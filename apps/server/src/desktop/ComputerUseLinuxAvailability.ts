import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * Build/deployment gate, independent of the user setting. server.ts sets it on Linux, where it
 * also composes the desktop toolkit; anywhere else no session may be issued the capability.
 */
export const ComputerUseLinuxDeploymentEnabled = Context.Reference<boolean>(
  "t3/desktop/ComputerUseLinuxDeploymentEnabled",
  { defaultValue: () => false },
);

export interface ComputerUseLinuxApprovalRevocationShape {
  readonly activateSession: (input: {
    readonly providerSessionId: string;
    readonly threadId: ThreadId;
  }) => void;
  readonly registerSession: (input: {
    readonly close: () => Promise<void>;
    readonly providerSessionId: string;
    readonly threadId: ThreadId;
    readonly generation?: number;
  }) => { readonly revoked: boolean; readonly unregister: () => void };
  readonly revokeSession: (providerSessionId: string) => Promise<void>;
  readonly revokeThread: (threadId: ThreadId) => Promise<void>;
  /** Stop: end the thread's pending approvals and running desktop calls; later turns may call again. */
  readonly interruptThread: (threadId: ThreadId) => Promise<void>;
  /** A new turn starts: the thread may use the desktop again after a Stop. */
  readonly resumeThread: (threadId: ThreadId) => void;
  /** Counts the thread's Stops, read when a call begins and checked when its session registers. */
  readonly generation: (threadId: ThreadId) => number;
}

export const ComputerUseLinuxApprovalRevocation =
  Context.Reference<ComputerUseLinuxApprovalRevocationShape>(
    "t3/desktop/ComputerUseLinuxApprovalRevocation",
    {
      defaultValue: () => ({
        activateSession: () => undefined,
        registerSession: () => ({ revoked: false, unregister: () => undefined }),
        revokeSession: async () => undefined,
        revokeThread: async () => undefined,
        interruptThread: async () => undefined,
        resumeThread: () => undefined,
        generation: () => 0,
      }),
    },
  );
