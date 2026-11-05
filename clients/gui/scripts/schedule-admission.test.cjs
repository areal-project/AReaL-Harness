"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { ScheduleAdmission } = require("@areal/workbench-service/desktop/core/schedule-admission.cjs");
const { WorktreeAdmission } = require("@areal/workbench-service/desktop/core/worktree-admission.cjs");
const { manageTaskDraft } = require("@areal/workbench-service/desktop/core/task-draft.cjs");
const { manageTask } = require("@areal/workbench-service/desktop/core/tasks.cjs");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { ProjectConnections } = require("@areal/workbench-service/desktop/core/project-connections.cjs");

const taskSnapshot = (value) => ({
  revision: 1,
  channelSequence: 0,
  owner: "desktop-owner",
  interactionMode: "interactive",
  objective: "Scheduled report",
  paused: false,
  cancelled: false,
  runCount: 0,
  archivedRunCount: 0,
  runsComplete: true,
  pendingQuestions: 0,
  runs: [],
  ...value,
});

async function fixture(t, { independent = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "areal-schedule-owner-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "execution"),
    home = join(base, "desktop");
  await mkdir(root);
  await mkdir(home);
  const allocationId = randomUUID(),
    id = createHash("sha256").update(root).digest("hex").slice(0, 24),
    threads = new Map(),
    tasks = new Map(),
    receipts = new Map(),
    interactions = new Map(),
    callbacks = new Map(),
    calls = [];
  const saved = { id, root, projectless: true, projectlessRequestId: allocationId };
  const project = {
    ...saved,
    pending: [],
    outcomes: {},
    configurations: {},
    models: [],
    model: {
      state: { threads: {}, tasks: {}, interactions: {} },
      setTask(task) {
        this.state.tasks[task.id] = task;
      },
      setInteractions(threadId, value) {
        this.state.interactions[threadId] = structuredClone(value);
      },
    },
  };
  const backend = {
    dispatchCommand: CoreBackend.prototype.dispatchCommand,
    requireConnection: CoreBackend.prototype.requireConnection,
    home,
    saved: [saved],
    projects: new Map([[id, project]]),
    projectless: {
      records: { [allocationId]: { root, ...(!independent ? { existing: true } : {}) } },
    },
    providers: { lastAcceptedModel: null, catalog: (models) => models },
    resources: { beforeCreate: async () => {} },
    awaitingResponses: new Set(),
    async save(name, value) {
      const file = join(home, name);
      await mkdir(dirname(file), { recursive: true });
      const temporary = file + "." + randomUUID();
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, file);
    },
    async changeOutcomes(p, change) {
      p.outcomes = change(p.outcomes);
    },
    async changePending(p, change) {
      p.pending = change(p.pending);
    },
    async refreshAfterAdmission() {},
    async start() {
      return project;
    },
    snapshot() {
      return { projects: [project.id] };
    },
    async ensureBrowserTools() {},
    async configureThread(p, threadId, patch) {
      const thread = threads.get(threadId);
      thread.desktop.configuration = {
        ...thread.desktop.configuration,
        options: { ...thread.desktop.configuration.options, ...patch.options },
      };
      p.configurations[threadId] = thread.desktop.configuration;
    },
    textInput: (text) => [{ type: "text", text }],
  };
  project.client = {
    ready: true,
    capabilities: {
      methods: ["areal/task/update", "areal/task/runNow", "areal/turn/submit"],
      features: { ordinaryTurnSubmit: true },
    },
    async request(method, params) {
      calls.push({ method, params, read: true });
      if (method === "thread/read") {
        const thread = threads.get(params.threadId);
        if (!thread) throw new Error("missing thread");
        return { thread };
      }
      if (method === "areal/request/read")
        return {
          data: receipts.has(params.requestId) ? [receipts.get(params.requestId)] : [],
        };
      if (method === "areal/task/list")
        return {
          data: [...tasks.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((task) => ({ cancelled: false, ...task })),
          nextCursor: null,
        };
      if (method === "areal/task/read") {
        const task = tasks.get(params.taskId);
        if (!task) throw new Error("missing task");
        return task;
      }
      if (method === "areal/task/run/read") {
        const run = tasks.get(params.taskId)?.runs.find((value) => value.id === params.runId);
        if (!run) throw new Error("missing run");
        return run;
      }
      if (method === "areal/interaction/list")
        return { revision: 1, data: interactions.get(params.threadId) ?? [] };
      if (method === "areal/interaction/respond") {
        const interaction = interactions
          .get(params.threadId)
          ?.find((value) => value.requestId === params.requestId);
        assert.equal(interaction?.status, "pending");
        assert.equal(params.turnId, interaction.turnId);
        const worker = [...tasks.values()]
          .flatMap((task) => task.runs ?? [])
          .flatMap((run) => run.workers ?? [])
          .find((value) => value.threadId === params.threadId && !value.settled);
        assert.equal(
          threads.get(params.threadId)?.goals?.goal.activeTurnId ?? worker?.turnId,
          params.turnId,
        );
        interaction.status = "answered";
        callbacks.get(params.requestId)?.(structuredClone(params));
        return {};
      }
      if (method === "areal/task/schedule/context")
        return { timeZone: "Etc/UTC", localDate: "2026-10-23", localTime: "12:00:00" };
      if (method === "areal/task/schedule/preview") return { data: [] };
      if (method === "areal/server/status")
        return {
          acceptingWork: true,
          activeTurns: [],
          resources: [],
          unresolvedTools: [],
          activeGoals: [],
          compactions: [],
          workgroups: [],
          activeTasks: 0,
          pendingQueueItems: 0,
        };
      throw new Error("unexpected " + method);
    },
  };
  backend.submit = async (p, method, params, { requestId }) => {
    if (receipts.has(requestId)) return receipts.get(requestId).result;
    calls.push({ method, params, read: false });
    let value;
    if (method === "areal/thread/start") {
      const tid = randomUUID(),
        thread = {
          id: tid,
          sessionId: tid,
          cwd: params.cwd,
          turns: [],
          desktop: { configuration: { revision: 1, options: {} } },
        };
      threads.set(tid, thread);
      p.model.state.threads[tid] = thread;
      value = { thread };
    } else if (method === "areal/turn/start") {
      const thread = threads.get(params.threadId),
        turn = {
          id: randomUUID(),
          status: "completed",
          items: [
            { id: randomUUID(), type: "userMessage", content: params.input },
            {
              id: randomUUID(),
              type: "agentMessage",
              text: JSON.stringify({
                kind: "proposal",
                message: "安排已整理",
                objective: "write an independent report",
                scheduleV2: {
                  version: 1,
                  rule: {
                    kind: "calendar",
                    timeZone: "Etc/UTC",
                    frequency: "daily",
                    interval: 1,
                    localTime: "13:00",
                    anchorDate: "2026-10-23",
                  },
                },
              }),
            },
          ],
        };
      thread.turns.push(turn);
      value = { turn };
    } else if (method === "areal/task/create") {
      value = taskSnapshot({ ...params, id: randomUUID() });
      tasks.set(value.id, value);
    } else {
      value = tasks.get(params.taskId);
      if (!value) throw new Error("missing task");
    }
    receipts.set(requestId, {
      requestId,
      method,
      result: value,
      ...(method === "areal/task/create" ? { taskId: value.id } : {}),
    });
    return value;
  };
  backend.connections = new ProjectConnections(backend);
  backend.worktreeAdmission = new WorktreeAdmission(backend);
  backend.scheduleAdmission = new ScheduleAdmission(backend);
  return {
    backend,
    project,
    threads,
    tasks,
    receipts,
    interactions,
    callbacks,
    calls,
    root,
    home,
  };
}
async function draft(f) {
  const started = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftStart",
    draftId: randomUUID(),
    timeZone: "Etc/UTC",
  });
  await f.backend.worktreeAdmission.admit(f.project, "manage", {
    operation: "taskDraftSend",
    threadId: started.threadId,
  });
  const sent = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftSend",
    threadId: started.threadId,
    requestId: randomUUID(),
    timeZone: "Etc/UTC",
    text: "每天13点生成独立报告",
  });
  const proposal = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftRead",
    threadId: started.threadId,
  });
  return { threadId: started.threadId, turnId: sent.turnId, digest: proposal.digest };
}

