import { describe, expect, it } from "vite-plus/test";

import {
  centralMcpServerFromInput,
  describeCentralMcpServer,
} from "./CentralMcpServersSection.logic";

describe("centralMcpServerFromInput", () => {
  it("reads an http address as an http server", () => {
    expect(centralMcpServerFromInput("docs", " https://docs.example/mcp ")).toEqual({
      name: "docs",
      enabled: true,
      transport: { type: "http", url: "https://docs.example/mcp", headers: {} },
    });
  });

  it("splits a command line and keeps quoted parts together", () => {
    const server = centralMcpServerFromInput("files", 'npx -y fs-mcp "D:\\My Files"');
    expect(server).toEqual({
      name: "files",
      enabled: true,
      transport: { type: "stdio", command: "npx", args: ["-y", "fs-mcp", "D:\\My Files"], env: {} },
    });
    if (typeof server === "string") throw new Error(server);
    expect(describeCentralMcpServer(server)).toBe("npx -y fs-mcp D:\\My Files");
  });

  it("explains invalid names and empty targets", () => {
    expect(typeof centralMcpServerFromInput("t3-code", "npx x")).toBe("string");
    expect(typeof centralMcpServerFromInput("bad name", "npx x")).toBe("string");
    expect(typeof centralMcpServerFromInput("ok", "  ")).toBe("string");
  });
});
