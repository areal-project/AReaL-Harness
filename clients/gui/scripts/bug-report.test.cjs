const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, mkdir, writeFile, readFile, stat, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { BugReports, exportReport } = require("../app/src/core/bug-reports.cjs");
const diagnostics = require("../app/src/core/diagnostics.cjs");
const contract = require("../packages/workbench/client/desktop-contract.cjs");

test("local reports freeze reviewed diagnostic context and exclude private automatic data", async () => {
  const root = await mkdtemp(join(tmpdir(), "areal-bug-report-"));
  const mainRoot = join(root, "diagnostics/main"),
    desktopRoot = join(root, "diagnostics/desktop");
  const secret = "PRIVATE_PATH_PROMPT_TOKEN_SENTINEL";
  diagnostics.start({ role: "main", root: mainRoot, version: "0.1.18" });
  diagnostics.record({
    type: "socket-error",
    boundary: "desktop-core",
    projectId: secret,
    code: "ECONNRESET",
    message: secret,
  });
  diagnostics.record({
    type: "command-complete",
    command: "send",
    outcome: "failed",
    durationMs: 42,
    payload: secret,
  });
  diagnostics.record({ type: "command-complete", command: secret, outcome: "ok", durationMs: 3 });
  diagnostics.record({ type: "window-ready", windows: 1 });
  diagnostics.record({
    type: "service-topology",
    state: "ready",
    projects: 2,
    connectedProjects: 1,
    root: secret,
  });
  const coreRoot = join(root, "core");
  const project = "0123456789abcdef01234567",
    requestId = randomUUID();
  for (const reason of ["DEPLOYMENT_CHANGE_REQUIRES_RESTART", secret])
    diagnostics.record({
      type: "model-configuration",
      phase: "apply",
      outcome: "failed",
      durationMs: 17,
      projectId: secret,
      coreGeneration: secret,
      requestId,
      reason,
      code: reason === secret ? secret : -32010,
      message: secret,
      credentials: { key: secret },
    });
  await diagnostics.withOperation("model-configuration", { requestId }, async () => {
    await assert.rejects(
      diagnostics.withOperation("history-load", { projectId: secret }, async () => {
        throw Object.assign(new Error(secret), { code: "ECONNRESET" });
      }),
      /PRIVATE_PATH_PROMPT_TOKEN_SENTINEL/,
    );
  });
  const original = await diagnostics.collect({ mainRoot, desktopRoot });
  const privateIds = original.runs.flatMap((run) =>
    run.events.flatMap((event) =>
      [event.operationId, event.parentOperationId, event.incidentId].filter(Boolean),
    ),
  );
  const requests = join(coreRoot, project, "state/model-requests");
  await mkdir(requests, { recursive: true });
  await writeFile(
    join(requests, `${requestId}.json`),
    JSON.stringify({
      requestId,
      parameters: { model: "private-model-name" },
      endpoint: { origin: "https://private.company.example", route: "/v1/responses" },
      httpStatus: 429,
      outcome: "failed",
      streamError: { code: "rate_limit_exceeded", messageSummary: secret },
      prompt: secret,
    }),
  );
  await writeFile(join(coreRoot, "service.log"), secret);
  const options = {
    root: join(root, "reports"),
    collect: () => diagnostics.collect({ mainRoot, desktopRoot, coreRoot }),
    normalizeImage: (image) => image,
  };
  const store = new BugReports(options);
  const preview = await store.command({ operation: "prepare" });
  for (const forbidden of [
    secret,
    project,
    requestId,
    "private-model-name",
    "private.company.example",
    ...privateIds,
  ])
    assert.ok(!preview.diagnostics.includes(forbidden), forbidden);
  const context = JSON.parse(preview.diagnostics);
  const operations = context.runs[0].events.filter((event) => event.type === "operation");
  const parent = operations.find((event) => event.name === "model-configuration");
  const child = operations.find(
    (event) => event.name === "history-load" && event.outcome === "failed",
  );
  assert.match(parent.operationId, /^ref-/);
  assert.equal(child.parentOperationId, parent.operationId);
  assert.equal(context.runs[0].incident.incidentId, child.incidentId);
  assert.equal(context.monitoring.incidents[0].incidentId, child.incidentId);
  assert.equal(context.monitoring.transport, "local-only");
  assert.ok(context.runs[0].header.osRelease);
  assert.equal(context.modelRequests[0].httpStatus, 429);
  assert.equal(context.modelRequests[0].error.code, "rate_limit_exceeded");
  const configuration = context.runs[0].events.filter(
    (event) => event.type === "model-configuration",
  );
  assert.equal(configuration.length, 2);
  assert.equal(configuration[0].reason, "DEPLOYMENT_CHANGE_REQUIRES_RESTART");
  assert.equal(configuration[0].code, -32010);
  assert.equal(configuration[0].phase, "apply");
  assert.equal(configuration[0].level, "error");
  assert.equal(configuration[0].component, "model-configuration");
  assert.equal(configuration[0].durationMs, 17);
  assert.match(configuration[0].requestId, /^ref-/);
  assert.match(configuration[0].coreGeneration, /^g\d+$/);
  assert.equal(configuration[1].reason, "OTHER");
  assert.equal(configuration[1].code, "OTHER");
  assert.ok(
    context.runs[0].events.some(
      (e) =>
        e.type === "command-complete" &&
        e.durationMs === 42 &&
        e.level === "error" &&
        e.component === "desktop-ipc",
    ),
  );
  assert.ok(context.incomplete, "missing diagnostics are not silently presented as complete");
  const id = randomUUID();
  const input = {
    operation: "save",
    id,
    description: "User-authored description",
    screenshots: [],
    diagnosticsToken: preview.token,
  };
  await store.command(input);
  assert.equal(
    (await store.command({ operation: "read", id })).report.diagnostics,
    preview.diagnostics,
  );
  await store.command(input);
  assert.equal(
    (await store.command({ operation: "list" })).reports.length,
    1,
    "retry has one immutable local receipt",
  );
  await assert.rejects(store.command({ ...input, description: "changed" }), /CONFLICT/);
  diagnostics.record({ type: "window-ready", windows: 2 });
  const replacement = await store.command({ operation: "prepare" });
  await assert.rejects(
    store.command({ ...input, diagnosticsToken: replacement.token }),
    /CONFLICT/,
  );
  assert.ok(
    context.runs[0].events.some((e) => e.type === "service-topology" && e.connectedProjects === 1),
  );
  const reopened = new BugReports(options);
  const report = (await reopened.command({ operation: "read", id })).report;
  const destination = join(root, "export.json");
  await exportReport(destination, report);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), report);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "reports", `${id}.json`))).mode & 0o777, 0o600);
  const without = randomUUID();
  await store.command({
    operation: "save",
    id: without,
    description: "No diagnostics",
    screenshots: [],
  });
  assert.equal((await store.command({ operation: "read", id: without })).report.diagnostics, null);
  await store.command({ operation: "delete", id });
  assert.equal((await store.command({ operation: "list" })).reports.length, 1);
  const outside = randomUUID();
  await symlink(destination, join(root, "reports", `${outside}.json`));
  await assert.rejects(store.command({ operation: "read", id: outside }));
});

