import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ThreadId } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  ComputerUseLinuxApprovalRevocation,
  type ComputerUseLinuxApprovalRevocationShape,
} from "./ComputerUseLinuxAvailability.ts";
import type { ComputerUseLinuxBridgeRequest } from "./ComputerUseLinuxBridge.ts";
import {
  type ComputerUseLinuxApprovalSurface,
  type ComputerUseLinuxUpstreamFactory,
  startComputerUseLinuxCallsite,
} from "./ComputerUseLinuxCallsite.ts";
import {
  ComputerUseLinuxHostLease,
  type ComputerUseLinuxLease,
  userLeaseScopeKey,
} from "./ComputerUseLinuxHostLease.ts";
import type {
  ComputerUseLinuxMcpAdapter,
  ComputerUseLinuxMcpTool,
} from "./ComputerUseLinuxMcpAdapter.ts";

const COMPUTER_USE_LINUX_LEASE_SECRET = "computer-use-linux-lease-scope-v1";
const COMPUTER_USE_LINUX_LEASE_SECRET_BYTES = 32;

export class ComputerUseLinuxApprovalSurfaceService extends Context.Service<
  ComputerUseLinuxApprovalSurfaceService,
  ComputerUseLinuxApprovalSurface
>()("t3/desktop/ComputerUseLinuxServerIntegration/ComputerUseLinuxApprovalSurfaceService") {}

export class ComputerUseLinuxUpstreamFactoryService extends Context.Service<
  ComputerUseLinuxUpstreamFactoryService,
  ComputerUseLinuxUpstreamFactory
>()("t3/desktop/ComputerUseLinuxServerIntegration/ComputerUseLinuxUpstreamFactoryService") {}

export const ComputerUseLinuxLeaseFactory = Context.Reference<{
  readonly make: (input: {
    readonly platform: NodeJS.Platform;
    readonly scopeKey: string;
  }) => ComputerUseLinuxLease;
}>("t3/desktop/ComputerUseLinuxLeaseFactory", {
  defaultValue: () => ({ make: (input) => new ComputerUseLinuxHostLease(input) }),
});

/** Where this OS user's shared lease key comes from; tests replace it. */
export const ComputerUseLinuxUserLeaseKey = Context.Reference<{
  readonly resolve: typeof userLeaseScopeKey;
}>("t3/desktop/ComputerUseLinuxUserLeaseKey", {
  defaultValue: () => ({ resolve: userLeaseScopeKey }),
});

export class ComputerUseLinuxStartError extends Schema.TaggedError<ComputerUseLinuxStartError>()(
  "ComputerUseLinuxStartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to start the mediated Computer Use for Linux session.";
  }
}

type BoundCall = Pick<ComputerUseLinuxBridgeRequest, "arguments" | "toolName">;

/**
 * A session-bound handle deliberately exposes no identity fields. Every call receives the
 * provider instance, provider session, and thread captured from the authenticated MCP request.
 */
class ComputerUseLinuxBoundSession {
  private readonly adapter: ComputerUseLinuxMcpAdapter;
  private closePromise: Promise<void> | undefined;
  private readonly identity: Pick<
    ComputerUseLinuxBridgeRequest,
    "providerInstanceId" | "providerSessionId" | "threadId"
  >;
  private readonly unregister: () => void;

  constructor(
    adapter: ComputerUseLinuxMcpAdapter,
    identity: Pick<
      ComputerUseLinuxBridgeRequest,
      "providerInstanceId" | "providerSessionId" | "threadId"
    >,
    lifecycle: ComputerUseLinuxApprovalRevocationShape,
  ) {
    this.adapter = adapter;
    this.identity = { ...identity };
    const registration = lifecycle.registerSession({
      close: () => this.close(),
      providerSessionId: identity.providerSessionId,
      threadId: ThreadId.make(identity.threadId),
    });
    this.unregister = registration.unregister;
    if (registration.revoked) {
      this.adapter.revoke();
      this.closePromise = this.adapter.close().finally(this.unregister);
    }
  }

  listTools(): Promise<ReadonlyArray<ComputerUseLinuxMcpTool>> {
    return this.adapter.listTools();
  }

  callTool(request: BoundCall): Promise<unknown> {
    return this.adapter.callTool({ ...request, ...this.identity });
  }

  revoke(): void {
    this.adapter.revoke();
  }

  /** Closed by revocation, Stop, shutdown or its owner; a closed session takes no more calls. */
  get closed(): boolean {
    return this.closePromise !== undefined;
  }

  close(): Promise<void> {
    this.closePromise ??= this.adapter.close().finally(this.unregister);
    return this.closePromise;
  }
}

/**
 * Creates a mediated desktop session from the already authenticated `/mcp` request context.
 * No environment variable or MCP argument participates in identity or lease-key selection.
 */
export const startComputerUseLinuxForCurrentMcpInvocation = Effect.fn(
  "ComputerUseLinuxServerIntegration.startForCurrentMcpInvocation",
)(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const scoped = yield* McpInvocationContext.requireThreadScope(
    invocation,
    "Computer Use for Linux",
  );
  yield* McpInvocationContext.requireMcpCapability("desktop");
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const approvalSurface = yield* ComputerUseLinuxApprovalSurfaceService;
  const lifecycle = yield* ComputerUseLinuxApprovalRevocation;
  const upstreamFactory = yield* ComputerUseLinuxUpstreamFactoryService;
  const leaseFactory = yield* ComputerUseLinuxLeaseFactory;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const userLeaseKey = yield* ComputerUseLinuxUserLeaseKey;
  // Shared by this user's T3 servers; this installation's own secret only when the file fails.
  const leaseScopeKey = yield* Effect.tryPromise({
    try: () => userLeaseKey.resolve({ platform, environment, homeDirectory }),
    catch: (cause) => new ComputerUseLinuxStartError({ cause }),
  }).pipe(
    Effect.catch(() =>
      secretStore
        .getOrCreateRandom(COMPUTER_USE_LINUX_LEASE_SECRET, COMPUTER_USE_LINUX_LEASE_SECRET_BYTES)
        .pipe(Effect.map((secret) => Buffer.from(secret).toString("base64url"))),
    ),
  );
  const identity = {
    providerInstanceId: scoped.thread.providerInstanceId,
    providerSessionId: scoped.thread.providerSessionId,
    threadId: scoped.thread.threadId,
  };
  const adapter = yield* Effect.tryPromise({
    try: () =>
      startComputerUseLinuxCallsite({
        approvalSurface,
        leaseFactory: leaseFactory.make,
        leaseScopeKey,
        platform,
        ...identity,
        upstreamFactory,
      }),
    catch: (cause) => new ComputerUseLinuxStartError({ cause }),
  });
  return new ComputerUseLinuxBoundSession(adapter, identity, lifecycle);
});

export const __testing = {
  leaseSecretBytes: COMPUTER_USE_LINUX_LEASE_SECRET_BYTES,
  leaseSecretName: COMPUTER_USE_LINUX_LEASE_SECRET,
};
