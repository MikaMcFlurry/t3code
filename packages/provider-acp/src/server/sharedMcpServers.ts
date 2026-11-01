import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * MCP servers the host shares with every ACP session, next to `t3-code`. Read at each session
 * start so settings changes reach the next session without rebuilding the adapter.
 */
export const AcpSharedMcpServers = Context.Reference<{
  readonly read: Effect.Effect<ReadonlyArray<EffectAcpSchema.McpServer>>;
}>("@t3tools/provider-acp/AcpSharedMcpServers", {
  defaultValue: () => ({ read: Effect.succeed([]) }),
});

/**
 * Appends shared servers to the `t3-code` server list chosen for the session. Every ACP agent
 * accepts stdio servers; HTTP servers go only to agents that advertise `mcpCapabilities.http`.
 */
export function withSharedMcpServers(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  shared: ReadonlyArray<EffectAcpSchema.McpServer> | undefined,
  supportsHttp: boolean,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  if (shared === undefined || shared.length === 0) return servers;
  const taken = new Set(servers.map((server) => server.name));
  return [
    ...servers,
    ...shared.filter(
      (server) =>
        !taken.has(server.name) && (supportsHttp || !("type" in server) || server.type !== "http"),
    ),
  ];
}
