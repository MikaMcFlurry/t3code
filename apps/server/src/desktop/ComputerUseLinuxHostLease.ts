// @effect-diagnostics nodeBuiltinImport:off -- Linux abstract Unix sockets and Windows named pipes provide a kernel-owned cross-process lease unavailable through Effect's network API.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as Schema from "effect/Schema";

export interface ComputerUseLinuxLease {
  withLease<A>(operation: () => Promise<A>): Promise<A>;
}

export interface ComputerUseLinuxLeaseHandle {
  readonly socketName: string;
  release(): Promise<void>;
}

export interface ComputerUseLinuxHostLeaseOptions {
  readonly platform: NodeJS.Platform;
  /** Stable per-user secret or installation identifier; never expose it as an MCP argument. */
  readonly scopeKey: string;
}

/** Hosts with a desktop backend: computer-use-linux on Linux, Windows-MCP on Windows. */
export const COMPUTER_USE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux", "win32"]);

export class ComputerUseLinuxLeaseBusyError extends Schema.TaggedError<ComputerUseLinuxLeaseBusyError>()(
  "ComputerUseLinuxLeaseBusyError",
  {},
) {
  override get message(): string {
    return "Computer Use host lease is already held by another process.";
  }
}

export class ComputerUseLinuxLeasePlatformError extends Schema.TaggedError<ComputerUseLinuxLeasePlatformError>()(
  "ComputerUseLinuxLeasePlatformError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Computer Use host lease needs a Linux abstract socket or a Windows named pipe; current platform is ${this.platform}.`;
  }
}

const isAddressInUse = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE";

/**
 * Same-host, cross-process lease backed directly by a Linux abstract Unix socket. The kernel
 * owns the binding for exactly the lifetime of this Node process, so crashes cannot leave stale
 * filesystem state and there is no read/check/reclaim race. The scope key should be a stable
 * per-user secret so unrelated local users cannot predictably reserve the same abstract name.
 */
export class ComputerUseLinuxHostLease implements ComputerUseLinuxLease {
  private readonly platform: NodeJS.Platform;
  private readonly socketName: string;

  constructor(options: ComputerUseLinuxHostLeaseOptions) {
    this.platform = options.platform;
    const digest = NodeCrypto.createHash("sha256").update(options.scopeKey).digest("hex");
    // A Windows named pipe has the same lifetime and single-owner semantics as the abstract
    // socket: a second listener gets EADDRINUSE, and the pipe goes when the process does.
    this.socketName =
      options.platform === "win32"
        ? `\\\\.\\pipe\\t3-computer-use-${digest.slice(0, 32)}`
        : `\0t3-computer-use-${digest.slice(0, 32)}`;
  }

  async acquire(): Promise<ComputerUseLinuxLeaseHandle> {
    if (!COMPUTER_USE_PLATFORMS.has(this.platform))
      throw new ComputerUseLinuxLeasePlatformError({ platform: this.platform });
    const server = NodeNet.createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: this.socketName }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (cause) {
      server.close();
      if (isAddressInUse(cause)) throw new ComputerUseLinuxLeaseBusyError();
      throw cause;
    }
    let released = false;
    return {
      socketName: this.socketName,
      release: async () => {
        if (released) return;
        await new Promise<void>((resolve, reject) => {
          server.close((cause) => {
            if (cause) reject(cause);
            else resolve();
          });
        });
        released = true;
      },
    };
  }

  async withLease<A>(operation: () => Promise<A>): Promise<A> {
    const lease = await this.acquire();
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }
}
