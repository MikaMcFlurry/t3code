import { useState } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Comma- or newline-separated entries; blanks are dropped. */
function parseAllowedModels(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function AutoRoutingAllowedRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["autoRoutingAllowed"]);
  const saved = settings.autoRoutingAllowed.join(", ");
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    updateSettings({ autoRoutingAllowed: parseAllowedModels(draft) });
    setDraft(null);
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["autoRoutingAllowed"]}
      mixed={mixed}
      id="auto-routing-allowed"
      title="Allowed models for automatic routing"
      description="Limits automatic accounts, Auto threads and routed scheduled runs. Entries: an account id (codex-2), account/model (claude-2/claude-opus-5-5) or driver:codex. Empty allows every model."
      resetAction={
        settings.autoRoutingAllowed.length > 0 ? (
          <SettingResetButton
            label="allowed models"
            tooltip="Allow every model"
            onClick={() => updateSettings({ autoRoutingAllowed: [] })}
          />
        ) : null
      }
      control={
        <Input
          size="sm"
          className="w-72"
          value={draft ?? (mixed ? "" : saved)}
          placeholder={mixed ? "Mixed" : "All models"}
          aria-label="Allowed models for automatic routing"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      }
    />
  );
}
