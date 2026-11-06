import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * Build/deployment gate, independent of the user setting. Production stays false until a real
 * approval surface and the optional desktop layer are deliberately composed into the server.
 */
export const ComputerUseLinuxDeploymentEnabled = Context.Reference<boolean>(
  "t3/desktop/ComputerUseLinuxDeploymentEnabled",
  { defaultValue: () => false },
);

export const layerEnabled = Layer.succeed(ComputerUseLinuxDeploymentEnabled, true);

export interface ComputerUseLinuxApprovalRevocationShape {
  readonly activateSession: (input: {
    readonly providerSessionId: string;
    readonly threadId: ThreadId;
  }) => void;
  readonly registerSession: (input: {
    readonly close: () => Promise<void>;
    readonly providerSessionId: string;
    readonly threadId: ThreadId;
  }) => { readonly revoked: boolean; readonly unregister: () => void };
  readonly revokeSession: (providerSessionId: string) => Promise<void>;
  readonly revokeThread: (threadId: ThreadId) => Promise<void>;
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
      }),
    },
  );
