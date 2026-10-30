import type { EnvironmentId } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, Var } from "gt-react";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { centralSkillSourceFromInput } from "./CentralSkillsSection.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function CentralSkillsSection({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const { data, error, refresh } = useEnvironmentQuery(
    serverEnvironment.centralSkills({ environmentId, input: {} }),
  );
  const install = useAtomCommand(serverEnvironment.installCentralSkill, {
    label: "central skill install",
  });
  const remove = useAtomCommand(serverEnvironment.removeCentralSkill, {
    label: "central skill remove",
  });
  const setEnabled = useAtomCommand(serverEnvironment.setCentralSkillEnabled, {
    label: "central skill toggle",
  });
  const gt = useGT();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy) return false;
    setBusy(true);
    const result = await action();
    setBusy(false);
    refresh();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title,
        description: String(squashAtomCommandFailure(result)),
      });
      return false;
    }
    return result._tag === "Success";
  };

  const installSource = centralSkillSourceFromInput(source);
  const skills = data?.skills ?? [];

  return (
    <SettingsSection title={gt("Central skills")}>
      <SettingsRow
        title={gt("Skill library")}
        description={[
          gt(
            "Enabled skills reach every provider account on this machine: Claude loads them directly, Codex homes get a managed copy. Your own skills with the same name win.",
          ),
          data ? gt("Folder: {directory}", { directory: data.directory }) : null,
        ]
          .filter(Boolean)
          .join(" ")}
        control={
          <div className="flex w-full max-w-md items-center gap-2">
            <Input
              size="sm"
              value={source}
              disabled={readOnly || busy}
              placeholder={gt("Folder, git URL, or SKILL.md URL")}
              aria-label={gt("Skill source")}
              onChange={(event) => setSource(event.target.value)}
            />
            <Button
              size="sm"
              disabled={readOnly || busy || installSource === null}
              onClick={async () => {
                if (installSource === null) return;
                const installed = await run(gt("Could not install skill"), () =>
                  install({ environmentId, input: { source: installSource } }),
                );
                if (installed) setSource("");
              }}
            >
              <T>Install</T>
            </Button>
          </div>
        }
      />
      {error ? (
        <p className="px-4 py-2.5 text-xs text-destructive">
          <T>
            Could not load skills: <Var>{error}</Var>
          </T>
        </p>
      ) : null}
      {data && skills.length === 0 ? (
        <p className="px-4 py-2.5 text-xs text-muted-foreground">
          <T>No central skills yet.</T>
        </p>
      ) : null}
      {skills.map((skill) => (
        <SettingsRow
          key={skill.name}
          title={skill.name}
          description={[
            skill.description,
            skill.source ? gt("From {source}", { source: skill.source }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <div className="flex items-center gap-2">
              <Switch
                checked={skill.enabled}
                disabled={readOnly || busy}
                aria-label={gt("Enable {name}", { name: skill.name })}
                onCheckedChange={(enabled) =>
                  run(gt("Could not update skill"), () =>
                    setEnabled({ environmentId, input: { name: skill.name, enabled } }),
                  )
                }
              />
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={readOnly || busy}
                aria-label={gt("Remove {name}", { name: skill.name })}
                onClick={() =>
                  run(gt("Could not remove skill"), () =>
                    remove({ environmentId, input: { name: skill.name } }),
                  )
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
