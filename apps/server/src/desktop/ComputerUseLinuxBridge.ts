import * as Schema from "effect/Schema";

import type { ComputerUseLinuxLease } from "./ComputerUseLinuxHostLease.ts";
import {
  ComputerUseLinuxOperationGate,
  computerUseLinuxToolAccess,
  type ComputerUseLinuxToolAccess,
} from "./ComputerUseLinuxPolicy.ts";

export interface ComputerUseLinuxBackend {
  invoke(
    toolName: string,
    arguments_: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export interface ComputerUseLinuxBridgeRequest {
  readonly arguments?: unknown;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly threadId: string;
  readonly toolName: string;
}

export type ComputerUseLinuxInteractionApproval = (
  request: ComputerUseLinuxBridgeRequest,
  options: { readonly signal: AbortSignal },
) => Promise<boolean>;

export interface ComputerUseLinuxBridgeSession {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly threadId: string;
}

export class ComputerUseLinuxBridgeRevokedError extends Schema.TaggedError<ComputerUseLinuxBridgeRevokedError>()(
  "ComputerUseLinuxBridgeRevokedError",
  {},
) {
  override get message(): string {
    return "Computer Use bridge has been revoked.";
  }
}

export class ComputerUseLinuxBridgeApprovalError extends Schema.TaggedError<ComputerUseLinuxBridgeApprovalError>()(
  "ComputerUseLinuxBridgeApprovalError",
  { toolName: Schema.String },
) {
  override get message(): string {
    return `Computer Use interaction '${this.toolName}' was not approved.`;
  }
}

export class ComputerUseLinuxBridgeSessionError extends Schema.TaggedError<ComputerUseLinuxBridgeSessionError>()(
  "ComputerUseLinuxBridgeSessionError",
  {},
) {
  override get message(): string {
    return "Computer Use bridge request does not belong to its bound T3 session.";
  }
}

/**
 * Enforcement core for a future T3-native bridge. The raw upstream MCP server is kept behind
 * this boundary: denied tools never reach it, every interaction needs a per-call approval, and
 * all observation and interaction calls share the same host lease.
 */
export class ComputerUseLinuxBridge {
  private readonly approvalControllers = new Set<AbortController>();
  private readonly approveInteraction: ComputerUseLinuxInteractionApproval;
  private readonly backend: ComputerUseLinuxBackend;
  private readonly gate = new ComputerUseLinuxOperationGate();
  private readonly hostLease: ComputerUseLinuxLease;
  private readonly operationControllers = new Set<AbortController>();
  private readonly session: ComputerUseLinuxBridgeSession;
  private revoked = false;

  constructor(
    backend: ComputerUseLinuxBackend,
    hostLease: ComputerUseLinuxLease,
    session: ComputerUseLinuxBridgeSession,
    approveInteraction: ComputerUseLinuxInteractionApproval,
  ) {
    this.backend = backend;
    this.hostLease = hostLease;
    this.session = {
      providerInstanceId: session.providerInstanceId,
      providerSessionId: session.providerSessionId,
      threadId: session.threadId,
    };
    this.approveInteraction = approveInteraction;
  }

  toolAccess(toolName: string): ComputerUseLinuxToolAccess {
    return computerUseLinuxToolAccess(toolName);
  }

  async invoke(request: ComputerUseLinuxBridgeRequest): Promise<unknown> {
    this.assertActive();
    const snapshot = structuredClone({
      arguments: request.arguments,
      providerInstanceId: request.providerInstanceId,
      providerSessionId: request.providerSessionId,
      threadId: request.threadId,
      toolName: request.toolName,
    });
    if (
      snapshot.providerInstanceId !== this.session.providerInstanceId ||
      snapshot.providerSessionId !== this.session.providerSessionId ||
      snapshot.threadId !== this.session.threadId
    ) {
      throw new ComputerUseLinuxBridgeSessionError();
    }
    const access = computerUseLinuxToolAccess(snapshot.toolName);
    if (access === "deny") {
      throw new Error(`Computer Use tool '${snapshot.toolName}' is not exposed by T3.`);
    }

    return this.gate.run(snapshot.toolName, async () => {
      this.assertActive();
      if (access === "interact" && !(await this.requestApproval(snapshot))) {
        throw new ComputerUseLinuxBridgeApprovalError({ toolName: snapshot.toolName });
      }
      return this.hostLease.withLease(async () => {
        this.assertActive();
        return this.invokeBackend(snapshot);
      });
    });
  }

  revoke(): void {
    this.revoked = true;
    for (const controller of this.approvalControllers) controller.abort();
    for (const controller of this.operationControllers) controller.abort();
  }

  async close(): Promise<void> {
    this.revoke();
    await this.gate.drain();
  }

  private assertActive(): void {
    if (this.revoked) throw new ComputerUseLinuxBridgeRevokedError();
  }

  private async requestApproval(request: ComputerUseLinuxBridgeRequest): Promise<boolean> {
    const controller = new AbortController();
    this.approvalControllers.add(controller);
    const approvalRequest = structuredClone(request);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new ComputerUseLinuxBridgeRevokedError()),
        { once: true },
      );
    });
    try {
      return await Promise.race([
        this.approveInteraction(approvalRequest, { signal: controller.signal }),
        aborted,
      ]);
    } finally {
      this.approvalControllers.delete(controller);
    }
  }

  private async invokeBackend(request: ComputerUseLinuxBridgeRequest): Promise<unknown> {
    const controller = new AbortController();
    this.operationControllers.add(controller);
    try {
      const result = await this.backend.invoke(request.toolName, request.arguments, {
        signal: controller.signal,
      });
      this.assertActive();
      return result;
    } finally {
      this.operationControllers.delete(controller);
    }
  }
}
