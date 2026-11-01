import { DEFAULT_SERVER_SETTINGS, type ServerProvider } from "@t3tools/contracts";
import { planUsageResets, type PlannedAccount } from "@t3tools/shared/resetPlanner";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { providerClients } from "./providerDriverMeta";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const STATE_LABEL: Record<PlannedAccount["state"], string> = {
  running: "Week running",
  idle: "Not started",
  unknown: "No weekly limit",
};

function driverLabel(driver: string) {
  return providerClients.get(driver as ServerProvider["driver"])?.label ?? driver;
}

/** Spread weekly resets, plus the plan it produces and the recorded reset forecast. */
export function ResetPlannerRows(props: { readonly providers: ReadonlyArray<ServerProvider> }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["usageResetStaggering"]);
  const timestampFormat = usePrimarySettings((primary) => primary.timestampFormat);
  // Settings pages stay open briefly; the plan is judged against when the page opened.
  const [now] = useState(() => Date.now());
  const plan = planUsageResets({ providers: props.providers, settings, now });
  const groups = plan.groups.filter((group) => group.accounts.length > 0);
  const when = (at: number | null) =>
    at === null ? "-" : formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, now);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["usageResetStaggering"]}
        mixed={mixed}
        id="usage-reset-staggering"
        title="Spread weekly resets"
        description="With several accounts of one provider, start each account's weekly window on a different day, so they don't all run out and reset together. Automatic account selection holds an unstarted account back until its planned start."
        resetAction={
          settings.usageResetStaggering !== DEFAULT_SERVER_SETTINGS.usageResetStaggering ? (
            <SettingResetButton
              label="weekly reset spreading"
              tooltip="Turn weekly reset spreading off"
              onClick={() => updateSettings({ usageResetStaggering: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Spread weekly resets"
            mixed={mixed}
            checked={mixed ? false : settings.usageResetStaggering}
            onCheckedChange={(enabled) => updateSettings({ usageResetStaggering: enabled })}
          />
        }
      />
      {groups.length > 0 || plan.forecast.length > 0 ? (
        <SettingsRow
          id="usage-reset-plan"
          title="Reset plan"
          description="Session and weekly resets per account, banked resets with their expiry, and resets expected from research (agents record them with t3_usage_forecast_add)."
        >
          <div className="mt-3 flex flex-col gap-4 text-xs">
            {groups.map((group) => (
              <div key={group.driver} className="flex flex-col gap-1">
                <span className="font-medium text-foreground">{driverLabel(group.driver)}</span>
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 gap-y-1 tabular-nums">
                  <span className="text-muted-foreground">Account</span>
                  <span className="text-muted-foreground">5h reset</span>
                  <span className="text-muted-foreground">Weekly reset</span>
                  <span className="text-muted-foreground">Banked resets</span>
                  {group.accounts.map((account) => (
                    <PlanRow key={account.instanceId} account={account} when={when} />
                  ))}
                </div>
              </div>
            ))}
            {plan.forecast.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="font-medium text-foreground">Expected resets</span>
                {plan.forecast.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {driverLabel(entry.driver)} · {entry.kind.replace("-", " ")} ·{" "}
                      {when(Date.parse(entry.expectedAt))} · {Math.round(entry.confidence * 100)}%
                      {entry.note ? ` · ${entry.note}` : ""}
                    </span>
                    {entry.source && /^https?:\/\//i.test(entry.source) ? (
                      <a
                        href={entry.source}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-muted-foreground underline underline-offset-2"
                      >
                        Source
                      </a>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Remove expected reset"
                      onClick={() =>
                        updateSettings({
                          usageResetForecast: settings.usageResetForecast.filter(
                            (candidate) => candidate.id !== entry.id,
                          ),
                        })
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}

function PlanRow(props: {
  readonly account: PlannedAccount;
  readonly when: (at: number | null) => string;
}) {
  const { account, when } = props;
  const credits = account.credits;
  return (
    <>
      <span className="min-w-0 truncate">
        {account.name}
        <span className="ms-2 text-muted-foreground">
          {account.plannedStartAt !== null
            ? `starts ${when(account.plannedStartAt)}`
            : STATE_LABEL[account.state]}
        </span>
      </span>
      <span>{when(account.sessionResetAt)}</span>
      <span className={cn(account.plannedStartAt !== null && "text-muted-foreground")}>
        {when(account.weeklyResetAt)}
      </span>
      <span className={cn(credits?.expiresFirst && "text-warning-foreground")}>
        {credits
          ? `${credits.count}${credits.expiresAt === null ? "" : `, expires ${when(credits.expiresAt)}`}`
          : "-"}
      </span>
    </>
  );
}
