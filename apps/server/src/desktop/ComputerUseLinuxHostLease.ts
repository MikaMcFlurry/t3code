// @effect-diagnostics nodeBuiltinImport:off -- Linux abstract Unix sockets and Windows named pipes provide a kernel-owned cross-process lease unavailable through Effect's network API.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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

const USER_LEASE_KEY_BYTES = 32;

export class ComputerUseLinuxLeaseKeyError extends Schema.TaggedError<ComputerUseLinuxLeaseKeyError>()(
  "ComputerUseLinuxLeaseKeyError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The desktop lease key can't be used: ${this.reason}`;
  }
}

/**
 * Where this OS user's lease key lives, from the account itself rather than the process
 * environment, so servers started with different LOCALAPPDATA or XDG_STATE_HOME still agree:
 * the user's runtime directory on Linux when it exists, else the passwd home's state directory;
 * the profile's AppData\Local on Windows, whose ACL already admits only the user and SYSTEM.
 */
export async function userLeaseKeyFile(input: {
  readonly platform: NodeJS.Platform;
}): Promise<string> {
  const account = NodeOS.userInfo();
  if (input.platform === "win32") {
    return NodePath.join(account.homedir, "AppData", "Local", "t3code", "computer-use-lease.key");
  }
  const runtime = `/run/user/${account.uid}`;
  const runtimeExists = await NodeFSP.stat(runtime).then(
    (stats) => stats.isDirectory() && stats.uid === account.uid,
    () => false,
  );
  return runtimeExists
    ? NodePath.join(runtime, "t3code", "computer-use-lease.key")
    : NodePath.join(account.homedir, ".local", "state", "t3code", "computer-use-lease.key");
}

/** An existing key file must be a plain file of this user that nobody else can read. */
async function assertPrivateKeyFile(file: string, platform: NodeJS.Platform): Promise<void> {
  const stats = await NodeFSP.lstat(file);
  if (!stats.isFile()) throw new ComputerUseLinuxLeaseKeyError({ reason: `${file} is not a file` });
  if (platform === "win32") return;
  if (stats.uid !== NodeOS.userInfo().uid || (stats.mode & 0o077) !== 0) {
    throw new ComputerUseLinuxLeaseKeyError({
      reason: `${file} must belong to this user and be readable by nobody else (mode 600)`,
    });
  }
}

/**
 * The lease scope key shared by all of this OS user's T3 servers, from a file only the user can
 * read. It appears only complete (written aside, then hard-linked in), so racing servers agree.
 */
export async function userLeaseScopeKey(input: {
  readonly platform: NodeJS.Platform;
  /** Test seam; production derives it from the OS account. */
  readonly file?: string;
}): Promise<string> {
  const file = input.file ?? (await userLeaseKeyFile(input));
  const read = async () => {
    await assertPrivateKeyFile(file, input.platform);
    const key = (await NodeFSP.readFile(file)).toString("base64url");
    if (key.length < USER_LEASE_KEY_BYTES) {
      throw new ComputerUseLinuxLeaseKeyError({ reason: `${file} is too short` });
    }
    return key;
  };
  const exists = await NodeFSP.lstat(file).then(
    () => true,
    () => false,
  );
  if (exists) return read();
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const draft = `${file}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(draft, NodeCrypto.randomBytes(USER_LEASE_KEY_BYTES), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await NodeFSP.link(draft, file);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  } finally {
    await NodeFSP.rm(draft, { force: true });
  }
  return read();
}
