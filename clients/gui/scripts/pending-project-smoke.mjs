import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
  stopFixtureHost,
} from "./application-cleanup.mjs";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { sendReady } from "./support/journey-fixture.mjs";
import { until } from "./support/desktop-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gui = join(root, "clients/gui");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "Use an absolute path to the built Core");
assert.ok(!process.env.AREAL_GUI_EXECUTABLE, "This runner validates source Electron");
const scratch = await makeTempDir("creation-recovery-");
const workspace = join(scratch, "workspace"),
  execution = join(scratch, "legacy-worktree");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const projectId = sha(workspace).slice(0, 24),
  executionProjectId = sha(execution).slice(0, 24);
const requestId = randomUUID();
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const checks = [],
  requests = [],
  errors = [];
await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
const pluginRoot = join(workspace, "packages/pending-fixture");
await mkdir(join(pluginRoot, "skills/proof"), { recursive: true });
await json(join(pluginRoot, "plugin.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "pending-fixture",
  version: "1.0.0",
  description: "Pending project acceptance",
});
await writeFile(
  join(pluginRoot, "skills/proof/SKILL.md"),
  "---\nname: pending-proof\ndescription: Pending project proof skill\n---\nPENDING_SKILL_BODY\n",
);
await json(join(workspace, ".agents/plugins/marketplace.json"), {
  name: "pending-market",
  plugins: [
    { name: "pending-fixture", source: { source: "local", path: "./packages/pending-fixture" } },
  ],
});
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ],
  { cwd: workspace, stdio: "ignore" },
);
execFileSync("git", ["worktree", "add", "-b", "legacy-fixture", execution], {
  cwd: workspace,
  stdio: "ignore",
});
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: join(scratch, "user"),
  AREAL_CORE_BIN: binary,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
});
for (const directory of [
  env.AREAL_CORE_HOME,
  env.AREAL_CORE_USER_HOME,
  join(env.AREAL_CORE_HOME, "worktree-requests"),
])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const pending = [
  {
    method: "areal/thread/start",
    params: {
      requestId,
      cwd: execution,
      text: "ORIGINAL_PRIVATE_CREATION",
      model: { providerId: "fixture", modelId: "fixture" },
    },
    operation: { method: "areal/thread/start", requestId, target: { kind: "project" } },
    at: "2026-01-01T00:00:00.000Z",
  },
];
const binding = {
  kind: "thread",
  requestId,
  projectId,
  executionProjectId,
  state: "binding",
  intent: "continue",
  parameters: { worktree: { mode: "worktree" } },
  sourceRoot: workspace,
  createdAt: "2026-01-01T00:00:00.000Z",
  automatic: false,
  events: [],
  record: {
    directory: execution,
    cwd: execution,
    branch: "legacy-fixture",
    base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(),
    target: workspace,
  },
};
await json(join(env.AREAL_CORE_HOME, "projects.json"), [
  { id: projectId, root: workspace },
  {
    id: executionProjectId,
    root: execution,
    logicalProjectId: projectId,
    worktreeRequestId: requestId,
  },
]);
const pendingPath = join(env.AREAL_CORE_HOME, `${executionProjectId}-pending.json`);
const bindingPath = join(env.AREAL_CORE_HOME, "worktree-requests", `${requestId}.json`);
await json(pendingPath, pending);
await json(bindingPath, binding);
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, res)) return;
  requests.push(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "PENDING_PROJECT_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  env.AREAL_CORE_CONFIG,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true},{id="fixture-configured",enabled=true}]\n`,
);
const evidence = { requestId, projectId, executionProjectId, binary, checks, errors };
const originalPaths = [pendingPath, bindingPath];
const originalBytes = await Promise.all(originalPaths.map((path) => readFile(path)));
const imports = join(env.AREAL_HARNESS_SERVICE_HOME, "host", "imports");
const observed = [];
let configuration;
let app, page, host, failure;
const button = (name) => page.getByRole("button", { name, exact: true });
const capture = (name) => page.screenshot({ path: join(scratch, `${name}.png`) });
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function verifyOriginals() {
  const expected = [`${executionProjectId}-pending.json`, `worktree-requests/${requestId}.json`];
  for (const id of await readdir(imports)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const record = await readJson(join(imports, id, "record.json"));
    const originals = expected.map((name) =>
      record.originals.find((file) => file.relativeName === name),
    );
    if (originals.some((file) => !file)) continue;
    for (const [index, file] of originals.entries()) {
      const stored = await readFile(
        join(imports, id, "backups", file.original.backupId + ".bytes"),
      );
      assert.deepEqual(stored, originalBytes[index], "The stopped import preserves original bytes");
    }
    return id;
  }
  throw new Error(
    "Original pending submission and linked worktree binding are missing from backups",
  );
}

