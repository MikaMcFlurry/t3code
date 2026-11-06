// @effect-diagnostics nodeBuiltinImport:off -- standalone native Linux lease harness.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import * as Schema from "effect/Schema";

import {
  ComputerUseLinuxHostLease,
  ComputerUseLinuxLeaseBusyError,
} from "../ComputerUseLinuxHostLease.ts";

const mode = process.argv[2] ?? "parent";
const scopeKey = process.argv[3] ?? `harness-${process.pid}`;
const lease = () => new ComputerUseLinuxHostLease({ platform: "linux", scopeKey });
const waitEvent = (
  emitter: { once(event: string, listener: (...arguments_: unknown[]) => void): unknown },
  event: string,
) =>
  new Promise<ReadonlyArray<unknown>>((resolve) => {
    emitter.once(event, (...arguments_) => resolve(arguments_));
  });

if (mode === "contend") {
  try {
    const handle = await lease().acquire();
    await handle.release();
    process.stdout.write("ACQUIRED\n");
  } catch (cause) {
    if (Schema.is(ComputerUseLinuxLeaseBusyError)(cause)) {
      process.stdout.write("BUSY\n");
    } else {
      throw cause;
    }
  }
} else if (mode === "hold") {
  await lease().acquire();
  process.stdout.write("ACQUIRED\n");
  await new Promise(() => undefined);
} else {
  const child = (childMode: "contend" | "hold") =>
    NodeChildProcess.spawn(
      process.execPath,
      ["--experimental-strip-types", import.meta.filename, childMode, scopeKey],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
  const line = async (process_: { readonly stdout: NodeJS.ReadableStream }) => {
    const reader = NodeReadline.createInterface({ input: process_.stdout });
    const [value] = await waitEvent(reader, "line");
    reader.close();
    return String(value);
  };

  const first = await lease().acquire();
  const contender = child("contend");
  if ((await line(contender)) !== "BUSY") throw new Error("contender acquired a held lease");
  await waitEvent(contender, "exit");
  await first.release();

  const released = child("contend");
  if ((await line(released)) !== "ACQUIRED") throw new Error("released lease was not reusable");
  await waitEvent(released, "exit");

  const holder = child("hold");
  if ((await line(holder)) !== "ACQUIRED") throw new Error("holder did not acquire lease");
  holder.kill("SIGKILL");
  await waitEvent(holder, "exit");
  const afterCrash = await lease().acquire();
  await afterCrash.release();

  process.stdout.write("PASS contention release SIGKILL-recovery\n");
}
