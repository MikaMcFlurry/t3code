import type { CentralMcpServer } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  centralMcpServerFromInput,
  describeCentralMcpServer,
} from "./CentralMcpServersSection.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function CentralMcpServersSection({
  servers,
  readOnly,
  onChange,
}: {
  readonly servers: ReadonlyArray<CentralMcpServer>;
  readonly readOnly: boolean;
  readonly onChange: (servers: ReadonlyArray<CentralMcpServer>) => void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const add = () => {
    const server = centralMcpServerFromInput(name, target);
    if (typeof server === "string") {
      setProblem(server);
      return;
    }
    if (servers.some((existing) => existing.name === server.name)) {
      setProblem(`A central MCP server named '${server.name}' already exists.`);
      return;
    }
    onChange([...servers, server]);
    setName("");
    setTarget("");
    setProblem(null);
  };

  return (
    <SettingsSection title="Central MCP servers">
      <SettingsRow
        title="Add MCP server"
        description="Added to every Claude and Codex session on this machine, whichever account runs it. Environment variables and headers can be set in settings.json."
        control={
          <div className="flex w-full max-w-lg items-center gap-2">
            <Input
              size="sm"
              className="w-32"
              value={name}
              disabled={readOnly}
              placeholder="name"
              aria-label="MCP server name"
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              size="sm"
              value={target}
              disabled={readOnly}
              placeholder="Command (npx -y …) or https:// URL"
              aria-label="MCP server command or URL"
              onChange={(event) => setTarget(event.target.value)}
            />
            <Button size="sm" disabled={readOnly || !name.trim() || !target.trim()} onClick={add}>
              Add
            </Button>
          </div>
        }
      />
      {problem ? <p className="px-4 py-2.5 text-xs text-destructive">{problem}</p> : null}
      {servers.map((server) => (
        <SettingsRow
          key={server.name}
          title={server.name}
          description={describeCentralMcpServer(server)}
          control={
            <div className="flex items-center gap-2">
              <Switch
                checked={server.enabled}
                disabled={readOnly}
                aria-label={`Enable ${server.name}`}
                onCheckedChange={(enabled) =>
                  onChange(
                    servers.map((entry) =>
                      entry.name === server.name ? { ...entry, enabled } : entry,
                    ),
                  )
                }
              />
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={readOnly}
                aria-label={`Remove ${server.name}`}
                onClick={() => onChange(servers.filter((entry) => entry.name !== server.name))}
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
