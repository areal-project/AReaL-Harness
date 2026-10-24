import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createProjectConversation, selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const WebSocket = require("ws");
const { ServiceConnection, waitForServiceExit } = require("../app/src/core/service-client.cjs");
const binary = process.env.AREAL_CORE_BIN || join(root, ".local/dev-bin/areal");
assert.ok(isAbsolute(binary), "AREAL_CORE_BIN must identify an absolute Core path");
assert.equal(process.env.AREAL_GUI_EXECUTABLE, undefined, "Thread schedules acceptance uses source Electron");
const sha = value => createHash("sha256").update(value).digest("hex");
const evidenceRoot = process.env.AREAL_THREAD_SCHEDULE_EVIDENCE || join(root, ".scratch/thread-schedules/acceptance");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "run-"));
const stateRoot = await mkdtemp("/private/tmp/ts-");
const owner = randomUUID();
await writeFile(join(stateRoot, ".owner"), owner);
const workspace = join(stateRoot, "workspace");
const userHome = join(stateRoot, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const binaryHash = sha(await readFile(binary));
const checks = [], errors = [], requests = [], frames = [], held = new Set();
const facts = { startedAt: new Date().toISOString(), workspace, stateRoot, ui: {}, protocol: {} };
const objectives = { A: "THREAD_SCHEDULE_A 检查项目提交并汇报", B: "THREAD_SCHEDULE_B HOLD 检查未完成事项", C: "THREAD_SCHEDULE_C 独立工作目录检查" };
const initialSchedule = { version: 1, rule: { kind: "intervalIso", atIso: "2040-01-02T09:00:00+08:00", intervalSeconds: 86400 }, misfire: { kind: "skip", maxLatenessSeconds: 300 }, overlap: "skip" };
const changedSchedule = { ...initialSchedule, rule: { ...initialSchedule.rule, atIso: "2040-01-05T09:00:00+08:00" } };
const text = message => typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n");
let creationBarrier, fixtureFailure, forbiddenTarget;
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    if (body.messages?.some(message => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Predict the next user prompt from the conversation data."))) {
      assert.ok(!body.tools?.length, "prompt prediction must not receive tools");
      facts.predictionRequests = (facts.predictionRequests ?? 0) + 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (body.stream === false) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    requests.push(body);
    const messages = body.messages ?? [];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    const end = () => {
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    };
    const finish = content => { send({ content }); send({}, "stop"); end(); };
    const tool = (name, args) => {
      assert.ok(body.tools?.some(entry => entry.function?.name === name), `ordinary Thread advertises ${name}`);
      send({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      send({}, "tool_calls");
      end();
    };
    const context = messages.map(text).findLast(value => value.includes("Current authoritative goal: "));
    if (context) {
      const view = JSON.parse(context.split("Current authoritative goal: ").at(-1));
      const goal = view.goal;
      if (goal.limitsPending) { tool("goal_set_limits", { expectedRevision: view.revision, sources: {} }); return; }
      if (goal.objective.includes("HOLD")) {
        send({ content: "THREAD_SCHEDULE_BUSY 等待删除时停止本次执行。" });
        held.add(response);
        response.on("close", () => held.delete(response));
        return;
      }
      if (!messages.some(message => (message.tool_calls ?? []).some(call => call.function?.name === "run_command"))) {
        tool("run_command", { argv: ["printf", "%s\\n", "THREAD_SCHEDULE_RUNTIME_OK"], cwd: "workspace://repo", timeoutMs: 5000 });
        return;
      }
      assert.ok(messages.some(message => message.role === "tool" && text(message).includes("THREAD_SCHEDULE_RUNTIME_OK")), "scheduled Run receives actual Runtime command output");
      if (goal.report?.status !== "complete") {
        tool("goal_update", { expectedRevision: view.revision, status: "complete", summary: "THREAD_SCHEDULE_RUN_COMPLETE", evidence: ["Run started through the saved schedule control."], remaining: [] });
        return;
      }
      finish("THREAD_SCHEDULE_RUN_COMPLETE");
      return;
    }
    const lastUser = messages.findLastIndex(message => message.role === "user" && !text(message).startsWith("AReaL runtime context"));
    const prompt = text(messages[lastUser] ?? {});
    const turn = messages.slice(lastUser + 1);
    const results = turn.filter(message => message.role === "tool").map(message => {
      const call = turn.flatMap(message => message.tool_calls ?? []).find(call => call.id === message.tool_call_id);
      return { name: call?.function?.name, value: JSON.parse(text(message)) };
    });
    if (prompt.includes("THREAD_SCHEDULE_FORBIDDEN")) {
      const listed = results.find(result => result.name === "scheduled_task_list");
      if (!listed) { tool("scheduled_task_list", {}); return; }
      assert.deepEqual(listed.value.tasks, [], "another ordinary source Thread cannot list sibling schedules in the same project");
      const denied = results.find(result => result.name === "scheduled_task_update");
      if (!denied) { tool("scheduled_task_update", { taskId: forbiddenTarget.id, expectedRevision: forbiddenTarget.revision, objective: "UNAUTHORIZED_SCHEDULE_CHANGE" }); return; }
      assert.equal(denied.value.error?.reason, "PERMISSION_DENIED");
      assert.equal(denied.value.error?.outcome?.kind, "rejected");
      facts.ui.crossSourceRejection = denied.value;
      finish("THREAD_SCHEDULE_SCOPE_REJECTION_CONFIRMED");
      return;
    }
    for (const result of results) assert.equal(result.value.error, undefined, `scheduled tool succeeds: ${JSON.stringify(result)}`);
    const create = prompt.match(/THREAD_SCHEDULE_CREATE_([ABC])/);
    if (create) {
      const key = create[1];
      const result = results.find(result => result.name === "scheduled_task_create");
      if (result) {
        assert.equal(result.value.task.objective, objectives[key]);
        assert.ok(result.value.receipt.requestId);
        finish(`THREAD_SCHEDULE_SAVED_${key}`);
        return;
      }
      assert.ok(body.tools?.some(entry => entry.function?.name === "scheduled_task_create"), "ordinary Thread advertises scheduled_task_create");
      const release = () => tool("scheduled_task_create", { objective: objectives[key], scheduleV2: initialSchedule });
      if (key === "A") {
        send({ content: "已了解检查方法，正在保存安排。" });
        held.add(response);
        response.on("close", () => held.delete(response));
        creationBarrier = () => { assert.ok(!response.destroyed, "source Turn stays connected after navigation"); held.delete(response); release(); };
      } else release();
      return;
    }
    if (prompt.includes("THREAD_SCHEDULE_UPDATE_B")) {
      const updated = results.find(result => result.name === "scheduled_task_update");
      if (updated) { assert.equal(updated.value.task.objective, objectives.B); finish("THREAD_SCHEDULE_UPDATED_B"); return; }
      const listed = results.find(result => result.name === "scheduled_task_list");
      if (!listed) { tool("scheduled_task_list", {}); return; }
      const target = listed.value.tasks.find(task => task.objective === objectives.B);
      assert.ok(target, "current source Thread tool list includes the second schedule");
      assert.equal(listed.value.tasks.filter(task => !task.deletedAt).length, 2);
      tool("scheduled_task_update", { taskId: target.id, expectedRevision: target.revision, scheduleV2: changedSchedule });
      return;
    }
    assert.fail(`Unexpected fixture prompt: ${prompt}`);
  } catch (error) {
    fixtureFailure = error;
    errors.push(error.stack ?? String(error));
    if (!response.headersSent) response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "THREAD_SCHEDULE_FIXTURE_FAILED" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const config = join(userHome, ".areal/config.toml");
await writeFile(config, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n`);
const deployment = join(stateRoot, "desktop.json");
await writeFile(deployment, JSON.stringify({ profiles: [{ id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Use the requested tools and report their authoritative results." }] }));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(",");
Object.assign(env, { NO_PROXY: noProxy, no_proxy: noProxy, AREAL_CORE_BIN: binary, AREAL_CORE_USER_HOME: userHome, AREAL_GUI_USER_DATA: join(stateRoot, "electron"), AREAL_CORE_HOME: join(stateRoot, "core"), AREAL_HARNESS_HOME: join(stateRoot, "runtime"), AREAL_HARNESS_SERVICE_HOME: join(stateRoot, "registry"), AREAL_CORE_CONFIG: config, AREAL_CORE_DESKTOP_CONFIG: deployment });
let app, page, projectId, sourceThreadId, passed = false;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureFailure) throw fixtureFailure;
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function call(name, params) {
  const reply = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
const task = (taskId, ownerId = projectId) => call("manage", { projectId: ownerId, operation: "task", taskId });
const tasks = () => call("tasks", { operation: "list", limit: 100 });
async function shot(name) {
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled", scale: "css" });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  frames.push(`${name}.png`);
}
async function send(prompt) {
  const before = await snapshot();
  const previousThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const previousTurnId = before.projects.flatMap(project => Object.values(project.state?.threads ?? {})).find(thread => thread.id === previousThreadId)?.turns?.at(-1)?.id;
  await page.getByTestId("chat-input").fill(prompt);
  await page.getByTestId("chat-send-button").click();
  return until(async () => {
    const id = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    const thread = (await snapshot()).projects.flatMap(project => Object.values(project.state?.threads ?? {})).find(thread => thread.id === id);
    return thread?.turns?.at(-1)?.id && thread.turns.at(-1).id !== previousTurnId && id;
  }, "ordinary Composer admits a Core Thread");
}
async function completed(threadId, ownerId = projectId) {
  return until(async () => {
    const thread = (await snapshot()).projects.find(project => project.id === ownerId)?.state?.threads?.[threadId];
    return thread?.turns?.at(-1)?.status === "completed" && thread;
  }, `source Turn ${threadId} completed`);
}
const card = id => page.locator(`[data-testid="scheduled-task-card"][data-task-id="${id}"]`).first();
const resourceRow = id => page.getByLabel("本会话定时任务", { exact: true }).locator(`[data-task-id="${id}"]`);
async function resources() {
  const panel = page.getByLabel("任务资源面板", { exact: true });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "任务资源", exact: true }).click();
  await page.getByLabel("本会话定时任务", { exact: true }).waitFor();
}
async function coreClient(drop = null) {
  const instance = (await snapshot()).projects.find(project => project.id === projectId).core.instanceId;
  const descriptor = JSON.parse(execFileSync(binary, ["service", "status", "--instance", instance, "--json"], { env, encoding: "utf8", timeout: 20000 }));
  assert.equal(descriptor.workspace, workspace);
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find(item => ["observe", "interact", "manage"].every(permission => item.permissions?.includes(permission)));
  assert.ok(principal?.token);
  const client = new CoreClient({ createSocket: () => {
    const socket = new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${principal.token}` }, followRedirects: false });
    if (drop) {
      const send = socket.send.bind(socket), listen = socket.addEventListener.bind(socket);
      let wireId;
      socket.send = (...args) => { const packet = JSON.parse(String(args[0])); if (packet.method === drop.method && packet.params?.requestId === drop.requestId) wireId = packet.id; return send(...args); };
      socket.addEventListener = (kind, listener, ...args) => listen(kind, kind !== "message" ? listener : event => {
        const packet = JSON.parse(String(event.data));
        if (wireId !== undefined && packet.id === wireId) {
          assert.ok(packet.result, "lost-response injection happens only after Core accepted the write");
          facts.protocol.droppedResponse = { method: drop.method, requestId: drop.requestId, result: packet.result };
          socket.close(1000, "fixture discarded accepted response");
          return;
        }
        listener(event);
      }, ...args);
    }
    return socket;
  } });
  await client.connect();
  return client;
}
async function protocolRecovery(taskId) {
  let client = await coreClient();
  try {
    const before = await client.request("areal/task/read", { taskId });
    const params = { taskId, requestId: randomUUID(), expectedRevision: before.revision };
    const first = await client.request("areal/task/pause", params);
    const duplicate = await client.request("areal/task/pause", params);
    assert.deepEqual(duplicate, first, "same durable request returns original result");
    assert.equal((await client.request("areal/task/read", { taskId })).revision, first.revision, "duplicate control creates no extra revision");
    let stale;
    try { await client.request("areal/task/resume", { ...params, requestId: randomUUID() }); } catch (error) { stale = error; }
    assert.ok(stale, "stale expectedRevision is rejected at real Core boundary");
    assert.equal(stale.outcome?.kind, "rejected");
    assert.equal((await client.request("areal/task/read", { taskId })).paused, true);
    facts.protocol.duplicate = { params, result: first };
    facts.protocol.conflict = { code: stale.code, data: stale.data };
    client.close();
    const lost = { method: "areal/task/resume", requestId: randomUUID() };
    client = await coreClient(lost);
    let unknown;
    try { await client.request(lost.method, { taskId, requestId: lost.requestId, expectedRevision: first.revision }); } catch (error) { unknown = error; }
    assert.equal(unknown?.submissionUnknown, true, "accepted write with discarded response is UNKNOWN");
    client.close();
    client = await coreClient();
    const receipts = await client.request("areal/request/read", { requestId: lost.requestId });
    assert.equal(receipts.data.filter(receipt => receipt.method === lost.method && receipt.taskId === taskId).length, 1);
    const recovered = await client.request("areal/task/read", { taskId });
    assert.equal(recovered.paused, false);
    assert.equal(recovered.revision, facts.protocol.droppedResponse.result.revision);
    facts.protocol.recovered = { receipts, task: recovered, replayed: false };
    checks.push("Core protocol independently rejects stale revision, deduplicates original request, and recovers a discarded accepted response by receipt without replay");
  } finally { client.close(); }
}

