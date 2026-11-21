import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
  stopFixtureHost,
} from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";
import { openProjectInDesktop, sendReady } from "./support/journey-fixture.mjs";
import { readCoreThread, withCore } from "./support/core-observation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
const failList = process.env.AREAL_SEND_LIST_FAILURE === "1";
assert.ok(binary && isAbsolute(binary), "Set AREAL_CORE_BIN to an absolute fixed Core binary");
const scratch = await makeTempDir("send-admission-");
const workspace = join(scratch, "demo");
await Promise.all([mkdir(workspace), mkdir(join(scratch, "user"))]);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: join(scratch, "user"),
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
const requests = [],
  errors = [],
  checks = [];
const originalText = "Send this exact first message once while the conversation list is held.";
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "SEND_ADMISSION_COMPLETE" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
const trace = [];
const commands = [];
const errorReply = (id, code, message) =>
  JSON.stringify({ version: 1, id, error: { code, message } });
let holdDirectory = false;
let directory;
let gate;
let hideCreationReceipt = false;

// 只拦截本次明确选择的 Host 帧，不记录握手票据，也不在清理时释放未派发的写入。
function proxyHostSocket(socket) {
  const remote = socket.connectToServer();
  const replies = new Map();
  const disconnect = () => void Promise.allSettled([socket.close(), remote.close()]);
  socket.onMessage((message) => {
    const frame = JSON.parse(message.toString());
    const { id, method, commandId, params, context } = frame;
    const creationId = gate?.method === "session.create" && gate.dropped && gate.command.commandId;
    const creationCommandRead = method === "command.read" && params?.commandId === creationId;
    const creationWorktreeRead =
      method === "worktree.read" &&
      params?.operation === "worktreeRead" &&
      params.requestId === creationId;
    if (creationId && (creationCommandRead || creationWorktreeRead)) {
      replies.set(id, (reply, bytes) => {
        const ready = creationCommandRead
          ? reply.result?.admissionState === "accepted"
          : reply.result?.state === "ready";
        const hidden = hideCreationReceipt && ready;
        trace.push({ method, id, commandId: creationId, ready, hidden });
        if (!hidden) return socket.send(bytes);
        const { threadId: _threadId, ...record } = reply.result;
        const result = creationCommandRead
          ? { commandId: creationId, admissionState: "unknown", submissionUnknown: true }
          : { ...record, state: "unknown" };
        socket.send(JSON.stringify({ version: 1, id, result }));
      });
    }
    if (method === "shell.subscribe" && holdDirectory && !directory) {
      const held = { id };
      directory = held;
      replies.set(id, (reply, bytes) => {
        held.received = !reply.error;
        trace.push({ method, id, phase: "held", result: held.received ? "ready" : "error" });
        held.release = () => {
          held.released = true;
          socket.send(
            failList ? errorReply(id, "CORE_UNAVAILABLE", "Fixture directory read failed") : bytes,
          );
        };
      });
    }
    if (method !== "session.create" && method !== "session.send") {
      remote.send(message);
      return;
    }
    const command = { id, method, commandId, params, context };
    commands.push(command);
    const selected = gate?.method === method && !gate.command ? gate : undefined;
    replies.set(id, (reply, bytes) => {
      command.result = reply.result;
      command.error = reply.error;
      if (
        selected &&
        !selected.mode &&
        method === "session.create" &&
        reply.result?.admissionState === "accepted"
      )
        holdDirectory = true;
      if (
        selected?.mode === "lost-after-acceptance" &&
        reply.result?.admissionState === "accepted"
      ) {
        selected.dropped = true;
        disconnect();
      } else socket.send(bytes);
    });
    if (!selected) {
      remote.send(message);
      return;
    }
    selected.command = command;
    selected.release = () => {
      if (selected.mode === "reject") {
        selected.rejected = true;
        socket.send(errorReply(id, "FORBIDDEN", "Fixture rejected send before dispatch"));
      } else if (selected.mode === "unknown") {
        selected.dropped = true;
        disconnect();
      } else remote.send(message);
    };
  });
  remote.onMessage((bytes) => {
    const reply = JSON.parse(bytes.toString());
    const handle = replies.get(reply.id);
    if (!handle) socket.send(bytes);
    else {
      replies.delete(reply.id);
      handle(reply, bytes);
    }
  });
}

