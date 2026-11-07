import { useAtomValue } from "@effect/atom-react";
import {
  type PreviewStreamKind,
  previewStreamBasePath,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

const ACCESS_RETRY_INTERVAL_MS = 10_000;

interface StreamAccessKey {
  readonly environmentId: EnvironmentId;
  readonly stream: PreviewStreamKind;
}

// Keyed by stream kind: each socket spends its own media ticket.
const streamAccessKeys = new Map<string, StreamAccessKey>();
const streamAccessKey = (environmentId: EnvironmentId, stream: PreviewStreamKind = "preview") => {
  const id = `${stream}:${environmentId}`;
  let key = streamAccessKeys.get(id);
  if (!key) {
    key = { environmentId, stream };
    streamAccessKeys.set(id, key);
  }
  return key;
};

const previewStreamAccessAtom = Atom.family(({ environmentId, stream }: StreamAccessKey) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: previewStreamBasePath(stream) });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`${stream}-stream-access:${environmentId}`)),
);

// Only a surface the user is looking at retries a failed lookup; one-shot readers such as
// picture-in-picture see the failure at once.
const retryingPreviewStreamAccessAtom = Atom.family((key: StreamAccessKey) =>
  Atom.make((get) => {
    const access = previewStreamAccessAtom(key);
    const result = get(access);
    if (AsyncResult.isFailure(result)) {
      const timer = setTimeout(() => get.refresh(access), ACCESS_RETRY_INTERVAL_MS);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }),
);

export function usePreviewStreamAccess(
  environmentId: EnvironmentId,
  options?: { readonly retry: boolean; readonly stream?: PreviewStreamKind },
): DeviceHubAccess | null {
  const key = streamAccessKey(environmentId, options?.stream);
  const result = useAtomValue(
    options?.retry ? retryingPreviewStreamAccessAtom(key) : previewStreamAccessAtom(key),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

export function refreshPreviewStreamAccess(
  environmentId: EnvironmentId,
  stream: PreviewStreamKind = "preview",
): void {
  appAtomRegistry.refresh(previewStreamAccessAtom(streamAccessKey(environmentId, stream)));
}

export function readPreviewStreamAccess(
  environmentId: EnvironmentId,
  refresh: boolean,
  stream: PreviewStreamKind = "preview",
): Promise<DeviceHubAccess | null> {
  const atom = previewStreamAccessAtom(streamAccessKey(environmentId, stream));
  if (refresh) appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
