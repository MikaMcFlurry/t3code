import type { CentralMcpServer } from "@t3tools/contracts";

const SERVER_NAME = /^(?!t3-code$)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Splits a command line on spaces, keeping "quoted parts" together. */
function splitCommandLine(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

/** An http(s) address becomes an http server; anything else is a command line to run. */
export function centralMcpServerFromInput(name: string, target: string): CentralMcpServer | string {
  const trimmedName = name.trim();
  if (!SERVER_NAME.test(trimmedName)) {
    return "Use letters, digits, '-' or '_' for the name (not t3-code).";
  }
  const trimmedTarget = target.trim();
  if (/^https?:\/\//i.test(trimmedTarget)) {
    return {
      name: trimmedName,
      enabled: true,
      transport: { type: "http", url: trimmedTarget, headers: {} },
    };
  }
  const [command, ...args] = splitCommandLine(trimmedTarget);
  if (!command) return "Enter a command or an http(s) URL.";
  return { name: trimmedName, enabled: true, transport: { type: "stdio", command, args, env: {} } };
}

export function describeCentralMcpServer(server: CentralMcpServer): string {
  return server.transport.type === "http"
    ? server.transport.url
    : [server.transport.command, ...server.transport.args].join(" ");
}

/** Stdio servers take environment variables; http servers take headers. Both may hold tokens. */
export function centralMcpServerSecretKind(server: CentralMcpServer): "env" | "header" {
  return server.transport.type === "stdio" ? "env" : "header";
}

/**
 * The entry names a server holds, and whether each has a saved value. The server sends every
 * saved value back as a mask; sending the mask back unchanged keeps the stored secret.
 */
export function centralMcpServerSecretEntries(
  server: CentralMcpServer,
): ReadonlyArray<{ readonly key: string; readonly saved: boolean }> {
  const entries =
    server.transport.type === "stdio" ? server.transport.env : server.transport.headers;
  return Object.entries(entries).map(([key, value]) => ({ key, saved: value.length > 0 }));
}

/** Sets one header or environment value, replacing a saved one; `null` removes the entry. */
export function withCentralMcpServerSecret(
  server: CentralMcpServer,
  key: string,
  value: string | null,
): CentralMcpServer {
  const transport = server.transport;
  const entries = { ...(transport.type === "stdio" ? transport.env : transport.headers) };
  if (value === null) delete entries[key];
  else entries[key] = value;
  return {
    ...server,
    transport:
      transport.type === "stdio"
        ? { ...transport, env: entries }
        : { ...transport, headers: entries },
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Why a new entry name cannot be used, or null when it can. */
export function centralMcpServerSecretKeyProblem(
  server: CentralMcpServer,
  key: string,
): string | null {
  const kind = centralMcpServerSecretKind(server);
  if (!(kind === "env" ? ENV_NAME : HEADER_NAME).test(key)) {
    return kind === "env"
      ? "Use letters, digits and '_' for the variable name, not starting with a digit."
      : "Enter a valid header name, such as Authorization.";
  }
  return null;
}
