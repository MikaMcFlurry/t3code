// @effect-diagnostics nodeBuiltinImport:off -- Linux abstract Unix sockets and Windows named pipes provide a kernel-owned cross-process lease unavailable through Effect's network API.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

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
 * Where this OS user's lease key lives: a fixed place in the account's own home (from the OS
 * account, not HOME, LOCALAPPDATA or XDG_STATE_HOME), so every server of the user agrees whether
 * or not it started before login.
 */
export function userLeaseKeyFile(input: { readonly platform: NodeJS.Platform }): string {
  const home = NodeOS.userInfo().homedir;
  return input.platform === "win32"
    ? NodePath.join(home, "AppData", "Local", "t3code-desktop-lease", "lease.key")
    : NodePath.join(home, ".local", "state", "t3code-desktop-lease", "lease.key");
}

const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
/** whoami and icacls may not hold up a desktop call indefinitely. */
const WINDOWS_TOOL_TIMEOUT_MS = 10_000;

const windowsTool = (...segments: ReadonlyArray<string>) =>
  NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...segments);

const runWindowsTool = (file: string, args: ReadonlyArray<string>) =>
  execFile(file, [...args], { windowsHide: true, timeout: WINDOWS_TOOL_TIMEOUT_MS });

/** The SID of the user this process runs as (locale-independent, unlike account names). */
async function windowsUserSid(): Promise<string> {
  const { stdout } = await runWindowsTool(windowsTool("whoami.exe"), [
    "/user",
    "/fo",
    "csv",
    "/nh",
  ]);
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.trim())?.[1];
  if (sid === undefined) throw new ComputerUseLinuxLeaseKeyError({ reason: "no user SID" });
  return sid;
}

/**
 * Why an SDDL's DACL is not private to this user, or undefined when it is: only deny ACEs and
 * plain allow ACEs for the user, SYSTEM and Administrators pass; any other ACE type, callback and
 * object ACEs included, or text it can't parse is refused rather than interpreted.
 */
export function privateDaclRefusal(sddl: string, userSid: string): string | undefined {
  // The DACL up to any SACL; nothing in it may go unrecognized.
  const dacl = /D:([^\r\n]*?)(?:S:|$)/m.exec(sddl)?.[1];
  if (dacl === undefined) {
    return "has no readable DACL";
  }
  const ace = /\(([^;()]*);[^;()]*;[^;()]*;[^;()]*;[^;()]*;([^;()]*)\)/g;
  const aces = dacl.replace(/^[A-Z]*/, "");
  if (aces.replace(ace, "") !== "") {
    return "has a DACL T3 can't verify";
  }
  const allowed = new Set(["SY", "BA", WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID, userSid]);
  for (const [, type, trustee] of aces.matchAll(ace)) {
    if (type === "D") continue;
    if (type !== "A" || trustee === undefined || !allowed.has(trustee)) {
      return `grants ${trustee ?? "someone"} (${type ?? "?"}); only you, SYSTEM and Administrators may have access`;
    }
  }
  return undefined;
}

/**
 * A path's whole DACL, read as SDDL (SIDs, not localized names), may hold only deny ACEs and
 * plain allow ACEs for this user, SYSTEM and Administrators. Any other ACE type, callback and
 * object ACEs included, is refused rather than interpreted.
 */
async function assertPrivateWindowsAcl(target: string, userSid: string): Promise<void> {
  const saved = NodePath.join(NodeOS.tmpdir(), `t3-lease-acl-${NodeCrypto.randomUUID()}.txt`);
  try {
    await runWindowsTool(windowsTool("icacls.exe"), [target, "/save", saved]);
    const sddl = (await NodeFSP.readFile(saved)).toString("utf16le");
    const refusal = privateDaclRefusal(sddl, userSid);
    if (refusal !== undefined) {
      throw new ComputerUseLinuxLeaseKeyError({ reason: `${target} ${refusal}` });
    }
  } finally {
    await NodeFSP.rm(saved, { force: true });
  }
}

/**
 * Gives the key directory exactly this user, SYSTEM and Administrators, inheritance removed, and
 * verifies that nothing else is left before any secret is written into it.
 */
async function restrictWindowsDirectory(directory: string, userSid: string): Promise<void> {
  await runWindowsTool(windowsTool("icacls.exe"), [
    directory,
    "/inheritance:r",
    "/grant:r",
    `*${userSid}:(OI)(CI)F`,
    `*${WINDOWS_SYSTEM_SID}:(OI)(CI)F`,
    `*${WINDOWS_ADMINISTRATORS_SID}:(OI)(CI)F`,
  ]);
  await assertPrivateWindowsAcl(directory, userSid);
}

/** An existing key file must be a plain file only this user can use. */
async function assertPrivateKeyFile(file: string, platform: NodeJS.Platform): Promise<void> {
  const stats = await NodeFSP.lstat(file);
  if (!stats.isFile()) throw new ComputerUseLinuxLeaseKeyError({ reason: `${file} is not a file` });
  if (platform === "win32") {
    const userSid = await windowsUserSid();
    await assertPrivateWindowsAcl(NodePath.dirname(file), userSid);
    await assertPrivateWindowsAcl(file, userSid);
    return;
  }
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
  const file = input.file ?? userLeaseKeyFile(input);
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
  // Every creator restricts the directory before publishing, so whichever key wins is private.
  if (input.platform === "win32") {
    await restrictWindowsDirectory(NodePath.dirname(file), await windowsUserSid());
  }
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
