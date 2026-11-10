import { useAtomValue } from "@effect/atom-react";
import { minuteTick } from "@t3tools/client-runtime/clock";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  currentUsageWindow,
  describeUsageHeadroom,
  formatCountdown,
  formatDuration,
  limitsNotice,
  nextHeadroomReset,
  type ProviderUsageHeadroom,
  providerUsageHeadroom,
  type UsageHeadroomWindow,
  usageHeadroomGroups,
  type UsagePaceTone,
} from "@t3tools/shared/usageLimits";
import { Fragment, useSyncExternalStore } from "react";

import { useClientSettings, usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { formatResetClock } from "../../timestampFormat";
import { barColor, LimitWindows } from "../usage/UsageLimits";

export interface ModelPickerUsage {
  readonly now: number;
  readonly byInstance: ReadonlyMap<ProviderInstanceId, ProviderUsageHeadroom>;
}

const subscribeNever = () => () => {};

/**
 * Headroom per picker account while the Labs setting is on, re-read each minute so countdowns
 * tick and passed resets refill. Null while the setting is off; the clock then stays unsubscribed.
 */
export function useModelPickerUsage(
  environmentId: EnvironmentId | null,
  entries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly snapshot: ServerProvider;
  }>,
): ModelPickerUsage | null {
  const enabled = useClientSettings((settings) => settings.modelPickerUsageEnabled);
  const minute = useSyncExternalStore(
    enabled ? minuteTick.subscribe : subscribeNever,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (!enabled) return null;
  // The tick is UTC without an offset; `Date.parse` would read it as local time.
  const now = Date.parse(`${minute}:00Z`);
  const providers = config?.providers ?? entries.map((entry) => entry.snapshot);
  const sources = config?.usageLimitSources ?? [];
  const byInstance = new Map<ProviderInstanceId, ProviderUsageHeadroom>();
  for (const entry of entries) {
    const headroom = providerUsageHeadroom(entry.instanceId, providers, sources, now);
    if (headroom) byInstance.set(entry.instanceId, headroom);
  }
  return { now, byInstance };
}

// Outer ring: session window. Inner ring: provider-wide weekly window. Both sit outside a size-6 icon.
const RING_RADIUS = { session: 18, weekly: 14.5 } as const;
const RING_STROKE = 2;

const TONE_TEXT: Record<UsagePaceTone, string> = {
  ok: "text-success-foreground",
  warning: "text-warning-foreground",
  critical: "text-destructive-foreground",
};

// A shape next to the colour, so the tone does not rest on telling green from red.
const TONE_MARK: Record<UsagePaceTone, string | null> = {
  ok: null,
  warning: "▲",
  critical: "!",
};

function ringColor(window: UsageHeadroomWindow, accent: string): string {
  switch (window.tone) {
    case "critical":
      return "var(--color-error)";
    case "warning":
      return "var(--color-warning)";
    case "ok":
      return accent;
  }
}

/** Remaining session and weekly headroom as two thin rings around a provider icon. */
export function ProviderUsageHalo(props: {
  readonly headroom: ProviderUsageHeadroom;
  readonly driver: ServerProvider["driver"];
  readonly accentColor?: string | undefined;
  readonly className?: string;
}) {
  const rings = (["session", "weekly"] as const).flatMap((kind) => {
    const window = props.headroom[kind];
    return window ? [{ kind, window }] : [];
  });
  if (rings.length === 0) return null;
  const { stale } = props.headroom;
  const accent = normalizeProviderAccentColor(props.accentColor) ?? barColor(props.driver);
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      data-usage-halo
      className={cn(
        "-rotate-90 pointer-events-none absolute inset-0 size-full",
        stale && "opacity-50",
        props.className,
      )}
    >
      {rings.map(({ kind, window }) => {
        const radius = RING_RADIUS[kind];
        const circumference = 2 * Math.PI * radius;
        return (
          <g key={kind} data-usage-ring={kind}>
            <circle
              cx="20"
              cy="20"
              r={radius}
              fill="none"
              strokeWidth={RING_STROKE}
              className="stroke-foreground/10"
            />
            {window.remaining > 0 ? (
              <circle
                cx="20"
                cy="20"
                r={radius}
                fill="none"
                stroke={stale ? "var(--color-muted-foreground)" : ringColor(window, accent)}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - window.remaining / 100)}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** The soonest provider-wide reset under the icon: `14:30` today, otherwise the weekday. */
export function ProviderResetClock(props: {
  readonly headroom: ProviderUsageHeadroom;
  readonly now: number;
  readonly className?: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const next = nextHeadroomReset(props.headroom);
  if (!next?.resetsAt) return null;
  return (
    <span
      aria-hidden="true"
      data-usage-reset={next.kind}
      className={cn(
        "block text-center text-3xs leading-3 font-medium tabular-nums text-muted-foreground",
        props.className,
      )}
    >
      {formatResetClock(new Date(next.resetsAt).toISOString(), timestampFormat, props.now, {
        compact: true,
      })}
    </span>
  );
}

/**
 * The account's headroom as text, e.g. `5h 72% →2h10m | all: 41% • fable: 18% →3d4h`. Percentages
 * take the pace colour plus a mark when ahead of pace; countdowns stay muted.
 */
export function ProviderUsageText(props: {
  readonly headroom: ProviderUsageHeadroom;
  readonly now: number;
  readonly className?: string;
}) {
  const { headroom, now } = props;
  const groups = usageHeadroomGroups(headroom);
  if (groups.length === 0) return null;
  return (
    <span
      data-usage-text
      className={cn(
        "min-w-0 text-xs tabular-nums text-muted-foreground",
        headroom.stale && "opacity-60",
        props.className,
      )}
    >
      <span className="sr-only">{describeUsageHeadroom(headroom, now)}</span>
      <span aria-hidden="true">
        {groups.map((group, groupIndex) => (
          <Fragment key={group.windows[0]?.window.id ?? groupIndex}>
            {groupIndex > 0 ? <span className="text-muted-foreground/60"> | </span> : null}
            {group.windows.map((window, index) => {
              const mark = headroom.stale ? null : TONE_MARK[window.tone];
              return (
                <Fragment key={window.window.id}>
                  {index > 0 ? " • " : null}
                  {window.kind === "session" ? `${window.label} ` : `${window.label}: `}
                  <span
                    data-usage-tone={window.tone}
                    className={cn("font-medium", !headroom.stale && TONE_TEXT[window.tone])}
                  >
                    {window.remaining}%{mark}
                  </span>
                </Fragment>
              );
            })}
            {group.resetsAt === null ? null : (
              <span className="text-muted-foreground/80">
                {" "}
                →{formatCountdown(group.resetsAt - now)}
              </span>
            )}
          </Fragment>
        ))}
      </span>
    </span>
  );
}

/** The account's limit bars, as in Usage → Limits, for the provider tooltip. */
export function ProviderUsageTooltipDetails(props: {
  readonly headroom: ProviderUsageHeadroom;
  readonly driver: ServerProvider["driver"];
  readonly accentColor?: string | undefined;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { limits } = props.headroom;
  const checkedAt = Date.parse(limits.checkedAt);
  const formatReset = (window: ServerProviderUsageWindow) => {
    const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!window.resetsAt || !Number.isFinite(at) || at <= props.now) return null;
    return `${formatResetClock(window.resetsAt, timestampFormat, props.now)} · ${formatDuration(at - props.now)}`;
  };
  const notice = props.headroom.stale ? limitsNotice(limits) : null;
  return (
    <div className="mt-2 flex w-80 flex-col gap-1.5 border-t border-border/60 pt-2">
      <ProviderUsageText headroom={props.headroom} now={props.now} />
      <LimitWindows
        compact
        driver={props.driver}
        accentColor={props.accentColor}
        windows={limits.windows.map((window) => currentUsageWindow(window, checkedAt, props.now))}
        formatReset={formatReset}
        now={props.now}
      />
      {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
    </div>
  );
}
