import { installHostTransportBarrier } from "./support/host-transport-barrier.mjs";
import { until } from "./support/desktop-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const gui = resolve(import.meta.dirname, "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { applicationFixture } = await import("./application-fixture.mjs");
const { closeSmokeApplication, readFixtureHost, settleFixtureHostAfterQuit } =
  await import("./application-cleanup.mjs");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const scratch = await makeTempDir("areal-feedback-");
const home = join(scratch, "core"),
  workspace = join(scratch, "workspace");
const registry = join(
  scratch,
  "a-realistic-long-service-home-that-exceeds-the-unix-socket-budget",
  "registry",
);
await mkdir(workspace);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Respond to the isolated test only.",
      },
    ],
  }),
);
await writeFile(
  join(scratch, "user/.areal/config.toml"),
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/v1/chat/completions"\n',
);
const preparationGate = join(scratch, "hold-preparation");
const preparationObservation = join(scratch, "preparation-attempts.json");
await writeFile(preparationGate, "hold");
const technicalError = "Injected Host workspace preparation rejection";
const fixture = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
const fs = require('node:fs');
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const callHost = SharedCoreBackend.prototype.nativeBrowserCall;
const attempts = [];
SharedCoreBackend.prototype.nativeBrowserCall = async function (method, params) {
  if (method !== 'projectless.command' || params.operation !== 'prepare')
    return callHost.call(this, method, params);
  const observation = ${JSON.stringify(preparationObservation)};
  const gate = ${JSON.stringify(preparationGate)};
  const first = attempts.length === 0;
  attempts.push({ requestId: params.requestId, forwarded: !first });
  fs.writeFileSync(observation, JSON.stringify(attempts));
  if (!first) return callHost.call(this, method, params);
  while (fs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
  throw Object.assign(new Error(${JSON.stringify(technicalError)}), {
    code: 'COMMAND_FAILED',
    outcome: { kind: 'noMutation' },
    submissionUnknown: false,
  });
};
`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: join(scratch, "user"),
  AREAL_CORE_BIN: binary,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_CORE_CONFIG: join(scratch, "user/.areal/config.toml"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: home,
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: registry,
});
const execute = promisify(execFile);
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const readAttempts = () =>
  readFile(preparationObservation, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
const readyCore = async (workspace) => {
  const { stdout } = await execute(binary, ["service", "list", "--json"], { env, timeout: 5000 });
  return JSON.parse(stdout).find(
    (service) => service.workspace === workspace && service.state === "ready",
  );
};
let app,
  page,
  passed = false;
const checks = [],
  errors = [];
console.log("Evidence: " + scratch);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  const initialInput = page.getByTestId("chat-input");
  await initialInput.waitFor();
  const [original] = await until(async () => {
    const attempts = await readAttempts();
    return attempts.length === 1 && attempts;
  }, "Automatic preparation reached the native Host boundary");
  assert.ok(original.requestId);
  assert.equal(original.forwarded, false);
  await initialInput.fill("Draft during workspace preparation");
  assert.equal(await initialInput.getAttribute("contenteditable"), "true");
  assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
  const preparingText = await page.locator("body").innerText();
  assert.ok(!preparingText.includes("权限模式不受支持") && !preparingText.includes("暂无可用模型"));
  await page.screenshot({ path: join(scratch, "initial-preparation.png"), scale: "css" });
  await unlink(preparationGate);
  const status = page.getByTestId("workspace-preparation-status");
  const retry = status.getByRole("button", { name: "重试准备", exact: true });
  await retry.waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes(technicalError));
  assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
  await initialInput.press("Enter");
  assert.equal(await initialInput.textContent(), "Draft during workspace preparation");
  assert.deepEqual(await readAttempts(), [original]);
  await page.screenshot({ path: join(scratch, "quiet-project-status.png"), scale: "css" });
  await page.evaluate(installHostTransportBarrier);
  await page.evaluate((requestId) => {
    const attempts = [];
    globalThis.preparationRetries = attempts;
    globalThis.preparationRetryObserver = globalThis.createHostTransportBarrier((frame) => {
      if (
        frame.method !== "desktop.command" ||
        frame.params?.command !== "projectless" ||
        frame.params?.request?.operation !== "prepare" ||
        frame.params.request.requestId !== requestId
      )
        return null;
      const attempt = { id: frame.id };
      attempts.push(attempt);
      return {
        onResponse(reply) {
          attempt.replyId = reply.id;
          attempt.ok = !reply.error;
        },
      };
    });
  }, original.requestId);
  await retry.click();
  const prepared = await until(async () => {
    const project = (await state()).projects.find((p) => p.projectless);
    return project && (await readyCore(project.root));
  }, "Explicit retry prepares the original projectless workspace in Core");
  await status.waitFor({ state: "hidden" });
  assert.ok(prepared.generation);
  assert.deepEqual(await readAttempts(), [original]);
  const retries = await page.evaluate(() => {
    globalThis.preparationRetryObserver.restore();
    return globalThis.preparationRetries;
  });
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0], { id: retries[0].id, replyId: retries[0].id, ok: true });
  await writeFile(join(scratch, "preparation-retries.json"), JSON.stringify(retries));
  assert.equal(await initialInput.textContent(), "Draft during workspace preparation");
  checks.push(
    "Automatic preparation and a confirmed before-dispatch failure keep an editable, unsent draft; explicit retry forwards the original request once and Core is ready",
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.locator(".composer-project").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  const project = await until(async () => {
    const registered = (await state()).projects.find((p) => p.root === workspace);
    return registered && (await readyCore(workspace)) && registered;
  }, "Directory picker registers and activates the project with a long service home");
  await until(
    async () =>
      (await page.getByTestId("areal-workbench").getAttribute("data-project-id")) === project.id,
    "Named project selected",
  );
  await page.screenshot({ path: join(scratch, "project.png"), scale: "css" });
  checks.push("Long service home opens a connected project through the directory picker");
  const browserExplanation = page.getByRole("heading", { name: "浏览器", exact: true });
  await page.keyboard.press("Meta+t");
  await browserExplanation.waitFor();
  assert.equal(await page.getByTestId("toast").count(), 0);
  await page.screenshot({ path: join(scratch, "new-chat-browser-shortcut.png"), scale: "css" });
  const addTab = page.getByRole("button", { name: "打开侧边面板标签页", exact: true });
  await addTab.click();
  await page.getByRole("menuitem", { name: /浏览器/ }).click();
  await browserExplanation.waitFor();
  assert.equal(await page.getByTestId("toast").count(), 0);
  checks.push("New chat browser shortcut and menu show the local explanation without a top notice");
  await addTab.click();
  await page.getByRole("menuitem", { name: /审查/ }).click();
  await page.getByRole("button", { name: "改动范围" }).click();
  const lastTurn = page.getByRole("menuitem", { name: "上一轮", exact: true });
  await lastTurn.waitFor();
  assert.equal(await lastTurn.getAttribute("aria-disabled"), "true");
  await page.screenshot({ path: join(scratch, "new-chat-review-scope.png"), scale: "css" });
  await page.keyboard.press("Escape");
  checks.push("Review scope disables last turn when the conversation has no turn");
  const input = page.getByTestId("chat-input");
  await input.focus();
  await input.press("Meta+A");
  await input.press("Backspace");
  await page.keyboard.type("Draft retained after a failed action");
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    join(scratch, "missing-directory"),
  );
  await page.getByRole("button", { name: "打开项目", exact: true }).first().click();
  const operationNotice = page.getByTestId("toast").filter({ hasText: "暂时无法完成操作" });
  await operationNotice.waitFor();
  assert.equal(await operationNotice.count(), 1);
  assert.ok(!(await page.locator("body").innerText()).includes("Error invoking remote method"));
  assert.equal(await input.textContent(), "Draft retained after a failed action");
  await page.screenshot({ path: join(scratch, "friendly-action-error.png"), scale: "css" });
  await operationNotice.getByRole("button", { name: "查看详情", exact: true }).click();
  assert.ok((await page.locator("body").innerText()).includes("ENOENT"));
  await operationNotice.getByRole("button", { name: "关闭提示", exact: true }).click();
  await operationNotice.waitFor({ state: "hidden" });
  assert.equal(await input.textContent(), "Draft retained after a failed action");
  checks.push(
    "Header action feedback uses the same collapsed details and preserves the editable draft when dismissed",
  );
  const composerBounds = await input.boundingBox();
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent("areal:toast", { detail: "内容已复制" })),
  );
  const toast = page.getByTestId("toast").filter({ hasText: "内容已复制" });
  await toast.waitFor();
  await toast.getByRole("status").getByText("内容已复制", { exact: true }).waitFor();
  assert.equal(
    await operationNotice.count(),
    0,
    "Copy feedback does not create a persistent error card",
  );
  const toastBounds = await toast.boundingBox(),
    viewport =
      page.viewportSize() ||
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  assert.ok(Math.abs(toastBounds.x + toastBounds.width / 2 - viewport.width / 2) < 3);
  assert.deepEqual(
    await input.boundingBox(),
    composerBounds,
    "The toast does not shift the composer",
  );
  await page.screenshot({ path: join(scratch, "top-center-toast.png"), scale: "css" });
  await toast.waitFor({ state: "hidden", timeout: 6500 });
  assert.equal(await input.textContent(), "Draft retained after a failed action");
  checks.push(
    "Native Electron displays a top-center transient toast without a persistent card or composer movement",
  );
  passed = true;
} catch (error) {
  errors.push(error.message);
  process.exitCode = 1;
  if (page) {
    await writeFile(join(scratch, "failure.txt"), await page.locator("body").innerText()).catch(
      () => {},
    );
    await page.screenshot({ path: join(scratch, "failure.png"), scale: "css" }).catch(() => {});
  }
} finally {
  await unlink(preparationGate).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const guiPid = app?.process().pid;
  let originalHost;
  try {
    originalHost = await readFixtureHost(env);
  } catch (error) {
    errors.push("Host identity: " + error.message);
    passed = false;
    process.exitCode = 1;
  }
  if (app) {
    await closeSmokeApplication(app).catch((error) => {
      errors.push("Electron cleanup: " + error.message);
      passed = false;
      process.exitCode = 1;
    });
  }
  try {
    await settleFixtureHostAfterQuit(binary, env, scratch, { pid: guiPid, host: originalHost });
    checks.push("All fixture Core registrations are stopped after GUI exit");
  } catch (error) {
    errors.push("cleanup: " + error.message);
    passed = false;
    process.exitCode = 1;
  }
  await fixture.close();
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        binary,
        binarySHA256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceDiffSHA256: createHash("sha256")
          .update(execFileSync("git", ["diff", "--binary", "HEAD"]))
          .digest("hex"),
        rendererEntrySHA256: createHash("sha256")
          .update(await readFile(join(gui, "renderer/dist/index.html")))
          .digest("hex"),
        scriptSHA256: createHash("sha256")
          .update(await readFile(import.meta.filename))
          .digest("hex"),
        boundary:
          "Source Electron/Main/Core, injected native picker and controlled native Host before-dispatch rejection for UI failure case, isolated state, no provider request",
      },
      null,
      2,
    ),
  );
  console.log(`${passed ? "PASS" : "FAIL"} service feedback`);
  console.log(JSON.stringify({ passed, evidence: scratch, errors }));
}
