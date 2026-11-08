import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gui = process.env.AREAL_RECOVERY_GUI_ROOT
  ? resolve(process.env.AREAL_RECOVERY_GUI_ROOT, "clients/gui")
  : join(root, "clients/gui");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(
  binary?.startsWith(join(root, ".local/dev-bin/")),
  "Use this checkout’s private fixed Core slot",
);
assert.ok(!process.env.AREAL_GUI_EXECUTABLE, "This runner validates source Electron");
const red = process.argv.includes("--red");
const recoveryNotices = process.argv.includes("--recovery-notices");
const scratch = await makeTempDir("apending-");
await mkdir(join(root, ".scratch/pending-project"), { recursive: true });
const evidence = await mkdtemp(join(root, ".scratch/pending-project/run-"));
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
const until = async (read, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timeout: ${label}`);
};
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
  await mkdir(directory, { recursive: true });
const pending = [
  {
    method: "areal/thread/start",
    params: { requestId, cwd: execution, model: { providerId: "fixture", modelId: "fixture" } },
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
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const tracePath = join(evidence, "core-calls.jsonl");
const responseLossPath = join(evidence, "response-loss.json");
const setResponseLoss = async (value) => {
  await json(`${responseLossPath}.next`, value);
  await rename(`${responseLossPath}.next`, responseLossPath);
};
await writeFile(tracePath, "");
const application = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
if (process.argv.includes('--areal-core-service')) {
  const { CoreBackend } = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"))});
  const { SubmissionRecovery } = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/submission-recovery.cjs"))});
  const fs = require('node:fs');
  const trace = value => require('node:fs').appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + '\\n');
  const loss = () => fs.existsSync(${JSON.stringify(responseLossPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(responseLossPath)}, 'utf8')) : undefined;
  const submission = SubmissionRecovery.prototype.requestSubmission;
  SubmissionRecovery.prototype.requestSubmission = async function(project, method, params) {
    const control = loss();
    if (${recoveryNotices} && control?.armed && control.beforeDispatch && control.method === method) {
      if (project.root !== ${JSON.stringify(workspace)} || !Number.isSafeInteger(project.service?.corePid))
        throw new Error('Fixture may kill only its own workspace Core');
      fs.writeFileSync(${JSON.stringify(`${responseLossPath}.next`)}, JSON.stringify({ ...control, armed: false,
        requestId: params.requestId, owner: project.id, originalBinding: params.creationAdmission }));
      fs.renameSync(${JSON.stringify(`${responseLossPath}.next`)}, ${JSON.stringify(responseLossPath)});
      trace({ kind: 'not-dispatched', owner: project.id, method, params });
      process.kill(project.service.corePid, 'SIGKILL');
      throw Object.assign(new Error('Fixture Core exited before dispatch'), { submissionUnknown: true, requestId: params.requestId });
    }
    const result = await submission.call(this, project, method, params);
    if (${recoveryNotices} && control?.armed && control.method === method) {
      fs.writeFileSync(${JSON.stringify(`${responseLossPath}.next`)}, JSON.stringify({ ...control, armed: false, requestId: params.requestId, owner: project.id, result }));
      fs.renameSync(${JSON.stringify(`${responseLossPath}.next`)}, ${JSON.stringify(responseLossPath)});
      trace({ kind: 'response-lost', owner: project.id, submissionMethod: method, params, result });
      throw Object.assign(new Error('Fixture lost response after real Core admission'), { submissionUnknown: true, requestId: params.requestId });
    }
    return result;
  };
  const execute = CoreBackend.prototype.command;
  CoreBackend.prototype.command = async function(name, request, ...args) {
    trace({ kind: 'desktop-command', name, request });
    const control = loss();
    if (control?.releaseOnCheck && control.requestId === request.requestId && ['reconcile', 'workspace'].includes(name)) {
      fs.writeFileSync(${JSON.stringify(`${responseLossPath}.next`)}, JSON.stringify({ ...control, hold: false, releaseOnCheck: false }));
      fs.renameSync(${JSON.stringify(`${responseLossPath}.next`)}, ${JSON.stringify(responseLossPath)});
    }
    const result = await execute.call(this, name, request, ...args);
    trace({ kind: 'desktop-result', name, request });
    return result;
  };
  const instrumentClient = (project, client) => {
    if (!client || client.__pendingTrace) return;
    const request = client.request.bind(client);
    client.request = async (method, params, ...options) => {
      trace({ owner: project.id, method, params });
      const result = await request(method, params, ...options);
      const control = loss();
      if (method === 'areal/request/read' && control?.hold && control.requestId === params.requestId) {
        trace({ kind: 'receipt-hidden', owner: project.id, method, params });
        return { ...result, data: [] };
      }
      return result;
    };
    client.__pendingTrace = true;
  };
  const receipt = SubmissionRecovery.prototype.readReceipt;
  SubmissionRecovery.prototype.readReceipt = function(project, entry, client, ...options) {
    instrumentClient(project, client);
    return receipt.call(this, project, entry, client, ...options);
  };
  const connect = CoreBackend.prototype.connect;
  CoreBackend.prototype.connect = async function(project, ...args) {
    const result = await connect.call(this, project, ...args);
    instrumentClient(project, project.client);
    return result;
  };
}
`,
);
const manifest = {
  red,
  recoveryNotices,
  passed: false,
  checks,
  errors,
  scratch,
  evidence,
  requestId,
  projectId,
  executionProjectId,
  runtimeGui: gui,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  helperSHA256: sha(await readFile(fileURLToPath(import.meta.url))),
  diffSHA256: sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })),
  binary,
  coreSHA256: sha(await readFile(binary)),
  fixtureBoundary:
    "Synthetic legacy pending journal, registered linked worktree owner, and binding seeded before startup; no original mutation was executed. Native project picker, retention confirmation and quit confirmation injected. Recovery-notices mode also drops one Desktop submission response after real Core admission and temporarily hides that exact request's real receipt, controlled by response-loss.json; all dispatched mutations reach real Core unchanged. The retired-instance case kills only the fixture Core after Desktop pending persistence and before RPC dispatch.",
  scope:
    "Source Electron Renderer → preload/Main → Desktop → real Core with deterministic local model; no real provider, package, physical input or native picker acceptance",
};
const assets = (await readdir(join(gui, "renderer/dist/assets"))).filter((name) =>
  /\.(js|css)$/.test(name),
);
manifest.rendererSHA256 = Object.fromEntries(
  await Promise.all(
    assets.map(async (name) => [
      name,
      sha(await readFile(join(gui, "renderer/dist/assets", name))),
    ]),
  ),
);
console.log(`Pending project evidence: ${evidence}`);
let app,
  page,
  metadata,
  failure,
  stderr = "";
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const logical = (snapshot) => snapshot.projects.find((project) => project.id === projectId);
const button = (name) => page.getByRole("button", { name, exact: true });
// 本专项使用按钮的真实键盘入口；侧栏鼠标命中问题另留失败证据。
const createProjectConversation = async (page, projectName) => {
  const create = page.getByRole("button", {
    name: `在项目 ${projectName} 中新建对话`,
    exact: true,
  });
  await create.focus();
  await create.press("Enter");
  await page.getByTestId("chat-input").waitFor();
};
const call = async (name, params) => {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const trace = async () =>
  (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const capture = async (name) => {
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  await json(join(evidence, `${name}.snapshot.json`), await state());
};
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr?.on("data", (bytes) => {
    stderr += bytes;
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "Desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await until(async () => logical(await state())?.state?.connected, "logical Core ready");
  if (recoveryNotices) await call("connect", { projectId: executionProjectId });
  else await call("reconcile", { projectId, requestId });
  await until(
    async () =>
      logical(await state())?.pending.some((entry) => entry.params?.requestId === requestId),
    "legacy pending aggregated",
  );
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  await json(join(evidence, "runtime.json"), {
    mainPid: app.process().pid,
    desktopPid: metadata.pid,
    profile: env.AREAL_GUI_USER_DATA,
  });
  await page.evaluate(() =>
    localStorage.setItem(
      "areal-gui:application-preferences",
      JSON.stringify({ nextPromptSuggestions: false }),
    ),
  );
  await page.reload();
  await until(
    async () =>
      (await state()).connection?.state === "ready" && logical(await state())?.state?.connected,
    "reloaded isolated preferences",
  );
  if (process.env.AREAL_PENDING_SCHEDULE_RECOVERY === "1") {
    const scheduleDraft = {
      prepareId: randomUUID(),
      requestId,
      projectId,
      pending: true,
      text: "Retained schedule intent",
    };
    await page.evaluate(
      (draft) =>
        localStorage.setItem("areal-gui:ordinary-schedule-creation", JSON.stringify(draft)),
      scheduleDraft,
    );
    await button("定时任务").click();
    const checkStart = (await trace()).length;
    await button("新建定时任务").click();
    await until(
      async () =>
        (await trace())
          .slice(checkStart)
          .some((call) => call.kind === "desktop-result" && call.name === "reconcile"),
      "schedule original request checked",
    );
    const scheduleCheck = (await trace())
      .slice(checkStart)
      .find((call) => call.kind === "desktop-command" && call.name === "reconcile");
    assert.equal(
      scheduleCheck.request.requestId,
      requestId,
      "Schedule recovery must reconcile the original request identity",
    );
    const leave = button("保留原记录，返回任务列表");
    await leave.waitFor();
    await capture("schedule-unknown");
    await page.evaluate(() => {
      window.confirm = (message) => {
        window.__retainedCreationPrompt = message;
        return true;
      };
    });
    await leave.click();
    const retained = await page.evaluate(
      (id) => ({
        active: localStorage.getItem("areal-gui:ordinary-schedule-creation"),
        retained: JSON.parse(
          localStorage.getItem(`areal-gui:retained-schedule-creation:${id}`) ?? "null",
        ),
      }),
      requestId,
    );
    assert.equal(retained.active, null, "Leaving recovery releases only the active draft slot");
    assert.deepEqual(
      retained.retained,
      scheduleDraft,
      "Original frozen schedule draft remains inspectable",
    );
    assert.ok(
      !(await trace())
        .slice(checkStart)
        .some((call) => call.kind === "desktop-command" && call.name === "create"),
      "Leaving unknown creation never creates or replays a request",
    );
    await button("新建定时任务").click();
    await page.getByTestId("chat-input").waitFor();
    await until(
      async () =>
        (await page.getByTestId("chat-input").innerText()).includes("帮我创建一个定时任务"),
      "fresh schedule conversation opens",
    );
    const creates = (await trace())
      .slice(checkStart)
      .filter((call) => call.kind === "desktop-command" && call.name === "create");
    assert.equal(creates.length, 1, "Explicit new schedule creates exactly one new conversation");
    assert.notEqual(creates[0].request.requestId, requestId, "Fresh schedule uses a new identity");
    assert.equal(
      requests.length,
      0,
      "Recovery and opening a new schedule do not send the retained intent",
    );
    await capture("schedule-fresh");
    checks.push(
      "Unknown schedule can be retained without replay; explicit new creation opens a new real Core conversation",
    );
  }
  await createProjectConversation(page, "workspace");
  if (recoveryNotices) {
    await capture("00-historical-request-fresh-draft");
    assert.equal(
      await page.getByTestId("toast").filter({ hasText: "操作结果待确认。" }).count(),
      0,
      "Historical Worktree request must not appear as the fresh draft's operation warning",
    );
  }
  const workspaceSettings = button("新会话工作区");
  await capture("00-workspace-settings");
  assert.equal(
    await workspaceSettings.isEnabled(),
    true,
    "Unrelated retained creation must not disable new-chat workspace settings",
  );
  await workspaceSettings.click();
  const worktreeToggle = page.getByRole("switch", { name: "在新工作树中工作", exact: true });
  await worktreeToggle.waitFor();
  assert.equal(await worktreeToggle.isChecked(), false, "Opening settings keeps worktree opt-in");
  await page.keyboard.press("Escape");
  checks.push(
    "New-chat workspace settings open with unrelated retained creation; worktree stays off",
  );
  await page.getByTestId("chat-input").fill("Independent fresh draft");
  const draftEnabled = await button("发送").isEnabled();
  await capture("01-fresh-draft");
  manifest.draftEnabled = draftEnabled;
  const pluginId = "pending-fixture@pending-market";
  const catalog = await call("manage", { projectId, operation: "plugins" });
  await json(join(evidence, "plugin-catalog.json"), catalog);
  const candidate = catalog.data.find((row) => row.id === pluginId);
  assert.ok(candidate, "Real Core discovers local plugin");
  await call("manage", {
    projectId,
    operation: "pluginInstall",
    id: pluginId,
    scope: "project",
    expectedRevision: catalog.revision,
    source: candidate.source,
    expectedDigest: candidate.sourceDigest,
  });
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", { name: "个人", exact: true })
    .click();
  await button(`查看插件 ${pluginId}`).click();
  await button("管理").click();
  const skillSwitch = page.getByRole("switch", {
    name: "在当前项目启用 Skill pending-proof",
    exact: true,
  });
  await skillSwitch.waitFor();
  manifest.skillEnabled = await skillSwitch.isEnabled();
  await capture("02-plugin-management");
  assert.equal(
    await page.getByText("历史会话创建记录（待核对）", { exact: true }).count(),
    0,
    "Unrelated creation records are absent from plugin management",
  );
  assert.equal(
    await button("核对项目操作").count(),
    0,
    "Plugin management has no unrelated project recovery action",
  );
  await button("设置").click();
  await button("常规").click();
  await button("打开高级诊断").click();
  await page.getByRole("heading", { name: "待核对的会话创建", exact: true }).waitFor();
  await page.getByText(requestId, { exact: false }).waitFor();
  const beforeCheck = (await trace()).length;
  await button("检查操作状态").click();
  await until(
    async () =>
      (await trace())
        .slice(beforeCheck)
        .some((call) => call.kind === "desktop-result" && call.name === "reconcile"),
    "explicit GUI reconciliation complete",
  );
  await until(async () => !(await button("正在核对项目操作…").count()), "project check complete");
  await button("检查操作状态").scrollIntoViewIfNeeded();
  await capture("03-checked-unknown");
  const checkCalls = (await trace()).slice(beforeCheck);
  await json(join(evidence, "project-check-calls.json"), checkCalls);
  const explicitCheck = checkCalls.find(
    (call) => call.kind === "desktop-command" && call.name === "reconcile",
  );
  manifest.explicitCheck = explicitCheck;
  manifest.checkOwners = checkCalls
    .filter((call) => call.method === "areal/request/read" && call.params?.requestId === requestId)
    .map((call) => call.owner);
  if (red) {
    assert.equal(
      draftEnabled,
      false,
      "Baseline reproduces unrelated legacy pending blocking draft send",
    );
    assert.equal(
      manifest.skillEnabled,
      false,
      "Baseline reproduces unrelated legacy pending blocking Skill configuration",
    );
    assert.equal(
      explicitCheck.request.requestId,
      undefined,
      "Baseline GUI check omits original request identity",
    );
    checks.push("RED reproduced draft and Skill project-wide locks on real Electron/Core");
  } else {
    await page.getByText("已核对，原操作仍未确认。未重新提交。", { exact: true }).waitFor();
    assert.equal(draftEnabled, true, "Independent fresh draft can send despite legacy pending");
    assert.equal(
      manifest.skillEnabled,
      true,
      "Skill setting can change despite unrelated creation",
    );
    assert.equal(
      explicitCheck.request.requestId,
      requestId,
      "GUI reconciliation carries original request identity",
    );
    assert.ok(
      manifest.checkOwners.includes(executionProjectId),
      "Original request read reaches original execution owner",
    );
    assert.ok(
      !manifest.checkOwners.includes(projectId),
      "Original receipt is never read from logical owner",
    );
    await page
      .getByRole("navigation", { name: "应用导航", exact: true })
      .getByRole("button", { name: "插件", exact: true })
      .click();
    await page
      .getByRole("tablist", { name: "市场范围", exact: true })
      .getByRole("tab", { name: "个人", exact: true })
      .click();
    await button(`查看插件 ${pluginId}`).click();
    await button("管理").click();
    await skillSwitch.click();
    await until(async () => !(await skillSwitch.isChecked()), "Skill disabled through GUI");
    let detail = await call("manage", { projectId, operation: "plugin", id: pluginId });
    assert.ok(
      detail.componentChoices.disabledSkills.includes(detail.installedSkills[0].id),
      "Core readback confirms disabled Skill",
    );
    await skillSwitch.click();
    await until(async () => skillSwitch.isChecked(), "Skill reenabled through GUI");
    detail = await call("manage", { projectId, operation: "plugin", id: pluginId });
    assert.deepEqual(
      detail.componentChoices.disabledSkills,
      [],
      "Core readback confirms enabled Skill",
    );
    checks.push(
      "GUI Skill disable and enable persist through real Core with legacy UNKNOWN retained",
    );
    await button("返回应用").click();
    const expandSidebar = button("展开侧栏");
    if (await expandSidebar.isVisible()) await expandSidebar.click();
    await createProjectConversation(page, "workspace");
    await page.getByTestId("chat-input").fill("Independent fresh draft with selected skill");
    await button("添加功能与 Skills").click();
    await page.getByRole("option").filter({ hasText: "pending-proof" }).click();
    await button("发送").click();
    await until(
      async () =>
        Object.values(logical(await state())?.state?.threads ?? {}).some(
          (thread) => thread.turns?.at(-1)?.status === "completed",
        ),
      "fresh draft completes",
    );
    assert.equal(requests.length, 1, "One explicit fresh draft produces exactly one model request");
    assert.match(
      JSON.stringify(requests[0]),
      /PENDING_SKILL_BODY/,
      "Selected Skill reaches actual provider request",
    );
    await page.getByText("PENDING_PROJECT_OK", { exact: true }).waitFor();
    assert.equal(await page.getByText("PENDING_PROJECT_OK", { exact: true }).count(), 1);
    await capture("04-fresh-completed");
    checks.push(
      "Fresh GUI draft with selected Skill completes once without replaying original creation",
    );
    if (recoveryNotices) {
      await createProjectConversation(page, "workspace");
      await setResponseLoss({ armed: true, hold: true, method: "areal/thread/start" });
      const beforeLostCreate = (await trace()).length;
      await page.getByTestId("chat-input").fill("Real admitted creation keeps this draft unsent");
      await button("发送").click();
      const lostCreate = await until(async () => {
        const loss = JSON.parse(await readFile(responseLossPath, "utf8"));
        return !loss.armed && loss;
      }, "real creation response lost after admission");
      manifest.lostCreation = lostCreate;
      assert.notEqual(
        lostCreate.requestId,
        requestId,
        "Current creation has its own request identity",
      );
      const creationWarning = page.getByTestId("toast").filter({ hasText: "任务创建结果待确认。" });
      await creationWarning.waitFor();
      assert.equal(
        await button("发送").isEnabled(),
        false,
        "Current unknown creation cannot send again",
      );
      assert.equal(
        await page.getByTestId("toast").filter({ hasText: "操作结果待确认。" }).count(),
        0,
        "Current creation uses its specialized warning without the generic operation notice",
      );
      await capture("05-real-creation-unknown");
      const beforeHeldCheck = (await trace()).length;
      await creationWarning.getByRole("button", { name: "检查操作状态", exact: true }).click();
      await button("操作待确认").click();
      await page.getByRole("menuitem", { name: "保留原结果，返回草稿", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      const heldChecks = (await trace()).slice(beforeHeldCheck);
      assert.ok(
        heldChecks.some(
          (entry) =>
            entry.kind === "desktop-command" &&
            entry.name === "workspace" &&
            entry.request.operation === "worktreeRead" &&
            entry.request.requestId === lostCreate.requestId,
        ),
        "Current creation check reads its exact worktree admission record",
      );
      assert.ok(
        !heldChecks.some((entry) => entry.kind === "desktop-command" && entry.name === "create"),
        "Checking current unknown creation never submits create again",
      );
      assert.equal(
        requests.length,
        1,
        "Admitted creation and receipt checks leave its draft unsent",
      );
      await setResponseLoss({ ...lostCreate, releaseOnCheck: true });
      await button("操作待确认").click();
      await page.getByRole("menuitem", { name: "检查操作状态", exact: true }).click();
      const recoveredThreadId = lostCreate.result.thread.id;
      await page.waitForFunction(
        (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
        recoveredThreadId,
      );
      assert.equal(
        await page.getByTestId("chat-input").innerText(),
        "Real admitted creation keeps this draft unsent",
        "Recovered real thread retains the original unsent draft",
      );
      const lostCreateCalls = (await trace()).slice(beforeLostCreate);
      assert.equal(
        lostCreateCalls.filter(
          (entry) =>
            entry.method === "areal/thread/start" &&
            entry.params?.requestId === lostCreate.requestId,
        ).length,
        1,
        "Lost creation is admitted exactly once through real Core",
      );
      assert.equal(
        lostCreateCalls.filter(
          (entry) => entry.kind === "desktop-command" && entry.name === "create",
        ).length,
        1,
        "Recovery opens the known thread without issuing another create command",
      );
      assert.equal(requests.length, 1, "Receipt recovery never sends the retained draft");
      await capture("06-real-creation-recovered");
      checks.push(
        "Real Core admits current creation once; hidden receipt keeps its warning and draft locked; release opens that same empty thread without sending or recreating",
      );

      const configureRequestId = randomUUID();
      await setResponseLoss({ armed: true, hold: true, method: "areal/thread/configure" });
      const beforeConfigure = (await trace()).length;
      const configured = await page.evaluate(
        (params) => window.arealDesktop.command("configure", params),
        {
          projectId,
          threadId: recoveredThreadId,
          requestId: configureRequestId,
          model: { providerId: "fixture", modelId: "fixture" },
        },
      );
      assert.equal(
        configured.ok,
        false,
        "Fixture loses the response after actual thread configuration",
      );
      const lostConfigure = JSON.parse(await readFile(responseLossPath, "utf8"));
      assert.equal(lostConfigure.requestId, configureRequestId);
      const operationWarning = page.getByTestId("toast").filter({ hasText: "操作结果待确认。" });
      await operationWarning.waitFor();
      const beforeGlobalCheck = (await trace()).length;
      await operationWarning.getByRole("button", { name: "检查操作状态", exact: true }).click();
      await until(
        async () =>
          (await trace())
            .slice(beforeGlobalCheck)
            .some((entry) => entry.kind === "desktop-result" && entry.name === "reconcile"),
        "thread operation check completes while receipt remains hidden",
      );
      const globalCheck = (await trace())
        .slice(beforeGlobalCheck)
        .find((entry) => entry.kind === "desktop-command" && entry.name === "reconcile");
      assert.equal(
        globalCheck.request.requestId,
        configureRequestId,
        "Global warning checks the exact thread-associated original request",
      );
      assert.notEqual(
        globalCheck.request.requestId,
        requestId,
        "Thread operation check does not target historical creation",
      );
      assert.ok(
        (await trace())
          .slice(beforeGlobalCheck)
          .some(
            (entry) =>
              entry.method === "areal/request/read" &&
              entry.owner === projectId &&
              entry.params?.requestId === configureRequestId &&
              entry.params?.threadId === recoveredThreadId,
          ),
        "Global warning reads the original receipt from its real thread owner",
      );
      await capture("07-thread-operation-unknown");
      await setResponseLoss({ ...lostConfigure, releaseOnCheck: true });
      await operationWarning.getByRole("button", { name: "检查操作状态", exact: true }).click();
      await until(
        async () =>
          !logical(await state()).pending.some(
            (entry) => entry.params?.requestId === configureRequestId,
          ),
        "real configured thread receipt recovered",
      );
      assert.equal(
        (await trace())
          .slice(beforeConfigure)
          .filter(
            (entry) =>
              entry.method === "areal/thread/configure" &&
              entry.params?.requestId === configureRequestId,
          ).length,
        1,
        "Checking global thread operation never repeats configuration",
      );
      assert.equal(requests.length, 1, "Thread-operation recovery sends no model request");
      checks.push(
        "Thread-associated global warning retains exact requestId routing and recovers the real configuration receipt without replay",
      );

      await createProjectConversation(page, "workspace");
      await setResponseLoss({ armed: true, hold: true, method: "areal/thread/start" });
      await page.getByTestId("chat-input").fill("Retain this live unknown creation without replay");
      await button("发送").click();
      const retainedLive = await until(async () => {
        const loss = JSON.parse(await readFile(responseLossPath, "utf8"));
        return !loss.armed && loss;
      }, "second real creation response lost after admission");
      manifest.retainedLiveCreation = retainedLive;
      const liveWarning = page.getByTestId("toast").filter({ hasText: "任务创建结果待确认。" });
      await liveWarning.waitFor();
      await liveWarning.getByRole("button", { name: "检查操作状态", exact: true }).click();
      await button("操作待确认").click();
      const keepLive = page.getByRole("menuitem", { name: "保留原结果，返回草稿", exact: true });
      await keepLive.waitFor();
      await page.evaluate(() => {
        window.confirm = () => true;
      });
      await keepLive.click();
      await capture("08-live-creation-retained");
      assert.equal(
        await button("发送").isEnabled(),
        true,
        "Retaining a live unknown creation must release fresh draft admission",
      );
      assert.equal(
        await page.getByTestId("toast").filter({ hasText: "操作结果待确认。" }).count(),
        0,
        "Retained live creation does not leave a generic warning",
      );
      assert.ok(
        logical(await state()).pending.some(
          (entry) => entry.params?.requestId === retainedLive.requestId,
        ),
        "Retained live request stays pending while its receipt is hidden",
      );
      assert.equal(
        (await trace()).filter(
          (entry) =>
            entry.method === "areal/thread/start" &&
            entry.params?.requestId === retainedLive.requestId,
        ).length,
        1,
        "Retaining a live request never repeats its original mutation",
      );
      assert.equal(requests.length, 1, "Retaining live creation does not send its draft");
      checks.push(
        "Retaining live UNKNOWN releases the active creation owner while preserving original pending and unsent text",
      );
    }
    if (recoveryNotices) {
      await createProjectConversation(page, "workspace");
      const stateDirectory = join(env.AREAL_CORE_HOME, projectId, "state");
      const threadFiles = async () =>
        (await readdir(stateDirectory)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
      const before = await threadFiles();
      const modelCount = requests.length;
      const originalText = "Core exited before dispatch; keep this draft unsent";
      await setResponseLoss({ armed: true, beforeDispatch: true, method: "areal/thread/start" });
      await page.getByTestId("chat-input").fill(originalText);
      await button("发送").click();
      const lost = await until(async () => {
        const loss = JSON.parse(await readFile(responseLossPath, "utf8"));
        return !loss.armed && loss.beforeDispatch && loss;
      }, "Core killed before original creation dispatch");
      assert.ok(lost.originalBinding?.journalEpoch && lost.originalBinding?.coreInstanceId);
      await until(
        async () =>
          logical(await state()).outcomes?.[lost.requestId]?.admissionState === "notAdmitted",
        "retired original instance is proven not admitted after guarded Core replacement",
      );
      const current = logical(await state());
      assert.equal(current.outcomes[lost.requestId].accepted, false);
      assert.equal(
        current.pending.some((item) => item.params.requestId === lost.requestId),
        false,
      );
      await until(
        async () => button("发送").isEnabled(),
        "proven rejection unlocks retained draft",
      );
      assert.equal(await page.getByTestId("chat-input").innerText(), originalText);
      assert.deepEqual(await threadFiles(), before, "recovery creates no new Thread");
      assert.equal(requests.length, modelCount, "no automatic model request or draft send");
      const calls = await trace();
      assert.equal(
        calls.filter(
          (item) =>
            item.owner === projectId &&
            item.method === "areal/thread/start" &&
            item.params?.requestId === lost.requestId &&
            item.kind !== "not-dispatched",
        ).length,
        0,
        "original request never reaches Core or gets replayed",
      );
      assert.ok(
        calls.some(
          (item) =>
            item.method === "areal/request/read" &&
            item.params?.requestId === lost.requestId &&
            item.params?.creationAdmission?.coreInstanceId === lost.originalBinding.coreInstanceId,
        ),
      );
      manifest.notAdmittedCreation = {
        requestId: lost.requestId,
        originalBinding: lost.originalBinding,
        outcome: current.outcomes[lost.requestId],
        modelCount,
      };
      await capture("09-retired-creation-not-admitted");
      checks.push(
        "Real Core SIGKILL before dispatch is reconciled as notAdmitted after guarded replacement; original text survives with no creation or model replay",
      );
    }
    await createProjectConversation(page, "workspace");
    await page.evaluate(
      ({ projectId, requestId }) => {
        const key = `areal-gui:draft:${projectId}:new`;
        localStorage.setItem(key, "Own unknown draft must remain unsent");
        localStorage.setItem(`${key}:pending-create`, requestId);
        localStorage.setItem(
          `${key}:pending-create-request`,
          JSON.stringify({ projectId, requestId, worktree: { mode: "worktree" } }),
        );
      },
      { projectId, requestId },
    );
    await page.reload();
    await until(
      async () =>
        (await state()).connection?.state === "ready" && logical(await state())?.state?.connected,
      "own UNKNOWN reconnects to ready Core",
    );
    await page.getByTestId("chat-input").waitFor();
    assert.equal(await button("发送").isEnabled(), false, "Own UNKNOWN cannot send again");
    assert.equal(
      await page.getByTestId("chat-input").getAttribute("contenteditable"),
      "false",
      "Own UNKNOWN preserves editing lock",
    );
    assert.equal(requests.length, 1, "Reloading own UNKNOWN never sends a provider request");
    await capture("05-own-unknown-locked");
    checks.push("Persisted own-draft UNKNOWN stays locked and unsent after reload");
    if (recoveryNotices) {
      const ownWarning = page.getByTestId("toast").filter({ hasText: "任务创建结果待确认。" });
      await ownWarning.waitFor();
      assert.equal(
        await page.getByTestId("toast").filter({ hasText: "操作结果待确认。" }).count(),
        0,
      );
      const beforeOwnCheck = (await trace()).length;
      await ownWarning.getByRole("button", { name: "检查操作状态", exact: true }).click();
      await button("操作待确认").click();
      const leave = page.getByRole("menuitem", { name: "保留原结果，返回草稿", exact: true });
      await leave.waitFor();
      await page.evaluate(() => {
        window.confirm = () => true;
      });
      await leave.click();
      const retained = await page.evaluate(
        ({ projectId, requestId }) => {
          const key = `areal-gui:draft:${projectId}:new`;
          return {
            active: localStorage.getItem(`${key}:pending-create`),
            frozen: localStorage.getItem(`${key}:pending-create-request`),
            retained: JSON.parse(
              localStorage.getItem(`${key}:retained-create:${requestId}`) ?? "null",
            ),
          };
        },
        { projectId, requestId },
      );
      assert.equal(retained.active, null, "Leaving releases current creation recovery slot");
      assert.equal(retained.frozen, null, "Leaving releases only the active frozen request slot");
      assert.deepEqual(
        retained.retained,
        {
          requestId,
          request: JSON.stringify({ projectId, requestId, worktree: { mode: "worktree" } }),
        },
        "Leaving preserves the original frozen creation request for inspection",
      );
      await createProjectConversation(page, "workspace");
      await until(
        async () => button("发送").isEnabled(),
        "retained old request leaves fresh draft usable",
      );
      assert.equal(
        await page.getByTestId("toast").filter({ hasText: "操作结果待确认。" }).count(),
        0,
        "Fresh draft never inherits the retained operation notice",
      );
      assert.equal(
        await page.getByTestId("toast").filter({ hasText: "任务创建结果待确认。" }).count(),
        0,
        "Fresh draft never inherits the prior current-creation warning",
      );
      assert.ok(
        !(await trace())
          .slice(beforeOwnCheck)
          .some((entry) => entry.kind === "desktop-command" && entry.name === "create"),
        "Check and leave never create or replay retained work",
      );
      assert.equal(requests.length, 1, "Check and leave keep retained text unsent");
      await capture("08-retained-creation-fresh-draft");
      checks.push(
        "Persisted current creation keeps its specialized warning; check and leave retain frozen request without replay and fresh draft has no stale warning",
      );
    }
  }
  assert.deepEqual(
    JSON.parse(await readFile(pendingPath, "utf8")),
    pending,
    "Original missing-receipt journal preserved",
  );
  assert.deepEqual(
    JSON.parse(await readFile(bindingPath, "utf8")),
    binding,
    "Original worktree binding preserved",
  );
  assert.ok(
    !(await trace()).some(
      (call) => call.method === "areal/thread/start" && call.params?.requestId === requestId,
    ),
    "Original creation never resubmitted",
  );
  assert.ok(
    logical(await state()).pending.some((entry) => entry.params.requestId === requestId),
    "Original UNKNOWN stays visible",
  );
  checks.push(
    "Original pending, binding, request identity and missing receipt preserved; no original mutation replay",
  );
  assert.deepEqual(errors, []);
  manifest.passed = true;
} catch (error) {
  failure = error;
  manifest.error = error.stack;
  if (page) await captureSmokeFailure(page, evidence, error);
} finally {
  await json(join(evidence, "model-requests.json"), requests);
  if (app) {
    try {
      await closeSmokeApplication(app);
    } catch (error) {
      failure ??= error;
      manifest.cleanupError = error.stack;
    }
  }
  await application.close();
  try {
    await assertApplicationStopped(binary, env, metadata);
    manifest.cleaned = true;
  } catch (error) {
    failure ??= error;
    manifest.cleanupError = error.stack;
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(join(evidence, "electron.stderr.log"), stderr);
  assert.equal(sha(await readFile(binary)), manifest.coreSHA256, "Core binary unchanged");
  manifest.passed &&= !failure;
  await json(join(evidence, "manifest.json"), manifest);
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: manifest.passed, red, evidence, checks }, null, 2));
