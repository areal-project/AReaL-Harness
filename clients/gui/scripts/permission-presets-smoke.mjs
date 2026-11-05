import { readTurnToolDetails } from "./support/tool-history.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createProjectConversation,
  selectConversation,
  captureSmokeFailure,
} from "./smoke-navigation.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { checkBrowserStartup } from "./browser-startup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { CoreClient } = await import("../packages/runtime-client/core.js");
const WebSocket = require("ws");
const { ServiceConnection, waitForServiceExit } = require(
  join(gui, "app/src/core/service-client.cjs"),
);
const binary = process.env.AREAL_CORE_BIN || join(root, ".local/dev-bin/areal");
assert.ok(isAbsolute(binary), "AREAL_CORE_BIN must identify the frozen absolute Core path");
assert.equal(
  process.env.AREAL_GUI_EXECUTABLE,
  undefined,
  "This runner accepts source Electron only",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const evidenceRoot = join(root, ".scratch/permission-presets-gui");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "run-"));
const stateRoot = await makeTempDir("app-");
const owner = randomUUID();
await writeFile(join(stateRoot, ".owner"), owner);
const workspace = join(stateRoot, "workspace");
const userHome = join(stateRoot, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });

const presets = [
  { id: "ask", label: "请求审批", resources: "workspace", reviewer: "human" },
  { id: "autoReview", label: "帮我审批", resources: "workspace", reviewer: "model" },
  { id: "fullAccess", label: "完全访问", resources: "deployment", reviewer: "none" },
];
const checks = [],
  errors = [],
  requests = [],
  frames = [],
  threads = [];
