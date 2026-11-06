import { assert, describe, it } from "@effect/vitest";

import { computerUseLinuxToolResult } from "./ComputerUseLinuxMcpToolkit.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("computerUseLinuxToolResult", () => {
  it("passes text and images through as MCP blocks", () => {
    const result = computerUseLinuxToolResult(
      {
        content: [
          { type: "text", text: '{"width":1920,"height":1080}' },
          { type: "image", data: png, mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///etc/passwd" } },
        ],
        structuredContent: { width: 1920, height: 1080 },
      },
      true,
    );
    assert.isFalse(result.isError);
    assert.deepStrictEqual(result.content[0], {
      type: "text",
      text: '{"width":1920,"height":1080}',
    });
    const image = result.content[1] as { type: string; data: Uint8Array; mimeType: string };
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.deepStrictEqual([...image.data], [0x89, 0x50, 0x4e, 0x47]);
    assert.lengthOf(result.content, 2);
    assert.deepStrictEqual(result.structuredContent, { width: 1920, height: 1080 });
  });

  it("leaves images out on request and says so", () => {
    const result = computerUseLinuxToolResult(
      { content: [{ type: "image", data: png, mimeType: "image/png" }] },
      false,
    );
    assert.deepStrictEqual(result.content, [
      { type: "text", text: "1 image left out (includeImage: false)." },
    ]);
  });

  it("keeps an upstream error an error and refuses unexpected image types", () => {
    const result = computerUseLinuxToolResult(
      {
        isError: true,
        content: [
          { type: "text", text: "screenshot failed" },
          { type: "image", data: png, mimeType: "text/html" },
        ],
      },
      true,
    );
    assert.isTrue(result.isError);
    assert.deepStrictEqual(result.content, [{ type: "text", text: "screenshot failed" }]);
  });

  it("falls back to bounded JSON text for an unknown result shape", () => {
    const result = computerUseLinuxToolResult({ ok: true }, true);
    assert.deepStrictEqual(result.content, [{ type: "text", text: '{"ok":true}' }]);
  });
});
