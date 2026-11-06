import {
  DesktopApprovalId,
  type DesktopApprovalRequest,
  type DesktopApprovalRespondInput,
  type DesktopApprovalSnapshot,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ComputerUseLinuxBridgeRequest } from "./ComputerUseLinuxBridge.ts";
import { ComputerUseLinuxApprovalRevocation } from "./ComputerUseLinuxAvailability.ts";
import { ComputerUseLinuxApprovalSurfaceService } from "./ComputerUseLinuxServerIntegration.ts";

const DEFAULT_APPROVAL_TTL_MS = 60_000;
const MAX_ARGUMENT_BYTES = 64 * 1_024;
const MAX_PENDING_APPROVALS = 32;

interface PendingApproval {
  readonly request: DesktopApprovalRequest;
  readonly resolve: (approved: boolean) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface ActiveSession {
  readonly close: () => Promise<void>;
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
}

interface CredentialState {
  readonly threadId: ThreadId;
  status: "active" | "revoked";
}

export interface ComputerUseLinuxApprovalBrokerOptions {
  readonly environmentId: EnvironmentId;
  readonly now?: () => number;
  readonly makeId?: () => string;
  readonly ttlMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ComputerUseLinuxApprovalBroker extends Context.Service<
  ComputerUseLinuxApprovalBroker,
  {
    readonly request: (
      request: ComputerUseLinuxBridgeRequest,
      options: { readonly signal: AbortSignal },
    ) => Promise<boolean>;
    readonly respond: (input: DesktopApprovalRespondInput) => boolean;
    readonly revokeSession: (providerSessionId: string) => void;
    readonly revokeThread: (threadId: ThreadId) => void;
    readonly revokeAll: () => void;
    readonly activateSession: (input: {
      readonly providerSessionId: string;
      readonly threadId: ThreadId;
    }) => void;
    readonly registerSession: (session: ActiveSession) => {
      readonly revoked: boolean;
      readonly unregister: () => void;
    };
    readonly revokeSessionAndWait: (providerSessionId: string) => Promise<void>;
    readonly revokeThreadAndWait: (threadId: ThreadId) => Promise<void>;
    readonly revokeAllAndWait: () => Promise<void>;
    readonly credentialCount: () => number;
    readonly snapshot: () => DesktopApprovalSnapshot;
    readonly stream: Stream.Stream<DesktopApprovalSnapshot>;
  }
>()("t3/desktop/ComputerUseLinuxApprovalBroker") {}

export const make = (options: ComputerUseLinuxApprovalBrokerOptions) =>
  Effect.sync(() => {
    const pending = new Map<DesktopApprovalId, PendingApproval>();
    const activeSessions = new Map<number, ActiveSession>();
    const credentials = new Map<string, CredentialState>();
    const listeners = new Set<(snapshot: DesktopApprovalSnapshot) => void>();
    const now = options.now ?? Date.now;
    let requestSequence = 0;
    let activeSessionSequence = 0;
    const makeId = options.makeId ?? (() => `desktop-${now()}-${requestSequence++}`);
    const ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;

    const snapshot = (): DesktopApprovalSnapshot => ({
      requests: [...pending.values()]
        .map((entry) => entry.request)
        .sort((left, right) => left.createdAt - right.createdAt),
    });
    const publish = () => {
      const value = snapshot();
      for (const listener of listeners) listener(value);
    };
    const settle = (id: DesktopApprovalId, approved: boolean): boolean => {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      clearTimer(entry.timeout);
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.resolve(approved);
      publish();
      return true;
    };

    const request = (
      input: ComputerUseLinuxBridgeRequest,
      requestOptions: { readonly signal: AbortSignal },
    ): Promise<boolean> => {
      if (requestOptions.signal.aborted) return Promise.resolve(false);
      if (
        credentials.get(input.providerSessionId)?.status !== "active" ||
        credentials.get(input.providerSessionId)?.threadId !== input.threadId ||
        pending.size >= MAX_PENDING_APPROVALS ||
        [...pending.values()].some(
          (entry) =>
            entry.request.providerSessionId === input.providerSessionId ||
            entry.request.threadId === input.threadId,
        )
      ) {
        return Promise.resolve(false);
      }
      let arguments_: unknown;
      try {
        arguments_ = structuredClone(input.arguments);
        const encoded = JSON.stringify(arguments_);
        if (encoded !== undefined && Buffer.byteLength(encoded) > MAX_ARGUMENT_BYTES) {
          return Promise.resolve(false);
        }
      } catch {
        return Promise.resolve(false);
      }
      const id = DesktopApprovalId.make(makeId());
      const createdAt = now();
      const approval: DesktopApprovalRequest = {
        id,
        environmentId: options.environmentId,
        threadId: ThreadId.make(input.threadId),
        providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        providerSessionId: input.providerSessionId,
        toolName: input.toolName,
        ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
        createdAt,
        expiresAt: createdAt + ttlMs,
      };
      return new Promise<boolean>((resolve) => {
        const onAbort = () => settle(id, false);
        const timeout = setTimer(() => settle(id, false), ttlMs);
        pending.set(id, {
          request: approval,
          resolve,
          signal: requestOptions.signal,
          onAbort,
          timeout,
        });
        requestOptions.signal.addEventListener("abort", onAbort, { once: true });
        // The signal can race the listener registration.
        if (requestOptions.signal.aborted) settle(id, false);
        else publish();
      });
    };

    const respond = (input: DesktopApprovalRespondInput): boolean => {
      const entry = pending.get(input.id);
      if (!entry || entry.request.threadId !== input.threadId) return false;
      if (now() >= entry.request.expiresAt) {
        settle(input.id, false);
        return false;
      }
      return settle(input.id, input.decision === "approve");
    };

    const revokeSession = (providerSessionId: string): void => {
      const credential = credentials.get(providerSessionId);
      if (credential !== undefined) credential.status = "revoked";
      const ids = [...pending.entries()]
        .filter(([, entry]) => entry.request.providerSessionId === providerSessionId)
        .map(([id]) => id);
      for (const id of ids) settle(id, false);
    };
    const revokeThread = (threadId: ThreadId): void => {
      for (const credential of credentials.values()) {
        if (credential.threadId === threadId) credential.status = "revoked";
      }
      const ids = [...pending.entries()]
        .filter(([, entry]) => entry.request.threadId === threadId)
        .map(([id]) => id);
      for (const id of ids) settle(id, false);
    };
    const revokeAll = (): void => {
      for (const credential of credentials.values()) credential.status = "revoked";
      for (const id of pending.keys()) settle(id, false);
    };
    const activateSession = (input: {
      readonly providerSessionId: string;
      readonly threadId: ThreadId;
    }): void => {
      const existing = credentials.get(input.providerSessionId);
      if (existing === undefined) {
        credentials.set(input.providerSessionId, { threadId: input.threadId, status: "active" });
      }
    };
    const registerSession = (
      session: ActiveSession,
    ): { readonly revoked: boolean; readonly unregister: () => void } => {
      if (
        credentials.get(session.providerSessionId)?.status !== "active" ||
        credentials.get(session.providerSessionId)?.threadId !== session.threadId
      ) {
        return { revoked: true, unregister: () => undefined };
      }
      const id = activeSessionSequence++;
      activeSessions.set(id, session);
      return { revoked: false, unregister: () => activeSessions.delete(id) };
    };
    const closeSessions = async (sessions: ReadonlyArray<ActiveSession>): Promise<void> => {
      const results = await Promise.allSettled(sessions.map((session) => session.close()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Desktop session revocation failed.");
    };
    const revokeSessionAndWait = async (providerSessionId: string): Promise<void> => {
      revokeSession(providerSessionId);
      try {
        await closeSessions(
          [...activeSessions.values()].filter(
            (session) => session.providerSessionId === providerSessionId,
          ),
        );
      } finally {
        credentials.delete(providerSessionId);
      }
    };
    const revokeThreadAndWait = async (threadId: ThreadId): Promise<void> => {
      const credentialIds = [...credentials.entries()]
        .filter(([, credential]) => credential.threadId === threadId)
        .map(([providerSessionId]) => providerSessionId);
      revokeThread(threadId);
      try {
        await closeSessions(
          [...activeSessions.values()].filter((session) => session.threadId === threadId),
        );
      } finally {
        for (const providerSessionId of credentialIds) credentials.delete(providerSessionId);
      }
    };
    const revokeAllAndWait = async (): Promise<void> => {
      revokeAll();
      try {
        await closeSessions([...activeSessions.values()]);
      } finally {
        credentials.clear();
      }
    };

    const stream = Stream.callback<DesktopApprovalSnapshot>(
      (mailbox) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (value: DesktopApprovalSnapshot) => Queue.offerUnsafe(mailbox, value);
            listeners.add(listener);
            Queue.offerUnsafe(mailbox, snapshot());
            return listener;
          }),
          (listener) => Effect.sync(() => listeners.delete(listener)),
        ).pipe(Effect.asVoid),
      { bufferSize: 1, strategy: "sliding" },
    );

    return ComputerUseLinuxApprovalBroker.of({
      request,
      respond,
      revokeSession,
      revokeThread,
      revokeAll,
      activateSession,
      registerSession,
      revokeSessionAndWait,
      revokeThreadAndWait,
      revokeAllAndWait,
      credentialCount: () => credentials.size,
      snapshot,
      stream,
    });
  });

export const layer = (options: ComputerUseLinuxApprovalBrokerOptions) =>
  Layer.effect(
    ComputerUseLinuxApprovalBroker,
    Effect.acquireRelease(make(options), (broker) =>
      Effect.promise(() => broker.revokeAllAndWait()),
    ),
  );

export const layerApprovalSurface = Layer.effect(
  ComputerUseLinuxApprovalSurfaceService,
  ComputerUseLinuxApprovalBroker.pipe(
    Effect.map((broker) => ComputerUseLinuxApprovalSurfaceService.of({ request: broker.request })),
  ),
);

export const layerRevocation = Layer.effect(
  ComputerUseLinuxApprovalRevocation,
  ComputerUseLinuxApprovalBroker.pipe(
    Effect.map((broker) =>
      ComputerUseLinuxApprovalRevocation.of({
        activateSession: broker.activateSession,
        registerSession: broker.registerSession,
        revokeSession: broker.revokeSessionAndWait,
        revokeThread: broker.revokeThreadAndWait,
      }),
    ),
  ),
);

/** Fail-closed service for builds that do not compose the optional desktop deployment. */
export const disabled = ComputerUseLinuxApprovalBroker.of({
  request: async () => false,
  respond: () => false,
  revokeSession: () => undefined,
  revokeThread: () => undefined,
  revokeAll: () => undefined,
  activateSession: () => undefined,
  registerSession: () => ({ revoked: false, unregister: () => undefined }),
  revokeSessionAndWait: async () => undefined,
  revokeThreadAndWait: async () => undefined,
  revokeAllAndWait: async () => undefined,
  credentialCount: () => 0,
  snapshot: () => ({ requests: [] }),
  stream: Stream.make({ requests: [] }),
});

export const __testing = {
  defaultTtlMs: DEFAULT_APPROVAL_TTL_MS,
  maxArgumentBytes: MAX_ARGUMENT_BYTES,
  maxPendingApprovals: MAX_PENDING_APPROVALS,
};
