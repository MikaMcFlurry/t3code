#!/usr/bin/env node
import * as NodeReadline from "node:readline";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const markerPaths = process.argv.slice(2).filter((argument) => NodePath.isAbsolute(argument));
const startedMarker = markerPaths[0];
const completedMarker = markerPaths[1];

for await (const line of lines) {
  if (line.trim().length === 0) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-computer-use-linux", version: "1" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "screenshot", description: "fake", inputSchema: { type: "object" } },
          { name: "click", description: "fake", inputSchema: { type: "object" } },
          { name: "run_shell", description: "denied", inputSchema: { type: "object" } },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    if (message.params.name === "click") {
      if (startedMarker) await NodeFSP.writeFile(startedMarker, "started", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (completedMarker) await NodeFSP.writeFile(completedMarker, "completed", "utf8");
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: message.params.name,
              arguments: message.params.arguments,
              shell: process.env.COMPUTER_USE_LINUX_ENABLE_SHELL,
              screenshotBackend: process.env.COMPUTER_USE_LINUX_SCREENSHOT_BACKEND,
              leakedIdentity: process.env.T3_PROVIDER_SESSION_ID ?? null,
            }),
          },
        ],
      },
    });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
  }
}