test("auto projectless TaskDraftStart, readonly send and automatic confirm retain the supported scheduling journey", async (t) => {
  const f = await fixture(t),
    proposal = await draft(f);
  assert.equal(
    await f.backend.scheduleAdmission.read(f.project),
    null,
    "management discussion reserves no writer",
  );
  const created = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftConfirm",
    ...proposal,
  });
  assert.equal(created.mode, "scheduled");
  assert.notEqual(created.threadId, proposal.threadId);
  const reservation = await f.backend.scheduleAdmission.read(f.project);
  assert.equal(reservation.taskId, created.id);
  assert.equal(reservation.anchorThreadId, created.threadId);
  assert.ok(reservation.token.startsWith("schedule:"));
  assert.equal(reservation.cwd, f.root);
  const same = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftConfirm",
    ...proposal,
  });
  assert.equal(same.id, created.id);
  assert.equal(
    f.calls.filter((call) => !call.read && call.method === "areal/task/create").length,
    1,
  );
  const restarted = new ScheduleAdmission(f.backend);
  assert.equal((await restarted.admitTask(f.project, created.id)).task.id, created.id);
});

test("normal writers and scheduled families compete in the same durable author namespace", async (t) => {
  const f = await fixture(t),
    proposal = await draft(f);
  const task = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftConfirm",
    ...proposal,
  });
  await assert.rejects(
    f.backend.worktreeAdmission.claim(f.project, "ordinary-session"),
    (error) => error.code === "WORKTREE_REQUIRED",
  );
  await assert.rejects(
    f.backend.scheduleAdmission.reserveCreate(f.project, randomUUID()),
    /另一个定时任务|另一个会话/,
  );
  assert.equal((await f.backend.scheduleAdmission.read(f.project)).taskId, task.id);
  const g = await fixture(t);
  await g.backend.worktreeAdmission.claim(g.project, "ordinary-session");
  const other = await draft(g);
  await assert.rejects(
    manageTaskDraft(g.backend, g.project, { operation: "taskDraftConfirm", ...other }),
    (error) => error.code === "WORKTREE_REQUIRED",
  );
  assert.equal(
    g.calls.filter((call) => !call.read && call.method === "areal/task/create").length,
    0,
  );
});

