"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, readdir, readFile, writeFile, realpath } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { WorktreeAdmission } = require("../app/src/core/worktree-admission.cjs");
const { checkoutRoot } = require("../packages/workspace-git");
const { ScheduleAdmission } = require("../app/src/core/schedule-admission.cjs");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const git = (root, ...args) => exec("git", ["-C", root, ...args]);
async function repository(root) {
    await git(root, "init", "--initial-branch=main");
    await git(
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
    );
}

const idle = () => ({
    acceptingWork: true,
    activeTurns: [],
    resources: [],
    unresolvedTools: [],
    activeGoals: [],
    compactions: [],
    workgroups: [],
    activeTasks: 0,
    pendingQueueItems: 0,
});
async function fixture(t, status = idle()) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "areal-author-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, "repo");
    await mkdir(root);
    const threads = {
        first: { id: "first", sessionId: "first", parentThreadId: null },
        second: { id: "second", sessionId: "second", parentThreadId: null },
        fork: {
            id: "fork",
            sessionId: "fork",
            parentThreadId: null,
            conversation: { kind: "fork" },
        },
        child: { id: "child", sessionId: "first", parentThreadId: "first" },
        side: {
            id: "side",
            sessionId: "side",
            parentThreadId: null,
            conversation: { kind: "side" },
        },
    };
    const reads = [],
        dispatched = [],
        backend = { home: join(directory, "desktop") };
    const project = {
        id: "physical",
        root,
        client: {
            ready: true,
            request: async (method, params) => {
                reads.push({ method, params });
                if (method === "areal/server/status") return structuredClone(status);
                if (method === "areal/task/list") return { data: [], nextCursor: null };
                if (method === "thread/read") return { thread: threads[params.threadId] };
                assert.fail("unexpected read " + method);
            },
        },
    };
    let gate = new WorktreeAdmission(backend);
    const run = async (name, request) => {
        await gate.admit(project, name, { projectId: project.id, ...request });
        dispatched.push({ name, ...request });
    };
    return {
        backend,
        project,
        root,
        threads,
        reads,
        dispatched,
        status,
        run,
        restart() {
            gate = new WorktreeAdmission(backend);
        },
        gate: () => gate,
    };
}
const required = (error) =>
    error.code === "WORKTREE_REQUIRED" &&
    error.submissionUnknown === false &&
    error.outcome.kind === "noMutation";

test("ordinary independent sessions share the current directory without reserving a workspace author", async (t) => {
    const f = await fixture(t);
    await Promise.all([f.run("send", { threadId: "first" }), f.run("send", { threadId: "second" })]);
    await f.run("send", { threadId: "fork" });
    await f.run("send", { threadId: "child" });
    assert.equal(f.dispatched.length, 4);
    await assert.rejects(readdir(join(f.backend.home, "workspace-authors")), { code: "ENOENT" });
    assert.ok(!f.reads.some(read => read.method === "areal/server/status"));
});

test("a pending task catalog in one root does not block ordinary admission in an unrelated root", async (t) => {
    const f = await fixture(t), gate = f.gate(), otherRoot = join(dirname(f.root), "unrelated");
    await mkdir(otherRoot);
    await mkdir(join(f.backend.home, "workspace-authors"), { recursive: true });
    let entered, resume;
    const checking = new Promise(resolve => { entered = resolve; }),
        pending = new Promise(resolve => { resume = resolve; }),
        request = f.project.client.request;
    f.project.client.request = async (method, params) => {
        if (method === "areal/task/list") {
            entered();
            await pending;
        }
        return request(method, params);
    };
    const other = { ...f.project, id: "unrelated", root: otherRoot, client: { ready: true, request } },
        ordinary = f.run("send", { threadId: "first" });
    await checking;
    try {
        await assert.doesNotReject(gate.admit(other, "send", { threadId: "second" }));
        assert.deepEqual(f.dispatched, []);
    } finally {
        resume();
        await ordinary;
    }
});

test("legacy ordinary author records are preserved without forcing later sessions into Worktree", async (t) => {
    const f = await fixture(t);
    await f.gate().claim(f.project, "first");
    const directory = join(f.backend.home, "workspace-authors");
    const [file] = await readdir(directory), before = await readFile(join(directory, file), "utf8");
    f.restart();
    await f.run("send", { threadId: "second" });
    await f.run("continue", { threadId: "first" });
    assert.equal(await readFile(join(directory, file), "utf8"), before);
    assert.equal(f.dispatched.length, 2);
});

