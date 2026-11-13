import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { assertApplicationStopped, cleanupSyntheticHostKeychain } from "./application-cleanup.mjs";

const root = await realpath(await trackedMkdtemp("/tmp/areal-web-partial-"));
const gui = resolve("clients/gui"),
  binary = resolve("target/debug/areal");
const expected = process.env.AREAL_PARTIAL_CORE_SHA256;
assert.match(expected || "", /^[a-f0-9]{64}$/);
const sha = (b) => createHash("sha256").update(b).digest("hex");
assert.equal(sha(await readFile(binary)), expected, "Core identity changed");
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("@areal/client/node");
const { GuiSourceAdapter } = require("@areal/workbench-service/desktop/core/gui-source.cjs");
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const { chromium } = require("playwright-core");
const persistedMode = process.argv.includes("--persisted");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
const home = join(root, "host"),
  user = join(root, "user"),
  config = join(root, "config.toml");
const safe = join(root, "safe-project"),
  blocked = join(root, "blocked-project");
for (const p of [home, user, safe, blocked, ...Object.values(source)])
  await mkdir(p, { mode: 0o700 });
const safeId = sha(safe).slice(0, 24),
  blockedId = sha(blocked).slice(0, 24);
for (const id of [safeId, blockedId])
  await mkdir(join(source.coreHome, id, "state"), { recursive: true, mode: 0o700 });
const marker = join(source.coreHome, blockedId, "state", "unconfirmed-owner-marker");
await writeFile(marker, "synthetic legacy state; no cleanup receipt\n", { mode: 0o600 });
await writeFile(
  join(source.coreHome, "projects.json"),
  JSON.stringify([
    { id: safeId, root: safe },
    { id: blockedId, root: blocked },
  ]),
  { mode: 0o600 },
);
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1"\n',
  { mode: 0o600 },
);
Object.assign(process.env, {
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_USER_HOME: user,
  AREAL_CORE_CONFIG: config,
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
});
const evidence = {
  root,
  scope: "synthetic partial GUI import, real Host and Web, no credentials or model requests",
  coreSha256: expected,
  checks: [],
  pids: {},
  wire: [],
  cleanup: {},
  error: null,
};
const save = () =>
  writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const client = new HostClient();