test("start and resume callbacks verify Task, Run, exact anchor and cwd against the reservation", async (t) => {
  const f = await fixture(t),
    proposal = await draft(f),
    task = await manageTaskDraft(f.backend, f.project, {
      operation: "taskDraftConfirm",
      ...proposal,
    });
  const run = { id: randomUUID(), threadId: randomUUID(), status: "queued" };
  task.runs.push(run);
  f.threads.set(run.threadId, { id: run.threadId, cwd: f.root });
  assert.equal(
    (
      await f.backend.scheduleAdmission.prepare(f.project, {
        taskId: task.id,
        runId: run.id,
        threadId: task.threadId,
        intent: "start",
      })
    ).task.id,
    task.id,
  );
  assert.equal(
    (
      await f.backend.scheduleAdmission.prepare(f.project, {
        taskId: task.id,
        runId: run.id,
        threadId: run.threadId,
        intent: "resume",
      })
    ).task.id,
    task.id,
  );
  await assert.rejects(
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: task.id,
      runId: run.id,
      threadId: proposal.threadId,
      intent: "resume",
    }),
    /身份不匹配/,
  );
  f.threads.get(run.threadId).cwd = dirname(f.root);
  await assert.rejects(
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: task.id,
      runId: run.id,
      threadId: run.threadId,
      intent: "resume",
    }),
    /目录已变化/,
  );
});

test("Task accepted before local bind recovers only from the original create receipt", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  await f.backend.scheduleAdmission.reserveCreate(f.project, requestId);
  const anchor = await f.backend.submit(
    f.project,
    "areal/thread/start",
    { cwd: f.root },
    { requestId: randomUUID() },
  );
  await f.backend.scheduleAdmission.setAnchor(f.project, anchor.thread.id);
  const accepted = await f.backend.submit(
    f.project,
    "areal/task/create",
    { mode: "scheduled", threadId: anchor.thread.id },
    { requestId },
  );
  accepted.runs.push({ id: "run", status: "queued" });
  const result = await new ScheduleAdmission(f.backend).prepare(f.project, {
    taskId: accepted.id,
    runId: "run",
    threadId: anchor.thread.id,
    intent: "start",
  });
  assert.equal(result.reservation.taskId, accepted.id);
  const impostor = { ...accepted, id: randomUUID() };
  f.tasks.set(impostor.id, impostor);
  await assert.rejects(
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: impostor.id,
      runId: "run",
      threadId: anchor.thread.id,
      intent: "start",
    }),
    /另一个定时任务/,
  );
});