async function recoverScheduledCreation() {
  await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { ServiceConnection } = require('./src/core/service-client.cjs');
    const request = ServiceConnection.prototype.request;
    ServiceConnection.prototype.request = async function(method, params, ...rest) {
      const result = await request.call(this, method, params, ...rest);
      if (method === 'command' && params.name === 'create') globalThis.__scheduleCreateCalls = (globalThis.__scheduleCreateCalls ?? 0) + 1;
      if (method === 'command' && params.name === 'create' && !globalThis.__scheduleLostCreation) {
        globalThis.__scheduleLostCreation = { requestId: params.request.requestId, projectId: params.request.projectId, threadId: result.threadId, calls: 1 };
        throw Object.assign(new Error('Fixture lost committed creation reply'), { submissionUnknown: true, requestId: params.request.requestId });
      }
      return result;
    };
  });
  await page.getByRole("button", { name: "新建自动化", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  await until(async () => !(await page.locator('.task-conversation-pending').count()), 'known committed creation opens without duplicate create');
  const recoveredCreation = await app.evaluate(() => globalThis.__scheduleLostCreation);
  assert.ok(recoveredCreation?.threadId && recoveredCreation.requestId);
  assert.equal(await app.evaluate(() => globalThis.__scheduleCreateCalls), 1, "read-only recovery never repeats create");
  assert.equal(await page.evaluate(() => localStorage.getItem('areal-gui:ordinary-schedule-creation')), null);
  checks.push('a lost committed Scheduled creation reply recovers from its original ready record without another create');
  const owner = (await snapshot()).projects.find(project => project.id === recoveredCreation.projectId);
  assert.equal(owner.worktreeOperations.find(record => record.requestId === recoveredCreation.requestId).state, 'ready');
  assert.equal(await page.getByTestId('areal-workbench').getAttribute('data-thread-id'), recoveredCreation.threadId);
  return recoveredCreation;
}

console.log("Thread schedules GUI evidence:", evidence);
try {
  app = await electron.launch({ executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"), args: [process.env.AREAL_GUI_TEST_APP_DIR || join(gui, "app")], env, timeout: 120000 });
  app.process().stderr.on("data", chunk => void writeFile(join(evidence, "electron.stderr.log"), chunk, { flag: "a" }));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "isolated desktop service ready");
  facts.runtime = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 960); window.show(); window.focus();
    return { pid: process.pid, userData: app.getPath("userData"), preferences: window.webContents.getLastWebPreferences(), electron: process.versions.electron };
  });
  assert.equal(facts.runtime.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(facts.runtime.preferences.sandbox, true);
  assert.equal(facts.runtime.preferences.contextIsolation, true);
  assert.equal(facts.runtime.preferences.nodeIntegration, false);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await snapshot()).projects.find(project => project.root === workspace && project.state?.connected), "isolated project ready");
  projectId = project.id;
  if (process.argv.includes("--creation-recovery-only")) {
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    await recoverScheduledCreation();
    assert.match(await page.getByTestId("chat-input").innerText(), /帮我创建一个定时任务/);
    assert.equal(requests.length, 0, "recovered creation preserves the draft without sending it");
    passed = true;
  } else {
  await createProjectConversation(page, "workspace");
  await page.getByRole("button", { name: "更改权限", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^完全访问/ }).click();
  sourceThreadId = await send("THREAD_SCHEDULE_CREATE_A 以后每天九点按刚才的方法检查项目并汇报。");
  await until(() => creationBarrier, "ordinary Thread advertises scheduled_task_create before fixture emits the call");
  await createProjectConversation(page, "workspace");
  assert.notEqual(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), sourceThreadId);
  creationBarrier();
  const A = await until(async () => (await tasks()).data.find(task => task.objective === objectives.A), "schedule commits after navigating away from source Thread");
  assert.equal(A.sourceThreadId, sourceThreadId);
  assert.notEqual(A.threadId, sourceThreadId, "source discussion and execution anchor remain distinct");
  assert.equal(A.projectId, projectId);
  assert.equal(A.runs.length, 0, "saving a future schedule does not start a run");
  await selectConversation(page, sourceThreadId);
  await completed(sourceThreadId);
  await card(A.id).waitFor();
  assert.equal(await page.getByTestId(`task-item-${sourceThreadId}`).count(), 1, "source Thread remains in the regular sidebar");
  await shot("01-source-card");
  facts.ui.A = A;
  checks.push("ordinary source Thread tool creates a durable schedule after navigation; separate execution anchor preserves source sidebar");

  const preservedDraft = "UNSENT_SCHEDULE_DRAFT 保留我尚未发送的检查说明。";
  await page.getByTestId("chat-input").fill(preservedDraft);
  const requestsBeforeAdd = requests.length;
  await resources();
  await page.getByLabel("本会话定时任务", { exact: true }).getByRole("button", { name: "添加", exact: true }).click();
  const addDraft = await until(async () => {
    const input = page.getByTestId("chat-input");
    const value = await input.innerText();
    const focused = await input.evaluate(element => element === document.activeElement || element.contains(document.activeElement));
    return value.includes(preservedDraft) && value.includes("帮我创建一个定时任务：") && focused && value;
  }, "conversation Add preserves unsent text, appends schedule intent and focuses Composer");
  assert.ok(addDraft.indexOf(preservedDraft) < addDraft.indexOf("帮我创建一个定时任务："));
  assert.equal(requests.length, requestsBeforeAdd, "conversation Add does not send a model request");
  assert.equal((await tasks()).data.length, 1, "conversation Add waits for an explicit user send before creating another schedule");
  facts.ui.conversationAdd = { preservedDraft, draft: addDraft, sourceThreadId };
  checks.push("top-right Add preserves the existing draft, appends creation intent and focuses Composer without submitting");

  await send("THREAD_SCHEDULE_CREATE_B 另建一个每天九点检查未完成事项的安排。");
  await completed(sourceThreadId);
  const B = await until(async () => (await tasks()).data.find(task => task.objective === objectives.B), "second schedule saved from same source Thread");
  assert.equal(B.sourceThreadId, sourceThreadId);
  const beforeUpdateA = await task(A.id);
  await send("THREAD_SCHEDULE_UPDATE_B 只把第二个安排改到一月五日开始，其他保持不变。");
  await completed(sourceThreadId);
  const updatedB = await task(B.id);
  assert.equal(updatedB.objective, B.objective);
  assert.equal(updatedB.scheduleV2.rule.anchorAt, Date.parse("2040-01-05T09:00:00+08:00") / 1000);
  assert.deepEqual((await task(A.id)).scheduleV2, beforeUpdateA.scheduleV2, "targeted update preserves sibling schedule");
  assert.equal((await task(A.id)).revision, beforeUpdateA.revision);
  facts.ui.B = updatedB;
  await resources();
  for (const entry of [A, B]) await resourceRow(entry.id).waitFor();
  await shot("02-source-resources");
  let count = requests.length;
  await resourceRow(A.id).getByRole("button", { name: "暂停", exact: true }).click();
  await until(async () => (await task(A.id)).paused, "resource pause is authoritative");
  assert.equal(requests.length, count, "pause needs no model call");
  await resourceRow(A.id).getByRole("button", { name: "开启", exact: true }).click();
  await until(async () => !(await task(A.id)).paused, "resource enable is authoritative");
  assert.equal(requests.length, count, "enable needs no model call");
  await resourceRow(A.id).getByRole("button", { name: "立即运行", exact: true }).click();
  const completedA = await until(async () => { const value = await task(A.id); return value.runs.some(run => run.status === "completed") && value; }, "run now produces completed real Core run");
  assert.ok(requests.length > count, "intentional run calls configured model");
  assert.notEqual(completedA.runs[0].threadId, sourceThreadId);
  facts.ui.completedA = completedA;
  checks.push("two source schedules can be targeted independently; resource pause/enable bypass model and run-now starts a separate Core run with real Runtime command output");
  await page.keyboard.press("Escape");

  forbiddenTarget = await task(A.id);
  const scheduleCount = (await tasks()).data.length;
  await createProjectConversation(page, "workspace");
  const otherSource = await send("THREAD_SCHEDULE_FORBIDDEN 检查本会话安排，并尝试修改已知的其他会话任务。");
  assert.notEqual(otherSource, sourceThreadId);
  await completed(otherSource);
  assert.ok(facts.ui.crossSourceRejection, "cross-source mutation reached an observed Core rejection");
  assert.equal((await task(A.id)).objective, forbiddenTarget.objective);
  assert.equal((await task(A.id)).revision, forbiddenTarget.revision);
  assert.equal((await tasks()).data.length, scheduleCount);
  checks.push("ordinary sibling Thread in the same project sees no other source schedules and receives PERMISSION_DENIED for a known task mutation without side effects");

  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  for (const entry of [A, B]) await page.getByRole("button", { name: `打开自动化 ${entry.objective}`, exact: true }).waitFor();
  await recoverScheduledCreation();
  const independentThread = await send("THREAD_SCHEDULE_CREATE_C 每天九点在独立工作目录检查。");
  const approval = await until(async () => (await snapshot()).projects.flatMap(project => project.state?.interactions?.[independentThread]?.data ?? []).find(item => item.kind === "approval" && item.status === "pending"), "independent source asks for exact schedule creation approval");
  assert.equal(approval.tool, "scheduled_task_create");
  assert.equal(approval.threadId, independentThread);
  assert.deepEqual(approval.effectiveArguments, { objective: objectives.C, scheduleV2: initialSchedule });
  assert.deepEqual(approval.effectivePermissions.grant.arguments, approval.effectiveArguments);
  facts.ui.independentCreationApproval = { requestId: approval.requestId, threadId: approval.threadId, tool: approval.tool, effectiveArguments: approval.effectiveArguments };
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  const C = await until(async () => (await tasks()).data.find(task => task.objective === objectives.C), "global add saves through ordinary tool path");
  await completed(independentThread, C.projectId);
  const answered = (await snapshot()).projects.find(project => project.id === C.projectId).state.interactions[independentThread].data.find(item => item.requestId === approval.requestId);
  assert.equal(answered.response.decision, "allowOnce");
  const independent = (await snapshot()).projects.find(project => project.id === C.projectId);
  assert.equal(independent.projectless, true);
  assert.notEqual(independent.root, workspace);
  assert.equal(C.sourceThreadId, independentThread);
  facts.ui.C = C;
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  for (const entry of [A, B, C]) await page.getByRole("button", { name: `打开自动化 ${entry.objective}`, exact: true }).waitFor();
  await shot("03-global-project-and-independent");
  await page.getByRole("button", { name: `打开自动化 ${C.objective}`, exact: true }).click();
  count = requests.length;
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await until(async () => (await task(C.id, C.projectId)).paused, "global control pauses independent task");
  await page.getByRole("button", { name: "开启", exact: true }).click();
  await until(async () => !(await task(C.id, C.projectId)).paused, "global control enables independent task");
  assert.equal(requests.length, count);
  checks.push("global center aggregates project and independent owner schedules and direct controls share Core state");

  await page.reload();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await selectConversation(page, sourceThreadId);
  for (const entry of [A, B]) await card(entry.id).waitFor();
  await resources();
  assert.equal(await resourceRow(B.id).count(), 1);
  count = requests.length;
  await resourceRow(B.id).getByRole("button", { name: "立即运行", exact: true }).click();
  const busyB = await until(async () => { const value = await task(B.id); return value.runs.some(run => run.status === "running") && held.size && value; }, "second task is running at model response barrier");
  assert.ok(requests.length > count);
  count = requests.length;
  await resourceRow(B.id).getByRole("button", { name: "删除", exact: true }).click();
  const deletedB = await until(async () => { const value = await task(B.id); return value.deletedAt && value.runs.every(run => ["completed", "failed", "cancelled"].includes(run.status) && (run.workers ?? []).every(worker => worker.settled)) && value; }, "busy deletion persists tombstone and settles owned run");
  assert.equal(deletedB.cancelled, true);
  assert.equal(deletedB.nextRunAt, null);
  assert.ok(deletedB.runs.length >= busyB.runs.length, "delete retains execution history");
  assert.equal(requests.length, count, "delete requires no model request");
  facts.ui.deletedB = deletedB;
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await selectConversation(page, sourceThreadId);
  const tombstone = card(B.id);
  await tombstone.getByText("已删除", { exact: true }).waitFor();
  assert.equal(await page.getByTestId(`task-item-${sourceThreadId}`).count(), 1);
  await shot("04-deleted-card-history");
  await resources();
  assert.equal(await resourceRow(B.id).count(), 0, "settled tombstone leaves active source resource list");
  assert.equal(await resourceRow(A.id).count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: `打开自动化 ${A.objective}`, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: `打开自动化 ${B.objective}`, exact: true }).count(), 0);
  checks.push("reload recovers source cards; deleting a busy schedule stops and settles run, keeps historical tombstone, and removes active catalog rows");
  await protocolRecovery(A.id);
  assert.deepEqual(errors, []);
  passed = true;
  }
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) {
    await captureSmokeFailure(page, evidence, error);
    try { await writeFile(join(evidence, "failure-desktop-snapshot.json"), JSON.stringify(await snapshot(), null, 2)); }
    catch (captureError) { errors.push(`Desktop snapshot evidence: ${captureError.stack ?? captureError}`); }
  }
  process.exitCode = 1;
} finally {
  const metadata = await readFile(join(stateRoot, "core/service.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const cleanupFailure = (label, error) => { errors.push(`${label}: ${error.stack ?? error}`); passed = false; process.exitCode = 1; };
  if (page && projectId) {
    try {
      const rows = await tasks();
      facts.cleanupTasks = [];
      for (const entry of rows.data) {
        if (entry.cancelled) continue;
        const current = await task(entry.id, entry.projectId);
        if (current.cancelled) continue;
        const cancelled = await call("manage", { projectId: entry.projectId, operation: "taskCancel", taskId: entry.id, expectedRevision: current.revision });
        facts.cleanupTasks.push({ projectId: entry.projectId, taskId: entry.id, revision: cancelled.revision });
      }
      const deadline = Date.now() + 20000;
      let settled = false;
      while (Date.now() < deadline) {
        const rows = await tasks();
        settled = rows.data.every(entry => entry.cancelled && entry.runs.every(run => ["completed", "failed", "cancelled"].includes(run.status) && (run.workers ?? []).every(worker => worker.settled)));
        if (settled) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(settled, "owned task cancellation settles before Electron quit");
      facts.cleanupTasksSettled = true;
    } catch (error) { cleanupFailure("Task cleanup", error); }
  }
  for (const response of held) response.destroy();
  if (app) {
    try {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      await closeSmokeApplication(app);
    } catch (error) { cleanupFailure("Electron cleanup", error); }
  }
  try {
    try { await assertApplicationStopped(binary, env, metadata); }
    catch (error) {
      assert.ok(metadata, "fallback stop targets only owned service metadata");
      facts.cleanupAssisted = true;
      const connection = new ServiceConnection();
      try {
        await connection.connect(metadata);
        const hello = await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
        await connection.request("stopService", { protocol: metadata.protocol, cancel: true, expectedDesktopGeneration: metadata.desktopGeneration, expectedTargets: hello.service.targets }, true);
        await waitForServiceExit(join(stateRoot, "core"), metadata);
      } finally { connection.close(); }
      await assertApplicationStopped(binary, env, metadata);
    }
    facts.applicationStopped = true;
  } catch (error) { cleanupFailure("Service cleanup", error); }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, "facts.json"), JSON.stringify(facts, null, 2));
  const manifest = { passed, checks, errors, frames, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }), diffSHA256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })), scriptSHA256: sha(await readFile(fileURLToPath(import.meta.url))), binary, binarySHA256: binaryHash, binarySHA256After: sha(await readFile(binary)), startedAt: facts.startedAt, endedAt: new Date().toISOString(), scope: "Real source Electron/preload/Desktop/Core/Runtime with deterministic external SSE provider. UI scenarios and supplemental Core protocol fault injections are reported separately.", injectedBoundaries: ["Native project picker selects the owned workspace", "External model response barriers control navigation and busy-run ordering", "Supplemental Core client discards one successful mutation response and closes that socket"], unverified: ["real-provider language inference", "installed or signed package", "physical input", "other operating systems"] };
  if (facts.applicationStopped) {
    assert.equal(await readFile(join(stateRoot, ".owner"), "utf8"), owner);
    await rm(stateRoot, { recursive: true });
    manifest.stateRemoved = true;
  }
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, checks, errors, evidence }, null, 2));
}
