"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { ScheduleAdmission } = require("../app/src/core/schedule-admission.cjs");
const { WorktreeAdmission } = require("../app/src/core/worktree-admission.cjs");
const { manageTaskDraft } = require("../app/src/core/task-draft.cjs");
const { manageTask } = require("../app/src/core/tasks.cjs");
const { CoreBackend } = require("../app/src/core/backend.cjs");

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
        home,
        saved: [saved],
        projects: new Map([[id, project]]),
        projectless: {
            records: { [allocationId]: { root, ...(!independent ? { existing: true } : {}) } },
        },
        providers: { lastAcceptedModel: null },
        resources: { beforeCreate: async () => {} },
        awaitingResponses: new WeakSet(),
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
                const run = tasks
                    .get(params.taskId)
                    ?.runs.find((value) => value.id === params.runId);
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
            value = { ...params, id: randomUUID(), revision: 1, cancelled: false, runs: [] };
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
        before = f.calls.filter(
            (call) => !call.read && call.method === "areal/thread/start",
        ).length;
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
    const task = {
        id: "legacy",
        mode: "scheduled",
        threadId: proposal.threadId,
        runs: [{ id: "run" }],
    };
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
    for (const operation of [
        "taskRunNow",
        "taskResume",
        "taskResumeRun",
        "taskReply",
        "taskUpdate",
    ])
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
    const execute = (name, request) =>
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
