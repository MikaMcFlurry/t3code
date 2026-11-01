import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import type { ServerProvider } from "@t3tools/contracts";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  currentUsageWindow,
  formatDuration,
  limitsNotice,
  nextHeadroomReset,
  type UsageHeadroomWindow,
  usageHeadroomTone,
  usageHeadroomWindows,
} from "@t3tools/shared/usageLimits";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatResetClock } from "../../timestampFormat";
import { barColor, LimitWindows } from "../usage/UsageLimits";

// Outer ring: session window. Inner ring: tightest weekly window. Both sit outside a size-6 icon.
const RING_RADIUS = { session: 18, weekly: 14.5 } as const;
const RING_STROKE = 2;

function ringColor(ring: UsageHeadroomWindow, accent: string): string {
  switch (usageHeadroomTone(ring.remaining)) {
    case "critical":
      return "var(--color-error)";
    case "low":
      return "var(--color-warning)";
    case "ok":
      return accent;
  }
}

/** Remaining session and weekly usage as two thin rings around a provider icon. */
export function ProviderUsageHalo(props: {
  readonly provider: ServerProvider;
  readonly accentColor?: string | undefined;
  readonly now: number;
  readonly className?: string;
}) {
  const rings = usageHeadroomWindows(props.provider.usageLimits, props.now);
  if (rings.length === 0) return null;
  // Failed probes keep the last good windows; grey them so they don't read as live.
  const stale = props.provider.usageLimits?.unavailable !== undefined;
  const accent = normalizeProviderAccentColor(props.accentColor) ?? barColor(props.provider.driver);
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
      {rings.map((ring) => {
        const radius = RING_RADIUS[ring.kind];
        const circumference = 2 * Math.PI * radius;
        return (
          <g key={ring.kind} data-usage-ring={ring.kind}>
            <circle
              cx="20"
              cy="20"
              r={radius}
              fill="none"
              strokeWidth={RING_STROKE}
              className="stroke-foreground/10"
            />
            {ring.remaining > 0 ? (
              <circle
                cx="20"
                cy="20"
                r={radius}
                fill="none"
                stroke={stale ? "var(--color-muted-foreground)" : ringColor(ring, accent)}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - ring.remaining / 100)}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** The soonest reset under the icon: `14:30` today, otherwise the weekday. */
export function ProviderResetClock(props: {
  readonly provider: ServerProvider;
  readonly now: number;
  readonly className?: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const next = nextHeadroomReset(
    usageHeadroomWindows(props.provider.usageLimits, props.now),
    props.now,
  );
  if (!next?.window.resetsAt) return null;
  const tone = usageHeadroomTone(next.remaining);
  return (
    <span
      aria-hidden="true"
      data-usage-reset={next.kind}
      className={cn(
        "block text-center text-3xs leading-3 font-medium tabular-nums text-muted-foreground",
        tone === "critical" && "text-destructive-foreground",
        tone === "low" && "text-warning-foreground",
        props.className,
      )}
    >
      {formatResetClock(next.window.resetsAt, timestampFormat, props.now, { compact: true })}
    </span>
  );
}

/** Screen-reader text for the halo, e.g. "5h 72% left, weekly 40% left". */
export function usageHeadroomLabel(provider: ServerProvider, now: number): string | null {
  const rings = usageHeadroomWindows(provider.usageLimits, now);
  if (rings.length === 0) return null;
  return rings
    .map((ring) => {
      const resetsIn = ring.window.resetsAt ? formatResetsInShort(ring.window, now) : null;
      return `${ring.kind === "weekly" ? "weekly" : ring.shortLabel} ${ring.remaining}% left${resetsIn ? `, resets in ${resetsIn}` : ""}`;
    })
    .join(", ");
}

/** The account's limit bars, as in Usage → Limits, for the provider tooltip. */
export function ProviderUsageTooltipDetails(props: {
  readonly provider: ServerProvider;
  readonly accentColor?: string | undefined;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const limits = props.provider.usageLimits;
  if (usageHeadroomWindows(limits, props.now).length === 0 || !limits) return null;
  const formatReset = (window: ServerProviderUsageWindow) => {
    const resetsIn = formatResetsInShort(window, props.now);
    if (!window.resetsAt || resetsIn === null) return null;
    return `${formatResetClock(window.resetsAt, timestampFormat, props.now)} · ${resetsIn}`;
  };
  const notice = limits.unavailable ? limitsNotice(limits) : null;
  return (
    <div className="mt-2 flex w-80 flex-col gap-1.5 border-t border-border/60 pt-2">
      <LimitWindows
        compact
        driver={props.provider.driver}
        accentColor={props.accentColor}
        windows={limits.windows.map((window) => currentUsageWindow(window, props.now))}
        formatReset={formatReset}
        now={props.now}
      />
      {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
    </div>
  );
}

function formatResetsInShort(window: ServerProviderUsageWindow, now: number): string | null {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(at) && at > now ? formatDuration(at - now) : null;
}