test("feedback IPC validates bounded content and remains main-only", () => {
  const id = randomUUID();
  for (const request of [
    { operation: "save", id, description: " ", screenshots: [] },
    { operation: "save", id, description: "x".repeat(4001), screenshots: [] },
    {
      operation: "save",
      id,
      description: "x",
      screenshots: Array(6).fill("data:image/png;base64,AAAA"),
    },
    { operation: "save", id, description: "x", screenshots: ["data:image/svg+xml;base64,AAAA"] },
    { operation: "prepare", path: "/private" },
    { operation: "save", id, description: "x", screenshots: [], contact: "private@example.com" },
    { operation: "read", id: "../../secret" },
    { operation: "upload", id },
  ])
    assert.throws(() => contract.validateCommand("bugReport", request));
  assert.doesNotThrow(() =>
    contract.validateCommand("bugReport", {
      operation: "save",
      id,
      description: "x",
      screenshots: [],
    }),
  );
  assert.throws(() =>
    contract.readCommandInvocation("bugReport", { operation: "prepare" }, { serviceOnly: true }),
  );
  assert.throws(() =>
    contract.validateCommandResponse("bugReport", { operation: "save", id }, { id: randomUUID() }),
  );
});

test("expired preview and disk failure preserve retryable content without a false saved report", async () => {
  const root = await mkdtemp(join(tmpdir(), "areal-bug-failure-"));
  const store = new BugReports({
    root: join(root, "reports"),
    collect: () =>
      diagnostics.collect({ mainRoot: join(root, "main"), desktopRoot: join(root, "desktop") }),
    normalizeImage: (image) => image,
  });
  const preview = await store.command({ operation: "prepare" });
  store.prepared.get(preview.token).at = 0;
  await assert.rejects(
    store.command({
      operation: "save",
      id: randomUUID(),
      description: "keep",
      screenshots: [],
      diagnosticsToken: preview.token,
    }),
    /EXPIRED/,
  );
  assert.deepEqual((await store.command({ operation: "list" })).reports, []);
  const file = join(root, "not-directory");
  await writeFile(file, "sentinel");
  const failed = new BugReports({
    root: file,
    collect: store.collect,
    normalizeImage: (image) => image,
  });
  await assert.rejects(
    failed.command({ operation: "save", id: randomUUID(), description: "keep", screenshots: [] }),
  );
  assert.equal(await readFile(file, "utf8"), "sentinel");
});

test("submission retains immutable report after lost receipt and persists confirmed ID", async () => {
  const { createServer } = require("node:http");
  const requests = [];
  let loseReceipt = true;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    requests.push(JSON.parse(body));
    if (loseReceipt) {
      loseReceipt = false;
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: requests[0].id }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "areal-bug-submit-"));
  const options = {
    root,
    collect: async () => ({}),
    normalizeImage: (image) => image,
    endpoint: `http://127.0.0.1:${server.address().port}/api/public/bug-reports`,
  };
  const store = new BugReports(options);
  const id = randomUUID();
  try {
    await store.command({
      operation: "save",
      id,
      description: "retry same report",
      screenshots: [],
    });
    await assert.rejects(store.command({ operation: "submit", id }), /UPLOAD_UNCONFIRMED/);
    assert.equal((await store.read(id)).state, "local-only");
    const result = await store.command({ operation: "submit", id });
    assert.equal(result.report.submittedId, id);
    assert.equal(result.report.state, "submitted");
    assert.deepEqual(requests[0], requests[1]);
    contract.validateCommandResponse("bugReport", { operation: "submit", id }, result);
    const restarted = new BugReports(options);
    assert.equal((await restarted.command({ operation: "list" })).reports[0].submittedId, id);
    await restarted.command({ operation: "submit", id });
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
