"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { TaskWorkspaceOwners } = require("../app/src/core/task-workspace-owners.cjs");
const { CoreWorktrees } = require("../app/src/core/worktrees.cjs");
const { manageTask } = require("../app/src/core/tasks.cjs");
const { taskCatalog } = require("../app/src/core/task-catalog.cjs");
const { ScheduleAdmission } = require("../app/src/core/schedule-admission.cjs");
const source = "a".repeat(24),
    isolated = "b".repeat(24),
    foreign = "c".repeat(24);
const task = (id, threadId) => ({ id, threadId, mode: "scheduled", revision: 1 });

async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), "areal-task-owners-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const calls = [];
    const records = new Map([
        [source, new Map()],
        [isolated, new Map()],
        [foreign, new Map()],
    ]);
    const backend = {
        home,
        calls,
        saved: [
            { id: source, root: "/workspace/source" },
            { id: isolated, root: "/worktrees/isolated", logicalProjectId: source },
            { id: foreign, root: "/workspace/foreign" },
        ],
        projects: new Map(),
        library: { value: { projects: { [source]: { title: "Logical project" } } } },
        providers: { redact: (value) => value },
        lifecycleOperations: { assertProject() {} },
        projectless: { records: {} },
        async save(name, value) {
            const path = join(home, name);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, JSON.stringify(value));
        },
        async readConnection(id) {
            const project = this.projects.get(id);
            return { project, client: project.client, generation: 0 };
        },
        requireConnection(project, client) {
            assert.equal(project.client, client);
        },
        async submit(project, method, params) {
            calls.push({ host: project.id, method, params });
            const value =
                method === "areal/task/create"
                    ? { ...task("created-task", params.threadId), mode: params.mode }
                    : records.get(project.id).get(params.taskId);
            assert.ok(value);
            records.get(project.id).set(value.id, value);
            return value;
        },
    };
    for (const owner of backend.saved) {
        const state = { tasks: {}, threads: {} };
        const project = {
            ...owner,
            pending: [],
            model: {
                state,
                setTask(value) {
                    state.tasks[value.id] = value;
                },
            },
        };
        project.client = {
            ready: true,
            capabilities: { methods: ["areal/task/runNow"] },
            async request(method, params) {
                calls.push({ host: owner.id, method, params });
                if (method === "areal/task/list")
                    return { data: [...records.get(owner.id).values()], nextCursor: null };
                if (method === "areal/inbox/list")
                    return {
                        data: [...records.get(owner.id).values()].map((value) => ({
                            taskId: value.id,
                            message: { runId: "run", id: "message" },
                        })),
                        nextCursor: null,
                    };
                if (method === "areal/task/unsubscribe") return { removed: true };
                if (method === "areal/task/read" || method === "areal/task/subscribe") {
                    const value = records.get(owner.id).get(params.taskId);
                    if (!value) throw Object.assign(new Error("missing"), { code: -32004 });
                    return value;
                }
                if (method === "areal/channel/read") return { data: [] };
                throw new Error(`unexpected RPC: ${method}`);
            },
        };
        backend.projects.set(owner.id, project);
    }
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    backend.worktrees = new CoreWorktrees(backend);
    backend.scheduleAdmission = new ScheduleAdmission(backend);
    return { backend, records, calls };
}

async function dispatch(backend, request) {
    const routed = await backend.worktrees.resolveRequest("manage", request);
    return manageTask(backend, backend.projects.get(routed.projectId), routed);
}

test("hidden-thread create then taskId-only control/read remains on physical host across restart", async (t) => {
    const { backend, calls } = await fixture(t);
    backend.worktrees.threadOwners.set("isolated-thread", isolated);
    await dispatch(backend, {
        projectId: source,
        threadId: "isolated-thread",
        operation: "taskCreate",
        mode: "foreground",
        objective: "example",
        requestId: "11111111-1111-4111-a111-111111111111",
    });
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, "created-task"), {
        projectId: isolated,
        threadId: "isolated-thread",
    });
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    calls.length = 0;
    for (const operation of ["taskPause", "taskUpdate", "taskChannel", "task"])
        await dispatch(backend, {
            projectId: source,
            taskId: "created-task",
            operation,
            expectedRevision: 1,
        });
    assert.deepEqual(
        calls.filter((call) => call.method !== "areal/task/read").map((call) => call.method),
        ["areal/task/pause", "areal/task/update", "areal/channel/read"],
    );
    assert.ok(calls.every((call) => call.host === isolated));
    assert.deepEqual(
        JSON.parse(await readFile(join(backend.home, "task-owners", isolated + ".json"), "utf8")),
        [{ id: "created-task", threadId: "isolated-thread" }],
    );
});

