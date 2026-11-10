import {
  EnvironmentOfflineWindow,
  EnvironmentSchedule,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
/** How busy this machine is right now; absent from servers that don't report it. */
export const EnvironmentLoad = Schema.Struct({
  cpuUtilization: Schema.NullOr(Schema.Number),
  cpuCount: Schema.Number,
  availableMemoryBytes: Schema.Number,
  totalMemoryBytes: Schema.Number,
});
export type EnvironmentLoad = typeof EnvironmentLoad.Type;

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
export const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    load: Schema.optional(EnvironmentLoad),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const EnvironmentLoadsTool = Tool.make("t3_environment_loads", {
  ...shared,
  dependencies: [...shared.dependencies, PeerForwarding.PeerForwarding],
  description:
    "CPU and memory load of this machine and every reachable linked one: available machines first, then least busy. Before delegating heavy work or subagents with `delegate_task`, prefer an available, least busy environment; for long work avoid one whose `changesAt` (planned off time) is soon. If it lacks the project, clone it there with `t3_project_clone` and register it with `t3_project_create`. `load` is null where the server doesn't report it.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    environments: Schema.Array(
      Schema.Struct({
        environmentId: Schema.String,
        label: Schema.String,
        current: Schema.Boolean,
        load: Schema.NullOr(EnvironmentLoad),
        /** 0 idle to 1 saturated: CPU weighted 0.6, memory in use 0.4. */
        busy: Schema.NullOr(Schema.Number),
        /** From the machine's schedule (`t3_environment_schedule_set`); true without one. */
        availableNow: Schema.Boolean,
        /** When availability changes next (planned off or back on); null if never. */
        changesAt: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentScheduleTool = Tool.make("t3_environment_schedule_set", {
  ...shared,
  description:
    "Record when a machine (this one or a linked one) is usually off, so work is not placed on it just before it shuts down. `alwaysOn: true` clears planned off times. Times are wall-clock times in `timeZone` (default: this server's zone), correct across daylight-saving changes; a window ending before it starts runs past midnight. Only when the user says so.",
  parameters: Schema.Struct({
    machineEnvironmentId: Schema.String.annotate({
      description: "environmentId from t3_environment_links or t3_environment_read.",
    }),
    alwaysOn: Schema.Boolean,
    timeZone: Schema.optional(
      Schema.String.annotate({ description: 'IANA time zone, e.g. "Europe/Berlin".' }),
    ),
    offline: Schema.optional(Schema.Array(EnvironmentOfflineWindow)),
  }),
  success: Schema.Struct({ schedules: Schema.Array(EnvironmentSchedule) }),
}).annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentLoadsTool,
  EnvironmentScheduleTool,
);