test("durable scheduled claims block ordinary writes before schedule binding and survive restart", async (t) => {
    const f = await fixture(t);
    f.backend.scheduleAdmission = { read: async () => null };
    await f.gate().claim(f.project, "schedule:" + "a".repeat(64));
    const directory = join(f.backend.home, "workspace-authors"),
        [file] = await readdir(directory),
        before = await readFile(join(directory, file), "utf8");
    f.restart();
    await assert.rejects(f.run("send", { threadId: "first" }), required);
    await assert.rejects(f.run("workspace", { operation: "save", threadId: "second" }), required);
    assert.deepEqual(f.dispatched, []);
    assert.equal(await readFile(join(directory, file), "utf8"), before);
});

test("durable scheduled claims protect overlapping non-Git roots across project identities", async (t) => {
    for (const scheduledParent of [true, false]) {
        const f = await fixture(t), nested = join(f.root, "nested");
        await mkdir(nested);
        const scheduled = { ...f.project, root: scheduledParent ? f.root : nested },
            ordinary = { ...f.project, id: "ordinary", root: scheduledParent ? nested : f.root };
        f.backend.scheduleAdmission = { read: async (project) => project.id === scheduled.id ? { reserved: true } : null };
        await f.gate().claim(scheduled, "schedule:" + "b".repeat(64));
        await assert.rejects(f.gate().admit(ordinary, "send", { threadId: "first" }), required);
    }
});

test("legacy ordinary claims do not reserve physically overlapping non-Git roots", async (t) => {
    const f = await fixture(t), nested = join(f.root, "nested");
    await mkdir(nested);
    await f.gate().claim(f.project, "first");
    const directory = join(f.backend.home, "workspace-authors"),
        [file] = await readdir(directory),
        before = await readFile(join(directory, file), "utf8");
    await f.gate().admit({ ...f.project, root: nested }, "send", { threadId: "second" });
    assert.equal(await readFile(join(directory, file), "utf8"), before);
});

test("unknown durable author records fail closed before ordinary dispatch", async (t) => {
    const f = await fixture(t), directory = join(f.backend.home, "workspace-authors");
    await mkdir(directory, { recursive: true });
    for (const value of [
        "{",
        JSON.stringify({ version: 1, root: f.root, projectId: "physical" }),
        JSON.stringify({ version: 2, root: f.root, projectId: "physical", sessionId: "first" }),
        JSON.stringify({ version: 1, root: "relative", projectId: "physical", sessionId: "first" }),
    ]) {
        await writeFile(join(directory, "unknown.json"), value);
        await assert.rejects(f.run("send", { threadId: "first" }), required);
    }
    assert.deepEqual(f.dispatched, []);
});

test("ordinary admission rejects a durable schedule published while its task catalog was pending", async (t) => {
    const f = await fixture(t), gate = f.gate();
    await mkdir(join(f.backend.home, "workspace-authors"), { recursive: true });
    f.backend.scheduleAdmission = { read: async () => null };
    let entered, resume, first = true;
    const checking = new Promise(resolve => { entered = resolve; }),
        pending = new Promise(resolve => { resume = resolve; }),
        request = f.project.client.request;
    f.project.client.request = async (method, params) => {
        const result = await request(method, params);
        if (method === "areal/task/list" && first) {
            first = false;
            entered();
            await pending;
        }
        return result;
    };
    const ordinary = f.run("send", { threadId: "first" });
    await checking;
    try {
        await gate.claim(f.project, "schedule:" + "c".repeat(64));
    } finally {
        const rejected = assert.rejects(ordinary, required);
        resume();
        await rejected;
    }
    assert.deepEqual(f.dispatched, []);
});

test("a scheduled claim checks ordinary activity after waiting for its admission lock", async (t) => {
    const f = await fixture(t), gate = f.gate(), directory = join(f.backend.home, "workspace-authors");
    await mkdir(directory, { recursive: true });
    f.backend.scheduleAdmission = { read: async () => null };
    const release = await gate.claimLock(directory), claimLock = gate.claimLock.bind(gate);
    let waiting;
    const scheduledWaiting = new Promise(resolve => { waiting = resolve; });
    gate.claimLock = (path) => {
        waiting();
        return claimLock(path);
    };
    const scheduled = gate.claim(f.project, "schedule:" + "d".repeat(64)),
        rejected = assert.rejects(scheduled, required);
    await scheduledWaiting;
    f.status.activeTurns.push({ threadId: "first" });
    await release();
    await rejected;
    assert.deepEqual(await readdir(directory), []);
});