test("existing selected directories preserve readonly planning but reject scheduled execution before the anchor prelude", async (t) => {
  const f = await fixture(t, { independent: false }),
    proposal = await draft(f),
    before = f.calls.filter((call) => !call.read && call.method === "areal/thread/start").length;
  await assert.rejects(
    manageTaskDraft(f.backend, f.project, { operation: "taskDraftConfirm", ...proposal }),
    (error) => error.code === "SCHEDULE_WORKSPACE_REQUIRED",
  );
  assert.equal(
    f.calls.filter((call) => !call.read && call.method === "areal/thread/start").length,
    before,
  );
  assert.equal(
    f.calls.filter((call) => !call.read && call.method === "areal/task/create").length,
    0,
  );
  const task = taskSnapshot({
    id: "legacy",
    revision: 1,
    mode: "scheduled",
    threadId: proposal.threadId,
    runs: [
      {
        id: "run",
        status: "queued",
        scheduledAt: 0,
        waitRequested: false,
        usage: {
          accountingComplete: true,
          cachedInputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reservedTokens: 0,
          timeUsedSeconds: 0,
          tokensUsed: 0,
          turnsStarted: 0,
          unknownRequests: 0,
        },
      },
    ],
  });
  f.tasks.set(task.id, task);
  await assert.rejects(
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: task.id,
      runId: "run",
      threadId: task.threadId,
      intent: "start",
    }),
    /没有可核对/,
  );
  await manageTask(f.backend, f.project, {
    operation: "taskPause",
    taskId: task.id,
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  await manageTask(f.backend, f.project, {
    operation: "taskCancel",
    taskId: task.id,
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  await assert.rejects(
    manageTask(f.backend, f.project, {
      operation: "taskRunNow",
      taskId: task.id,
      requestId: randomUUID(),
      expectedRevision: 1,
    }),
    /没有可核对/,
  );
});

test("public scheduled create and activation use the same reserved family without duplicate preludes", async (t) => {
  const f = await fixture(t),
    request = {
      operation: "taskCreate",
      mode: "scheduled",
      requestId: randomUUID(),
      objective: "independent report",
      schedule: { at: 1792760400, intervalSeconds: 86400 },
    };
  const created = await manageTask(f.backend, f.project, request);
  const again = await manageTask(f.backend, f.project, request);
  assert.equal(again.id, created.id);
  assert.equal(
    f.calls.filter((call) => !call.read && call.method === "areal/thread/start").length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => !call.read && call.method === "areal/task/create").length,
    1,
  );
  for (const operation of ["taskRunNow", "taskResume", "taskResumeRun", "taskReply", "taskUpdate"])
    await manageTask(f.backend, f.project, {
      operation,
      taskId: created.id,
      requestId: randomUUID(),
      expectedRevision: 1,
    });
  assert.equal((await f.backend.scheduleAdmission.read(f.project)).taskId, created.id);
  const before = f.calls.filter((call) => !call.read).length;
  await assert.rejects(
    manageTask(f.backend, f.project, { ...request, requestId: randomUUID() }),
    /另一个定时任务/,
  );
  assert.equal(f.calls.filter((call) => !call.read).length, before);
});

test("foreign receipt cannot recover a newly accepted but unbound schedule", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  await f.backend.scheduleAdmission.reserveCreate(f.project, requestId);
  const anchor = await f.backend.submit(
    f.project,
    "areal/thread/start",
    { cwd: f.root },
    { requestId: randomUUID() },
  );
  await f.backend.scheduleAdmission.setAnchor(f.project, anchor.thread.id);
  const accepted = await f.backend.submit(
    f.project,
    "areal/task/create",
    { mode: "scheduled", threadId: anchor.thread.id },
    { requestId },
  );
  accepted.runs.push({ id: "run", status: "queued" });
  f.receipts.get(requestId).result = { id: "foreign" };
  await assert.rejects(
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: accepted.id,
      runId: "run",
      threadId: anchor.thread.id,
      intent: "start",
    }),
    /创建结果尚未核对/,
  );
  assert.equal((await f.backend.scheduleAdmission.read(f.project)).taskId, undefined);
});

test("simultaneous ordinary writer and schedule reservation grant only one checkout author", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.backend.scheduleAdmission.reserveCreate(f.project, randomUUID()),
    f.backend.worktreeAdmission.claim(f.project, "ordinary-session"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const schedule = await f.backend.scheduleAdmission.read(f.project);
  if (results[0].status === "fulfilled") {
    assert.ok(schedule.token.startsWith("schedule:"));
    await assert.rejects(
      f.backend.worktreeAdmission.claim(f.project, "ordinary-session"),
      (error) => error.code === "WORKTREE_REQUIRED",
    );
  } else assert.equal(schedule, null);
});

async function executingSchedule(t) {
  const f = await fixture(t),
    proposal = await draft(f),
    task = await manageTaskDraft(f.backend, f.project, {
      operation: "taskDraftConfirm",
      ...proposal,
    });
  const run = {
    id: randomUUID(),
    threadId: randomUUID(),
    goalId: randomUUID(),
    status: "waitingForInput",
    workers: [],
  };
  task.runs.push(run);
  const turnId = randomUUID(),
    thread = {
      id: run.threadId,
      sessionId: run.threadId,
      cwd: f.root,
      source: "nativeTaskAgent",
      goals: {
        revision: 1,
        goal: {
          id: run.goalId,
          threadId: run.threadId,
          status: "active",
          activeTurnId: turnId,
        },
      },
    };
  f.threads.set(thread.id, thread);
  f.project.configurations[thread.id] = { revision: 1 };
  const interact = (kind, target = thread, targetTurnId = turnId) => {
    const requestId = randomUUID(),
      value = {
        requestId,
        threadId: target.id,
        turnId: targetTurnId,
        kind,
        status: "pending",
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        argumentsDigest: kind === "approval" ? "original-digest" : null,
        questions:
          kind === "question"
            ? [{ id: "choice", allowFreeText: false, options: ["yes", "no"] }]
            : [],
      };
    f.interactions.set(target.id, [value]);
    const resumed = new Promise((resolve) => f.callbacks.set(requestId, resolve));
    return { value, resumed };
  };
  f.backend.worktrees = { assertAvailable() {}, records: new Map() };
  const execute = async (name, request) =>
    CoreBackend.prototype.executeCommand.call(f.backend, name, {
      projectId: f.project.id,
      threadId: thread.id,
      ...request,
    });
  return { ...f, task, run, thread, turnId, interact, execute };
}

