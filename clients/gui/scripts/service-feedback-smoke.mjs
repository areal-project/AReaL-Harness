import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";

const gui = resolve(import.meta.dirname, "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { applicationFixture } = await import("./application-fixture.mjs");
const { createProjectConversation } = await import("./smoke-navigation.mjs");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const { DesktopLifecycle } = require("../app/src/core/lifecycle.cjs");
const execute = promisify(execFile);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../.local/dev-bin/areal");
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
await writeFile(
  join(scratch, "user/.areal/config.toml"),
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/v1/chat/completions"\n',
);
const rejectedWorkspace = join(scratch, "unavailable-project");
const fault = join(scratch, "reject-ensure");
const preparationGate = join(scratch, "hold-preparation");
await writeFile(preparationGate, "hold");
await mkdir(rejectedWorkspace);
const technicalError = "service socket path is too long; use a shorter AREAL_HARNESS_SERVICE_HOME";
const fixture = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
const coreProcess = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/core-process.cjs"))});
const execute = coreProcess.executeCore;
coreProcess.executeCore = (binary, args, options) => {
  if (args[0] === 'service' && args[1] === 'ensure' && args.includes(${JSON.stringify(rejectedWorkspace)})
    && require('node:fs').existsSync(${JSON.stringify(fault)})) {
    const error = Object.assign(new Error('Injected service failure before launch'), {
      stderr: JSON.stringify({ error: { code: 'localServiceError', message: ${JSON.stringify(technicalError)} } })
    });
    return Object.assign(Promise.reject(error), { child: {} });
  }
  return execute(binary, args, options);
};
const { CoreBackend } = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"))});
const startProject = CoreBackend.prototype.startProject;
CoreBackend.prototype.startProject = async function (...args) {
  while (require('node:fs').existsSync(${JSON.stringify(preparationGate)})) await new Promise(resolve => setTimeout(resolve, 25));
  return startProject.apply(this, args);
};
`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: home,
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: registry,
});
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
  await initialInput.focus();
  await page.keyboard.type("Draft during workspace preparation");
  assert.equal(await initialInput.getAttribute("contenteditable"), "true");
  assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
  const preparingText = await page.locator("body").innerText();
  assert.ok(!preparingText.includes("权限模式不受支持") && !preparingText.includes("暂无可用模型"));
  await page.screenshot({ path: join(scratch, "initial-preparation.png"), scale: "css" });
  await unlink(preparationGate);
  const preparedDeadline = Date.now() + 30000;
  let prepared;
  while (Date.now() < preparedDeadline) {
    prepared = (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
      (p) => p.projectless && p.state?.connected,
    );
    if (prepared) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(prepared, "The existing automatic preparation finishes without a user retry");
  assert.equal(await initialInput.textContent(), "Draft during workspace preparation");
  await initialInput.press("Meta+A");
  await initialInput.press("Backspace");
  checks.push(
    "Initial workspace preparation is automatic, keeps writing available and preserves the draft",
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.waitForFunction(async () => {
    const s = await window.arealDesktop.snapshot();
    return s.connection?.state === "ready" || s.projects.some((p) => p.error || p.state?.error);
  });
  const startup = await page.evaluate(() => window.arealDesktop.snapshot());
  const startupError = startup.projects.find((p) => p.error || p.state?.error);
  assert.ok(!startupError, startupError?.error || startupError?.state?.error);
  await page.getByRole("button", { name: "打开项目", exact: true }).first().click();
  let snapshot, project;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(() => window.arealDesktop.snapshot());
    project = snapshot.projects.find((p) => p.root === workspace);
    if (project && (project.state?.connected || project.error || project.state?.error)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(join(scratch, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  await page.screenshot({ path: join(scratch, "project.png"), scale: "css" });
  assert.ok(
    project?.state?.connected,
    project?.error || project?.state?.error || "Project must connect with a long service home",
  );
  checks.push("Long service home opens a connected project through the directory picker");
  await writeFile(fault, "reject");
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, rejectedWorkspace);
  await page.getByRole("button", { name: "打开项目", exact: true }).first().click();
  const failedProject = page.getByRole("button", { name: "unavailable-project", exact: true });
  await failedProject.waitFor();
  await createProjectConversation(page, "unavailable-project");
  const status = page.getByTestId("toast").filter({ hasText: "连接暂不可用" });
  await status.waitFor();
  await status.hover();
  const visibleText = await page.locator("body").innerText();
  assert.ok(
    !visibleText.includes(technicalError),
    "Raw transport diagnostics must stay out of the writing flow",
  );
  assert.ok(!visibleText.includes("Error invoking remote method"));
  assert.ok(!visibleText.includes("当前任务配置不可用"));
  assert.ok(!visibleText.includes("权限模式不受支持"), "Unloaded capability is not unsupported");
  assert.ok(!visibleText.includes("暂无可用模型"), "Unloaded catalog is not an empty catalog");
  const offlineInput = page.getByTestId("chat-input");
  await offlineInput.focus();
  await page.keyboard.type("Draft while preparing");
  assert.equal(await offlineInput.getAttribute("contenteditable"), "true");
  assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
  await offlineInput.press("Enter");
  assert.equal(
    await offlineInput.textContent(),
    "Draft while preparing",
    "Enter neither submits nor clears the offline draft",
  );
  await page.screenshot({ path: join(scratch, "quiet-project-status.png"), scale: "css" });
  await status.getByRole("button", { name: "查看详情", exact: true }).click();
  assert.ok((await page.locator("body").innerText()).includes(technicalError));
  await page.screenshot({ path: join(scratch, "project-status-details.png"), scale: "css" });
  await status.getByRole("button", { name: "查看详情", exact: true }).click();
  await status.getByRole("button", { name: "重新连接项目", exact: true }).click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[data-testid="toast"] button')].find(
      (value) => value.textContent === "重新连接项目",
    );
    return button && !button.disabled;
  });
  checks.push("Offline draft stays editable; top notification exposes details and retry");
  await unlink(fault);
  await status.getByRole("button", { name: "重新连接项目", exact: true }).click();
  const reconnectDeadline = Date.now() + 30000;
  let recovered;
  while (Date.now() < reconnectDeadline) {
    recovered = (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
      (p) => p.root === rejectedWorkspace,
    );
    if (recovered?.state?.connected) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    recovered?.state?.connected,
    "Explicit retry connects the project after the before-launch failure is removed",
  );
  assert.equal(
    await offlineInput.textContent(),
    "Draft while preparing",
    "Connection recovery preserves the offline draft",
  );
  checks.push(
    "Explicit retry recovers the project through the real Core service and preserves the offline draft",
  );
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
  const operationNotice = page.getByTestId("toast");
  await operationNotice.filter({ hasText: "暂时无法完成操作" }).waitFor();
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
  const toast = page.getByTestId("toast");
  await toast.waitFor();
  assert.equal(await toast.getAttribute("role"), "status");
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
  await unlink(fault).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const metadata = await readFile(join(home, "service.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const connection = new ServiceConnection();
  try {
    if (metadata && alive(metadata.pid)) {
      try {
        await connection.connect(metadata);
        await connection.request("hello", {
          protocol: metadata.protocol,
          identity: metadata.identity,
        });
        await new DesktopLifecycle({
          connection,
          metadata,
          home,
          notify: async () => ({ response: 1 }),
        }).stop({ mode: "cancel" });
      } catch (error) {
        assert.ok(!alive(metadata.pid), error.message);
      }
    }
    const registrations = await readdir(join(registry, "services")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const id of registrations) {
      const record = await readFile(join(registry, "services", id, "service.json"), "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      if (!record) continue;
      assert.ok(record.dataDir.startsWith(home + "/"), "Cleanup only addresses this fixture data");
      const run = (args) =>
        execute(binary, ["service", ...args, "--instance", id, "--json"], {
          env,
          timeout: 30000,
        }).then(({ stdout }) => JSON.parse(stdout));
      if ((await run(["status"])).state !== "stopped") await run(["stop", "--cancel"]);
      assert.equal((await run(["status"])).state, "stopped");
    }
    checks.push("All fixture Core registrations are stopped after GUI exit");
  } catch (error) {
    errors.push("cleanup: " + error.message);
    passed = false;
    process.exitCode = 1;
  } finally {
    connection.close();
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
          "Source Electron/Main/Core, injected native picker and controlled CLI before-launch rejection for UI failure case, isolated state, no provider request",
      },
      null,
      2,
    ),
  );
  console.log(`${passed ? "PASS" : "FAIL"} service feedback`);
  console.log(JSON.stringify({ passed, evidence: scratch, errors }));
}
