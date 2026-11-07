import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DesktopApprovalId = Schema.String.pipe(Schema.brand("DesktopApprovalId"));
export type DesktopApprovalId = typeof DesktopApprovalId.Type;

export const DesktopApprovalRequest = Schema.Struct({
  id: DesktopApprovalId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: Schema.String,
  toolName: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type DesktopApprovalRequest = typeof DesktopApprovalRequest.Type;

export const DesktopApprovalSnapshot = Schema.Struct({
  requests: Schema.Array(DesktopApprovalRequest),
});
export type DesktopApprovalSnapshot = typeof DesktopApprovalSnapshot.Type;

export const DesktopApprovalRespondInput = Schema.Struct({
  id: DesktopApprovalId,
  threadId: ThreadId,
  decision: Schema.Union([Schema.Literal("approve"), Schema.Literal("deny")]),
});
export type DesktopApprovalRespondInput = typeof DesktopApprovalRespondInput.Type;

export const DesktopApprovalRespondResult = Schema.Struct({ accepted: Schema.Boolean });
export type DesktopApprovalRespondResult = typeof DesktopApprovalRespondResult.Type;
