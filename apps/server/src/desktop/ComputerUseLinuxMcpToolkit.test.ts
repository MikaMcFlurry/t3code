import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import { __testing as toolkitTesting } from "./ComputerUseLinuxMcpToolkit.ts";
import {
  ComputerUseLinuxApprovalSurfaceService,
  ComputerUseLinuxLeaseFactory,
  ComputerUseLinuxUpstreamFactoryService,
  ComputerUseLinuxUserLeaseKey,
} from "./ComputerUseLinuxServerIntegration.ts";

const threadId = ThreadId.make("thread:computer-use");
const invocation: McpInvocationContext.McpThreadInvocationScope = {
  capabilities: new Set(["desktop"]),
  client: undefined,
  environmentId: EnvironmentId.make("environment-office"),
  issuedAt: 1,
  requestNamespace: "provider-session-computer-use",
  thread: {
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "provider-session-computer-use",
    threadId,
  },
};
const client = McpSchema.McpServerClient.of({
  clientCapabilities: {},
  clientId: 1,
  clientInfo: { name: "computer-use-test", version: "1" },
  getClient: Effect.die("unused"),
  initializePayload: {
    capabilities: {},
    clientInfo: { name: "computer-use-test", version: "1" },
    protocolVersion: "2025-06-18",
  },
  protocolVersion: "2025-06-18",
});

describe("ComputerUseLinuxMcpToolkit", () => {
  it.effect("routes an authenticated T3 MCP call through the mediated fake upstream", () => {
    const approvals: string[] = [];
    const upstreamCalls: Array<{ arguments?: unknown; name: string }> = [];
    let upstreamStarts = 0;
    let upstreamCloses = 0;
    let approvalAllowed = true;
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      create: () => Effect.void,
      get: () => Effect.succeedNone,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      remove: () => Effect.void,
      set: () => Effect.void,
    });
    const layerTest = McpHttpServer.layerComputerUseLinuxToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
      Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
      Layer.provide(
        Layer.succeed(ComputerUseLinuxUserLeaseKey, {
          resolve: async () => "test-user-lease-key".repeat(3),
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ComputerUseLinuxApprovalSurfaceService,
          ComputerUseLinuxApprovalSurfaceService.of({
            request: async (request) => {
              approvals.push(
                `${request.providerInstanceId}:${request.providerSessionId}:${request.threadId}:${request.toolName}`,
              );
              return approvalAllowed;
            },
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          ComputerUseLinuxUpstreamFactoryService,
          ComputerUseLinuxUpstreamFactoryService.of({
            start: async () => {
              upstreamStarts += 1;
              return {
                callTool: async (input) => {
                  upstreamCalls.push(input);
                  return {
                    content: [
                      { text: input.name, type: "text" },
                      ...(input.name === "screenshot"
                        ? [{ type: "image", data: "iVBORw==", mimeType: "image/png" }]
                        : []),
                    ],
                  };
                },
                close: async () => {
                  upstreamCloses += 1;
                },
                listTools: async () => [{ name: "screenshot" }, { name: "click" }],
              };
            },
          }),
        ),
      ),
    );
    const call = (toolName: "click" | "screenshot", arguments_: unknown) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({
            arguments: { arguments: arguments_, toolName },
            name: "computer_use_linux",
          }),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(ComputerUseLinuxLeaseFactory, {
          make: () => ({ withLease: (operation) => operation() }),
        }),
      );

    return Effect.gen(function* () {
      const observed = yield* call("screenshot", { max_width: 800 });
      const interacted = yield* call("click", { x: 5, y: 6 });
      approvalAllowed = false;
      const denied = yield* call("click", { x: 7, y: 8 });
      assert.isFalse(observed.isError);
      // The screenshot reaches the agent as an image block, not as base64 inside JSON text.
      assert.deepStrictEqual(
        observed.content.map((block) => block.type),
        ["text", "image"],
      );
      assert.isFalse(interacted.isError);
      assert.isTrue(denied.isError);
      assert.deepStrictEqual(approvals, [
        "codex:provider-session-computer-use:thread:computer-use:click",
        "codex:provider-session-computer-use:thread:computer-use:click",
      ]);
      assert.deepStrictEqual(upstreamCalls, [
        { arguments: { max_width: 800 }, name: "screenshot" },
        { arguments: { x: 5, y: 6 }, name: "click" },
      ]);
      // One kept backend serves every call of the session; a declined approval leaves it open.
      assert.equal(upstreamStarts, 1);
      assert.equal(upstreamCloses, 0);
      yield* Effect.promise(() => toolkitTesting.closeKeptSessions());
      assert.equal(upstreamCloses, 1);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("fails closed when the authenticated MCP credential lacks desktop capability", () => {
    let upstreamStarted = false;
    const withoutDesktop = { ...invocation, capabilities: new Set(["preview"] as const) };
    const layerTest = McpHttpServer.layerComputerUseLinuxToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
      Layer.provide(
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            create: () => Effect.void,
            get: () => Effect.succeedNone,
            getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
            remove: () => Effect.void,
            set: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
      Layer.provide(
        Layer.succeed(ComputerUseLinuxUserLeaseKey, {
          resolve: async () => "test-user-lease-key".repeat(3),
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ComputerUseLinuxApprovalSurfaceService,
          ComputerUseLinuxApprovalSurfaceService.of({ request: async () => true }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          ComputerUseLinuxUpstreamFactoryService,
          ComputerUseLinuxUpstreamFactoryService.of({
            start: async () => {
              upstreamStarted = true;
              throw new Error("must not start");
            },
          }),
        ),
      ),
    );
    const call = McpServer.McpServer.pipe(
      Effect.flatMap((server) =>
        server.callTool({
          arguments: { arguments: {}, toolName: "screenshot" },
          name: "computer_use_linux",
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, withoutDesktop),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

    return Effect.gen(function* () {
      const result = yield* call;
      assert.isTrue(result.isError);
      assert.isFalse(upstreamStarted);
    }).pipe(Effect.provide(layerTest));
  });

  it("keeps one idle timer per session, and none while a call is in flight", () => {
    const entry = {
      session: { closed: false, close: async () => undefined } as never,
      idle: undefined as ReturnType<typeof setTimeout> | undefined,
      active: 1,
    };
    toolkitTesting.keptSessions.set("idle-test", entry);
    try {
      toolkitTesting.scheduleIdleClose("idle-test", entry);
      assert.isUndefined(entry.idle);
      entry.active = 0;
      toolkitTesting.scheduleIdleClose("idle-test", entry);
      const first = entry.idle;
      assert.isDefined(first);
      toolkitTesting.scheduleIdleClose("idle-test", entry);
      assert.notStrictEqual(entry.idle, first);
    } finally {
      toolkitTesting.cancelIdleClose(entry);
      toolkitTesting.keptSessions.delete("idle-test");
    }
  });
});