test("scoped and unscoped catalogs aggregate hosts under one logical project and persist authoritative owners", async (t) => {
    const { backend, records } = await fixture(t);
    records.get(source).set("local-task", task("local-task", "local-thread"));
    records.get(isolated).set("hidden-task", task("hidden-task", "hidden-thread"));
    const scoped = await taskCatalog(backend, { operation: "list", projectId: source });
    assert.deepEqual(
        scoped.data.map((value) => [value.id, value.projectId, value.projectName]),
        [
            ["local-task", source, "Logical project"],
            ["hidden-task", source, "Logical project"],
        ],
    );
    assert.deepEqual(scoped.owners, [
        { projectId: source, status: "ready", connectionGeneration: 0 },
    ]);
    assert.equal(scoped.data[1].executionProjectId, isolated);
    const all = await taskCatalog(backend, { operation: "list" });
    assert.deepEqual(
        all.owners.map((owner) => owner.projectId),
        [source, foreign],
    );
    assert.ok(all.data.every((value) => value.projectId === source));
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    assert.equal(await backend.taskWorkspaceOwners.resolve(source, "hidden-task"), isolated);
});

test("unknown task discovers exact authoritative host without widening to other logical projects", async (t) => {
    const { backend, records, calls } = await fixture(t);
    records.get(isolated).set("discovered", task("discovered", "anchor"));
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, "discovered"), {
        projectId: isolated,
        threadId: "anchor",
    });
    assert.deepEqual(calls.map((call) => call.host).sort(), [source, isolated].sort());
    assert.ok(calls.every((call) => call.method === "areal/task/read"));
    await assert.rejects(backend.taskWorkspaceOwners.target(foreign, "discovered"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
});

