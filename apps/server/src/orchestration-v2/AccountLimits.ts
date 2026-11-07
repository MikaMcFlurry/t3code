import type { ProviderInstanceId } from "@t3tools/contracts";

/**
 * Accounts a turn on this server found out of usage, until when (epoch ms). Usage bars can
 * lag a limit by minutes, so new turns, launches and account switches also check this.
 */
const limitedUntil = new Map<ProviderInstanceId, number>();

export function recordAccountLimit(instanceId: ProviderInstanceId, untilMs: number): void {
  if ((limitedUntil.get(instanceId) ?? 0) < untilMs) limitedUntil.set(instanceId, untilMs);
}

export function accountLimits(): ReadonlyMap<ProviderInstanceId, number> {
  return limitedUntil;
}
