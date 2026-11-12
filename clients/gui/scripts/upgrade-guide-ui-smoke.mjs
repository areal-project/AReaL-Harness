import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { findRelaunchedGui, readIsolatedDevTools } from "./upgrade-guide-relaunch.mjs";
import { cleanupSyntheticHostKeychain } from "./application-cleanup.mjs";

// A synthetic unreachable descriptor causes a real Host stop receipt. It is fault injection.
const root = await realpath(await trackedMkdtemp("/private/tmp/areal-upgrade-ui-"));
const require = createRequire(resolve("clients/gui/app/package.json"));
const dev = process.env.AREAL_UPGRADE_DEV === "1";
const app = dev ? resolve("clients/gui/app") : resolve(process.env.AREAL_UPGRADE_APP || "");
const executable = dev ? require("electron") : join(app, "Contents/MacOS/AReaL Harness GUI");
const binary = dev
  ? resolve("target/debug/areal")
  : join(app, "Contents/Resources/areal-core/bin/areal");
const oldBinary = resolve(process.env.AREAL_UPGRADE_OLD_CORE || "");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.match(process.env.AREAL_UPGRADE_CORE_SHA256 || "", /^[a-f0-9]{64}$/);
assert.match(process.env.AREAL_UPGRADE_OLD_CORE_SHA256 || "", /^[a-f0-9]{64}$/);
assert.equal(sha(await readFile(binary)), process.env.AREAL_UPGRADE_CORE_SHA256);
assert.equal(sha(await readFile(oldBinary)), process.env.AREAL_UPGRADE_OLD_CORE_SHA256);
const { HostClient } = require("@areal/client/node");
const { chromium } = require("playwright-core");
const run = promisify(execFile);
const oldHome = join(root, "old-host"),
  profile = join(root, "old-profile"),
  core = join(root, "old-core"),
  workspace = join(root, "old-workspace"),
  user = join(root, "user");
for (const dir of [oldHome, profile, core, workspace, user]) await mkdir(dir, { mode: 0o700 });
const put = (path, value) =>
  writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