test("CoreBackend respond dispatches original scheduled approval and AskUser callbacks after restart", async (t) => {
  const f = await executingSchedule(t);
  f.backend.scheduleAdmission = new ScheduleAdmission(f.backend);
  f.backend.worktreeAdmission = new WorktreeAdmission(f.backend);
  for (const kind of ["approval", "question"]) {
    const { value, resumed } = f.interact(kind);
    await f.execute("respond", {
      requestId: value.requestId,
      ...(kind === "approval" ? { decision: "deny" } : { answers: { choice: "yes" } }),
      familyToken: "renderer-value-is-never-used",
    });
    const callback = await resumed;
    assert.equal(callback.threadId, f.thread.id);
    assert.equal(callback.turnId, f.turnId);
    assert.equal(callback.requestId, value.requestId);
    if (kind === "approval") {
      assert.equal(callback.decision, "deny");
      assert.equal(callback.argumentsDigest, "original-digest");
    } else assert.deepEqual(callback.answers, { choice: "yes" });
  }
});

test("CoreBackend rejects foreign, expired, wrong-shape, old or cancelled scheduled interactions before dispatch", async (t) => {
  const f = await executingSchedule(t),
    { value } = f.interact("approval");
  const responses = () =>
    f.calls.filter((call) => call.method === "areal/interaction/respond").length;
  const denied = async (patch = {}) => {
    const count = responses();
    await assert.rejects(
      f.execute("respond", { requestId: value.requestId, decision: "deny", ...patch }),
    );
    assert.equal(responses(), count);
  };
  await denied({ requestId: randomUUID() });
  await denied({ answers: { choice: "yes" } });
  const foreign = { ...f.thread, id: randomUUID(), sessionId: randomUUID() };
  f.threads.set(foreign.id, foreign);
  await denied({
    threadId: foreign.id,
    familyToken: (await f.backend.scheduleAdmission.read(f.project)).token,
  });
  await denied({ sourceThreadId: foreign.id });
  await denied({ threadId: f.task.threadId });
  value.expiresAt = Math.floor(Date.now() / 1000) - 1;
  await denied();
  value.expiresAt += 1000;
  value.turnId = randomUUID();
  await denied();
  value.turnId = f.turnId;
  f.task.cancelled = true;
  await denied();
  f.task.cancelled = false;
  for (const status of ["paused", "blocked", "completed", "failed", "cancelled"]) {
    f.run.status = status;
    await denied();
  }
  f.run.status = "running";
  f.task.runs.push({ ...f.run, id: randomUUID(), threadId: randomUUID(), goalId: randomUUID() });
  await denied();
  f.run.status = "completed";
  await denied();
});

test("mapped continue reaches existing Core ordinary ownership guard; stale turn and other writes stay rejected", async (t) => {
  const f = await executingSchedule(t),
    originalSubmit = f.backend.submit;
  let dispatched = 0;
  f.backend.submit = async (project, method, params, options) => {
    if (method !== "areal/turn/submit") return originalSubmit(project, method, params, options);
    dispatched++;
    assert.equal(params.threadId, f.thread.id);
    assert.equal(params.intent.type, "continue");
    assert.equal(params.intent.expectedTurnId, f.turnId);
    throw Object.assign(new Error("native Task ownership rejects ordinary continue"), {
      code: "CORE_ORDINARY_OWNERSHIP",
    });
  };
  await assert.rejects(
    f.execute("continue", { expectedTurnId: f.turnId, requestId: randomUUID() }),
    (error) => error.code === "CORE_ORDINARY_OWNERSHIP",
  );
  assert.equal(dispatched, 1);
  await assert.rejects(f.execute("continue", { expectedTurnId: "old", requestId: randomUUID() }));
  await assert.rejects(f.execute("send", { text: "new work", requestId: randomUUID() }));
  assert.equal(dispatched, 1);
});

