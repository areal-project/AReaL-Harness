import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const {
  ServiceConnection,
  waitForServiceProcessExit,
} = require("../app/src/core/service-client.cjs");
const { DesktopLifecycle } = require("../app/src/core/lifecycle.cjs");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary?.startsWith(join(root, ".local/dev-bin/")), "use an explicit fixed Core slot");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = [
  "app/src/core/legacy-desktop-recovery.cjs",
  "app/src/core/local-service.cjs",
  "app/src/core/service-client.cjs",
  "app/src/core/main.cjs",
  "renderer/src/App.tsx",
  "renderer/src/BackendStatusNotice.tsx",
  "renderer/src/settings/ServiceStatusSettings.tsx",
  "renderer/src/services.ts",
  "packages/workbench/client/desktop-contract.cjs",
  "scripts/legacy-desktop-recovery-smoke.mjs",
  "renderer/dist/index.html",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(join(gui, path)))])),
);
const binaryHashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const scratch = await makeTempDir("ar-");
const home = join(scratch, "core"),
  registry = join(scratch, "registry"),
  userData = join(scratch, "electron");
const legacyRoot = join(scratch, "legacy"),
  archive = join(scratch, "legacy.tar");
await mkdir(legacyRoot);
await mkdir(home);
await mkdir(userData);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
const legacyRef = "d49d2398";
execFileSync(
  "git",
  ["archive", "--output", archive, legacyRef, "clients/gui/app", "clients/gui/packages/workbench"],
  { cwd: root },
);
execFileSync("tar", ["-xf", archive, "-C", legacyRoot]);
const legacyGui = join(legacyRoot, "clients/gui");
const modules = join(legacyGui, "app/node_modules");
await mkdir(join(modules, "@areal"), { recursive: true });
for (const name of await readdir(join(gui, "app/node_modules")))
  if (name !== "@areal") await symlink(join(gui, "app/node_modules", name), join(modules, name));
for (const name of await readdir(join(gui, "app/node_modules/@areal")))
  await symlink(
    name === "workbench"
      ? join(legacyGui, "packages/workbench")
      : join(gui, "app/node_modules/@areal", name),
    join(modules, "@areal", name),
  );
await symlink(join(gui, "renderer"), join(legacyGui, "renderer"));
// Model only: all GUI, Desktop, CLI, Host, Core, persistence and recovery are real.
const requests = [],
  errors = [],
  checks = [];
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "RECOVERY_HISTORY_PRESERVED" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const config = join(scratch, "config.toml");
const configText = `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`;
await writeFile(config, configText);
const env = {
  ...process.env,
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_HOME: home,
  AREAL_GUI_USER_DATA: userData,
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: registry,
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "AREAL_CORE_WORKSPACE",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
  "AREAL_HARNESS_TOOL_EXTENSIONS",
])
  delete env[key];
const scenario = process.env.AREAL_RECOVERY_SCENARIO || "open";
assert.ok(["open", "exited"].includes(scenario));
const marker = join(scratch, "fail-once");
await writeFile(marker, "1");
const oldLocal = join(legacyGui, "app/src/core/local-service.cjs");
let oldSource = await readFile(oldLocal, "utf8");
const fault = `if (project.root.endsWith('workspace-b') && require('node:fs').existsSync(${JSON.stringify(marker)})) { require('node:fs').unlinkSync(${JSON.stringify(marker)}); throw new Error('fixture: original stop response unconfirmed'); }`;
oldSource =
  scenario === "open"
    ? oldSource.replace(
        "  const result = await request(backend, ['stop'",
        `  ${fault}\n  const result = await request(backend, ['stop'`,
      )
    : oldSource.replace(
        "  if (result.state !== 'stopped')",
        `  ${fault}\n  if (result.state !== 'stopped')`,
      );
