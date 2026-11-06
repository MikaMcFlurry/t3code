import {
  ComputerUseLinuxBridge,
  type ComputerUseLinuxBridgeRequest,
  type ComputerUseLinuxBridgeSession,
  type ComputerUseLinuxInteractionApproval,
} from "./ComputerUseLinuxBridge.ts";
import type { ComputerUseLinuxLease } from "./ComputerUseLinuxHostLease.ts";
import { computerUseLinuxToolAccess } from "./ComputerUseLinuxPolicy.ts";

export interface ComputerUseLinuxMcpTool {
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface ComputerUseLinuxUpstreamMcpClient {
  callTool(
    input: { readonly arguments?: unknown; readonly name: string },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
  close(): Promise<void>;
  listTools(): Promise<ReadonlyArray<ComputerUseLinuxMcpTool>>;
}

/**
 * Minimal transport-independent adapter for an upstream computer-use-linux MCP client. It
 * preserves approved upstream schemas while hiding every tool the T3 policy does not know.
 * The surrounding T3 MCP transport must supply the real provider/thread identity.
 */
export class ComputerUseLinuxMcpAdapter {
  private readonly bridge: ComputerUseLinuxBridge;
  private readonly upstream: ComputerUseLinuxUpstreamMcpClient;

  constructor(
    upstream: ComputerUseLinuxUpstreamMcpClient,
    hostLease: ComputerUseLinuxLease,
    session: ComputerUseLinuxBridgeSession,
    approveInteraction: ComputerUseLinuxInteractionApproval,
  ) {
    this.upstream = upstream;
    this.bridge = new ComputerUseLinuxBridge(
      {
        invoke: (toolName, arguments_, options) =>
          this.upstream.callTool({ name: toolName, arguments: arguments_ }, options),
      },
      hostLease,
      session,
      approveInteraction,
    );
  }

  async listTools(): Promise<ReadonlyArray<ComputerUseLinuxMcpTool>> {
    const tools = await this.upstream.listTools();
    return tools.filter((tool) => computerUseLinuxToolAccess(tool.name) !== "deny");
  }

  callTool(request: ComputerUseLinuxBridgeRequest): Promise<unknown> {
    return this.bridge.invoke(request);
  }

  revoke(): void {
    this.bridge.revoke();
  }

  async close(): Promise<void> {
    this.bridge.revoke();
    const results = await Promise.allSettled([this.bridge.close(), this.upstream.close()]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Computer Use adapter close failed.");
  }
}