test("registered native and inherited-session workers map only their exact unsettled Run turn and lineage", async (t) => {
  const f = await executingSchedule(t);
  for (const inherited of [false, true]) {
    const worker = {
      id: randomUUID(),
      cwd: f.root,
      source: "nativeTaskAgent",
      goalOwner: { threadId: f.thread.id, goalId: f.run.goalId },
    };
    worker.sessionId = inherited ? f.thread.sessionId : worker.id;
    if (inherited) worker.parentThreadId = f.thread.id;
    const turnId = randomUUID(),
      registration = {
        threadId: worker.id,
        turnId,
        settled: false,
        status: "running",
        execution: { kind: "thread", threadId: worker.id, turnId },
      };
    f.run.workers.push(registration);
    f.threads.set(worker.id, worker);
    const verify = async () => {
      const { value } = f.interact("approval", worker, turnId);
      return f.backend.scheduleAdmission.authorForSession(f.project, {
        name: "respond",
        request: { threadId: worker.id, requestId: value.requestId, decision: "deny" },
        threads: [worker],
        sessionId: worker.sessionId,
      });
    };
    assert.equal(await verify(), (await f.backend.scheduleAdmission.read(f.project)).token);
    const { value, resumed } = f.interact("approval", worker, turnId);
    await f.execute("respond", {
      threadId: worker.id,
      requestId: value.requestId,
      decision: "deny",
    });
    assert.equal((await resumed).threadId, worker.id);
    registration.settled = true;
    await assert.rejects(verify());
    registration.settled = false;
    worker.goalOwner.goalId = "foreign";
    await assert.rejects(verify());
    worker.goalOwner.goalId = f.run.goalId;
    worker.cwd = dirname(f.root);
    await assert.rejects(verify());
    worker.cwd = f.root;
    if (inherited) {
      const parent = {
        ...worker,
        id: randomUUID(),
        parentThreadId: f.thread.id,
      };
      f.threads.set(parent.id, parent);
      worker.parentThreadId = parent.id;
      assert.equal(await verify(), (await f.backend.scheduleAdmission.read(f.project)).token);
      parent.goalOwner = { ...parent.goalOwner, goalId: "foreign" };
      await assert.rejects(verify());
      worker.parentThreadId = worker.id;
      await assert.rejects(verify());
    }
  }
});

test("scheduled prepare rejects cancelled Tasks and stale or terminal Runs, retaining dedicated resume", async (t) => {
  const f = await executingSchedule(t),
    prepare = () =>
      f.backend.scheduleAdmission.prepare(f.project, {
        taskId: f.task.id,
        runId: f.run.id,
        threadId: f.thread.id,
        intent: "resume",
      });
  f.run.status = "paused";
  f.run.reason = "resumeRequested";
  assert.equal((await prepare()).task.id, f.task.id);
  f.task.cancelled = true;
  await assert.rejects(prepare());
  f.task.cancelled = false;
  f.run.status = "completed";
  await assert.rejects(prepare());
  f.run.status = "paused";
  f.task.runs.push({ ...f.run, id: randomUUID(), status: "queued" });
  await assert.rejects(prepare());
});

async function sourceSchedule(t) {
  const f = await fixture(t, { independent: false });
  f.backend.saved[0].projectless = false;
  const source = { id: randomUUID(), cwd: f.root, desktop: { configuration: { readOnly: false } } };
  source.sessionId = source.id;
  const anchor = { id: randomUUID(), cwd: f.root };
  anchor.sessionId = anchor.id;
  f.threads.set(source.id, source);
  f.threads.set(anchor.id, anchor);
  const task = {
    id: randomUUID(),
    owner: "desktop-owner",
    mode: "scheduled",
    cancelled: false,
    sourceThreadId: source.id,
    threadId: anchor.id,
    runs: [{ id: randomUUID(), status: "queued", workers: [] }],
  };
  f.tasks.set(task.id, task);
  return { ...f, source, anchor, task, run: task.runs[0] };
}

test("ordinary source schedules share the selected directory across sources and restart without legacy reservations", async (t) => {
  const f = await sourceSchedule(t);
  const otherSource = { ...f.source, id: randomUUID() };
  otherSource.sessionId = otherSource.id;
  f.threads.set(otherSource.id, otherSource);
  for (const source of [f.source, otherSource]) {
    const anchor = { ...f.anchor, id: randomUUID() };
    anchor.sessionId = anchor.id;
    f.threads.set(anchor.id, anchor);
    const task = {
      ...f.task,
      id: randomUUID(),
      sourceThreadId: source.id,
      threadId: anchor.id,
      runs: [{ id: randomUUID(), status: "queued", workers: [] }],
    };
    f.tasks.set(task.id, task);
  }
  for (const task of f.tasks.values()) {
    assert.equal(
      (
        await f.backend.scheduleAdmission.prepare(f.project, {
          taskId: task.id,
          runId: task.runs[0].id,
          threadId: task.threadId,
          intent: "start",
        })
      ).task.id,
      task.id,
    );
  }
  f.backend.scheduleAdmission = new ScheduleAdmission(f.backend);
  f.backend.worktreeAdmission = new WorktreeAdmission(f.backend);
  for (const source of [f.source, otherSource])
    await f.backend.worktreeAdmission.admit(f.project, "send", { threadId: source.id });
  assert.equal(await f.backend.scheduleAdmission.read(f.project), null);
  await assert.rejects(readFile(join(f.home, "workspace-authors")), { code: "ENOENT" });
  assert.equal(f.calls.filter((call) => !call.read).length, 0);
});

