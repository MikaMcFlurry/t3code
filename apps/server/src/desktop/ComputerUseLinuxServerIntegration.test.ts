import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ComputerUseLinuxApprovalRevocation } from "./ComputerUseLinuxAvailability.ts";
import * as ComputerUseLinuxApprovalBroker from "./ComputerUseLinuxApprovalBroker.ts";
import {
  __testing,
  ComputerUseLinuxApprovalSurfaceService,
  ComputerUseLinuxLeaseFactory,
  ComputerUseLinuxUserLeaseKey,
  ComputerUseLinuxUpstreamFactoryService,
  startComputerUseLinuxForCurrentMcpInvocation,
} from "./ComputerUseLinuxServerIntegration.ts";
import { COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT } from "./ComputerUseLinuxPolicy.ts";

const secret = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);

const secretStore = (onRead: (name: string, bytes: number) => void) =>
  ServerSecretStore.ServerSecretStore.of({
    create: () => Effect.void,
    get: () => Effect.succeedNone,
    getOrCreateRandom: (name, bytes) => {
      onRead(name, bytes);
      return Effect.succeed(secret);
    },
    remove: () => Effect.void,
    set: () => Effect.void,
  });

const threadInvocation: McpInvocationContext.McpThreadInvocationScope = {
  capabilities: new Set(["desktop"]),
  client: undefined,
  environmentId: EnvironmentId.make("environment-office"),
  issuedAt: 1,
  requestNamespace: "provider-session-authorized",
  thread: {
    providerInstanceId: ProviderInstanceId.make("codex-office"),
    providerSessionId: "provider-session-authorized",
    threadId: ThreadId.make("thread-authorized"),
  },
};

// The secret-store fallback; userLeaseScopeKey has its own test in ComputerUseLinuxHostLease.test.ts.
const noUserLeaseKey = async (): Promise<string> => {
  throw new Error("no user lease key in this test");
};

