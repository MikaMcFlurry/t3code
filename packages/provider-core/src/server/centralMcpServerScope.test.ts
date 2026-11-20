import { CentralMcpServer, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { centralMcpServersForSession } from "./centralMcpServerScope.ts";

const decode = Schema.decodeUnknownSync(Schema.Array(CentralMcpServer));
const session = {
  providerInstanceId: ProviderInstanceId.make("desktop-control"),
  threadId: ThreadId.make("thread-authorized"),
};

describe("centralMcpServersForSession", () => {
  it("preserves legacy global servers but fails closed for an empty explicit scope", () => {
    const servers = decode([
      { name: "global", transport: { type: "stdio", command: "global" } },
      {
        name: "closed",
        sessionScope: {},
        transport: { type: "stdio", command: "closed" },
      },
    ]);

    assert.deepStrictEqual(
      centralMcpServersForSession(servers, session).map((server) => server.name),
      ["global"],
    );
  });

  it("requires every populated provider and thread allowlist to match", () => {
    const servers = decode([
      {
        name: "host-capability",
        sessionScope: {
          providerInstanceIds: ["desktop-control"],
          threadIds: ["thread-authorized"],
        },
        transport: { type: "stdio", command: "host-capability", args: ["mcp"] },
      },
    ]);

    assert.lengthOf(centralMcpServersForSession(servers, session), 1);
    assert.lengthOf(
      centralMcpServersForSession(servers, {
        ...session,
        threadId: ThreadId.make("thread-other"),
      }),
      0,
    );
    assert.lengthOf(
      centralMcpServersForSession(servers, {
        ...session,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      }),
      0,
    );
    assert.lengthOf(centralMcpServersForSession(servers, undefined), 0);
  });
});