await put(join(root, ".areal-test-space-root.json"), { version: 1, testOnly: true });
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("AREAL_") && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
const env = {
  ...inherited,
  AREAL_SPACES_TEST_ROOT: root,
  AREAL_GUI_USER_DATA: profile,
  AREAL_CORE_HOME: core,
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: oldHome,
  AREAL_HARNESS_SERVICE_HOME: oldHome,
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  ...(dev ? { AREAL_CORE_BIN: binary } : {}),
};
const result = {
  root,
  scope: `${dev ? "source Electron" : "packaged GUI"}; synthetic unreachable old service descriptor; real Host stop receipt`,
  checks: [],
  pids: {},
  cleanup: {},
};
const save = () => put(join(root, "result.json"), result);
const old = spawn(oldBinary, ["host", "run"], { env, stdio: "ignore" });
result.pids.oldHost = old.pid;
const host = new HostClient();
let first, next, browser, manifest;
let initialStderr = "";
result.modelRequests = [];
const model = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const title = messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content)?.includes("Generate a concise semantic session title"),
      );
      const prediction = messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content)?.includes("Predict the next user prompt"),
      );
      const conversation = messages.some((message) =>
        JSON.stringify(message.content)?.includes("Say the fixture marker."),
      );
      result.modelRequests.push({
        category: title
          ? "title"
          : prediction
            ? "prediction"
            : conversation
              ? "conversation"
              : "unknown",
        roles: messages.map((message) => message.role),
      });
    } catch {
      result.modelRequests.push({ category: "unknown", roles: [] });
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ISOLATED_UPGRADE_OK" }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const wait = async (fn, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (
      label === "native activation" &&
      first &&
      (first.exitCode !== null || first.signalCode !== null)
    )
      throw Error(
        `Initial GUI exited before activation: code=${first.exitCode} signal=${first.signalCode}`,
      );
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Timed out: ${label}`);
};
try {
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  await wait(async () => {
    await host.connect(oldHome);
    return true;
  }, "old Host");
  const id = sha(workspace).slice(0, 24),
    threadId = "66666666-6666-4666-8666-666666666666";
  const data = join(core, id, "state"),
    instance = sha(data).slice(0, 24),
    directory = join(oldHome, "services", instance);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await put(join(core, "projects.json"), [{ id, root: workspace, name: "Old fixture" }]);
  await put(join(core, "library.json"), {
    projects: { [id]: { navigationSummaries: [{ id: threadId, name: "Old fixture history" }] } },
  });
  const history = JSON.parse(
    await readFile(
      resolve(
        `clients/gui/scripts/fixtures/history-compat/111111111111111111111111/state/${threadId}.json`,
      ),
    ),
  );
  history.thread.cwd = workspace;
  await put(join(data, `${threadId}.json`), history);
  await put(join(data, "service-workspace"), JSON.stringify(workspace));
  for (const path of [
    join(data, "owner.lock"),
    join(data, "service.lock"),
    join(directory, "start.lock"),
  ])
    await put(path, "");
  await host.request("projects.register", {
    requestId: randomUUID(),
    expectedGeneration: host.generation,
    registration: {
      projectId: id,
      workspace,
      dataDir: data,
      source: { kind: "cli" },
      defaultBinding: true,
    },
  });
  await put(join(directory, "service.json"), {
    protocolVersion: 1,
    serviceId: instance,
    generation: randomUUID(),
    workspace,
    dataDir: data,
    configFingerprint: "synthetic-unreachable-owner",
    endpoint: "ws://127.0.0.1:1",
    webUrl: "http://127.0.0.1:1",
    authFile: join(directory, "absent-auth.json"),
    logFile: join(directory, "unused.log"),
    hostPid: 99999999,
    corePid: 99999998,
    state: "ready",
  });
  const stopId = randomUUID();
  result.originalStop = { requestId: stopId, state: "UNKNOWN" };
  await save();
  const receipt = await host.request("host.stop", {
    requestId: stopId,
    expectedGeneration: host.generation,
    strategy: "ifIdle",
  });
  result.originalStop = { requestId: stopId, state: receipt.state };
  assert.equal(receipt.state, "admissionUnknown");
  const originalDigest = sha(await readFile(join(oldHome, "host/stop.json")));
  const preflight = JSON.parse(
    (
      await run(
        binary,
        [
          "space",
          "preflight",
          "--source-profile",
          profile,
          "--source-core-home",
          core,
          "--source-host-home",
          oldHome,
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(preflight.kind, "upgradeRequired");
  result.checks.push("real-host-unknown-and-preflight");
  await save();
  const guiStartedAfter = Date.now() - 1000;
  first = spawn(executable, ["--remote-debugging-port=0", ...(dev ? [app] : [])], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  first.stderr.on("data", (chunk) => {
    initialStderr = (initialStderr + chunk.toString()).slice(-16384);
  });
  result.pids.initialGui = first.pid;
  await save();
  console.log(
    JSON.stringify({
      root,
      stage: "select-create-separate-space-in-native-prompt",
      pid: first.pid,
    }),
  );
  const active = await wait(
    async () => JSON.parse((await run(binary, ["space", "active"], { env })).stdout).spaceId,
    "native activation",
    120000,
  );
  manifest = JSON.parse(
    (await run(binary, ["space", "resolve", "--space-id", active], { env })).stdout,
  );
  const endpoint = await wait(
    () => readIsolatedDevTools({ root, profile: manifest.profile }),
    "isolated CDP",
  );
  browser = await chromium.connectOverCDP(endpoint);
  next = await wait(
    () =>
      findRelaunchedGui({
        root,
        profile: manifest.profile,
        browser,
        startedAfter: guiStartedAfter,
        packaged: !dev,
      }),
    "relaunched GUI",
  );
  result.pids.relaunchedGui = next.pid;
  result.appRunId = next.appRunId;
  await save();
  const page = await wait(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((item) => item.url().startsWith("areal-ui://")),
    "GUI page",
  );
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push({ name: error.name }));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push({ name: "console-error" });
  });
  try {
    await page.getByRole("dialog").getByRole("button", { name: "创建空工作区" }).click();
  } catch (error) {
    result.guideDiagnostic = await page.evaluate(async () => {
      const snapshot = await window.arealDesktop.snapshot();
      let recovery;
      try {
        const response = await window.arealDesktop.command("recovery", { operation: "inspect" });
        recovery = response.ok
          ? { ok: true, kind: response.value?.kind }
          : { ok: false, code: response.error?.code };
      } catch (failure) {
        recovery = { threw: true, code: failure?.code };
      }
      return {
        connectionState: snapshot.connection?.state,
        recovery,
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
        readyRetryVisible: document.body.innerText.includes("准备暂未完成"),
      };
    });
    result.guideDiagnostic.pageErrors = pageErrors;
    await save();
    throw error;
  }
  await page.getByText("空工作区已准备好。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "进入新版", exact: true }).click();
  await page.waitForFunction(async () => {
    const snapshot = await window.arealDesktop.snapshot();
    return snapshot.connection?.state === "ready";
  });
  await page.getByRole("button", { name: "查看旧历史", exact: true }).click();
  await page
    .getByRole("button", { name: "Old fixture · Old fixture history", exact: true })
    .click();
  await page.getByText("HISTORY_TERMINAL_INTERRUPTED", { exact: false }).waitFor();
  const historyPanel = page.locator('section[aria-label="查看旧历史"]');
  assert.equal(await historyPanel.locator('textarea, input, [contenteditable="true"]').count(), 0);
  assert.equal(await historyPanel.getByRole("button", { name: "发送", exact: true }).count(), 0);
  assert.equal(sha(await readFile(join(oldHome, "host/stop.json"))), originalDigest);
  result.checks.push("native-upgrade-guide-empty-workspace-and-readonly-history");
  await save();
  await page.keyboard.press("Escape");
  result.providerOperations = [];
  const providers = async (params) => {
    const attempt = {
      attemptId: randomUUID(),
      operation: params.operation,
      expectedRevision: params.expectedRevision,
      state: "UNKNOWN",
    };
    result.providerOperations.push(attempt);
    await save();
    let response;
    try {
      response = await page.evaluate(
        (request) => window.arealDesktop.command("providers", request),
        params,
      );
    } catch (error) {
      attempt.error = { message: error.message };
      await save();
      throw error;
    }
    if (!response.ok) {
      attempt.state =
        response.error?.submissionUnknown ||
        ["admitted", "unconfirmed"].includes(response.error?.outcome?.kind)
          ? "UNKNOWN"
          : "failed";
      attempt.error = response.error;
      await save();
      throw new Error(
        `providers ${params.operation} failed; original request will not be replayed`,
      );
    }
    attempt.state = "completed";
    attempt.revision = response.value.revision;
    attempt.pendingApply = response.value.pendingApply;
    attempt.application = response.value.application;
    await save();
    return response.value;
  };
  const before = await providers({ operation: "list" });
  assert.equal(typeof before.revision, "string");
  const saved = await providers({
    operation: "save",
    expectedRevision: before.revision,
    authentication: "none",
    provider: {
      name: "Isolated upgrade fixture",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      protocol: "chatCompletions",
      enabled: true,
      models: [{ id: "fixture", enabled: true }],
      parameters: {},
    },
  });
  const candidates = saved.data.filter((provider) => provider.name === "Isolated upgrade fixture");
  assert.equal(candidates.length, 1, "saved provider identity must be unique");
  const settleDeadline = Date.now() + 60000;
  let settled = saved;
  while (settled.pendingApply) {
    assert.ok(Date.now() < settleDeadline, "model configuration did not settle");
    await new Promise((done) => setTimeout(done, 100));
    settled = await providers({ operation: "list" });
    assert.equal(settled.revision, saved.revision, "model configuration revision changed");
    assert.notEqual(settled.application?.kind, "failed", "model configuration apply failed");
  }
  const selected = { providerId: candidates[0].id, modelId: "fixture" };
  const applied = await providers({
    operation: "defaultAndApply",
    expectedRevision: saved.revision,
    model: selected,
  });
  assert.deepEqual(applied.defaultModel, selected);
  assert.equal(applied.pendingApply, false, "model configuration not settled");
  result.checks.push("fixture-provider-configured-through-workbench");
  const newConversation = page.getByRole("button", { name: /在项目 .* 中新建对话/ });
  await newConversation
    .locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' project-row ')]",
    )
    .hover();
  await newConversation.click();
  await page.getByTestId("chat-input").fill("Say the fixture marker.");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByTestId("chat-view").getByText("ISOLATED_UPGRADE_OK", { exact: false }).waitFor();
  assert.equal(
    result.modelRequests.filter((request) => request.category === "conversation").length,
    1,
    "new session must use exactly one local fixture conversation request",
  );
  result.checks.push("new-workspace-session-local-model");
  await save();
} catch (error) {
  result.error = { message: error.message, code: error.code };
} finally {
  // Never infer ownership or reissue the old UNKNOWN stop. Preserve the fixture for reconciliation.
  if (browser)
    await browser.close().catch((error) => {
      result.cleanup.browserError = error.message;
    });
  if (next && alive(next.pid)) {
    console.log(JSON.stringify({ root, stage: "quit-isolated-gui-normally", pid: next.pid }));
    try {
      await wait(() => !alive(next.pid), "normal GUI exit", 120000);
      result.cleanup.gui = "exited";
    } catch {
      result.cleanup.gui = "UNKNOWN";
    }
  } else if (next) result.cleanup.gui = "exited";
  if (first && alive(first.pid)) {
    console.log(
      JSON.stringify({ root, stage: "quit-initial-isolated-gui-normally", pid: first.pid }),
    );
    try {
      await wait(() => !alive(first.pid), "initial GUI exit", 120000);
      result.cleanup.initialGui = "exited";
    } catch {
      result.cleanup.initialGui = "UNKNOWN";
    }
  } else if (first) result.cleanup.initialGui = "exited";
  if (manifest && result.cleanup.gui === "exited") {
    const isolated = new HostClient();
    try {
      await isolated.connect(manifest.hostHome);
      const identity = JSON.parse(
        await readFile(join(manifest.hostHome, "host/host.json"), "utf8"),
      );
      assert.equal(identity.generation, isolated.generation);
      result.pids.newHost = identity.pid;
      const requestId = randomUUID();
      result.cleanup.newStop = { requestId, state: "UNKNOWN" };
      await save();
      const stopped = await isolated.request("host.stop", {
        requestId,
        expectedGeneration: isolated.generation,
        strategy: "ifIdle",
      });
      result.cleanup.newStop = { requestId, state: stopped.state };
      if (stopped.state === "completed") {
        await wait(() => !alive(identity.pid), "new Host exit", 10000);
        result.cleanup.newHostExited = true;
        result.cleanup.keychain = await cleanupSyntheticHostKeychain(manifest.hostHome, root);
      }
    } catch (error) {
      result.cleanup.newError = error.message;
    } finally {
      isolated.close();
    }
  }
  host.close();
  if (old.exitCode === null && old.signalCode === null) old.kill("SIGTERM");
  if (old.exitCode === null && old.signalCode === null)
    await Promise.race([
      new Promise((done) => old.once("exit", done)),
      new Promise((done) => setTimeout(done, 5000)),
    ]);
  result.cleanup.oldHostExited = old.exitCode !== null || old.signalCode !== null;
  result.cleanup.oldKeychain = "preserved: original stop remains UNKNOWN";
  await put(join(root, "initial-gui.stderr"), initialStderr);
  await new Promise((done) => model.close(done));
  result.cleanup.state =
    result.cleanup.gui === "exited" &&
    result.cleanup.initialGui === "exited" &&
    result.cleanup.newStop?.state === "completed" &&
    result.cleanup.newHostExited &&
    result.cleanup.oldHostExited
      ? "completed"
      : "PENDING";
  await save();
  console.log(
    JSON.stringify({
      root,
      checks: result.checks,
      pids: result.pids,
      originalStop: result.originalStop,
      error: result.error,
      cleanup: result.cleanup,
    }),
  );
  if (result.error || result.cleanup.state !== "completed") process.exitCode = 1;
}
