import { describe, expect, it } from "vite-plus/test";

import {
  centralMcpServerFromInput,
  centralMcpServerSecretEntries,
  centralMcpServerSecretKeyProblem,
  describeCentralMcpServer,
  withCentralMcpServerSecret,
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

describe("central MCP server secrets", () => {
  const masked = "\u2022\u2022\u2022\u2022\u2022\u2022";
  const http = {
    name: "docs",
    enabled: true,
    transport: {
      type: "http" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: masked, "X-Empty": "" },
    },
  };

  it("lists entries with whether a value is saved, never the value", () => {
    expect(centralMcpServerSecretEntries(http)).toEqual([
      { key: "Authorization", saved: true },
      { key: "X-Empty", saved: false },
    ]);
  });

  it("keeps masked values it does not touch and replaces or removes the one it does", () => {
    const replaced = withCentralMcpServerSecret(http, "X-Empty", "token");
    expect(replaced.transport).toEqual({
      ...http.transport,
      headers: { Authorization: masked, "X-Empty": "token" },
    });
    expect(withCentralMcpServerSecret(replaced, "Authorization", null).transport).toEqual({
      ...http.transport,
      headers: { "X-Empty": "token" },
    });
  });

  it("writes environment variables on stdio servers", () => {
    const server = centralMcpServerFromInput("gh", "npx gh-mcp");
    if (typeof server === "string") throw new Error(server);
    expect(withCentralMcpServerSecret(server, "GITHUB_TOKEN", "t").transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["gh-mcp"],
      env: { GITHUB_TOKEN: "t" },
    });
    expect(centralMcpServerSecretKeyProblem(server, "1BAD")).toBeTypeOf("string");
    expect(centralMcpServerSecretKeyProblem(server, "GOOD_1")).toBeNull();
    expect(centralMcpServerSecretKeyProblem(http, "Bad Header")).toBeTypeOf("string");
  });
});
