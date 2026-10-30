import type { ServerProvider } from "@t3tools/contracts";
import { formatResetsIn, limitsNotice } from "@t3tools/shared/usageLimits";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { barColor } from "../usage/UsageLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type UsageRingWindow, usageRingTone, usageRingWindows } from "./UsageRing.logic";

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const KIND_LABEL = { session: "Session", weekly: "Weekly" } as const;

function ringColor(ring: UsageRingWindow, driver: ServerProvider["driver"], stale: boolean) {
  if (stale) return "var(--color-muted-foreground)";
  switch (usageRingTone(ring.remaining)) {
    case "critical":
      return "var(--color-error)";
    case "low":
      return "var(--color-warning)";
    case "ok":
      return barColor(driver);
  }
}

function UsageRing(props: {
  readonly ring: UsageRingWindow;
  readonly driver: ServerProvider["driver"];
  readonly now: number;
  readonly staleNotice: string | null;
  readonly tooltipSide?: "left" | "right" | "top" | "bottom";
}) {
  const { ring, now, staleNotice } = props;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const stale = staleNotice !== null;
  const color = ringColor(ring, props.driver, stale);
  // A passed reset already counts as full (see usageRingWindows), so only upcoming resets show.
  const upcomingReset =
    ring.window.resetsAt !== undefined && Date.parse(ring.window.resetsAt) > now
      ? ring.window.resetsAt
      : null;
  const resetsIn = upcomingReset ? formatResetsIn(ring.window, now) : null;
  const resetsAt = upcomingReset
    ? formatUpcomingTimestamp(upcomingReset, timestampFormat, now)
    : null;
  const kindLabel = KIND_LABEL[ring.kind];
  const title = ring.window.label === kindLabel ? kindLabel : `${kindLabel} · ${ring.window.label}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${title}: ${ring.remaining}% left${resetsIn ? `, ${resetsIn}` : ""}`}
            data-usage-ring={ring.kind}
            className={cn("relative block size-4 shrink-0 cursor-default", stale && "opacity-60")}
          />
        }
      >
        <svg viewBox="0 0 24 24" className="-rotate-90 size-full" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r={RADIUS}
            fill="none"
            className="stroke-muted-foreground/24"
            strokeWidth="3.5"
          />
          {ring.remaining > 0 ? (
            <circle
              cx="12"
              cy="12"
              r={RADIUS}
              fill="none"
              stroke={color}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - ring.remaining / 100)}
            />
          ) : null}
        </svg>
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center text-5xs font-medium text-muted-foreground"
        >
          {ring.centerLabel}
        </span>
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 rounded-sm bg-background px-px text-5xs font-semibold tabular-nums"
          style={stale || usageRingTone(ring.remaining) === "ok" ? undefined : { color }}
        >
          {ring.remaining}
        </span>
      </TooltipTrigger>
      <TooltipPopup side={props.tooltipSide ?? "top"} sideOffset={8} align="center">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {title}: {ring.remaining}% left
          </span>
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
          {staleNotice ? <span className="text-muted-foreground">{staleNotice}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Session and weekly rings for one provider instance; renders nothing without limit data. */
export function ProviderUsageRings(props: {
  readonly provider: ServerProvider;
  readonly now: number;
  readonly className?: string;
  readonly tooltipSide?: "left" | "right" | "top" | "bottom";
}) {
  const limits = props.provider.usageLimits;
  const rings = usageRingWindows(limits, props.now);
  if (rings.length === 0) return null;
  // Failed probes keep the last good windows; grey them so they don't read as live.
  const staleNotice = limits?.unavailable ? limitsNotice(limits) : null;
  return (
    <div className={cn("flex items-center justify-center gap-1", props.className)}>
      {rings.map((ring) => (
        <UsageRing
          key={ring.kind}
          ring={ring}
          driver={props.provider.driver}
          now={props.now}
          staleNotice={staleNotice}
          {...(props.tooltipSide ? { tooltipSide: props.tooltipSide } : {})}
        />
      ))}
    </div>
  );
}