test("offline host, exact identity mismatch, and unknown task fail without control fallback", async (t) => {
    const { backend, records, calls } = await fixture(t);
    records.get(isolated).set("hidden", task("hidden", "anchor"));
    const project = backend.projects.get(source),
        read = project.client.request;
    project.client.request = async () => {
        throw new Error("offline");
    };
    await assert.rejects(
        dispatch(backend, { projectId: source, taskId: "hidden", operation: "taskPause" }),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
    assert.ok(calls.every((call) => call.method === "areal/task/read"));
    project.client.request = async () => task("other-task", "anchor");
    await assert.rejects(backend.taskWorkspaceOwners.target(source, "hidden"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
    project.client.request = read;
    await assert.rejects(backend.taskWorkspaceOwners.target(source, "unknown"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
});

test("duplicate authoritative task identity is blocked in memory and after restart", async (t) => {
    const { backend } = await fixture(t);
    await backend.taskWorkspaceOwners.observe(
        backend.projects.get(source),
        task("collision", "one"),
    );
    await assert.rejects(
        backend.taskWorkspaceOwners.observe(
            backend.projects.get(isolated),
            task("collision", "two"),
        ),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
    await assert.rejects(backend.taskWorkspaceOwners.target(source, "collision"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    await assert.rejects(backend.taskWorkspaceOwners.target(source, "collision"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
});

test("removed owner and conflicting anchor cannot silently fall back to source", async (t) => {
    const { backend } = await fixture(t);
    const owner = backend.projects.get(isolated);
    await backend.taskWorkspaceOwners.observe(owner, task("removed", "anchor"));
    await backend.taskWorkspaceOwners.observe(owner, task("changed-anchor", "one"));
    await assert.rejects(
        backend.taskWorkspaceOwners.observe(owner, task("changed-anchor", "two")),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
    await assert.rejects(backend.taskWorkspaceOwners.target(source, "changed-anchor"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
    backend.saved = backend.saved.filter((value) => value.id !== isolated);
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    await assert.rejects(backend.taskWorkspaceOwners.resolve(source, "removed"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
});

test("inbox-only observations recover authoritative anchor and do not confuse message id with task id", async (t) => {
    const { backend, records } = await fixture(t);
    records.get(isolated).set("inbox-task", task("inbox-task", "anchor"));
    await taskCatalog(backend, { operation: "inbox", projectId: source });
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, "inbox-task"), {
        projectId: isolated,
        threadId: "anchor",
    });
    await assert.rejects(backend.taskWorkspaceOwners.target(source, "message"), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
    });
});

test("legacy id-only journal hydrates anchor from only the known host", async (t) => {
    const { backend, records, calls } = await fixture(t);
    records.get(isolated).set("legacy-task", task("legacy-task", "anchor"));
    await backend.save(join("task-owners", isolated + ".json"), ["legacy-task"]);
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, "legacy-task"), {
        projectId: isolated,
        threadId: "anchor",
    });
    assert.deepEqual(
        calls.map((call) => call.host),
        [isolated],
    );
});

test("client cannot substitute a different thread on the same physical Task host", async (t) => {
    const { backend, calls } = await fixture(t);
    await backend.taskWorkspaceOwners.observe(
        backend.projects.get(isolated),
        task("anchored-task", "trusted-thread"),
    );
    backend.worktrees.threadOwners.set("unrelated-thread", isolated);
    await assert.rejects(
        dispatch(backend, {
            projectId: source,
            taskId: "anchored-task",
            threadId: "unrelated-thread",
            operation: "taskPause",
        }),
        { code: "WORKTREE_BINDING_UNAVAILABLE" },
    );
    assert.deepEqual(calls, []);
});

test("execution-start requests receive authoritative Task anchor rather than a client-selected actor", async (t) => {
    const { backend, records } = await fixture(t);
    const authoritative = { ...task("anchored-task", "trusted-thread"), mode: "foreground" };
    records.get(isolated).set(authoritative.id, authoritative);
    await backend.taskWorkspaceOwners.observe(backend.projects.get(isolated), authoritative);
    for (const mode of ["foreground", "background"]) {
        records.get(isolated).set(authoritative.id, { ...authoritative, mode });
        for (const operation of [
            "taskRunNow",
            "taskResumeRun",
            "taskReply",
            "taskResume",
            "taskUpdate",
        ]) {
            const request = { projectId: source, taskId: "anchored-task", operation };
            const resolved = await backend.worktrees.resolveRequest("manage", request);
            assert.equal(resolved.projectId, isolated);
            assert.equal(resolved.logicalProjectId, source);
            assert.equal(resolved.threadId, "trusted-thread");
            assert.equal(request.threadId, undefined);
        }
    }
});

test("anchorless legacy Task permits observation and pause but blocks execution-start operations", async (t) => {
    const { backend, records, calls } = await fixture(t);
    records
        .get(isolated)
        .set("anchorless-task", { ...task("anchorless-task", null), mode: "foreground" });
    for (const operation of [
        "taskRunNow",
        "taskResumeRun",
        "taskReply",
        "taskResume",
        "taskUpdate",
    ])
        await assert.rejects(
            dispatch(backend, { projectId: source, taskId: "anchorless-task", operation }),
            { code: "WORKTREE_BINDING_UNAVAILABLE" },
        );
    assert.ok(calls.every((call) => call.method === "areal/task/read"));
    assert.equal(
        (
            await dispatch(backend, {
                projectId: source,
                taskId: "anchorless-task",
                operation: "task",
            })
        ).id,
        "anchorless-task",
    );
    await dispatch(backend, {
        projectId: source,
        taskId: "anchorless-task",
        operation: "taskPause",
    });
    assert.equal(calls.at(-1).host, isolated);
    assert.equal(calls.at(-1).method, "areal/task/pause");
});

test("failed durable index save blocks routing until authoritative observation successfully retries", async (t) => {
    const { backend, calls } = await fixture(t);
    const save = backend.save.bind(backend),
        failure = new Error("simulated disk failure");
    backend.save = async () => {
        throw failure;
    };
    const authoritative = task("durable-task", "anchor");
    await assert.rejects(
        backend.taskWorkspaceOwners.observe(backend.projects.get(isolated), authoritative),
        (error) => error === failure,
    );
    await assert.rejects(
        dispatch(backend, { projectId: source, taskId: authoritative.id, operation: "taskPause" }),
        (error) => error === failure,
    );
    assert.deepEqual(calls, []);
    backend.save = save;
    await backend.taskWorkspaceOwners.observe(backend.projects.get(isolated), authoritative);
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, authoritative.id), {
        projectId: isolated,
        threadId: "anchor",
    });
});

test("concurrent observations serialize each physical journal without losing tasks after restart", async (t) => {
    const { backend } = await fixture(t);
    const save = backend.save.bind(backend);
    let release, reached;
    const blocked = new Promise((resolve) => {
        release = resolve;
    });
    const started = new Promise((resolve) => {
        reached = resolve;
    });
    let count = 0,
        active = 0;
    backend.save = async (name, value) => {
        assert.equal(active++, 0);
        if (++count === 1) {
            reached();
            await blocked;
        }
        await save(name, value);
        active--;
    };
    const first = backend.taskWorkspaceOwners.observe(
        backend.projects.get(isolated),
        task("first-task", "first-anchor"),
    );
    await started;
    const second = backend.taskWorkspaceOwners.observe(
        backend.projects.get(isolated),
        task("second-task", "second-anchor"),
    );
    release();
    await Promise.all([first, second]);
    backend.taskWorkspaceOwners = new TaskWorkspaceOwners(backend);
    await backend.taskWorkspaceOwners.init();
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, "first-task"), {
        projectId: isolated,
        threadId: "first-anchor",
    });
    assert.deepEqual(await backend.taskWorkspaceOwners.target(source, "second-task"), {
        projectId: isolated,
        threadId: "second-anchor",
    });
});

test("owner conflict observed while routing awaits durability prevents dispatch", async (t) => {
    const { backend, calls } = await fixture(t);
    const save = backend.save.bind(backend);
    let release, reached;
    const blocked = new Promise((resolve) => {
        release = resolve;
    });
    const started = new Promise((resolve) => {
        reached = resolve;
    });
    backend.save = async (name, value) => {
        if (name === join("task-owners", isolated + ".json")) {
            reached();
            await blocked;
        }
        await save(name, value);
    };
    const first = assert.rejects(
        backend.taskWorkspaceOwners.observe(
            backend.projects.get(isolated),
            task("racing-task", "anchor"),
        ),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
    await started;
    const rejected = assert.rejects(
        dispatch(backend, { projectId: source, taskId: "racing-task", operation: "taskPause" }),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
    await assert.rejects(
        backend.taskWorkspaceOwners.observe(
            backend.projects.get(source),
            task("racing-task", "other-anchor"),
        ),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
    release();
    await first;
    await rejected;
    assert.deepEqual(calls, []);
});

test("execution target refreshes authoritative mode even when Task owner and anchor are cached", async (t) => {
    const { backend, records, calls } = await fixture(t);
    const authoritative = { ...task("mode-task", "anchor"), mode: "background" };
    records.get(isolated).set(authoritative.id, authoritative);
    await backend.taskWorkspaceOwners.observe(backend.projects.get(isolated), authoritative);
    assert.deepEqual(
        await backend.taskWorkspaceOwners.target(source, authoritative.id, { execution: true }),
        { projectId: isolated, threadId: "anchor", mode: "background" },
    );
    assert.deepEqual(
        calls.map((call) => [call.host, call.method]),
        [[isolated, "areal/task/read"]],
    );
    backend.projects.get(isolated).client.request = async () => {
        throw new Error("offline");
    };
    await assert.rejects(
        backend.taskWorkspaceOwners.target(source, authoritative.id, { execution: true }),
        { code: "TASK_WORKSPACE_UNAVAILABLE" },
    );
});

test("unreserved scheduled activations use real schedule guard and unknown modes fail in router", async (t) => {
    const { backend, records, calls } = await fixture(t);
    for (const mode of ["scheduled", undefined]) {
        const authoritative = { ...task("non-foreground-task", "anchor"), mode };
        records.get(isolated).set(authoritative.id, authoritative);
        for (const operation of [
            "taskRunNow",
            "taskResumeRun",
            "taskReply",
            "taskResume",
            "taskUpdate",
        ])
            await assert.rejects(
                dispatch(backend, {
                    projectId: source,
                    taskId: authoritative.id,
                    operation,
                    mode: "foreground",
                }),
                {
                    code:
                        mode === "scheduled"
                            ? "SCHEDULE_WORKSPACE_REQUIRED"
                            : "WORKTREE_BINDING_UNAVAILABLE",
                },
            );
    }
    assert.ok(calls.every((call) => call.method === "areal/task/read"));
    assert.ok(calls.every((call) => call.host !== foreign));
});

test("watch cleanup carrying taskId removes subscription on isolated owner rather than source", async (t) => {
    const { backend, records, calls } = await fixture(t);
    const authoritative = task("watched-task", "anchor");
    records.get(isolated).set(authoritative.id, authoritative);
    await backend.taskWorkspaceOwners.observe(backend.projects.get(isolated), authoritative);
    await dispatch(backend, {
        projectId: source,
        operation: "taskWatch",
        taskId: authoritative.id,
        viewId: "task-center-view",
    });
    assert.equal(
        backend.projects.get(isolated).taskViews.get("task-center-view"),
        authoritative.id,
    );
    await dispatch(backend, {
        projectId: source,
        operation: "taskUnwatch",
        taskId: authoritative.id,
        viewId: "task-center-view",
    });
    assert.equal(backend.projects.get(isolated).taskViews.size, 0);
    assert.equal(backend.projects.get(source).taskViews, undefined);
    assert.deepEqual(
        calls.map((call) => [call.host, call.method]),
        [
            [isolated, "areal/task/subscribe"],
            [isolated, "areal/task/unsubscribe"],
        ],
    );
});

test("direct scheduled create in shared logical source fails real reservation before any Core mutation", async (t) => {
    const { backend, calls } = await fixture(t);
    const root = join(backend.home, "shared-source");
    await mkdir(root);
    backend.projects.get(source).root = root;
    backend.saved.find((project) => project.id === source).root = root;
    await assert.rejects(
        dispatch(backend, {
            projectId: source,
            operation: "taskCreate",
            mode: "scheduled",
            objective: "shared schedule",
            requestId: "22222222-2222-4222-a222-222222222222",
        }),
        { code: "SCHEDULE_WORKSPACE_REQUIRED" },
    );
    assert.deepEqual(calls, []);
});
