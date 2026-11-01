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
