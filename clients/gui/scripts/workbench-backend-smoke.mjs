import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, generateKeyPairSync, sign, createHash } from "node:crypto";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { CoreClient } from "../packages/runtime-client/core.js";
import { until } from "./support/desktop-fixture.mjs";

const require = createRequire(import.meta.url);
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const WebSocket = require("../app/node_modules/ws");
const domains = new Set(
  process.argv
    .slice(2)
    .filter((arg) => arg !== "--rust")
    .map((arg) => arg.replace(/^--domain=/, "")),
);
const supported = [
  "library",
  "trajectory",
  "feedback",
  "tasks",
  "manage",
  "worktree",
  "providers",
  "lifecycle",
];
for (const domain of domains) assert.ok(supported.includes(domain), `Unknown domain: ${domain}`);
const selected = (domain) => domains.size === 0 || domains.has(domain);
assert.ok(
  process.platform !== "darwin" || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
  "Backend startup writes isolated synthetic Keychain entries; authorize them before setting AREAL_TEST_HOST_KEYCHAIN=1.",
);
const root = await realpath(await mkdtemp("/tmp/areal-a3-"));
const binary = resolve(
  process.env.AREAL_TEST_BIN || join(import.meta.dirname, "../../../target/debug/areal"),
);
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "data"),
  legacyServiceHome: join(root, "legacy"),
};
const home = join(root, "host"),
  user = join(root, "user");
