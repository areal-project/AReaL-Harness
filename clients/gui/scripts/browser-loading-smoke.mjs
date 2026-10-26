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
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceExit } = require(
  join(gui, "app/src/core/service-client.cjs"),
);
const scratch = await makeTempDir("areal-browser-loading-");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
let pendingImage,
  app,
  page,
  projectId,
  threadId,
  pageId,
  observation,
  stage = 0;
const facts = {
  checks: [],
  errors: [],
  scope: "source Electron + Core + synthetic loading page + deterministic inference",
};
facts.source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  files: {},
};
for (const file of [
  "app/src/core/preview.cjs",
  "renderer/src/Preview.tsx",
  "scripts/browser-loading-smoke.mjs",
])
  facts.source.files[file] = createHash("sha256")
    .update(await readFile(join(gui, file)))
    .digest("hex");
const site = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/pending.png") {
    pendingImage = response;
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>${url.pathname === "/search" ? "Loading search results" : "Search fixture"}</title>
    <style>body{padding:32px;font:20px system-ui}</style>
    <form action="/search"><label>Search <input name="q" aria-label="Search"></label><button>Search</button></form>
    ${url.pathname === "/search" ? '<h1>Agent results available before load completes</h1><img src="/pending.png">' : ""}`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const searchUrl = `http://browser-synthetic.localhost:${site.address().port}/`;
const find = (value, predicate) => {
  if (typeof value === "string") {
    try {
      return find(JSON.parse(value), predicate);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  if (predicate(value)) return value;
  return (
    Object.values(value)
      .map((item) => find(item, predicate))
      .find(Boolean) ?? null
  );
};
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    const last = body.messages.at(-1),
      result = last?.role === "tool" ? last.content : null;
    const description = find(result, (value) => value.protocol === "areal.browser.host.v1");
    const observed = find(result, (value) => value.observationId && Array.isArray(value.nodes));
    if (description) pageId = description.pages[0];
    if (observed) observation = observed;
    const field = () => {
      const node = observation.nodes.find(
        (node) => /combobox|searchbox|textbox/i.test(node.role) && node.name === "Search",
      );
      assert.ok(node?.ref, "Search field has an observed ref");
      return node.ref;
    };
    const calls = [
      () => ({ operation: "describe", parameters: {} }),
      () => ({ operation: "navigate", parameters: { pageId, url: searchUrl } }),
      () => ({ operation: "observe", parameters: { pageId } }),
      () => ({
        operation: "act",
        parameters: {
          pageId,
          snapshotId: observation.observationId,
          action: { kind: "fill", ref: field(), value: "Agent" },
        },
      }),
      () => ({ operation: "observe", parameters: { pageId } }),
      () => ({
        operation: "act",
        parameters: {
          pageId,
          snapshotId: observation.observationId,
          action: { kind: "press", ref: field(), key: "Enter" },
        },
      }),
      () => ({ operation: "observe", parameters: { pageId } }),
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta =
      stage < calls.length
        ? {
            tool_calls: [
              {
                index: 0,
                id: `loading-${stage}`,
                type: "function",
                function: { name: "browser_v1", arguments: JSON.stringify(calls[stage]()) },
              },
            ],
          }
        : { content: "Loading page inspected." };
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: stage++ < calls.length ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    facts.modelError = error.stack;
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
        instructions: "Use the built-in browser for the requested search.",
      },
    ],
  }),
);
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_CORE_CONFIG: join(userHome, ".areal/config.toml"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: binary,
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "ELECTRON_RUN_AS_NODE",
])
  delete env[key];
