export const COMPUTER_USE_LINUX_OBSERVATION_TOOLS = [
  "doctor",
  "list_apps",
  "get_tree_page",
  "list_windows",
  "focused_window",
  "get_app_state",
  "screenshot",
  // Windows-MCP (Windows hosts)
  "ControlStatus",
  "DisplayInventory",
  "Snapshot",
  "Screenshot",
  "Wait",
  "WaitFor",
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
  // Windows-MCP (Windows hosts). Its PowerShell, FileSystem, Registry, Process, Scrape and
  // Notification tools reach beyond the screen and stay refused.
  "App",
  "Click",
  "Type",
  "Scroll",
  "Move",
  "Shortcut",
  "MultiSelect",
  "MultiEdit",
  "Clipboard",
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

// Windows-MCP's App tool also has a `launch_executable` mode that runs any executable with
// arguments, which would reach past the screen exactly like its refused PowerShell tool.
const WINDOWS_APP_MODES: ReadonlySet<unknown> = new Set([undefined, "launch", "resize", "switch"]);
const WINDOWS_APP_EXECUTABLE_KEYS = ["executable", "args", "cwd"] as const;

/**
 * Why T3 refuses these arguments for an allowed tool, or undefined when they pass. It runs before
 * approval, so a standing grant cannot let them through either.
 */
export function computerUseToolArgumentsRefusal(
  toolName: string,
  arguments_: unknown,
): string | undefined {
  if (toolName !== "App") return undefined;
  const fields =
    typeof arguments_ === "object" && arguments_ !== null && !Array.isArray(arguments_)
      ? (arguments_ as Record<string, unknown>)
      : {};
  if (
    !WINDOWS_APP_MODES.has(fields.mode) ||
    WINDOWS_APP_EXECUTABLE_KEYS.some((key) => fields[key] !== undefined)
  ) {
    return "App only opens, switches to or resizes applications through T3; launch_executable, executable, args and cwd are refused.";
  }
  return undefined;
}

/** Environment that refuses silent GNOME/Wayland fallbacks after portal denial. */
export const COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT = {
  CU_DISABLE_ABS_POINTER: "1",
  COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER: "1",
  COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD: "1",
  COMPUTER_USE_LINUX_SCREENSHOT_BACKEND: "portal",
  COMPUTER_USE_LINUX_ENABLE_SHELL: "0",
  // A new process per call would otherwise ask for pointer and keyboard access every time.
  // GNOME's dialog offers to remember the grant; later processes reuse its restore token.
  COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP: "1",
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
