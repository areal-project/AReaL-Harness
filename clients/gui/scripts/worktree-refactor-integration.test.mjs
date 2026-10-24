import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { CoreClient } from "../packages/runtime-client/core.js";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const physical = "a".repeat(24),
  logical = "b".repeat(24);

async function backendFixture(t) {
  const home = await mkdtemp(join(tmpdir(), "areal-refactored-worktree-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "thread-owners"));
  const backend = new CoreBackend({ binary: "/bin/true", home });
  backend.saved = [{ id: physical, logicalProjectId: logical, root: home }];
  backend.scheduleReconciliation = () => {};
  backend.stopReconciliation = () => {};
  return { backend, home };
}

test("refactored journal model persists physical thread ownership for logical project routing", async (t) => {
  const { backend, home } = await backendFixture(t);
  const project = await backend.loadProjectJournal(physical);
  assert.equal(await backend.loadProjectJournal(physical), project);
  project.model.replace({ id: "journal-thread", sessionId: "session", turns: [], desktop: {} });
  await Promise.all([...backend.saves.values()]);
  assert.equal(backend.worktrees.threadOwners.get("journal-thread"), physical);
  assert.deepEqual(
    JSON.parse(await readFile(join(home, "thread-owners", physical + ".json"), "utf8")),
    ["journal-thread"],
  );
});

test("refactored summary reads persist isolated host routing before returning navigation", async (t) => {
  const { backend, home } = await backendFixture(t);
  const project = await backend.loadProjectJournal(physical);
  backend.library.recordThreadSummaries = async () => {};
  project.client = {
    closed: false,
    request: async () => ({ data: [{ id: "summary-thread", desktop: {} }], nextCursor: null }),
  };
  const summaries = await backend.listThreads(project);
  assert.equal(summaries[0].id, "summary-thread");
  assert.equal(backend.worktrees.threadOwners.get("summary-thread"), physical);
  assert.deepEqual(
    JSON.parse(await readFile(join(home, "thread-owners", physical + ".json"), "utf8")),
    ["summary-thread"],
  );
});

test("refactored connection guards scheduled start and resume before resources and preserves logical browser identity", async (t) => {
  const { backend } = await backendFixture(t);
  const project = await backend.loadProjectJournal(physical),
    calls = [];
  backend.providers = { value: {} };
  backend.supportsBrowser = () => false;
  backend.resources.beforeCreate = async () => calls.push("resources");
  backend.scheduleAdmission.prepare = async (_project, params) => {
    calls.push(params.intent);
    if (params.taskId === "unreserved")
      throw Object.assign(new Error("unreserved"), { code: "WORKTREE_REQUIRED" });
  };
  const original = CoreClient.prototype.connect;
  CoreClient.prototype.connect = async () => {
    throw new Error("fixture before transport");
  };
  try {
    await assert.rejects(backend.connect(project), /fixture before transport/);
  } finally {
    CoreClient.prototype.connect = original;
  }
  const callback = project.client.onServerRequest;
  for (const intent of ["start", "resume"]) {
    await assert.rejects(callback("areal/task/prepare", { intent, taskId: "unreserved" }), {
      code: "WORKTREE_REQUIRED",
    });
  }
  assert.deepEqual(calls, ["start", "resume"]);
  await callback("areal/task/prepare", { intent: "start", taskId: "reserved" });
  await callback("areal/task/prepare", { intent: "resume", taskId: "reserved" });
  assert.deepEqual(calls, ["start", "resume", "start", "resources", "resume"]);
  backend.browserRead = async (request) => request;
  const browser = await callback(
    "item/tool/call",
    { tool: "browser_v1", threadId: "run-thread" },
    { signal: new AbortController().signal },
  );
  assert.equal(browser.projectId, logical);
  assert.equal(browser.threadId, "run-thread");
});

test("refactored notifications keep physical task ownership and logical user-facing identity", async (t) => {
  const { backend } = await backendFixture(t);
  const project = await backend.loadProjectJournal(physical),
    events = [];
  project.client = { closed: false };
  project.model.event = () => {};
  backend.analytics.observe = (projectId) => events.push(["analytics", projectId]);
  backend.notifications.observe = (owner) => events.push(["notice", owner.id]);
  backend.taskWorkspaceOwners.observeProject = async (owner) => events.push(["task", owner.id]);
  backend.onMcpPageToolNotice = (notice) => events.push(["mcp", notice.projectId]);
  backend.observations.notification(project, project.client, "areal/task/changed", {
    task: { id: "task" },
  });
  backend.observations.notification(project, project.client, "areal/mcp/app/tools/pending", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    ["analytics", physical],
    ["task", physical],
    ["notice", logical],
    ["mcp", logical],
  ]);
});
