import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import {
  assertApplicationStopped,
  cleanupSyntheticHostKeychain,
  closeSmokeApplication,
} from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import {
  captureSmokeFailure,
  createProjectConversation,
  openSideChat,
} from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
const snapshotCompletion = process.env.AREAL_STOP_SNAPSHOT_COMPLETION === "1";
assert.ok(binary && isAbsolute(binary), "Set AREAL_CORE_BIN to an absolute fixed Core binary");
const scratch = await makeTempDir("stop-turn-");
const rust = process.argv.includes("--rust");
const rustDomains = ["library-rust", "execution-rust", "tasks-rust", "worktree-rust"];
if (rust && process.platform === "darwin") assert.equal(process.env.AREAL_TEST_HOST_KEYCHAIN, "1");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: [env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
});
if (rust) env.AREAL_TEST_HOST_KEYCHAIN = "1";
const requests = [],
  held = new Set(),
  errors = [],
  checks = [];
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "STOP_TURN_STREAMING" }, finish_reason: null }] })}\n\n`,
    );
    held.add(response);
    response.on("close", () => held.delete(response));
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
const commandLog = join(scratch, "commands.jsonl");
const receiptGate = join(scratch, "receipt.gate");
const omittedCompletionLog = join(scratch, "omitted-completions.jsonl");
const preload = join(scratch, "snapshot-preload.cjs");
if (snapshotCompletion) {
  const runtime = await realpath(process.execPath);
  const directory = join(scratch, "snapshot-bin");
  await mkdir(directory);
  await writeFile(
    preload,
    `
const { HostCoreClient } = require(${JSON.stringify(join(root, "services/workbench/src/generated/host-core-client.cjs"))});
const { appendFileSync } = require('node:fs');
const event = HostCoreClient.prototype.event;
HostCoreClient.prototype.event = function(frame) {
  if (this.owns(frame.lease) && frame.method === 'turn/completed') {
    appendFileSync(${JSON.stringify(omittedCompletionLog)}, JSON.stringify({
      threadId: frame.params?.threadId, turnId: frame.params?.turn?.id,
      connectionId: this.identity()?.connectionId, owned: true
    }) + '\\n');
    return;
  }
  return event.call(this, frame);
};
`,
  );
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(directory, "node"),
    `#!/bin/sh\nexec ${quote(runtime)} --require ${quote(preload)} "$@"\n`,
    { mode: 0o700 },
  );
  env.PATH = `${directory}:${env.PATH ?? ""}`;
}
const bootstrap = `
${snapshotCompletion ? `require(${JSON.stringify(preload)});` : ""}
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const { appendFileSync, existsSync } = require('node:fs');
const command = SharedCoreBackend.prototype.command;
const accept = SharedCoreBackend.prototype.acceptLifecycleReceipt;
SharedCoreBackend.prototype.command = async function(name, request) {
  try {
    const value = await command.call(this, name, request);
    appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ name, request, ok: true }) + '\\n');
    return value;
  } catch (error) {
    appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ name, request, error: error.message }) + '\\n');
    throw error;
  }
};
SharedCoreBackend.prototype.acceptLifecycleReceipt = async function(reference, receipt) {
  if (reference.kind === 'interruptTurn' && receipt.phase === 'completed') {
    appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ receiptHeld: reference.requestId }) + '\\n');
    const deadline = Date.now() + 45000;
    while (existsSync(${JSON.stringify(receiptGate)})) {
      if (Date.now() > deadline) throw new Error('Fixture receipt gate was not released');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return accept.call(this, reference, receipt);
};
`;
const hash = async () =>
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
const coreHash = await hash();
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const guiDiffHash = createHash("sha256")
  .update(execFileSync("git", ["diff", "HEAD", "--", "clients/gui"], { cwd: root }))
  .digest("hex");
