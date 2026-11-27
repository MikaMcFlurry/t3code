import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  SecretRef,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);
const decodeStoredModelSelection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ModelSelection),
);

const threadShell = (
  projectId: ProjectId,
  state: { archivedAt?: string | null; deletedAt?: string | null } = {},
) => ({ projectId, archivedAt: null, deletedAt: null, ...state }) as never;

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(refused.message, "Schedule task is already running.");
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { status: "failed", error: "Weekly usage limit reached", heldWarning: false },
  { status: "failed", error: "Weekly usage limit reached", heldWarning: true },
  { status: "interrupted", error: "The run was stopped.", heldWarning: false },
  { status: "cancelled", error: "The run was cancelled.", heldWarning: false },
] as const)("a run that ends $status after its message was accepted records it", (outcome) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:test");
    const ended = yield* Deferred.make<void>();
    const sent = yield* Ref.make("");
    const run = { id: "run:2", status: outcome.status, rootNodeId: "node:root" };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) => Ref.set(sent, input.messageId).pipe(Effect.as({} as never)),
            getThreadShell: () => Effect.succeed(threadShell(projectId)),
            getProjectThreadRecords: () =>
              Effect.map(
                Ref.get(sent),
                (userMessageId) =>
                  ({
                    runs: [
                      { id: "run:1", status: "completed", userMessageId: "message:earlier" },
                      { ...run, userMessageId },
                    ],
                    messages: [{ id: userMessageId, runId: "run:2" }],
                    turnItems: [
                      {
                        type: "error",
                        status: "failed",
                        runId: "run:2",
                        nodeId: "node:root",
                        failure: { message: "Weekly usage limit reached" },
                      },
                    ],
                  }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.as({
                  threadId: input.threadId,
                  run: { ...run, id: input.runId, userMessageId: "" },
                  timedOut: false,
                } as never),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:quota"),
        title: "Quota bookkeeping",
        prompt: "Update the notes",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: ThreadId.make("thread:quota"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      if (outcome.heldWarning) {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET last_run_status = 'failed',
          last_run_error = 'A previous occurrence is held in the thread queue. Resume or remove it to run this task again.'
          WHERE task_id = ${task.id}`;
      }
      const failed = yield* service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((candidate) => candidate.id === task.id)),
        Stream.filter((current) => current?.lastRunError === outcome.error),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(ended, undefined);
      const recorded = Option.getOrUndefined(yield* Fiber.join(failed));
      assert.equal(recorded?.lastRunError, outcome.error);
      assert.equal(recorded?.runCount, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a one-time task is removed once its turn completes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const projectId = ProjectId.make("project:test");
    const ended = yield* Deferred.make<void>();
    const sent = yield* Ref.make("");
    const run = { id: "run:1", status: "completed", rootNodeId: "node:root" };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) => Ref.set(sent, input.messageId).pipe(Effect.as({} as never)),
            getThreadShell: () => Effect.succeed(threadShell(projectId)),
            getProjectThreadRecords: () =>
              Effect.map(
                Ref.get(sent),
                (userMessageId) => ({ runs: [{ ...run, userMessageId }] }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.as({ threadId: input.threadId, run, timedOut: false } as never),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:once"),
        title: "Release notes",
        prompt: "Draft the release notes",
        enabled: true,
        schedule: { type: "once", runAt: "2026-11-01T07:01:00.000Z" },
        projectId,
        threadId: ThreadId.make("thread:once"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const dispatched = service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((candidate) => candidate.id === task.id)),
        Stream.filter((current) => current?.lastRunStatus === "succeeded"),
        Stream.runHead,
      );
      const removed = service.subscribeList().pipe(
        Stream.filter(({ tasks }) => tasks.every((candidate) => candidate.id !== task.id)),
        Stream.runHead,
      );
      const recorded = yield* Effect.forkChild(dispatched);
      const gone = yield* Effect.forkChild(removed);
      yield* TestClock.adjust("2 minutes");
      // The dispatch alone keeps it: the turn can still fail.
      assert.isNull(Option.getOrThrow(yield* Fiber.join(recorded))?.nextRunAt);
      yield* Deferred.succeed(ended, undefined);
      yield* Fiber.join(gone);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a paused one-time task run by hand before its time is kept", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const projectId = ProjectId.make("project:test");
    const ended = yield* Deferred.make<void>();
    const outcomeRead = yield* Deferred.make<void>();
    const sent = yield* Ref.make("");
    const run = { id: "run:1", status: "completed", rootNodeId: "node:root" };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) => Ref.set(sent, input.messageId).pipe(Effect.as({} as never)),
            getThreadShell: () => Effect.succeed(threadShell(projectId)),
            getProjectThreadRecords: () =>
              Effect.map(
                Ref.get(sent),
                (userMessageId) => ({ runs: [{ ...run, userMessageId }] }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.tap(() => Deferred.succeed(outcomeRead, undefined)),
                Effect.as({ threadId: input.threadId, run, timedOut: false } as never),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:paused-once"),
        title: "Release notes",
        prompt: "Draft the release notes",
        enabled: true,
        schedule: { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
        projectId,
        threadId: ThreadId.make("thread:once"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.setEnabled({ id: task.id, enabled: false });
      yield* service.runNow({ id: task.id });
      yield* Deferred.succeed(ended, undefined);
      yield* Deferred.await(outcomeRead);
      yield* TestClock.adjust("1 second");
      const [kept] = (yield* service.list()).tasks;
      assert.equal(kept?.id, task.id);
      assert.equal(kept?.runCount, 1);
      const resumed = yield* service.setEnabled({ id: task.id, enabled: true });
      assert.equal(resumed.task.nextRunAt, "2026-11-01T08:00:00.000Z");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Saving reads it first. Then the rebind lands, and the promotion commits between the shell
    // read and the retry.
    const shellProjects = yield* Ref.make([promoted, scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [threadShell(next ?? promoted), rest]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a fresh-session task launches one thread, then starts each later run fresh in it", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const sends = yield* Ref.make<Array<{ threadId: ThreadId; freshContext?: boolean }>>([]);
    const launched = ThreadId.make("thread:fresh-session-task");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: launched, resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                deletedAt: null,
                archivedAt: null,
                projectId: ProjectId.make("project:test"),
              } as never),
            sendToThread: (input) =>
              Ref.update(sends, (all) => [
                ...all,
                {
                  threadId: input.threadId,
                  ...(input.freshContext === undefined ? {} : { freshContext: input.freshContext }),
                },
              ]).pipe(Effect.as({} as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = {
        id: ScheduledTaskId.make("task:fresh-session"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...input, threadMode: "fresh_session" });

      assert.equal((yield* service.runNow({ id: input.id })).threadId, launched);
      // A form opened before the first run saves no thread; the binding stays.
      const { task } = yield* service.upsert({
        ...input,
        threadId: null,
        threadMode: "fresh_session",
      });
      assert.equal(task.threadId, launched);
      assert.equal(task.threadMode, "fresh_session");
      // A client that predates thread modes sends neither; both stay.
      const legacy = yield* service.upsert({ ...input, threadId: null });
      assert.equal(legacy.task.threadId, launched);
      assert.equal(legacy.task.threadMode, "fresh_session");
      yield* service.runNow({ id: input.id });

      assert.equal(yield* Ref.get(launches), 1);
      assert.deepEqual(yield* Ref.get(sends), [{ threadId: launched, freshContext: true }]);
      // Its thread stays in the old project, so moving the task leaves it for a new one.
      const moved = yield* service.upsert({
        ...input,
        projectId: ProjectId.make("project:moved"),
        threadId: launched,
      });
      assert.equal(moved.task.threadId, null);
      assert.equal(moved.task.threadMode, "fresh_session");
      const unbound = yield* service.upsert({ ...input, threadMode: "new_thread" });
      assert.equal(unbound.task.threadId, null);
      // Clearing the thread keeps the mode, so the next run starts a thread for later runs.
      yield* service.upsert({ ...input, threadId: launched, threadMode: "continue" });
      const cleared = yield* service.upsert({
        ...input,
        threadId: null,
        unbindThread: true,
        threadMode: "continue",
      });
      assert.equal(cleared.task.threadId, null);
      assert.equal(cleared.task.threadMode, "continue");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a refused dispatch records its refusal, and opaque causes stay generic", () =>
  Effect.gen(function* () {
    const refusal = "Thread thread:refused was stopped.";
    const refused = (cause: unknown) =>
      new OrchestratorDispatchError({
        commandId: CommandId.make("command:refused"),
        commandType: "message.dispatch",
        cause,
      });
    const generic = refused(undefined).message;
    const cases = [
      [refusal, refusal],
      ["   ", generic],
      [new Error("private-nested-secret"), generic],
    ] as const;
    const failure = yield* Ref.make<unknown>(undefined);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
            sendToThread: () =>
              Ref.get(failure).pipe(Effect.flatMap((cause) => Effect.fail(refused(cause)))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:refused"),
        title: "Refused dispatch",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: ThreadId.make("thread:refused"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      for (const [cause, expected] of cases) {
        yield* Ref.set(failure, cause);
        const result = yield* service.runNow({ id: task.id });
        assert.equal(result.task.lastRunStatus, "failed");
        assert.equal(result.task.lastRunError, expected);
      }
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a first run whose thread was deleted before it bound removes the task", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread:deleted"),
                resumed: false,
              } as never),
          }),
          // Deleted before the binding landed, so its cleanup found no task to remove.
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ deletedAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z") } as never),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:thread-deleted-mid-launch"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      assert.deepEqual((yield* service.list()).tasks, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["recreated under the same id", "moved to another project"] as const)(
  "a first run never binds its thread to a task %s",
  (change) =>
    Effect.gen(function* () {
      const launching = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ManagedPolicy.layerTest(),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Deferred.succeed(launching, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as({
                    threadId: ThreadId.make("thread:old-generation"),
                    resumed: false,
                  } as never),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            NodeCrypto.layer,
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = {
          id: ScheduledTaskId.make("task:recreated-mid-launch"),
          title: "Triage",
          prompt: "Triage new issues",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          threadMode: "fresh_session",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        } as const;
        yield* service.upsert(input);
        const run = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(launching);
        if (change === "recreated under the same id") {
          yield* service.delete({ id: input.id });
          yield* TestClock.adjust("1 second");
          yield* service.upsert(input);
        } else {
          yield* service.upsert({ ...input, projectId: ProjectId.make("project:moved") });
        }
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.await(run);

        const replacement = (yield* service.list()).tasks.find((task) => task.id === input.id);
        assert.equal(replacement?.threadId, null);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses saving an enabled task above the policy ceiling", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (enabled: boolean) =>
        service.upsert({
          id: ScheduledTaskId.make("task:above-ceiling"),
          title: "Nightly",
          prompt: "Check progress",
          enabled,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const refused = yield* save(true).pipe(Effect.flip);
      assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      assert.lengthOf((yield* service.list()).tasks, 0);
      // A disabled task does not run, so it can still be saved.
      yield* save(false);
      assert.lengthOf((yield* service.list()).tasks, 1);
      // Nor can it be switched back on while its mode is above the ceiling.
      const reenabled = yield* service
        .setEnabled({ id: ScheduledTaskId.make("task:above-ceiling"), enabled: true })
        .pipe(Effect.flip);
      assert.equal(reenabled.message, "Example Corp limits threads to Auto-accept edits.");
      // A task bound to a thread runs in that thread's mode, so its own is not checked.
      const bound = {
        id: ScheduledTaskId.make("task:bound"),
        title: "Follow up",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...bound, threadId: ThreadId.make("thread:bound") });
      // Nor when an edit omits the thread it stays bound to.
      yield* service.upsert(bound);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("checks a task's destination thread only when the destination changes", () =>
  Effect.gen(function* () {
    const project = ProjectId.make("project:test");
    const otherProject = ProjectId.make("project:other");
    const destination = ThreadId.make("thread:destination");
    const archivedAt = "2026-11-05T00:00:00.000Z";
    const shells = yield* Ref.make<ReadonlyMap<ThreadId, never>>(
      new Map([
        [destination, threadShell(project)],
        [ThreadId.make("thread:archived"), threadShell(project, { archivedAt })],
        [ThreadId.make("thread:deleted"), threadShell(project, { deletedAt: archivedAt })],
        [ThreadId.make("thread:other-project"), threadShell(otherProject)],
      ]),
    );
    const consumed = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Ref.get(shells).pipe(Effect.map((all) => all.get(threadId) ?? null)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({
            consume: () => Ref.update(consumed, (count) => count + 1).pipe(Effect.as("secret")),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const id = ScheduledTaskId.make("task:destination");
      const save = (
        threadId: ThreadId,
        schedule: ScheduledTaskUpsertInput["schedule"] = { type: "interval", everyMs: 60_000 },
      ) =>
        service.upsert({
          id,
          title: "Follow up",
          prompt: "Check progress",
          enabled: true,
          schedule,
          projectId: project,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });

      for (const [threadId, message] of [
        ["thread:missing", "That thread no longer exists."],
        ["thread:deleted", "That thread no longer exists."],
        ["thread:archived", "That thread is archived. Unarchive it or pick another destination."],
        ["thread:other-project", "That thread belongs to a different project."],
      ] as const) {
        const refused = yield* save(ThreadId.make(threadId)).pipe(Effect.flip);
        assert.equal(refused.message, message);
      }
      assert.lengthOf((yield* service.list()).tasks, 0);

      // A rejected save must not burn a one-shot secret.
      yield* save(ThreadId.make("thread:missing"), {
        type: "webhook",
        signature: {
          header: "x-signature",
          encoding: "hex",
          prefix: "",
          secretRef: SecretRef.make("secret-ref:00000000000000000000000000000001"),
        },
      }).pipe(Effect.flip);
      assert.equal(yield* Ref.get(consumed), 0);

      yield* save(destination);
      // A task whose thread was archived later stays editable.
      yield* Ref.update(shells, (all) =>
        new Map(all).set(destination, threadShell(project, { archivedAt })),
      );
      assert.equal((yield* save(destination)).task.threadId, destination);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run interrupted right after it reserves the task does not block the next run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:interrupted-reservation"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // The reservation is the first Set.add of the task id; interrupt the run right there.
      const add = Set.prototype.add;
      let interrupted = false;
      const first = yield* Effect.gen(function* () {
        using _reserve = vi.spyOn(Set.prototype, "add").mockImplementation(function (
          this: Set<unknown>,
          value: unknown,
        ) {
          const result = add.call(this, value);
          if (value === task.id && !interrupted) {
            interrupted = true;
            Fiber.getCurrent()?.interruptUnsafe();
          }
          return result;
        });
        return yield* service
          .runNow({ id: task.id })
          .pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      });
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(first));

      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:launched"));
      assert.equal(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run whose stored model is outside the allowed list fails instead of starting", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const codex = (instanceId: string, status: "ready" | "error"): ServerProvider => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-09-13T00:00:00.000Z",
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    const run = (autoRoutingAllowed: ReadonlyArray<string>) => {
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ManagedPolicy.layerTest(),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Ref.update(launches, (n) => n + 1).pipe(
                  Effect.as({ threadId: ThreadId.make("thread:routed"), resumed: false } as never),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            // The stored account is ready; the only allowed one is down.
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([codex("codex", "ready"), codex("codex_team", "error")]),
            }),
            ServerSettings.layerTest({ autoRoutingAllowed: [...autoRoutingAllowed] }),
            NodeCrypto.layer,
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const id = ScheduledTaskId.make(`task:allowlist:${autoRoutingAllowed.join(",")}`);
        yield* service.upsert({
          id,
          title: "Nightly",
          prompt: "Check the contact forms",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        return yield* service.runNow({ id });
      }).pipe(Effect.provide(layer));
    };

    const refused = yield* run(["codex_team"]);
    assert.equal(yield* Ref.get(launches), 0);
    assert.isNull(refused.threadId);
    assert.equal(refused.task.lastRunStatus, "failed");
    assert.include(refused.task.lastRunError ?? "", "Not started");
    assert.include(refused.task.lastRunError ?? "", "codex_team");

    // An allowed list that names no configured account refuses the run the same way.
    const unmatched = yield* run(["claudeAgent"]);
    assert.equal(yield* Ref.get(launches), 0);
    assert.equal(unmatched.task.lastRunStatus, "failed");
    assert.include(unmatched.task.lastRunError ?? "", "match no configured");

    // Without a list the stored model runs as before.
    const unrestricted = yield* run([]);
    assert.equal(yield* Ref.get(launches), 1);
    assert.equal(unrestricted.task.lastRunStatus, "succeeded");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

describe("per-task model routing", () => {
  const account = (
    instanceId: string,
    driver: "codex" | "claudeAgent",
    usedPercent: number,
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      driver === "codex"
        ? [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }]
        : [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-09-13T00:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  });
  const stored = { instanceId: ProviderInstanceId.make("claude_a"), model: "claude-opus-5-5" };
  const routing = { candidates: ["claude_a", "claude_b", "codex"], minUsageLeftPercent: 20 };

  /** A fresh service over the test's database, as after a restart. */
  const serviceLayer = (
    providers: Ref.Ref<ReadonlyArray<ServerProvider>>,
    launched: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>,
    autoRoutingAllowed: ReadonlyArray<string> = [],
  ) =>
    ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Ref.update(launched, (all) => [...all, input]).pipe(
                Effect.as({ threadId: ThreadId.make("thread:routed"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Ref.get(providers) }),
          ServerSettings.layerTest({
            autoRoutingAllowed: [...autoRoutingAllowed],
            // Named instances run only when configured, as on a real server.
            providerInstances: {
              claude_a: { driver: "claudeAgent", enabled: true, config: {} },
              claude_b: { driver: "claudeAgent", enabled: true, config: {} },
            },
          } as never),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
  const taskInput = (patch: Partial<ScheduledTaskUpsertInput> = {}): ScheduledTaskUpsertInput => ({
    id: ScheduledTaskId.make("task:routing"),
    title: "Morning routine",
    prompt: "Summarise the inbox",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project:test"),
    workspaceStrategy: { type: "root" },
    modelSelection: stored,
    runtimeMode: "full-access",
    interactionMode: "default",
    ...patch,
  });
  const lastLaunch = (launched: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>) =>
    Ref.get(launched).pipe(Effect.map((all) => all.at(-1)?.modelSelection.instanceId));

  it.effect("starts each run on the first listed account with enough usage left", () =>
    Effect.gen(function* () {
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        account("claude_a", "claudeAgent", 85),
        account("claude_b", "claudeAgent", 30),
        account("codex", "codex", 0),
      ]);
      const launched = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(taskInput({ modelRouting: routing }));
        assert.deepEqual(task.modelRouting, routing);

        // claude_a has 15% left, below the threshold: the run goes to claude_b, the next one.
        yield* service.runNow({ id: task.id });
        assert.equal(yield* lastLaunch(launched), "claude_b");

        // claude_b drops below too; codex is next in the list.
        yield* Ref.update(providers, (all) =>
          all.map((entry) =>
            entry.instanceId === "claude_b" ? account("claude_b", "claudeAgent", 90) : entry,
          ),
        );
        yield* service.runNow({ id: task.id });
        assert.equal(yield* lastLaunch(launched), "codex");

        // Every account below the threshold: the one with the most left runs instead of none.
        yield* Ref.set(providers, [
          account("claude_a", "claudeAgent", 95),
          account("claude_b", "claudeAgent", 85),
          account("codex", "codex", 90),
        ]);
        const fallback = yield* service.runNow({ id: task.id });
        assert.equal(yield* lastLaunch(launched), "claude_b");
        assert.equal(fallback.task.lastRunStatus, "succeeded");
      }).pipe(Effect.provide(serviceLayer(providers, launched)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("never routes outside the global allowed list", () =>
    Effect.gen(function* () {
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        account("claude_a", "claudeAgent", 0),
        account("claude_b", "claudeAgent", 50),
        account("codex", "codex", 0),
      ]);
      const launched = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        // codex comes first, but the setting allows only Claude accounts.
        const { task } = yield* service.upsert(
          taskInput({ modelRouting: { candidates: ["codex", "claude_b", "claude_a"] } }),
        );
        yield* service.runNow({ id: task.id });
        assert.equal(yield* lastLaunch(launched), "claude_b");
      }).pipe(Effect.provide(serviceLayer(providers, launched, ["driver:claudeAgent"])));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "keeps the routing across replayed and older saves and a restart, and clears it on null",
    () =>
      Effect.gen(function* () {
        const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
          account("claude_a", "claudeAgent", 90),
          account("claude_b", "claudeAgent", 10),
          account("codex", "codex", 0),
        ]);
        const launched = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
        const commandId = CommandId.make("cmd:routing-create");
        const created = yield* Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const first = yield* service.upsert(
            taskInput({ id: undefined, commandId, modelRouting: routing }),
          );
          // The same create replayed, and an edit from a client that does not know the field.
          const replayed = yield* service.upsert(
            taskInput({ id: undefined, commandId, modelRouting: routing }),
          );
          assert.equal(replayed.task.id, first.task.id);
          const older = yield* service.upsert(taskInput({ id: first.task.id, title: "Renamed" }));
          assert.deepEqual(older.task.modelRouting, routing);
          return first.task;
        }).pipe(Effect.provide(serviceLayer(providers, launched)));

        // Stored beside the model selection, which still decodes as a plain one.
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          model_selection_json: string;
        }>`SELECT model_selection_json FROM scheduled_tasks WHERE task_id = ${created.id}`;
        assert.deepEqual(yield* decodeStoredModelSelection(row?.model_selection_json), stored);

        yield* Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const { tasks } = yield* service.list();
          assert.deepEqual(tasks.find((task) => task.id === created.id)?.modelRouting, routing);
          yield* service.runNow({ id: created.id });
          assert.equal(yield* lastLaunch(launched), "claude_b");

          const cleared = yield* service.upsert(taskInput({ id: created.id, modelRouting: null }));
          assert.isUndefined(cleared.task.modelRouting);
          yield* service.runNow({ id: created.id });
          assert.equal(yield* lastLaunch(launched), "claude_a");
        }).pipe(Effect.provide(serviceLayer(providers, launched)));
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
