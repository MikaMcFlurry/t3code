// @effect-diagnostics abortControllerInEffect:off -- Exercises external AbortSignal races at the Promise bridge boundary.
import { DesktopApprovalId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  __testing,
  ComputerUseLinuxApprovalBroker,
  layerApprovalSurface,
  make,
} from "./ComputerUseLinuxApprovalBroker.ts";
import { ComputerUseLinuxApprovalSurfaceService } from "./ComputerUseLinuxServerIntegration.ts";

const bridgeRequest = {
  arguments: { x: 5, password: "never-show", nested: { accessToken: "also-secret" } },
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session-1",
  threadId: ThreadId.make("thread-1"),
  toolName: "click",
};

it.effect("approves exactly one matching pending request", () =>
  Effect.gen(function* () {
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => "approval-1",
    });
    broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
    const controller = new AbortController();
    const decision = broker.request(bridgeRequest, { signal: controller.signal });
    expect(broker.snapshot().requests).toHaveLength(1);
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-1"),
        threadId: ThreadId.make("another-thread"),
        decision: "approve",
      }),
    ).toBe(false);
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-1"),
        threadId: ThreadId.make("thread-1"),
        decision: "approve",
      }),
    ).toBe(true);
    expect(yield* Effect.promise(() => decision)).toBe(true);
    expect(broker.snapshot().requests).toEqual([]);
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-1"),
        threadId: ThreadId.make("thread-1"),
        decision: "approve",
      }),
    ).toBe(false);
  }),
);

it.effect("fails closed on denial, abort, expiry, and response races", () =>
  Effect.gen(function* () {
    let sequence = 0;
    const timerCallbacks = new Map<number, () => void>();
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => `approval-${++sequence}`,
      ttlMs: 5_000,
      setTimer: (callback) => {
        timerCallbacks.set(sequence, callback);
        return sequence as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => timerCallbacks.delete(timer as unknown as number),
    });
    broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });

    const denied = broker.request(bridgeRequest, { signal: new AbortController().signal });
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-1"),
        threadId: ThreadId.make("thread-1"),
        decision: "deny",
      }),
    ).toBe(true);
    expect(yield* Effect.promise(() => denied)).toBe(false);

    const abortController = new AbortController();
    const aborted = broker.request(bridgeRequest, { signal: abortController.signal });
    abortController.abort();
    expect(yield* Effect.promise(() => aborted)).toBe(false);
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-2"),
        threadId: ThreadId.make("thread-1"),
        decision: "approve",
      }),
    ).toBe(false);

    const expired = broker.request(bridgeRequest, { signal: new AbortController().signal });
    timerCallbacks.get(3)?.();
    expect(yield* Effect.promise(() => expired)).toBe(false);

    const raceController = new AbortController();
    const won = broker.request(bridgeRequest, { signal: raceController.signal });
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-4"),
        threadId: ThreadId.make("thread-1"),
        decision: "approve",
      }),
    ).toBe(true);
    raceController.abort();
    timerCallbacks.get(4)?.();
    expect(yield* Effect.promise(() => won)).toBe(true);
    expect(broker.snapshot().requests).toEqual([]);
  }),
);

it.effect("rejects a response after its deadline even when the timer is delayed", () =>
  Effect.gen(function* () {
    let now = 0;
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => "approval-1",
      now: () => now,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      ttlMs: 5_000,
    });
    broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
    const decision = broker.request(bridgeRequest, { signal: new AbortController().signal });
    now = 5_000;
    expect(
      broker.respond({
        id: DesktopApprovalId.make("approval-1"),
        threadId: ThreadId.make("thread-1"),
        decision: "approve",
      }),
    ).toBe(false);
    expect(yield* Effect.promise(() => decision)).toBe(false);
  }),
);

