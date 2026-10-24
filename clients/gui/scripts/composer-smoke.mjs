import { composerFilesResponse, runComposerFilesAcceptance } from "./composer-files-acceptance.mjs";
import { composerReferencesResponse, runComposerReferencesAcceptance } from "./composer-references-acceptance.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure, resizeConversation, selectConversation } from "./smoke-navigation.mjs";
import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(gui, "app");
const filesRegression = process.env.AREAL_COMPOSER_FILES_REGRESSION === "1";
const referencesRegression = process.env.AREAL_COMPOSER_REFERENCES_REGRESSION === "1";
const referencesFixture = { held: new Set() };
const filesFixture = { held: new Set() };
const skillsRegression = process.env.AREAL_COMPOSER_SKILLS_REGRESSION === "1";
assert.ok([skillsRegression, filesRegression, referencesRegression].filter(Boolean).length <= 1, "Choose one source fixture regression mode");
assert.ok(!(skillsRegression || filesRegression || referencesRegression) || !process.env.AREAL_GUI_EXECUTABLE, "Composer regression modes require the source Electron fixture");
let launchApp = desktop;
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const root = resolve(gui, "../..");
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(binary, "AREAL_CORE_BIN must point to the actual built Core");
const scratch = await mkdtemp("/private/tmp/areal-gui-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user-home"));
execFileSync("git", ["init", "-b", "main"], {
  cwd: workspace,
  stdio: "ignore",
});
await writeFile(join(workspace, "hello.ts"), 'export const hello = "world";\n');
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
await writeFile(join(workspace, "hello.ts"), 'export const hello = "AReaL";\n');
const skill = join(scratch, "skill");
await mkdir(skill);
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\nExplain the fixture project.\n",
);
const secondSkill = join(scratch, "skill-two");
await mkdir(secondSkill);
await writeFile(
  join(secondSkill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Second source\n---\nSECOND_SKILL_CONTENT\n",
);
const pagedContent = "分页正文".repeat(2400) + "\nPAGED_SKILL_END";
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\n" + pagedContent,
);
const pluginSource = join(workspace, "packages", "composer-plugin");
await mkdir(join(pluginSource, "skills", "compose"), { recursive: true });
await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "composer-plugin", version: "1.0.0", description: "Composer plugin fixture",
}));
await writeFile(join(pluginSource, "skills", "compose", "SKILL.md"),
  "---\nname: composer-plugin-skill\ndescription: Exact plugin context\n---\nCOMPOSER_PLUGIN_EXACT_BODY\n");
await writeFile(join(workspace, ".agents", "plugins", "marketplace.json"), JSON.stringify({
  name: "composer-fixture", plugins: [{ name: "composer-plugin", source: { source: "local", path: "./packages/composer-plugin" } }],
}));
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [
      { id: "fixture-skill", revision: "v1", root: skill },
      { id: "fixture-two", revision: "v2", root: secondSkill },
    ],
    profiles: [
      ...(skillsRegression ? [{
        id: "standard", revision: "v2", displayName: "标准二", instructions: "Complete the task", allowPluginSkills: true,
        skills: [{ id: "fixture-two", revision: "v2" }],
      }] : []),
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task",
        allowThreadProcesses: true,
        allowPluginSkills: true,
        approvalTools: ["fs_create"],
        skills: [
          { id: "fixture-skill", revision: "v1" },
          { id: "fixture-two", revision: "v2" },
        ],
      },
    ],
  }),
);
const received = [];
let predictionRequests = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, res)) return;
  if (body.messages?.some(message => message.role === "system"
    && typeof message.content === "string" && message.content.startsWith("Predict the next user prompt from the conversation data."))) {
    assert.ok(!body.tools?.length, "prompt prediction must not receive conversation tools");
    predictionRequests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  received.push(body);
  if (filesRegression) { composerFilesResponse(body, res, filesFixture); return; }
  if (referencesRegression) { composerReferencesResponse(body, res, referencesFixture); return; }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "COMPOSER_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`,
);
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
const labelsControl = join(scratch, "labels-control.json");
const labelsTrace = join(scratch, "labels-trace.jsonl");
const labelGates = [];
if (skillsRegression) {
  launchApp = join(scratch, "app");
  await mkdir(launchApp);
  await writeFile(join(launchApp, "package.json"), JSON.stringify({ name: "composer-skills-fixture", main: "bootstrap.cjs" }));
  await writeFile(join(launchApp, "bootstrap.cjs"), `
const { CoreBackend } = require(${JSON.stringify(join(desktop, "src/core/backend.cjs"))});
const { ScopedResources } = require(${JSON.stringify(join(desktop, "src/core/scoped-resources.cjs"))});
const { existsSync, readFileSync, appendFileSync } = require("node:fs");
const execute = CoreBackend.prototype.executeCommand;
const skills = ScopedResources.prototype.skills;
const trace = value => appendFileSync(${JSON.stringify(labelsTrace)}, JSON.stringify(value) + "\\n");
ScopedResources.prototype.skills = async function(request) {
  if (existsSync(${JSON.stringify(labelsControl)})) {
    const plan = JSON.parse(readFileSync(${JSON.stringify(labelsControl)}, "utf8"));
    trace({ kind: "labels_begin", plan: plan.id, scope: request.scope, projectId: request.projectId });
    while (plan.gate && existsSync(plan.gate)) await new Promise(resolve => setTimeout(resolve, 20));
    trace({ kind: "labels_end", plan: plan.id, scope: request.scope, failed: !!plan.failure });
    if (plan.failure) throw new Error("optional source fixture failure");
    return { revision: 1, data: plan[request.scope] || [] };
  }
  return skills.call(this, request);
};
CoreBackend.prototype.executeCommand = async function(name, request, context) {
  const result = await execute.call(this, name, request, context);
  if (name === "manage" && request.operation === "skills")
    trace({ kind: "core_catalog", projectId: request.projectId, profile: request.agentProfile, rows: result.data.map(row => ({ id: row.id, revision: row.revision, available: row.available })) });
  return result;
};
require(${JSON.stringify(join(desktop, "src/main.cjs"))});
`);
}
if (filesRegression) {
  launchApp = join(scratch, "files-app");
  await mkdir(launchApp);
  await writeFile(join(launchApp, "package.json"), JSON.stringify({ name: "composer-files-fixture", main: "bootstrap.cjs" }));
  await writeFile(join(launchApp, "bootstrap.cjs"), `
const { ipcMain } = require("electron");
const handle = ipcMain.handle.bind(ipcMain);
globalThis.filesHoldList = false;
globalThis.filesListEntered = false;
globalThis.filesListCompleted = false;
ipcMain.handle = function(channel, listener) {
  if (channel !== "areal-core:command") return handle(channel, listener);
  return handle(channel, async (event, name, params) => {
    const held = name === "workspace" && params?.operation === "list" && !params.path && globalThis.filesHoldList;
    if (!held) return listener(event, name, params);
    globalThis.filesHoldList = false;
    globalThis.filesListEntered = true;
    await new Promise(resolve => { globalThis.filesReleaseList = () => { globalThis.filesReleaseList = null; resolve(); }; });
    try { return await listener(event, name, params); }
    finally { globalThis.filesListCompleted = true; }
  });
};
require(${JSON.stringify(join(desktop, "src/main.cjs"))});
`);
}
let app,
  page,
  passed = false;
