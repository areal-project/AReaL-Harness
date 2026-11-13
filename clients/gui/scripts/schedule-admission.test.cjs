"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rename, rm, realpath } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const {
  ScheduleAdmission,
} = require("@areal/workbench-service/desktop/core/schedule-admission.cjs");
const {
  WorktreeAdmission,
} = require("@areal/workbench-service/desktop/core/worktree-admission.cjs");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const {
  ProjectConnections,
} = require("@areal/workbench-service/desktop/core/project-connections.cjs");

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
