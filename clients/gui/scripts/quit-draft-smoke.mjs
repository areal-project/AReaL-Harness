import { readFixtureHost, settleFixtureHostAfterQuit } from "./application-cleanup.mjs";
import { until } from "./support/desktop-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { applicationFixture } from "./application-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(
  binary?.startsWith(join(root, ".local/dev-bin/")),
  "Use an existing private fixed Core build",
);
const scratch = await makeTempDir("areal-quit-draft-");
const user = join(scratch, "user");
const config = join(user, ".areal/config.toml");
const endpoint = "http://127.0.0.1:9/v1/chat/completions";
const application = await applicationFixture(gui, join(scratch, "app"));
await mkdir(dirname(config), { recursive: true });
await writeFile(
  config,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nname="Fixture"\nprotocol="chat-completions"\nendpoint="${endpoint}"\nmodels=[{id="fixture",enabled=true}]\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: user,
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "app/src/core/main.cjs",
  "app/src/core/preload.cjs",
  "renderer/src/App.tsx",
  "renderer/src/services.ts",
  "renderer/src/settings/UnsavedChanges.tsx",
  "scripts/quit-draft-smoke.mjs",
  "renderer/dist/index.html",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (file) => [file, sha(await readFile(join(gui, file)))])),
);
const coreHashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const checks = [],
  errors = [],
  processes = [],
  dialogs = [];
let app,
  page,
  guiProcess,
  passed = false,
  originalHost,
  cleanup;
const button = (name) => page.getByRole("button", { name, exact: true });
const guard = () => page.getByRole("dialog", { name: "供应商有未保存的修改", exact: true });
const hostIdentity = ({ hostId, generation, pid }) => ({ hostId, generation, pid });
const idle = async () => {
  const observer = new HostClient();
  try {
    await observer.connect(env.AREAL_HARNESS_SERVICE_HOME);
    assert.equal(observer.hostId, originalHost.hostId);
    assert.equal(observer.generation, originalHost.generation);
    await until(async () => {
      const activity = await observer.activity();
      return (
        activity.complete && activity.projects.every((p) => p.state === "observed" && p.idleAllowed)
      );
    }, "Host and Core are idle");
  } finally {
    observer.close();
  }
};
const quit = (label = "退出 AReaL Harness") =>
  app.evaluate(({ Menu }, label) => {
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(
      (item) => item.label === label,
    );
    if (!item) throw new Error(`Missing menu ${label}`);
    item.click();
  }, label);
