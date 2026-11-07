import * as Schema from "effect/Schema";

import { SessionControl } from "../preview/SessionControl.ts";

/** An agent's desktop call met a person driving the desktop through the live view. */
export class DesktopHumanControlError extends Schema.TaggedError<DesktopHumanControlError>()(
  "DesktopHumanControlError",
  {},
) {
  override get message(): string {
    return "A person is using this desktop through T3's live view. Wait until they hand it back, then take a new screenshot before acting.";
  }
}

const settle = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    () => undefined,
  );

/**
 * Agents drive the desktop unless a live view viewer took control. A takeover lets running agent
 * calls finish first; new ones are refused, screenshots included, so none catches a password.
 */
class DesktopLiveControl {
  private readonly listeners = new Set<() => void>();
  private readonly agentCalls = new Set<Promise<void>>();
  readonly control: SessionControl = new SessionControl(null, () => {
    // Runs inside the ownership change, so the drain is queued ahead of the person's first input.
    if (this.control.controller !== null) {
      void this.control.system(() => this.drainAgentCalls()).catch(() => undefined);
    }
    for (const listener of this.listeners) listener();
  });

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get humanController(): string | null {
    return this.control.controller;
  }

  /** Runs an agent's desktop call unless a person holds control. Calls are not serialized here. */
  agent<A>(run: () => Promise<A>): Promise<A> {
    if (this.control.controller !== null) return Promise.reject(new DesktopHumanControlError());
    const work = run();
    const settled = settle(work).finally(() => this.agentCalls.delete(settled));
    this.agentCalls.add(settled);
    return work;
  }

  private async drainAgentCalls() {
    await Promise.all(this.agentCalls);
  }
}

export const desktopLiveControl = new DesktopLiveControl();
