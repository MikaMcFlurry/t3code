// @effect-diagnostics nodeBuiltinImport:off -- standalone native Linux process/MCP harness.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT } from "../ComputerUseLinuxPolicy.ts";
import { makeComputerUseLinuxUpstreamFactory } from "../ComputerUseLinuxUpstreamFactory.ts";

const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cu-process-"));
const executable = NodePath.join(directory, "computer-use-linux");
const startedMarker = NodePath.join(directory, "child-started");
const completedMarker = NodePath.join(directory, "child-completed");
const fakeServer = NodeURL.fileURLToPath(new URL("./fakeComputerUseLinuxMcp.mjs", import.meta.url));

try {
  await NodeFSP.writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@" "${startedMarker}" "${completedMarker}"\n`,
    { mode: 0o700 },
  );
  const makeFactory = () =>
    makeComputerUseLinuxUpstreamFactory({
      platform: "linux",
      environment: {
        PATH: directory,
        WAYLAND_DISPLAY: "wayland-harness",
        XDG_RUNTIME_DIR: directory,
        T3_PROVIDER_SESSION_ID: "must-not-leak",
      },
      resolveExecutable: (command, platform, environment) => {
        if (command !== "computer-use-linux" || platform !== "linux") return undefined;
        if (environment.PATH !== directory) return undefined;
        return executable;
      },
    });
  const factory = makeFactory();
  const upstream = await factory.start({ environment: COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT });
  try {
    const tools = await upstream.listTools();
    if (tools.map((tool) => tool.name).join(",") !== "screenshot,click,run_shell") {
      throw new Error("unexpected tool list");
    }
    const result = (await upstream.callTool(
      { name: "screenshot", arguments: { max_width: 320 } },
      { signal: new AbortController().signal },
    )) as { readonly content: ReadonlyArray<{ readonly text: string }> };
    const evidence = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    if (
      evidence.shell !== "0" ||
      evidence.screenshotBackend !== "portal" ||
      evidence.leakedIdentity !== null
    ) {
      throw new Error(`unsafe child environment: ${JSON.stringify(evidence)}`);
    }
  } finally {
    await upstream.close();
  }

  const cancellationUpstream = await makeFactory().start({
    environment: COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT,
  });
  const markerWatcherAbort = new AbortController();
  try {
    await cancellationUpstream.listTools();
    const markerStarted = (async () => {
      for await (const _change of NodeFSP.watch(directory, { signal: markerWatcherAbort.signal })) {
        if ((await NodeFSP.readFile(startedMarker, "utf8").catch(() => "")) === "started") return;
      }
    })();
    const controller = new AbortController();
    const pending = cancellationUpstream.callTool(
      { name: "click", arguments: { x: 1, y: 2 } },
      { signal: controller.signal },
    );
    await markerStarted;
    if ((await NodeFSP.readFile(startedMarker, "utf8")) !== "started") {
      throw new Error("cancellation fixture did not start");
    }
    controller.abort();
    let rejected = false;
    try {
      await pending;
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("aborted MCP call did not reject");
    if ((await NodeFSP.readFile(completedMarker, "utf8")) !== "completed") {
      throw new Error("process close was not awaited after cancellation");
    }
  } finally {
    markerWatcherAbort.abort();
    await cancellationUpstream.close().catch(() => undefined);
  }

  process.stdout.write("PASS linux stdio MCP child, environment boundary, cancellation shutdown\n");
} finally {
  await NodeFSP.rm(directory, { force: true, recursive: true });
}