it.effect("bounds pending requests per session and rejects oversized action payloads", () =>
  Effect.gen(function* () {
    let sequence = 0;
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => `approval-${++sequence}`,
    });
    broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
    broker.activateSession({
      providerSessionId: "session-2",
      threadId: ThreadId.make("thread-2"),
    });
    const first = broker.request(bridgeRequest, { signal: new AbortController().signal });
    expect(
      yield* Effect.promise(() =>
        broker.request(
          { ...bridgeRequest, threadId: ThreadId.make("thread-2") },
          { signal: new AbortController().signal },
        ),
      ),
    ).toBe(false);
    expect(
      yield* Effect.promise(() =>
        broker.request(
          {
            ...bridgeRequest,
            arguments: { text: "x".repeat(__testing.maxArgumentBytes + 1) },
            providerSessionId: "session-2",
            threadId: ThreadId.make("thread-2"),
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).toBe(false);
    expect(broker.snapshot().requests).toHaveLength(1);
    broker.revokeAll();
    expect(yield* Effect.promise(() => first)).toBe(false);
  }),
);

it.effect("rejects late registration and approval after session revocation", () =>
  Effect.gen(function* () {
    const broker = yield* make({ environmentId: EnvironmentId.make("environment-1") });
    yield* Effect.promise(() => broker.revokeSessionAndWait("session-1"));
    const registration = broker.registerSession({
      close: async () => undefined,
      providerSessionId: "session-1",
      threadId: ThreadId.make("thread-1"),
    });
    expect(registration.revoked).toBe(true);
    expect(
      yield* Effect.promise(() =>
        broker.request(bridgeRequest, { signal: new AbortController().signal }),
      ),
    ).toBe(false);

    yield* Effect.promise(() => broker.revokeThreadAndWait(ThreadId.make("thread-2")));
    expect(
      broker.registerSession({
        close: async () => undefined,
        providerSessionId: "session-2",
        threadId: ThreadId.make("thread-2"),
      }).revoked,
    ).toBe(true);
    broker.activateSession({
      providerSessionId: "session-3",
      threadId: ThreadId.make("thread-2"),
    });
    expect(
      broker.registerSession({
        close: async () => undefined,
        providerSessionId: "session-3",
        threadId: ThreadId.make("thread-2"),
      }).revoked,
    ).toBe(false);
    yield* Effect.promise(() => broker.revokeAllAndWait());
  }),
);

it.effect("retires revoked credential lifecycle state", () =>
  Effect.gen(function* () {
    const broker = yield* make({ environmentId: EnvironmentId.make("environment-1") });
    for (let index = 0; index < 100; index += 1) {
      const providerSessionId = `session-${index}`;
      broker.activateSession({
        providerSessionId,
        threadId: ThreadId.make(`thread-${index}`),
      });
      yield* Effect.promise(() => broker.revokeSessionAndWait(providerSessionId));
    }
    expect(broker.credentialCount()).toBe(0);
  }),
);

it.effect("revokes every pending request for only the targeted provider session", () =>
  Effect.gen(function* () {
    let sequence = 0;
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => `approval-${++sequence}`,
    });
    broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
    broker.activateSession({
      providerSessionId: "session-2",
      threadId: ThreadId.make("thread-2"),
    });
    const first = broker.request(bridgeRequest, { signal: new AbortController().signal });
    const second = broker.request(
      { ...bridgeRequest, providerSessionId: "session-2", threadId: ThreadId.make("thread-2") },
      { signal: new AbortController().signal },
    );
    broker.revokeSession("session-1");
    expect(yield* Effect.promise(() => first)).toBe(false);
    expect(broker.snapshot().requests.map((request) => request.providerSessionId)).toEqual([
      "session-2",
    ]);
    broker.activateSession({ providerSessionId: "session-3", threadId: bridgeRequest.threadId });
    const third = broker.request(
      { ...bridgeRequest, providerSessionId: "session-3" },
      { signal: new AbortController().signal },
    );
    broker.revokeThread(ThreadId.make("thread-1"));
    expect(yield* Effect.promise(() => third)).toBe(false);
    expect(broker.snapshot().requests.map((request) => request.providerSessionId)).toEqual([
      "session-2",
    ]);
    broker.revokeSession("session-2");
    expect(yield* Effect.promise(() => second)).toBe(false);
  }),
);