const hash = async () =>
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
const coreHash = await hash();
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const guiDiffHash = createHash("sha256")
  .update(execFileSync("git", ["diff", "HEAD", "--", "clients/gui"], { cwd: root }))
  .digest("hex");
let app, page, originalHost, electronPid, stopReceipt, failure;
let passed = false;
async function until(read, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}

const editorText = async () =>
  (await page.getByTestId("chat-input").innerText()).replaceAll("\u200b", "").trim();
const capture = (name) => page.screenshot({ path: join(scratch, `${name}.png`) });
async function readJournal(projectId) {
  const { HostClient } = require("@areal/client/node");
  const client = new HostClient();
  try {
    await client.connect(env.AREAL_HARNESS_SERVICE_HOME);
    assert.equal(client.hostId, originalHost.hostId);
    assert.equal(client.generation, originalHost.generation);
    return (await client.journal(projectId).read()).snapshot;
  } finally {
    client.close();
  }
}
async function accepted(command) {
  const result = await until(
    () => command.result || command.error,
    `${command.method} original reply`,
  );
  assert.equal(result.admissionState, "accepted");
  assert.equal(result.commandId, command.commandId);
  assert.ok(result.operationId);
  if (command.method === "session.send") {
    const journal = await readJournal(command.context.projectId);
    const durable = journal.outcomes[result.operationId];
    assert.equal(durable?.remote?.commandId, command.commandId);
    assert.equal(durable.admissionState, "accepted");
  }
  return result;
}

