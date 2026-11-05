import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import { type EnvironmentLoad, EnvironmentReadTool, EnvironmentToolkit } from "./tools.ts";

const PEER_LOAD_TIMEOUT = "5 seconds";

const readLoad: Effect.Effect<EnvironmentLoad | null> = Effect.serviceOption(
  HostResources.HostResources,
).pipe(
  Effect.flatMap((service) =>
    service._tag === "None"
      ? Effect.succeed(null)
      : service.value.read.pipe(
          Effect.map((snapshot): EnvironmentLoad | null => ({
            cpuUtilization: snapshot.cpuUtilization,
            cpuCount: snapshot.cpuCount,
            availableMemoryBytes: snapshot.availableMemoryBytes,
            totalMemoryBytes: snapshot.totalMemoryBytes,
          })),
        ),
  ),
);

/** 0 idle to 1 saturated; null without a CPU reading or memory total. */
export function environmentBusyScore(load: EnvironmentLoad | null | undefined): number | null {
  if (!load || load.cpuUtilization === null || load.totalMemoryBytes <= 0) return null;
  const memoryInUse = 1 - Math.min(1, load.availableMemoryBytes / load.totalMemoryBytes);
  return Math.round((0.6 * load.cpuUtilization + 0.4 * memoryInUse) * 1000) / 1000;
}

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        ...(yield* readLoad.pipe(Effect.map((load) => (load ? { load } : {})))),
      };
    }),
  ),
  t3_environment_loads: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { descriptor } = yield* access;
      const local = yield* readLoad;
      const entries = [
        {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          current: true,
          load: local,
        },
      ];
      const forwarding = yield* PeerForwarding.PeerForwarding;
      const links = yield* forwarding.links(scope).pipe(
        Effect.map((result) => result.links),
        Effect.orElseSucceed(() => []),
      );
      const remote = yield* Effect.forEach(
        links.filter((link) => link.status === "reachable"),
        (link) =>
          forwarding
            .call(scope, EnvironmentReadTool, link.environmentId, {
              environmentId: link.environmentId,
            })
            .pipe(
              Effect.timeout(PEER_LOAD_TIMEOUT),
              Effect.map((result) => result.load ?? null),
              Effect.orElseSucceed(() => null),
              Effect.map((load) => ({
                environmentId: link.environmentId,
                label: link.label,
                current: false,
                load,
              })),
            ),
        { concurrency: "unbounded" },
      );
      const environments = [...entries, ...remote]
        .map((entry) => ({ ...entry, busy: environmentBusyScore(entry.load) }))
        .sort((left, right) => (left.busy ?? 2) - (right.busy ?? 2));
      return { environments };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
