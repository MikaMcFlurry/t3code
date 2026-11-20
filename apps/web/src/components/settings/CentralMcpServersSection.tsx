import type { CentralMcpServer } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  centralMcpServerFromInput,
  centralMcpServerSecretEntries,
  centralMcpServerSecretKeyProblem,
  centralMcpServerSecretKind,
  describeCentralMcpServer,
  withCentralMcpServerSecret,
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
  const gt = useGT();
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
      setProblem(gt("A central MCP server named {name} already exists.", { name: server.name }));
      return;
    }
    onChange([...servers, server]);
    setName("");
    setTarget("");
    setProblem(null);
  };

  return (
    <SettingsSection title={gt("Central MCP servers")}>
      <SettingsRow
        title={gt("Add MCP server")}
        description={gt(
          "Added to every Claude and Codex session on this machine, whichever account runs it. Environment variables and headers are kept in the secret store.",
        )}
        control={
          <div className="flex w-full max-w-lg items-center gap-2">
            <Input
              size="sm"
              className="w-32"
              value={name}
              disabled={readOnly}
              placeholder={gt("name", { $context: "MCP server name placeholder" })}
              aria-label={gt("MCP server name")}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              size="sm"
              value={target}
              disabled={readOnly}
              placeholder={gt("Command ({example} …) or {scheme} URL", {
                example: "npx -y",
                scheme: "https://",
              })}
              aria-label={gt("MCP server command or URL")}
              onChange={(event) => setTarget(event.target.value)}
            />
            <Button size="sm" disabled={readOnly || !name.trim() || !target.trim()} onClick={add}>
              <T>Add</T>
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
                aria-label={gt("Enable {name}", { name: server.name })}
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
                aria-label={gt("Remove {name}", { name: server.name })}
                onClick={() => onChange(servers.filter((entry) => entry.name !== server.name))}
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        >
          <CentralMcpServerSecrets
            server={server}
            readOnly={readOnly}
            onChange={(next) =>
              onChange(servers.map((entry) => (entry.name === server.name ? next : entry)))
            }
          />
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}

/**
 * A server's headers or environment variables. Saved values stay on the server and arrive masked;
 * leaving a row alone keeps its value, typing a new one replaces it.
 */
function CentralMcpServerSecrets({
  server,
  readOnly,
  onChange,
}: {
  readonly server: CentralMcpServer;
  readonly readOnly: boolean;
  readonly onChange: (server: CentralMcpServer) => void;
}) {
  const gt = useGT();
  const kind = centralMcpServerSecretKind(server);
  const [replacements, setReplacements] = useState<Readonly<Record<string, string>>>({});
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const replace = (entry: string) => {
    const next = replacements[entry];
    if (!next) return;
    onChange(withCentralMcpServerSecret(server, entry, next));
    setReplacements((current) =>
      Object.fromEntries(Object.entries(current).filter(([name]) => name !== entry)),
    );
  };

  const add = () => {
    const trimmed = key.trim();
    const keyProblem = centralMcpServerSecretKeyProblem(server, trimmed);
    if (keyProblem) {
      setProblem(keyProblem);
      return;
    }
    if (centralMcpServerSecretEntries(server).some((entry) => entry.key === trimmed)) {
      setProblem(
        gt("{key} is already set; type a new value in its row to replace it.", { key: trimmed }),
      );
      return;
    }
    onChange(withCentralMcpServerSecret(server, trimmed, value));
    setKey("");
    setValue("");
    setProblem(null);
  };

  return (
    <div className="space-y-1.5 pb-2">
      {centralMcpServerSecretEntries(server).map((entry) => (
        <div key={entry.key} className="flex items-center gap-2">
          <span className="w-40 shrink-0 font-mono text-xs break-all">{entry.key}</span>
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            value={replacements[entry.key] ?? ""}
            disabled={readOnly}
            placeholder={entry.saved ? gt("Saved; type to replace") : gt("Empty")}
            aria-label={
              kind === "env"
                ? gt("New value for environment variable {key}", { key: entry.key })
                : gt("New value for header {key}", { key: entry.key })
            }
            onChange={(event) => {
              const next = event.target.value;
              setReplacements((current) => ({ ...current, [entry.key]: next }));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") replace(entry.key);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || !replacements[entry.key]}
            onClick={() => replace(entry.key)}
          >
            <T>Replace</T>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={readOnly}
            aria-label={
              kind === "env"
                ? gt("Remove environment variable {key}", { key: entry.key })
                : gt("Remove header {key}", { key: entry.key })
            }
            onClick={() => onChange(withCentralMcpServerSecret(server, entry.key, null))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          className="w-40 shrink-0"
          value={key}
          disabled={readOnly}
          // oxlint-disable-next-line t3code/no-untranslated-copy -- example identifiers, not prose
          placeholder={kind === "env" ? "VARIABLE_NAME" : "Header-Name"}
          aria-label={
            kind === "env"
              ? gt("New environment variable name for {name}", { name: server.name })
              : gt("New header name for {name}", { name: server.name })
          }
          onChange={(event) => setKey(event.target.value)}
        />
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          value={value}
          disabled={readOnly}
          placeholder={gt("Value")}
          aria-label={
            kind === "env"
              ? gt("New environment variable value for {name}", { name: server.name })
              : gt("New header value for {name}", { name: server.name })
          }
          onChange={(event) => setValue(event.target.value)}
        />
        <Button size="sm" variant="outline" disabled={readOnly || !key.trim()} onClick={add}>
          {kind === "env" ? gt("Add variable") : gt("Add header")}
        </Button>
      </div>
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
    </div>
  );
}