for (const path of [home, user, ...Object.values(source)]) await mkdir(path, { mode: 0o700 });
const config = join(user, "config.toml");
await writeFile(
  config,
  'schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:1"\n',
  { mode: 0o600 },
);
console.log(JSON.stringify({ evidence: root, binary }));
const projects = new GuiHostProjects({ binary, home, source, singletonHeld: true });
const options = {
  binary,
  home: source.coreHome,
  guiProfile: source.profile,
  hostHome: home,
  harnessHome: source.legacyServiceHome,
  userHome: user,
  configHome: user,
  config,
};
const backend = new SharedCoreBackend({
  ...options,
  app: { getPath: (name) => (name === "userData" ? source.profile : user) },
});
const checks = [];
const ownedProcesses = [];
async function recordProcesses(service) {
  const host = JSON.parse(await readFile(join(home, "host", "host.json"), "utf8"));
  for (const record of [
    { role: "host", pid: host.pid, generation: host.generation },
    { role: "backend", pid: service.pid, generation: service.generation },
  ]) {
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
    if (!ownedProcesses.some((owned) => owned.pid === record.pid)) ownedProcesses.push(record);
  }
  await writeFile(join(root, "owned-processes.json"), JSON.stringify(ownedProcesses, null, 2));
}
let owner, stopping, web, stopRequestId;
const stopHost = () => {
  stopRequestId = randomUUID();
  return projects.client
    .stop(stopRequestId, projects.client.generation, "ifIdle")
    .then((receipt) => {
      assert.equal(receipt.state, "completed", JSON.stringify(receipt));
      return receipt;
    });
};
try {
  await projects.init();
  console.log("source ready");
  const workspace = join(root, "git-project");
  await mkdir(workspace);
  const git = (...args) =>
    execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  await writeFile(join(workspace, "fixture.txt"), "source contents\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const projectId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  await projects.register(randomUUID(), { id: projectId, root: workspace });
  const ensure = () =>
    projects.client.request("backend.ensure", { profile: source.profile, options });
  const owners = await Promise.all([ensure(), ensure()]);
  owner = owners[0];
  await recordProcesses(owner);
  assert.deepEqual(owners[0], owners[1]);
  assert.notEqual(owner.pid, process.pid);
  checks.push("concurrent ensure owns one child");
  console.log("backend ready");
  const attached = await backend.attach({ expectedIdentity: owner.identity });
  if (!attached)
    await writeFile(
      join(root, "attach-failure.json"),
      JSON.stringify(
        {
          connectionState: backend.connectionState,
          owner,
          host: await projects.client.request("backend.status", {}),
        },
        null,
        2,
      ),
    );
  assert.equal(attached, true);
  assert.equal(backend.foreignOwner, null);
  assert.equal(backend.connectionState.state, "ready");
  assert.equal(backend.computerHostOwned, true);
  checks.push("Main attaches with Host ownership and native capability lease");
  if (selected("manage")) {
    const first = await backend.command("create", { projectId, requestId: randomUUID() });
    const send = {
      projectId,
      threadId: first.threadId,
      requestId: randomUUID(),
      text: "Journal identity fixture",
    };
    const admitted = await backend.command("send", send);
    await assert.rejects(backend.command("send", send), /请求标识已使用/);
    assert.ok(first.threadId);
    const started = await projects.status(projectId);
    const auth = JSON.parse(await readFile(started.service.authFile, "utf8"));
    const core = new CoreClient({
      createSocket: () =>
        new WebSocket(started.service.endpoint, {
          headers: { Authorization: `Bearer ${auth.principals[0].token}` },
        }),
    });
    try {
      await core.connect();
      const before = (
        await core.request("thread/read", { threadId: first.threadId, includeTurns: true })
      ).thread;
      assert.equal(before.turns.length, 1);
      assert.equal(before.turns[0].id, admitted.turn.id);
      if (before.turns[0].status === "inProgress")
        await core.request("turn/interrupt", {
          threadId: first.threadId,
          turnId: before.turns[0].id,
        });
      const thread = await until(
        async () =>
          (await core.request("thread/read", { threadId: first.threadId, includeTurns: true }))
            .thread,
        "original turn settles before cleanup",
        {
          accept: (value) =>
            value.turns.some(
              (turn) => turn.id === admitted.turn.id && turn.status !== "inProgress",
            ),
        },
      );
      assert.equal(thread.turns.length, 1);
      assert.equal(thread.turns[0].id, admitted.turn.id);
    } finally {
      core.close();
    }
    checks.push("Desktop rejects an already settled request identity without redispatch");
  }
  const endpoint = await projects.client.request("web.endpoint", {});
  // 使用普通浏览器的持久公钥授权；不以桌面一次性票据代替 Web 写权限。
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
  const auth = async (path, body) => {
    const response = await fetch(`${endpoint.origin}/host/auth/${path}`, {
      method: "POST",
      headers: { Origin: endpoint.origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const pairing = await auth("challenge", { publicKey });
  assert.equal(pairing.state, "pending");
  const device = await projects.client.request("web.approve", {
    requestId: pairing.requestId,
    expectedGeneration: projects.client.generation,
    scopes: ["observe", "manage"],
  });
  assert.deepEqual(device.scopes, ["observe", "manage"]);
  const challenge = await auth("challenge", { publicKey });
  const signature = sign(
    "sha256",
    Buffer.from(`${challenge.hostId}\n${challenge.nonce}\n${endpoint.origin}`),
    { key: keys.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  const ticket = await auth("ticket", { publicKey, nonce: challenge.nonce, signature });
  web = new WebSocket(ticket.websocketUrl, { origin: endpoint.origin });
  await once(web, "open");
  const pending = new Map();
  const onMessage = (bytes) => {
    const frame = JSON.parse(bytes.toString());
    const done = pending.get(frame.id);
    if (!done) return;
    pending.delete(frame.id);
    clearTimeout(done.timer);
    if (frame.error) done.reject(Object.assign(new Error(frame.error.message), frame.error));
    else done.resolve(frame.result);
  };
  web.on("message", onMessage);
  const call = (method, params, commandId) =>
    new Promise((resolveCall, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Object.assign(new Error(`Web protocol request timed out: ${method}`), {
            requestId: id,
            commandId,
            operation: params.operation,
          }),
        );
      }, 10000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      web.send(JSON.stringify({ version: 1, id, method, params, ...(commandId && { commandId }) }));
    });
  const hello = await call("hello", {
    protocolVersions: [1],
    capabilities: ["gui-read-v1", "gui-write-v1"],
    ticket: ticket.ticket,
    expectedGeneration: ticket.generation,
  });
  assert.ok(hello.writeMethods.includes("library.command"));
  assert.equal(hello.writeMethods.includes("session.send"), false);
  assert.deepEqual(hello.scopes, ["observe", "manage"]);
  const shell = await call("shell.subscribe", {});
  assert.equal(shell.snapshot.navigation.length, 1);
  const commandId = randomUUID(),
    change = {
      sourceId: shell.snapshot.navigation[0].sourceId,
      operation: "createSection",
      title: "Web library",
    };
  let receipt;
  if (selected("library") || selected("lifecycle")) {
    await assert.rejects(
      call("library.command", { ...change, sourceId: "other-source" }, randomUUID()),
      { code: "FORBIDDEN", submissionUnknown: false },
    );
    receipt = await call("library.command", change, commandId);
    assert.equal(receipt.submissionUnknown, false);
    assert.equal(
      receipt.receipt.sections.filter((section) => section.title === "Web library").length,
      1,
    );
    require("../packages/workbench/client/desktop-contract.cjs").validateCommandResponse(
      "library",
      { operation: "createSection", title: "Web library" },
      receipt.receipt,
    );
    assert.deepEqual(await call("library.command", change, commandId), receipt);
    assert.deepEqual(await call("command.read", { commandId }), receipt);
    await assert.rejects(call("library.command", { ...change, title: "conflict" }, commandId), {
      code: "COMMAND_CONFLICT",
    });
    const webLibrary = JSON.parse(await readFile(join(source.coreHome, "library.json"), "utf8"));
    assert.equal(
      webLibrary.sections.filter((section) => section.title === "Web library").length,
      1,
    );
    checks.push(
      "Paired browser library write is journaled once; duplicate and command.read return its receipt",
    );
    const another = await call(
      "library.command",
      { ...change, title: "Another section" },
      randomUUID(),
    );
    const firstSection = receipt.receipt.sections[0].id;
    const secondSection = another.receipt.sections.find(
      (section) => section.title === "Another section",
    ).id;
    const moved = await call(
      "library.command",
      {
        sourceId: change.sourceId,
        operation: "dropSidebar",
        source: { type: "section", id: secondSection },
        target: { type: "section", id: firstSection },
        edge: "before",
        expectedSidebarRevision: another.receipt.sidebarRevision,
      },
      randomUUID(),
    );
    assert.equal(moved.submissionUnknown, false);
    assert.equal(moved.receipt.sections[0].id, secondSection);
    const preferences = await call(
      "library.command",
      {
        sourceId: change.sourceId,
        operation: "settings",
        key: "sidebarSort",
        value: "manual",
        order: [],
      },
      randomUUID(),
    );
    assert.equal(preferences.submissionUnknown, false);
    assert.equal(preferences.receipt.settings.sidebarSort, "manual");
    await assert.rejects(
      call(
        "library.command",
        {
          sourceId: change.sourceId,
          operation: "settings",
          key: "computerControlEnabled",
          value: true,
        },
        randomUUID(),
      ),
      { code: "INVALID_PARAMS", submissionUnknown: false },
    );
    checks.push(
      "Paired browser drag ordering and navigation preferences persist; native settings are rejected",
    );
  }
  if (selected("trajectory")) {
    const trajectory = await call("trajectory.read", {
      sourceId: change.sourceId,
      operation: "status",
    });
    assert.equal(trajectory.enabled, false);
    assert.equal(trajectory.worker_running, false);
    const disableId = randomUUID();
    const disable = {
      sourceId: change.sourceId,
      operation: "setEnabled",
      enabled: false,
      expectedRevision: trajectory.config_revision,
    };
    const disabled = await call("trajectory.command", disable, disableId);
    assert.equal(disabled.submissionUnknown, false);
    assert.equal(disabled.receipt.enabled, false);
    assert.deepEqual(await call("trajectory.command", disable, disableId), disabled);
    checks.push("Trajectory configuration uses Host receipts without starting an uploader");
  }
  if (selected("feedback")) {
    const feedback = await call("feedback.read", {
      sourceId: change.sourceId,
      operation: "status",
    });
    assert.equal(feedback.opted_in, true);
    const preferenceId = randomUUID();
    const preference = { sourceId: change.sourceId, operation: "preference", enabled: false };
    const optedOut = await call("feedback.command", preference, preferenceId);
    assert.equal(optedOut.submissionUnknown, false);
    assert.equal(optedOut.receipt.opted_in, false);
    assert.deepEqual(await call("feedback.command", preference, preferenceId), optedOut);
    assert.deepEqual(await call("command.read", { commandId: preferenceId }), optedOut);
    assert.equal(
      (await call("feedback.read", { sourceId: change.sourceId, operation: "status" })).opted_in,
      false,
    );
    checks.push("Feedback preference uses Host receipts without starting an uploader");
  }
  if (selected("providers")) {
    let requests = 0;
    const secret = `synthetic-${randomUUID()}`;
    const receiver = createServer(async (request, response) => {
      requests++;
      if (request.url === "/v1/models") {
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            data: [{ id: "fixture-model", context_window: 32768 }, { id: secret }],
          }),
        );
      } else {
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, undefined);
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          'data: {"id":"probe","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      }
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    try {
      const sourceId = change.sourceId;
      const baseUrl = `http://127.0.0.1:${receiver.address().port}/v1`;
      const read = () => call("providers.read", { sourceId, operation: "list" });
      const originalStatus = await backend.command("providers", { operation: "list" });
      await writeFile(
        join(root, "provider-public-status.json"),
        JSON.stringify(originalStatus, null, 2),
      );
      let status = await read();
      assert.deepEqual(status, originalStatus);
      const mutate = async (params) => {
        const commandId = randomUUID();
        const input = { sourceId, expectedRevision: status.revision, ...params };
        const result = await call("providers.command", input, commandId);
        assert.equal(result.submissionUnknown, false, JSON.stringify(result));
        require("../packages/workbench/client/desktop-contract.cjs").validateCommandResponse(
          "providers",
          { ...params, expectedRevision: input.expectedRevision },
          result.receipt,
        );
        assert.deepEqual(await call("providers.command", input, commandId), result);
        assert.deepEqual(await call("command.read", { commandId }), result);
        status = result.receipt;
        assert.equal(JSON.stringify(result).includes(secret), false);
        return result;
      };
      await assert.rejects(
        call("providers.read", { sourceId: "other-source", operation: "list" }),
        { code: "FORBIDDEN" },
      );
      await assert.rejects(
        call(
          "providers.command",
          { sourceId, operation: "revealKey", id: "fixture", expectedRevision: status.revision },
          randomUUID(),
        ),
        { code: "INVALID_PARAMS", submissionUnknown: false },
      );
      const discoveryId = randomUUID();
      const discovery = {
        sourceId,
        operation: "discover",
        connection: {
          baseUrl,
          protocol: "chatCompletions",
          credential: { kind: "draft", value: secret },
        },
      };
      const discovered = await call("providers.command", discovery, discoveryId);
      assert.equal(discovered.submissionUnknown, false);
      assert.deepEqual(discovered.receipt.models, ["fixture-model"]);
      assert.deepEqual(await call("providers.command", discovery, discoveryId), discovered);
      assert.equal(requests, 1);
      await assert.rejects(
        call(
          "providers.command",
          {
            ...discovery,
            connection: {
              ...discovery.connection,
              credential: { kind: "draft", value: "rotated" },
            },
          },
          discoveryId,
        ),
        { code: "COMMAND_CONFLICT" },
      );
      await mutate({
        operation: "save",
        authentication: "none",
        provider: {
          name: "Web provider",
          baseUrl,
          protocol: "chatCompletions",
          models: [{ id: "fixture-model" }],
        },
      });
      const provider = status.data.find((item) => item.name === "Web provider");
      assert.ok(provider);
      await mutate({
        operation: "default",
        model: { providerId: provider.id, modelId: "fixture-model" },
      });
      assert.equal((await read()).defaultModel.providerId, provider.id);
      await mutate({ operation: "apply" });
      await mutate({ operation: "defaultAndApply", model: null });
      const probe = await call(
        "providers.command",
        { sourceId, operation: "probe", id: provider.id, model: "fixture-model" },
        randomUUID(),
      );
      assert.equal(probe.submissionUnknown, false);
      assert.deepEqual(probe.receipt, { state: "connected" });
      assert.equal(requests, 2);
      await mutate({ operation: "removeAndApply", id: provider.id });
      assert.equal(
        (await read()).data.some((item) => item.id === provider.id),
        false,
      );
      await mutate({
        operation: "saveAndApply",
        authentication: "none",
        provider: {
          name: "Second provider",
          baseUrl,
          protocol: "chatCompletions",
          models: [{ id: "fixture-model" }],
        },
      });
      const second = status.data.find((item) => item.name === "Second provider");
      await mutate({ operation: "remove", id: second.id });
      assert.equal(
        (await read()).data.some((item) => item.id === second.id),
        false,
      );
      await mutate({ operation: "defaultAndApply", model: originalStatus.defaultModel });
      assert.deepEqual((await read()).defaultModel, originalStatus.defaultModel);
      // 检查真实 Host 落盘产物，不能只检查已过滤的公共回执。
      for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        assert.equal(
          (await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(secret)),
          false,
          entry.name,
        );
      }
      checks.push(
        "Browser provider discovery/probe, save/apply/default/remove share backend ownership; credentials never enter receipts or Host files",
      );
    } finally {
      await new Promise((resolveClose) => receiver.close(resolveClose));
    }
  }
  async function scheduledFixture(projectId) {
    const sourceThread = await backend.command("create", { projectId, requestId: randomUUID() });
    const anchorThread = await backend.command("create", { projectId, requestId: randomUUID() });
    const startedProject = await projects.status(projectId);
    assert.equal(startedProject.state, "ready");
    const coreAuth = JSON.parse(await readFile(startedProject.service.authFile, "utf8"));
    const core = new CoreClient({
      createSocket: () =>
        new WebSocket(startedProject.service.endpoint, {
          headers: { Authorization: `Bearer ${coreAuth.principals[0].token}` },
        }),
    });
    let scheduled;
    try {
      await core.connect();
      scheduled = await core.request("areal/task/create", {
        requestId: randomUUID(),
        mode: "scheduled",
        objective: "Host catalog fixture",
        threadId: anchorThread.threadId,
        sourceThreadId: sourceThread.threadId,
        interactionMode: "interactive",
        schedule: { at: Math.floor(Date.now() / 1000) + 86400 },
      });
    } finally {
      core.close();
    }
    return { scheduled, startedProject };
  }
  if (selected("tasks")) {
    const unboundCatalog = await call("tasks.read", {
      sourceId: change.sourceId,
      operation: "preview",
      limit: 30,
    });
    assert.equal(unboundCatalog.errors[0]?.code, "TASK_CATALOG_READ_FAILED");
    assert.match(unboundCatalog.errors[0]?.message, /unbound/);
    assert.equal((await projects.status(projectId)).state, "stopped");
    const { scheduled, startedProject } = await scheduledFixture(projectId);
    const viewId = randomUUID();
    const watched = await backend.command("manage", {
      operation: "taskWatch",
      projectId,
      taskId: scheduled.id,
      viewId,
    });
    assert.equal(watched.id, scheduled.id);
    assert.deepEqual(
      await backend.command("manage", {
        operation: "taskUnwatch",
        projectId,
        taskId: scheduled.id,
        viewId,
      }),
      { removed: true },
    );
    checks.push("Task view subscribes through Host and releases the original view without replay");

    const stopped = await projects.stop(
      randomUUID(),
      projectId,
      startedProject.service.generation,
      "ifIdle",
    );
    assert.equal(stopped.state, "completed");
    assert.equal((await projects.status(projectId)).state, "stopped");
    const catalog = await call("tasks.read", {
      sourceId: change.sourceId,
      operation: "preview",
      limit: 30,
    });
    assert.equal(catalog.source, "published");
    assert.equal(catalog.executionState, "unobserved");
    assert.deepEqual(catalog.errors, []);
    assert.ok(
      catalog.owners.some((row) => row.projectId === projectId && row.status === "unobserved"),
    );
    assert.equal(catalog.data.length, 1);
    assert.equal(catalog.data[0].id, scheduled.id);
    assert.equal(catalog.data[0].objectivePreview, "Host catalog fixture");
    assert.equal(catalog.data[0].projectId, projectId);
    assert.ok(
      (await projects.client.status()).projects.every((project) => project.state !== "ready"),
    );
    checks.push("Task directory preview reads published state without waking a stopped project");
  }
  if (selected("manage")) {
    const workspace = join(root, "manage-project");
    await mkdir(workspace);
    const projectId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
    assert.equal(await backend.addProject(workspace), projectId);
    await projects.list();
    const { scheduled } = await scheduledFixture(projectId);
    const taskRead = {
      sourceId: change.sourceId,
      projectId,
      operation: "task",
      taskId: scheduled.id,
    };
    const managedRead = async (request) =>
      call("manage.read", request).catch(async (error) => {
        const { sourceId: _source, ...local } = request;
        const diagnostic = await backend
          .command("manage", local)
          .catch((cause) => ({ error: String(cause) }));
        await writeFile(
          join(root, `manage-${request.operation}-diagnostic.json`),
          JSON.stringify(diagnostic, null, 2),
        );
        throw error;
      });
    const task = await managedRead(taskRead);
    assert.equal(task.id, scheduled.id);
    for (const operation of ["taskRunNow", "taskResumeRun"]) {
      await assert.rejects(
        call(
          "manage.command",
          {
            ...taskRead,
            operation,
            expectedRevision: task.revision,
            ...(operation === "taskResumeRun" ? { expectedRunId: "unsubmitted" } : {}),
          },
          randomUUID(),
        ),
        (error) => error.code === "FORBIDDEN",
      );
    }
    assert.equal((await managedRead(taskRead)).revision, task.revision);
    checks.push("Management permission alone cannot start or resume a task Run");
    const pauseId = randomUUID();
    const pause = {
      sourceId: change.sourceId,
      projectId,
      operation: "taskPause",
      taskId: task.id,
      expectedRevision: task.revision,
    };
    const paused = await call("manage.command", pause, pauseId);
    assert.equal(paused.submissionUnknown, false);
    assert.equal(paused.receipt.paused, true);
    assert.deepEqual(await call("manage.command", pause, pauseId), paused);
    const resumed = await call(
      "manage.command",
      { ...pause, operation: "taskResume", expectedRevision: paused.receipt.revision },
      randomUUID(),
    );
    assert.equal(resumed.submissionUnknown, false);
    assert.equal(resumed.receipt.paused, false);
    assert.equal(resumed.receipt.id, task.id);
    checks.push(
      "Task pause and resume use the original Core owner and do not replay duplicate writes",
    );
    const scheduleContext = await managedRead({
      sourceId: change.sourceId,
      projectId,
      operation: "taskScheduleContext",
      timeZone: "UTC",
    });
    assert.equal(scheduleContext.timeZone, "UTC");
    const nextAt = scheduleContext.coreNow + 172800;
    const schedule = {
      version: 1,
      rule: { kind: "onceIso", atIso: new Date(nextAt * 1000).toISOString().replace(".000Z", "Z") },
      misfire: { kind: "coalesce" },
      overlap: "skip",
    };
    const preview = await managedRead({
      sourceId: change.sourceId,
      projectId,
      operation: "taskSchedulePreview",
      schedule,
      count: 1,
    });
    assert.equal(preview.occurrences[0].at, nextAt);
    let current = resumed.receipt;
    for (const operation of ["taskUpdate", "taskCancel", "taskDelete"]) {
      const commandId = randomUUID();
      const input = {
        sourceId: change.sourceId,
        projectId,
        operation,
        taskId: current.id,
        expectedRevision: current.revision,
        ...(operation === "taskUpdate"
          ? { objective: "Updated from browser", scheduleV2: schedule }
          : {}),
      };
      const result = await call("manage.command", input, commandId);
      assert.equal(result.submissionUnknown, false, JSON.stringify(result));
      assert.deepEqual(await call("manage.command", input, commandId), result);
      assert.deepEqual(await call("command.read", { commandId }), result);
      current = result.receipt;
      if (operation === "taskUpdate") {
        assert.equal(current.objective, "Updated from browser");
        assert.equal(current.nextRunAt, nextAt);
        assert.equal((await call("manage.read", taskRead)).revision, current.revision);
      } else if (operation === "taskCancel") assert.equal(current.cancelled, true);
      else assert.equal(typeof current.deletedAt, "number");
    }
    const afterDeletion = await call("tasks.read", {
      sourceId: change.sourceId,
      projectId,
      operation: "preview",
      limit: 30,
    });
    assert.equal(
      afterDeletion.data.some((row) => row.id === task.id),
      false,
    );
    checks.push(
      "Task schedule context/preview, edit, cancel and delete use Core revisions and stable Host receipts",
    );
  }
  if (selected("worktree")) {
    await backend.command("connect", { projectId, resumeScheduling: true });
    const worktrees = await call("worktree.read", {
      sourceId: change.sourceId,
      operation: "worktreeList",
    });
    assert.equal(worktrees.settings.branchPrefix, "areal");
    const worktreeSettingsId = randomUUID();
    const worktreeSettings = {
      sourceId: change.sourceId,
      operation: "worktreeSettings",
      worktreeRoot: join(root, "worktrees"),
      branchPrefix: "web-test",
      expectedRevision: worktrees.revision,
    };
    const configured = await call("worktree.command", worktreeSettings, worktreeSettingsId);
    assert.equal(configured.submissionUnknown, false);
    assert.equal(configured.receipt.branchPrefix, "web-test");
    assert.deepEqual(
      await call("worktree.command", worktreeSettings, worktreeSettingsId),
      configured,
    );
    assert.deepEqual(await call("command.read", { commandId: worktreeSettingsId }), configured);
    const configuredList = await call("worktree.read", {
      sourceId: change.sourceId,
      operation: "worktreeList",
    });
    assert.equal(configuredList.settings.branchPrefix, "web-test");
    assert.equal(configuredList.revision, worktrees.revision + 1);
    await assert.rejects(
      call(
        "worktree.command",
        { ...worktreeSettings, branchPrefix: "changed" },
        worktreeSettingsId,
      ),
      { code: "COMMAND_CONFLICT" },
    );
    checks.push(
      "Paired browser Worktree settings use the original backend and one journaled mutation",
    );
    const environment = {
      id: "fixture-env",
      name: "Fixture environment",
      setup: { default: "" },
      cleanup: { default: "" },
      actions: [],
    };
    const environmentSaved = await call(
      "worktree.command",
      {
        sourceId: change.sourceId,
        projectId,
        operation: "worktreeEnvironmentSave",
        expectedRevision: 0,
        environment,
      },
      randomUUID(),
    );
    assert.equal(environmentSaved.submissionUnknown, false);
    assert.deepEqual(environmentSaved.receipt.environments, [environment]);
    const environmentDeleted = await call(
      "worktree.command",
      {
        sourceId: change.sourceId,
        projectId,
        operation: "worktreeEnvironmentDelete",
        expectedRevision: environmentSaved.receipt.environmentRevision,
        environmentId: environment.id,
      },
      randomUUID(),
    );
    assert.equal(environmentDeleted.submissionUnknown, false);
    assert.deepEqual(environmentDeleted.receipt.environments, []);
    checks.push(
      "Worktree environment save and delete share Host library ownership and revision checks",
    );
    const creationId = randomUUID(),
      creationCommand = randomUUID();
    const creation = {
      sourceId: change.sourceId,
      projectId,
      operation: "worktreeCreate",
      requestId: creationId,
      source: "head",
      worktreeRoot: join(root, "worktrees"),
      branch: "web-created",
    };
    const created = await call("worktree.command", creation, creationCommand);
    assert.equal(created.submissionUnknown, false);
    assert.equal(created.receipt.state, "created");
    assert.equal(
      await readFile(join(created.receipt.record.directory, "fixture.txt"), "utf8"),
      "source contents\n",
    );
    assert.deepEqual(await call("worktree.command", creation, creationCommand), created);
    const inspected = await call("worktree.read", {
      sourceId: change.sourceId,
      projectId,
      operation: "worktreeRead",
      requestId: creationId,
    });
    assert.equal(inspected.record.directory, created.receipt.record.directory);
    assert.equal(inspected.requestId, creationId);
    checks.push(
      "Paired browser creates a real Git Worktree and reads the original creation without duplication",
    );
    const cancelled = await call(
      "worktree.command",
      { sourceId: change.sourceId, projectId, operation: "worktreeCancel", requestId: creationId },
      randomUUID(),
    );
    assert.equal(cancelled.submissionUnknown, false);
    assert.equal(cancelled.receipt.state, "cancelled");
    assert.equal(
      await readFile(join(created.receipt.record.directory, "fixture.txt"), "utf8"),
      "source contents\n",
    );
    checks.push(
      "Cancelling Worktree creation retains its checkout and reports the original operation state",
    );
    const openCreationId = randomUUID();
    const openCreation = await call(
      "worktree.command",
      { ...creation, requestId: openCreationId, branch: "web-opened" },
      randomUUID(),
    );
    assert.equal(openCreation.submissionUnknown, false);
    const opened = await call(
      "worktree.command",
      {
        sourceId: change.sourceId,
        projectId,
        operation: "worktreeOpen",
        requestId: openCreationId,
      },
      randomUUID(),
    );
    assert.equal(opened.submissionUnknown, false);
    assert.equal(opened.receipt.projectId, projectId);
    assert.equal(typeof opened.receipt.threadId, "string");
    const removal = await call(
      "worktree.command",
      {
        sourceId: change.sourceId,
        projectId,
        operation: "worktreeDelete",
        requestId: randomUUID(),
        worktreeRequestId: openCreationId,
      },
      randomUUID(),
    );
    assert.equal(removal.submissionUnknown, false);
    assert.equal(
      removal.receipt.deletion.status,
      "succeeded",
      JSON.stringify(removal.receipt.deletion),
    );
    assert.equal(removal.receipt.deleted, true);
    await assert.rejects(readFile(join(openCreation.receipt.record.directory, "fixture.txt")), {
      code: "ENOENT",
    });
    checks.push(
      "Opening and deleting a Worktree retains Core thread ownership and waits for cleanup receipts",
    );
  }
  if (selected("lifecycle")) {
    await backend.command("connect", { projectId });
    const observations = await Promise.all([
      projects.client.activity(),
      backend.readHostActivity(),
      projects.client.status().then(() => backend.readHostActivity()),
    ]);
    await writeFile(join(root, "concurrent-activity.json"), JSON.stringify(observations, null, 2));
    for (const activity of observations)
      assert.equal(
        activity.complete,
        true,
        "concurrent readers must not make background status unknown",
      );
    checks.push("Concurrent Main, menu and Host activity reads preserve authoritative status");
    await backend.command("library", { operation: "createSection", title: "A3 source acceptance" });
    const library = JSON.parse(await readFile(join(source.coreHome, "library.json"), "utf8"));
    assert.ok(JSON.stringify(library).includes("A3 source acceptance"));
    checks.push("existing backend library command persists in original isolated directory");
    const previousPid = owner.pid;
    const recovered = new Promise((resolveRecovered, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("backend did not recover from its observed crash")),
        15000,
      );
      backend.onChange = () => {
        if (backend.status.connected && backend.metadata?.pid !== previousPid) {
          clearTimeout(timeout);
          resolveRecovered();
        }
      };
    });
    // PID 来自本次 Host 启动回执；这里只故障注入本夹具的后台。
    process.kill(previousPid, "SIGKILL");
    await recovered;
    owner = (await projects.client.request("backend.status", {})).service;
    await recordProcesses(owner);
    assert.equal(backend.metadata.pid, owner.pid);
    const restored = JSON.parse(await readFile(join(source.coreHome, "library.json"), "utf8"));
    assert.deepEqual(restored, library);
    checks.push("backend crash recovers observation without replaying the library mutation");
    await backend.shutdown();
    assert.equal((await projects.client.request("backend.status", {})).owned, true);
    checks.push("Main disconnect leaves Host-owned backend running");
    const removed = new Promise((resolveRemoved, reject) => {
      const timeout = setTimeout(() => {
        watcher.close();
        reject(new Error("backend metadata did not retire"));
      }, 10000);
      const watcher = watch(source.coreHome, async (_event, name) => {
        if (name !== "service.json") return;
        try {
          await readFile(join(source.coreHome, name));
        } catch (error) {
          if (error.code !== "ENOENT") return;
          clearTimeout(timeout);
          watcher.close();
          resolveRemoved();
        }
      });
    });
    stopping = stopHost();
    await stopping;
    await removed;
    checks.push("Host stop closes child and retires connection metadata");
    const previousGeneration = projects.client.generation;
    projects.client.close();
    await projects.client.connectOrStart(home, binary);
    assert.notEqual(projects.client.generation, previousGeneration);
    stopping = undefined;
    owner = await ensure();
    await recordProcesses(owner);
    const restartedChallenge = await auth("challenge", { publicKey });
    assert.equal(restartedChallenge.state, "challenge");
    const restartedSignature = sign(
      "sha256",
      Buffer.from(`${restartedChallenge.hostId}\n${restartedChallenge.nonce}\n${endpoint.origin}`),
      { key: keys.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    const restartedTicket = await auth("ticket", {
      publicKey,
      nonce: restartedChallenge.nonce,
      signature: restartedSignature,
    });
    web?.close();
    web = new WebSocket(restartedTicket.websocketUrl, { origin: endpoint.origin });
    web.on("message", onMessage);
    await once(web, "open");
    const restartedHello = await call("hello", {
      protocolVersions: [1],
      capabilities: ["gui-read-v1", "gui-write-v1"],
      ticket: restartedTicket.ticket,
      expectedGeneration: restartedTicket.generation,
    });
    assert.deepEqual(restartedHello.scopes, ["observe", "manage"]);
    assert.deepEqual(await call("command.read", { commandId }), receipt);
    assert.deepEqual(await call("library.command", change, commandId), receipt);
    assert.deepEqual(
      JSON.parse(await readFile(join(source.coreHome, "library.json"), "utf8")),
      library,
    );
    checks.push("Host restart retains browser grants and original command receipts without replay");
    stopping = stopHost();
    await stopping;
  }
  if (!stopping) {
    stopping = stopHost();
    await stopping;
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify({ domains: [...domains], checks, owner }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks, evidence: root }));
} catch (error) {
  await writeFile(
    join(root, "failure.json"),
    JSON.stringify({ checks, error: String(error), code: error.code }, null, 2),
  );
  throw error;
} finally {
  web?.close();
  await backend.shutdown();
  if (stopping) {
    try {
      await stopping;
    } catch {
      const original = await projects.client.operation(stopRequestId).catch(() => undefined);
      // 只有 Host 确认原退出请求未受理，清理阶段才能另起请求。
      if (original?.operation === null) stopping = undefined;
    }
  }
  if (!stopping && projects.client.generation) await stopHost().catch(() => {});
  projects.close();
  const syntheticEntries = [];
  if (process.platform === "darwin") {
    const service = `org.areal.host.v1.${createHash("sha256").update(home).digest("hex")}`;
    for (const directory of ["vault-operations", "remote-operations"]) {
      for (const name of await readdir(join(home, "host", directory)).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const receipt = JSON.parse(await readFile(join(home, "host", directory, name), "utf8"));
        assert.equal(name, `${receipt.requestId}.json`);
        if (!["vault.replace", "remote.replace"].includes(receipt.method) || !receipt.entryId)
          continue;
        assert.match(receipt.entryId, /^[a-f0-9-]{36}$/);
        const removal = spawnSync(
          "/usr/bin/security",
          ["delete-generic-password", "-s", service, "-a", receipt.entryId],
          { stdio: "ignore" },
        );
        const absent = spawnSync(
          "/usr/bin/security",
          ["find-generic-password", "-s", service, "-a", receipt.entryId],
          { stdio: "ignore" },
        );
        syntheticEntries.push({
          entryId: receipt.entryId,
          removal: removal.status,
          absent: absent.status === 44,
        });
        assert.equal(absent.status, 44, "original synthetic Keychain entry is absent");
      }
    }
  }
  await writeFile(
    join(root, "synthetic-keychain-cleanup.json"),
    JSON.stringify(syntheticEntries, null, 2),
  );
}
