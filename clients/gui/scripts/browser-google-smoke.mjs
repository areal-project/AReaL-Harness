import { readTurnToolDetails } from "./support/tool-history.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";
import { checkBrowserStartup } from "./browser-startup.mjs";

// Real GUI/Main/desktop adapter/Core/native Google; only inference is deterministic.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-google-");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
await writeFile(join(workspace, "README.md"), "# Unified browser tabs fixture\n");
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const localSearch = process.env.AREAL_BROWSER_LOCAL_SEARCH === "1";
const site = localSearch
  ? createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      const results = url.pathname === "/search";
      const html = `<!doctype html><title>${results ? "AI Agent results fixture" : "Search fixture"}</title><main>
    <form action="/search" method="GET"><label>Search <input name="q" aria-label="Search" value="${results ? "AI Agent" : ""}"></label><button>Search</button></form>
    ${results ? '<h1>AI Agent results fixture</h1><a href="/one">AI Agent result one</a><a href="/two">AI Agent result two</a><iframe src="/frame"></iframe>' : ""}</main>`;
      setTimeout(
        () => response.end(url.pathname === "/frame" ? "<p>late frame</p>" : html),
        results ? 250 : 0,
      );
    })
  : null;
if (site) await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const searchUrl = site
  ? `http://browser-synthetic.localhost:${site.address().port}/`
  : "https://www.google.com/";
const evidence = {
  scope: `source Electron + Core + ${site ? "synthetic local search (not Google)" : "live Google"} + deterministic local inference`,
  turns: [],
  requests: [],
};
let scenario = "open",
  stage = 0,
  pageId,
  observation,
  oldObservation,
  app,
  page,
  projectId,
  threadId;