test("cleanup, queue pause and readonly Side discussion remain possible for the non-owner", async (t) => {
    const f = await fixture(t);
    await f.run("send", { threadId: "first" });
    for (const operation of [
        "processTerminate",
        "executionCancel",
        "goalPause",
        "closeResources",
        "taskStopRun",
        "taskDelete",
    ])
        await f.run("manage", { threadId: "second", operation });
    await f.run("queueEdit", { threadId: "second", operation: "pause" });
    await f.run("stop", { threadId: "second" });
    await f.run("side", { threadId: "side", operation: "send" });
    await assert.rejects(
        f.run("manage", { threadId: "side", operation: "mcpExtensionCall" }),
        required,
    );
    await assert.rejects(f.run("workspace", { threadId: "side", operation: "save" }), required);
    assert.equal(f.dispatched.length, 10);
});

test("project-only writes, mixed-session targets and unavailable identity never fall back to the source", async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run("workspace", { operation: "save" }), required);
    await assert.rejects(f.run("send", {}), required);
    await assert.rejects(
        f.run("manage", { operation: "agentSpawn", threadId: "first", parentThreadId: "second" }),
        required,
    );
    await assert.rejects(f.run("send", { threadId: "missing" }), required);
    assert.deepEqual(f.dispatched, []);
});

test("scheduled task creation without dedicated admission is rejected before reads even when an author is supplied", async (t) => {
    const f = await fixture(t);
    for (const threadId of [undefined, "first", "second"])
        await assert.rejects(
            f.run("manage", { operation: "taskCreate", mode: "scheduled", threadId }),
            required,
        );
    assert.deepEqual(f.dispatched, []);
    assert.deepEqual(f.reads, []);
});

test("scheduled tasks use the dedicated admission boundary and authoritative mode instead of anchor session", async (t) => {
    const f = await fixture(t),
        admitted = [];
    f.backend.scheduleAdmission = {
        reserveDraft: async () => {},
        reserveCreate: async () => {},
        admitTask: async (project, taskId, operation) => {
            admitted.push({ project: project.id, taskId, operation });
        },
    };
    const request = f.project.client.request;
    f.project.client.request = (method, params) =>
        method === "areal/task/read"
            ? { id: params.taskId, mode: "scheduled" }
            : request(method, params);
    await f.run("manage", { operation: "taskDraftConfirm", threadId: "first" });
    await f.run("manage", { operation: "taskCreate", mode: "scheduled", threadId: "first" });
    await f.run("manage", {
        operation: "taskRunNow",
        taskId: "saved",
        threadId: "first",
        mode: "background",
    });
    assert.deepEqual(admitted, [{ project: "physical", taskId: "saved", operation: "taskRunNow" }]);
    assert.deepEqual(f.reads, []);
    f.backend.scheduleAdmission.admitTask = async () => {
        throw Object.assign(new Error("unsafe schedule"), { code: "WORKTREE_REQUIRED" });
    };
    await assert.rejects(
        f.run("manage", { operation: "taskResume", taskId: "saved", threadId: "first" }),
        { code: "WORKTREE_REQUIRED" },
    );
    assert.equal(f.dispatched.length, 3);
});

test("background task creation requires an anchor and allows either ordinary session", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
        f.run("manage", { operation: "taskCreate", mode: "background" }),
        required,
    );
    await f.run("manage", { operation: "taskCreate", mode: "background", threadId: "first" });
    await f.run("manage", { operation: "taskCreate", mode: "background", threadId: "second" });
    assert.equal(f.dispatched.length, 2);
});

test("Core-verified readonly task draft sends do not claim an ordinary writer", async (t) => {
    const f = await fixture(t);
    f.threads.first.desktop = {
        configuration: {
            options: {
                appendInstructions: "AREAL_TASK_DRAFT_V1\n",
                readOnly: true,
                toolAllowlist: [],
            },
        },
    };
    await f.run("send", { threadId: "first" });
    await f.run("manage", { operation: "taskDraftSend", threadId: "first" });
    await f.run("send", { threadId: "second" });
    f.threads.first.desktop.configuration.options.toolAllowlist = ["exec_command"];
    await f.run("send", { threadId: "first" });
});

test("checkout identity ignores inherited Git redirection and fails closed for a corrupt Git marker", async (t) => {
    const f = await fixture(t);
    await repository(f.root);
    const sub = join(f.root, "src");
    await mkdir(sub);
    const old = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    try {
        process.env.GIT_DIR = join(f.root, "missing-git");
        process.env.GIT_WORK_TREE = join(f.root, "missing-tree");
        assert.equal(await checkoutRoot(sub), f.root);
    } finally {
        for (const [key, value] of Object.entries(old)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
    const other = join(f.root, "..", "corrupt");
    await mkdir(other);
    const { writeFile } = require("node:fs/promises");
    await writeFile(join(other, ".git"), "gitdir: /missing-areal-test-git\n");
    await assert.rejects(
        checkoutRoot(other),
    );
});

test("task draft confirmation requires dedicated schedule admission before dispatch", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
        f.run("manage", { operation: "taskDraftConfirm", threadId: "first" }),
        required,
    );
    assert.deepEqual(f.dispatched, []);
    assert.deepEqual(f.reads, []);
});