test("shared source schedules reject foreign owner, source, cwd and incomplete authoritative identity", async (t) => {
  const f = await sourceSchedule(t);
  const prepare = () =>
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: f.task.id,
      runId: f.run.id,
      threadId: f.anchor.id,
      intent: "start",
    });
  const changes = [
    [f.task, "owner", "foreign-host"],
    [f.task, "sourceThreadId", f.anchor.id],
    [f.source, "id", "foreign-source"],
    [f.source, "parentThreadId", "foreign-parent"],
    [f.source, "goalOwner", { threadId: "foreign", goalId: "foreign" }],
    [f.source, "conversation", { kind: "side" }],
    [f.source, "source", "nativeTaskAgent"],
    [f.source, "sessionId", null],
    [f.source, "cwd", dirname(f.root)],
    [f.anchor, "cwd", dirname(f.root)],
    [f.project.client, "ready", false],
  ];
  for (const [target, key, value] of changes) {
    const old = target[key];
    target[key] = value;
    await assert.rejects(prepare());
    if (old === undefined) delete target[key];
    else target[key] = old;
  }
  await prepare();
  assert.equal(f.calls.filter((call) => !call.read).length, 0);
});

test("shared schedule preparation verifies the full current Run and original callback identity", async (t) => {
  const f = await sourceSchedule(t),
    request = f.project.client.request;
  const prepare = (patch = {}) =>
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: f.task.id,
      runId: f.run.id,
      threadId: f.anchor.id,
      intent: "start",
      ...patch,
    });
  await prepare();
  for (const patch of [
    { id: "foreign-run" },
    { status: "completed" },
    { reason: "stopRequested" },
  ]) {
    f.project.client.request = (method, params) =>
      method === "areal/task/run/read" ? { ...f.run, ...patch } : request(method, params);
    await assert.rejects(prepare());
  }
  f.project.client.request = request;
  await assert.rejects(prepare({ threadId: f.source.id }));
  await assert.rejects(prepare({ runId: "foreign-run" }));
  const execution = { id: randomUUID(), sessionId: randomUUID(), cwd: f.root };
  f.threads.set(execution.id, execution);
  Object.assign(f.run, { threadId: execution.id, status: "paused", goalId: randomUUID() });
  await prepare({ threadId: execution.id, intent: "resume" });
  await assert.rejects(prepare({ threadId: f.anchor.id, intent: "resume" }));
  execution.cwd = dirname(f.root);
  await assert.rejects(prepare({ threadId: execution.id, intent: "resume" }));
});

test("legacy schedule claims keep the same and overlapping physical directories exclusive from shared schedules", async (t) => {
  for (const nested of [false, true]) {
    const f = await sourceSchedule(t);
    f.tasks.clear();
    await f.backend.worktreeAdmission.claim(f.project, "schedule:" + "e".repeat(64));
    if (nested) {
      const child = join(f.root, "child");
      await mkdir(child);
      f.project.root = child;
      f.backend.saved[0].root = child;
      f.source.cwd = child;
      f.anchor.cwd = child;
    }
    f.tasks.set(f.task.id, f.task);
    await assert.rejects(
      f.backend.scheduleAdmission.prepare(f.project, {
        taskId: f.task.id,
        runId: f.run.id,
        threadId: f.anchor.id,
        intent: "start",
      }),
    );
    await assert.rejects(
      f.backend.worktreeAdmission.admit(f.project, "send", { threadId: f.source.id }),
    );
  }
});

test("shared schedule reads fail closed without writing or replaying after an unknown response", async (t) => {
  const f = await sourceSchedule(t),
    request = f.project.client.request;
  for (const failed of [
    "areal/task/read",
    "areal/task/run/read",
    "thread/read",
    "areal/task/list",
  ]) {
    f.project.client.request = async (method, params) => {
      if (method === failed)
        throw Object.assign(new Error("read interrupted"), { code: "RESPONSE_UNKNOWN" });
      return request(method, params);
    };
    await assert.rejects(
      f.backend.scheduleAdmission.prepare(f.project, {
        taskId: f.task.id,
        runId: f.run.id,
        threadId: f.anchor.id,
        intent: "start",
      }),
    );
  }
  f.project.client.request = request;
  await prepareSource(f);
  assert.equal(f.calls.filter((call) => !call.read).length, 0);
});

async function prepareSource(f) {
  return f.backend.scheduleAdmission.prepare(f.project, {
    taskId: f.task.id,
    runId: f.run.id,
    threadId: f.anchor.id,
    intent: "start",
  });
}

test("shared schedule continuation verifies its current Run and rejects stale turns without taking an exclusive author", async (t) => {
  const f = await sourceSchedule(t);
  const execution = {
    id: randomUUID(),
    cwd: f.root,
    goals: {
      revision: 1,
      goal: {
        id: randomUUID(),
        status: "active",
        activeTurnId: randomUUID(),
      },
    },
  };
  execution.sessionId = execution.id;
  execution.goals.goal.threadId = execution.id;
  f.threads.set(execution.id, execution);
  Object.assign(f.run, {
    threadId: execution.id,
    goalId: execution.goals.goal.id,
    status: "running",
  });
  await f.backend.worktreeAdmission.admit(f.project, "continue", {
    threadId: execution.id,
    expectedTurnId: execution.goals.goal.activeTurnId,
  });
  await assert.rejects(
    f.backend.worktreeAdmission.admit(f.project, "continue", {
      threadId: execution.id,
      expectedTurnId: "old-turn",
    }),
  );
  f.run.status = "completed";
  await assert.rejects(
    f.backend.worktreeAdmission.admit(f.project, "continue", {
      threadId: execution.id,
      expectedTurnId: execution.goals.goal.activeTurnId,
    }),
  );
  assert.equal(await f.backend.scheduleAdmission.read(f.project), null);
});

