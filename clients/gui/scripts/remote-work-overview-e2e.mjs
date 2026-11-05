import { attachRemoteHostFixture } from "./remote-host-fixture.cjs";
import { makeTempDir } from "./support/temp.mjs";
import { selectRemoteTransport, requireBrowserTransport } from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
await requireBrowserTransport(transport, "remote-work-overview-e2e");
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "../app/node_modules/playwright-core/index.mjs";
import {
  byteChannel,
  createIdentity,
  identityId,
  secureChannel,
} from "../packages/remote/src/channel.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { RemoteControl } = require("@areal/workbench-service/desktop/core/remote.cjs");
const WebSocket = require("ws");
const scratch = await makeTempDir("areal-remote-rc03-");
const workspace = join(scratch, "workspace");
const home = join(scratch, "desktop");
await mkdir(workspace);
await mkdir(join(scratch, "user", ".areal"), { recursive: true });
let modelRequests = 0;
const held = new Set();
const unknownMarker = join(workspace, "unknown-once.txt");
const tool = (name, args, index) => ({
  index,
  id: `call-${name}-${index}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const question = {
  id: "choice",
  title: "RC03 question: choose a target",
  options: ["A", "B"],
  allowFreeText: false,
};
function finish(response, delta = { content: "RC03_RESULT" }, reason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
  );
}
const model = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  modelRequests++;
  const body = JSON.parse(Buffer.concat(chunks));
  const text = JSON.stringify(body.messages);
  const hasTool = body.messages.some((message) => message.role === "tool");
  if (text.includes("RC03_FAIL")) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end('{"error":{"message":"fixture failure"}}');
    return;
  }
  if (
    text.includes("RC03_RUNNING") ||
    text.includes("You are a TaskRun worker.") ||
    (text.includes("RC03_TASKCASE") && hasTool)
  ) {
    held.add(response);
    response.on("close", () => held.delete(response));
    return;
  }
  if (text.includes("RC03_APPROVAL") && !hasTool) {
    finish(response, { tool_calls: [tool("run_command", { command: "true" }, 0)] }, "tool_calls");
    return;
  }
  if (text.includes("RC03_SYNCQUESTION") && !hasTool) {
    finish(
      response,
      {
        tool_calls: [tool("ask_user_question", { questions: [question], timeoutSeconds: 600 }, 0)],
      },
      "tool_calls",
    );
    return;
  }
  if (text.includes("RC03_TASKCASE") && !hasTool) {
    finish(
      response,
      {
        tool_calls: [
          tool("ask_user_question", { questions: [question], mode: "async", required: false }, 0),
          tool("task_spawn", { prompt: "RC03_WORKER_A inspect evidence" }, 1),
          tool("task_spawn", { prompt: "RC03_WORKER_B inspect evidence" }, 2),
        ],
      },
      "tool_calls",
    );
    return;
  }
  if (text.includes("RC03_UNKNOWN") && !hasTool) {
    finish(
      response,
      {
        tool_calls: [
          tool(
            "run_command",
            { command: `printf x >> '${unknownMarker}'; sleep 60`, timeoutMs: 120000 },
            0,
          ),
        ],
      },
      "tool_calls",
    );
    return;
  }
  finish(response);
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(scratch, "user", ".areal", "config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      { id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Complete task" },
      {
        id: "approval",
        revision: "v1",
        displayName: "Approval fixture",
        instructions: "Complete task",
        approvalTools: ["run_command"],
      },
    ],
  }),
);
const backend = new CoreBackend({
  binary: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
  home,
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
  desktopConfig: deployment,
  defaultProfile: { id: "fixture", revision: "v1" },
});
const checks = [];
const extraWriters = [];
let service,
  browser,
  writer,
  remoteClient,
  passed = false;
async function waitFor(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}`);
}
async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
// Playwright 对其页面启用强制焦点；真实可见性单独使用 Chrome 公共 CDP，避免伪造 document.hidden。
async function verifyRealVisibility(remote, projectId) {
  const profile = await mkdtemp(join(scratch, "visibility-"));
  const chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let socket;
  try {
    const port = await waitFor(async () => {
      try {
        return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      } catch {
        return null;
      }
    }, "Chrome debugging endpoint");
    socket = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await once(socket, "open");
    let sequence = 0,
      frames = 0,
      sessionId;
    const waiting = new Map();
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      if (
        message.method === "Network.webSocketFrameSent" &&
        message.sessionId === sessionId &&
        message.params.response.opcode === 2
      )
        frames++;
      if (!message.id) return;
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
    });
    const cdp = (method, params = {}, session) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10000);
        waiting.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }),
        );
      });
    const invitation = await remote.control({ operation: "pair" });
    const target = await cdp("Target.createTarget", { url: invitation.payload });
    sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
      .sessionId;
    await cdp("Network.enable", {}, sessionId);
    const evaluate = async (expression) => {
      const response = await cdp(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
      );
      if (response.exceptionDetails) throw new Error("CDP Runtime.evaluate failed");
      return response.result.value;
    };
    await waitFor(
      () =>
        evaluate(
          '!!document.getElementById("connect") && !document.getElementById("connect").disabled',
        ),
      "production Remote connect ready",
    );
    await evaluate('document.getElementById("connect").click()');
    const pending = await waitFor(
      async () => (await remote.control({ operation: "status" })).pending[0],
      "raw browser pairing",
    );
    await remote.control({
      operation: "approve",
      id: pending.id,
      projects: [projectId],
      preset: "Observer",
    });
    await waitFor(
      () => evaluate('document.querySelectorAll(".remote-session-row").length > 0'),
      "raw browser work cards",
    );
    const beforeForeground = frames;
    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.ok(frames > beforeForeground);
    const other = await cdp("Target.createTarget", { url: "about:blank" });
    await cdp("Target.activateTarget", { targetId: other.targetId });
    await waitFor(
      async () => (await evaluate("document.visibilityState")) === "hidden",
      "actual hidden tab",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hiddenFrames = frames;
    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.equal(frames, hiddenFrames, "actual hidden tab sends no polling frames");
    await cdp("Target.activateTarget", { targetId: target.targetId });
    await waitFor(
      async () => (await evaluate("document.visibilityState")) === "visible",
      "actual foreground tab",
    );
    await waitFor(() => frames > hiddenFrames, "foreground immediately refreshes", 1500);
    await writeFile(
      join(scratch, "visibility.json"),
      JSON.stringify(
        {
          beforeForeground,
          afterForeground: hiddenFrames,
          hiddenFrames,
          resumedFrames: frames,
          realVisibility: true,
        },
        null,
        2,
      ),
    );
    await cdp("Browser.close");
  } finally {
    socket?.close();
    chrome.kill("SIGTERM");
    await new Promise((resolve) => {
      if (chrome.exitCode !== null) resolve();
      else {
        chrome.once("exit", resolve);
        setTimeout(resolve, 3000).unref();
      }
    });
  }
}
try {
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const project = await backend.start(projectId);
  writer = new CoreClient({
    createSocket: () =>
      new WebSocket(project.endpoint, { headers: { Authorization: `Bearer ${project.token}` } }),
  });
  await writer.connect();
  const { thread } = await writer.request("areal/thread/start", { requestId: randomUUID() });
  await writer.request("areal/turn/start", {
    requestId: randomUUID(),
    threadId: thread.id,
    expectedConfigRevision: 1,
    input: [{ type: "text", text: "RC03_NEVER_OPENED" }],
  });
  await waitFor(
    async () =>
      (await writer.request("thread/read", { threadId: thread.id, includeTurns: false })).thread
        .status.type === "idle",
    "turn completed",
  );
  assert.equal(
    project.model.state.threads[thread.id],
    undefined,
    "thread was never opened or subscribed by desktop",
  );
  service = new DesktopService(backend, "rc03-fixture");
  const hostIdentity = await createIdentity();
  const identity = await createIdentity();
  const encryptionFixture = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString("utf8"),
  };
  await writeFile(
    join(home, "remote-host-fixture.json"),
    JSON.stringify({
      encrypted: Buffer.from(
        JSON.stringify({
          enabled: false,
          directEnabled: true,
          identity: hostIdentity,
          deviceGrants: [],
        }),
      ).toString("base64"),
    }),
  );
  const remote = (service.remote = new RemoteControl(service));
  attachRemoteHostFixture(remote, encryptionFixture);
  await remote.init();
  const invite = await remote.control({ operation: "pair" });
  const invitation = new URL(invite.payload);
  const params = new URLSearchParams(invitation.hash.slice(1));
  const socket = new WebSocket(remote.direct.ws, { origin: remote.direct.origin });
  await once(socket, "open");
  const wire = byteChannel(
    (bytes) => socket.send(bytes),
    () => socket.close(),
  );
  socket.on("message", (bytes) => wire.receive(bytes));
  socket.on("close", () => wire.close());
  const secure = await secureChannel(wire, identity, identityId(hostIdentity));
  remoteClient = secure;
  const messages = secure.messages();
  secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "rc03",
    displayName: "RC03 observer",
    inviteSecret: params.get("invite"),
  });
  assert.equal((await messages.next()).value.event, "pairing");
  await remote.control({
    operation: "approve",
    id: identityId(identity),
    projects: [projectId],
    preset: "Observer",
  });
  assert.equal((await messages.next()).value.event, "ready");
  let sequence = 0;
  const rpc = async (method, params = {}, target = projectId) => {
    const id = String(++sequence);
    secure.send({ id, method, context: { projectId: target }, params });
    const message = (await messages.next()).value;
    assert.equal(message.id, id);
    return message;
  };
  const reply = await rpc("work.list");
  assert.ok(!reply.error, JSON.stringify(reply));
  assert.equal(reply.result.data[0].threadId, thread.id);
  assert.equal(reply.result.data[0].execution.state, "completed");
  assert.equal(reply.result.data[0].resultAvailable, true);
  assert.equal(reply.result.complete, true);
  assert.equal(JSON.stringify(reply).includes(workspace), false);
  assert.equal(
    project.model.state.threads[thread.id],
    undefined,
    "overview does not subscribe desktop to transcript",
  );
  checks.push(
    "never-opened completed session with independent result state through authenticated Remote/Core",
  );
  const createWork = async (name, profile) => {
    const { thread } = await writer.request("areal/thread/start", {
      requestId: randomUUID(),
      ...(profile ? { agentProfile: { id: profile, revision: "v1" } } : {}),
    });
    await writer.request("areal/turn/start", {
      requestId: randomUUID(),
      threadId: thread.id,
      expectedConfigRevision: 1,
      input: [{ type: "text", text: name }],
    });
    return thread.id;
  };
  const runningId = await createWork("RC03_RUNNING");
  const failedId = await createWork("RC03_FAIL");
  const approvalId = await createWork("RC03_APPROVAL", "approval");
  const questionId = await createWork("RC03_SYNCQUESTION");
  const task = await writer.request("areal/task/create", {
    requestId: randomUUID(),
    mode: "background",
    objective: "RC03_TASKCASE",
    interactionMode: "asynchronous",
  });
  const statePage = await waitFor(
    async () => {
      const result = await rpc("work.list");
      assert.ok(!result.error, JSON.stringify(result));
      const data = result.result.data;
      const taskRow = data.find((row) => row.taskId === task.id);
      return data.some((row) => row.threadId === failedId && row.execution.state === "failed") &&
        data.some(
          (row) =>
            row.threadId === approvalId &&
            row.attentionRefs.some((item) => item.kind === "approval"),
        ) &&
        data.some(
          (row) =>
            row.threadId === questionId &&
            row.attentionRefs.some((item) => item.kind === "syncQuestion"),
        ) &&
        taskRow?.workerCount === 2 &&
        taskRow.attentionRefs.some((item) => item.kind === "asyncQuestion")
        ? result.result
        : null;
    },
    "running/failed/sync interactions and Task asynchronous question with two workers",
    30000,
  );
  const taskRow = statePage.data.find((row) => row.taskId === task.id);
  assert.equal(taskRow.execution.state, "running");
  assert.equal(taskRow.execution.runStatus, "running");
  assert.equal(taskRow.attentionCount, 1);
  assert.equal(
    taskRow.workers.every((worker) => !worker.settled && worker.status === "running"),
    true,
  );
  const ownedIds = [taskRow.threadId, ...taskRow.workers.map((worker) => worker.threadId)];
  assert.equal(
    statePage.data.some((row) => row.kind === "thread" && ownedIds.includes(row.threadId)),
    false,
    "coordinator/workers do not appear as unrelated ordinary sessions",
  );
  assert.equal(statePage.data.find((row) => row.threadId === runningId).execution.state, "running");
  assert.equal(
    statePage.data.find((row) => row.threadId === approvalId).execution.state,
    "running",
  );
  for (const id of [runningId, failedId, approvalId, questionId])
    assert.equal(project.model.state.threads[id], undefined);
  const activePage = await rpc("work.list", { filter: "active" });
  assert.ok(activePage.result.data.some((row) => row.threadId === runningId));
  assert.ok(
    activePage.result.data.every(
      (row) => row.execution.state !== "failed" && row.execution.state !== "completed",
    ),
  );
  const attention = await rpc("attention.list", { limit: 2 });
  assert.equal(attention.result.data.length, 2);
  assert.equal(attention.result.complete, false);
  const remainingAttention = await rpc("attention.list", {
    limit: 2,
    cursor: attention.result.nextCursor,
  });
  assert.equal(remainingAttention.result.data.length, 1);
  assert.equal(remainingAttention.result.complete, true);
  assert.deepEqual(
    new Set([...attention.result.data, ...remainingAttention.result.data].map((item) => item.kind)),
    new Set(["approval", "syncQuestion", "asyncQuestion"]),
  );
  checks.push(
    "never-opened running/failure/sync approval and question; Task runs while async question pending; two workers attributed and deduplicated",
  );
  checks.push("attention.list pages bounded summaries without full tool arguments");
  const forbiddenWorkspace = join(scratch, "forbidden-project");
  await mkdir(forbiddenWorkspace);
  const forbiddenId = await backend.addProject(forbiddenWorkspace);
  const forbiddenProject = await backend.start(forbiddenId);
  const forbiddenThread = await forbiddenProject.client.request("thread/start", {});
  for (const method of ["work.list", "attention.list"])
    assert.equal((await rpc(method, {}, forbiddenId)).error.code, "FORBIDDEN");
  assert.equal(JSON.stringify(statePage).includes(forbiddenThread.thread.id), false);
  assert.equal((await rpc("work.list", { limit: 101 })).error.code, "INVALID_PARAMS");
  assert.equal((await rpc("work.list", { filter: "not-valid" })).error.code, "INVALID_PARAMS");
  checks.push(
    "real second Core project is forbidden for work/attention; invalid filter/page limits rejected",
  );
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  let frames = 0;
  page.on("websocket", (ws) => ws.on("framesent", () => frames++));
  const browserInvite = await remote.control({ operation: "pair" });
  await page.goto(browserInvite.payload);
  await page.getByRole("button", { name: "连接电脑" }).click();
  await page
    .getByRole("status")
    .getByText(/等待桌面确认/)
    .waitFor({ timeout: 10000 });
  const pending = (await remote.control({ operation: "status" })).pending[0];
  await remote.control({
    operation: "approve",
    id: pending.id,
    projects: [projectId],
    preset: "Observer",
  });
  await page
    .locator(`.remote-session-row[data-thread-id="${thread.id}"]`)
    .waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(scratch, "work-overview.png"), fullPage: true });
  assert.equal(await page.getByRole("button", { name: "审阅待处理事项", exact: true }).count(), 3);
  checks.push(
    "production project list renders never-opened Core Thread and exposes approval, sync question and Task question review; independent execution/result/workers verified by real work.list above",
  );
  let before = frames;
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.ok(frames > before, "visible page polls within five seconds");
  before = frames;
  await page.evaluate(() => window.dispatchEvent(new Event("remote-operation-complete")));
  await waitFor(() => frames > before, "operation completion triggers immediate refresh", 1000);
  checks.push("foreground five-second poll and operation completion immediate refresh");
  const hugeTitle = "RC03_OVERSIZED_" + "界".repeat(3500);
  const oversizedTask = await writer.request("areal/task/create", {
    requestId: randomUUID(),
    mode: "background",
    objective: hugeTitle,
    maxTurns: 1,
  });
  await waitFor(
    async () => (await rpc("work.list")).result.data.find((row) => row.taskId === oversizedTask.id),
    "oversized Task projection",
  );
  for (let index = 0; index < 35; index++)
    await writer.request("areal/thread/start", { requestId: randomUUID() });
  let cursor;
  const all = [];
  let pages = 0;
  do {
    const page = (await rpc("work.list", cursor ? { cursor } : {})).result;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024);
    assert.ok(page.data.length <= 30);
    if (!pages) {
      assert.equal(page.data.length, 30);
      assert.equal(page.complete, false);
    }
    all.push(...page.data);
    cursor = page.nextCursor;
    pages++;
    assert.equal(page.complete, cursor === null);
  } while (cursor);
  const oversized = all.find((row) => row.taskId === oversizedTask.id);
  assert.ok(oversized.summaryTruncated);
  assert.ok(Buffer.byteLength(oversized.title) <= 512);
  assert.ok(!JSON.stringify(all).includes(hugeTitle));
  assert.equal(
    new Set(
      all.map((row) => (row.kind === "taskRun" ? `${row.taskId}/${row.runId}` : row.threadId)),
    ).size,
    all.length,
  );
  assert.equal(all.length, 42);
  assert.equal(pages, 2);
  const projectButton = page.getByRole("button", { name: "workspace", exact: true });
  if ((await projectButton.getAttribute("aria-expanded")) === "true") await projectButton.click();
  await projectButton.click();
  const expectedIds = [
    ...new Set(all.filter((row) => row.threadId).map((row) => row.threadId)),
  ].sort();
  await waitFor(async () => {
    const ids = await page
      .locator(".remote-session-row")
      .evaluateAll((rows) => rows.map((row) => row.dataset.threadId));
    if (ids.length === expectedIds.length) {
      assert.deepEqual([...new Set(ids)].sort(), expectedIds);
      return true;
    }
    const more = page.getByRole("button", { name: /^(Show more|加载更多)$/ });
    if (await more.first().isVisible()) await more.first().click();
    return false;
  }, "public project pagination contains every original Core Thread without duplicates");
  checks.push(
    "default 30, multi-page cursor without duplicates, 128 KiB budget, oversized Task title bounded; real project pagination loads every original Thread",
  );
  await browser.close();
  browser = null;
  await verifyRealVisibility(remote, projectId);
  checks.push("unemulated Chrome tab is hidden: no polling; real foreground resumes immediately");
  const unknownId = await createWork("RC03_UNKNOWN");
  await waitFor(async () => {
    try {
      return (await readFile(unknownMarker, "utf8")) === "x";
    } catch {
      return false;
    }
  }, "real Runtime side effect begins");
  assert.equal(
    project.model.state.threads[unknownId],
    undefined,
    "unknown tool thread was never opened on desktop",
  );
  const oldGeneration = project.service.generation;
  process.kill(project.service.corePid, "SIGKILL");
  await waitFor(() => writer.closed && !project.client?.ready, "Core lost while tool in flight");
  const offline = await rpc("work.list");
  assert.equal(offline.error.code, "CORE_UNAVAILABLE");
  await backend.restartProject(project);
  assert.notEqual(project.service.generation, oldGeneration);
  const unknownRows = [];
  let unknownCursor;
  do {
    const result = await rpc("work.list", unknownCursor ? { cursor: unknownCursor } : {});
    assert.ok(!result.error, JSON.stringify(result));
    unknownRows.push(...result.result.data);
    unknownCursor = result.result.nextCursor;
  } while (unknownCursor);
  const unknown = unknownRows.find((row) => row.threadId === unknownId);
  assert.equal(unknown.execution.turnStatus, "failed");
  assert.ok(unknown.attentionRefs.some((item) => item.kind === "executionUnknown"));
  assert.equal(
    await readFile(unknownMarker, "utf8"),
    "x",
    "overview did not replay or acknowledge the unknown tool",
  );
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const unknownPage = await browser.newPage();
  const unknownInvite = await remote.control({ operation: "pair" });
  await unknownPage.goto(unknownInvite.payload);
  await unknownPage.getByRole("button", { name: "连接电脑" }).click();
  await unknownPage
    .getByRole("status")
    .getByText(/等待桌面确认/)
    .waitFor({ timeout: 10000 });
  const unknownPending = (await remote.control({ operation: "status" })).pending[0];
  await remote.control({
    operation: "approve",
    id: unknownPending.id,
    projects: [projectId],
    preset: "Observer",
  });
  await unknownPage
    .getByRole("status")
    .getByText(/已连接/)
    .waitFor();
  const unknownRow = unknownPage.locator(`.remote-session-row[data-thread-id="${unknownId}"]`);
  await waitFor(async () => {
    if (await unknownRow.isVisible()) return true;
    const more = unknownPage.getByRole("button", { name: /^(Show more|加载更多)$/ });
    if (await more.first().isVisible()) await more.first().click();
    return false;
  }, "original UNKNOWN Thread visible through project pagination");
  await unknownRow.click();
  await waitFor(
    async () =>
      (await unknownPage.locator("#session-attention").textContent()).includes("executionUnknown"),
    "same native UNKNOWN visible through original Session attention",
  );
  await unknownPage.screenshot({ path: join(scratch, "unknown-overview.png"), fullPage: true });
  assert.equal(await readFile(unknownMarker, "utf8"), "x");
  checks.push(
    "real Runtime write then Core crash/restart: never-opened UNKNOWN visible in production Session, native failed terminal retained, effect not replayed",
  );
  passed = true;
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
} finally {
  remoteClient?.close();
  writer?.close();
  for (const client of extraWriters) client.close();
  await browser?.close();
  service?.close();
  for (const project of backend.projects.values()) {
    try {
      await project.client?.request("areal/server/drain", { strategy: "cancel", timeoutMs: 30000 });
    } catch {}
  }
  const instances = [];
  for (const project of backend.projects.values()) {
    if (!project.service) continue;
    let unknown = false;
    try {
      unknown =
        (await project.client.request("areal/server/status", {})).unresolvedTools.length > 0;
    } catch {}
    instances.push({ service: project.service, unknown });
  }
  await backend.disconnect();
  const cleanup = [];
  for (const { service: instance, unknown } of instances) {
    try {
      if (unknown) {
        // 验收后只结束隔离进程，不为了清理而确认未知工具；保留原持久 UNKNOWN 证据。
        const descriptorPath = join(
          scratch,
          "registry",
          "services",
          instance.serviceId,
          "service.json",
        );
        const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
        assert.equal(descriptor.generation, instance.generation);
        assert.equal(descriptor.hostPid, instance.hostPid);
        const command = execFileSync("ps", ["-p", String(instance.hostPid), "-o", "command="], {
          encoding: "utf8",
        });
        assert.ok(command.startsWith(`${backend.binary} service-host`));
        process.kill(instance.hostPid, "SIGTERM");
        await waitFor(
          async () => JSON.parse(await readFile(descriptorPath, "utf8")).state === "stopped",
          "isolated UNKNOWN fixture host cleanup",
          30000,
        );
        cleanup.push({
          instance: instance.serviceId,
          state: "stopped",
          method: "fixture host SIGTERM; UNKNOWN not acknowledged",
        });
      } else {
        const result = JSON.parse(
          execFileSync(
            backend.binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            {
              env: { ...process.env, AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry") },
              encoding: "utf8",
              timeout: 60000,
            },
          ),
        );
        cleanup.push({
          instance: instance.serviceId,
          state: result.state,
          method: "service stop --cancel",
        });
      }
    } catch (error) {
      cleanup.push({ instance: instance.serviceId, error: error.message });
      passed = false;
      process.exitCode = 1;
    }
  }
  await writeFile(join(scratch, "cleanup.json"), JSON.stringify(cleanup, null, 2));
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        modelRequests,
        transport: "direct-loopback",
        command: "pnpm --dir clients/gui run test:remote-work-overview",
        source: {
          revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          dirty: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
          diffSha256: createHash("sha256")
            .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
            .digest("hex"),
        },
        cleanup,
        core: { binary: backend.binary, sha256: await fileSha256(backend.binary) },
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        notRun: [
          "public HTTPS/WSS",
          "mobile devices",
          "system keychain",
          "signed package",
          "Relay",
        ],
      },
      null,
      2,
    ),
  );
}
