import { describe, expect, it } from "vite-plus/test";

import { newAutoProjectPath } from "./AutoLaunchDialog.logic";

describe("newAutoProjectPath", () => {
  it("places the new folder next to the most recently added project", () => {
    expect(
      newAutoProjectPath(
        [
          { workspaceRoot: "D:\\Old\\alpha", createdAt: "2026-01-01T00:00:00.000Z" },
          { workspaceRoot: "D:\\Projects\\beta\\", createdAt: "2026-10-01T00:00:00.000Z" },
        ],
        "weather-app",
      ),
    ).toBe("D:\\Projects\\weather-app");
    expect(
      newAutoProjectPath(
        [{ workspaceRoot: "/home/mika/code/site", createdAt: "2026-10-01T00:00:00.000Z" }],
        "notes",
      ),
    ).toBe("/home/mika/code/notes");
  });

  it("needs an existing project to place it next to", () => {
    expect(newAutoProjectPath([], "notes")).toBeNull();
  });
});
