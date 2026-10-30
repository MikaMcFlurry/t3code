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
