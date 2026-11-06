export const COMPUTER_USE_LINUX_OBSERVATION_TOOLS = [
  "doctor",
  "list_apps",
  "get_tree_page",
  "list_windows",
  "focused_window",
  "get_app_state",
  "screenshot",
] as const;

export const COMPUTER_USE_LINUX_INTERACTION_TOOLS = [
  "complete_interaction",
  "activate_window",
  "click",
  "perform_action",
  "set_value",
  "scroll",
  "drag",
  "press_key",
  "type_text",
  "move_window",
  "resize_window",
] as const;

const OBSERVATION_TOOLS = new Set<string>(COMPUTER_USE_LINUX_OBSERVATION_TOOLS);
const INTERACTION_TOOLS = new Set<string>(COMPUTER_USE_LINUX_INTERACTION_TOOLS);

export type ComputerUseLinuxToolAccess = "observe" | "interact" | "deny";

/** Unknown and host-configuration tools fail closed; setup remains an explicit operator step. */
export function computerUseLinuxToolAccess(toolName: string): ComputerUseLinuxToolAccess {
  if (OBSERVATION_TOOLS.has(toolName)) return "observe";
  if (INTERACTION_TOOLS.has(toolName)) return "interact";
  return "deny";
}

/** Environment that refuses silent GNOME/Wayland fallbacks after portal denial. */
export const COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT = {
  CU_DISABLE_ABS_POINTER: "1",
  COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER: "1",
  COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD: "1",
  COMPUTER_USE_LINUX_SCREENSHOT_BACKEND: "portal",
  COMPUTER_USE_LINUX_ENABLE_SHELL: "0",
} as const;

/** One instance belongs to the environment-level bridge and serializes every desktop operation. */
export class ComputerUseLinuxOperationGate {
  private tail: Promise<void> = Promise.resolve();

  async run<A>(toolName: string, operation: () => Promise<A>): Promise<A> {
    if (computerUseLinuxToolAccess(toolName) === "deny") {
      throw new Error(`Computer Use tool '${toolName}' is not exposed by T3.`);
    }
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
