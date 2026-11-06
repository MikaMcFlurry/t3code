import * as Schema from "effect/Schema";

import type {
  ComputerUseLinuxBridgeRequest,
  ComputerUseLinuxInteractionApproval,
} from "./ComputerUseLinuxBridge.ts";
import {
  ComputerUseLinuxHostLease,
  ComputerUseLinuxLeasePlatformError,
  type ComputerUseLinuxLease,
} from "./ComputerUseLinuxHostLease.ts";
import {
  ComputerUseLinuxMcpAdapter,
  type ComputerUseLinuxUpstreamMcpClient,
} from "./ComputerUseLinuxMcpAdapter.ts";
import { COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT } from "./ComputerUseLinuxPolicy.ts";

export interface ComputerUseLinuxApprovalSurface {
  request(
    request: ComputerUseLinuxBridgeRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<boolean>;
}

export interface ComputerUseLinuxUpstreamFactory {
  start(options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<ComputerUseLinuxUpstreamMcpClient>;
}

export interface ComputerUseLinuxCallsiteOptions {
  readonly approvalSurface: ComputerUseLinuxApprovalSurface;
  /** Stable per-installation secret obtained from T3's secret store, never provider input. */
  readonly leaseScopeKey: string;
  readonly platform: NodeJS.Platform;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly threadId: string;
  readonly upstreamFactory: ComputerUseLinuxUpstreamFactory;
  /** Test seam for the composition root; production callers omit it. */
  readonly leaseFactory?: (input: {
    readonly platform: NodeJS.Platform;
    readonly scopeKey: string;
  }) => ComputerUseLinuxLease;
}

export class ComputerUseLinuxLeaseScopeKeyError extends Schema.TaggedError<ComputerUseLinuxLeaseScopeKeyError>()(
  "ComputerUseLinuxLeaseScopeKeyError",
  {},
) {
  override get message(): string {
    return "Computer Use lease scope requires a non-empty server-owned key.";
  }
}

function lazyUpstream(factory: ComputerUseLinuxUpstreamFactory): ComputerUseLinuxUpstreamMcpClient {
  const startupController = new AbortController();
  let started: Promise<ComputerUseLinuxUpstreamMcpClient> | undefined;
  const get = () =>
    (started ??= factory.start({
      environment: COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT,
      signal: startupController.signal,
    }));
  return {
    callTool: async (input, options) => {
      const abortStartup = () => startupController.abort();
      options.signal.addEventListener("abort", abortStartup, { once: true });
      if (options.signal.aborted) abortStartup();
      try {
        return await (await get()).callTool(input, options);
      } finally {
        options.signal.removeEventListener("abort", abortStartup);
      }
    },
    close: async () => {
      startupController.abort();
      if (started === undefined) return;
      const upstream = await started.catch(() => undefined);
      await upstream?.close();
    },
    listTools: async () => (await get()).listTools(),
  };
}

/**
 * Server-owned composition root for the mediated desktop client. The provider never supplies
 * environment flags, lease identity, approval implementation, or bound session identity.
 */
export async function startComputerUseLinuxCallsite(
  options: ComputerUseLinuxCallsiteOptions,
): Promise<ComputerUseLinuxMcpAdapter> {
  if (options.platform !== "linux") {
    throw new ComputerUseLinuxLeasePlatformError({ platform: options.platform });
  }
  if (options.leaseScopeKey.trim().length === 0) {
    throw new ComputerUseLinuxLeaseScopeKeyError();
  }
  const lease = (options.leaseFactory ?? ((input) => new ComputerUseLinuxHostLease(input)))({
    platform: options.platform,
    scopeKey: options.leaseScopeKey,
  });
  const upstream = lazyUpstream(options.upstreamFactory);
  const approve: ComputerUseLinuxInteractionApproval = (request, approvalOptions) =>
    options.approvalSurface.request(request, approvalOptions);
  return new ComputerUseLinuxMcpAdapter(
    upstream,
    lease,
    {
      providerInstanceId: options.providerInstanceId,
      providerSessionId: options.providerSessionId,
      threadId: options.threadId,
    },
    approve,
  );
}