function find(value, predicate, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (typeof value === "string") {
    try {
      return find(JSON.parse(value), predicate, depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (predicate(value)) return value;
  return (
    Object.values(value)
      .map((v) => find(v, predicate, depth + 1))
      .find(Boolean) ?? null
  );
}
function searchRef(obs) {
  const node = obs.nodes.find(
    (n) => /combobox|searchbox|textbox/i.test(n.role) && /search|搜索/i.test(n.name),
  );
  assert.ok(node?.ref, "Google search field must be in actual AX observation");
  return node.ref;
}
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      last = body.messages.at(-1);
    const result = last?.role === "tool" ? last.content : null;
    evidence.requests.push({
      scenario,
      stage,
      guidance: JSON.stringify(body.messages).includes("Built-in Browser guidance:"),
    });
    if (scenario === "chat-before" || scenario === "chat-after") {
      assert.doesNotMatch(
        JSON.stringify(body.messages),
        /Every new user request (?:must start|starts) with describe/,
        "ordinary chat must not receive an unconditional browser instruction",
      );
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish_reason ?? null }] })}\n\n`,
      );
    const tool = (args) => {
      send({
        tool_calls: [
          {
            index: 0,
            id: `google-${scenario}-${stage}`,
            type: "function",
            function: { name: "browser_v1", arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls");
    };
    const finish = (text) => {
      send({ content: text });
      send({}, "stop");
    };
    const obs = find(result, (v) => v.observationId && Array.isArray(v.nodes));
    const description = find(result, (v) => v.protocol === "areal.browser.host.v1");
    if (description) pageId = description.pages[0];
    if (obs) observation = obs;
    if (scenario === "chat-before" || scenario === "chat-after") {
      finish(scenario === "chat-before" ? "1" : "不客气");
    } else if (scenario === "spawn") {
      if (stage === 0) tool({ operation: "describe", parameters: {} });
      else if (stage === 1) tool({ operation: "observe", parameters: { pageId } });
      else if (stage === 2)
        tool({
          operation: "newPage",
          parameters: { pageId, url: new URL("/agent", searchUrl).href },
        });
      else finish("Agent created an independent page.");
      stage++;
    } else if (scenario === "old") {
      if (stage++ === 0)
        tool({
          operation: "act",
          parameters: {
            pageId,
            snapshotId: oldObservation.observationId,
            action: { kind: "fill", ref: searchRef(oldObservation), value: "MUST_NOT_DISPATCH" },
          },
        });
      else finish("Old turn refs refused.");
    } else if (scenario === "human") {
      if (stage++ === 0) tool({ operation: "observe", parameters: { pageId } });
      else finish("Human control respected.");
    } else if (scenario === "change" || scenario === "takeover") {
      if (stage++ === 0) tool({ operation: "observe", parameters: { pageId } });
      else finish("Navigation invalidation classified.");
    } else if (scenario === "read") {
      if (stage === 0) tool({ operation: "describe", parameters: {} });
      else if (stage === 1) tool({ operation: "observe", parameters: { pageId } });
      else finish(`Read Google results: ${observation.text.slice(0, 1800)}`);
      stage++;
    } else if (scenario === "open") {
      if (stage === 0) tool({ operation: "describe", parameters: {} });
      else if (stage === 1) tool({ operation: "navigate", parameters: { pageId, url: searchUrl } });
      else if (stage === 2)
        tool({
          operation: "wait",
          parameters: {
            pageId,
            condition: { kind: "documentReady", state: "complete" },
            timeoutMs: 15000,
          },
        });
      else if (stage === 3) tool({ operation: "observe", parameters: { pageId } });
      else finish("Google opened and search field read.");
      stage++;
    } else {
      if (stage === 0) tool({ operation: "describe", parameters: {} });
      else if (stage === 1 || stage === 4 || stage === 7)
        tool({ operation: "observe", parameters: { pageId } });
      else if (stage === 2)
        tool({
          operation: "act",
          parameters: {
            pageId,
            snapshotId: observation.observationId,
            action: { kind: "fill", ref: searchRef(observation), value: "AI Agent" },
          },
        });
      else if (stage === 3) tool({ operation: "wait", parameters: { pageId, timeoutMs: 1000 } });
      else if (stage === 5)
        tool({
          operation: "act",
          parameters: {
            pageId,
            snapshotId: observation.observationId,
            action: { kind: "press", ref: searchRef(observation), key: "Enter" },
          },
        });
      else if (stage === 6)
        tool({
          operation: "wait",
          parameters: {
            pageId,
            condition: { kind: "documentReady", state: "complete" },
            timeoutMs: 15000,
          },
        });
      else finish(`Read Google results: ${observation.text.slice(0, 1800)}`);
      stage++;
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    evidence.modelError = error.stack;
    response.end();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        allowThreadProcesses: true,
        instructions:
          "Complete the current user request. Use browser tools when the task requires browser interaction and report actual observations.",
      },
    ],
  }),
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"),
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "ELECTRON_RUN_AS_NODE",
])
  delete env[key];
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function state() {
  return page.evaluate(() => window.arealDesktop.snapshot());
}
async function command(name, params) {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function readProcesses(params) {
  const result = await page.evaluate((params) => window.arealDesktop.command("manage", params), {
    projectId,
    threadId,
    ...params,
  });
  // Terminal creation/resize/write uses the same per-thread journal. Retry only
  // the known rejection of this read, never replay a terminal mutation.
  if (!result.ok && result.error?.code === -32009) return null;
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function run(kind, text) {
  scenario = kind;
  stage = 0;
  const count =
    (await state()).projects.find((p) => p.id === projectId).state.threads[threadId]?.turns
      ?.length ?? 0;
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-input").press("Enter");
  const turn = await until(async () => {
    if (evidence.modelError) throw new Error(evidence.modelError);
    const allow = page
      .getByRole("button", { name: "允许一次", exact: true })
      .and(page.locator(":enabled"));
    if (await allow.isVisible()) {
      await allow.click();
      evidence.guiApprovals = (evidence.guiApprovals ?? 0) + 1;
    }
    const t = (await state()).projects.find((p) => p.id === projectId).state.threads[threadId];
    const v = t?.turns?.at(-1);
    return t.turns.length > count && ["completed", "failed"].includes(v.status) ? v : null;
  }, kind);
  evidence.turns.push({ scenario: kind, turn });
  assert.equal(turn.status, "completed", JSON.stringify(turn.error));
  return readTurnToolDetails({
    command,
    readThread: async () =>
      (await state()).projects.find((project) => project.id === projectId).state.threads[threadId],
    projectId,
    threadId,
    turnId: turn.id,
  });
}
function calls(turn) {
  return turn.items.filter((i) => i.type === "dynamicToolCall");
}
function success(turn) {
  for (const call of calls(turn))
    assert.equal(
      call.success,
      true,
      `${call.arguments.operation}: ${JSON.stringify(call.contentItems)}`,
    );
}
async function native() {
  return app.evaluate(({ webContents }, origin) => {
    const c = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin));
    return c ? { id: c.id, url: c.getURL(), title: c.getTitle() } : null;
  }, new URL(searchUrl).origin);
}
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  await checkBrowserStartup(app, { binary: env.AREAL_CORE_BIN, userHome, scratch });
  await app.evaluate(({ app }) => {
    globalThis.__googleNativeEvents = [];
    app.on("web-contents-created", (_event, c) => {
      for (const name of ["did-start-navigation", "did-fail-load", "render-process-gone"])
        c.on(name, (_event, ...args) =>
          globalThis.__googleNativeEvents.push({
            name,
            id: c.id,
            args: args.slice(0, 5),
            at: Date.now(),
          }),
        );
      c.debugger.on("detach", (_event, reason) =>
        globalThis.__googleNativeEvents.push({
          name: "debugger-detach",
          id: c.id,
          reason,
          at: Date.now(),
        }),
      );
    });
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) =>
      args.at(-1)?.title === "允许本地开发站点" ? { response: 1 } : original(...args);
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(
    async () => (await state()).projects.find((p) => p.root === workspace),
    "project ready",
  );
  projectId = project.id;
  const created = await command("create", {
    projectId,
    browserEnabled: true,
    profile: { id: "fixture", revision: "v1" },
  });
  threadId = created.threadId;
  await selectConversation(page, threadId);
  const chatBefore = await run("chat-before", "1");
  assert.equal(calls(chatBefore).length, 0);
  assert.equal(chatBefore.items.filter((item) => item.type === "agentMessage").at(-1)?.text, "1");
  assert.equal(evidence.guiApprovals ?? 0, 0);
  success(await run("open", "打开 Google，并确认搜索框可读取。"));
  oldObservation = observation;
  assert.equal(new URL(observation.url).origin, new URL(searchUrl).origin);
  searchRef(observation);
  const approvalsBeforeChat = evidence.guiApprovals;
  const chatAfter = await run("chat-after", "谢谢");
  assert.equal(calls(chatAfter).length, 0);
  assert.equal(
    chatAfter.items.filter((item) => item.type === "agentMessage").at(-1)?.text,
    "不客气",
  );
  assert.equal(evidence.guiApprovals, approvalsBeforeChat);
  const old = await run("old", "检查上一轮旧 refs 是否会被拒绝。");
  assert.equal(calls(old)[0].success, false);
  assert.match(JSON.stringify(calls(old)), /stale_ref/);
  success(await run("search", "使用内置浏览器的 Google 搜索 AI Agent，并读取结果。"));
  if (observation.url.includes("/sorry/") && process.env.AREAL_GOOGLE_MANUAL_CAPTCHA === "1") {
    evidence.captcha = { url: observation.url, status: "requires_human" };
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "takeover", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      const w = BrowserWindow.getAllWindows()[0];
      w.setTitle("AReaL Harness · Google 验收");
      w.focus();
    });
    console.log(JSON.stringify({ status: "captcha_requires_human", evidence: scratch }));
    await until(
      async () => {
        const n = await native();
        return n && new URL(n.url).pathname === "/search";
      },
      "manual Google verification",
      300000,
    );
    evidence.captcha.status = "manually_completed";
    success(await run("read", "人工验证已完成，请重新授权并读取 Google 的 AI Agent 搜索结果。"));
  }
  assert.equal(new URL(observation.url).pathname, "/search");
  assert.match(observation.text, /AI Agent|AI agent/i);
  const resultLinks = observation.nodes.filter(
    (n) => n.role === "link" && n.name && /agent/i.test(n.name),
  );
  assert.ok(resultLinks.length >= 2, "at least two actual search result links are readable");
  evidence.resultLinks = resultLinks;
  evidence.native = await native();
  assert.equal(new URL(evidence.native.url).searchParams.get("q"), "AI Agent");
  // The same authoritative pages must be represented by top-level panel tabs.
  const tabs = page.getByRole("tablist", { name: "侧边面板标签", exact: true });
  await tabs.locator(`[data-side-pane-tab-id="browser:${pageId}"]`).waitFor();
  assert.equal(await page.getByRole("tablist", { name: "浏览页面", exact: true }).count(), 0);
  const originalPageId = pageId;
  await page.getByRole("button", { name: "打开侧边面板标签页", exact: true }).click();
  await page.getByRole("menuitem", { name: /^浏览器/ }).click();
  await until(
    async () => (await tabs.locator('[data-side-pane-tab-id^="browser:"]').count()) === 2,
    "two top-level browser tabs",
  );
  const secondId = await tabs
    .locator('[data-side-pane-tab-id^="browser:"]')
    .evaluateAll(
      (nodes, original) =>
        nodes
          .map((n) => n.getAttribute("data-side-pane-tab-id"))
          .find((id) => id !== `browser:${original}`),
      originalPageId,
    );
  await page.getByLabel("预览地址").fill(new URL("/two", searchUrl).href);
  await page.getByLabel("预览地址").press("Enter");
  await until(async () => {
    const value = await page.evaluate((q) => window.arealDesktop.preview(q), {
      operation: "state",
      projectId,
      threadId,
      pageId: secondId.slice(8),
    });
    return value.url === new URL("/two", searchUrl).href;
  }, "second tab navigates independently");
  await page.evaluate((q) => window.arealDesktop.preview(q), {
    operation: "selectPage",
    projectId,
    threadId,
    pageId: originalPageId,
  });
  await until(
    async () =>
      (await tabs
        .locator(`[data-side-pane-tab-id="browser:${originalPageId}"] [role="tab"]`)
        .getAttribute("aria-selected")) === "true",
    "Main-side selection is reflected in the unified strip",
  );
  await until(
    async () => (await page.getByLabel("预览地址").inputValue()).includes(new URL(searchUrl).host),
    "original address restored",
  );
  await page.getByRole("button", { name: "打开侧边面板标签页", exact: true }).click();
  await page.getByRole("menuitem", { name: /^终端/ }).click();
  await tabs.locator('[data-side-pane-tab-id^="terminal:"] [role="tab"]').waitFor();
  assert.equal(
    await page.locator(".preview-panel").count(),
    0,
    "browser view unmounts behind terminal",
  );
  await until(
    () =>
      app.evaluate(({ BrowserWindow }, origin) => {
        const views = BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
          view.webContents?.getURL().startsWith(origin),
        );
        return views.length >= 2 && views.every((view) => !view.getVisible());
      }, new URL(searchUrl).origin),
    "native views really hide behind terminal",
  );
  const terminalProcess = await until(async () => {
    const processes = await readProcesses({ operation: "processes" });
    const process = processes?.data?.at(-1);
    if (!process) return null;
    const output = await readProcesses({
      operation: "processOutput",
      id: process.id,
      maxBytes: 4096,
    });
    return output?.chunks?.length ? process : null;
  }, "terminal process and first shell output ready");
  await page.locator(".xterm-helper-textarea").pressSequentially("echo UNIFIED_TERMINAL_READY");
  await page.locator(".xterm-helper-textarea").press("Enter");
  await until(async () => {
    const output = await readProcesses({
      operation: "processOutput",
      id: terminalProcess.id,
      maxBytes: 4096,
    });
    return output?.chunks
      ?.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString())
      .join("")
      .includes("UNIFIED_TERMINAL_READY");
  }, "terminal remains interactive");
  await page.keyboard.press("Meta+p");
  await page.getByRole("treeitem", { name: /README.md/ }).click();
  await tabs.getByRole("tab", { name: "README.md", exact: true }).waitFor();
  await tabs.locator(`[data-side-pane-tab-id="browser:${originalPageId}"] [role="tab"]`).click();
  await page.getByLabel("预览地址").waitFor();
  // Closing an inactive browser tab releases that page, keeping the selected page.
  await tabs.locator(`[data-side-pane-tab-id="${secondId}"]`).hover();
  await tabs.locator(`[data-side-pane-tab-id="${secondId}"] button`).last().click();
  await until(
    async () => (await tabs.locator('[data-side-pane-tab-id^="browser:"]').count()) === 1,
    "sibling browser tab closed",
  );
  const kept = await page.evaluate((q) => window.arealDesktop.preview(q), {
    operation: "state",
    projectId,
    threadId,
    pageId: originalPageId,
  });
  assert.equal(kept.browser.pageId, originalPageId);
  assert.equal(new URL(kept.url).searchParams.get("q"), "AI Agent");
  evidence.unifiedTabs = { originalPageId, closedPageId: secondId.slice(8), terminalAndFile: true };
  evidence.unifiedTabs.native = await until(
    () =>
      app.evaluate(({ BrowserWindow }, id) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
          (view) => view.webContents?.id === id,
        );
        return view?.getVisible() ? { visible: true, bounds: view.getBounds() } : null;
      }, evidence.native.id),
    "original native view is shown on return",
  );
  const viewport = await page.locator(".preview-webview").boundingBox();
  for (const key of ["x", "y", "width", "height"])
    assert.ok(
      Math.abs(evidence.unifiedTabs.native.bounds[key] - viewport[key]) <= 1,
      `native ${key} aligns with the Panel viewport`,
    );
  await page.screenshot({ path: join(scratch, "gui-results.png") });
  const png = await app.evaluate(
    async ({ webContents }, id) =>
      (await webContents.fromId(id).capturePage()).toPNG().toString("base64"),
    evidence.native.id,
  );
  await writeFile(join(scratch, "native-results.png"), Buffer.from(png, "base64"));
  // Force a real same-document update while the native AX read is pending.
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id),
      original = c.debugger.sendCommand.bind(c.debugger);
    c.debugger.sendCommand = async (method, ...args) => {
      if (method === "Accessibility.getFullAXTree") {
        c.debugger.sendCommand = original;
        await c.executeJavaScript('history.replaceState(history.state,"",location.href)');
        await new Promise((r) => setTimeout(r, 100));
      }
      return original(method, ...args);
    };
  }, evidence.native.id);
  const changed = await run("change", "读取正在更新的页面。");
  assert.equal(calls(changed)[0].success, false);
  assert.match(JSON.stringify(calls(changed)), /plan_stale/);
  assert.doesNotMatch(JSON.stringify(calls(changed)), /human_control/);
  const control = await page.evaluate(
    ({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: "state", projectId, threadId, pageId }),
    { projectId, threadId, pageId },
  );
  assert.equal(
    control.browser.control,
    "agent",
    "same-document invalidation preserves Agent authority",
  );
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id),
      original = c.debugger.sendCommand.bind(c.debugger);
    globalThis.__googleReadPending = false;
    c.debugger.sendCommand = async (method, ...args) => {
      if (method === "Accessibility.getFullAXTree") {
        c.debugger.sendCommand = original;
        globalThis.__googleReadPending = true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return original(method, ...args);
    };
  }, evidence.native.id);
  const taking = run("takeover", "读取时人工接管。");
  await until(() => app.evaluate(() => globalThis.__googleReadPending), "in-flight native read");
  await page.evaluate(
    ({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: "takeover", projectId, threadId, pageId }),
    { projectId, threadId, pageId },
  );
  const taken = await taking;
  assert.equal(calls(taken)[0].success, false);
  assert.match(JSON.stringify(calls(taken)), /human_control/);
  const human = await run("human", "检查人工接管后的拒绝。");
  assert.equal(calls(human)[0].success, false);
  assert.match(JSON.stringify(calls(human)), /host_unavailable|human_control/);
  const spawned = await run("spawn", "在新的独立浏览器页面中打开测试链接。");
  success(spawned);
  const createdPage = find(calls(spawned), (value) => !!value.createdPage)?.createdPage;
  assert.ok(createdPage?.pageId, "browser_v1 newPage returns a new authoritative identity");
  await tabs.locator(`[data-side-pane-tab-id="browser:${createdPage.pageId}"]`).waitFor();
  await tabs
    .locator(`[data-side-pane-tab-id="browser:${createdPage.pageId}"] [role="tab"]`)
    .click();
  const agentPage = await until(async () => {
    const value = await page.evaluate((q) => window.arealDesktop.preview(q), {
      operation: "state",
      projectId,
      threadId,
      pageId: createdPage.pageId,
    });
    return value.url === new URL("/agent", searchUrl).href ? value : null;
  }, "Agent page maps to its own top-level tab");
  assert.equal(agentPage.browser.control, "agent");
  evidence.unifiedTabs.agentCreatedPageId = createdPage.pageId;
  await page.screenshot({ path: join(scratch, "unified-tabs.png") });
  await tabs
    .locator(`[data-side-pane-tab-id="browser:${createdPage.pageId}"] button`)
    .last()
    .click();
  await until(
    async () => (await tabs.locator('[data-side-pane-tab-id^="browser:"]').count()) === 1,
    "active Agent tab closes independently",
  );
  await tabs.locator(`[data-side-pane-tab-id="browser:${originalPageId}"]`).hover();
  await tabs.locator(`[data-side-pane-tab-id="browser:${originalPageId}"] button`).last().click();
  await until(
    async () => (await tabs.locator('[data-side-pane-tab-id^="browser:"]').count()) === 0,
    "last page closes without a ghost browser tab",
  );
  assert.ok(await tabs.locator('[data-side-pane-tab-id^="terminal:"]').count());
  await tabs.getByRole("tab", { name: "README.md", exact: true }).waitFor();
  const otherThread = await command("create", {
    projectId,
    profile: { id: "fixture", revision: "v1" },
  });
  await selectConversation(page, otherThread.threadId);
  assert.equal(
    await page.locator('[data-side-pane-tab-id^="browser:"]').count(),
    0,
    "other conversation does not inherit browser tabs",
  );
  await selectConversation(page, threadId);
  assert.equal(
    await page.locator('[data-side-pane-tab-id^="browser:"]').count(),
    0,
    "closed pages do not resurrect on return",
  );
  assert.ok(
    evidence.requests.every((r) => r.guidance),
    "fresh-request guidance reaches each model request",
  );
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error.stack;
  if (page) await captureSmokeFailure(page, scratch, error);
  process.exitCode = 1;
} finally {
  if (site) {
    site.closeAllConnections();
    await new Promise((r) => site.close(r));
  }
  if (app) {
    evidence.nativeEvents = await app
      .evaluate(() => globalThis.__googleNativeEvents)
      .catch(() => []);
    await app.close();
  }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  evidence.sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  evidence.diffSHA256 = createHash("sha256")
    .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
    .digest("hex");
  evidence.coreBinarySHA256 = createHash("sha256")
    .update(await readFile(env.AREAL_CORE_BIN))
    .digest("hex");
  evidence.tabSourceSHA256 = Object.fromEntries(
    await Promise.all(
      [
        "renderer/src/App.tsx",
        "renderer/src/Preview.tsx",
        "renderer/src/app-shell/SidePane.tsx",
        "renderer/src/app-shell/SidePaneTabTrigger.tsx",
        "renderer/src/app-shell/useBrowserWorkspace.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(gui, file)))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({ status: evidence.status, evidence: scratch, error: evidence.error }),
  );
}
