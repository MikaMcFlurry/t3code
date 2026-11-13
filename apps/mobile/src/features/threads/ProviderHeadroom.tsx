import { useAtomValue } from "@effect/atom-react";
import { minuteTick } from "@t3tools/client-runtime/clock";
import type { ServerProvider, UsageLimitSourceSnapshots } from "@t3tools/contracts";
import {
  describeUsageHeadroom,
  formatCountdown,
  type ProviderUsageHeadroom,
  providerUsageHeadroom,
  usageHeadroomGroups,
  type UsagePaceTone,
} from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import { Fragment, useSyncExternalStore } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { minuteTickToEpochMs } from "../../lib/clock";
import type { ProviderGroup } from "../../lib/modelOptions";
import { mobilePreferencesAtom } from "../../state/preferences";

export interface ProviderUsage {
  readonly now: number;
  readonly byProvider: ReadonlyMap<string, ProviderUsageHeadroom>;
}

const subscribeNever = () => () => {};

/**
 * Headroom per provider group while the Labs preference is on, re-read each minute so countdowns
 * tick. Same rule as the web picker: `providerUsageHeadroom` from `@t3tools/shared/usageLimits`.
 */
export function useProviderUsage(
  groups: ReadonlyArray<ProviderGroup>,
  config:
    | {
        readonly providers: readonly ServerProvider[];
        readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      }
    | undefined,
): ProviderUsage | null {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.modelPickerUsageEnabled === true;
  const minute = useSyncExternalStore(
    enabled ? minuteTick.subscribe : subscribeNever,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
  if (!enabled || !config) return null;
  const now = minuteTickToEpochMs(minute);
  const byProvider = new Map<string, ProviderUsageHeadroom>();
  for (const group of groups) {
    const instanceId = group.models[0]?.selection.instanceId;
    const headroom = instanceId
      ? providerUsageHeadroom(instanceId, config.providers, config.usageLimitSources ?? [], now)
      : null;
    if (headroom) byProvider.set(group.providerKey, headroom);
  }
  return { now, byProvider };
}

const TONE_TEXT: Record<UsagePaceTone, string> = {
  ok: "text-foreground",
  warning: "text-warning-foreground",
  critical: "text-danger-foreground",
};

// A shape next to the colour, so the tone does not rest on telling green from red.
const TONE_MARK: Record<UsagePaceTone, string> = { ok: "", warning: "▲", critical: "!" };

/** `5h 72% →2h10m | all: 41% • fable: 18% →3d4h` for a provider header in the model sheet. */
export function ProviderHeadroom(props: {
  readonly headroom: ProviderUsageHeadroom;
  readonly now: number;
}) {
  const { headroom, now } = props;
  const groups = usageHeadroomGroups(headroom);
  if (groups.length === 0) return null;
  return (
    <Text
      accessibilityLabel={describeUsageHeadroom(headroom, now)}
      numberOfLines={1}
      className="shrink text-2xs tabular-nums text-foreground-tertiary"
      style={headroom.stale ? { opacity: 0.6 } : undefined}
    >
      {groups.map((group, groupIndex) => (
        <Fragment key={group.windows[0]?.window.id ?? groupIndex}>
          {groupIndex > 0 ? " | " : ""}
          {group.windows.map((window, index) => (
            <Fragment key={window.window.id}>
              {index > 0 ? " • " : ""}
              {window.kind === "session" ? `${window.label} ` : `${window.label}: `}
              <Text
                className={cn(
                  "text-2xs font-t3-medium",
                  headroom.stale ? "text-foreground-tertiary" : TONE_TEXT[window.tone],
                )}
              >
                {window.remaining}%{headroom.stale ? "" : TONE_MARK[window.tone]}
              </Text>
            </Fragment>
          ))}
          {group.resetsAt === null ? "" : ` →${formatCountdown(group.resetsAt - now)}`}
        </Fragment>
      ))}
    </Text>
  );
}