describe("ComputerUseLinuxServerIntegration", () => {
  it.effect(
    "keeps desktop capability off unless the authenticated MCP session explicitly has it",
    () =>
      Effect.gen(function* () {
        const requireDesktop = (scope: McpInvocationContext.McpThreadInvocationScope) =>
          McpInvocationContext.requireThreadMcpCapability("desktop").pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );

        const denied = yield* requireDesktop({
          ...threadInvocation,
          capabilities: new Set(["preview"]),
        }).pipe(Effect.flip);
        assert.include(denied.message, "does not grant the desktop capability");
        const allowed = yield* requireDesktop({
          ...threadInvocation,
          capabilities: new Set(["desktop"]),
        });
        assert.deepStrictEqual(allowed.thread, threadInvocation.thread);
      }),
  );

  it.effect(
    "derives identity from authenticated MCP context and lease scope from the secret store",
    () =>
      Effect.gen(function* () {
        const approvals: string[] = [];
        const leaseInputs: Array<{ platform: NodeJS.Platform; scopeKey: string }> = [];
        const secretReads: Array<{ bytes: number; name: string }> = [];
        const upstreamCalls: Array<{ arguments?: unknown; name: string }> = [];
        const upstreamEnvironments: Array<Readonly<Record<string, string>>> = [];
        let upstreamClosed = false;

        const program = startComputerUseLinuxForCurrentMcpInvocation().pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
          Effect.provideService(
            ServerSecretStore.ServerSecretStore,
            secretStore((name, bytes) => secretReads.push({ name, bytes })),
          ),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(ComputerUseLinuxUserLeaseKey, { resolve: noUserLeaseKey }),
          Effect.provideService(ComputerUseLinuxLeaseFactory, {
            make: (input) => {
              leaseInputs.push(input);
              return { withLease: (operation) => operation() };
            },
          }),
          Effect.provideService(
            ComputerUseLinuxApprovalSurfaceService,
            ComputerUseLinuxApprovalSurfaceService.of({
              request: async (request) => {
                approvals.push(
                  `${request.providerInstanceId}:${request.providerSessionId}:${request.threadId}:${request.toolName}`,
                );
                return true;
              },
            }),
          ),
          Effect.provideService(
            ComputerUseLinuxUpstreamFactoryService,
            ComputerUseLinuxUpstreamFactoryService.of({
              start: async ({ environment }) => {
                upstreamEnvironments.push(environment);
                return {
                  callTool: async (input) => {
                    upstreamCalls.push(input);
                    return { content: [{ text: input.name, type: "text" }] };
                  },
                  close: async () => {
                    upstreamClosed = true;
                  },
                  listTools: async () => [
                    { name: "screenshot" },
                    { name: "click" },
                    { name: "run_shell" },
                  ],
                };
              },
            }),
          ),
        );

        const session = yield* program;
        assert.deepStrictEqual(secretReads, [
          { name: __testing.leaseSecretName, bytes: __testing.leaseSecretBytes },
        ]);
        assert.deepStrictEqual(leaseInputs, [
          { platform: "linux", scopeKey: Buffer.from(secret).toString("base64url") },
        ]);
        assert.deepStrictEqual(upstreamEnvironments, []);
        assert.deepStrictEqual(
          (yield* Effect.promise(() => session.listTools())).map((tool) => tool.name),
          ["screenshot", "click"],
        );
        assert.deepStrictEqual(upstreamEnvironments, [COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT]);

        yield* Effect.promise(() =>
          session.callTool({ arguments: { max_width: 800 }, toolName: "screenshot" }),
        );
        yield* Effect.promise(() =>
          session.callTool({ arguments: { x: 2, y: 3 }, toolName: "click" }),
        );
        assert.deepStrictEqual(approvals, [
          "codex-office:provider-session-authorized:thread-authorized:click",
        ]);
        assert.deepStrictEqual(upstreamCalls, [
          { arguments: { max_width: 800 }, name: "screenshot" },
          { arguments: { x: 2, y: 3 }, name: "click" },
        ]);
        yield* Effect.promise(() => session.close());
        assert.isTrue(upstreamClosed);
      }),
  );

  it.effect(
    "rejects an outside MCP client before reading a lease secret or starting upstream",
    () =>
      Effect.gen(function* () {
        let secretRead = false;
        let upstreamStarted = false;
        const clientInvocation: McpInvocationContext.McpInvocationScope = {
          ...threadInvocation,
          client: {
            access: "read-only",
            label: "outside-client",
            sessionId: "client-session",
          },
          thread: undefined,
        };
        const program = startComputerUseLinuxForCurrentMcpInvocation().pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientInvocation),
          Effect.provideService(
            ServerSecretStore.ServerSecretStore,
            secretStore(() => {
              secretRead = true;
            }),
          ),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(ComputerUseLinuxUserLeaseKey, { resolve: noUserLeaseKey }),
          Effect.provideService(ComputerUseLinuxLeaseFactory, {
            make: () => ({ withLease: (operation) => operation() }),
          }),
          Effect.provideService(
            ComputerUseLinuxApprovalSurfaceService,
            ComputerUseLinuxApprovalSurfaceService.of({ request: async () => true }),
          ),
          Effect.provideService(
            ComputerUseLinuxUpstreamFactoryService,
            ComputerUseLinuxUpstreamFactoryService.of({
              start: async () => {
                upstreamStarted = true;
                throw new Error("must not start");
              },
            }),
          ),
        );

        const error = yield* program.pipe(Effect.flip);
        assert.include(error.message, "needs an agent running inside T3");
        assert.isFalse(secretRead);
        assert.isFalse(upstreamStarted);
      }),
  );

  it.effect("aborts and awaits an active backend call when its MCP session is revoked", () =>
    Effect.gen(function* () {
      let markBackendStarted: () => void = () => undefined;
      const backendStarted = new Promise<void>((resolve) => {
        markBackendStarted = resolve;
      });
      let backendAborted = false;
      const broker = yield* ComputerUseLinuxApprovalBroker.make({
        environmentId: threadInvocation.environmentId,
        makeId: () => "approval-active-revoke",
      });
      const lifecycle = ComputerUseLinuxApprovalRevocation.of({
        activateSession: broker.activateSession,
        registerSession: broker.registerSession,
        revokeSession: broker.revokeSessionAndWait,
        revokeThread: broker.revokeThreadAndWait,
        interruptThread: broker.interruptThreadAndWait,
      });
      broker.activateSession({
        providerSessionId: threadInvocation.thread.providerSessionId,
        threadId: threadInvocation.thread.threadId,
      });
      const program = startComputerUseLinuxForCurrentMcpInvocation().pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
        Effect.provideService(
          ServerSecretStore.ServerSecretStore,
          secretStore(() => undefined),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(ComputerUseLinuxApprovalRevocation, lifecycle),
        Effect.provideService(ComputerUseLinuxUserLeaseKey, { resolve: noUserLeaseKey }),
        Effect.provideService(ComputerUseLinuxLeaseFactory, {
          make: () => ({ withLease: (operation) => operation() }),
        }),
        Effect.provideService(
          ComputerUseLinuxApprovalSurfaceService,
          ComputerUseLinuxApprovalSurfaceService.of({
            request: async (request, options) => {
              const decision = broker.request(request, options);
              broker.respond({
                id: broker.snapshot().requests[0]!.id,
                threadId: threadInvocation.thread.threadId,
                decision: "approve",
              });
              return decision;
            },
          }),
        ),
        Effect.provideService(
          ComputerUseLinuxUpstreamFactoryService,
          ComputerUseLinuxUpstreamFactoryService.of({
            start: async () => ({
              callTool: async (_input, options) => {
                markBackendStarted();
                return new Promise<unknown>((_resolve, reject) => {
                  options.signal.addEventListener(
                    "abort",
                    () => {
                      backendAborted = true;
                      reject(new Error("backend aborted"));
                    },
                    { once: true },
                  );
                });
              },
              close: async () => undefined,
              listTools: async () => [{ name: "click" }],
            }),
          }),
        ),
      );

      const session = yield* program;
      const call = yield* Effect.promise(() =>
        session.callTool({ arguments: { x: 1, y: 2 }, toolName: "click" }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => backendStarted);
      yield* Effect.promise(() =>
        lifecycle.revokeSession(threadInvocation.thread.providerSessionId),
      );
      const callExit = yield* Fiber.await(call);
      assert.isTrue(Exit.isFailure(callExit));
      assert.isTrue(backendAborted);
      yield* Effect.promise(() => session.close());
    }),
  );

  it.effect("rejects a session revoked while its pre-registration setup is pending", () =>
    Effect.gen(function* () {
      let markSecretRequested: () => void = () => undefined;
      const secretRequested = new Promise<void>((resolve) => {
        markSecretRequested = resolve;
      });
      let releaseSecret: () => void = () => undefined;
      const secretReleased = new Promise<void>((resolve) => {
        releaseSecret = resolve;
      });
      let upstreamStarted = false;
      const broker = yield* ComputerUseLinuxApprovalBroker.make({
        environmentId: threadInvocation.environmentId,
      });
      const lifecycle = ComputerUseLinuxApprovalRevocation.of({
        activateSession: broker.activateSession,
        registerSession: broker.registerSession,
        revokeSession: broker.revokeSessionAndWait,
        revokeThread: broker.revokeThreadAndWait,
        interruptThread: broker.interruptThreadAndWait,
      });
      broker.activateSession({
        providerSessionId: threadInvocation.thread.providerSessionId,
        threadId: threadInvocation.thread.threadId,
      });
      const delayedSecretStore = ServerSecretStore.ServerSecretStore.of({
        create: () => Effect.void,
        get: () => Effect.succeedNone,
        getOrCreateRandom: () =>
          Effect.promise(async () => {
            markSecretRequested();
            await secretReleased;
            return secret;
          }),
        remove: () => Effect.void,
        set: () => Effect.void,
      });
      const program = startComputerUseLinuxForCurrentMcpInvocation().pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
        Effect.provideService(ServerSecretStore.ServerSecretStore, delayedSecretStore),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(ComputerUseLinuxApprovalRevocation, lifecycle),
        Effect.provideService(ComputerUseLinuxUserLeaseKey, { resolve: noUserLeaseKey }),
        Effect.provideService(ComputerUseLinuxLeaseFactory, {
          make: () => ({ withLease: (operation) => operation() }),
        }),
        Effect.provideService(
          ComputerUseLinuxApprovalSurfaceService,
          ComputerUseLinuxApprovalSurfaceService.of({ request: async () => true }),
        ),
        Effect.provideService(
          ComputerUseLinuxUpstreamFactoryService,
          ComputerUseLinuxUpstreamFactoryService.of({
            start: async () => {
              upstreamStarted = true;
              throw new Error("must not start");
            },
          }),
        ),
      );

      const starting = yield* program.pipe(Effect.forkChild);
      yield* Effect.promise(() => secretRequested);
      yield* Effect.promise(() =>
        lifecycle.revokeSession(threadInvocation.thread.providerSessionId),
      );
      releaseSecret();
      const session = yield* Fiber.join(starting);
      const rejectedAsRevoked = yield* Effect.promise(async () => {
        try {
          await session.callTool({ arguments: { max_width: 800 }, toolName: "screenshot" });
          return false;
        } catch (error) {
          return String(error).includes("revoked");
        }
      });
      assert.isTrue(rejectedAsRevoked);
      assert.isFalse(upstreamStarted);
      yield* Effect.promise(() => session.close());
    }),
  );
});
