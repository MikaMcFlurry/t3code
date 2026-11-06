import { CentralMcpServer, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sharedMcpSessionEnvironment } from "@t3tools/provider-core/server/mcpSession";
import { centralMcpServersForSession } from "@t3tools/provider-core/server/centralMcpServerScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import { claudeCentralMcpServers, claudeMcpQueryOverrides } from "./ClaudeAdapterV2.ts";
import { codexCentralMcpConfig } from "./CodexAdapterV2.ts";
import {
  acpCentralMcpServers,
  resolveAcpCentralMcpServers,
} from "../../provider/ProviderInstanceRegistryHydration.ts";

const decodeServers = Schema.decodeUnknownSync(Schema.Array(CentralMcpServer));

const servers = decodeServers([
  { name: "github", transport: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"] } },
  {
    name: "docs",
    transport: { type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "k" } },
  },
  { name: "off", enabled: false, transport: { type: "stdio", command: "off" } },
]);

const scopedServer = decodeServers([
  {
    name: "scoped-desktop",
    sessionScope: {
      providerInstanceIds: ["claudeAgent"],
      threadIds: ["thread-1"],
    },
    transport: { type: "stdio", command: "scoped-desktop", args: ["mcp"] },
  },
])[0];

describe("central MCP servers", () => {
  it("rejects the name T3 reserves for itself", () => {
    assert.throws(() =>
      decodeServers([{ name: "t3-code", transport: { type: "stdio", command: "x" } }]),
    );
  });

  it("rejects raw computer-use-linux configuration that would bypass T3's bridge", () => {
    assert.throws(() =>
      decodeServers([
        { name: "computer-use-linux", transport: { type: "stdio", command: "unsafe" } },
      ]),
    );
  });

  it("maps enabled servers into Claude's query shape", () => {
    assert.deepStrictEqual(claudeCentralMcpServers(servers), {
      github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: {} },
      docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "k" } },
    });
  });

  it("adds a scoped server only to its authorized Claude and Codex session", () => {
    assert.isDefined(scopedServer);
    const scoped = scopedServer ? [...servers, scopedServer] : servers;
    const authorized = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer token",
      browserToolsAvailable: false,
    };
    const otherThread = { ...authorized, threadId: ThreadId.make("thread-2") };

    assert.hasAllKeys(
      claudeMcpQueryOverrides({
        mcpSession: authorized,
        readOnlySandbox: false,
        centralMcpServers: scoped,
      }).mcpServers ?? {},
      ["github", "docs", "scoped-desktop", "t3-code"],
    );
    assert.notProperty(
      claudeMcpQueryOverrides({
        mcpSession: otherThread,
        readOnlySandbox: false,
        centralMcpServers: scoped,
      }).mcpServers ?? {},
      "scoped-desktop",
    );
    assert.property(
      codexCentralMcpConfig(centralMcpServersForSession(scoped, authorized)),
      "mcp_servers.scoped-desktop",
    );
    assert.notProperty(
      codexCentralMcpConfig(centralMcpServersForSession(scoped, otherThread)),
      "mcp_servers.scoped-desktop",
    );
  });

  it("adds central servers next to T3's own and without a T3 session", () => {
    const withSession = claudeMcpQueryOverrides({
      mcpSession: {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        browserToolsAvailable: false,
      },
      readOnlySandbox: false,
      centralMcpServers: servers,
    });
    assert.deepStrictEqual(Object.keys(withSession.mcpServers ?? {}), [
      "github",
      "docs",
      "t3-code",
    ]);

    const withoutSession = claudeMcpQueryOverrides({
      mcpSession: undefined,
      readOnlySandbox: false,
      centralMcpServers: servers,
    });
    assert.deepStrictEqual(Object.keys(withoutSession.mcpServers ?? {}), ["github", "docs"]);
  });

  it("maps enabled servers into Codex config overrides", () => {
    assert.deepStrictEqual(codexCentralMcpConfig(servers), {
      "mcp_servers.github": { command: "npx", args: ["-y", "gh-mcp"], env: {} },
      "mcp_servers.docs": {
        url: "https://docs.example/mcp",
        http_headers: { "X-Key": "k" },
      },
    });
  });

  it("maps enabled servers into ACP session servers", () => {
    assert.deepStrictEqual(acpCentralMcpServers(servers), [
      { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: [] },
      {
        type: "http",
        name: "docs",
        url: "https://docs.example/mcp",
        headers: [{ name: "X-Key", value: "k" }],
      },
    ]);
  });

  it("does not expose session-scoped servers through the global ACP registry", () => {
    assert.isDefined(scopedServer);
    assert.deepStrictEqual(
      acpCentralMcpServers(scopedServer ? [...servers, scopedServer] : servers).map(
        (server) => server.name,
      ),
      ["github", "docs"],
    );
  });

  it.effect("resolves ACP stdio commands, running Windows cmd shims through cmd.exe", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveAcpCentralMcpServers(servers);
      assert.deepStrictEqual(resolved[0], {
        name: "github",
        command: String.raw`C:\Windows\System32\cmd.exe`,
        args: ["/d", "/c", "npx", "-y", "gh-mcp"],
        env: [],
      });
      assert.deepStrictEqual(resolved[1], acpCentralMcpServers(servers)[1]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
        PATH: String.raw`C:\nodejs`,
      }),
      Effect.provideService(SpawnExecutableResolution, (command) =>
        command === "npx" ? String.raw`C:\nodejs\npx.cmd` : undefined,
      ),
    ),
  );

  it("tells shared stdio servers which provider, account and thread they serve", () => {
    const session = {
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("claude_work"),
    };
    const environment = sharedMcpSessionEnvironment("claudeAgent", session);
    assert.deepStrictEqual(environment, {
      T3CODE_PROVIDER: "claudeAgent",
      T3CODE_PROVIDER_INSTANCE: "claude_work",
      T3CODE_THREAD_ID: "thread-1",
    });
    const [ownEnv] = decodeServers([
      {
        name: "murmur",
        transport: { type: "stdio", command: "mur", args: ["mcp"], env: { T3CODE_PROVIDER: "x" } },
      },
    ]);
    const claude = claudeCentralMcpServers(ownEnv ? [ownEnv] : [], environment);
    // A server's own env entries win over the session values.
    assert.deepInclude(claude.murmur, {
      env: {
        T3CODE_PROVIDER: "x",
        T3CODE_PROVIDER_INSTANCE: "claude_work",
        T3CODE_THREAD_ID: "thread-1",
      },
    });
    assert.deepStrictEqual(
      codexCentralMcpConfig(servers, sharedMcpSessionEnvironment("codex", undefined))[
        "mcp_servers.github"
      ],
      { command: "npx", args: ["-y", "gh-mcp"], env: { T3CODE_PROVIDER: "codex" } },
    );
  });
});