test("failed authoritative read stays a pre-dispatch Worktree requirement", async (t) => {
    const f = await fixture(t);
    f.project.client.request = async () => {
        throw new Error("transport interrupted");
    };
    await assert.rejects(f.run("send", { threadId: "first" }), required);
    assert.deepEqual(f.dispatched, []);
});

test("sleeping prepared legacy schedule blocks ordinary authors even at activeTasks zero and after author restart", async (t) => {
    const f = await fixture(t),
        tasks = [];
    const request = f.project.client.request;
    f.project.client.request = (method, params) =>
        method === "areal/task/list"
            ? { data: structuredClone(tasks), nextCursor: null }
            : request(method, params);
    await f.run("send", { threadId: "first" });
    tasks.push({
        id: "legacy",
        mode: "scheduled",
        threadId: "second",
        cancelled: false,
        paused: true,
        nextRunAt: 9999999999,
        runs: [{ preparation: { persisted: true } }],
    });
    assert.equal(f.status.activeTasks, 0);
    f.restart();
    await assert.rejects(f.run("send", { threadId: "first" }), required);
    assert.equal(f.dispatched.length, 1);
    tasks[0].cancelled = true;
    await f.run("send", { threadId: "first" });
});

test("task catalog follows every authoritative page and rejects unknown or nonadvancing pagination", async (t) => {
    const f = await fixture(t),
        pages = [];
    const request = f.project.client.request;
    f.project.client.request = (method, params) => {
        if (method !== "areal/task/list") return request(method, params);
        pages.push(params.after);
        return params.after
            ? { data: [{ id: "b", mode: "scheduled", cancelled: false }], nextCursor: null }
            : { data: [{ id: "a", mode: "foreground", cancelled: false }], nextCursor: "a" };
    };
    await assert.rejects(f.run("send", { threadId: "first" }), required);
    assert.deepEqual(pages, [undefined, "a"]);
    for (const reply of [
        { data: [] },
        { data: [], nextCursor: "a" },
        { data: [], nextCursor: null, hasMore: true },
    ]) {
        f.project.client.request = (method, params) =>
            method === "areal/task/list" ? reply : request(method, params);
        await assert.rejects(f.run("send", { threadId: "first" }), required);
    }
    assert.deepEqual(f.dispatched, []);
});

test("verified dedicated schedule family retains its exact bound Task and rejects a second or foreign schedule", async (t) => {
    const f = await fixture(t),
        tasks = [];
    const request = f.project.client.request,
        token = "schedule:verified";
    f.backend.scheduleAdmission = {
        read: async () => ({ token, taskId: "owned", anchorThreadId: "first" }),
    };
    f.project.client.request = (method, params) =>
        method === "areal/task/list" ? { data: tasks, nextCursor: null } : request(method, params);
    await f.gate().claim(f.project, token);
    tasks.push({ id: "owned", mode: "scheduled", cancelled: false, threadId: "first" });
    f.restart();
    await f.gate().claim(f.project, token);
    tasks.push({ id: "other", mode: "scheduled", cancelled: false, threadId: "second" });
    await assert.rejects(f.gate().claim(f.project, token), required);
});

