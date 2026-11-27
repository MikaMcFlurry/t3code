import type { DesktopApprovalRespondInput } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
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

export function DesktopApprovalCoordinator() {
  const gt = useGT();
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
          <AlertDialogTitle>
            <T>Allow desktop control?</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>
              Thread <Var>{request?.threadId ?? ""}</Var> wants to run the desktop action "
              <Var>{request?.toolName ?? ""}</Var>". Review the exact input before allowing it. It
              is shown only for this pending decision and is not saved by the approval broker.
            </T>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
          {request === null
            ? ""
            : request.arguments === undefined
              ? gt("(no arguments)")
              : JSON.stringify(request.arguments, null, 2)}
        </pre>
        <AlertDialogFooter>
          <Button disabled={responding} variant="outline" onClick={() => void decide("deny")}>
            <T>Deny</T>
          </Button>
          <Button disabled={responding} onClick={() => void decide("approve")}>
            <T>Allow once</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
