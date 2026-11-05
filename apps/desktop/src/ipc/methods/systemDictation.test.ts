import { describe, expect, it } from "vite-plus/test";

import { WINDOWS_VOICE_TYPING_SCRIPT, windowsPowerShellPath } from "./systemDictation.ts";

describe("windowsPowerShellPath", () => {
  it("builds the system PowerShell path from SystemRoot, with a fallback", () => {
    expect(windowsPowerShellPath({ SystemRoot: "D:\\Win\\" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});

describe("Windows voice typing script", () => {
  it("presses Win+H and releases both keys in reverse order", () => {
    const presses = [...WINDOWS_VOICE_TYPING_SCRIPT.matchAll(/keybd_event\((\d+), 0, (\d+),/g)].map(
      ([, key, flags]) => `${key}:${flags}`,
    );
    expect(presses).toEqual(["91:0", "72:0", "72:2", "91:2"]);
  });
});

describe("Windows voice typing language", () => {
  it("switches the window to the display language's input language before Win+H", () => {
    const languageSwitch = WINDOWS_VOICE_TYPING_SCRIPT.indexOf(
      "PostMessage($k::GetForegroundWindow(), 80",
    );
    const winH = WINDOWS_VOICE_TYPING_SCRIPT.indexOf("keybd_event(91, 0, 0,");
    expect(languageSwitch).toBeGreaterThan(-1);
    expect(languageSwitch).toBeLessThan(winH);
    expect(WINDOWS_VOICE_TYPING_SCRIPT).toContain("CurrentUICulture.LCID");
  });
});