console.log("Send admission evidence:", scratch);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  app = await electron.launch({
    executablePath: require("electron"),
    args: [
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      join(gui, "app"),
      ...(process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
    ],
    env,
    timeout: 120000,
  });
  electronPid = app.process().pid;
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  const ready = page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]');
  await ready.waitFor({ timeout: 120000 });
  originalHost = await until(async () => {
    const descriptor = await readFixtureHost(env);
    return descriptor?.pid > 1 ? descriptor : false;
  }, "Isolated Host identity published");
  await page.routeWebSocket(/\/host\/socket$/, proxyHostSocket);
  await page.evaluate(() =>
    localStorage.setItem(
      "areal-gui:application-preferences",
      JSON.stringify({
        locale: "zh-CN",
        nextPromptSuggestions: false,
      }),
    ),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready.waitFor();
  await openProjectInDesktop(app, page, workspace);
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  const workbench = page.getByTestId("areal-workbench");
  const input = page.getByTestId("chat-input");
  const send = page.getByTestId("chat-send-button");
  const preview = page.getByTestId("pending-message");
  const userBubble = (text) => page.locator(".user-message-body").filter({ hasText: text });
  gate = { method: "session.create" };
  await input.fill(originalText);
  await sendReady(page);
  await send.click();
  const create = await until(() => gate.command, "Original session.create intercepted");
  await preview.waitFor();
  assert.equal(await editorText(), "");
  assert.equal(await preview.locator(".user-bubble").innerText(), originalText);
  assert.match(await preview.getByRole("status").innerText(), /正在启动聊天|Starting your chat/);
  assert.equal(requests.length, 0);
  await capture("create-pending");
  gate.release();
  const creation = await accepted(create);
  const threadId = creation.threadId;
  const readThread = () => readCoreThread({ binary, env, gui, workspace, threadId });
  async function completedTurn(result, text) {
    assert.equal(result.threadId, threadId);
    assert.ok(result.turnId);
    const turn = await until(
      async () =>
        (await readThread()).turns.find(
          (value) =>
            value.id === result.turnId &&
            value.status === "completed" &&
            value.items.some(
              (item) =>
                item.type === "userMessage" && item.content.some((part) => part.text === text),
            ),
        ),
      "Original Core Turn is completed",
    );
    assert.ok(
      turn.items.some(
        (item) => item.type === "agentMessage" && item.text.includes("SEND_ADMISSION_COMPLETE"),
      ),
    );
    await userBubble(text).waitFor();
    assert.equal(await userBubble(text).count(), 1);
  }
  const projectId = create.context.projectId;
  assert.equal(create.params.worktree?.mode ?? "source", "source");
  assert.equal(creation.receipt.result.executionProjectId, projectId);
  assert.equal(creation.nativeRequestId, create.commandId);
  await withCore({ binary, env, gui, workspace, threadId }, async (client) => {
    const { data } = await client.request("areal/request/read", { requestId: create.commandId });
    assert.equal(data.length, 1);
    assert.equal(data[0].requestId, create.commandId);
    assert.equal(data[0].method, "areal/thread/start");
    assert.equal(data[0].threadId, threadId);
    assert.equal(data[0].status, "completed");
    assert.equal(data[0].operation.target.threadId, threadId);
  });
  await until(() => directory?.received, "Post-create shell response is held");
  const first = await until(
    () => commands.find((item) => item.method === "session.send"),
    "First send while the directory response is still held",
  );
  assert.equal(first.params.text, originalText);
  assert.equal(first.context.projectId, projectId);
  await completedTurn(await accepted(first), originalText);
  assert.equal(directory.released, undefined);
  assert.equal(await editorText(), "");
  assert.equal(await workbench.getAttribute("data-thread-id"), threadId);
  assert.equal(requests.length, 1);
  assert.equal(commands.filter((item) => item.method === "session.create").length, 1);
  const userMessages = requests[0].messages
    .filter((message) => message.role === "user")
    .map(({ content }) =>
      typeof content === "string" ? content : content.map((part) => part.text).join("\n"),
    )
    .filter((text) => !text.startsWith("AReaL runtime context (not a user request):"));
  assert.deepEqual(userMessages, [originalText]);
  await capture("directory-held");
  directory.release();
  holdDirectory = false;
  checks.push(
    "Original source creation and first send settle once in Host and Core while the post-create shell response is held",
  );

  const draftKey = `areal-gui:draft:${await workbench.getAttribute("data-project-id")}:${threadId}`;
  const draft = (suffix = "") =>
    page.evaluate((key) => localStorage.getItem(key), draftKey + suffix);
  for (const mode of ["lost-after-acceptance", "pass", "reject", "unknown"]) {
    const text = `Submission feedback ${mode}`;
    const count = requests.length;
    gate = { method: "session.send", mode };
    await input.fill(text);
    await page.locator("input[type=file]").setInputFiles({
      name: "message.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retained attachment"),
    });
    await send.click();
    const command = await until(() => gate.command, `Original send held: ${mode}`);
    assert.equal(command.params.text, text);
    assert.equal(command.params.threadId, threadId);
    assert.ok(command.params.attachments?.length);
    await preview.waitFor();
    assert.equal(await editorText(), "");
    assert.match(await preview.innerText(), /message.txt/);
    assert.match(await preview.locator(".user-bubble").innerText(), new RegExp(text));
    assert.equal(await page.getByTestId("composer-attachments").isVisible(), false);
    assert.equal(await draft(), text);
    assert.equal(requests.length, count);
    await input.press("Enter");
    await capture(`send-pending-${mode}`);
    gate.release();
    await preview.waitFor({ state: "detached" });

    if (mode === "pass" || mode === "lost-after-acceptance") {
      await completedTurn(await accepted(command), text);
      assert.equal(requests.length, count + 1);
      if (mode === "lost-after-acceptance") {
        assert.equal(gate.dropped, true);
        await page.reload();
        await input.waitFor();
        await userBubble(text).waitFor();
        await until(
          async () => (await editorText()) !== text || (await send.isDisabled()),
          "Accepted text cannot be resubmitted after reload",
        );
        assert.equal(await userBubble(text).count(), 1);
      } else {
        assert.equal(await editorText(), "");
        await page.getByTestId("chat-input").focus();
        await app.evaluate(async ({ BrowserWindow }) => {
          const debug = BrowserWindow.getAllWindows()[0].webContents.debugger;
          debug.attach("1.3");
          await debug.sendCommand("Input.imeSetComposition", {
            text: "你好",
            selectionStart: 2,
            selectionEnd: 2,
          });
        });
        try {
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-testid="chat-input"]')
                .textContent.replaceAll("\u200b", "") === "你好",
          );
          assert.equal(
            await page.evaluate((key) => localStorage.getItem(key), draftKey),
            null,
            "Uncommitted input after send stays out of recovery storage",
          );
          await app.evaluate(async ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand("Input.insertText", {
              text: "你好",
            }),
          );
          await page.waitForFunction((key) => localStorage.getItem(key) === "你好", draftKey);
          assert.equal(
            requests.length,
            count + 1,
            "Committing an input-method candidate never sends it",
          );
          checks.push(
            "After send, native Chromium composition remains local until commitment and never triggers submission",
          );
        } finally {
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.debugger.detach(),
          );
        }
      }
    } else {
      assert.equal(mode === "reject" ? gate.rejected : gate.dropped, true);
      await until(async () => (await editorText()) === text, "Original unaccepted draft restored");
      assert.equal(await page.getByTestId("composer-attachments").isVisible(), true);
      const journal = await readJournal(projectId);
      assert.ok(
        ![...journal.pending, ...Object.values(journal.outcomes)].some(
          (row) => row.remote?.commandId === command.commandId,
        ),
      );
      if (mode === "unknown") {
        assert.equal(await draft(":pending"), command.commandId);
        await page.reload();
        await input.waitFor();
        await until(async () => (await editorText()) === text, "UNKNOWN draft survives reload");
        assert.equal(await draft(":pending"), command.commandId);
        assert.equal(await send.isDisabled(), true);
      }
    }
    assert.equal(
      commands.filter((item) => item.method === "session.send" && item.params.text === text).length,
      1,
    );
    assert.equal(
      requests.length,
      count + (["pass", "lost-after-acceptance"].includes(mode) ? 1 : 0),
    );
    checks.push(
      `${mode}: original Host command identity, pending transcript, draft attachments and no replay`,
    );
  }
  await createProjectConversation(page, "demo");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  const lostCreationText = "Keep this draft unsent when the original creation reply is lost.";
  const modelCount = requests.length;
  const commandCount = commands.length;
  gate = { method: "session.create", mode: "lost-after-acceptance" };
  hideCreationReceipt = true;
  await input.fill(lostCreationText);
  await sendReady(page);
  await send.click();
  const lostCreate = await until(() => gate.command, "Original creation before lost reply");
  gate.release();
  const lostReceipt = await accepted(lostCreate);
  assert.equal(gate.dropped, true);
  const pendingKey = `areal-gui:draft:${await workbench.getAttribute("data-project-id")}:new:pending-create`;
  const pendingCreateId = () => page.evaluate((key) => localStorage.getItem(key), pendingKey);
  const pendingAction = page.getByRole("button", { name: "操作待确认", exact: true });
  const checkStatus = page.getByRole("menuitem", { name: "检查操作状态", exact: true });
  await pendingAction.waitFor();
  assert.equal(await pendingCreateId(), lostCreate.commandId);
  assert.equal(await send.isDisabled(), true);
  assert.equal(await editorText(), lostCreationText);
  await pendingAction.click();
  await checkStatus.click();
  const readSeen = (method, hidden) =>
    trace.some(
      (entry) =>
        entry.commandId === lostCreate.commandId &&
        entry.method === method &&
        entry.ready &&
        entry.hidden === hidden,
    );
  await until(
    () => readSeen("command.read", true) && readSeen("worktree.read", true),
    "Both original creation reads are hidden",
  );
  await pendingAction.click();
  await page.getByRole("menuitem", { name: "保留原结果，返回草稿", exact: true }).waitFor();
  assert.equal(await pendingCreateId(), lostCreate.commandId);
  assert.equal(await send.isDisabled(), true);
  assert.equal(requests.length, modelCount);
  hideCreationReceipt = false;
  await checkStatus.click();
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
    lostReceipt.threadId,
  );
  await until(
    async () => (await editorText()) === lostCreationText,
    "Original unsent draft restores in its Thread",
  );
  assert.equal(await pendingCreateId(), null);
  assert.equal(readSeen("command.read", false), true);
  const restored = await readCoreThread({
    binary,
    env,
    gui,
    workspace,
    threadId: lostReceipt.threadId,
  });
  assert.deepEqual(restored.turns, []);
  assert.equal(commands.length, commandCount + 1);
  assert.equal(requests.length, modelCount);
  await capture("creation-recovered");
  checks.push(
    "A lost creation reply keeps the same draft locked until the original Host receipt restores its empty Thread",
  );

  await createProjectConversation(page, "demo");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  const retainedText = "Keep the original UNKNOWN creation for inspection.";
  const beforeRetain = commands.length;
  gate = { method: "session.create", mode: "lost-after-acceptance" };
  hideCreationReceipt = true;
  await input.fill(retainedText);
  await sendReady(page);
  await send.click();
  const original = await until(() => gate.command, "Original retained creation");
  gate.release();
  const originalReceipt = await accepted(original);
  await pendingAction.waitFor();
  assert.equal(gate.dropped, true);
  const frozenKey = pendingKey + "-request";
  const frozen = await page.evaluate((key) => localStorage.getItem(key), frozenKey);
  assert.equal(JSON.parse(frozen).requestId, original.commandId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await pendingAction.waitFor();
  assert.equal(await pendingCreateId(), original.commandId);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), frozenKey), frozen);
  assert.equal(await editorText(), retainedText);
  assert.equal(await send.isDisabled(), true);

  await pendingAction.click();
  await checkStatus.click();
  await until(
    () =>
      ["command.read", "worktree.read"].every((method) =>
        trace.some(
          (entry) =>
            entry.commandId === original.commandId && entry.method === method && entry.hidden,
        ),
      ),
    "Both exact original receipts remain hidden after reload",
  );
  await pendingAction.click();
  const retain = page.getByRole("menuitem", { name: "保留原结果，返回草稿", exact: true });
  const confirm = page.waitForEvent("dialog").then(async (dialog) => {
    assert.equal(dialog.type(), "confirm");
    await dialog.accept();
  });
  await Promise.all([confirm, retain.click()]);
  await sendReady(page);
  const retainedKey = pendingKey.replace(
    ":pending-create",
    `:retained-create:${original.commandId}`,
  );
  const retained = await page.evaluate(
    ({ pendingKey, frozenKey, retainedKey }) => ({
      pending: localStorage.getItem(pendingKey),
      frozen: localStorage.getItem(frozenKey),
      retained: JSON.parse(localStorage.getItem(retainedKey)),
    }),
    { pendingKey, frozenKey, retainedKey },
  );
  assert.deepEqual(retained, {
    pending: null,
    frozen: null,
    retained: { requestId: original.commandId, request: frozen },
  });
  assert.equal(await editorText(), retainedText);
  const originalThread = await readCoreThread({
    binary,
    env,
    gui,
    workspace,
    threadId: originalReceipt.threadId,
  });
  assert.deepEqual(originalThread.turns, []);
  assert.equal(commands.length, beforeRetain + 1);
  assert.equal(requests.length, modelCount);
  await capture("creation-retained");
  checks.push(
    "An own UNKNOWN creation stays locked after reload, then retaining it frees the original draft without touching its Host result or sending",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = error.stack;
  console.error(failure);
  if (page) await captureSmokeFailure(page, scratch, error).catch(() => {});
} finally {
  // 显式结算本次 fixture 的 Host，不把空闲释放意图当成停止回执。
  if (originalHost) {
    try {
      const descriptor = await readFixtureHost(env);
      assert.equal(descriptor?.hostId, originalHost.hostId);
      assert.equal(descriptor.generation, originalHost.generation);
      stopReceipt = await stopFixtureHost(binary, env.AREAL_HARNESS_SERVICE_HOME, scratch);
      assert.equal(stopReceipt?.state, "completed");
    } catch (error) {
      errors.push(`Host stop: ${error.message}`);
    }
  }
  if (app) {
    await withSmokeDeadline("Electron quit preparation", () =>
      app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0 });
      }),
    ).catch((error) => errors.push(error.message));
    try {
      await closeSmokeApplication(app, 60000);
    } catch (error) {
      errors.push(`Electron cleanup: ${error.message}`);
    }
  }
  try {
    if (originalHost)
      await assertApplicationStopped(binary, env, { pid: electronPid, hostPid: originalHost.pid });
    else stopReceipt = await settleFixtureHostAfterQuit(binary, env, scratch, { pid: electronPid });
  } catch (error) {
    errors.push(`Host cleanup: ${error.message}`);
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  assert.equal(await hash(), coreHash, "Core binary stays unchanged");
  passed &&= errors.length === 0;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        source,
        guiDiffHash,
        binary,
        coreHash,
        failList,
        electronPid,
        hostPid: originalHost?.pid,
        stopRequestId: stopReceipt?.requestId,
        checks,
        trace,
        commands,
        modelRequests: requests.length,
        failure,
        errors,
      },
      null,
      2,
    ),
  );
  console.log("Send admission result:", passed ? "PASS" : "FAIL");
  if (!passed) process.exitCode = 1;
}
