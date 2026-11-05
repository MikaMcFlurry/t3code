import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const VK_LWIN = 0x5b;
const VK_H = 0x48;
const KEYEVENTF_KEYUP = 0x2;

const WM_INPUTLANGCHANGEREQUEST = 0x50;

/**
 * Presses Win+H (Electron can't send the Windows key) to open voice typing. It listens in the
 * window's input language, so the window first switches to the display language's: a second
 * language on the same keyboard layout can otherwise be active unnoticed.
 */
export const WINDOWS_VOICE_TYPING_SCRIPT = [
  "$k = Add-Type -Name K -Namespace T3Dictation -PassThru -MemberDefinition",
  '\'[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);',
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern System.IntPtr LoadKeyboardLayout(string id, uint flags);',
  '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);\';',
  "$layout = $k::LoadKeyboardLayout(('{0:X8}' -f [System.Globalization.CultureInfo]::CurrentUICulture.LCID), 0);",
  `if ($layout -ne [IntPtr]::Zero) { [void]$k::PostMessage($k::GetForegroundWindow(), ${WM_INPUTLANGCHANGEREQUEST}, [IntPtr]::Zero, $layout); Start-Sleep -Milliseconds 150 };`,
  `$k::keybd_event(${VK_LWIN}, 0, 0, [UIntPtr]::Zero);`,
  `$k::keybd_event(${VK_H}, 0, 0, [UIntPtr]::Zero);`,
  `$k::keybd_event(${VK_H}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero);`,
  `$k::keybd_event(${VK_LWIN}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`,
].join(" ");

/** An absolute path, so a powershell.exe earlier on PATH cannot stand in for the system one. */
export function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const windowsRoot = (environment.SystemRoot ?? environment.WINDIR ?? "C:\\Windows").replace(
    /[\\/]+$/,
    "",
  );
  return `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export const startSystemDictation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_SYSTEM_DICTATION_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.startSystemDictation")(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return false;
    const powershell = windowsPowerShellPath(yield* HostProcess.Environment);
    // Optional, so IPC methods keep needing nothing beyond what the app always provides.
    const spawnerOption = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    if (spawnerOption._tag === "None") return false;
    const spawner = spawnerOption.value;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            powershell,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_VOICE_TYPING_SCRIPT],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" },
          ),
        );
        return (yield* handle.exitCode.pipe(Effect.timeout("10 seconds"))) === 0;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Windows voice typing could not start", cause).pipe(Effect.as(false)),
      ),
    );
  }),
});