async function scheduledExecution(t) {
    const f = await fixture(t),
        allocation = randomUUID(),
        tasks = [],
        interactions = [];
    f.project.id = "a".repeat(24);
    f.backend.saved = [{ ...f.project, projectless: true, projectlessRequestId: allocation }];
    f.backend.projectless = { records: { [allocation]: { root: f.root, existing: false } } };
    f.backend.save = async (file, value) => {
        const target = join(f.backend.home, file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(value));
    };
    f.threads.first.cwd = f.root;
    const request = f.project.client.request;
    f.project.client.request = async (method, params) => {
        if (method === "areal/task/list") return { data: structuredClone(tasks), nextCursor: null };
        if (method === "areal/task/read")
            return structuredClone(tasks.find((task) => task.id === params.taskId));
        if (method === "areal/task/run/read")
            return structuredClone(
                tasks
                    .find((task) => task.id === params.taskId)
                    ?.runs.find((run) => run.id === params.runId),
            );
        if (method === "areal/interaction/list")
            return {
                revision: 1,
                data: structuredClone(
                    interactions.filter((item) => item.threadId === params.threadId),
                ),
            };
        return request(method, params);
    };
    f.backend.scheduleAdmission = new ScheduleAdmission(f.backend);
    f.backend.worktreeAdmission = f.gate();
    f.project.model = {
        state: { interactions: {} },
        setInteractions(threadId, value) {
            this.state.interactions[threadId] = structuredClone(value);
        },
    };
    const reservation = await f.backend.scheduleAdmission.reserveCreate(
        f.project,
        randomUUID(),
        "first",
    );
    const run = {
        id: "run-id",
        threadId: "execution",
        goalId: "goal-id",
        status: "waitingForInput",
        workers: [],
    };
    const task = {
        id: "task-id",
        mode: "scheduled",
        threadId: "first",
        cancelled: false,
        paused: false,
        runs: [run],
    };
    tasks.push(task);
    f.threads.execution = {
        id: "execution",
        sessionId: "execution",
        cwd: f.root,
        source: "nativeTaskAgent",
        goals: {
            goal: {
                id: "goal-id",
                threadId: "execution",
                status: "active",
                activeTurnId: "turn-id",
            },
        },
        turns: [{ id: "turn-id", status: "inProgress", goal: { goalId: "goal-id" }, items: [] }],
    };
    await f.backend.scheduleAdmission.bind(f.project, task);
    return { ...f, tasks, task, executionRun: run, interactions, reservation };
}

test("scheduled execution replies and continuation use verified Run ownership rather than renderer tokens", async (t) => {
    const f = await scheduledExecution(t);
    for (const [kind, response] of [
        ["approval", { decision: "allowOnce" }],
        ["approval", { decision: "deny" }],
        ["question", { answers: { answer: "yes" } }],
    ]) {
        const requestId = `${kind}-${f.dispatched.length}`;
        f.interactions.splice(0, f.interactions.length, {
            requestId,
            threadId: "execution",
            turnId: "turn-id",
            callId: "call-id",
            kind,
            questions:
                kind === "question"
                    ? [{ id: "answer", title: "Proceed?", options: [], allowFreeText: true }]
                    : [],
            status: "pending",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
        await f.run("respond", {
            threadId: "execution",
            requestId,
            ...response,
            token: "untrusted",
        });
    }
    await f.run("continue", { threadId: "execution", expectedTurnId: "turn-id" });
    await assert.rejects(
        f.run("respond", { threadId: "execution", requestId: "foreign" }),
        required,
    );
    await assert.rejects(
        f.run("continue", { threadId: "execution", expectedTurnId: "old-turn" }),
        required,
    );
    f.interactions[0].expiresAt = Math.floor(Date.now() / 1000) - 1;
    await assert.rejects(
        f.run("respond", {
            threadId: "execution",
            requestId: f.interactions[0].requestId,
            answers: { answer: "yes" },
        }),
        required,
    );
    await assert.rejects(
        f.run("continue", {
            threadId: "second",
            expectedTurnId: "turn-id",
            token: f.reservation.token,
        }),
        required,
    );
    f.task.cancelled = true;
    await assert.rejects(
        f.run("continue", { threadId: "execution", expectedTurnId: "turn-id" }),
        required,
    );
    assert.equal(f.dispatched.length, 4);
});


test("executable Side uses its verified source author for first input, replies and active tools", async (t) => {
    const f = await fixture(t);
    Object.assign(f.threads.first, { cwd: f.root });
    Object.assign(f.threads.second, { cwd: f.root });
    f.threads.executable = { id: "executable", sessionId: "executable", cwd: f.root,
        conversation: { kind: "side", version: 2, policy: { kind: "sideExecutableV2" }, origin: { sourceThreadId: "first" } } };
    f.threads.sideChild = { id: "sideChild", sessionId: "executable", parentThreadId: "executable", cwd: f.root };
    await f.run("send", { threadId: "first" });
    await f.run("side", { sourceThreadId: "first", operation: "create", firstInput: { text: "hello" } });
    await f.run("side", { sourceThreadId: "second", operation: "create", firstInput: { text: "hello" } });
    await f.run("send", { threadId: "executable" });
    await f.run("respond", { threadId: "executable" });
    await f.run("manage", { threadId: "sideChild", operation: "processStart" });
    assert.equal(await new WorktreeAdmission(f.backend).session(f.project, { threadId: "executable" }).then(value => value.sessionId), "first");
    f.threads.executable.cwd = join(f.root, "other");
    await assert.rejects(f.run("send", { threadId: "executable" }), required);
    f.threads.executable.cwd = f.root;
    f.threads.executable.conversation.origin.sourceThreadId = "second";
    await f.run("send", { threadId: "executable" });
});
