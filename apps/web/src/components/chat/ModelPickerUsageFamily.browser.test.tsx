import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function providerBase(now: number) {
  return {
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - MIN)),
    slashCommands: [],
    skills: [],
  };
}

// One Antigravity login whose Gemini pool is used up while the shared Claude/GPT pool is free.
function antigravity(now: number): ServerProvider {
  const at = (offset: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offset + 30_000));
  return {
    ...providerBase(now),
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Antigravity",
    auth: { status: "authenticated", email: "ag@example.com" },
    models: [
      { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro", isCustom: false, capabilities: {} },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false, capabilities: {} },
    ],
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - MIN)),
      windows: [
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: at(HOUR),
        },
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini · Weekly",
          usedPercent: 70,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: at(2 * DAY),
        },
        {
          id: "3p-5h",
          kind: "session",
          label: "Claude & GPT (shared) · 5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: at(4 * HOUR),
        },
        {
          id: "3p-weekly",
          kind: "weekly",
          label: "Claude & GPT (shared) · Weekly",
          usedPercent: 25,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: at(5 * DAY),
        },
      ],
    },
  };
}

function claude(now: number): ServerProvider {
  const at = (offset: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offset + 30_000));
  return {
    ...providerBase(now),
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Personal",
    auth: { status: "authenticated", email: "me@example.com" },
    models: [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isCustom: false, capabilities: {} },
    ],
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - MIN)),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 28,
          windowDurationMins: 300,
          resetsAt: at(2 * HOUR + 10 * MIN),
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 59,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: at(3 * DAY + 4 * HOUR),
        },
      ],
    },
  };
}

// Generous, since the browser project runs many files at once.
const WAIT = { timeout: 5_000 };

const EXPECTED = {
  "Gemini 3.1 Pro": { text: "5h 0%! →1h0m | week: 30% →2d0h", exhausted: true },
  "Claude Sonnet 4.6": { text: "5h 100% →4h0m | week: 75% →5d0h", exhausted: false },
  "Claude Sonnet 5": { text: "5h 72% →2h10m | all: 41% →3d4h", exhausted: false },
} as const;

/** Each visible model row: its usage text and whether it is dimmed as used up. */
function rows() {
  return new Map(
    [...document.querySelectorAll<HTMLElement>("[role='option']")].flatMap((option) => {
      const name = Object.keys(EXPECTED).find((model) => option.textContent?.includes(model));
      if (!name) return [];
      const text =
        option.querySelector("[data-usage-text] [aria-hidden='true']")?.textContent ?? null;
      return [[name, { text, exhausted: option.hasAttribute("data-usage-exhausted") }] as const];
    }),
  );
}

it("reads each model's own family pool in favorites, search and the Antigravity tab", async () => {
  // On the minute, since the picker reads time from the minute clock.
  const now = Date.UTC(2026, 10, 22, 12, 0);
  vi.setSystemTime(now);
  using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
  const entries = deriveProviderInstanceEntries([antigravity(now), claude(now)]);
  const [ag, personal] = entries;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    modelPickerUsageEnabled: true,
    favorites: [
      { provider: ag!.instanceId, model: "gemini-3.1-pro" },
      { provider: ag!.instanceId, model: "claude-sonnet-4-6" },
      { provider: personal!.instanceId, model: "claude-sonnet-5" },
    ],
  };
  __setClientSettingsForTests(settings);
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <div style={{ padding: 16, paddingLeft: 420, minHeight: 460 }}>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={personal!.instanceId}
        model="claude-sonnet-5"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={() => {}}
      />
    </div>,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();

  // Favorites mix accounts, so each row carries its own model's headroom.
  await vi.waitFor(() => expect(Object.fromEntries(rows())).toEqual(EXPECTED), WAIT);
  // The used-up Gemini pool dims only Gemini; the Claude model on the same login stays usable.
  expect(
    page
      .getByRole("option", { name: /Gemini 3\.1 Pro/ })
      .element()
      .getAttribute("aria-disabled"),
  ).not.toBe("true");

  const screenshotPath = import.meta.env.VITE_USAGE_PICKER_FAMILY_SCREENSHOT;
  if (screenshotPath) {
    const popup = document.querySelector<HTMLElement>("[data-model-picker-content]");
    if (popup) await page.screenshot({ path: screenshotPath, element: popup });
  }

  // Search hits show the same values as the favorite rows.
  const search = page.getByPlaceholder("Search models...");
  await userEvent.click(search);
  await userEvent.type(search, "sonnet");
  await vi.waitFor(
    () => expect([...rows().keys()].sort()).toEqual(["Claude Sonnet 4.6", "Claude Sonnet 5"]),
    WAIT,
  );
  expect(rows().get("Claude Sonnet 4.6")).toEqual(EXPECTED["Claude Sonnet 4.6"]);
  expect(rows().get("Claude Sonnet 5")).toEqual(EXPECTED["Claude Sonnet 5"]);
  await userEvent.clear(search);
  await userEvent.type(search, "gemini");
  await vi.waitFor(() => expect([...rows().keys()]).toEqual(["Gemini 3.1 Pro"]), WAIT);
  expect(rows().get("Gemini 3.1 Pro")).toEqual(EXPECTED["Gemini 3.1 Pro"]);
  await userEvent.clear(search);

  // Antigravity has no window that stops every model: no account line or rings, but its rows
  // carry their family's headroom.
  await page.getByRole("button", { name: /^Antigravity/ }).click();
  await vi.waitFor(() => expect(rows().size).toBe(2), WAIT);
  expect(document.querySelector("[data-model-picker-account-usage]")).toBeNull();
  expect(rows().get("Gemini 3.1 Pro")).toEqual(EXPECTED["Gemini 3.1 Pro"]);
  expect(rows().get("Claude Sonnet 4.6")).toEqual(EXPECTED["Claude Sonnet 4.6"]);

  // An account with windows that stop every model keeps its line, so rows stay plain but dimming
  // still follows the model.
  await page.getByRole("button", { name: /^Claude Personal/ }).click();
  await vi.waitFor(
    () => expect(rows().get("Claude Sonnet 5")).toEqual({ text: null, exhausted: false }),
    WAIT,
  );

  // With the Labs setting off, rows go back to plain: no text and no dimming.
  __setClientSettingsForTests({ ...settings, modelPickerUsageEnabled: false });
  await page.getByRole("button", { name: /^Antigravity/ }).click();
  await vi.waitFor(
    () => expect(rows().get("Gemini 3.1 Pro")).toEqual({ text: null, exhausted: false }),
    WAIT,
  );
  expect(rows().get("Claude Sonnet 4.6")).toEqual({ text: null, exhausted: false });
});
