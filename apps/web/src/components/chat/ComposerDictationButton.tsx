import { LoaderCircleIcon, MicIcon } from "lucide-react";
import { useState } from "react";

import { isWindowsPlatform } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Windows voice typing works in any focused field, so the desktop app can offer it directly. */
export function canStartSystemDictation(): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    isWindowsPlatform(navigator.platform)
  );
}

/**
 * Focuses the composer and opens Windows voice typing (Win+H). Windows transcribes in the
 * language set for voice typing and types into the editor like a keyboard.
 */
export function ComposerDictationButton(props: { readonly focusComposer: () => void }) {
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = failed ? "Windows voice typing is not available" : "Dictate (Win+H)";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={starting}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              props.focusComposer();
              setStarting(true);
              void (window.desktopBridge?.startSystemDictation() ?? Promise.resolve(false))
                .then((started) => setFailed(!started))
                .finally(() => setStarting(false));
            }}
            aria-label={label}
          />
        }
      >
        {starting ? <LoaderCircleIcon className="animate-spin" /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
