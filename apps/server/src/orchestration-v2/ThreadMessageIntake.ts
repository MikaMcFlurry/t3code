import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationV2Command,
  ProjectId,
  ServerProvider,
  ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { availableAccountSelection, limitSwitchReturnSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as AccountLimits from "./AccountLimits.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorProviderSelectionBusyError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "ThreadManagementProviderInstanceDisabledError":
      return true;
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const withGuestAttachments = Effect.fn("ThreadMessageIntake.withGuestAttachments")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return command;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  const message = projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
  return { ...command, attachments: message?.attachments ?? [] };
});

/** Null unless the user lets sends move off an account that is out of usage. */
const readAccountChoice = Effect.fn("ThreadMessageIntake.readAccountChoice")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.orElseSucceed(() => null),
  );
  if (!settings?.fallbackToAvailableAccounts) return null;
  const providers = yield* ProviderRegistry.ProviderRegistry.pipe(
    Effect.flatMap((registry) => registry.getProviders),
  );
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  // A model an agent picked stays that model: only another account of it may take over.
  const choose = (selection: ModelSelection, projectId: ProjectId, sameModelOnly = false) =>
    availableAccountSelection({
      selection,
      providers,
      now,
      settings,
      projectId,
      sameModelOnly,
      limitedUntil: AccountLimits.accountLimits(),
    }) ?? selection;
  return Object.assign(choose, { providers, now, settings });
});

type MessageDispatchCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>;

/**
 * The account a new turn on an existing thread starts on, or undefined to keep the one it
 * names (or the thread's). Null-safe when the setting is off or the thread cannot be read.
 */
const availableThreadAccount = Effect.fn("ThreadMessageIntake.availableThreadAccount")(function* (
  input: Pick<MessageDispatchCommand, "threadId" | "modelSelection" | "deliveryIntent">,
  sameModelOnly = false,
) {
  const choose = yield* readAccountChoice();
  if (choose === null) return undefined;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const window = yield* threads
    .getThreadSnapshotWindow(input.threadId, { rowLimit: 1 })
    .pipe(Effect.orElseSucceed(() => null));
  if (window === null) return undefined;
  const { thread } = window.projection;
  const selection = input.modelSelection ?? thread.modelSelection;
  const returned = yield* returnAfterLimitSwitch(input, selection, thread.projectId, choose);
  const next = choose(
    returned ?? selection,
    thread.projectId,
    sameModelOnly || thread.createdBy === "agent",
  );
  return next === selection ? undefined : next;
});

/**
 * The account a message's turn starts on, picked under the thread's dispatch lock: a send
 * that commits first (and so may have started or queued a run) is always seen, never raced.
 * Steering stays on the active run's account; server continuations validate their own. An
 * agent's send keeps its model.
 */
export const messageAccountChoice = Effect.fn("ThreadMessageIntake.messageAccountChoice")(
  function* (options: { readonly sameModelOnly: boolean }) {
    const context = yield* Effect.context<
      | ServerSettings.ServerSettingsService
      | ProviderRegistry.ProviderRegistry
      | ThreadManagement.ThreadManagementService
    >();
    const resolveModelSelection = (command: MessageDispatchCommand) =>
      command.dispatchMode.type === "steer_active" ||
      command.dispatchMode.type === "restart_active" ||
      command.usageLimitContinuationOfRunId !== undefined ||
      command.restartContinuationOfRunId !== undefined
        ? Effect.undefined
        : availableThreadAccount(command, options.sameModelOnly).pipe(Effect.provide(context));
    return { resolveModelSelection } satisfies ThreadManagement.ThreadManagementDispatchOptions;
  },
);

/** A new thread starts on an account with usage left; a model an agent picked stays. */
export const withAvailableLaunchAccount = Effect.fn(
  "ThreadMessageIntake.withAvailableLaunchAccount",
)(function* (input: ThreadLaunch.ThreadLaunchInput) {
  const choose = yield* readAccountChoice();
  if (choose === null) return input;
  const modelSelection = choose(input.modelSelection, input.projectId, input.createdBy === "agent");
  return modelSelection === input.modelSelection ? input : { ...input, modelSelection };
});

/**
 * The account a usage-limit switch moved this thread away from, once it has usage again. Only
 * for a turn that starts now: never while a run is active or queued, so no turn is cut off.
 */
const returnAfterLimitSwitch = Effect.fn("ThreadMessageIntake.returnAfterLimitSwitch")(function* (
  command: Pick<MessageDispatchCommand, "threadId" | "deliveryIntent">,
  current: ModelSelection,
  projectId: ProjectId,
  choice: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly settings: ServerSettingsValue;
  },
) {
  if (command.deliveryIntent === "steer" || command.deliveryIntent === "restart") return null;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const latest = yield* threads
    .getLatestLimitSwitch(command.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (latest === null || latest.busy) return null;
  return limitSwitchReturnSelection({
    ...choice,
    projectId,
    origin: latest.origin,
    originResetAt: latest.originResetAt,
    originLimitedAt: latest.originLimitedAt,
    switchedTo: latest.switchedTo,
    current,
  });
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
) {
  const command =
    incoming.type === "message.dispatch" ? yield* withGuestAttachments(incoming) : incoming;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.tap((result) => {
          // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
          // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  const accountChoice =
    command.type === "message.dispatch"
      ? yield* messageAccountChoice({ sameModelOnly: false })
      : undefined;
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  return yield* threads
    .dispatch(
      {
        ...command,
        attachments: claimed.attachments,
        ...(command.context
          ? {
              context: remapComposerContextAttachments(
                command.context,
                command.attachments ?? [],
                claimed.attachments,
              ),
            }
          : {}),
      },
      accountChoice,
    )
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const accountChoice = yield* messageAccountChoice({ sameModelOnly: input.createdBy === "agent" });
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads
    .sendToThread({ ...input, attachments: claimed.attachments }, accountChoice)
    .pipe(
      Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  requested: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const input = yield* withAvailableLaunchAccount(requested);
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede dispatch; create-thread errors can wrap post-message reads and prove nothing alone.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