let application,
  app,
  page,
  metadata,
  primaryThreadId,
  passed = false,
  failure,
  cleanup;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function acceptedCompletionReads(projectId, threadId, completionId) {
  const imports = join(env.AREAL_HARNESS_SERVICE_HOME, "host/imports");
  const migrations = await readdir(imports).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const sources = (
    await Promise.all(
      migrations.map(async (name) => {
        const record = await readFile(join(imports, name, "record.json"), "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        return record?.phase === "committed" && record.source?.profile === env.AREAL_GUI_USER_DATA
          ? record.sourceId
          : null;
      }),
    )
  ).filter(Boolean);
  assert.equal(new Set(sources).size, 1, "Fixture profile has one committed Host source");
  const params = {
    completionId,
    operation: "readThread",
    projectId,
    read: true,
    sourceId: sources[0],
    threadId,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(["library.command", params]))
    .digest("hex");
  const directory = join(env.AREAL_HARNESS_SERVICE_HOME, "host/journals/records");
  const records = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const outcomes = await Promise.all(
    records.map(async (name) => {
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      return Object.values(record.snapshot?.outcomes ?? {});
    }),
  );
  const key = `${projectId}:${threadId}`;
  return outcomes.flat().filter((outcome) => {
    const item = outcome.receipt?.threads?.[key];
    return (
      outcome.method === "library.command" &&
      outcome.admissionState === "accepted" &&
      outcome.submissionUnknown === false &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(outcome.commandId) &&
      outcome.semanticDigest === digest &&
      item?.completionId === completionId &&
      item.unread === false
    );
  });
}
const project = (value) => value.projects.find((item) => item.root === workspace);
const current = (value) => {
  return project(value)?.state?.threads[primaryThreadId];
};
const until = async (read, label) => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Timeout: ${label}`);
};
console.log("Stop turn evidence:", scratch);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(receiptGate, "held");
  application = await applicationFixture(gui, join(scratch, "app"), bootstrap);
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" });
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "Desktop ready");
  if (rust) {
    await page.evaluate((domains) => {
      localStorage.setItem("areal.oneProtocol.reads", "1");
      localStorage.setItem(
        "areal.oneProtocol.domains",
        ["backend", "library", "tasks", "worktree", ...domains].join(","),
      );
    }, rustDomains);
    const stop = JSON.parse(
      execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
        env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
        encoding: "utf8",
      }),
    );
    await writeFile(join(scratch, "rust-bootstrap-stop.json"), JSON.stringify(stop, null, 2));
    assert.equal(stop.state, "completed");
    assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    await closeSmokeApplication(app);
    await assertApplicationStopped(binary, env, null);
    app = await electron.launch({
      executablePath: require("electron"),
      args: [application.path],
      env,
      timeout: 120000,
    });
    app.process().stderr.on("data", (chunk) => {
      void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" });
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.stack));
    await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
    await until(async () => (await snapshot()).connection?.state === "ready", "Rust desktop ready");
    await until(async () => {
      const record = await readFile(
        join(env.AREAL_HARNESS_SERVICE_HOME, "workbench/backend-launch.json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => null);
      return rustDomains.every((domain) => record?.options?.rustDomains?.includes(domain));
    }, "Rust backend launch domains");
  }
  // Rust Host 管理项目代际，旧桌面服务文件不是其身份。
  metadata = rust
    ? null
    : JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, "Project ready");
  await createProjectConversation(page, "workspace");
  await until(async () => {
    const target = project(await snapshot());
    return (
      target &&
      (await page.getByTestId("areal-workbench").getAttribute("data-project-id")) === target.id
    );
  }, "selected workspace conversation");
  await page.getByTestId("chat-input").fill("Keep streaming until I pause.");
  await page.getByTestId("chat-send-button").click();
  primaryThreadId = await until(async () => {
    const id = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    return id && project(await snapshot())?.state?.threads[id] ? id : null;
  }, "submitted workspace thread identity");
  await until(
    async () =>
      current(await snapshot())
        ?.turns.at(-1)
        ?.items.some(
          (item) => item.type === "agentMessage" && item.text?.includes("STOP_TURN_STREAMING"),
        ),
    "Streaming reply",
  );
  await page.bringToFront();
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until(
    async () => current(await snapshot())?.turns.at(-1)?.status === "interrupted",
    "Core interrupted",
  );
  await until(() => held.size === 0, "Provider stream closed");
  await until(
    async () => (await readFile(commandLog, "utf8")).includes("receiptHeld"),
    "Completed receipt held",
  );
  await page.locator('section[data-turn-status="interrupted"]').waitFor();
  assert.equal(await page.getByText("执行已暂停", { exact: true }).count(), 0);
  await page
    .locator(".turn-stop-heading[role='status']")
    .getByText("你暂停了本轮执行", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".turn-execution [role='status']").count(), 0);
  assert.equal(await page.getByText(/^命令资源/).count(), 0);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await until(async () => {
    const value = await snapshot();
    const stopped = current(value);
    return (
      stopped &&
      value.library.threads[`${project(value).id}:${stopped.id}`]?.completionId ===
        stopped.turns.at(-1)?.id
    );
  }, "Paused completion recorded");
  const pending = await snapshot();
  const stoppedThread = current(pending);
  const projectId = project(pending).id;
  const turnId = stoppedThread.turns.at(-1).id;
  if (snapshotCompletion) {
    const omitted = await until(async () => {
      const text = await readFile(omittedCompletionLog, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return text
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .find(
          (event) =>
            event.owned === true &&
            event.threadId === stoppedThread.id &&
            event.turnId === turnId &&
            typeof event.connectionId === "string" &&
            event.connectionId.length > 0,
        );
    }, "original turn completion omitted from owned Workbench connection");
    assert.equal(omitted.threadId, stoppedThread.id);
    assert.equal(
      omitted.turnId,
      turnId,
      "Snapshot fixture must omit the original turn completion from the owned Workbench connection",
    );
  }
  assert.equal(pending.library.threads[`${projectId}:${stoppedThread.id}`].completionId, turnId);
  assert.equal(
    pending.lifecycle.operations.some(
      (operation) =>
        operation.kind === "interruptTurn" &&
        operation.turnId === turnId &&
        operation.phase === "admissionUnconfirmed",
    ),
    true,
    "Original stop receipt remains unconfirmed at the render barrier",
  );
  await page.screenshot({ path: join(scratch, "after-stop.png") });
  await writeFile(join(scratch, "after-stop.json"), JSON.stringify(await snapshot(), null, 2));
  const stoppedBody = await page.locator("body").innerText();
  console.log(
    /此任务的原后台操作尚未结算/.test(stoppedBody)
      ? "FAIL: pause shows 此任务的原后台操作尚未结算，请检查原请求"
      : "PASS: pause shows no lifecycle error",
  );
  assert.doesNotMatch(
    stoppedBody,
    /此任务的原后台操作尚未结算/,
    "Stopping a turn must not show a stale lifecycle error",
  );
  const historyRequest = { projectId, threadId: stoppedThread.id, viewId: "pause-history-view" };
  for (const [operation, expected] of [
    ["acquire", "supported"],
    ["loadOlder", "data"],
    ["loadItem", "loaded"],
    ["release", "released"],
  ]) {
    const result = await page.evaluate(
      (request) => window.arealDesktop.command("history", request),
      {
        ...historyRequest,
        operation,
        ...(operation === "loadItem" ? { itemId: "absent-item" } : {}),
      },
    );
    assert.equal(
      result.ok,
      true,
      `History ${operation} remains readable during interruption settlement`,
    );
    assert.ok(
      Object.hasOwn(result.value, expected),
      `History ${operation} executes its handler during settlement`,
    );
  }
  const unconfirmedSend = await page.evaluate(
    ({ projectId, threadId }) =>
      window.arealDesktop.command("send", {
        projectId,
        threadId,
        text: "Must remain blocked until original receipt arrives.",
      }),
    { projectId, threadId: stoppedThread.id },
  );
  assert.equal(unconfirmedSend.ok, false, "Unconfirmed interruption still guards new execution");
  assert.equal(unconfirmedSend.error.code, "LIFECYCLE_INCOMPLETE");
  assert.equal(requests.length, 1, "Blocked send never reaches the model");
  const followup = "Continue with a new message after pause.";
  const draftKey = `areal-gui:draft:${projectId}:${stoppedThread.id}`;
  const continueDisabled = await page.getByTestId("chat-continue-button").isDisabled();
  await page.getByTestId("chat-input").fill(followup);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const beforeFollowup = await snapshot();
  const sendDisabled = await page.getByTestId("chat-send-button").isDisabled();
  await writeFile(
    join(scratch, "before-followup.json"),
    JSON.stringify(
      { snapshot: beforeFollowup, sendDisabled, providerRequests: requests.length },
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(scratch, "before-followup.png") });
  assert.equal(
    beforeFollowup.lifecycle.operations.some(
      (operation) =>
        operation.kind === "interruptTurn" &&
        operation.turnId === turnId &&
        operation.phase === "admissionUnconfirmed",
    ),
    true,
    "Terminal Core turn still awaits its original interruption receipt",
  );
  assert.equal(
    sendDisabled,
    true,
    "Follow-up submission waits for the original interruption receipt after the turn becomes terminal",
  );
  assert.equal(
    continueDisabled,
    true,
    "Empty-draft continuation waits for the same original interruption receipt",
  );
  await page.getByTestId("chat-input").press("Enter");
  await page
    .getByTestId("chat-input")
    .press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    (await page.getByTestId("chat-input").textContent()).trim(),
    followup,
    "Enter preserves the visible follow-up draft while interruption settlement is pending",
  );
  await openSideChat(page);
  const preservedDraft = await page.evaluate((key) => localStorage.getItem(key), draftKey);
  assert.equal(
    preservedDraft?.trim(),
    followup,
    "Enter preserves the follow-up draft while interruption settlement is pending",
  );
  const sideDraft = page.getByTestId("side-chat-input");
  await sideDraft.fill("Side draft while the original project pause is pending.");
  assert.equal(
    await page.getByTestId("side-chat-send").isDisabled(),
    true,
    "The same project interruption also blocks Side submission",
  );
  await sideDraft.press("Enter");
  await page.screenshot({ path: join(scratch, "pending-side-draft.png") });
  const childId = await page
    .getByTestId("side-chat-pane")
    .filter({ visible: true })
    .getAttribute("data-thread-id");
  assert.equal(
    project(await snapshot()).state.threads[childId].turns.length,
    0,
    "Pending interruption keeps the eager child empty",
  );
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  assert.equal(
    (await page.getByTestId("chat-input").innerText()).trim(),
    followup,
    "Returning from Side preserves the pending main draft",
  );
  const beforeRelease = (await readFile(commandLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(
    beforeRelease.filter((item) => item.name === "send").length,
    2,
    "Enter submits no command while the original interruption receipt is pending",
  );
  const childCreates = beforeRelease.filter(
    (item) => item.name === "side" && item.request.operation === "create",
  );
  assert.equal(childCreates.length, 1, "Opening Side admits one distinct empty child");
  assert.equal(
    childCreates[0].request.firstInput,
    undefined,
    "Pending project interruption admits no child first input",
  );
  assert.equal(
    beforeRelease.filter((item) => item.name === "side" && item.request.operation === "send")
      .length,
    0,
    "Pending project interruption does not submit a Side turn",
  );
  assert.equal(requests.length, 1, "Pending interruption admits no follow-up model request");
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /此任务的原后台操作尚未结算/,
    "Waiting to send must not surface a lifecycle rejection",
  );
  if (rust)
    assert.equal(
      (await acceptedCompletionReads(projectId, stoppedThread.id, turnId)).length,
      0,
      "No completion read is accepted before the original stop settles",
    );
  await rm(receiptGate);
  await until(
    async () =>
      rust
        ? (await acceptedCompletionReads(projectId, stoppedThread.id, turnId)).length > 0 &&
          (await snapshot()).library.threads[`${projectId}:${stoppedThread.id}`]?.unread === false
        : (await readFile(commandLog, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse)
            .some(
              (item) =>
                item.name === "library" &&
                item.request.operation === "readThread" &&
                item.request.completionId &&
                item.ok,
            ),
    "Automatic read after settlement",
  );
  assert.equal(
    (await snapshot()).library.threads[`${projectId}:${stoppedThread.id}`].unread,
    false,
    "Settled completion becomes read",
  );
  assert.ok(
    (await snapshot()).lifecycle.operations.some(
      (operation) =>
        operation.kind === "interruptTurn" &&
        operation.turnId === turnId &&
        operation.phase === "completed",
    ),
    "Original interruption has settled before the completion read",
  );
  const commands = (await readFile(commandLog, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const stopCommands = commands.filter((item) => item.name === "stop");
  assert.equal(stopCommands.length, 1, "Original stop is never replayed");
  assert.equal(
    stopCommands[0].request.turnId,
    turnId,
    "Original stop keeps its exact turn identity",
  );
  assert.equal(
    commands.filter(
      (item) => item.name === "library" && item.request.completionId === turnId && item.error,
    ).length,
    0,
    "Automatic completion read is deferred until settlement",
  );
  const historyCommands = commands.filter((item) => item.name === "history");
  assert.equal(
    historyCommands.some((item) => item.error),
    false,
    "History view lifecycle never becomes a rejected execution command",
  );
  const markUnread = await page.evaluate(
    (request) => window.arealDesktop.command("library", request),
    { operation: "readThread", projectId, threadId: stoppedThread.id, read: false },
  );
  assert.equal(markUnread.ok, true, "Explicit unread change is accepted after settlement");
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = await page.evaluate(
      (request) => window.arealDesktop.command("open", request),
      { projectId, threadId: stoppedThread.id },
    );
    assert.equal(observed.ok, true, "The same terminal history can be observed again");
  }
  const repeated = (await snapshot()).library.threads[`${projectId}:${stoppedThread.id}`];
  assert.equal(
    repeated.completionId,
    turnId,
    "Re-observing terminal history keeps the exact completion",
  );
  assert.equal(repeated.unread, true, "Re-observing the same completion preserves explicit unread");
  await until(
    async () => !(await page.getByTestId("chat-send-button").isDisabled()),
    "Follow-up submission enabled after original receipt settlement",
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    preservedDraft,
    "Settling the interruption preserves the draft without automatically submitting it",
  );
  assert.equal(requests.length, 1, "Receipt settlement does not replay the follow-up");
  await page.getByTestId("chat-send-button").click();
  await until(
    async () =>
      requests.length === 2 ||
      (await page.locator("body").innerText()).includes("此任务的原后台操作尚未结算"),
    "Next send or lifecycle error",
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /此任务的原后台操作尚未结算/,
    "Stopping a turn must not show a stale lifecycle error",
  );
  assert.equal(requests.length, 2, "A settled pause permits the next user message");
  await until(
    async () =>
      (await readFile(commandLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .some((item) => item.name === "send" && item.request.text === preservedDraft && item.ok),
    "Preserved follow-up accepted after settlement",
  );
  const settledCommands = (await readFile(commandLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(
    settledCommands.filter(
      (item) => item.name === "send" && item.request.text === preservedDraft && item.ok,
    ).length,
    1,
    "The preserved follow-up is accepted exactly once",
  );
  assert.equal(
    settledCommands.filter((item) => item.name === "stop").length,
    1,
    "Follow-up admission does not resubmit the original interruption",
  );
  checks.push(
    "UI pause interrupts Core, closes the model stream, and permits the next message without a lifecycle error",
  );
  console.log("PASS: pause permits the next message without a lifecycle error");
  assert.deepEqual(errors, [], "No renderer or model fixture errors");
  passed = true;
} catch (error) {
  failure = error.stack;
  console.error(error.message);
  if (page) {
    await writeFile(
      join(scratch, "failure-snapshot.json"),
      JSON.stringify(await snapshot(), null, 2),
    ).catch(() => {});
    await captureSmokeFailure(page, scratch, error);
  }
} finally {
  await rm(receiptGate, { force: true });
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async (...args) => ({
          response: ["确认取消后台任务？", "退出 AReaL Harness？"].includes(args.at(-1).message)
            ? 1
            : (args.at(-1).cancelId ?? 0),
        });
      })
      .catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
  }
  await application?.close();
  try {
    if (!rust) await assertApplicationStopped(binary, env, metadata);
    cleanup = "passed";
  } catch (error) {
    cleanup = error.stack;
    passed = false;
  }
  if (rust) {
    try {
      const stop = JSON.parse(
        execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
          env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
          encoding: "utf8",
        }),
      );
      await writeFile(join(scratch, "rust-final-stop.json"), JSON.stringify(stop, null, 2));
      assert.equal(stop.state, "completed");
      assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
      await assertApplicationStopped(binary, env, null);
      const entries = await cleanupSyntheticHostKeychain(env.AREAL_HARNESS_SERVICE_HOME, scratch);
      await writeFile(
        join(scratch, "synthetic-keychain-cleanup.json"),
        JSON.stringify(entries, null, 2),
      );
    } catch (error) {
      errors.push(`Rust cleanup: ${error.message}`);
      passed = false;
    }
  }
  for (const response of held) response.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  assert.equal(await hash(), coreHash, "Core binary stays unchanged");
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        source,
        guiDiffHash,
        binary,
        coreHash,
        snapshotCompletion,
        checks,
        failure,
        cleanup,
        errors,
        boundaries:
          "Source Electron and real Core. Deterministic loopback model. A file barrier holds the completed stop receipt through the paused UI render, then explicitly releases it. Optional fixture omits the original completion notification from the owned Workbench desktop projection; Renderer Host subscriptions may still receive it. History handler and unread checks also use the public bridge. Native folder picker stubbed. No packaged app or physical input.",
      },
      null,
      2,
    ),
  );
  console.log("Stop turn result:", passed ? "PASS" : "FAIL");
  if (!passed) process.exitCode = 1;
}