it.effect("keeps an exact private action snapshot for an informed decision", () =>
  Effect.gen(function* () {
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => "approval-1",
    });
    broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
    const arguments_ = { text: "exact text", nested: { value: 7 } };
    const decision = broker.request(
      { ...bridgeRequest, arguments: arguments_, toolName: "type_text" },
      { signal: new AbortController().signal },
    );
    arguments_.text = "mutated";
    arguments_.nested.value = 8;
    expect(broker.snapshot().requests[0]?.arguments).toEqual({
      text: "exact text",
      nested: { value: 7 },
    });
    broker.revokeAll();
    expect(yield* Effect.promise(() => decision)).toBe(false);
  }),
);

it.effect(
  "Stop refuses the thread's pending approvals and closes its sessions, keeping its credential",
  () =>
    Effect.gen(function* () {
      const broker = yield* make({
        environmentId: EnvironmentId.make("environment-1"),
        makeId: () => "approval-stop",
      });
      broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
      let closed = 0;
      broker.registerSession({
        close: async () => {
          closed += 1;
        },
        providerSessionId: "session-1",
        threadId: bridgeRequest.threadId,
      });
      const decision = broker.request(bridgeRequest, { signal: new AbortController().signal });
      yield* Effect.promise(() => broker.interruptThreadAndWait(bridgeRequest.threadId));
      expect(yield* Effect.promise(() => decision)).toBe(false);
      expect(closed).toBe(1);
      // The next turn can call again without a new credential.
      expect(broker.isLive(bridgeRequest)).toBe(true);
    }),
);

const standingSurface = (
  approval: "every-action" | "full-access-threads" | "standing",
  runtimeMode: "full-access" | "approval-required",
) =>
  Effect.gen(function* () {
    const broker = yield* make({
      environmentId: EnvironmentId.make("environment-1"),
      makeId: () => "approval-standing",
    });
    const context = yield* Layer.build(
      layerApprovalSurface.pipe(
        Layer.provide(Layer.succeed(ComputerUseLinuxApprovalBroker, broker)),
        Layer.provide(ServerSettings.layerTest({ agentDesktopApproval: approval })),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed({ runtimeMode } as never),
          }),
        ),
      ),
    );
    return { broker, surface: Context.get(context, ComputerUseLinuxApprovalSurfaceService) };
  });

it.effect("grants standing approval only as the setting says, and only to a live session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const [approval, runtimeMode, standing] of [
        ["standing", "approval-required", true],
        ["full-access-threads", "full-access", true],
        ["full-access-threads", "approval-required", false],
        ["every-action", "full-access", false],
      ] as const) {
        const { broker, surface } = yield* standingSurface(approval, runtimeMode);
        broker.activateSession({
          providerSessionId: "session-1",
          threadId: bridgeRequest.threadId,
        });
        const decision = surface.request(bridgeRequest, { signal: new AbortController().signal });
        if (standing) {
          expect(yield* Effect.promise(() => decision)).toBe(true);
          expect(broker.snapshot().requests).toEqual([]);
        } else {
          // Not standing: the request waits for the user's answer.
          yield* broker.stream.pipe(
            Stream.filter((snapshot) => snapshot.requests.length === 1),
            Stream.runHead,
          );
          broker.revokeAll();
          expect(yield* Effect.promise(() => decision)).toBe(false);
        }
      }
      // A revoked session gets no standing grant either.
      const { broker, surface } = yield* standingSurface("standing", "full-access");
      broker.activateSession({ providerSessionId: "session-1", threadId: bridgeRequest.threadId });
      broker.revokeSession("session-1");
      expect(
        yield* Effect.promise(() =>
          surface.request(bridgeRequest, { signal: new AbortController().signal }),
        ),
      ).toBe(false);
    }),
  ),
);
