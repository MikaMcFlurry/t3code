import type { DesktopApprovalRespondInput } from "@t3tools/contracts";
import { useState } from "react";

import { desktopApprovalEnvironment } from "../../state/desktopApprovals";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { openDesktopLiveView } from "./DesktopLiveViewDialog";

export function DesktopApprovalCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const approvals = useEnvironmentQuery(
    environmentId === null ? null : desktopApprovalEnvironment.state({ environmentId, input: {} }),
  );
  const respond = useAtomCommand(desktopApprovalEnvironment.respond, {
    label: "Respond to desktop control request",
  });
  const [responding, setResponding] = useState(false);
  const request = approvals.data?.requests[0] ?? null;

  const decide = async (decision: DesktopApprovalRespondInput["decision"]) => {
    if (environmentId === null || request === null || responding) return;
    setResponding(true);
    await respond({
      environmentId,
      input: { id: request.id, threadId: request.threadId, decision },
    }).finally(() => setResponding(false));
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) void decide("deny");
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Allow desktop control?</AlertDialogTitle>
          <AlertDialogDescription>
            Thread {request?.threadId ?? ""} wants to run the desktop action ÔÇ£
            {request?.toolName ?? ""}". Review the exact input before allowing it. It is shown only
            for this pending decision and is not saved by the approval broker.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
          {request === null
            ? ""
            : request.arguments === undefined
              ? "(no arguments)"
              : JSON.stringify(request.arguments, null, 2)}
        </pre>
        <AlertDialogFooter>
          <Button
            className="sm:me-auto"
            variant="ghost"
            onClick={() => environmentId !== null && openDesktopLiveView(environmentId)}
          >
            Show desktop
          </Button>
          <Button disabled={responding} variant="outline" onClick={() => void decide("deny")}>
            Deny
          </Button>
          <Button disabled={responding} onClick={() => void decide("approve")}>
            Allow once
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
