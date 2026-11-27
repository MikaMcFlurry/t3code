import { describe, expect, it } from "vite-plus/test";

import { environmentBusyScore } from "./handlers.ts";

const GB = 1024 ** 3;

describe("environmentBusyScore", () => {
  it("weights CPU 0.6 and memory in use 0.4", () => {
    expect(
      environmentBusyScore({
        cpuUtilization: 0.5,
        cpuCount: 8,
        availableMemoryBytes: 4 * GB,
        totalMemoryBytes: 16 * GB,
      }),
    ).toBe(0.6);
    expect(
      environmentBusyScore({
        cpuUtilization: 0.1,
        cpuCount: 8,
        availableMemoryBytes: 12 * GB,
        totalMemoryBytes: 16 * GB,
      }),
    ).toBe(0.16);
  });

  it("has no score without a CPU reading or a memory total", () => {
    expect(environmentBusyScore(null)).toBeNull();
    expect(
      environmentBusyScore({
        cpuUtilization: null,
        cpuCount: 8,
        availableMemoryBytes: GB,
        totalMemoryBytes: 2 * GB,
      }),
    ).toBeNull();
  });
});
