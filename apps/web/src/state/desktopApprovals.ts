import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const desktopApprovalEnvironment = {
  state: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:desktop-approvals",
    tag: WS_METHODS.subscribeDesktopApprovals,
    idleTtlMs: 0,
  }),
  respond: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:desktop-approval-respond",
    tag: WS_METHODS.desktopApprovalRespond,
  }),
};