const until = async (read, label, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const nativeFact = () =>
  app.evaluate(({ webContents }, origin) => {
    const c = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin));
    return c
      ? { id: c.id, url: c.getURL(), loading: c.isLoading(), mainLoading: c.isLoadingMainFrame() }
      : null;
  }, new URL(searchUrl).origin);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "Desktop ready");
  await app.evaluate(
    ({ dialog, BrowserWindow }, { workspace, module }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
      const original = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) =>
        args.at(-1)?.title === "允许本地开发站点" ? { response: 1 } : original(...args);
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1440, 960);
      window.show();
      globalThis.__loadingEvidence = [];
      const { PageControl } = process.getBuiltinModule("module").createRequire(module)(
        "./preview-native/control.cjs",
      );
      const { NativePageLifecycle } = process.getBuiltinModule("module").createRequire(module)(
        "./preview-native/lifecycle.cjs",
      );
      const revoke = PageControl.prototype.revoke;
      PageControl.prototype.revoke = function (page, options) {
        globalThis.__loadingEvidence.push({
          kind: "revoke",
          url: page.view?.webContents.getURL(),
          epoch: page.controlEpoch,
          stack: new Error().stack,
        });
        return revoke.call(this, page, options);
      };
      const create = NativePageLifecycle.prototype.create;
      NativePageLifecycle.prototype.create = function (...args) {
        globalThis.__loadingHost = this.workspace;
        const page = create.apply(this, args),
          c = page.view.webContents;
        for (const name of [
          "did-start-navigation",
          "did-navigate",
          "did-navigate-in-page",
          "did-finish-load",
        ])
          c.on(name, (_event, ...args) =>
            globalThis.__loadingEvidence.push({
              kind: name,
              args: args.slice(0, 4),
              epoch: page.controlEpoch,
            }),
          );
        const read = c.executeJavaScriptInIsolatedWorld.bind(c);
        c.executeJavaScriptInIsolatedWorld = async (...args) => {
          const event = {
            kind: "isolatedRead",
            start: Date.now(),
            loading: c.isLoading(),
            code: args[1]?.[0]?.code.slice(0, 90),
          };
          globalThis.__loadingEvidence.push(event);
          try {
            return await read(...args);
          } finally {
            event.end = Date.now();
          }
        };
        return page;
      };
    },
    { workspace, module: join(gui, "app/src/core/preview.cjs") },
  );
  await page.evaluate(() => window.arealDesktop.chooseProject());
  projectId = (
    await until(
      async () => (await state()).projects.find((project) => project.root === workspace),
      "Project ready",
    )
  ).id;
  const created = await page.evaluate(
    (projectId) =>
      window.arealDesktop.command("create", {
        projectId,
        browserEnabled: true,
        profile: { id: "fixture", revision: "v1" },
      }),
    projectId,
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  threadId = created.value.threadId;
  await selectConversation(page, threadId);
  await page.getByTestId("chat-input").fill("使用内置浏览器搜索 Agent，读取仍在加载的结果。");
  // 浏览器场景通过可见发送按钮进入；原生 Enter 与 IME 由 Composer 场景独立验收。
  await page.getByTestId("chat-send-button").click();
  facts.turn = await until(async () => {
    if (facts.modelError) throw new Error(facts.modelError);
    const allow = page
      .getByRole("button", { name: "允许一次", exact: true })
      .and(page.locator(":enabled"));
    if (await allow.isVisible()) await allow.click();
    const turn = (await state()).projects
      .find((project) => project.id === projectId)
      .state.threads[threadId]?.turns?.at(-1);
    return turn && ["completed", "failed"].includes(turn.status) && turn;
  }, "Search turn settles");
  facts.nativeBeforeAnnotation = await nativeFact();
  const finalRead = facts.turn.items.filter((item) => item.type === "dynamicToolCall").at(-1);
  facts.read = {
    success: finalRead.success,
    result: finalRead.contentItems,
    durationMs: finalRead.execution?.durationMs,
  };
  assert.equal(
    facts.nativeBeforeAnnotation.loading,
    true,
    "The subresource keeps the actual native document loading",
  );
  assert.equal(new URL(facts.nativeBeforeAnnotation.url).searchParams.get("q"), "Agent");
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await until(
    async () =>
      (await page.locator(".browser-region-annotation").count()) ||
      (await page.getByText(/页面截图已取消或超时/).count()),
    "Annotation settles",
    20000,
  );
  facts.nativeAfterAnnotation = await nativeFact();
  facts.annotationError = await page.getByText(/页面截图已取消或超时/).allTextContents();
  facts.nativeVisible = await app.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.find((view) => view.webContents?.id === id)
        ?.getVisible(),
    facts.nativeBeforeAnnotation.id,
  );
  await page.screenshot({ path: join(scratch, "annotation-result.png") });
  const errors = [];
  if (!facts.read.success)
    errors.push("Agent observe cannot read the committed document while a subresource is loading");
  else if (
    !JSON.stringify(facts.read.result).includes("Agent results available before load completes")
  )
    errors.push("Observe must return the committed search result content");
  if (facts.annotationError.length)
    errors.push(
      "Human annotation cannot capture the committed document while a subresource is loading",
    );
  if (!facts.nativeVisible && facts.annotationError.length)
    errors.push("An annotation failure hides the original native page");
  if (await page.locator(".browser-region-annotation").count())
    await page.getByRole("button", { name: "退出标注", exact: true }).click();
  pendingImage?.end();
  await page.getByLabel("预览地址").fill(searchUrl);
  await page.getByLabel("预览地址").press("Enter");
  await until(async () => (await nativeFact())?.url === searchUrl, "Return to loaded fixture");
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id),
      send = c.debugger.sendCommand.bind(c.debugger);
    const delay = (globalThis.__loadingDelay = { phase: "first" });
    c.debugger.sendCommand = async (method, parameters, ...rest) => {
      const result = await send(method, parameters, ...rest);
      if (method === "Runtime.evaluate" && parameters.expression.startsWith("({width:innerWidth")) {
        if (delay.phase === "first") {
          delay.phase = "firstHeld";
          return new Promise((resolve) => {
            delay.releaseFirst = () => resolve(result);
          });
        }
        if (delay.phase === "retry") {
          delay.phase = "retryHeld";
          return new Promise((resolve) => {
            delay.releaseRetry = () => resolve(result);
          });
        }
      }
      return result;
    };
    delay.restore = () => {
      c.debugger.sendCommand = send;
      delay.releaseFirst?.();
      delay.releaseRetry?.();
    };
  }, facts.nativeBeforeAnnotation.id);
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "页面截图已取消或超时" })
    .waitFor({ timeout: 15000 });
  facts.timeoutLocal = (await page.getByTestId("browser-load-error").count()) === 0;
  await app.evaluate(() => {
    globalThis.__loadingDelay.phase = "retry";
  });
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await until(
    () => app.evaluate(() => globalThis.__loadingDelay.phase === "retryHeld"),
    "Retry reaches an isolated read",
  );
  facts.retrySessionRetained = await app.evaluate(async ({ webContents }, id) => {
    globalThis.__loadingDelay.releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    const retained = webContents.fromId(id).debugger.isAttached();
    globalThis.__loadingDelay.releaseRetry();
    return retained;
  }, facts.nativeBeforeAnnotation.id);
  await page.locator(".browser-region-annotation").waitFor();
  await app.evaluate(() => globalThis.__loadingDelay.restore());
  if (!facts.timeoutLocal || !facts.retrySessionRetained)
    errors.push("A timed-out read must not release the debugger session borrowed by its retry");
  assert.equal(
    await page.getByText(/页面截图已取消或超时/).count(),
    0,
    "Retry clears the page-owned annotation error",
  );
  await page.getByRole("button", { name: "退出标注", exact: true }).click();
  await app.evaluate(
    (_electron, module) => {
      const { HumanPageCapture } = process.getBuiltinModule("module").createRequire(module)(
        "./preview-native/human-capture.cjs",
      );
      const captureRegion = HumanPageCapture.prototype.captureRegion;
      HumanPageCapture.prototype.captureRegion = async function () {
        HumanPageCapture.prototype.captureRegion = captureRegion;
        throw new Error("Fixture annotation capture refused");
      };
    },
    join(gui, "app/src/core/preview.cjs"),
  );
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.getByText(/Fixture annotation capture refused/).waitFor();
  facts.refusal = {
    fullPageError: await page.getByTestId("browser-load-error").count(),
    native: await nativeFact(),
    visible: await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.find((view) => view.webContents?.id === id)
          ?.getVisible(),
      facts.nativeBeforeAnnotation.id,
    ),
  };
  if (facts.refusal.fullPageError || !facts.refusal.visible)
    errors.push("A refused annotation must report a local error and preserve the native page");
  await page.screenshot({ path: join(scratch, "annotation-refusal.png") });
  const nativeImage = await app.evaluate(
    async ({ webContents }, id) =>
      (await webContents.fromId(id).capturePage()).toPNG().toString("base64"),
    facts.nativeBeforeAnnotation.id,
  );
  await writeFile(
    join(scratch, "annotation-refusal-native.png"),
    Buffer.from(nativeImage, "base64"),
  );
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.locator(".browser-region-annotation").waitFor();
  assert.equal(
    await page.getByText(/Fixture annotation capture refused/).count(),
    0,
    "Explicit retry clears the local annotation refusal",
  );
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id),
      send = c.debugger.sendCommand.bind(c.debugger);
    const cleanup = (globalThis.__loadingCleanup = {});
    c.debugger.sendCommand = async (method, parameters, ...rest) => {
      const result = await send(method, parameters, ...rest);
      if (
        !cleanup.held &&
        method === "Runtime.evaluate" &&
        parameters.expression.includes("globalThis.__arealCaptureGuardSequence = Math.max")
      ) {
        cleanup.held = true;
        return new Promise((resolve) => {
          cleanup.release = () => resolve(result);
        });
      }
      return result;
    };
    cleanup.restore = () => {
      c.debugger.sendCommand = send;
      cleanup.release?.();
    };
  }, facts.nativeBeforeAnnotation.id);
  await page.getByRole("button", { name: "退出标注", exact: true }).click();
  await page.locator(".browser-region-annotation").waitFor({ state: "detached" });
  assert.equal(
    await app.evaluate(() => globalThis.__loadingCleanup.held),
    true,
    "Annotation cleanup remains pending after its bounded caller settled",
  );
  await page.evaluate(
    (identity) => window.arealDesktop.preview({ operation: "claim", ...identity }),
    { projectId, threadId, pageId },
  );
  facts.cleanupClaim = await app.evaluate(
    async ({ webContents }, { id, identity }) => {
      const host = globalThis.__loadingHost;
      const before = host.page(identity.projectId, identity.threadId, identity.pageId).control;
      globalThis.__loadingCleanup.release();
      await new Promise((resolve) => setImmediate(resolve));
      return {
        before,
        after: host.page(identity.projectId, identity.threadId, identity.pageId).control,
        attached: webContents.fromId(id).debugger.isAttached(),
      };
    },
    { id: facts.nativeBeforeAnnotation.id, identity: { projectId, threadId, pageId } },
  );
  await app.evaluate(() => globalThis.__loadingCleanup.restore());
  if (
    facts.cleanupClaim.before !== "agent" ||
    facts.cleanupClaim.after !== "agent" ||
    !facts.cleanupClaim.attached
  )
    errors.push(
      "A completed annotation cleanup must not detach a session adopted by a new Agent claim",
    );
  await page.evaluate(
    (identity) => window.arealDesktop.preview({ operation: "takeover", ...identity }),
    { projectId, threadId, pageId },
  );
  facts.errors.push(...errors);
  assert.deepEqual(errors, []);
  facts.checks.push(
    "Agent observe and human annotation work while an unrelated subresource is pending",
  );
} catch (error) {
  facts.failure = error.stack;
  if (page) await captureSmokeFailure(page, scratch, error);
  process.exitCode = 1;
} finally {
  if (app)
    facts.nativeEvents = await app
      .evaluate(() => {
        globalThis.__loadingDelay?.restore();
        globalThis.__loadingCleanup?.restore();
        return globalThis.__loadingEvidence;
      })
      .catch(() => []);
  pendingImage?.end();
  const home = join(scratch, "core");
  const metadata = await readFile(join(home, "service.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      })
      .catch(() => {});
    await app.close();
  }
  if (metadata) {
    try {
      process.kill(metadata.pid, 0);
      const connection = new ServiceConnection();
      await connection.connect(metadata);
      try {
        await connection.request("hello", {
          protocol: metadata.protocol,
          identity: metadata.identity,
        });
        const resources = await connection.request("resources", { operation: "inspect" });
        assert.ok(
          resources.every(
            (project) =>
              !project.activeTurns && !project.unresolvedTools && !project.resources.length,
          ),
        );
        await connection.request(
          "stopService",
          { protocol: metadata.protocol, forUpdate: false },
          true,
        );
      } finally {
        connection.close();
      }
      await waitForServiceExit(home, metadata);
    } catch (error) {
      if (error.code !== "ESRCH") {
        facts.cleanupError = error.stack;
        process.exitCode = 1;
      }
    }
  }
  await assertApplicationStopped(binary, env, metadata);
  facts.cleanup = { pid: metadata?.pid, serviceExited: true };
  for (const server of [site, model]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await writeFile(join(scratch, "evidence.json"), JSON.stringify(facts, null, 2));
  console.log(
    JSON.stringify({
      passed: !process.exitCode,
      scratch,
      errors: facts.errors,
      failure: facts.failure,
      cleanup: facts.cleanup,
    }),
  );
}
