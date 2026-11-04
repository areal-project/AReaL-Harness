import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Real renderer in Chrome; controlled desktop snapshots keep startup pending
// until explicitly released. This does not claim Electron/Core acceptance.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const { checkHostPrerequisites } = require("./src/core/host-prerequisites.cjs");
const dist = process.env.AREAL_RENDERER_DIST || join(gui, "renderer/dist");
const scratch = await makeTempDir("areal-startup-connection-");
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("Invalid asset path");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      }[extname(path)] || "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser,
  passed = false;
const checks = [],
  errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const installFixture = () => {
    const project = {
      id: "startup-fixture",
      root: "/isolated/workspace",
      state: null,
      error: null,
      models: [{ modelId: "default", isDefault: true }],
      profiles: [],
      pending: [],
      summaries: [],
      configurations: {},
      outcomes: {},
      core: {},
    };
    const snapshot = {
      revision: 1,
      projects: [project],
      connection: { state: "ready" },
      library: { projects: {}, threads: {}, settings: {}, projectOrder: [] },
    };
    const cached = location.search.includes("cached");
    const light = location.search.includes("light");
    const vanished = location.search.includes("vanished");
    const deepLink = location.search.includes("deep-link");
    const appCatalog = [
      {
        serverId: "startup-app",
        pluginId: "startup-plugin",
        installedDigest: "startup-digest",
        generation: 1,
        capabilities: {},
        icons: null,
        instructions: null,
        protocolVersion: "2025-11-25",
        title: null,
        tools: [
          {
            name: "startup.open",
            toolName: "startup.open",
            title: "Startup queued app",
            inputSchema: { type: "object" },
            _meta: { "openai/ui": { entrypoints: [{ type: "global" }] } },
          },
        ],
      },
    ];
    let pendingLink = deepLink
      ? { id: 1, pluginId: "startup-plugin", toolName: "startup.open", path: "/startup-target" }
      : null;
    window.deepLinks = { subscriptions: 0, active: 0, delivered: 0, consumed: 0 };
    window.pendingDeepLink = () => pendingLink;
    const threadId = cached ? "saved-history" : "";
    let listener,
      projectionListener,
      sequence = 0,
      releaseSnapshot,
      releaseConnect,
      releaseOpen,
      releaseStop;
    let openPending = cached;
    if (cached) {
      project.state = {
        connected: true,
        threads: { [threadId]: { id: threadId, status: "idle", turns: [] } },
        queues: {},
        interactions: {},
      };
      project.summaries = [{ id: threadId, name: "Saved startup history", status: "idle" }];
    }
    if (vanished) snapshot.projects = [];
    let startupConnectPending = true;
    let pendingConnect;
    let stopOutcome = "cancel";
    const publish = () => {
      snapshot.revision++;
      listener(structuredClone(snapshot));
    };
    window.calls = [];
    window.presentations = [];
    window.initialGreeting = false;
    new MutationObserver(() => {
      if (
        !window.startupReleased &&
        document.querySelector('.draft-greeting, [data-testid="chat-input"]')
      )
        window.initialGreeting = true;
    }).observe(document, { childList: true, subtree: true });
    localStorage.setItem("areal-gui:project", project.id);
    localStorage.setItem(`areal-gui:thread:${project.id}`, threadId);
    localStorage.setItem(
      `areal-gui:draft:${project.id}:${threadId || "new"}`,
      "STARTUP_DRAFT_PRESERVED",
    );
    localStorage.setItem("areal-gui:sidebar-width", "384");
    localStorage.setItem("areal-gui:font-size", "15");
    window.finishDiscovery = () => {
      releaseSnapshot();
    };
    window.publishPartial = () => {
      snapshot.revision++;
      listener({
        ...structuredClone(snapshot),
        projects: [{ ...structuredClone(project), id: "partial-other-project" }],
        connection: { state: "connecting" },
      });
    };
    window.failStartup = () =>
      releaseConnect({ ok: false, error: { code: "READ_FAILED", message: "STARTUP_FAILURE" } });
    window.finishStartup = () => releaseConnect();
    window.finishOpen = (fail = false) => {
      if (fail) {
        releaseOpen({
          ok: false,
          error: { code: "READ_FAILED", message: "HELD_OPEN_FAILURE", recovery: { kind: "none" } },
        });
        return;
      }
      project.state.threads[threadId] = {
        id: threadId,
        status: "idle",
        turns: [
          {
            id: "restored-turn",
            status: "completed",
            items: [
              {
                id: "restored-message",
                type: "agentMessage",
                phase: "final_answer",
                text: "RESTORED_STARTUP_HISTORY",
              },
            ],
          },
        ],
      };
      openPending = false;
      publish();
      releaseOpen({ ok: true, value: {} });
    };
    window.updateProject = (state, error = null) => {
      project.state = state;
      project.error = error;
      snapshot.revision++;
      listener(structuredClone(snapshot));
    };
    window.updateBackend = ({
      connection = { state: "ready" },
      backendUpdate,
      currentCommands = true,
    }) => {
      snapshot.connection = connection;
      snapshot.backendUpdate = backendUpdate;
      snapshot.desktopCapabilities = project.desktopCapabilities = { currentCommands };
      publish();
    };
    window.setStopOutcome = (outcome) => {
      stopOutcome = outcome;
    };
    window.finishStop = () => releaseStop();
    window.arealDesktop = {
      setInterfaceLocale: () => {},
      onProjection: (callback) => {
        projectionListener = callback;
        listener = (value) =>
          callback({
            frame: {
              projection: 1,
              stream: "startup-fixture",
              sequence: ++sequence,
              kind: "full",
              snapshot: value,
            },
          });
        return () => {};
      },
      requestProjection: (requestId) => {
        releaseSnapshot = () =>
          projectionListener({
            requestId,
            frame: {
              projection: 1,
              stream: "startup-fixture",
              sequence: ++sequence,
              kind: "full",
              snapshot: structuredClone(snapshot),
            },
          });
      },
      theme: async () => ({ platform: "darwin", dark: !light, id: light ? "light" : "dark" }),
      onTheme: () => () => {},
      onUpdate: () => () => {},
      updateState: async () => ({ enabled: false, status: "idle" }),
      onMcpAppEvent: () => () => {},
      onMcpAppDeepLink: (callback) => {
        window.deepLinks.subscriptions++;
        window.deepLinks.active++;
        let active = true;
        if (pendingLink)
          void Promise.resolve()
            .then(async () => {
              if (!active || !pendingLink) return;
              window.deepLinks.delivered++;
              await callback(pendingLink);
              if (active) {
                pendingLink = null;
                window.deepLinks.consumed++;
              }
            })
            .catch(() => {});
        return () => {
          active = false;
          window.deepLinks.active--;
        };
      },
      mcpApp: async (request) => {
        window.calls.push({ name: "mcpApp", params: request });
        if (request.operation === "open")
          return {
            kind: "mcp",
            token: "startup-app-token",
            instanceId: "startup-app-instance",
            serverId: "startup-app",
            generation: 1,
            projectId: project.id,
            threadId: request.threadId,
            frameUrl: "about:blank",
            toolMetadata: { name: "startup.open", title: "Startup queued app" },
            initialArguments: {},
            hostContext: {},
          };
        return {};
      },
      presentReady: async () => {
        window.presentations.push({
          dark: document.documentElement.classList.contains("dark"),
          width: document.querySelector('[data-testid="areal-sidebar"]')?.getBoundingClientRect()
            .width,
        });
      },
      installCommandLineTools: async () => {
        window.calls.push({ name: "installCommandLineTools" });
        return { started: true };
      },
      chooseProject: async () => {
        window.calls.push({ name: "chooseProject" });
        return null;
      },
      preview: async () => ({}),
      onPreviewEvent: () => () => {},
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === "serviceLifecycle") {
          if (params.operation === "check")
            return window.arealDesktop.command("connectService", {});
          const result = await window.arealDesktop.command("stopService", {});
          if (result.ok && result.value.stopped)
            await window.arealDesktop.command("connectService", {});
          return result;
        }
        if (name === "stopService") {
          if (stopOutcome === "hold")
            return await new Promise((resolve) => {
              releaseStop = () => resolve({ ok: true, value: { stopped: false } });
            });
          if (stopOutcome === "refuse")
            return {
              ok: false,
              error: { code: "BUSY", message: "仍有其他窗口连接，无法更新后台。" },
            };
          if (stopOutcome === "unknown") {
            snapshot.connection = {
              state: "unavailable",
              recovery: "check",
              message: "停止结果尚未确认，请检查后台。",
            };
            publish();
            return {
              ok: false,
              error: {
                code: "UNKNOWN",
                message: "后台停止回执丢失，请检查后台状态。",
                submissionUnknown: true,
              },
            };
          }
          return { ok: true, value: { stopped: stopOutcome === "confirmed" } };
        }
        if (name === "connectService") {
          if (snapshot.connection.recovery === "check") return { ok: true, value: {} };
          snapshot.connection = { state: "ready" };
          delete snapshot.backendUpdate;
          snapshot.desktopCapabilities = project.desktopCapabilities = { currentCommands: true };
          publish();
          return { ok: true, value: {} };
        }
        if (name === "connect" && startupConnectPending) {
          pendingConnect ??= new Promise((resolve) => {
            releaseConnect = (result = { ok: true, value: {} }) => {
              startupConnectPending = false;
              resolve(result);
            };
          });
          return await pendingConnect;
        }
        if (name === "manage" && params.operation === "mcpApps")
          return {
            ok: true,
            value: { data: deepLink ? appCatalog : [], requestEpoch: "startup-fixture" },
          };
        if (name === "open" && openPending)
          return await new Promise((resolve) => {
            releaseOpen = resolve;
          });
        if (name === "serviceStatus")
          return {
            ok: true,
            value: {
              connected: true,
              clients: 1,
              activeCommands: 0,
              projects: [
                {
                  projectId: project.id,
                  root: project.root,
                  started: false,
                  activeThreads: [{ threadId, turnId: "service-active-turn" }],
                  goals: [{ threadId, status: "active", objective: "STARTUP_SERVICE_GOAL" }],
                  tasks: [
                    {
                      id: "service-task",
                      threadId,
                      mode: "schedule",
                      objective: "STARTUP_SERVICE_TASK",
                      paused: false,
                      running: false,
                    },
                  ],
                  queues: [{ threadId, paused: true, pending: 1, running: 0 }],
                  pendingRequests: [{ threadId, awaitingResponse: true }],
                  resources: [
                    {
                      id: "service-resource",
                      threadId,
                      executable: "STARTUP_SERVICE_RESOURCE",
                      state: "running",
                      stale: false,
                    },
                  ],
                },
              ],
            },
          };
        if (name === "workspace") return { ok: true, value: { git: true, branch: "main" } };
        if (name === "trajectory")
          return { ok: true, value: { enabled: false, state: "disabled", queue: {}, records: [] } };
        return { ok: true, value: { data: [] } };
      },
    };
  };
  const prerequisite = await checkHostPrerequisites({
    app: { isPackaged: false },
    platform: "darwin",
    execute: async () => {
      throw new Error("fixture missing developer tools");
    },
  }).then(
    () => null,
    (error) => error.prerequisite,
  );
  const prerequisitePage = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block",
  });
  try {
    prerequisitePage.on("pageerror", (error) => errors.push(error.message));
    await prerequisitePage.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await prerequisitePage.addInitScript(installFixture);
    await prerequisitePage.goto(origin);
    await prerequisitePage.waitForFunction(() => window.presentations.length === 1);
    await prerequisitePage.evaluate((prerequisite) => {
      window.updateBackend({
        connection: { state: "unavailable", prerequisite, message: prerequisite.detail },
      });
      window.finishDiscovery();
    }, prerequisite);
    const guide = prerequisitePage.getByTestId("host-prerequisite-guide");
    await guide.getByRole("alert").getByText(prerequisite.title).waitFor();
    await guide.getByText(prerequisite.detail, { exact: true }).waitFor();
    assert.deepEqual(
      await prerequisitePage.evaluate(() =>
        window.calls.filter((call) =>
          ["connectService", "installCommandLineTools", "connect", "send", "create"].includes(
            call.name,
          ),
        ),
      ),
      [],
    );
    await guide.getByRole("button", { name: prerequisite.installLabel, exact: true }).click();
    await guide.getByText(prerequisite.requestedMessage, { exact: true }).waitFor();
    assert.deepEqual(
      await prerequisitePage.evaluate(() =>
        window.calls
          .filter((call) => ["connectService", "installCommandLineTools"].includes(call.name))
          .map((call) => call.name),
      ),
      ["installCommandLineTools"],
    );
    await prerequisitePage.screenshot({
      path: join(scratch, "host-prerequisite-guide.png"),
      animations: "disabled",
    });
    await guide.getByRole("button", { name: prerequisite.retryLabel, exact: true }).click();
    await guide.waitFor({ state: "detached" });
    assert.equal(
      await prerequisitePage.evaluate(
        () => window.calls.filter((call) => call.name === "connectService").length,
      ),
      1,
    );
    assert.deepEqual(
      await prerequisitePage.evaluate(() =>
        window.calls.filter((call) => ["send", "create", "enqueue", "steer"].includes(call.name)),
      ),
      [],
    );
    checks.push(
      "missing macOS dependencies show guidance before startup, installation is explicit, and checking again retries once without submissions",
    );
  } finally {
    await prerequisitePage.close();
  }
  if (!process.argv.includes("--prerequisite-only")) {
    const regressionResults = await Promise.allSettled([
      (async () => {
        const target = await browser.newPage({
          viewport: { width: 1280, height: 960 },
          serviceWorkers: "block",
        });
        try {
          target.on("pageerror", (error) => errors.push(error.message));
          await target.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          await target.addInitScript(installFixture);
          await target.goto(`${origin}/?cached&vanished`);
          await target.waitForFunction(() => window.presentations.length === 1);
          await target.evaluate(() => window.publishPartial());
          await target.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.equal(
            await target.getByTestId("areal-workbench").getAttribute("data-startup-ready"),
            "false",
          );
          assert.equal(
            await target.getByTestId("areal-workbench").getAttribute("data-thread-id"),
            "saved-history",
          );
          assert.equal(
            await target.evaluate(() => localStorage.getItem("areal-gui:project")),
            "startup-fixture",
          );
          assert.deepEqual(
            await target.evaluate(() =>
              window.calls.filter((call) =>
                ["connect", "open", "create", "projectless"].includes(call.name),
              ),
            ),
            [],
          );
          await target.evaluate(() => {
            window.startupReleased = true;
            window.finishDiscovery();
          });
          await target.waitForFunction(
            () =>
              document
                .querySelector('[data-testid="areal-workbench"]')
                ?.getAttribute("data-startup-ready") === "true",
          );
          assert.equal(
            await target.getByTestId("areal-workbench").getAttribute("data-thread-id"),
            "",
            "authoritative empty discovery must clear the orphaned saved conversation",
          );
          await target.getByTestId("chat-input").waitFor();
          assert.equal(await target.evaluate(() => localStorage.getItem("areal-gui:project")), "");
          assert.deepEqual(
            await target.evaluate(() =>
              window.calls.filter((call) => ["connect", "open", "create"].includes(call.name)),
            ),
            [],
          );
          checks.push(
            "a vanished saved project preserves intent during partial discovery and settles into the empty workbench after authoritative discovery",
          );
          await target.screenshot({
            path: join(scratch, "vanished-project-settled.png"),
            animations: "disabled",
          });
        } finally {
          await target.close();
        }
      })(),
      (async () => {
        const target = await browser.newPage({
          viewport: { width: 1280, height: 960 },
          serviceWorkers: "block",
        });
        try {
          target.on("pageerror", (error) => errors.push(error.message));
          await target.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          await target.addInitScript(installFixture);
          await target.goto(`${origin}/?cached&deep-link`);
          await target.waitForFunction(() => window.presentations.length === 1);
          await target.evaluate(() => window.finishDiscovery());
          await target.waitForFunction(
            () =>
              window.calls.some((call) => call.name === "open") &&
              window.calls.some(
                (call) => call.name === "manage" && call.params.operation === "mcpApps",
              ),
          );
          await target.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.deepEqual(
            await target.evaluate(() => window.deepLinks),
            { subscriptions: 0, active: 0, delivered: 0, consumed: 0 },
            "the queued app link must stay in Main while the initial conversation is held",
          );
          assert.equal(
            await target.getByTestId("areal-workbench").getAttribute("data-thread-id"),
            "saved-history",
          );
          assert.deepEqual(
            await target.evaluate(() =>
              window.calls.filter((call) => call.name === "create" || call.name === "mcpApp"),
            ),
            [],
          );
          assert.ok(await target.evaluate(() => window.pendingDeepLink()));
          await target.evaluate(() => {
            window.startupReleased = true;
            window.finishOpen();
          });
          await target.waitForFunction(() => window.deepLinks.consumed === 1);
          assert.equal(
            await target.getByTestId("areal-workbench").getAttribute("data-thread-id"),
            "saved-history",
          );
          await target.getByRole("tab", { name: "Startup queued app" }).waitFor();
          assert.equal(await target.locator('iframe[title="Startup queued app"]').count(), 1);
          assert.deepEqual(
            await target.evaluate(() =>
              window.calls.filter((call) =>
                ["create", "send", "enqueue", "steer", "projectless"].includes(call.name),
              ),
            ),
            [],
          );
          assert.equal(
            await target.evaluate(() =>
              localStorage.getItem("areal-gui:draft:startup-fixture:saved-history"),
            ),
            "STARTUP_DRAFT_PRESERVED",
          );
          assert.deepEqual(
            await target.evaluate(() =>
              window.calls
                .filter((call) => call.name === "mcpApp" && call.params.operation === "open")
                .map((call) => ({
                  projectId: call.params.projectId,
                  threadId: call.params.threadId,
                  deepLink: call.params.deepLink,
                })),
            ),
            [
              {
                projectId: "startup-fixture",
                threadId: "saved-history",
                deepLink: "/startup-target",
              },
            ],
          );
          assert.deepEqual(
            await target.evaluate(() => ({
              delivered: window.deepLinks.delivered,
              consumed: window.deepLinks.consumed,
              pending: window.pendingDeepLink(),
            })),
            { delivered: 1, consumed: 1, pending: null },
          );
          checks.push(
            "a queued global app link opens exactly once in the restored conversation without creating a conversation or sending its draft",
          );
          await target.screenshot({
            path: join(scratch, "queued-app-after-release.png"),
            animations: "disabled",
          });
        } finally {
          await target.close();
        }
      })(),
    ]);
    assert.deepEqual(
      regressionResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason.stack || result.reason.message),
      [],
    );
    await page.addInitScript(installFixture);
    await page.goto(origin);
    const connectedState = {
      connected: true,
      threads: {},
      interactions: {},
      queues: {},
      error: null,
    };
    const writes = () =>
      page.evaluate(() =>
        window.calls.filter((call) =>
          [
            "send",
            "create",
            "enqueue",
            "steer",
            "projectless",
            "chooseProject",
            "browser",
            "terminal",
          ].includes(call.name),
        ),
      );
    async function assertShell(label, target = page, expectedDark = true) {
      await target.waitForFunction(() => window.presentations.length === 1);
      assert.equal(
        await target.getByTestId("areal-workbench").getAttribute("data-startup-ready"),
        "false",
      );
      assert.equal(
        await target.getByTestId("areal-workbench").getAttribute("data-shell-ready"),
        "true",
      );
      await target.getByTestId("startup-loading").waitFor();
      assert.equal(
        await target
          .getByTestId("startup-loading")
          .locator("img")
          .evaluate((image) => image.complete && image.naturalWidth > 0),
        true,
      );
      assert.equal(await target.getByTestId("startup-loading").innerText(), "正在加载…");
      assert.equal(await target.getByTestId("areal-sidebar").count(), 0);
      assert.equal(
        await target
          .locator(".workspace-header, .application-rail, .areal-update-floating")
          .count(),
        0,
      );
      assert.equal(await target.getByRole("button").count(), 0);
      assert.equal(await target.locator(".draft-greeting").count(), 0);
      assert.equal(
        await target.getByRole("alert").count(),
        0,
        "pending startup must not report a connection failure",
      );
      assert.equal(await target.getByTestId("chat-input").count(), 0);
      if (await target.locator(".header-task").count())
        assert.doesNotMatch(await target.locator(".header-task").innerText(), /新对话/);
      assert.deepEqual(await target.evaluate(() => window.presentations), [
        { dark: expectedDark, width: undefined },
      ]);
      assert.equal(
        await target.evaluate(() => localStorage.getItem("areal-gui:project")),
        "startup-fixture",
      );
      checks.push(label);
    }
    async function tryStartupRoutes(target = page) {
      for (const key of ["n", "t", "p", "k", ","])
        await target.evaluate(
          (key) =>
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }),
            ),
          key,
        );
      await target.evaluate(() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "`",
            code: "Backquote",
            ctrlKey: true,
            bubbles: true,
          }),
        ),
      );
      await target.evaluate(() => {
        for (const label of ["打开项目", "定时任务", "插件", "展开侧边面板", "设置"])
          document.querySelector(`[aria-label="${label}"]`)?.click();
      });
      await target.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(
        await target.getByTestId("areal-workbench").getAttribute("data-view"),
        "workspace",
      );
      assert.deepEqual(
        await target.evaluate(() =>
          window.calls.filter((call) =>
            [
              "send",
              "create",
              "enqueue",
              "steer",
              "projectless",
              "chooseProject",
              "browser",
              "terminal",
            ].includes(call.name),
          ),
        ),
        [],
      );
    }
    if (process.argv.includes("--backend-only")) {
      await page.waitForFunction(() => window.presentations.length === 1);
      await page.evaluate(() => {
        window.startupReleased = true;
        window.finishDiscovery();
      });
      await page.waitForFunction(() => window.calls.some((call) => call.name === "connect"));
      await page.evaluate((state) => {
        window.updateProject(state);
        window.finishStartup();
      }, connectedState);
      await page.getByTestId("chat-input").waitFor();
    } else {
      await assertShell(
        "the dark initial window shows only the app icon and loading before discovery",
      );
      await tryStartupRoutes();
      await page.evaluate(() => window.publishPartial());
      await assertShell("a partial discovery cannot replace or persist the remembered project");
      await page.screenshot({ path: join(scratch, "discovery-held.png"), animations: "disabled" });
      await page.evaluate(() => window.finishDiscovery());
      await page.waitForFunction(() => window.calls.some((call) => call.name === "connect"));
      await assertShell("project connection remains contained after authoritative discovery");
      await tryStartupRoutes();
      await page.evaluate(
        (state) => window.updateProject({ ...state, connected: false }),
        connectedState,
      );
      assert.equal(await page.getByTestId("chat-input").count(), 0);
      await page.evaluate(() => window.failStartup());
      await page.getByTestId("areal-sidebar").waitFor();
      await page.getByText("暂时无法加载对话，请重试或切换对话。", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("startup-loading").count(), 0);
      assert.equal(
        await page.getByTestId("areal-workbench").getAttribute("data-startup-ready"),
        "false",
      );
      assert.equal(await page.getByTestId("chat-input").count(), 0);
      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      await page.getByText("STARTUP_FAILURE", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("button", { name: "设置", exact: true }).isEnabled(), true);
      assert.deepEqual(await writes(), []);
      checks.push(
        "failed project observation keeps navigation and settings available without admitting a draft",
      );
      await page.screenshot({ path: join(scratch, "failure.png"), animations: "disabled" });
      await page.getByRole("button", { name: "重试加载对话", exact: true }).first().click();
      await page.evaluate((state) => {
        window.startupReleased = true;
        window.updateProject(state);
      }, connectedState);
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="chat-send-button"]')?.disabled &&
          !!document.querySelector('[data-testid="chat-send-button"]'),
      );
      await page.getByRole("group", { name: "工作区上下文", exact: true }).waitFor();
      await page.waitForFunction(() =>
        window.calls.some((call) => call.name === "workspace" && call.params.operation === "info"),
      );
      assert.match(await page.getByTestId("chat-input").innerText(), /STARTUP_DRAFT_PRESERVED/);
      assert.equal(await page.evaluate(() => window.initialGreeting), false);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("areal-gui:draft:startup-fixture:new")),
        "STARTUP_DRAFT_PRESERVED",
      );
      assert.deepEqual(await writes(), []);
      checks.push("recovery preserves the unsent draft without a startup greeting or preparation");
      await page.screenshot({ path: join(scratch, "ready.png"), animations: "disabled" });

      const delayedPage = await browser.newPage({
        viewport: { width: 1280, height: 960 },
        serviceWorkers: "block",
      });
      delayedPage.on("pageerror", (error) => errors.push(error.message));
      await delayedPage.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await delayedPage.clock.install();
      await delayedPage.addInitScript(installFixture);
      await delayedPage.goto(`${origin}/?cached`);
      await delayedPage.clock.runFor(100);
      await delayedPage.evaluate(() => window.finishDiscovery());
      await delayedPage.waitForFunction(() => window.calls.some((call) => call.name === "open"));
      await delayedPage.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await delayedPage.clock.pauseAt(
        new Date((await delayedPage.evaluate(() => Date.now())) + 50),
      );
      await delayedPage.clock.runFor(14000);
      assert.equal(await delayedPage.getByRole("button").count(), 0);
      await delayedPage.clock.runFor(1100);
      await delayedPage.getByText("加载时间较长，历史和草稿已保留。", { exact: true }).waitFor();
      assert.equal(await delayedPage.getByTestId("areal-sidebar").count(), 0);
      assert.equal(await delayedPage.getByTestId("chat-input").count(), 0);
      assert.equal(
        await delayedPage.getByRole("button", { name: "检查后台", exact: true }).isDisabled(),
        true,
      );
      await delayedPage.getByRole("button", { name: "检查设置", exact: true }).click();
      await delayedPage.getByRole("button", { name: "返回加载界面", exact: true }).waitFor();
      assert.equal(await delayedPage.getByTestId("areal-sidebar").count(), 0);
      assert.equal(await delayedPage.getByTestId("chat-input").count(), 0);
      const recoveryDrilldowns = delayedPage
        .getByTestId("service-project-startup-fixture")
        .getByRole("button");
      await recoveryDrilldowns.first().waitFor();
      assert.equal(await recoveryDrilldowns.count(), 6);
      for (const drilldown of await recoveryDrilldowns.all()) {
        assert.equal(
          await drilldown.isDisabled(),
          true,
          "recovery settings must not offer navigation before successful initial restoration",
        );
        await drilldown.evaluate((button) => button.click());
      }
      assert.equal(
        await delayedPage.getByTestId("areal-workbench").getAttribute("data-view"),
        "settings",
      );
      assert.equal(
        await delayedPage.getByRole("button", { name: "返回加载界面", exact: true }).count(),
        1,
      );
      assert.equal(
        await delayedPage.getByRole("button", { name: "刷新后台状态", exact: true }).isEnabled(),
        true,
      );
      await delayedPage.evaluate(() => {
        window.startupReleased = true;
        window.finishOpen();
      });
      await delayedPage.clock.resume();
      await delayedPage
        .getByRole("button", { name: "返回加载界面", exact: true })
        .waitFor({ state: "detached" });
      assert.equal(
        await delayedPage.evaluate(
          () => window.calls.filter((call) => call.name === "open").length,
        ),
        1,
      );
      for (const drilldown of await recoveryDrilldowns.all())
        assert.equal(await drilldown.isEnabled(), true);
      await delayedPage.getByTestId("service-active-saved-history").getByRole("button").click();
      await delayedPage.getByText("RESTORED_STARTUP_HISTORY", { exact: true }).waitFor();
      assert.equal(
        await delayedPage.getByTestId("areal-workbench").getAttribute("data-view"),
        "workspace",
      );
      assert.equal(
        await delayedPage.evaluate(
          () => window.calls.filter((call) => call.name === "open").length,
        ),
        2,
        "a deliberate drilldown observes history only after navigation is released",
      );
      assert.deepEqual(
        await delayedPage.evaluate(() =>
          window.calls.filter((call) => ["send", "create", "enqueue", "steer"].includes(call.name)),
        ),
        [],
      );
      checks.push(
        "a 15-second soft wait keeps recovery drilldowns disabled until late success, then enables deliberate navigation without replay",
      );
      await delayedPage.screenshot({
        path: join(scratch, "delayed-late-success.png"),
        animations: "disabled",
      });
      await delayedPage.close();

      const cachedPage = await browser.newPage({
        viewport: { width: 1280, height: 960 },
        serviceWorkers: "block",
      });
      cachedPage.on("pageerror", (error) => errors.push(error.message));
      await cachedPage.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await cachedPage.addInitScript(installFixture);
      await cachedPage.goto(`${origin}/?cached&light`);
      await assertShell(
        "the light initial window shows only the app icon and loading before history opens",
        cachedPage,
        false,
      );
      assert.equal(
        await cachedPage.getByTestId("areal-workbench").getAttribute("data-thread-id"),
        "saved-history",
      );
      await cachedPage.evaluate(() => window.finishDiscovery());
      await cachedPage.waitForFunction(() => window.calls.some((call) => call.name === "open"));
      await assertShell(
        "a cached empty thread stays contained while its authoritative open is held",
        cachedPage,
        false,
      );
      await cachedPage.screenshot({
        path: join(scratch, "loading-light.png"),
        animations: "disabled",
      });
      await tryStartupRoutes(cachedPage);
      await cachedPage.evaluate(() => window.finishOpen(true));
      await cachedPage.getByRole("alert").filter({ hasText: "暂时无法完成加载" }).waitFor();
      assert.equal(await cachedPage.getByTestId("areal-sidebar").count(), 0);
      await cachedPage.getByText("查看详情", { exact: true }).click();
      await cachedPage.getByText("HELD_OPEN_FAILURE", { exact: true }).waitFor();
      assert.equal(
        await cachedPage.getByTestId("chat-input").count(),
        0,
        "failed cached observation must not expose write controls",
      );
      const retry = cachedPage.getByRole("button", { name: "重试加载对话", exact: true });
      await retry.first().click();
      await cachedPage.waitForFunction(
        () => window.calls.filter((call) => call.name === "open").length === 2,
      );
      await cachedPage.evaluate(() => {
        window.startupReleased = true;
        window.finishOpen();
      });
      await cachedPage.getByText("RESTORED_STARTUP_HISTORY", { exact: true }).waitFor();
      assert.match(
        await cachedPage.getByTestId("chat-input").innerText(),
        /STARTUP_DRAFT_PRESERVED/,
      );
      assert.equal(await cachedPage.evaluate(() => window.initialGreeting), false);
      assert.equal(
        await cachedPage
          .getByTestId("areal-sidebar")
          .evaluate((element) => element.getBoundingClientRect().width),
        384,
      );
      assert.deepEqual(
        await cachedPage.evaluate(() =>
          window.calls.filter((call) =>
            [
              "send",
              "create",
              "enqueue",
              "steer",
              "projectless",
              "chooseProject",
              "browser",
              "terminal",
            ].includes(call.name),
          ),
        ),
        [],
      );
      checks.push(
        "failed cached observation stays visible, retries, and restores the saved thread and draft",
      );
      await cachedPage.screenshot({
        path: join(scratch, "cached-restored-light.png"),
        animations: "disabled",
      });
      await cachedPage.evaluate(() =>
        window.updateBackend({ connection: { state: "connecting" } }),
      );
      assert.equal(
        await cachedPage.getByText("RESTORED_STARTUP_HISTORY", { exact: true }).count(),
        1,
      );
      assert.match(
        await cachedPage.getByTestId("chat-input").innerText(),
        /STARTUP_DRAFT_PRESERVED/,
      );
      assert.equal(await cachedPage.getByTestId("chat-send-button").isDisabled(), true);
      checks.push(
        "a subsequent global reconnect keeps the workbench and draft mounted while sending is blocked",
      );
      await cachedPage.close();
    }

    const setBackend = (state) => page.evaluate((value) => window.updateBackend(value), state);
    await setBackend({ currentCommands: false, backendUpdate: { state: "pending" } });
    assert.equal(await page.locator("#backend-status").count(), 0);
    assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
    assert.equal(await page.getByTestId("chat-input").getAttribute("contenteditable"), "true");
    await page.getByTestId("chat-input").fill("BACKEND_UPDATE_DRAFT_PRESERVED");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("button", { name: "打开高级诊断", exact: true }).click();
    const backendStatus = page.getByTestId("backend-service-status");
    const update = backendStatus.getByRole("button", { name: /^(更新后台…|正在更新…)$/ });
    const serviceCalls = () =>
      page.evaluate(() =>
        window.calls
          .filter((call) =>
            ["stopService", "connectService", "connect", "open"].includes(call.name),
          )
          .map((call) => call.name),
      );
    await update.waitFor();
    let before = await serviceCalls();
    await update.click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="backend-service-status"] button')?.disabled,
    );
    assert.deepEqual(await serviceCalls(), [...before, "stopService"]);
    checks.push(
      "backend lifecycle controls move to service settings and cancelled updates never connect",
    );

    await page.evaluate(() => window.setStopOutcome("hold"));
    before = await serviceCalls();
    await update.click();
    assert.equal(await update.isDisabled(), true);
    await update.evaluate((button) => {
      button.click();
      button.click();
    });
    assert.deepEqual(await serviceCalls(), [...before, "stopService"]);
    await page.evaluate(() => window.finishStop());
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="backend-service-status"] button')?.disabled,
    );
    checks.push("an update in flight disables its settings action and only stops once");

    await page.evaluate(() => window.setStopOutcome("refuse"));
    before = await serviceCalls();
    await update.click();
    await backendStatus.locator("summary").click();
    await backendStatus.getByText("仍有其他窗口连接，无法更新后台。", { exact: true }).waitFor();
    assert.deepEqual(await serviceCalls(), [...before, "stopService"]);
    checks.push("a refused update keeps its diagnostic in settings without connecting");

    await setBackend({ currentCommands: true, backendUpdate: { state: "pending" } });
    await backendStatus
      .getByText("已连接后台，更新可稍后应用。现有任务继续运行。", { exact: true })
      .waitFor();
    await setBackend({ currentCommands: true, backendUpdate: { state: "applying" } });
    await backendStatus.getByText("正在更新后台…", { exact: true }).waitFor();
    assert.equal(await update.isDisabled(), true);
    await setBackend({
      backendUpdate: { state: "failed", message: "新后台启动失败，请检查配置。" },
    });
    await backendStatus.locator("summary").click();
    await backendStatus.getByText("新后台启动失败，请检查配置。", { exact: true }).waitFor();
    checks.push("service settings retain compatible pending, applying, and failed update states");

    await setBackend({ currentCommands: false, backendUpdate: { state: "pending" } });
    await page.evaluate(() => window.setStopOutcome("unknown"));
    before = await serviceCalls();
    await update.click();
    const checkBackend = backendStatus.getByRole("button", { name: "检查后台", exact: true });
    await checkBackend.waitFor();
    assert.deepEqual(await serviceCalls(), [...before, "stopService"]);
    assert.equal(await update.count(), 0);
    await backendStatus.locator("summary").click();
    assert.match(await backendStatus.innerText(), /后台停止回执丢失/);
    await checkBackend.click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="backend-service-status"] button')?.disabled,
    );
    assert.deepEqual(await serviceCalls(), [...before, "stopService", "connectService"]);
    checks.push(
      "UNKNOWN remains authoritative after toast dismissal and settings only check through connectService",
    );

    await setBackend({ currentCommands: false, backendUpdate: { state: "pending" } });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="areal-workbench"]')
          ?.getAttribute("data-startup-ready") === "true",
    );
    await page.evaluate(() => window.setStopOutcome("confirmed"));
    before = await serviceCalls();
    await update.click();
    await backendStatus.waitFor({ state: "detached" });
    assert.deepEqual(await serviceCalls(), [...before, "stopService", "connectService"]);
    assert.deepEqual(
      await page.evaluate(() =>
        window.calls.filter((call) => ["send", "create", "enqueue", "steer"].includes(call.name)),
      ),
      [],
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("areal-gui:draft:startup-fixture:new")),
      "BACKEND_UPDATE_DRAFT_PRESERVED",
    );
    checks.push(
      "a confirmed settings update connects once without replay and preserves the unsent draft",
    );
    await setBackend({ connection: { state: "ready", message: "STALE_DEPLOYMENT_MESSAGE" } });
    assert.equal(await backendStatus.count(), 0);
    await page.screenshot({ path: join(scratch, "backend-current.png"), animations: "disabled" });
  }
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        scope: "built renderer in Chrome with controlled Desktop contract snapshots",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
