"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, readdir, readFile, writeFile, realpath } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const {
  WorktreeAdmission,
} = require("@areal/workbench-service/desktop/core/worktree-admission.cjs");
const { checkoutRoot } = require("../packages/workspace-git");
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
    backend = { home: join(directory, "desktop"), rustDomains: [] };
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
    const f = await fixture(t),
      nested = join(f.root, "nested");
    await mkdir(nested);
    const scheduled = { ...f.project, root: scheduledParent ? f.root : nested },
      ordinary = { ...f.project, id: "ordinary", root: scheduledParent ? nested : f.root };
    f.backend.scheduleAdmission = {
      read: async (project) => (project.id === scheduled.id ? { reserved: true } : null),
    };
    await f.gate().claim(scheduled, "schedule:" + "b".repeat(64));
    await assert.rejects(f.gate().admit(ordinary, "send", { threadId: "first" }), required);
  }
});

test("unknown durable author records fail closed before ordinary dispatch", async (t) => {
  const f = await fixture(t),
    directory = join(f.backend.home, "workspace-authors");
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

test("a scheduled claim checks ordinary activity after waiting for its admission lock", async (t) => {
  const f = await fixture(t),
    gate = f.gate(),
    directory = join(f.backend.home, "workspace-authors");
  await mkdir(directory, { recursive: true });
  f.backend.scheduleAdmission = { read: async () => null };
  const release = await gate.claimLock(directory),
    claimLock = gate.claimLock.bind(gate);
  let waiting;
  const scheduledWaiting = new Promise((resolve) => {
    waiting = resolve;
  });
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
  await assert.rejects(checkoutRoot(other));
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
