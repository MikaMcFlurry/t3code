import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  approvalRedirectNotice,
  composerSendRefusal,
  composerSendRefusalToast,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

describe("composerSendRefusal", () => {
  it("offers Stop next to a refusal over background work, with what still runs", () => {
    const message =
      'The previous account is still running background agents or commands, and switching would end them. Wait for them to finish, or press Stop, then send the message again. Still running: background task "npm test", wake turn.';
    expect(composerSendRefusal(message)).toEqual({
      title: "Message not sent",
      description: message,
      offersBackgroundStop: true,
    });
    expect(
      composerSendRefusal(
        "Claude is still running background agents or commands, and this model or setting change would end them.",
      ).offersBackgroundStop,
    ).toBe(true);
  });

  it("shows any other refusal without a Stop offer", () => {
    expect(composerSendRefusal("Thread is archived.")).toEqual({
      title: "Message not sent",
      description: "Thread is archived.",
      offersBackgroundStop: false,
    });
  });
});

describe("composerSendRefusalToast", () => {
  const busy =
    "Claude is still running background agents or commands, and this model or setting change would end them.";
  const click = (toast: ReturnType<typeof composerSendRefusalToast>) =>
    (toast.actionProps?.onClick as (() => void) | undefined)?.();

  it("stops the refused thread even after the user moved to another thread", () => {
    const refused = scopeThreadRef(local, ThreadId.make("thread-a"));
    // The thread open at click time, as a route-reading Stop would see it.
    let open = refused;
    const stopped: Array<unknown> = [];
    const toast = composerSendRefusalToast({
      message: busy,
      threadRef: refused,
      isServerThread: true,
      onStopBackgroundWork: (threadRef) => stopped.push(threadRef ?? open),
    });
    open = scopeThreadRef(local, ThreadId.make("thread-b"));
    click(toast);
    expect(stopped).toEqual([refused]);
    expect(toast.data?.threadRef).toEqual(refused);
  });

  it("keeps the refused thread's environment when another environment has the same thread id", () => {
    const refused = scopeThreadRef(remote, ThreadId.make("same"));
    const stopped: Array<unknown> = [];
    const toast = composerSendRefusalToast({
      message: busy,
      threadRef: refused,
      isServerThread: true,
      onStopBackgroundWork: (threadRef) => stopped.push(threadRef),
    });
    click(toast);
    expect(stopped).toEqual([scopeThreadRef(remote, ThreadId.make("same"))]);
  });

  it("offers no Stop for other refusals", () => {
    const toast = composerSendRefusalToast({
      message: "Thread is archived.",
      threadRef: scopeThreadRef(local, ThreadId.make("thread-a")),
      isServerThread: true,
      onStopBackgroundWork: () => {
        throw new Error("no Stop offered");
      },
    });
    expect(toast.actionProps).toBeUndefined();
  });
});