const launch = async () => {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 60000,
  });
  guiProcess = app.process();
  processes.push(guiProcess);
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss().catch(() => {});
  });
  await page.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
    "GUI ready",
  );
  originalHost = await readFixtureHost(env);
  assert.ok(originalHost, "Host identity is required");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      return { response: options.message === "退出 AReaL Harness？" ? 1 : (options.cancelId ?? 0) };
    };
  });
  await button("设置").click();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  await page.locator(".provider-catalog-row").filter({ hasText: "Fixture" }).click();
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).waitFor();
  await idle();
};
const exited = async () => {
  await until(() => guiProcess.exitCode !== null, "GUI process exits after confirmation");
  app = null;
};
console.log("Quit draft evidence:", scratch);
try {
  await launch();
  const initialHost = hostIdentity(originalHost);
  const initialConfig = await readFile(config, "utf8");
  const name = page.getByRole("textbox", { name: "供应商名称", exact: true });
  await name.fill("Fixture edited");
  await quit();
  await guard().waitFor();
  await quit();
  assert.equal(await guard().count(), 1, "Repeated quit shares the pending confirmation");
  await guard().getByRole("button", { name: "继续编辑", exact: true }).click();
  await guard().waitFor({ state: "hidden" });
  assert.equal(app.process().exitCode, null);
  assert.equal(await name.inputValue(), "Fixture edited");
  assert.equal(
    (await page.evaluate(() => window.arealDesktop.snapshot())).connection.state,
    "ready",
  );
  assert.equal(await readFile(config, "utf8"), initialConfig);
  await name.fill("Fixture saved after cancel");
  await idle();
  await button("保存").click();
  await until(async () => await button("保存").isDisabled(), "save succeeds after cancel");
  assert.match(await readFile(config, "utf8"), /Fixture saved after cancel/);
  checks.push(
    "Cancel quit preserves the draft and Host connection; a subsequent save persists through Host",
  );

  await name.fill("Fixture save and quit");
  const stopAndQuit = page.evaluate(() =>
    window.arealDesktop.command("serviceLifecycle", { operation: "stopAndQuit" }),
  );
  await guard().waitFor();
  await guard().getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.arealDesktop.snapshot())).connection.state,
    "ready",
  );
  const stopResult = await stopAndQuit;
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.value?.canceled, true);
  assert.deepEqual(hostIdentity(await readFixtureHost(env)), initialHost);
  await idle();
  checks.push("cancel stop-and-quit leaves the original background available");

  await page.getByRole("textbox", { name: "Base URL", exact: true }).fill("invalid-url");
  await quit();
  await guard().waitFor();
  await guard().getByRole("button", { name: "保存并继续", exact: true }).click();
  await guard().getByRole("alert").waitFor();
  await until(
    async () => await guard().getByRole("button", { name: "保存并继续", exact: true }).isEnabled(),
    "failed save settles",
  );
  assert.equal(await guard().isVisible(), true);
  assert.equal(app.process().exitCode, null);
  await guard().getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("textbox", { name: "Base URL", exact: true }).fill(endpoint);
  await quit();
  await guard().waitFor();
  await page.screenshot({ path: join(scratch, "quit-confirmation.png") });
  await guard().getByRole("button", { name: "保存并继续", exact: true }).click();
  await exited();
  assert.match(await readFile(config, "utf8"), /Fixture save and quit/);
  checks.push(
    "save failure keeps the GUI usable; successful save-and-quit persists configuration and exits the GUI",
  );

  await launch();
  assert.equal(
    await page.getByRole("textbox", { name: "供应商名称", exact: true }).inputValue(),
    "Fixture save and quit",
  );
  const savedConfig = await readFile(config, "utf8");
  await page
    .getByRole("textbox", { name: "供应商名称", exact: true })
    .fill("Discard this quit draft");
  await until(() => button("保存").isEnabled(), "reopened provider draft is ready for navigation");
  await quit();
  await guard().waitFor();
  await guard().getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await exited();
  assert.equal(await readFile(config, "utf8"), savedConfig);
  checks.push("discard-and-quit exits the GUI without changing the saved configuration");
  assert.deepEqual(dialogs, [], "Approved quits must not reach a renderer beforeunload veto");
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack);
  if (page && app) {
    await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
    await writeFile(
      join(scratch, "failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
} finally {
  let host;
  try {
    host = originalHost ?? (await readFixtureHost(env));
  } catch (error) {
    errors.push("Host identity: " + error.message);
    passed = false;
  }
  if (app)
    await app.close().catch((error) => {
      errors.push("GUI cleanup: " + error.message);
      passed = false;
    });
  await application.close();
  try {
    await until(
      () => processes.every((child) => child.exitCode !== null || child.signalCode !== null),
      "owned GUI processes exit",
    );
    const receipt = await settleFixtureHostAfterQuit(binary, env, scratch, {
      host,
      pid: guiProcess?.pid,
    });
    cleanup = {
      host: host && hostIdentity(host),
      receipt: receipt?.requestId,
      backendExited: true,
    };
  } catch (error) {
    cleanup = { error: error.message };
    passed = false;
  }
  for (const [file, hash] of Object.entries(sourceHashes))
    assert.equal(sha(await readFile(join(gui, file))), hash, `Source changed during test: ${file}`);
  for (const [name, hash] of Object.entries(coreHashes))
    assert.equal(
      sha(await readFile(join(dirname(binary), name))),
      hash,
      `Core changed during test: ${name}`,
    );
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        dialogs,
        cleanup,
        processes: processes.map((process) => ({ pid: process.pid, exitCode: process.exitCode })),
        source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        diffSha256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
        sourceHashes,
        coreHashes,
        binary,
        scope:
          "isolated real Electron/Core; actual settings and confirmation UI; application-menu quit callback, no physical Command+Q; no remote model requests",
      },
      null,
      2,
    ),
  );
}
console.log(passed ? "PASS quit draft smoke" : "FAIL quit draft smoke", checks);
assert.ok(passed, JSON.stringify({ errors, cleanup }));
