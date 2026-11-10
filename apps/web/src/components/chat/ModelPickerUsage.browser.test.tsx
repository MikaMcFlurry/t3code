import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { updateClientSettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function claude(input: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly now: number;
  readonly sessionUsed: number;
  readonly weeklyUsed: number;
  readonly fableUsed?: number;
}): ServerProvider {
  const at = (offset: number) => DateTime.formatIso(DateTime.makeUnsafe(input.now + offset));
  const weeklyReset = at(3 * DAY + 4 * HOUR + 30 * 1000);
  const windows: ServerProviderUsageWindow[] = [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: input.sessionUsed,
      windowDurationMins: 300,
      resetsAt: at(2 * HOUR + 10 * MIN + 30 * 1000),
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: input.weeklyUsed,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: weeklyReset,
    },
    ...(input.fableUsed === undefined
      ? []
      : [
          {
            id: "seven_day_fable",
            kind: "weekly" as const,
            label: "Weekly · Fable",
            usedPercent: input.fableUsed,
            resetsAt: weeklyReset,
          },
        ]),
  ];
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: input.name,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: input.email },
    checkedAt: at(-MIN),
    models: [
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1", isCustom: false, capabilities: {} },
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isCustom: false, capabilities: {} },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: at(-MIN), windows },
  };
}

it("shows each account's 5h and weekly headroom in the picker once the Labs setting is on", async () => {
  await updateClientSettings({ modelPickerUsageEnabled: true });
  await using _setting = {
    async [Symbol.asyncDispose]() {
      await updateClientSettings({ modelPickerUsageEnabled: false });
    },
  };
  // On the minute, since the picker reads time from the minute clock.
  const now = Date.UTC(2026, 10, 10, 12, 0);
  vi.setSystemTime(now);
  using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
  const entries = deriveProviderInstanceEntries([
    claude({
      id: "claude",
      name: "Claude Personal",
      email: "me@example.com",
      now,
      sessionUsed: 28,
      weeklyUsed: 59,
      fableUsed: 82,
    }),
    claude({
      id: "claude-work",
      name: "Claude Work",
      email: "work@example.com",
      now,
      sessionUsed: 93,
      weeklyUsed: 20,
    }),
  ]);
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));
  const first = entries[0]!;

  await using screen = await render(
    <div style={{ padding: 16, paddingLeft: 420, minHeight: 460 }}>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model="claude-fable-5-1"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={() => {}}
      />
    </div>,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();

  const row = () => document.querySelector<HTMLElement>("[data-model-picker-account-usage]");
  await vi.waitFor(() => expect(row()?.textContent).toContain("Claude Personal"));
  const text = row()?.querySelector("[aria-hidden='true']")?.textContent;
  expect(text).toBe("5h 72% →2h10m | all: 41% • fable: 18%▲ →3d4h");
  expect(document.querySelectorAll("[data-usage-halo]")).toHaveLength(2);

  const screenshotPath = import.meta.env.VITE_USAGE_PICKER_SCREENSHOT;
  if (screenshotPath) {
    const popup = document.querySelector<HTMLElement>("[data-model-picker-content]");
    if (popup) await page.screenshot({ path: screenshotPath, element: popup });
  }

  await page.getByRole("button", { name: /^Claude Work,/ }).click();
  await vi.waitFor(() =>
    expect(row()?.querySelector("[aria-hidden='true']")?.textContent).toBe(
      "5h 7%! →2h10m | all: 80% →3d4h",
    ),
  );
});
