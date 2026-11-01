import { CentralMcpServer, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

describe("central MCP servers", () => {
  it("rejects the name T3 reserves for itself", () => {
    assert.throws(() =>
      decodeServers([{ name: "t3-code", transport: { type: "stdio", command: "x" } }]),
    );
  });

  it("maps enabled servers into Claude's query shape", () => {
    assert.deepStrictEqual(claudeCentralMcpServers(servers), {
      github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: {} },
      docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "k" } },
    });
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

  it.effect("resolves ACP stdio commands, running Windows cmd shims through cmd.exe", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveAcpCentralMcpServers(servers);
      assert.deepStrictEqual(resolved[0], {
        name: "github",
        command: "C:\Windows\System32\cmd.exe",
        args: ["/d", "/c", "npx", "-y", "gh-mcp"],
        env: [],
      });
      assert.deepStrictEqual(resolved[1], acpCentralMcpServers(servers)[1]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        ComSpec: "C:\Windows\System32\cmd.exe",
        PATH: "C:\nodejs",
      }),
      Effect.provideService(SpawnExecutableResolution, (command) =>
        command === "npx" ? "C:\nodejs\npx.cmd" : undefined,
      ),
    ),
  );
});
