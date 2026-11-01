import type { ServerProvider } from "@t3tools/contracts";
import {
  type UsageHeadroomWindow,
  usageHeadroomTone,
  usageHeadroomWindows,
} from "@t3tools/shared/usageLimits";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { usageProviderKind, useProviderColors } from "../usage/usageProviders";

const resetTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const resetWeekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** `14:30` for a reset within 12 hours, otherwise the weekday; null without an upcoming reset. */
function formatHeadroomReset(ring: UsageHeadroomWindow, now: number): string | null {
  const at = ring.window.resetsAt ? Date.parse(ring.window.resetsAt) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  const date = new Date(at);
  return at - now < 12 * 60 * 60 * 1000
    ? resetTimeFormat.format(date)
    : resetWeekdayFormat.format(date);
}

/** Remaining session and weekly usage as two short bars, for a provider row in the model sheet. */
export function ProviderHeadroom(props: { readonly provider: ServerProvider | undefined }) {
  const now = useNowMinuteMs();
  const colors = useProviderColors();
  const rings = usageHeadroomWindows(props.provider?.usageLimits, now);
  if (!props.provider || rings.length === 0) return null;
  const kind = usageProviderKind(props.provider.driver);
  const color = kind ? colors[kind] : null;
  // Failed probes keep the last good windows; dim them so they don't read as live.
  const stale = props.provider.usageLimits?.unavailable !== undefined;
  return (
    <View
      accessible
      accessibilityLabel={rings
        .map((ring) => {
          const reset = formatHeadroomReset(ring, now);
          return `${ring.kind === "weekly" ? "Weekly" : ring.shortLabel} ${ring.remaining}% left${reset ? `, resets ${reset}` : ""}`;
        })
        .join(", ")}
      className="flex-row items-center gap-2.5"
      style={stale ? { opacity: 0.5 } : undefined}
    >
      {rings.map((ring) => {
        const tone = usageHeadroomTone(ring.remaining);
        const reset = formatHeadroomReset(ring, now);
        return (
          <View key={ring.kind} className="flex-row items-center gap-1">
            <Text className="text-2xs font-t3-medium text-foreground-muted">{ring.shortLabel}</Text>
            <View className="h-1 w-6 flex-row overflow-hidden rounded-full bg-subtle">
              <View
                className={
                  tone === "critical"
                    ? "h-full rounded-full bg-red-500"
                    : tone === "low"
                      ? "h-full rounded-full bg-amber-500"
                      : "h-full rounded-full bg-foreground"
                }
                style={[
                  { flex: ring.remaining },
                  tone === "ok" && color && !stale ? { backgroundColor: color } : null,
                ]}
              />
              <View style={{ flex: 100 - ring.remaining }} />
            </View>
            <Text className="text-2xs tabular-nums text-foreground-muted">{ring.remaining}%</Text>
            {reset ? (
              <Text className="text-2xs tabular-nums text-foreground-muted opacity-70">
                ↻{reset}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