const facts = {
  startedAt: new Date().toISOString(),
  stateRoot,
  workspace,
  launches: [],
  cleanup: [],
};
const siteFacts = { documents: [], otherGets: [], posts: [] };
const site = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  if (request.method !== "GET") {
    siteFacts.posts.push({ method: request.method, path: url.pathname });
    response.writeHead(405);
    response.end("GET only");
    return;
  }
  if (url.pathname !== "/" && url.pathname !== "/search") {
    siteFacts.otherGets.push(url.pathname);
    response.writeHead(204);
    response.end();
    return;
  }
  const query = url.searchParams.get("q") ?? "";
  siteFacts.documents.push({ path: url.pathname, query });
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Search ${query || "ready"}</title>
    <style>body{font:20px system-ui;padding:32px;background:#fff;color:#172033}input,button{font:inherit;padding:10px}</style>
    <main><h1>PERMISSION_BROWSER_FIXTURE</h1><form role="search" method="get" action="/search">
    <label>Search query <input type="search" name="q" aria-label="Search query"></label>
    <button type="submit">Search fixture</button></form><p id="result">RESULT_${query || "READY"}</p></main>
    <script>window.nativeSentinel=crypto.randomUUID();</script>`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://browser-synthetic.localhost:${site.address().port}/`;
const browser = {
  stage: 0,
  pageId: null,
  observation: null,
  staleTarget: null,
  takeoverReady: false,
  release: null,
};
function findRecord(value, predicate, depth = 0) {
  if (value == null || depth > 12) return null;
  if (typeof value === "string") {
    try {
      return findRecord(JSON.parse(value), predicate, depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Object.values(value)) {
    const result = findRecord(child, predicate, depth + 1);
    if (result) return result;
  }
  return null;
}
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
const model = createServer((request, response) => {
  void (async () => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    const messages = body.messages ?? [];
    const userIndex = messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        /^(?:permission:(?:ask|autoReview|fullAccess)|browser:continuous)$/.test(
          textOf(message.content),
        ),
    );
    const prompt = textOf(messages[userIndex]?.content);
    const results = messages.slice(userIndex + 1).filter((message) => message.role === "tool");
    const last = results.at(-1);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const tool = (id, name, args) => {
      send({
        tool_calls: [
          { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      });
      send({}, "tool_calls");
    };
    const done = (text) => {
      send({ content: text });
      send({}, "stop");
    };
    const write = prompt.match(/^permission:(ask|autoReview|fullAccess)$/);
    if (write) {
      if (!results.length)
        tool(`write-${write[1]}`, "fs_create", {
          path: `${write[1]}.txt`,
          text: `PERMISSION_WRITE_${write[1]}`,
        });
      else done(`PERMISSION_OK_${write[1]}`);
    } else if (prompt === "browser:continuous") {
      const observation = findRecord(
        last?.content,
        (value) => typeof value.observationId === "string" && Array.isArray(value.nodes),
      );
      if (observation) browser.observation = observation;
      const descriptor = findRecord(
        last?.content,
        (value) => value.available === true && Array.isArray(value.pages),
      );
      if (descriptor) browser.pageId = descriptor.pages[0];
      const observe = (id) =>
        tool(id, "browser_v1", { operation: "observe", parameters: { pageId: browser.pageId } });
      const ready = (id) =>
        tool(id, "browser_v1", {
          operation: "wait",
          parameters: {
            pageId: browser.pageId,
            condition: { kind: "documentReady", state: "complete" },
            timeoutMs: 15000,
          },
        });
      const field = () => {
        assert.ok(browser.observation, "a real native observation precedes every action");
        const ref = browser.observation.nodes.find(
          (node) => node.name?.trim() === "Search query" && node.ref,
        )?.ref;
        assert.match(ref ?? "", /^r[1-9]\d*$/, "native AX exposes the search field Ref");
        return ref;
      };
      const act = (id, action) =>
        tool(id, "browser_v1", {
          operation: "act",
          parameters: {
            pageId: browser.pageId,
            snapshotId: browser.observation.observationId,
            action,
          },
        });
      switch (browser.stage++) {
        case 0:
          tool("browser-describe", "browser_v1", { operation: "describe", parameters: {} });
          break;
        case 1:
          assert.ok(
            browser.pageId,
            "Core-approved describe returns the actual native page identity",
          );
          tool("browser-navigate", "browser_v1", {
            operation: "navigate",
            parameters: { pageId: browser.pageId, url: siteUrl },
          });
          break;
        case 2:
          ready("browser-ready-initial");
          break;
        case 3:
          observe("browser-read-first");
          break;
        case 4:
          browser.staleTarget = { snapshotId: browser.observation.observationId, ref: field() };
          observe("browser-read-repeat");
          break;
        case 5:
          act("browser-fill-first", { kind: "fill", ref: field(), value: "FIRST" });
          break;
        case 6:
          observe("browser-read-first-query");
          break;
        case 7:
          act("browser-search-first", { kind: "press", ref: field(), key: "Enter" });
          break;
        case 8:
          ready("browser-ready-first-result");
          break;
        case 9:
          observe("browser-read-first-result");
          break;
        case 10:
          act("browser-fill-second", { kind: "fill", ref: field(), value: "SECOND" });
          break;
        case 11:
          observe("browser-read-second-query");
          break;
        case 12:
          act("browser-search-second", { kind: "press", ref: field(), key: "Enter" });
          break;
        case 13:
          ready("browser-ready-second-result");
          break;
        case 14:
          observe("browser-read-second-result");
          break;
        case 15:
          tool("browser-stale-target", "browser_v1", {
            operation: "act",
            parameters: {
              pageId: browser.pageId,
              snapshotId: browser.staleTarget.snapshotId,
              action: { kind: "fill", ref: browser.staleTarget.ref, value: "STALE_FORBIDDEN" },
            },
          });
          break;
        case 16:
          browser.takeoverReady = true;
          await new Promise((resolve) => {
            browser.release = resolve;
          });
          observe("browser-after-takeover");
          break;
        default:
          done("PERMISSION_BROWSER_OK");
      }
    } else throw new Error(`Unexpected fixture prompt: ${prompt}`);
    response.end("data: [DONE]\n\n");
  })().catch((error) => {
    errors.push(`Model fixture: ${error.stack ?? error}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(userHome, ".areal/config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(stateRoot, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Use the requested fixture tools and report the result.",
      },
    ],
  }),
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(",");
Object.assign(env, {
  NO_PROXY: noProxy,
  no_proxy: noProxy,
  AREAL_CORE_BIN: binary,
  AREAL_CORE_USER_HOME: userHome,
  AREAL_GUI_USER_DATA: join(stateRoot, "electron"),
  AREAL_CORE_HOME: join(stateRoot, "core"),
  AREAL_HARNESS_HOME: join(stateRoot, "runtime"),
  AREAL_HARNESS_SERVICE_HOME: join(stateRoot, "registry"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
});
const binaryHash = sha(await readFile(binary));
let app,
  page,
  projectId,
  passed = false;
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (snapshot) => snapshot.projects.find((item) => item.id === projectId);
const approvals = (snapshot, threadId) =>
  (project(snapshot)?.state?.interactions?.[threadId]?.data ?? []).filter(
    (item) => item.kind === "approval",
  );
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function shot(name) {
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  frames.push(`${name}.png`);
}
async function preview(operation, threadId, extra = {}) {
  return page.evaluate((parameters) => window.arealDesktop.preview(parameters), {
    operation,
    projectId,
    threadId,
    ...extra,
  });
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  app
    .process()
    .stderr.on(
      "data",
      (chunk) => void writeFile(join(evidence, "electron.stderr.log"), chunk, { flag: "a" }),
    );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "desktop service ready");
  const runtime = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 960);
    const prefs = window.webContents.getLastWebPreferences();
    return {
      pid: process.pid,
      userData: app.getPath("userData"),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    };
  });
  assert.equal(runtime.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(runtime.sandbox, true);
  assert.equal(runtime.contextIsolation, true);
  assert.equal(runtime.nodeIntegration, false);
  facts.launches.push(runtime);
  await until(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    "native main window visible",
  );
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
}
async function closeOwned() {
  const metadata = await readFile(join(stateRoot, "core/service.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      })
      .catch(() => {});
    await app.close();
    app = null;
  }
  try {
    await assertApplicationStopped(binary, env, metadata);
  } catch {
    assert.ok(metadata, "cleanup can only target this run's service metadata");
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      await connection.request("stopService", { protocol: metadata.protocol }, true);
    } finally {
      connection.close();
    }
    await waitForServiceExit(join(stateRoot, "core"), metadata);
    await assertApplicationStopped(binary, env, metadata);
  }
  facts.cleanup.push({ pid: metadata?.pid ?? null, serviceExited: true });
}
async function choosePreset(preset, capture = false) {
  await page.getByRole("button", { name: "更改权限", exact: true }).click();
  const choices = page.getByRole("menuitemradio");
  await choices.first().waitFor();
  assert.equal(
    await choices.count(),
    3,
    "Composer offers exactly three resource and reviewer presets",
  );
  for (const option of presets)
    assert.equal(
      await page.getByRole("menuitemradio", { name: new RegExp(`^${option.label}`) }).isEnabled(),
      true,
    );
  if (capture) await shot("01-three-presets");
  await page.getByRole("menuitemradio", { name: new RegExp(`^${preset.label}`) }).click();
}
async function assertSelectedPreset(preset, label, capture = false) {
  await page.getByRole("button", { name: "更改权限", exact: true }).click();
  const choice = page.getByRole("menuitemradio", { name: new RegExp(`^${preset.label}`) });
  assert.equal(await choice.getAttribute("aria-checked"), "true", label);
  const alignment = await choice.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const indicator = element
      .querySelector('[data-slot="dropdown-menu-radio-item-indicator"] svg')
      .getBoundingClientRect();
    return {
      rowCenter: row.y + row.height / 2,
      indicatorCenter: indicator.y + indicator.height / 2,
    };
  });
  facts.indicatorAlignment ??= [];
  facts.indicatorAlignment.push({ label, ...alignment });
  assert.ok(
    Math.abs(alignment.rowCenter - alignment.indicatorCenter) <= 1,
    "permission checkmark is vertically centered in the complete option row",
  );
  if (capture) await shot(capture);
  await page.keyboard.press("Escape");
}
async function send(text) {
  const before = new Set(Object.keys(project(await state())?.state?.threads ?? {}));
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  return until(async () => {
    const snapshot = await state();
    const id = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    return id && !before.has(id) && project(snapshot)?.state?.threads?.[id] ? id : null;
  }, "UI send creates a new Core Thread");
}
async function completed(threadId) {
  return until(async () => {
    const snapshot = await state();
    const pending = approvals(snapshot, threadId).find((item) => item.status === "pending");
    if (pending)
      throw new Error(
        `Unexpected approval for ${pending.tool} ${JSON.stringify(pending.effectiveArguments)}`,
      );
    const thread = project(snapshot)?.state?.threads?.[threadId];
    return thread?.turns?.at(-1)?.status === "completed" ? thread : null;
  }, `completed Thread ${threadId}`);
}
async function readCoreThread(threadId) {
  const instance = project(await state()).core.instanceId;
  const descriptor = JSON.parse(
    execFileSync(binary, ["service", "status", "--instance", instance, "--json"], {
      env,
      encoding: "utf8",
      timeout: 20000,
    }),
  );
  assert.equal(descriptor.state, "ready");
  assert.equal(descriptor.workspace, workspace);
  assert.equal(descriptor.serviceId, instance);
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find((item) => item.permissions.includes("observe"));
  assert.ok(principal?.token);
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${principal.token}` },
        followRedirects: false,
      }),
  });
  try {
    await client.connect();
    return (await client.request("thread/read", { threadId, includeTurns: true })).thread;
  } finally {
    client.close();
  }
}
function assertPreset(configuration, preset) {
  assert.equal(configuration.options.permissionPreset, preset.id);
  assert.equal(configuration.permissions.resources, preset.resources);
  assert.equal(configuration.permissions.reviewer, preset.reviewer);
  assert.equal(configuration.permissions.fullAccessAvailable, true);
}
console.log("Permission preset GUI evidence:", evidence);
try {
  await launch();
  facts.startup = await checkBrowserStartup(app, { binary, userHome, scratch: evidence });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const connected = await until(
    async () =>
      (await state()).projects.find((item) => item.root === workspace && item.state?.connected),
    "isolated project connected",
  );
  projectId = connected.id;
  assert.equal(connected.core.features.permissionPresets, true);
  assert.equal(connected.core.features.permissionFullAccess, true);
  for (const [index, preset] of presets.entries()) {
    await createProjectConversation(page, "workspace");
    await assertSelectedPreset(
      index === 0 ? presets[1] : presets[index - 1],
      index === 0
        ? "fresh GUI draft defaults to autoReview"
        : "new chat inherits the last explicit permission choice",
      index === 0 ? "00-default-auto-review" : false,
    );
    await choosePreset(preset, index === 0);
    const threadId = await send(`permission:${preset.id}`);
    threads.push({ threadId, preset: preset.id });
    const thread = await completed(threadId);
    const snapshot = await state();
    assertPreset(project(snapshot).configurations[threadId], preset);
    const authoritative = await readCoreThread(threadId);
    assertPreset(authoritative.turns[0].configuration, preset);
    assert.equal(
      await readFile(join(workspace, `${preset.id}.txt`), "utf8"),
      `PERMISSION_WRITE_${preset.id}`,
    );
    assert.equal(
      approvals(snapshot, threadId).length,
      0,
      "ordinary workspace writes require no approval in any preset",
    );
    assert.match(JSON.stringify(thread.turns[0]), new RegExp(`PERMISSION_OK_${preset.id}`));
    await page.getByText(`PERMISSION_OK_${preset.id}`, { exact: true }).waitFor();
    facts[preset.id] = { thread, configuration: project(snapshot).configurations[threadId] };
  }
  checks.push(
    "Three UI-selected presets reach the first Core Turn atomically; actual workspace writes complete with zero approval interactions.",
  );
  await shot("02-workspace-result");
  await closeOwned();
  const requestCount = requests.length;
  await launch();
  for (const { threadId, preset: id } of threads) {
    await selectConversation(page, threadId);
    const snapshot = await state();
    const preset = presets.find((item) => item.id === id);
    assertPreset(project(snapshot).configurations[threadId], preset);
    await page.getByRole("button", { name: "更改权限", exact: true }).click();
    assert.equal(
      await page
        .getByRole("menuitemradio", { name: new RegExp(`^${preset.label}`) })
        .getAttribute("aria-checked"),
      "true",
    );
    await page.keyboard.press("Escape");
  }
  assert.equal(
    requests.length,
    requestCount,
    "reopening histories does not replay model submissions",
  );
  checks.push(
    "All three Core presets and selected menu values survive application quit and reopen without submitting again.",
  );
  await shot("03-reopened-presets");
  await createProjectConversation(page, "workspace");
  await assertSelectedPreset(
    presets[2],
    "new chat permission preference survives quit and reopen",
    "04-remembered-full-access",
  );
  await selectConversation(page, threads[2].threadId);
  await choosePreset(presets[0]);
  await until(
    async () =>
      project(await state()).configurations[threads[2].threadId]?.options?.permissionPreset ===
      "ask",
    "existing chat accepts explicit permission change",
  );
  await createProjectConversation(page, "workspace");
  await assertSelectedPreset(
    presets[0],
    "explicit ask selected in an existing chat becomes the new-chat default",
  );
  await closeOwned();
  await launch();
  await createProjectConversation(page, "workspace");
  await assertSelectedPreset(
    presets[0],
    "explicit ask preference survives restart",
    "05-remembered-ask",
  );
  assert.equal(
    requests.length,
    requestCount,
    "changing permission preferences never submits a model request",
  );
  checks.push(
    "Fresh chats default to autoReview; all explicit choices become new-chat defaults; fullAccess and explicit ask persist across restarts; checkmarks are vertically centered.",
  );

  await app.evaluate(
    ({ dialog, app, BrowserWindow }, { origin, modulePath }) => {
      const originalDialog = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        if (
          options?.title === "允许本地开发站点" &&
          options.message === `允许此浏览工作区访问 ${origin}？`
        ) {
          globalThis.__permissionOriginPrompts = (globalThis.__permissionOriginPrompts ?? 0) + 1;
          return { response: 0, checkboxChecked: false };
        }
        return originalDialog(...args);
      };
      const { CorePreview } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      globalThis.__permissionMainCalls = [];
      for (const method of ["prepare", "execute"]) {
        const original = CorePreview.prototype[method];
        CorePreview.prototype[method] = async function (request) {
          const record = {
            method,
            operation: request.operation,
            callId: request.callId,
            threadId: request.threadId,
            turnId: request.turnId,
          };
          try {
            const value = await original.call(this, request);
            globalThis.__permissionMainCalls.push({ ...record, result: structuredClone(value) });
            return value;
          } catch (error) {
            globalThis.__permissionMainCalls.push({ ...record, error: error.message });
            throw error;
          }
        };
      }
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    },
    { origin: new URL(siteUrl).origin, modulePath: join(gui, "app/src/core/preview.cjs") },
  );
  await createProjectConversation(page, "workspace");
  await choosePreset(presets[0]);
  const browserThread = await send("browser:continuous");
  const authorization = await until(
    async () => approvals(await state(), browserThread).find((item) => item.status === "pending"),
    "initial Core browser authorization",
  );
  assert.equal(authorization.tool, "browser_v1");
  assert.equal(authorization.effectiveArguments.arguments.operation, "describe");
  await page.getByRole("region", { name: "工具审批", exact: true }).waitFor();
  await shot("04-initial-browser-authorization");
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await until(() => browser.takeoverReady, "two real searches and stale target attempt completed");
  const native = await app.evaluate(async ({ webContents }, origin) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(origin));
    if (!contents) return null;
    return {
      id: contents.id,
      url: contents.getURL(),
      facts: await contents.executeJavaScript(
        `({title:document.title,result:document.querySelector('#result')?.textContent,query:document.querySelector('[name=q]')?.value,sentinel:window.nativeSentinel,bridge:typeof window.arealDesktop,node:typeof require})`,
      ),
      png: (await contents.capturePage()).toPNG().toString("base64"),
    };
  }, new URL(siteUrl).origin);
  assert.ok(native?.id && native.facts.sentinel, "actual native WebContents loaded the fixture");
  assert.equal(native.facts.result, "RESULT_SECOND");
  assert.equal(native.facts.title, "Search SECOND");
  assert.equal(native.facts.bridge, "undefined");
  assert.equal(native.facts.node, "undefined");
  await writeFile(join(evidence, "05-native-search-result.png"), Buffer.from(native.png, "base64"));
  delete native.png;
  const beforeTakeover = await preview("state", browserThread);
  assert.equal(beforeTakeover.browser.pageId, browser.pageId);
  assert.equal(beforeTakeover.browser.control, "agent");
  await preview("takeover", browserThread, { pageId: browser.pageId });
  const afterTakeover = await until(async () => {
    const value = await preview("state", browserThread);
    return value.browser?.control === "human" ? value : null;
  }, "existing Main takeover path converges native input");
  browser.release();
  browser.release = null;
  const browserHistory = await completed(browserThread);
  await page.getByText("PERMISSION_BROWSER_OK", { exact: true }).waitFor();
  const browserTurn = await readTurnToolDetails({
    command: async (name, params) => {
      const result = await page.evaluate(
        ({ name, params }) => window.arealDesktop.command(name, params),
        { name, params },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    },
    readThread: async () => project(await state()).state.threads[browserThread],
    projectId,
    threadId: browserThread,
    turnId: browserHistory.turns.at(-1).id,
  });
  const calls = browserTurn.items.filter(
    (item) => item.type === "dynamicToolCall" && item.tool === "browser_v1",
  );
  for (const id of [
    "browser-describe",
    "browser-navigate",
    "browser-ready-initial",
    "browser-read-first",
    "browser-read-repeat",
    "browser-fill-first",
    "browser-read-first-query",
    "browser-search-first",
    "browser-ready-first-result",
    "browser-read-first-result",
    "browser-fill-second",
    "browser-read-second-query",
    "browser-search-second",
    "browser-ready-second-result",
    "browser-read-second-result",
  ])
    assert.equal(
      calls.find((item) => item.callId === id)?.success,
      true,
      `actual Core history confirms ${id}`,
    );
  for (const id of ["browser-stale-target", "browser-after-takeover"])
    assert.equal(
      calls.find((item) => item.callId === id)?.success,
      false,
      `actual Core history rejects ${id}`,
    );
  const browserApprovals = approvals(await state(), browserThread);
  assert.equal(
    browserApprovals.length,
    1,
    "continuous reads, two searches and refused stale/revoked calls add no human approval",
  );
  assert.equal(browserApprovals[0].response.decision, "allowOnce");
  assert.deepEqual(siteFacts.documents, [
    { path: "/", query: "" },
    { path: "/search", query: "FIRST" },
    { path: "/search", query: "SECOND" },
  ]);
  assert.deepEqual(siteFacts.posts, []);
  const main = await app.evaluate(() => ({
    calls: globalThis.__permissionMainCalls,
    originPrompts: globalThis.__permissionOriginPrompts ?? 0,
  }));
  assert.equal(
    main.originPrompts,
    0,
    "the synthetic public-search host requires no local-development Origin grant",
  );
  for (const [callId, query] of [
    ["browser-search-first", "FIRST"],
    ["browser-search-second", "SECOND"],
  ]) {
    const plan = main.calls.find((item) => item.method === "prepare" && item.callId === callId)
      ?.result?.plan;
    assert.equal(plan?.localDevelopment, false);
    assert.equal(plan?.target?.semantics?.kind, "public_search");
    assert.equal(plan.target.semantics.method, "GET");
    assert.equal(plan.target.semantics.query, query);
  }
  assert.ok(
    main.calls.some(
      (item) =>
        item.method === "prepare" &&
        item.callId === "browser-stale-target" &&
        /stale_ref/.test(item.error ?? ""),
    ),
  );
  assert.equal(
    main.calls.filter(
      (item) =>
        item.method === "execute" &&
        ["browser-stale-target", "browser-after-takeover"].includes(item.callId),
    ).length,
    0,
    "stale or human-controlled calls never dispatch in Main",
  );
  facts.browser = {
    threadId: browserThread,
    native,
    beforeTakeover,
    afterTakeover,
    approvals: browserApprovals,
    history: browserHistory,
    main,
    siteFacts,
  };
  checks.push(
    "One actual Core authorization permits repeated native reads and two GET searches; Core history, Main calls and server receipts agree.",
  );
  checks.push(
    "The original stale snapshot is rejected before native dispatch; injected takeover through the existing Main API revokes the following Core read.",
  );
  await shot("06-browser-completed");
  assert.deepEqual(errors, []);
  assert.equal(
    sha(await readFile(binary)),
    binaryHash,
    "Core binary remains frozen across both launches",
  );
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) {
    await captureSmokeFailure(page, evidence, error).catch(() => {});
    await state()
      .then((snapshot) =>
        writeFile(join(evidence, "failure-core-state.json"), JSON.stringify(snapshot, null, 2)),
      )
      .catch(() => {});
    if (app)
      await app
        .evaluate(() => ({
          calls: globalThis.__permissionMainCalls,
          originPrompts: globalThis.__permissionOriginPrompts ?? 0,
        }))
        .then((main) =>
          writeFile(join(evidence, "failure-main-calls.json"), JSON.stringify(main, null, 2)),
        )
        .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  browser.release?.();
  await closeOwned().catch((error) => {
    errors.push(`Cleanup: ${error.stack ?? error}`);
    passed = false;
    process.exitCode = 1;
  });
  for (const server of [site, model]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const sourceFiles = [
    "clients/gui/scripts/permission-presets-smoke.mjs",
    "clients/gui/renderer/src/ComposerPermissionMenu.tsx",
    "clients/gui/renderer/src/permissions.ts",
    "clients/gui/renderer/src/settings/applicationSettings.ts",
    "clients/gui/renderer/src/settings/applicationPreferences.ts",
    "clients/gui/renderer/src/Composer.tsx",
    "clients/gui/renderer/src/DraftComposer.tsx",
    "services/workbench/src/desktop/core/backend.cjs",
    "services/workbench/src/desktop/core/service-protocol.cjs",
    "clients/gui/app/src/core/main.cjs",
    "clients/gui/app/src/core/preview.cjs",
    "core/engine/src/permissions.rs",
    "core/engine/src/desktop/interactions.rs",
  ];
  const sourceSHA256 = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (name) => [name, sha(await readFile(join(root, name)))]),
    ),
  );
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, "facts.json"), JSON.stringify(facts, null, 2));
  const manifest = {
    passed,
    checks,
    errors,
    frames,
    startedAt: facts.startedAt,
    endedAt: new Date().toISOString(),
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    worktreeStatus: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    diffSHA256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
    sourceSHA256,
    coreBinary: binary,
    coreBinarySHA256: binaryHash,
    coreBinarySHA256After: sha(await readFile(binary)),
    os: process.platform,
    arch: process.arch,
    node: process.version,
    fixtureVersion: 1,
    entrypoint: "node clients/gui/scripts/permission-presets-smoke.mjs",
    scope:
      "source Electron + real independent desktop/Core/Runtime + local deterministic SSE model + native synthetic GET site through public-search classification",
    injectedBoundaries: [
      "Native project picker returns only the owned workspace",
      "Native dialog spy rejects any unexpected local-Origin prompt for the exact synthetic host",
      "Read-only CorePreview prepare/execute wrappers record original results",
      "Human takeover uses the existing Main preview API at a deterministic model-response barrier",
    ],
    unverified: [
      "real provider and reviewer inference",
      "live public search websites",
      "physical keyboard/mouse",
      "packaged or signed application",
      "other operating systems",
    ],
  };
  if (facts.cleanup.at(-1)?.serviceExited) {
    assert.equal(await readFile(join(stateRoot, ".owner"), "utf8"), owner);
    await rm(stateRoot, { recursive: true });
    manifest.stateRemoved = true;
  }
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, checks, errors, evidence }, null, 2));
}