test("legacy family reservations are not reclassified by a source-linked schedule in the same project", async (t) => {
  const f = await fixture(t),
    proposal = await draft(f);
  const legacy = await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftConfirm",
    ...proposal,
  });
  const source = { id: randomUUID(), cwd: f.root, desktop: { configuration: { readOnly: false } } };
  source.sessionId = source.id;
  const anchor = { id: randomUUID(), cwd: f.root };
  anchor.sessionId = anchor.id;
  f.threads.set(source.id, source);
  f.threads.set(anchor.id, anchor);
  const task = {
    id: randomUUID(),
    mode: "scheduled",
    owner: "desktop-owner",
    cancelled: false,
    sourceThreadId: source.id,
    threadId: anchor.id,
    runs: [{ id: randomUUID(), status: "queued" }],
  };
  f.tasks.set(task.id, task);
  await assert.rejects(
    f.backend.scheduleAdmission.prepare(f.project, {
      taskId: task.id,
      runId: task.runs[0].id,
      threadId: anchor.id,
      intent: "start",
    }),
  );
  assert.equal((await f.backend.scheduleAdmission.read(f.project)).taskId, legacy.id);
});

test("shared schedule approval replies retain exact pending interaction and worker ownership checks", async (t) => {
  const f = await sourceSchedule(t);
  const execution = {
    id: randomUUID(),
    cwd: f.root,
    goals: {
      revision: 1,
      goal: {
        id: randomUUID(),
        status: "active",
        activeTurnId: randomUUID(),
      },
    },
  };
  execution.sessionId = execution.id;
  execution.goals.goal.threadId = execution.id;
  f.threads.set(execution.id, execution);
  Object.assign(f.run, {
    threadId: execution.id,
    goalId: execution.goals.goal.id,
    status: "waitingForInput",
  });
  const worker = {
    id: randomUUID(),
    cwd: f.root,
    source: "nativeTaskAgent",
    goalOwner: { threadId: execution.id, goalId: f.run.goalId },
  };
  worker.sessionId = worker.id;
  f.threads.set(worker.id, worker);
  const registration = {
    threadId: worker.id,
    turnId: randomUUID(),
    status: "waitingForInput",
    settled: false,
  };
  f.run.workers.push(registration);
  const interaction = {
    requestId: randomUUID(),
    threadId: worker.id,
    turnId: registration.turnId,
    status: "pending",
    kind: "approval",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  f.interactions.set(worker.id, [interaction]);
  const respond = () =>
    f.backend.worktreeAdmission.admit(f.project, "respond", {
      threadId: worker.id,
      requestId: interaction.requestId,
      decision: "deny",
    });
  await respond();
  registration.settled = true;
  await assert.rejects(respond());
  registration.settled = false;
  interaction.turnId = "foreign-turn";
  await assert.rejects(respond());
  interaction.turnId = registration.turnId;
  worker.goalOwner.goalId = "foreign-goal";
  await assert.rejects(respond());
});

test("legacy TaskDraft retains its remembered subscription model while discovery is pending", async (t) => {
  const f = await fixture(t);
  const { AppProviders } = require("@areal/workbench-service/desktop/core/providers.cjs");
  f.backend.host = { sourceId: "fixture", resolve: () => ({ sourceId: "fixture" }) };
  const providers = new AppProviders(f.backend, {});
  providers.config.value = { data: [], revision: "fixture" };
  providers.subscription = {
    ...providers.subscription,
    authenticated: true,
    availability: "checking",
  };
  providers.lastAcceptedModel = {
    model: { providerId: "areal_openai", modelId: "remembered" },
    modelId: "remembered",
    reasoningEffort: "high",
    acceptedAt: 1,
  };
  let prepared = false;
  providers.ensureSubscription = async () => {
    prepared = true;
  };
  f.backend.providers = providers;
  f.project.models = [
    { providerId: "local", modelId: "other", providerRevision: 1, isDefault: true },
  ];
  const submit = f.backend.submit;
  f.backend.submit = (...args) => {
    if (args[1] === "areal/thread/start") assert.equal(prepared, true);
    return submit(...args);
  };
  await manageTaskDraft(f.backend, f.project, {
    operation: "taskDraftStart",
    draftId: randomUUID(),
    timeZone: "Etc/UTC",
  });
  const start = f.calls.find((call) => call.method === "areal/thread/start");
  assert.deepEqual(start.params.model, { providerId: "areal_openai", modelId: "remembered" });
  assert.equal(start.params.parameters.reasoningEffort, "high");
});
