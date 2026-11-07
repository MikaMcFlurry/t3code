import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

/** `?desktopLiveView=primary` (or an environment id) opens the live view, e.g. from a push. */
export const DESKTOP_LIVE_VIEW_SEARCH_PARAM = "desktopLiveView";

// Read when the app loads: start-up redirects (welcome, last thread) drop the query string.
const deepLinked = (() => {
  if (typeof window === "undefined") return null;
  const target = new URL(window.location.href).searchParams.get(DESKTOP_LIVE_VIEW_SEARCH_PARAM);
  return target === null || target === "" ? null : target;
})();

let openEnvironment: EnvironmentId | "primary" | null =
  deepLinked === null ? null : deepLinked === "primary" ? "primary" : (deepLinked as EnvironmentId);
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function openDesktopLiveView(environmentId: EnvironmentId | "primary" = "primary") {
  openEnvironment = environmentId;
  notify();
}

function closeDesktopLiveView() {
  openEnvironment = null;
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The machine's whole screen, live; take control to type a password or answer a prompt. */
export function DesktopLiveViewDialog() {
  const requested = useSyncExternalStore(subscribe, () => openEnvironment);
  const primary = usePrimaryEnvironmentId();
  const environmentId = requested === "primary" ? primary : requested;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaves the address bar clean once the deep link has opened the view
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(DESKTOP_LIVE_VIEW_SEARCH_PARAM)) return;
    url.searchParams.delete(DESKTOP_LIVE_VIEW_SEARCH_PARAM);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  return (
    <Dialog
      open={environmentId !== null}
      onOpenChange={(open) => {
        if (!open) closeDesktopLiveView();
      }}
    >
      <DialogPopup className="h-[85vh] sm:max-w-6xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Desktop live view</DialogTitle>
          <DialogDescription>
            Take control to type a password, solve a captcha or answer a system prompt. The
            agent&apos;s desktop actions wait until you release control.
          </DialogDescription>
        </DialogHeader>
        {environmentId !== null ? (
          <ServerBrowserSurface
            stream="desktop"
            environmentId={environmentId}
            threadId="desktop"
            tabId="desktop"
            visible
            followSize={false}
            className="min-h-0 flex-1 border-t"
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
