const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const diagnostics = require("@areal/workbench-service/desktop/core/diagnostics.cjs");

test("operations isolate concurrent events and export only projected fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-operation-"));
  const mainRoot = path.join(root, "main"),
    desktopRoot = path.join(root, "desktop");
  diagnostics.start({ role: "main", root: mainRoot, version: "1.2.3", packaged: true });
  const secret = "PRIVATE_TOKEN_PATH";
  const failure = Object.assign(new Error(secret), { code: "ECONNRESET", reason: secret });
  let finishLate;
  const late = new Promise((resolve) => {
    finishLate = resolve;
  });
  await diagnostics.withOperation("startup", {}, async () => {
    setTimeout(() => {
      diagnostics.record({ type: "window-ready", windows: 3 });
      finishLate();
    }, 10);
  });
  await late;
  const results = await Promise.allSettled([
    diagnostics.withOperation("task-send", { projectId: secret }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      diagnostics.record({
        type: "command-complete",
        command: "send",
        outcome: "ok",
        durationMs: 1,
        payload: secret,
      });
      throw failure;
    }),
    diagnostics.withOperation("history-load", {}, async () => {
      diagnostics.record({ type: "window-ready", windows: 1 });
      return 42;
    }),
  ]);
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].value, 42);
  assert.equal(
    await diagnostics.withOperation(
      "reconnect",
      {},
      async () => 7,
      () => "unknown",
    ),
    7,
  );
  const runPath = path.join(mainRoot, (await fs.readdir(mainRoot))[0]);
  await fs.appendFile(
    path.join(runPath, "events-0.ndjson"),
    JSON.stringify({
      schemaVersion: 1,
      runId: path.basename(runPath),
      seq: 999,
      at: new Date().toISOString(),
      uptimeMilliseconds: 1,
      type: "window-ready",
      windows: 1,
      operationId: secret,
      payload: secret,
    }) + "\n",
  );
  const report = await diagnostics.collect({ mainRoot, desktopRoot });
  assert.ok(!JSON.stringify(report).includes(secret));
  const run = report.runs[0];
  const starts = run.events.filter(
    (event) => event.type === "operation" && event.outcome === "started",
  );
  assert.equal(starts.length, 4);
  assert.equal(
    run.events.find((event) => event.type === "window-ready" && event.windows === 3).operationId,
    undefined,
  );
  assert.equal(
    run.events.find(
      (event) =>
        event.type === "operation" && event.name === "reconnect" && event.outcome === "unknown",
    ).outcome,
    "unknown",
  );
  assert.notEqual(starts[0].operationId, starts[1].operationId);
  assert.equal(
    run.events.find((event) => event.type === "command-complete").operationId,
    starts.find((event) => event.name === "task-send").operationId,
  );
  assert.equal(
    run.events.find(
      (event) => event.type === "window-ready" && event.windows === 1 && event.seq !== 999,
    ).operationId,
    starts.find((event) => event.name === "history-load").operationId,
  );
  assert.equal(run.events.find((event) => event.seq === 999).operationId, undefined);
  assert.equal(
    run.incident.operationId,
    starts.find((event) => event.name === "task-send").operationId,
  );
  assert.ok(run.incident.events.some((event) => event.type === "resource-sample"));
  assert.equal(run.header.packaged, true);
  await diagnostics.withOperation("startup", {}, async () => {
    await diagnostics
      .withOperation("history-load", {}, async () => {
        throw Object.assign(new Error(secret), {
          code: "CORE_STOPPED",
          data: { reason: "RESPONSE_TOO_LARGE" },
        });
      })
      .catch(() => {});
  });
  const nested = (await diagnostics.collect({ mainRoot, desktopRoot })).runs[0].events;
  const child = nested.find(
    (event) =>
      event.type === "operation" && event.name === "history-load" && event.outcome === "failed",
  );
  assert.equal(child.code, "CORE_STOPPED");
  assert.equal(child.reason, "RESPONSE_TOO_LARGE");
  assert.ok(
    nested.some(
      (event) =>
        event.type === "operation" &&
        event.name === "startup" &&
        event.operationId === child.parentOperationId,
    ),
  );
  diagnostics.record({ type: "socket-error", boundary: "desktop-core", code: "ECONNRESET" });
  const afterFailure = (await diagnostics.collect({ mainRoot, desktopRoot })).runs[0];
  assert.match(afterFailure.incident.incidentId, /^[a-f0-9-]{36}$/);
  assert.equal(
    afterFailure.events.find((event) => event.type === "socket-error").incidentId,
    afterFailure.incident.incidentId,
  );
  assert.ok(afterFailure.incident.events.some((event) => event.type === "resource-sample"));
  assert.ok(afterFailure.incident.events.some((event) => event.type === "socket-error"));
  assert.equal(typeof afterFailure.incident.windowTruncated, "boolean");
});
