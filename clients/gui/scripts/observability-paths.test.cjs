"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const diagnostics = require("@areal/workbench-service/desktop/core/diagnostics.cjs");
const { AppProviders } = require("@areal/workbench-service/desktop/core/providers.cjs");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { ProjectConnections } = require("@areal/workbench-service/desktop/core/project-connections.cjs");

test("business boundaries preserve results and classify observable outcomes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "observability-paths-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mainRoot = path.join(root, "main"),
    desktopRoot = path.join(root, "desktop");
  diagnostics.start({ role: "main", root: mainRoot, version: "1.2.3" });
  const providers = new AppProviders({ providerUpdating: false }, {});
  providers.apply = async () => ({ application: { kind: "unknown" } });
  providers.saveAndApply = async () => ({ application: { kind: "failed" } });
  assert.equal(
    (await providers.command({ operation: "apply", expectedRevision: "r" })).application.kind,
    "unknown",
  );
  assert.equal(
    (await providers.command({ operation: "defaultAndApply", expectedRevision: "r" })).application
      .kind,
    "failed",
  );

  const failure = Object.assign(new Error("private history"), { code: "ECONNRESET" });
  const project = { id: randomUUID(), service: { generation: randomUUID() } };
  await assert.rejects(
    CoreBackend.prototype.historyCommand.call(
      {
        observations: {
          historyCommand: async () => {
            throw failure;
          },
        },
      },
      project,
      { operation: "acquire" },
    ),
    (error) => error === failure,
  );
  const requestId = randomUUID();
  const calls = [];
  const backend = {
    projects: new Map([[project.id, project]]),
    lifecycleOperations: { blocking: () => null, activeTargets: new Map(), assertProject() {} },
    cloudConversations: {
      owns: () => true,
      route: async (name, request) => {
        calls.push({ name, request });
        return { threadId: request.threadId };
      },
    },
  };
  await CoreBackend.prototype.command.call(backend, "send", {
    projectId: project.id,
    threadId: "thread",
    text: "hello",
    requestId,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.requestId, requestId);

  const connection = new ProjectConnections({});
  connection.reconnectProjectObserved = async () => project;
  assert.equal(await connection.reconnectProject(project), project);
  const events = (await diagnostics.collect({ mainRoot, desktopRoot })).runs[0].events;
  const outcomes = (name) =>
    events.filter(
      (event) => event.type === "operation" && event.name === name && event.outcome !== "started",
    );
  assert.deepEqual(
    outcomes("model-configuration").map((event) => event.outcome),
    ["unknown", "failed"],
  );
  assert.equal(outcomes("history-load")[0].outcome, "failed");
  assert.equal(outcomes("task-send")[0].requestId, requestId);
  assert.equal(outcomes("reconnect")[0].outcome, "unknown");
});