const errors = [],
  frames = [],
  checks = [];
const pasteEvidence = { uploadedFile: null, folded: [] };
const skillCatalogEvents = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (snapshot) =>
  snapshot.projects.find((p) => p.root === workspace && !p.projectless);
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (await predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  const clip = await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll(
        '.composer-dock, [data-slot="popover-content"], [data-testid="composer-catalog"]',
      ),
    ]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return undefined;
    const x = Math.max(0, Math.min(...boxes.map((box) => box.left)) - 8);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.top)) - 8);
    return {
      x,
      y,
      width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right)) + 8) - x,
      height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom)) + 8) - y,
    };
  });
  await page.screenshot({
    clip,
    path: join(scratch, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
  frames.push(name + ".png");
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"),
    args: process.env.AREAL_GUI_EXECUTABLE ? [] : [launchApp],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (d) => {
    if (String(d).includes("Error")) process.stderr.write(d);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", message => {
    const output = message.text();
    if (!output.startsWith("[composer-skills] ")) return;
    skillCatalogEvents.push(JSON.parse(output.slice("[composer-skills] ".length)));
  });
  await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function quit() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await app.close();
  app = null;
}
console.log("GUI evidence:", scratch);
try {
  await launch();
  await page.evaluate(() => localStorage.setItem("areal-gui:theme", "data-dense"));
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    }),
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => project(s)?.state?.connected, "project ready");
  const pid = project(await state()).id;
  const selectFixtureProfile = async (revision = "v1") => {
    await page.waitForFunction((id) => {
      const workbench = document.querySelector('[data-testid="areal-workbench"]');
      return workbench?.dataset.projectId === id && !workbench.dataset.threadId;
    }, pid);
    assert(project(await state()).profiles.some((p) => p.id === "standard" && p.revision === revision));
    await page.evaluate(({ id, revision }) => {
      const key = `areal-gui:draft:${id}:new`;
      localStorage.setItem(`${key}:profile`, JSON.stringify({ id: "standard", revision }));
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    }, { id: pid, revision });
  };
  await selectFixtureProfile();
  await call("manage", {
    projectId: pid,
    operation: "providerSave",
    expectedRevision: 0,
    provider: {
      id: "fixture-provider",
      revision: 0,
      protocol: "chatCompletions",
      endpoint,
      models: ["fixture", "fixture-alt"],
      parameters: {},
    },
  });
  await until(
    (s) => project(s).models.some((model) => model.modelId === "fixture-alt"),
    "provider catalog",
  );
  const input = () => page.locator("[data-testid=chat-input]");
  const tags = () => page.locator(".composer-skill-tag");
  const openCatalog = async () => {
    await button("添加功能与 Skills").click();
    await page.getByRole("option").filter({ hasText: "Deterministic test skill" }).waitFor();
  };
  const chooseFirst = async () => {
    await openCatalog();
    await page.getByRole("option", { name: /Deterministic test skill/ }).click();
  };
  const sendAndWait = async () => {
    const count = received.length;
    await button("发送").click();
    await until(
      (s) =>
        Object.values(project(s).state.threads).some(
          (t) => t.turns?.at(-1)?.status === "completed",
        ) && received.length > count,
      "send completed",
    );
  };
  if (filesRegression) {
    await runComposerFilesAcceptance({ app, page, pid, workspace, scratch, endpoint, desktop, call, state, project, until, received, checks, shot, fixture: filesFixture });
  } else if (referencesRegression) {
    await runComposerReferencesAcceptance({ app, page, pid, workspace, scratch, endpoint, desktop, call, state, project, until, received, checks, shot, fixture: referencesFixture, reopen: async () => { await quit(); await launch(); return page; } });
  } else {
  if (skillsRegression) {
    const trace = async () => (await readFile(labelsTrace, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    })).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const plan = async (id, extra = {}) => {
      const gate = join(scratch, `labels-${id}.gate`);
      labelGates.push(gate);
      await writeFile(gate, "held");
      await writeFile(labelsControl, JSON.stringify({ id, gate, ...extra }));
      return gate;
    };
    const source = () => page.getByRole("option", { name: /Second source/ }).locator(".composer-catalog-source");
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const firstGate = await plan("held", { project: [{ id: "fixture-skill", revision: "v1" }], user: [{ id: "fixture-two", revision: "v2" }] });
    await input().fill("来源阻塞时保留正文");
    await input().click();
    await button("添加功能与 Skills").click();
    await until(async () => (await trace()).filter(row => row.kind === "labels_begin" && row.plan === "held").length === 2, "both source labels held after the real Core catalog");
    const core = (await trace()).filter(row => row.kind === "core_catalog" && row.profile?.revision === "v1").at(-1);
    assert.deepEqual(core.rows.filter(row => row.available).map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)), [
      { id: "fixture-skill", revision: "v1" }, { id: "fixture-two", revision: "v2" },
    ]);
    const first = page.getByRole("option", { name: /Deterministic test skill/ });
    await first.waitFor({ timeout: 3000 });
    assert.notEqual(await first.getAttribute("aria-disabled"), "true", "Core skill is selectable while optional source labels are held");
    assert.equal(await first.locator(".composer-catalog-source").textContent(), "任务配置 · fixture-skill");
    await first.click();
    assert.equal(await tags().count(), 1);
    assert.equal(await input().textContent(), "来源阻塞时保留正文");
    assert.equal(received.length, 0);
    await unlink(firstGate);
    await until(async () => (await trace()).filter(row => row.kind === "labels_end" && row.plan === "held").length === 2, "held labels released");
    await openCatalog();
    await until(async () => await source().textContent() === "个人", "released labels enrich current Core rows");
    await settled();
    const beforeClose = (await trace()).length;
    await button("添加功能与 Skills").click();
    await page.getByTestId("composer-catalog").waitFor({ state: "detached" });
    await settled();
    assert.equal((await trace()).length, beforeClose, "closing the catalog does not refresh Core or source labels");
    checks.push("Core Skills remain selectable with source labels held; source labels later enrich rows; closing performs no refresh");

    const failedGate = await plan("failure", { failure: true });
    await openCatalog();
    await unlink(failedGate);
    await until(async () => (await trace()).filter(row => row.kind === "labels_end" && row.plan === "failure").length === 2, "source failures returned");
    await settled();
    assert.equal(await page.getByRole("option", { name: /Deterministic test skill/ }).count(), 1);
    assert.equal(await source().textContent(), "任务配置 · fixture-two");
    assert.equal(await page.getByTestId("composer-catalog").getByRole("alert").count(), 0, "optional source failure preserves authoritative skills without catalog error");
    await page.getByLabel("搜索功能与 Skills").press("Escape");

    const staleGate = await plan("stale", { project: [{ id: "fixture-two", revision: "v2" }] });
    await openCatalog();
    await until(async () => (await trace()).filter(row => row.kind === "labels_begin" && row.plan === "stale").length === 2, "old profile labels held");
    await writeFile(labelsControl, JSON.stringify({ id: "current", user: [{ id: "fixture-two", revision: "v2" }] }));
    await selectFixtureProfile("v2");
    await until(async () => (await trace()).some(row => row.kind === "core_catalog" && row.profile?.revision === "v2"), "real Core returns the v2 profile catalog");
    await until(async () => await source().textContent() === "个人", "current profile source labels applied");
    assert.equal(await page.getByRole("option", { name: /Deterministic test skill/ }).count(), 0);
    await unlink(staleGate);
    await until(async () => (await trace()).filter(row => row.kind === "labels_end" && row.plan === "stale").length === 2, "old profile labels released");
    await settled();
    assert.equal(await source().textContent(), "个人", "old profile label response cannot overwrite the current catalog identity");
    assert.equal(await page.getByRole("option", { name: /Deterministic test skill/ }).count(), 0);
    assert.equal(await tags().count(), 1, "profile changes preserve the selected skill identity");
    assert.equal(await input().textContent(), "来源阻塞时保留正文");
    await page.getByLabel("搜索功能与 Skills").press("Escape");
    await page.getByRole("button", { name: /移除技能/ }).click();
    await selectFixtureProfile();
    await input().fill("");
    checks.push("source failure preserves Core availability; late labels cannot overwrite a different profile revision; selected skill and body remain intact");
  }
  // 由 Chromium 驱动真实组词事件；候选中间态不能保存到草稿或触发发送。
  const checkComposition = async (draftKey, label) => {
    await input().fill("");
    await input().focus();
    await page.evaluate((key) => {
      window.composerInputProbe = { writes: [], restore: Storage.prototype.setItem };
      Storage.prototype.setItem = function (name, value) {
        if (name === key) window.composerInputProbe.writes.push(value);
        return window.composerInputProbe.restore.call(this, name, value);
      };
    }, draftKey);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.debugger.attach("1.3"),
    );
    const command = (method, params) =>
      app.evaluate(
        async ({ BrowserWindow }, { method, params }) =>
          BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand(method, params),
        { method, params },
      );
    const compose = (text) =>
      command("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    const writes = () => page.evaluate(() => window.composerInputProbe.writes);
    const requestCount = received.length;
    try {
      for (const text of ["n", "ni", "nihao", "你好"]) {
        await compose(text);
        await page.waitForFunction(
          (text) =>
            document
              .querySelector('[data-testid="chat-input"]')
              .textContent.replaceAll("\u200b", "") === text,
          text,
        );
      }
      assert.deepEqual(await writes(), [], `${label}: unconfirmed candidates stay in editor`);
      await input().evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      assert.equal(received.length, requestCount, `${label}: candidate Enter does not send`);
      await command("Input.insertText", { text: "你好" });
      await page.waitForFunction((key) => localStorage.getItem(key) === "你好", draftKey);
      assert.deepEqual(
        await writes(),
        ["你好"],
        `${label}: commit publishes once even when candidate text is unchanged`,
      );
      assert.equal(await input().textContent(), "你好");
      assert.deepEqual(
        await input().evaluate((element) => {
          const selection = getSelection();
          return {
            inside: element.contains(selection.anchorNode),
            offset: selection.anchorOffset,
            collapsed: selection.isCollapsed,
          };
        }),
        { inside: true, offset: 2, collapsed: true },
      );
      assert.equal(
        await input().evaluate((element) => {
          const style = getComputedStyle(element);
          return style.caretColor === style.color;
        }),
        true,
        `${label}: caret follows foreground color`,
      );
      await shot(`${label}-ime-committed`);
      await compose("mei");
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="chat-input"]').textContent.includes("mei"),
      );
      assert.deepEqual(await writes(), ["你好"]);
      await compose("");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="chat-input"]').textContent === "你好",
      );
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), draftKey), "你好");
      assert.deepEqual(
        await writes(),
        ["你好"],
        `${label}: canceled composition preserves committed draft`,
      );
      await input().press("Shift+Enter");
      await page.keyboard.type("a");
      await page.waitForFunction((key) => localStorage.getItem(key)?.endsWith("a"), draftKey);
      assert.match(await page.evaluate((key) => localStorage.getItem(key), draftKey), /^你好\n+a$/);
      assert.equal(received.length, requestCount);
      assert.equal(await button("发送").isEnabled(), true);
      checks.push(
        `${label}: native Chromium composition stays local; one final draft write; cancel, caret, Enter guard and newline remain correct`,
      );
    } finally {
      await page.evaluate(() => {
        Storage.prototype.setItem = window.composerInputProbe.restore;
        delete window.composerInputProbe;
      });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.debugger.detach(),
      );
    }
    await input().fill("");
    await page.keyboard.type("a");
    await page.waitForFunction((key) => localStorage.getItem(key) === "a", draftKey);
    assert.equal(await button("发送").isEnabled(), true, `${label}: first character enables send`);
    await input().fill("");
  };
  await checkComposition(`areal-gui:draft:${pid}:new`, "draft");
  // 草稿目录不创建 Thread，+/slash 同视图并保留正文与同名来源。
  await input().fill("正文保留");
  await chooseFirst();
  await page.getByRole("button", { name: /查看技能/ }).click();
  await page
    .getByRole("dialog", { name: "技能 fixture-skill" })
    .getByText(/PAGED_SKILL_END/)
    .waitFor();
  await page.getByRole("dialog", { name: "技能 fixture-skill" }).press("Escape");
  assert.equal(await tags().count(), 1);
  await chooseFirst();
  assert.equal(await tags().count(), 1);
  await openCatalog();
  await page.getByRole("option", { name: /Second source/ }).click();
  assert.equal(await tags().count(), 2);
  await page
    .getByRole("button", { name: /移除技能/ })
    .first()
    .click();
  assert.equal(await tags().count(), 1);
  assert.equal(await input().textContent(), "正文保留");
  await chooseFirst();
  assert.equal(await tags().count(), 2);
  assert.equal(project(await state()).summaries?.length ?? 0, 0);
  await input().fill("正文保留 /fixture");
  await page.getByRole("listbox", { name: "功能与 Skills" }).waitFor();
  await input().press("ArrowDown");
  await input().press("Enter");
  assert.equal(await input().textContent(), "正文保留 ");
  assert.equal(await tags().count(), 2);
  await openCatalog();
  const draftMenuGap = await page.evaluate(() => {
    const menu = document.querySelector('[data-testid="composer-catalog"]').getBoundingClientRect();
    const surface = document.querySelector(".composer-surface").getBoundingClientRect();
    return surface.top - menu.bottom;
  });
  assert.ok(Math.abs(draftMenuGap - 8) < 1, `draft menu gap: ${draftMenuGap}`);
  await shot("01-draft-catalog");
  await page.getByLabel("搜索功能与 Skills").press("Escape");
  await shot("01-draft-skills");
  await input().fill("正文保留 /no-such-skill");
  await page.getByText("无匹配结果", { exact: true }).waitFor();
  await input().press("Enter");
  assert.equal(await input().textContent(), "正文保留 /no-such-skill");
  assert.equal(received.length, 0);
  await input().press("Escape");
  await input().fill("正文保留 /goal");
  await page.getByRole("option", { name: /设置目标/ }).waitFor();
  await input().evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  assert.equal(await button("退出目标模式").count(), 0);
  await input().press("Escape");
  await input().fill("正文保留");
  checks.push(
    "new draft catalog without hidden Thread; shared +/slash grouping; keyboard/no-result/IME guards; source identity dedup; body preservation",
  );
  // 卡片与长粘贴走真实浏览器文件/剪贴板边界。
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#75a9eb";
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles([
    { name: "image.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
    { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("文本附件内容") },
  ]);
  await page.getByRole("button", { name: "在文本框中显示 ›" }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="chat-input"]')?.textContent.includes("文本附件内容"),
  );
  assert.match(await input().textContent(), /正文保留.*文本附件内容/s);
  assert.equal(await page.locator(".composer-image-card").count(), 1);
  await page.waitForFunction(
    () => document.querySelector(".composer-image-card img")?.naturalWidth === 64,
  );
  const pasted = "粘贴正文".repeat(60);
  await input().evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, pasted);
  await page.getByRole("button", { name: "在文本框中显示 ›" }).waitFor();
  await shot("02-attachments");
  await page.getByRole("button", { name: "在文本框中显示 ›" }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="chat-input"]')?.textContent.includes("粘贴正文"),
  );
  assert.match(await input().textContent(), /粘贴正文/);
  const beforeRemove = await input().textContent();
  await button("移除附件 image.png").click();
  assert.equal(await input().textContent(), beforeRemove);
  checks.push(
    "image thumbnail; UTF-8 file and long-paste cards expand without losing existing body or other attachments",
  );
  // 真实目录与配置：选择模型后回到强度面板，提交到本地供应商。
  await button("模型").click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture-alt", exact: true }).click();
  const slider = page.getByRole("slider", { name: "思考强度" });
  await slider.waitFor();
  await slider.fill("4");
  assert.equal(await page.getByRole("button", { name: /快速|重置强度/ }).count(), 0);
  await shot("03-effort");
  await slider.press("Escape");
  await sendAndWait();
  const tid = await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id");
  assert.equal(project(await state()).configurations[tid].profile.id, "standard");
  assert.equal(project(await state()).configurations[tid].profile.revision, "v1");
  const current = (s) => project(s).state.threads[tid];
  const sentBody = received.at(-1);
  assert.equal(sentBody.model, "fixture-alt");
  assert.equal(sentBody.reasoning_effort, "high");
  const sentText = JSON.stringify(sentBody.messages);
  assert.ok(sentText.includes("PAGED_SKILL_END"));
  assert.ok(sentText.includes("SECOND_SKILL_CONTENT"));
  assert.ok(sentText.includes("正文保留"));
  await until((s) => !project(s).pending.length, "submission settled");
  assert.equal(await tags().count(), 0);
  checks.push(
    "real paged Core Skill read (multibyte >8192 bytes) reaches model request; two-tier real model/effort selection reaches provider",
  );
  const sentUser = page.locator(".user-message").last();
  const sentBubble = sentUser.locator(".user-bubble");
  const sentSkills = sentBubble.locator(".user-message-skill");
  await sentSkills.first().waitFor();
  assert.deepEqual(await sentSkills.allTextContents(), ["Fixture Skill", "Fixture Skill"]);
  assert.equal(await sentSkills.locator("svg").count(), 2);
  assert.equal(await sentBubble.locator("details, .user-message-skill button").count(), 0);
  const sentSkillAlignment = await sentBubble.evaluate(bubble => {
    const skillText = [...bubble.querySelector(".user-message-skill").childNodes]
      .find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const proseText = [...bubble.querySelector("p").childNodes]
      .find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const skillRange = document.createRange();
    skillRange.selectNodeContents(skillText);
    const proseRange = document.createRange();
    proseRange.selectNodeContents(proseText);
    const skill = skillRange.getClientRects()[0];
    const prose = proseRange.getClientRects()[0];
    return { skillTop: skill.top, skillBottom: skill.bottom, proseTop: prose.top, proseBottom: prose.bottom };
  });
  assert.ok(sentSkillAlignment.skillTop < sentSkillAlignment.proseBottom
    && sentSkillAlignment.proseTop < sentSkillAlignment.skillBottom,
    `sent Skill label and prose share a row: ${JSON.stringify(sentSkillAlignment)}`);
  assert.ok(Math.abs(sentSkillAlignment.skillBottom - sentSkillAlignment.proseBottom) <= 1,
    `sent Skill label and prose text align within 1px: ${JSON.stringify(sentSkillAlignment)}`);
  const assertCompactSkillBody = async () => {
    const visibleText = await sentBubble.textContent();
    assert.doesNotMatch(visibleText, /PAGED_SKILL_END|SECOND_SKILL_CONTENT|description:|name: fixture-skill|<skill/);
    assert.match(visibleText, /正文保留/);
    assert.match(visibleText, /文本附件内容/);
  };
  await assertCompactSkillBody();
  const expandSentBody = sentBubble.getByRole("button", { name: "展开全文", exact: true });
  if (await expandSentBody.count()) {
    await expandSentBody.click();
    await assertCompactSkillBody();
    await sentBubble.getByRole("button", { name: "收起", exact: true }).click();
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.copiedSkillMessage = text; },
    } });
  });
  await sentUser.getByRole("button", { name: "复制消息", exact: true }).click();
  await sentUser.getByRole("button", { name: "已复制消息", exact: true }).waitFor();
  const copiedSkillMessage = await page.evaluate(() => window.copiedSkillMessage);
  assert.match(copiedSkillMessage, /<skill name="fixture-skill"/);
  assert.match(copiedSkillMessage, /PAGED_SKILL_END/);
  assert.match(copiedSkillMessage, /SECOND_SKILL_CONTENT/);
  await sentBubble.scrollIntoViewIfNeeded();
  await sentBubble.screenshot({ path: join(scratch, "03-sent-skills.png"), animations: "disabled", scale: "css" });
  frames.push("03-sent-skills.png");
  checks.push("sent user Skills show two inline Box labels; bodies and frontmatter stay absent through prose expansion; copying preserves complete original Skill blocks");
  const pasteUploads = (await call("media", {
    projectId: pid, threadId: tid, operation: "list",
  })).uploads;
  for (const [label, text, body = "", newDraft = false] of [
    ["over-200-characters", "折叠正文开始\n" + "粘贴正文".repeat(60) + "\n折叠正文结束", "保留已有正文"],
    ["five-lines", "第一行\n第二行\n第三行\n第四行\n第五行"],
    ["new-draft-five-lines", "新聊天第一行\n第二行\n第三行\n第四行\n第五行", "", true],
  ]) {
    if (newDraft) {
      await button("新聊天").click();
      await page.waitForFunction(() =>
        !document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
      );
      await input().waitFor();
      await selectFixtureProfile();
    }
    let pasteTid = newDraft ? null : tid;
    const pasteThread = (s) => project(s).state.threads[pasteTid];
    assert.equal(
      await page.getByText("model does not support File input", { exact: true }).count(),
      0,
      `${label}: no preceding File refusal can satisfy this attempt`,
    );
    const expectedText = body ? `${body}\n\n${text}` : text;
    await input().fill(body);
    await input().evaluate((element, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData, bubbles: true, cancelable: true,
      }));
    }, text);
    await page.getByRole("button", { name: "在文本框中显示 ›" }).waitFor();
    assert.equal(await input().textContent(), body, `${label}: pasted text stays folded`);
    await shot(`03b-folded-${label}`);
    const beforePaste = {
      requests: received.length,
      turns: pasteThread(await state())?.turns.length ?? 0,
      uploads: newDraft ? [] : pasteUploads,
    };
    const evidence = { label, expectedText, before: beforePaste };
    pasteEvidence.folded.push(evidence);
    await button("发送").click();
    const accepted = await until(
      async (s) => {
        if (newDraft) pasteTid = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
        const refusal = await page.getByText("model does not support File input", { exact: true }).count();
        if (refusal) {
          evidence.observed = {
            error: "model does not support File input",
            draft: await input().textContent(),
            turns: pasteThread(s)?.turns.length ?? 0,
            modelRequests: received.slice(beforePaste.requests),
            uploads: pasteTid ? (await call("media", {
              projectId: pid, threadId: pasteTid, operation: "list",
            })).uploads : [],
          };
          assert.fail(`${label}: folded clipboard text was sent as File; expected exact Text input`);
        }
        return received.length === beforePaste.requests + 1 &&
          pasteThread(s)?.turns.length === beforePaste.turns + 1 &&
          pasteThread(s)?.turns.at(-1)?.status === "completed" && !project(s).pending.length;
      },
      `${label}: folded paste direct Send completes as Text`,
    );
    const turn = pasteThread(accepted).turns.at(-1);
    const userMessages = turn.items.filter((item) => item.type === "userMessage");
    assert.equal(userMessages.length, 1);
    assert.deepEqual(
      userMessages[0].content.map((part) => ({ type: part.type, text: part.text })),
      [{ type: "text", text: expectedText }],
      `${label}: Core accepted text contains every pasted character and no File part`,
    );
    const modelMessage = received.at(-1).messages.filter((message) => message.role === "user"
      && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1);
    assert.equal(modelMessage.content, expectedText, `${label}: actual model request preserves exact text`);
    assert.deepEqual(
      (await call("media", { projectId: pid, threadId: pasteTid, operation: "list" })).uploads,
      beforePaste.uploads,
      `${label}: folded text creates no Core upload`,
    );
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="chat-input"]')?.textContent === "" &&
      !document.querySelector('[data-testid="composer-attachment"]'),
    );
    evidence.observed = { threadId: pasteTid, turn, modelMessage };
    checks.push(`${label}: folded direct UI Send reaches completed Core history and model as exact Text without upload`);
    if (newDraft) await selectConversation(page, tid);
  }
  const uploadedText = "PKG_CONFIG=source\n真正通过文件选择器上传的文本，不是剪贴板正文。\nexport const 中文 = \"完整原文\";\n";
  const fileDraft = "读取真实文件";
  const beforeFile = {
    requests: received.length,
    uploads: (await call("media", { projectId: pid, threadId: tid, operation: "list" })).uploads,
  };
  await input().fill(fileDraft);
  await page.locator("input[type=file]").setInputFiles({
    name: "中文源文件.ts", mimeType: "application/typescript", buffer: Buffer.from(uploadedText),
  });
  await sendAndWait();
  await until((s) => current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length, "text file accepted");
  const filePart = current(await state()).turns.at(-1).items.find(item => item.type === "userMessage").content.find(part => part.type === "file");
  assert.equal(filePart.name, "中文源文件.ts");
  assert.equal(filePart.mime_type, "text/plain");
  assert.match(filePart.url, /^areal:\/\/blob\//);
  const uploadedFiles = (await call("media", { projectId: pid, threadId: tid, operation: "list" })).uploads;
  const uploadedFile = uploadedFiles.find(file => file.uri === filePart.url);
  assert.equal(uploadedFiles.length, beforeFile.uploads.length + 1);
  assert.equal(uploadedFile.mimeType, "text/plain");
  assert.equal(uploadedFile.sizeBytes, Buffer.byteLength(uploadedText));
  const uploadedContent = await page.evaluate(async (params) => {
    const result = await window.arealDesktop.command("media", params);
    if (!result.ok) throw Error(result.error.message);
    return new TextDecoder("utf-8", { fatal: true }).decode(result.value.bytes);
  }, { projectId: pid, threadId: tid, operation: "read", uri: uploadedFile.uri });
  assert.equal(uploadedContent, uploadedText);
  const projected = received.at(-1).messages.filter(message => message.role === "user"
    && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1).content;
  assert.equal(typeof projected, "string");
  assert(projected.includes(uploadedText), "actual Chat Completions request contains every source byte as text");
  assert(projected.includes("中文源文件.ts"));
  pasteEvidence.uploadedFile = { ...uploadedFile, text: uploadedText, filePart, projected };
  await shot("03a-uploaded-text-file-accepted");
  checks.push("named source file retains downloadable original and authoritative File history while Chat Completions receives complete text");
  const refusedFiles = [
    { name: "binary.txt", mimeType: "text/plain", buffer: Buffer.from([65, 0, 66]) },
    { name: "invalid.ts", mimeType: "application/typescript", buffer: Buffer.from([0xff, 0xfe]) },
    { name: "archive.txt", mimeType: "text/plain", buffer: Buffer.from("PK\x03\x04pretend archive") },
  ];
  for (const fixture of refusedFiles) {
    const requests = received.length;
    await input().fill("拒绝时保留草稿");
    await page.locator("input[type=file]").setInputFiles(fixture);
    await button("发送").click();
    await page.getByRole("alert").filter({ hasText: /不支持|UTF-8|unsupported|binary/ }).first().waitFor();
    assert.equal(received.length, requests);
    assert.equal(await input().textContent(), "拒绝时保留草稿");
    await button(`移除附件 ${fixture.name}`).click();
  }
  await input().fill("");
  checks.push("binary, malformed UTF-8 and text-labelled archive rejection preserves draft without model request");
  const pluginId = "composer-plugin@composer-fixture";
  let pluginList = await call("manage", { projectId: pid, operation: "plugins" });
  let plugin = pluginList.data.find(row => row.id === pluginId);
  assert.ok(plugin, "project marketplace discovers the real package");
  plugin = await call("manage", { projectId: pid, operation: "pluginInstall", id: pluginId,
    scope: "project", expectedRevision: pluginList.revision, source: plugin.source, expectedDigest: plugin.sourceDigest });
  await page.evaluate(() => window.dispatchEvent(new Event("areal-plugins-changed")));
  const pluginRequests = received.length;
  await input().fill("@");
  await page.getByRole("option", { name: /搜索 MCP 资源/ }).waitFor();
  await input().press("Escape");
  await input().fill("before  after");
  await input().press("Home");
  for (let i = 0; i < 7; i++) await input().press("ArrowRight");
  await page.keyboard.type("@composer");
  await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).waitFor();
  await input().evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: true,
  })));
  assert.equal(received.length, pluginRequests, "IME confirmation never sends or selects a plugin");
  assert.equal(await input().locator('[data-mention-category="plugins"]').count(), 0);
  await shot("plugin-mention-menu");
  await input().press("Escape");
  assert.equal(await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).count(), 0);
  await page.keyboard.type("-");
  await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).waitFor();
  const pluginEnterProbe = () => input().evaluate(element => ({
    focused: document.activeElement === element,
    composing: element.__lexicalEditor?.isComposing(),
    editorState: element.__lexicalEditor?.getEditorState().toJSON(),
    selection: { anchor: getSelection()?.anchorNode?.textContent, offset: getSelection()?.anchorOffset },
    catalog: document.querySelector('[data-testid="composer-catalog"]')?.textContent,
  }));
  const beforePluginEnter = await pluginEnterProbe();
  await input().press("Enter");
  await writeFile(join(scratch, "plugin-enter-probe.json"), JSON.stringify({ before: beforePluginEnter, after: await pluginEnterProbe() }, null, 2));
  assert.equal(received.length, pluginRequests, "mention selection never sends");
  await input().locator('[data-mention-category="plugins"]').waitFor();
  assert.equal(await input().textContent(), "before composer-plugin  after", "caret insertion preserves both sides");
  await shot("plugin-mention-chip");
  const pluginDraftKey = `areal-gui:draft:${pid}:${tid}`;
  const canonical = await page.evaluate(key => localStorage.getItem(key), pluginDraftKey);
  assert.match(canonical, /before \[@composer-plugin\]\(plugin:\/\/composer-plugin@composer-fixture\)  after/);
  await button("新聊天").click();
  await selectConversation(page, tid);
  await input().locator('[data-mention-category="plugins"]').waitFor();
  pluginList = await call("manage", { projectId: pid, operation: "plugins" });
  plugin = pluginList.data.find(row => row.id === pluginId);
  await call("manage", { projectId: pid, operation: "pluginComponentConfigure", id: pluginId,
    component: { kind: "skill", id: plugin.installedSkills[0].id }, enabled: false,
    expectedRevision: pluginList.revision, expectedDigest: plugin.installedDigest });
  await button("发送").click();
  await page.getByRole("alert").filter({ hasText: /插件.*草稿已保留/ }).waitFor();
  assert.equal(received.length, pluginRequests, "disabled retained plugin blocks send");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), pluginDraftKey), canonical);
  pluginList = await call("manage", { projectId: pid, operation: "plugins" });
  plugin = pluginList.data.find(row => row.id === pluginId);
  await call("manage", { projectId: pid, operation: "pluginComponentConfigure", id: pluginId,
    component: { kind: "skill", id: plugin.installedSkills[0].id }, enabled: true,
    expectedRevision: pluginList.revision, expectedDigest: plugin.installedDigest });
  await sendAndWait();
  await until(s => current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length, "plugin mention sent");
  const pluginMessage = received.at(-1).messages.filter(message => message.role === "user"
    && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1).content;
  assert.match(pluginMessage, /plugin:\/\/composer-plugin@composer-fixture/);
  assert.equal(pluginMessage.split("COMPOSER_PLUGIN_EXACT_BODY").length - 1, 1, "exact permitted Skill body appears once");
  const renderedPluginMessage = await page.locator(".user-message-body").filter({ hasText: /before @composer-plugin/ }).last().textContent();
  assert.ok(renderedPluginMessage?.includes("@composer-plugin") && !renderedPluginMessage.includes("[blocked]"), "sent plugin reference is readable without protocol navigation");
  checks.push("caret-aware plugin selection preserves surrounding text, Escape, navigation and retained disabled draft; exact Core skill reaches model once");
  await input().fill("paste boundary");
  await input().evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "[@composer-plugin](plugin://composer-plugin@composer-fixture)");
    clipboardData.items.add(new File(["file bytes"], "plugin-paste.txt", { type: "text/plain" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await button("移除附件 plugin-paste.txt").waitFor();
  assert.equal(await input().textContent(), "paste boundary", "mixed file paste keeps existing attachment handling before plugin parsing");
  await button("移除附件 plugin-paste.txt").click();
  const foldedPluginText = "long plugin paste ".repeat(20) + "[@composer-plugin](plugin://composer-plugin@composer-fixture)";
  await input().evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, foldedPluginText);
  await page.getByRole("button", { name: "在文本框中显示 ›" }).waitFor();
  assert.equal(await input().textContent(), "paste boundary", "long plugin markdown keeps existing folding");
  await page.getByRole("button", { name: "在文本框中显示 ›" }).click();
  await input().locator('[data-mention-category="plugins"]').waitFor();
  await input().fill("");
  await chooseFirst();
  await input().fill("manual before ");
  await input().evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, "[@Old Label](plugin://composer-plugin@composer-fixture)");
  await input().locator('[data-mention-category="plugins"]').filter({ hasText: "composer-plugin" }).waitFor();
  await input().fill("manual remains");
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(`${key}:plugins`) ?? "[]").length === 0, pluginDraftKey);
  assert.equal(await tags().count(), 1, "removing plugin chip retains manual Skill tags");
  await page.getByRole("button", { name: /移除技能 fixture-skill/ }).click();
  await input().fill("");
  await button("新聊天").click();
  await selectFixtureProfile();
  const firstPluginRequests = received.length;
  await input().fill("new plugin @composer");
  await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).click();
  assert.equal(received.length, firstPluginRequests, "pointer selection in a new draft never sends");
  await selectConversation(page, tid);
  await button("新聊天").click();
  await input().locator('[data-mention-category="plugins"]').waitFor();
  await page.reload();
  await input().locator('[data-mention-category="plugins"]').waitFor();
  await shot("plugin-mention-new-draft-reloaded");
  await sendAndWait();
  let firstPluginTid;
  await until(async s => {
    firstPluginTid = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    return firstPluginTid && project(s).state.threads[firstPluginTid]?.turns.at(-1)?.status === "completed" && !project(s).pending.length;
  }, "first plugin message accepted in created Thread");
  const firstPluginMessage = received.at(-1).messages.filter(message => message.role === "user"
    && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1).content;
  assert.equal(firstPluginMessage.split("COMPOSER_PLUGIN_EXACT_BODY").length - 1, 1);
  await selectConversation(page, tid);
  // This compatibility journey protects the persisted read-only Side policy.
  await button("任务操作").click();
  await page.getByRole("menuitem", { name: "历史旁路讨论", exact: true }).click();
  const sideInput = page.getByTestId("side-chat-input");
  await sideInput.fill("side plugin @composer");
  const beforeSidePlugin = received.length;
  await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).waitFor();
  assert.equal(await page.getByTestId("composer-catalog").evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
  }), true, "Side plugin picker remains inside the viewport");
  await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).click();
  assert.equal(received.length, beforeSidePlugin);
  await shot("plugin-mention-side-draft");
  await page.getByTestId("side-chat-send").click();
  const sideCompleted = await until(s => received.length > beforeSidePlugin && Object.values(project(s).state.threads).some(row => row.conversation?.kind === "side" && row.turns?.at(-1)?.status === "completed") && !project(s).pending.length, "Side plugin intent completed");
  const sidePluginMessage = received.at(-1).messages.filter(message => message.role === "user"
    && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1).content;
  assert.match(sidePluginMessage, /plugin:\/\/composer-plugin@composer-fixture/);
  assert.ok(!sidePluginMessage.includes("COMPOSER_PLUGIN_EXACT_BODY"), "Side mention does not borrow parent Profile Skill body");
  const sidePluginThread = Object.values(project(sideCompleted).state.threads).find(row => row.conversation?.kind === "side" && row.turns?.at(-1)?.status === "completed");
  assert.equal(project(sideCompleted).configurations[sidePluginThread.id].readOnly, true);
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-testid="side-chat-input"]');
    return editor?.getAttribute("contenteditable") === "true" && editor.textContent === "";
  });
  const beforeSideFollowUp = received.length;
  const sideTurnsBefore = sidePluginThread.turns.length;
  await sideInput.fill("side follow-up @composer");
  await page.getByRole("option", { name: /composer-plugin.*Composer plugin fixture/ }).waitFor();
  await sideInput.press("Enter");
  assert.equal(received.length, beforeSideFollowUp, "existing Side plugin selection never sends");
  await sideInput.locator('[data-mention-category="plugins"]').waitFor();
  await page.getByTestId("side-chat-send").click();
  const sideFollowUpCompleted = await until(s => received.length > beforeSideFollowUp
    && project(s).state.threads[sidePluginThread.id]?.turns.length === sideTurnsBefore + 1
    && project(s).state.threads[sidePluginThread.id]?.turns.at(-1)?.status === "completed"
    && !project(s).pending.length, "existing Side plugin follow-up completed");
  const sideFollowUpMessage = received.at(-1).messages.filter(message => message.role === "user"
    && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1).content;
  assert.match(sideFollowUpMessage, /side follow-up/);
  assert.match(sideFollowUpMessage, /plugin:\/\/composer-plugin@composer-fixture/);
  assert.match(sideFollowUpMessage, /请在本次请求中使用所选插件 composer-plugin/);
  assert.ok(!sideFollowUpMessage.includes("COMPOSER_PLUGIN_EXACT_BODY"), "existing Side follow-up retains intent without parent Skill body");
  assert.equal(project(sideFollowUpCompleted).configurations[sidePluginThread.id].readOnly, true);

  await page.getByRole("region", { name: "旁路讨论" }).getByRole("button", { name: "返回主会话", exact: true }).click();
  checks.push("canonical paste resolves Core metadata; removing chip preserves manual Skill; first-message plugin draft survives navigation/reload; new and existing legacy Side send reference intent under read-only Core policy");
  await checkComposition(`areal-gui:draft:${pid}:${tid}`, "chat");
  // Use native typing: fill() uses the editor bridge and repairs the selection itself.
  for (const theme of ["dark", "light"]) {
    await button("设置").click();
    await button("外观").click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
    await page.waitForFunction(
      (theme) => document.documentElement.classList.contains(`theme-areal-${theme}`) &&
        document.documentElement.classList.contains("dark") === (theme === "dark"),
      theme,
    );
    await button("返回应用").click();
    const requestCount = received.length;
    await input().focus();
    await page.keyboard.type(`Enter caret ${theme}`);
    await input().press("Enter");
    await until(
      (s) => received.length > requestCount &&
        current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length,
      `${theme}: Enter send completed`,
    );
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="chat-input"]');
      return element?.getAttribute("contenteditable") === "true" && element.textContent === "";
    });
    const caret = await input().evaluate((element) => {
      const selection = getSelection();
      const paragraph = element.firstElementChild;
      return {
        focused: document.activeElement === element,
        collapsed: selection?.isCollapsed,
        inParagraph: !!paragraph && paragraph.contains(selection?.anchorNode),
      };
    });
    const frame = `enter-caret-${theme}.png`;
    await page.screenshot({ path: join(scratch, frame), caret: "initial", scale: "css" });
    frames.push(frame);
    assert.deepEqual(
      caret,
      { focused: true, collapsed: true, inParagraph: true },
      `${theme}: cleared editor caret stays in its text line`,
    );
    await page.keyboard.type("next draft");
    assert.equal(await input().textContent(), "next draft", `${theme}: typing continues after Enter`);
    await input().press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await input().press("Backspace");
  }
  checks.push(
    "native Enter clears accepted messages and restores a line-sized caret in light/dark; subsequent typing remains usable",
  );
  // 已有聊天发送前读取失败不丢标签或正文，不发缺失技能请求。
  await chooseFirst();
  await input().fill("技能失败保留草稿");
  await rename(join(skill, "SKILL.md"), join(skill, "SKILL.unavailable"));
  const requestCount = received.length;
  await button("发送").click();
  await page.getByRole("alert").filter({ hasText: "无法读取技能" }).waitFor();
  assert.equal(received.length, requestCount);
  assert.equal(await tags().count(), 1);
  assert.equal(await page.locator('[data-testid="feedback-notice"][data-tone="error"]').count(), 0);
  assert.equal(await input().textContent(), "技能失败保留草稿");
  await rename(join(skill, "SKILL.unavailable"), join(skill, "SKILL.md"));
  await sendAndWait();
  await until(
    (s) => current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length,
    "second send",
  );
  checks.push(
    "existing Composer Skill failure blocks send and retains draft; retry reads real resource",
  );
  await input().fill("已有聊天 /goal");
  await page.getByRole("option", { name: /设置目标/ }).waitFor();
  await input().press("Enter");
  await button("退出目标模式").waitFor();
  assert.equal(await input().textContent(), "已有聊天 ");
  assert.equal(await page.getByRole("dialog", { name: /目标/ }).count(), 0);
  await button("退出目标模式").click();
  await button("模型").click();
  await slider.fill("2");
  await slider.press("Escape");
  await until(
    (s) => project(s).configurations[tid]?.parameters.reasoningEffort === "low",
    "existing effort configured",
  );
  await input().fill("已有模型设置");
  await sendAndWait();
  assert.equal(received.at(-1).reasoning_effort, "low");
  checks.push("existing Composer inline Goal toggle; model effort configuration and request");
  // 新目标只消费目标正文；技能和文件留在新聊天。
  await button("新聊天").click();
  await selectFixtureProfile();
  await chooseFirst();
  await page.locator("input[type=file]").setInputFiles({
    name: "goal-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("目标之外的附件"),
  });
  await input().fill("/goal");
  await page.getByRole("option", { name: /设置目标/ }).waitFor();
  await input().press("Enter");
  const foldedGoal = "完成\nComposer\n检查\n保持\n折叠";
  await input().fill("");
  await input().evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, foldedGoal);
  await button("移除附件 完成").waitFor();
  assert.equal(await input().textContent(), "");
  await button("开始目标").click();
  await until(
    (s) => Object.values(project(s).state.threads).some((t) => t.goals?.goal),
    "goal created",
  );
  await page.getByRole("button", { name: "移除附件 goal-note.txt" }).waitFor();
  assert.equal(await tags().count(), 1);
  const goalTid = await page
    .locator("[data-testid=areal-workbench]")
    .getAttribute("data-thread-id");
  assert.equal(project(await state()).state.threads[goalTid].goals.goal.objective, foldedGoal);
  assert.equal(await button("移除附件 完成").count(), 0);
  await until(
    (s) => project(s).state.threads[goalTid]?.goals?.goal?.status !== "active",
    "goal settles without progress",
  );
  await shot("04-inline-goal");
  checks.push(
    "new draft inline Goal consumes folded Text as the exact objective while skills and genuine file remain unsent",
  );
  await resizeConversation(app, page, 720, 760);
  await openCatalog();
  await shot("05-narrow-catalog");
  const catalogBox = await page.getByTestId("composer-catalog").boundingBox();
  const viewport =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  assert.ok(
    catalogBox.x >= 0 && catalogBox.y >= 0 && catalogBox.x + catalogBox.width <= viewport.width,
  );
  await page.getByLabel("搜索功能与 Skills").press("Escape");
  const sendBox = await button("发送").boundingBox();
  assert.ok(
    sendBox &&
      sendBox.x + sendBox.width <= viewport.width &&
      sendBox.y + sendBox.height <= viewport.height,
  );
  await openCatalog();
  await page.locator(".composer-editor").click();
  assert.equal(await page.getByTestId("composer-catalog").count(), 0);
  checks.push(
    "narrow window catalog within viewport; send control reachable; outside-click dismissal",
  );
  await button("展开侧栏").first().click();
  await selectConversation(page, tid);
  await button("收起侧栏").click();
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || "{}"), locale: "en" }));
  });
  await page.reload();
  await input().fill("@");
  await page.getByRole("group", { name: "Actions", exact: true }).waitFor();
  await input().fill("@no-such-plugin-reference");
  await page.getByTestId("composer-catalog").getByText("No matches", { exact: true }).waitFor();
  assert.ok(!(await page.getByTestId("composer-catalog").textContent()).match(/[\u4e00-\u9fff]/));
  await shot("plugin-mention-english-no-matches");
  await input().press("Escape");
  checks.push("English plugin picker localizes action groups and no-match state");
  }
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, scratch, checks }));
} catch (error) {
  console.error("renderer errors", errors);
  frames.push(
    ...(await captureSmokeFailure(page, scratch, error)).filter((file) => file.endsWith(".png")),
  );
  throw error;
} finally {
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(received, null, 2));
  if (filesRegression && app) await app.evaluate(() => globalThis.filesReleaseList?.());
  for (const finish of filesFixture.held) finish();
  for (const gate of labelGates) await unlink(gate).catch(error => {
    if (error.code !== "ENOENT") console.error("Source label barrier cleanup:", error.message);
  });
  const stoppingAdapter = await readFile(join(scratch, "core/service.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  await quit();
  const authoritativeHistory = [];
  for (const entry of await readdir(join(scratch, "core"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(scratch, "core", entry.name, "state");
    const names = await readdir(directory).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (record.thread) authoritativeHistory.push({ projectId: entry.name, record });
    }
  }
  await writeFile(join(scratch, "authoritative-history.json"), JSON.stringify(authoritativeHistory, null, 2));
  try {
    await assertApplicationStopped(binary, env, stoppingAdapter);
    checks.push("application quit stops the isolated adapter and all Core generations, including projectless");
  } catch (error) {
    console.error("Adapter fixture cleanup:", error.message);
    if (passed) {
      passed = false;
      process.exitCode = 1;
      errors.push(`Explicit safe stop failed: ${error.message}`);
    }
    // 仅清理本次隔离 home 中的服务；失败不遗留模型任务或后台进程。
    try {
      const instances = JSON.parse(
        execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
      );
      for (const instance of instances)
        if (instance.workspace === workspace && instance.state !== "stopped") {
          execFileSync(
            binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            { env, timeout: 120000, stdio: "pipe" },
          );
        }
    } catch (failure) {
      console.error("Core fixture cleanup:", failure.message);
    }
    try {
      const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
      process.kill(metadata.pid, "SIGTERM");
    } catch {}
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(join(scratch, "paste-evidence.json"), JSON.stringify(pasteEvidence, null, 2));
  const sourceFiles = {};
  for (const path of execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    try {
      sourceFiles[path] = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
      sourceFiles[path] = null; // Tracked deletions remain part of the source evidence.
    }
  }
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        sourceFiles,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        binary,
        platform: process.platform,
        arch: process.arch,
        runtime: "real Electron + real Rust Core/Runtime + deterministic local HTTP/SSE model",
        skillsRegression,
        filesRegression,
        referencesRegression,
        predictionRequests,
        modelRequests: "model-requests.json",
        authoritativeHistory: "authoritative-history.json",
        labelsTrace: skillsRegression ? labelsTrace : undefined,
        skillCatalogEvents,
        nativeDialogs: "project picker and archive/quit confirmations injected",
        filesBarrier: filesRegression ? "Source Main IPC delivery delay for workspace/list; original handler performs all validation and returns actual results" : undefined,
        scratch,
        frames,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
