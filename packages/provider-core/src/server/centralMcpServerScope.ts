import type { CentralMcpServer } from "@t3tools/contracts";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

/**
 * A scoped server is absent unless the current session matches every populated allowlist.
 * An explicitly empty scope fails closed so partially written high-authority settings do not
 * become global.
 */
export function centralMcpServersForSession(
  servers: ReadonlyArray<CentralMcpServer> | undefined,
  session: Pick<McpProviderSessionConfig, "providerInstanceId" | "threadId"> | undefined,
): ReadonlyArray<CentralMcpServer> {
  return (servers ?? []).filter((server) => {
    const scope = server.sessionScope;
    if (scope === undefined) return true;
    if (session === undefined) return false;
    if (scope.providerInstanceIds.length === 0 && scope.threadIds.length === 0) return false;
    return (
      (scope.providerInstanceIds.length === 0 ||
        scope.providerInstanceIds.includes(session.providerInstanceId)) &&
      (scope.threadIds.length === 0 || scope.threadIds.includes(session.threadId))
    );
  });
}