let browser, web, hostPid, backend, projects, backendOwner;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
try {
  await client.connectOrStart(home, binary);
  const descriptor = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  hostPid = descriptor.pid;
  evidence.pids.host = hostPid;
  const adapter = new GuiSourceAdapter({ source, hostHome: home, singletonHeld: true });
  const requestId = randomUUID();
  const result = await adapter.import(requestId, { publishOnly: true });
  await writeFile(join(root, "import-result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  assert.equal(result.sourcePublished, true);
  assert(
    result.blockers.some((x) => x.code === "legacyPending" && x.data?.projectId === blockedId),
  );
  const status = await client.request("gui.importStatus", { migrationId: result.migrationId });
  evidence.checks.push({
    stage: "partial-import",
    requestId,
    phase: result.phase,
    blocker: "legacyPending",
    statusPhase: status.phase,
  });
  const listing = await client.listProjects();
  const safeProject = listing.projects.find((p) => p.projectId === safeId);
  assert(safeProject, "safe project not published");
  let fixtureId;
  if (persistedMode) {
    const fixturePath = join(
      gui,
      "scripts/fixtures/history-compat/111111111111111111111111/state/66666666-6666-4666-8666-666666666666.json",
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.thread.cwd = safe;
    fixtureId = fixture.thread.id;
    await writeFile(
      join(source.coreHome, safeId, "state", `${fixtureId}.json`),
      JSON.stringify(fixture),
      { mode: 0o600 },
    );
  }
  projects = new GuiHostProjects({ binary, home, source, singletonHeld: true });
  await projects.init();
  const options = {
    binary,
    home: source.coreHome,
    guiProfile: source.profile,
    hostHome: home,
    harnessHome: source.legacyServiceHome,
    userHome: user,
    configHome: user,
    config,
  };
  backend = new SharedCoreBackend({
    ...options,
    app: { getPath: (name) => (name === "userData" ? source.profile : user) },
  });
  backendOwner = await client.request("backend.ensure", { profile: source.profile, options });
  evidence.pids.backend = backendOwner.pid;
  assert.equal(await backend.attach({ expectedIdentity: backendOwner.identity }), true);
  await backend.command("connect", { projectId: safeId });
  assert.equal(backend.value.projects.find((p) => p.id === safeId)?.state.connected, true);
  const created = persistedMode
    ? { threadId: fixtureId }
    : await backend.command("create", { projectId: safeId, requestId: randomUUID() });
  assert(created.threadId);
  if (!persistedMode)
    await backend.command("library", {
      projectId: safeId,
      threadId: created.threadId,
      operation: "renameThread",
      title: "Synthetic readable session",
    });
  evidence.checks.push({ stage: "safe-project-workbench-connected", backendPid: backendOwner.pid });
  let persistedDigest;
  if (persistedMode) {
    const project = backend.value.projects.find((p) => p.id === safeId);
    const generation = project?.core?.serviceGeneration;
    assert(generation, "running Core generation required");
    const stopRequestId = randomUUID();
    const stop = await client.stopProject(stopRequestId, safeId, generation, "ifIdle");
    assert.equal(stop.state, "completed");
    evidence.checks.push({
      stage: "project-stopped",
      requestId: stopRequestId,
      generation,
      state: stop.state,
    });
    persistedDigest = sha(
      await readFile(join(source.coreHome, safeId, "state", `${fixtureId}.json`)),
    );
  }
  const endpoint = JSON.parse(await readFile(join(home, "host/endpoint.json"), "utf8"));
  assert.equal(endpoint.hostId, client.hostId);
  assert.equal(endpoint.generation, client.generation);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  web = await browser.newPage();
  const wireRequests = new Map();
  web.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const p = JSON.parse(String(payload));
        if (
          [
            "hello",
            "shell.subscribe",
            "session.open",
            "session.openPersisted",
            "project.ensure",
          ].includes(p.method)
        ) {
          wireRequests.set(String(p.id), p.method);
          if (["session.open", "session.openPersisted", "project.ensure"].includes(p.method))
            evidence.wire.push({
              direction: "request",
              method: p.method,
              id: p.id,
              projectId: p.context?.projectId,
              serviceGeneration: p.context?.serviceGeneration,
            });
        }
      } catch {}
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const p = JSON.parse(String(payload)),
          method = wireRequests.get(String(p.id));
        if (!method) return;
        if (method === "hello")
          evidence.wire.push({
            direction: "response",
            method,
            id: p.id,
            hostId: p.result?.hostId,
            generation: p.result?.generation,
            connectionId: p.result?.connectionId,
            gatewayGeneration: p.result?.gatewayGeneration,
            errorCode: p.error?.code,
          });
        if (method === "shell.subscribe")
          evidence.wire.push({
            direction: "response",
            method,
            id: p.id,
            connectionId: p.result?.connectionId,
            gatewayGeneration: p.result?.gatewayGeneration,
            projects: (p.result?.snapshot?.projects ?? [])
              .filter((x) => [safeId, blockedId].includes(x.projectId))
              .map((x) => ({
                projectId: x.projectId,
                state: x.state,
                serviceGeneration: x.serviceGeneration,
                targetSummaryPresent: (x.summaries?.items ?? []).some(
                  (s) => s.id === created.threadId,
                ),
              })),
            errorCode: p.error?.code,
          });
        if (["session.open", "session.openPersisted", "project.ensure"].includes(method))
          evidence.wire.push({
            direction: "response",
            method,
            id: p.id,
            errorCode: p.error?.code ?? null,
            success: !!p.result,
            access: method === "session.openPersisted" ? p.result?.access : undefined,
          });
      } catch {}
    });
  });
  const pairing = web.waitForResponse(
    (r) => r.url().endsWith("/host/auth/challenge") && r.request().method() === "POST",
  );
  await web.goto(endpoint.origin);
  const challenge = await (await pairing).json();
  assert.equal(challenge.state, "pending");
  await client.request("web.approve", {
    requestId: challenge.requestId,
    expectedGeneration: client.generation,
    scopes: ["observe"],
  });
  await web.getByRole("button", { name: /检查批准状态|Check approval/i }).click();
  await web.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  const section = web.getByRole("button", { name: /项目分类|Project section/i });
  await section.waitFor();
  if ((await section.getAttribute("aria-expanded")) === "false") await section.click();
  await web.getByRole("button", { name: "safe-project", exact: true }).waitFor({ timeout: 30000 });
  await web
    .getByRole("button", { name: "blocked-project", exact: true })
    .waitFor({ timeout: 30000 });
  const safeButton = web.getByRole("button", { name: "safe-project", exact: true });
  if ((await safeButton.getAttribute("aria-expanded")) === "false") await safeButton.click();
  await web.getByTestId(`task-item-${created.threadId}`).click();
  await web.waitForFunction(
    (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
    created.threadId,
  );
  if (persistedMode) {
    await web
      .getByText("当前为只读历史，项目运行状态尚未恢复。", { exact: true })
      .waitFor({ timeout: 30000 });
    await web
      .getByText("HISTORY_TERMINAL_INTERRUPTED", { exact: false })
      .waitFor({ timeout: 30000 });
    assert.equal(
      await web
        .getByRole("button", { name: "发送", exact: true })
        .isEnabled()
        .catch(() => false),
      false,
    );
    assert.equal(
      sha(await readFile(join(source.coreHome, safeId, "state", `${fixtureId}.json`))),
      persistedDigest,
      "persisted Store changed while reading",
    );
    evidence.checks.push({ stage: "persisted-history-visible-and-send-unavailable" });
  }
  const wireDeadline = Date.now() + 15000;
  const matchingOpen = () => {
    const requests = evidence.wire.filter(
      (x) =>
        x.method === (persistedMode ? "session.openPersisted" : "session.open") &&
        x.direction === "request" &&
        x.projectId === safeId,
    );
    return requests.some((request) =>
      evidence.wire.some(
        (response) =>
          response.method === (persistedMode ? "session.openPersisted" : "session.open") &&
          response.direction === "response" &&
          response.id === request.id &&
          response.success &&
          (!persistedMode || response.access?.readOnly === true),
      ),
    );
  };
  while (!matchingOpen() && Date.now() < wireDeadline)
    await new Promise((resolve) => setTimeout(resolve, 30));
  evidence.checks.push({ stage: "safe-project-web-opened" });
  assert(
    evidence.wire.some(
      (x) =>
        x.method === "hello" &&
        x.direction === "response" &&
        x.hostId === client.hostId &&
        x.generation === client.generation &&
        x.connectionId,
    ),
  );
  assert(
    evidence.wire.some(
      (x) =>
        x.method === "shell.subscribe" &&
        x.direction === "response" &&
        x.projects?.some(
          (p) =>
            p.projectId === safeId &&
            (persistedMode ? p.state === "stopped" : p.state === "ready" && p.serviceGeneration),
        ),
    ),
  );
  assert(matchingOpen(), "the original safe-project session.open must succeed");
  await web.screenshot({ path: join(root, "web-projects.png") });
  await writeFile(join(root, "web-projects.aria"), await web.locator("body").ariaSnapshot(), {
    mode: 0o600,
  });
  const blockedSection = web.locator(`[data-sidebar-project="${blockedId}"]`);
  const blockedText = await blockedSection.innerText();
  assert.match(
    blockedText,
    /迁移|旧后台|待处理|受阻|migration|pending|blocked/i,
    "blocked project must clearly explain its state",
  );
  evidence.checks.push({
    stage: "web-both-projects-visible-and-blocker-explained",
    hostIdMatched: true,
  });
} catch (e) {
  evidence.error = { message: e.message, stack: e.stack };
  if (web) {
    await web.screenshot({ path: join(root, "web-failure.png") }).catch(() => {});
    await writeFile(
      join(root, "web-failure.aria"),
      await web
        .locator("body")
        .ariaSnapshot()
        .catch(() => ""),
      { mode: 0o600 },
    );
  }
} finally {
  if (web)
    evidence.webSelection = await web
      .evaluate(() => {
        const node = document.querySelector('[data-testid="areal-workbench"]');
        return {
          projectId: node?.getAttribute("data-project-id") ?? null,
          threadId: node?.getAttribute("data-thread-id") ?? null,
        };
      })
      .catch(() => null);
  if (browser) {
    try {
      await browser.close();
      evidence.cleanup.browser = "stopped";
    } catch (e) {
      evidence.cleanup.browser = e.message;
    }
  }
  try {
    if (client.generation) {
      const r = await client.stop(randomUUID(), client.generation, "ifIdle");
      evidence.cleanup.host = r.state;
      if (r.state === "completed") {
        for (let i = 0; i < 300 && alive(hostPid); i++)
          await new Promise((r) => setTimeout(r, 100));
        evidence.cleanup.hostPidExited = !alive(hostPid);
      }
    }
  } catch (e) {
    evidence.cleanup.hostError = e.message;
  } finally {
    client.close();
  }
  if (backend) {
    try {
      await Promise.race([
        backend.shutdown(),
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("backend shutdown timeout")), 10000),
        ),
      ]);
      evidence.cleanup.backend = "stopped";
    } catch (e) {
      evidence.cleanup.backend = e.message;
    }
  }
  projects?.close();
  if (evidence.cleanup.host === "completed" && evidence.cleanup.hostPidExited) {
    try {
      await assertApplicationStopped(binary, { ...process.env, HOME: user }, backendOwner);
      evidence.cleanup.inventory = "stopped";
      evidence.cleanup.keychain = await cleanupSyntheticHostKeychain(home, root);
    } catch (e) {
      evidence.cleanup.inventory = e.message;
    }
  }
  evidence.cleanup.markerUnchanged =
    (await readFile(marker, "utf8")) === "synthetic legacy state; no cleanup receipt\n";
  if (sha(await readFile(binary)) !== expected)
    evidence.error ??= { message: "Core changed during run" };
  if (
    !evidence.error &&
    (evidence.cleanup.browser !== "stopped" ||
      evidence.cleanup.backend !== "stopped" ||
      evidence.cleanup.host !== "completed" ||
      !evidence.cleanup.hostPidExited ||
      evidence.cleanup.inventory !== "stopped" ||
      !Array.isArray(evidence.cleanup.keychain) ||
      !evidence.cleanup.markerUnchanged)
  )
    evidence.error = { message: "cleanup incomplete" };
  await save();
  console.log(
    JSON.stringify({
      root,
      checks: evidence.checks,
      error: evidence.error?.message,
      cleanup: evidence.cleanup,
    }),
  );
}
if (evidence.error) process.exitCode = 1;