assert.ok(oldSource.includes(fault));
await writeFile(oldLocal, oldSource);
const testApp = join(scratch, "app");
await mkdir(testApp);
await writeFile(
  join(testApp, "package.json"),
  JSON.stringify({ name: "legacy-recovery-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(testApp, "bootstrap.cjs"),
  `
const {dialog}=require('electron');
globalThis.__recoveryConfirm=false; globalThis.__recoveryForce=true; globalThis.__recoveryDialogs=[];
dialog.showMessageBox=async(...args)=>{const o=args.at(-1);globalThis.__recoveryDialogs.push(o);return {response:globalThis.__recoveryConfirm ? (o.buttons?.includes('恢复后台') ? o.buttons.indexOf('恢复后台') : o.buttons?.includes('结束旧后台并恢复') && globalThis.__recoveryForce ? o.buttons.indexOf('结束旧后台并恢复') : 0) : 0};};
require(process.env.AREAL_RECOVERY_MAIN);
`,
);
let oldChild,
  old,
  connection,
  app,
  page,
  passed = false,
  projectId,
  threadId;
const until = async (fn, label, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timeout: " + label);
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const command = (name, request) => connection.request("command", { name, request }, true);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
console.log("Legacy Desktop recovery evidence:", scratch);
try {
  oldChild = spawn(require("electron"), [testApp, "--areal-core-service"], {
    env: { ...env, AREAL_RECOVERY_MAIN: join(legacyGui, "app/src/main.cjs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  oldChild.on("exit", (code, signal) =>
    appendFileSync(join(scratch, "legacy-exit.json"), JSON.stringify({ code, signal })),
  );
  oldChild.stderr.on("data", (c) => appendFileSync(join(scratch, "legacy.stderr.log"), c));
  old = await until(async () => {
    try {
      return JSON.parse(await readFile(join(home, "service.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }, "legacy Desktop");
  await writeFile(
    join(scratch, "run.json"),
    JSON.stringify({ home, registry, userData, oldPid: old.pid }),
  );
  connection = new ServiceConnection();
  await connection.connect(old);
  await connection.request("hello", { protocol: old.protocol, identity: old.identity });
  let firstProjectId;
  for (const name of ["workspace-a", "workspace-b"]) {
    const workspace = join(scratch, name);
    await mkdir(workspace);
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    await connection.request("addProject", { path: workspace }, true);
    const packet = await connection.request("snapshot");
    projectId = packet.snapshot.projects.find((v) => v.root === workspace).id;
    firstProjectId ??= projectId;
    await command("connect", { projectId });
  }
  projectId = firstProjectId;
  ({ threadId } = await command("create", { projectId }));
  await command("send", { projectId, threadId, text: "Preserve this history." });
  const before = await until(async () => {
    const p = await connection.request("snapshot");
    const t = p.snapshot.projects.find((v) => v.id === projectId)?.state?.threads[threadId];
    return t?.turns.at(-1)?.status === "completed" && t;
  }, "original turn completed");
  await until(async () => {
    const resources = await connection.request("resources", { operation: "inspect" });
    const { service } = await connection.request("snapshot");
    return !service.busy && service.activeCommands === 0 && resources.every((p) => p.restartSafe);
  }, "original Core quiescence");
  await assert.rejects(
    connection.request(
      "stopService",
      {
        protocol: old.protocol,
        expectedTargets: (await connection.request("snapshot")).service.targets.sort((a, b) =>
          a.projectId.localeCompare(b.projectId),
        ),
      },
      true,
    ),
    (e) => e.message.includes("fixture: original stop response unconfirmed"),
  );
  const originalControl = { home, state: "unconfirmed", pid: old.pid };
  await writeFile(join(userData, "service-control.json"), JSON.stringify(originalControl));
  const oldPacket = await connection.request("snapshot");
  assert.equal(oldPacket.service.stopReport.phase, "incomplete");
  connection.close();
  connection = null;
  const launchCurrent = async () => {
    app = await electron.launch({
      executablePath: require("electron"),
      args: [testApp],
      env: { ...env, AREAL_RECOVERY_MAIN: join(gui, "app/src/main.cjs") },
      timeout: 120000,
    });
    app.process().stderr.on("data", (c) => appendFileSync(join(scratch, "gui.stderr.log"), c));
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  };
  const openBackendSettings = async () => {
    const startupSettings = page.getByRole("button", { name: "检查设置", exact: true });
    if (await startupSettings.isVisible()) await startupSettings.click();
    else {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "常规", exact: true }).click();
      await page.getByRole("button", { name: "打开高级诊断", exact: true }).click();
    }
  };
  await launchCurrent();
  // Arrange the existing user's remembered navigation; recovery itself uses UI.
  await page.evaluate(
    ({ projectId, threadId }) => {
      localStorage.setItem("areal-gui:project", projectId);
      localStorage.setItem(`areal-gui:thread:${projectId}`, threadId);
    },
    { projectId, threadId },
  );
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      .items[0].submenu.items.find((i) => i.label === "停止后台并退出…")
      .click();
  });
  await until(async () => (await state()).lifecycle?.error, "unsettled legacy stop keeps GUI open");
  assert.equal(app.process().exitCode, null);
  assert.equal(alive(old.pid), true);
  assert.equal(requests.length, 1);
  checks.push("stop-and-quit refuses an unresolved legacy operation and keeps the GUI open");
  await openBackendSettings();
  await page
    .getByTestId("backend-service-status")
    .getByRole("button", { name: "检查后台", exact: true })
    .click();
  await page.getByRole("button", { name: "恢复后台…", exact: true }).waitFor();
  assert.equal(alive(old.pid), true);
  assert.equal(requests.length, 1, "inspection must not replay any turn");
  checks.push("legacy partial-stop inspection is read-only and offers recovery");
  await page.screenshot({ path: join(scratch, "01-inspected.png") });
  if (scenario === "exited") {
    const t = oldPacket.service.stopReport.projects.find((p) => p.phase === "unknown");
    const file = join(registry, "services", t.serviceId, "service.json"),
      clean = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...clean, state: "ready" }), { mode: 0o600 });
    await page
      .getByTestId("backend-service-status")
      .getByRole("button", { name: "检查后台", exact: true })
      .click();
    assert.equal(
      (await state()).lifecycle.recovery.canRecover,
      false,
      "lock freedom without a clean Host marker is unknown",
    );
    await writeFile(
      file,
      JSON.stringify({ ...clean, generation: "00000000-0000-4000-8000-000000000001" }),
      { mode: 0o600 },
    );
    await page
      .getByTestId("backend-service-status")
      .getByRole("button", { name: "检查后台", exact: true })
      .click();
    assert.equal(
      (await state()).lifecycle.recovery.canRecover,
      false,
      "replacement generation cannot settle the old request",
    );
    await writeFile(file, JSON.stringify(clean), { mode: 0o600 });
    await page
      .getByTestId("backend-service-status")
      .getByRole("button", { name: "检查后台", exact: true })
      .click();
    checks.push("unclean Host exit and generation change both block recovery");
  }
  await page.getByRole("button", { name: "恢复后台…", exact: true }).click();
  await until(() => app.evaluate(() => globalThis.__recoveryDialogs.length), "native confirmation");
  assert.equal(alive(old.pid), true, "canceling confirmation retains the original Desktop");
  assert.deepEqual(
    JSON.parse(await readFile(join(userData, "service-control.json"), "utf8")),
    originalControl,
  );
  checks.push("cancel leaves original record and processes unchanged");
  if (scenario === "exited") {
    await app.evaluate(() => {
      globalThis.__recoveryConfirm = true;
      globalThis.__recoveryForce = false;
    });
    await page.getByRole("button", { name: "恢复后台…", exact: true }).click();
    await until(
      () =>
        app.evaluate(() =>
          globalThis.__recoveryDialogs.some((d) => d.message === "旧后台未响应退出"),
        ),
      "separate exit confirmation",
    );
    await until(
      () => page.getByRole("button", { name: "恢复后台…", exact: true }).isEnabled(),
      "declined exit complete",
    );
    assert.equal(alive(old.pid), true);
    assert.equal(
      JSON.parse(await readFile(join(userData, "service-control.json"), "utf8")).legacyRecovery
        .phase,
      "retiring",
    );
    await app.close();
    app = null;
    await launchCurrent();
    await openBackendSettings();
    checks.push("declining manager exit preserves the journal across GUI restart");
  }
  await app.evaluate(() => {
    globalThis.__recoveryConfirm = true;
  });
  await page.getByRole("button", { name: "恢复后台…", exact: true }).click();
  await until(
    async () => {
      const s = await state();
      return (
        s.connection?.state === "ready" &&
        !s.lifecycle?.recovery &&
        s.projects.find((p) => p.id === projectId)?.state?.connected
      );
    },
    "same workspace recovered",
    120000,
  );
  assert.equal(alive(old.pid), false, "old Desktop must exit before replacement");
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), threadId);
  await page.getByText("RECOVERY_HISTORY_PRESERVED", { exact: true }).waitFor();
  await until(
    async () =>
      (await state()).projects.find((p) => p.id === projectId)?.state?.threads[threadId]?.turns
        ?.length === before.turns.length,
    "original history reopened",
  );
  const restored = (await state()).projects.find((p) => p.id === projectId).state.threads[threadId];
  assert.deepEqual(restored.turns, before.turns);
  await writeFile(join(scratch, "history-before.json"), JSON.stringify(before));
  await writeFile(join(scratch, "history-after.json"), JSON.stringify(restored));
  assert.equal(await readFile(config, "utf8"), configText);
  assert.equal(requests.length, 1, "recovery must not send history again");
  await page.getByTestId("chat-input").fill("Continue in this same workspace.");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(
    async () =>
      requests.length === 2 &&
      (await state()).projects.find((p) => p.id === projectId)?.state?.threads[threadId]?.turns
        .length ===
        before.turns.length + 1 &&
      (await state()).projects
        .find((p) => p.id === projectId)
        ?.state?.threads[threadId]?.turns.at(-1)?.status === "completed",
    "new work after recovery",
  );
  await page.screenshot({ path: join(scratch, "02-recovered.png") });
  checks.push("same project/history/configuration retained; fresh turn completes without replay");
  const archived = (await readdir(userData)).find((n) => n.startsWith("legacy-recovery-"));
  assert.deepEqual(
    JSON.parse(await readFile(join(userData, archived), "utf8")).legacyRecovery.originalStopReport,
    oldPacket.service.stopReport,
    "original unknown outcome is archived without rewriting",
  );
  await writeFile(
    join(scratch, "dialogs.json"),
    JSON.stringify(await app.evaluate(() => globalThis.__recoveryDialogs)),
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  passed = true;
} catch (error) {
  errors.push(error.stack);
  if (page) {
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
  if (app) await app.close();
  connection?.close();
  if (old && alive(old.pid)) {
    try {
      const { executeCore } = require("../app/src/core/core-process.cjs");
      const run = async (args) =>
        JSON.parse(
          (await executeCore(binary, ["service", ...args, "--json"], { env, timeout: 120000 }))
            .stdout,
        );
      for (const descriptor of await run(["list"])) {
        if (descriptor.state !== "stopped")
          await run([
            "stop",
            "--instance",
            descriptor.serviceId,
            "--expected-generation",
            descriptor.generation,
            "--cancel",
          ]);
      }
      oldChild.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (alive(old.pid)) oldChild.kill("SIGKILL");
      await require("../app/src/core/service-client.cjs").waitForProcessExit(old.pid);
      const file = join(home, "service.json");
      await readFile(file, "utf8")
        .then(async (contents) => {
          if (JSON.parse(contents).pid === old.pid) {
            const { rm } = await import("node:fs/promises");
            await rm(file);
          }
        })
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    } catch (e) {
      errors.push("legacy cleanup: " + e.message);
      passed = false;
    }
  }
  try {
    const metadata = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
    const c = new ServiceConnection();
    try {
      await c.connect(metadata);
      const p = await c.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      if (p.service.lifecycle?.version === 2) {
        await new DesktopLifecycle({ connection: c, metadata, home }).stop({ mode: "cancel" });
        await waitForServiceProcessExit(home, metadata);
      }
    } finally {
      c.close();
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      errors.push("cleanup: " + e.message);
      passed = false;
    }
  }
  await new Promise((r) => model.close(r));
  for (const [path, hash] of Object.entries(sourceHashes))
    if (sha(await readFile(join(gui, path))) !== hash) {
      errors.push("source changed during acceptance: " + path);
      passed = false;
    }
  for (const [name, hash] of Object.entries(binaryHashes))
    if (sha(await readFile(join(dirname(binary), name))) !== hash) {
      errors.push("binary changed during acceptance: " + name);
      passed = false;
    }
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        scenario,
        checks,
        errors,
        sourceCommit,
        sourceHashes,
        binaryHashes,
        nativeDialogs:
          "fixture responses; real Electron, Desktop, Core and Runtime; no real provider or package validation",
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        diffSha256: createHash("sha256")
          .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
          .digest("hex"),
        binary,
        oldDesktopExited: old ? !alive(old.pid) : null,
      },
      null,
      2,
    ),
  );
}
assert.ok(passed, errors.join("\n"));
console.log("PASS", checks);