async function manage(operation, params = {}) {
  const reply = await page.evaluate((request) => window.arealDesktop.command("manage", request), {
    operation,
    projectId,
    ...params,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}

function observeRecovery(socket) {
  const remote = socket.connectToServer();
  const reads = new Map();
  socket.onMessage((message) => {
    const { id, method, commandId, params, context } = JSON.parse(message.toString());
    if (
      method === "desktop.command" &&
      params?.command === "reconcile" &&
      params.request?.requestId === requestId
    ) {
      reads.set(id, { id, method, request: params.request });
    }
    if (method === "session.create" || method === "session.send")
      reads.set(id, { method, commandId, projectId: context?.projectId });
    if (
      configuration &&
      method === "desktop.command" &&
      params?.command === "configure" &&
      params.request?.threadId === configuration.threadId
    ) {
      configuration.writes.push(params.request.requestId);
      reads.set(id, { configure: true });
    }
    const configId = configuration?.dropped && configuration.writes[0];
    if (configId && method === "command.read" && params?.commandId === configId)
      reads.set(id, { commandId: configId, method });
    if (
      configId &&
      method === "desktop.command" &&
      params?.command === "reconcile" &&
      (params.request.requestId === configId || !params.request.requestId)
    ) {
      reads.set(id, { id, method, request: params.request, configId });
    }
    remote.send(message);
  });
  remote.onMessage((message) => {
    const { id, result, error } = JSON.parse(message.toString());
    const read = reads.get(id);
    if (read) {
      reads.delete(id);
      if (read.configure) {
        configuration.errorCode = error?.code;
        if (result && !error && !configuration.dropped) {
          configuration.dropped = true;
          void Promise.allSettled([socket.close(), remote.close()]);
          return;
        }
      }
      if (read.configId && !read.request.requestId && result?.outcomes?.[read.configId]) {
        const outcomes = { ...result.outcomes };
        delete outcomes[read.configId];
        socket.send(JSON.stringify({ version: 1, id, result: { ...result, outcomes } }));
        return;
      }
      observed.push({
        ...read,
        outcomes: result?.outcomes,
        admissionState: result?.admissionState,
        errorCode: error?.code ?? result?.error?.code,
      });
    }
    socket.send(message);
  });
}
console.log("Creation recovery evidence:", scratch);
try {
  evidence.source = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  evidence.coreSHA256 = sha(await readFile(binary));
  evidence.rendererSHA256 = sha(await readFile(join(gui, "renderer/dist/index.html")));
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  evidence.electronPid = app.process().pid;
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  const workbench = page.getByTestId("areal-workbench");
  const ready = workbench.and(page.locator('[data-startup-ready="true"]'));
  await ready.waitFor({ timeout: 120000 });
  host = await until(() => readFixtureHost(env), "Original isolated Host identity");
  evidence.hostPid = host.pid;
  await page.routeWebSocket(/\/host\/socket$/, observeRecovery);
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
  const migrationId = await verifyOriginals();
  const fences = await Promise.all(originalPaths.map((path) => readFile(path)));

  await createProjectConversation(page, "workspace");
  await button("选择模型").click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  await button("新会话工作区").click();
  const worktreeToggle = page.getByRole("switch", { name: "在新工作树中工作", exact: true });
  await worktreeToggle.waitFor();
  assert.equal(await worktreeToggle.isChecked(), false);
  await page.keyboard.press("Escape");
  const input = page.getByTestId("chat-input");
  await input.fill("Independent fresh draft with selected skill");
  await sendReady(page);
  assert.equal(await page.getByTestId("toast").filter({ hasText: "操作结果待确认。" }).count(), 0);
  await capture("draft-available");

  await button("设置").click();
  await button("常规").click();
  await button("打开高级诊断").click();
  await page.getByRole("heading", { name: "待核对的会话创建", exact: true }).waitFor();
  await page.getByText(requestId, { exact: false }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /NaN|ORIGINAL_PRIVATE_CREATION/);
  await button("检查操作状态").click();
  await page.getByText("已核对，原操作仍未确认。未重新提交。", { exact: true }).waitFor();
  const check = observed.find((entry) => entry.method === "desktop.command");
  assert.deepEqual(check?.request, {
    projectId: executionProjectId,
    executionProjectId,
    requestId,
  });
  assert.deepEqual(check.outcomes, {});
  await capture("original-worktree-unknown");

  const client = new HostClient();
  try {
    await client.connect(env.AREAL_HARNESS_SERVICE_HOME);
    assert.equal(client.hostId, host.hostId);
    assert.equal(client.generation, host.generation);
    const source = await client.sourceState({
      profile: env.AREAL_GUI_USER_DATA,
      coreHome: env.AREAL_CORE_HOME,
      legacyServiceHome: env.AREAL_HARNESS_SERVICE_HOME,
    });
    const owner = source.bindings.find(
      (item) => item.alias.legacyProjectId === executionProjectId && item.workspace === execution,
    );
    assert.ok(owner?.projectId, "Original worktree has its own canonical Host registration");
    const journal = (await client.journal(owner.projectId).read()).snapshot;
    assert.ok(!journal.pending.some((item) => item.params?.requestId === requestId));
    assert.equal(journal.outcomes[requestId], undefined);
  } finally {
    client.close();
  }
  checks.push("The original linked worktree UNKNOWN is visible and checked only on its own owner");

  await button("返回应用").click();
  const pluginId = "pending-fixture@pending-market";
  const catalog = await manage("plugins");
  const candidate = catalog.data.find((row) => row.id === pluginId);
  assert.ok(candidate, "Core discovers the fixture plugin");
  await manage("pluginInstall", {
    id: pluginId,
    scope: "project",
    expectedRevision: catalog.revision,
    source: candidate.source,
    expectedDigest: candidate.sourceDigest,
  });
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", {
      name: "插件",
      exact: true,
    })
    .click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", {
      name: "个人",
      exact: true,
    })
    .click();
  await button(`查看插件 ${pluginId}`).click();
  const skillSwitch = page.getByRole("switch", {
    name: "在当前项目启用 Skill pending-proof",
    exact: true,
  });
  await skillSwitch.waitFor();
  assert.equal(await skillSwitch.isEnabled(), true);
  assert.equal(await button("核对项目操作").count(), 0);
  await skillSwitch.click();
  await until(async () => !(await skillSwitch.isChecked()), "Skill disabled");
  const disabled = await manage("plugin", { id: pluginId });
  assert.ok(disabled.componentChoices.disabledSkills.includes(disabled.installedSkills[0].id));
  await skillSwitch.click();
  await until(() => skillSwitch.isChecked(), "Skill enabled");
  assert.deepEqual((await manage("plugin", { id: pluginId })).componentChoices.disabledSkills, []);
  await capture("skill-enabled");

  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "首页", exact: true })
    .click();
  if (await button("展开侧栏").isVisible()) await button("展开侧栏").click();
  await createProjectConversation(page, "workspace");
  await input.fill("Independent fresh draft with selected skill");
  await button("添加功能与 Skills").click();
  await page.getByRole("option").filter({ hasText: "pending-proof" }).click();
  await sendReady(page);
  await button("发送").click();
  const created = await until(
    () => observed.find((entry) => entry.method === "session.create"),
    "Original Host creation response",
  );
  assert.equal(created.admissionState, "accepted", JSON.stringify(created));
  await page.getByText("PENDING_PROJECT_OK", { exact: true }).waitFor();
  const threadId = await workbench.getAttribute("data-thread-id");
  assert.ok(threadId);
  const thread = await until(async () => {
    const candidate = await readCoreThread({ binary, env, gui, workspace, threadId });
    return candidate.turns?.at(-1)?.status === "completed" ? candidate : null;
  }, "Independent original Core Turn completed");
  assert.equal(thread.turns.length, 1);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /PENDING_SKILL_BODY/);
  assert.equal(observed.filter((row) => row.method === "session.create").length, 1);
  assert.equal(observed.filter((row) => row.method === "session.send").length, 1);
  assert.equal(await verifyOriginals(), migrationId);
  assert.deepEqual(await Promise.all(originalPaths.map((path) => readFile(path))), fences);
  checks.push("Skill changes persist and the independent draft runs once with the selected Skill");
  await capture("independent-draft-completed");
  await json(join(scratch, "history.json"), thread);

  configuration = { threadId, writes: [] };
  const unsent = "Keep this draft during configuration recovery.";
  await input.fill(unsent);
  await button("选择模型").click();
  await page.getByRole("radio", { name: "fixture-configured", exact: true }).click();
  await until(
    () => configuration.dropped || configuration.errorCode,
    "Lost original configuration response",
  );
  assert.equal(configuration.dropped, true, configuration.errorCode);
  const [configId] = configuration.writes;
  const originalConfig = await until(
    () =>
      observed.find((entry) => entry.configId === configId && entry.request.requestId === configId),
    "Renderer checks the exact original configuration",
  );
  const outcome = originalConfig.outcomes?.[configId];
  assert.equal(outcome?.status, "completed");
  assert.equal(outcome.operation.requestId, configId);
  assert.equal(outcome.operation.target.threadId, threadId);
  assert.deepEqual(configuration.writes, [configId]);
  assert.ok(
    observed.some(
      (entry) =>
        entry.method === "command.read" &&
        entry.commandId === configId &&
        entry.admissionState === "notFound",
    ),
  );
  const configKey = `areal-gui:draft:${projectId}:${threadId}:pending-configure`;
  await page.waitForFunction((key) => localStorage.getItem(key) === null, configKey);
  assert.equal(await input.innerText(), unsent);
  assert.equal(requests.length, 1);
  checks.push(
    "The original configuration is reconciled by exact receipt without sending the draft",
  );
  await capture("configuration-recovered");

  // 模拟旧版本留下的定时草稿。当前新建入口打开独立表单，提交前没有新会话。
  const scheduleDraft = {
    prepareId: randomUUID(),
    requestId,
    projectId,
    pending: true,
    text: "Retained schedule intent",
  };
  const scheduleKey = "areal-gui:ordinary-schedule-creation";
  await page.evaluate(
    ({ scheduleKey, scheduleDraft }) =>
      localStorage.setItem(scheduleKey, JSON.stringify(scheduleDraft)),
    { scheduleKey, scheduleDraft },
  );
  await button("定时任务").click();
  const mark = observed.length;
  await button("新建定时任务").click();
  const leave = button("保留原记录，返回任务列表");
  await leave.waitFor();
  const scheduleRead = observed.slice(mark).find((entry) => entry.method === "desktop.command");
  assert.equal(scheduleRead?.request.requestId, requestId);
  assert.deepEqual(scheduleRead.outcomes, {});
  const confirm = page.waitForEvent("dialog").then(async (dialog) => {
    assert.equal(dialog.type(), "confirm");
    await dialog.accept();
  });
  await Promise.all([confirm, leave.click()]);
  const retained = await page.evaluate(
    ({ requestId, scheduleKey }) => ({
      active: localStorage.getItem(scheduleKey),
      retained: JSON.parse(
        localStorage.getItem(`areal-gui:retained-schedule-creation:${requestId}`),
      ),
    }),
    { requestId, scheduleKey },
  );
  assert.deepEqual(retained, { active: null, retained: scheduleDraft });
  await button("新建定时任务").click();
  await page.getByRole("textbox", { name: "指令", exact: true }).waitFor();
  assert.ok(!observed.slice(mark).some((row) => row.method.startsWith("session.")));
  assert.equal(requests.length, 1);
  checks.push(
    "Historical schedule intent is retained while a fresh scheduling form can open without replay",
  );
  await capture("schedule-fresh");
} catch (error) {
  failure = error.stack;
  console.error(failure);
  if (page) await captureSmokeFailure(page, scratch, error).catch(() => {});
} finally {
  if (host) {
    try {
      const current = await readFixtureHost(env);
      assert.equal(current?.hostId, host.hostId);
      assert.equal(current.generation, host.generation);
      const receipt = await stopFixtureHost(binary, env.AREAL_HARNESS_SERVICE_HOME, scratch);
      assert.equal(receipt?.state, "completed");
      evidence.stopRequestId = receipt.requestId;
    } catch (error) {
      errors.push(error.stack);
    }
  }
  try {
    if (app) {
      await withSmokeDeadline("Electron quit preparation", () =>
        app.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 0 });
        }),
      ).catch((error) => errors.push(error.message));
      await closeSmokeApplication(app, 60000);
    }
  } catch (error) {
    errors.push(error.stack);
  }
  try {
    if (host) {
      await assertApplicationStopped(binary, env, { pid: evidence.electronPid, hostPid: host.pid });
    } else {
      const receipt = await settleFixtureHostAfterQuit(binary, env, scratch, {
        pid: evidence.electronPid,
      });
      evidence.stopRequestId = receipt?.requestId;
    }
  } catch (error) {
    errors.push(error.stack);
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (sha(await readFile(binary)) !== evidence.coreSHA256) errors.push("Core binary changed");
  const passed = !failure && !errors.length;
  await json(join(scratch, "manifest.json"), { ...evidence, observed, failure, passed });
  console.log("Creation recovery result:", passed ? "PASS" : "FAIL");
  if (!passed) process.exitCode = 1;
}
