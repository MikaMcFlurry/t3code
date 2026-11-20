import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ComputerUseLinuxApprovalSurfaceService,
  ComputerUseLinuxLeaseFactory,
  ComputerUseLinuxUpstreamFactoryService,
  ComputerUseLinuxUserLeaseKey,
} from "./ComputerUseLinuxServerIntegration.ts";
import * as ComputerUseLinuxApprovalBroker from "./ComputerUseLinuxApprovalBroker.ts";

it.effect("routes an authenticated HTTP bearer call through the mediated desktop bridge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerDesktopToken";
      const threadId = ThreadId.make("thread-http-desktop");
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("environment-http-desktop"),
        requestNamespace: "provider-http-desktop",
        thread: {
          threadId,
          providerSessionId: "provider-http-desktop",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["desktop"]),
        issuedAt: 1,
      };
      const upstreamCalls: unknown[] = [];
      const approvalBroker = yield* ComputerUseLinuxApprovalBroker.make({
        environmentId: scope.environmentId,
        makeId: () => "http-e2e-approval",
      });
      approvalBroker.activateSession({
        providerSessionId: scope.thread.providerSessionId,
        threadId,
      });
      const approvalSnapshots: unknown[] = [];
      const secretStore = ServerSecretStore.ServerSecretStore.of({
        create: () => Effect.void,
        get: () => Effect.succeedNone,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(11)),
        remove: () => Effect.void,
        set: () => Effect.void,
      });
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.layerComputerUseLinuxToolkit,
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
        Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provide(
          Layer.succeed(ComputerUseLinuxUserLeaseKey, {
            resolve: async () => "test-user-lease-key".repeat(3),
          }),
        ),
        Layer.provide(
          Layer.succeed(ComputerUseLinuxLeaseFactory, {
            make: () => ({ withLease: (operation) => operation() }),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            ComputerUseLinuxApprovalSurfaceService,
            ComputerUseLinuxApprovalSurfaceService.of({
              request: approvalBroker.request,
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            ComputerUseLinuxUpstreamFactoryService,
            ComputerUseLinuxUpstreamFactoryService.of({
              start: async () => ({
                listTools: async () => [{ name: "click" }, { name: "run_shell" }],
                callTool: async (input) => {
                  upstreamCalls.push(input);
                  return { content: [{ type: "text", text: "clicked" }] };
                },
                close: async () => undefined,
              }),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      yield* approvalBroker.stream.pipe(
        Stream.filter((snapshot) => snapshot.requests.length > 0),
        Stream.take(1),
        Stream.runForEach((snapshot) =>
          Effect.sync(() => {
            approvalSnapshots.push(snapshot);
            approvalBroker.respond({
              id: snapshot.requests[0]!.id,
              threadId,
              decision: "approve",
            });
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );
      const initialize = yield* client.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "desktop-http-e2e", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      expect(initialize.status).toBe(200);
      const response = yield* client
        .post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            "mcp-session-id": initialize.headers["mcp-session-id"]!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "computer_use_linux",
                arguments: { toolName: "click", arguments: { x: 4, y: 5 } },
              },
            }),
            "application/json",
          ),
        })
        .pipe(Effect.flatMap((result) => result.json));

      expect(response).toMatchObject({
        result: { isError: false },
      });
      expect(approvalSnapshots).toMatchObject([
        { requests: [{ id: "http-e2e-approval", threadId, toolName: "click" }] },
      ]);
      expect(upstreamCalls).toEqual([{ name: "click", arguments: { x: 4, y: 5 } }]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
