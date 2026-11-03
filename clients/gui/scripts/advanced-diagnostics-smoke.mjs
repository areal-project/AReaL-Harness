import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("../app/src/core/host-client.cjs");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "AREAL_CORE_BIN must be an absolute fixed-bundle path");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const scratch = await makeTempDir("areal-advanced-diagnostics-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});
const checks = [],
  errors = [],
  processes = [],
  streams = [];
const server = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (respondToSessionName(input, response)) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "QUIT_FIXTURE_STREAM" }, finish_reason: null }] })}\n\n`,
    );
    streams.push(response);
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
let application,
  app,
  page,
  child,
  host,
  hostPid,
  hostPids = [],
  corePids = [],
  passed = false,
  cleanup;
const until = async (read, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (value) => value.projects.find((item) => item.root === workspace);
const workspaceService = (status) => {
  const matches = status.projects.filter((item) => item.registration.workspace === workspace);
  assert.equal(matches.length, 1, "Host has exactly one registration for the test workspace");
  return matches[0].service;
};
const assertActiveWorkspace = async (threadId) => {
  const value = await snapshot();
  const workbench = page.getByTestId("areal-workbench");
  assert.equal(await workbench.getAttribute("data-project-id"), project(value).id);
  assert.equal(await workbench.getAttribute("data-thread-id"), threadId);
  assert.ok(project(value).state.threads[threadId]);
};
const thread = (value) =>
  project(value)?.state?.threads[
    value.activeThreadId ?? Object.keys(project(value)?.state?.threads ?? {})[0]
  ];
const launch = async () => {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  child = app.process();
  processes.push(child);
  child.stderr.on(
    "data",
    (chunk) => void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "GUI ready");
};
const activity = () => host.activity();
const send = async (text) => {
  const priorStreams = streams.length;
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  await until(() => streams.length > priorStreams, "new model request");
  await until(
    async () =>
      thread(await snapshot())
        ?.turns.at(-1)
        ?.items.some(
          (item) => item.type === "agentMessage" && item.text?.includes("QUIT_FIXTURE_STREAM"),
        ),
    "stream visible",
  );
  await until(
    async () =>
      (await activity()).projects.some((item) => item.state === "observed" && item.activeTurns > 0),
    "Host observes active turn",
  );
  return thread(await snapshot()).id;
};
const cleanupHost = async () => {
  const observer = new HostClient();
  try {
    if (!hostPid)
      hostPid = JSON.parse(
        await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
      ).pid;
    try {
      await observer.connect(env.AREAL_HARNESS_SERVICE_HOME);
      const state = await observer.status();
      corePids.push(
        ...state.projects
          .flatMap((item) => (item.service ? [item.service.hostPid, item.service.corePid] : []))
          .filter(Boolean),
      );
      const result = await observer.stop(randomUUID(), observer.generation, "cancel");
      assert.equal(result.state, "completed");
    } catch (error) {
      const receipt = JSON.parse(
        await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/stop.json"), "utf8"),
      );
      if (receipt.state !== "completed") throw error;
    }
    for (const pid of [...hostPids, hostPid, ...corePids].filter(Boolean))
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      }, `owned process ${pid} exits`);
    cleanup = { hostPids, corePids, exited: true };
  } catch (error) {
    cleanup = { hostPid, corePids, error: error.stack };
    passed = false;
  } finally {
    observer.close();
  }
};
console.log("Advanced diagnostics evidence:", scratch);
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nname="Fixture"\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  application = await applicationFixture(gui, join(scratch, "app"));
  await launch();
  host = new HostClient();
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  hostPid = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  ).pid;
  hostPids.push(hostPid);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "后台服务", exact: true }).count(), 0);
  await page.locator(".provider-catalog-row").filter({ hasText: "Fixture" }).click();
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("Fixture saved");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await until(
    async () => await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
    "provider save",
    180000,
  );
  checks.push("Provider settings saved in isolated desktop");
  await page.getByRole("button", { name: "常规", exact: true }).click();
  await page.screenshot({ path: join(scratch, "general.png"), animations: "disabled" });
  await page.getByRole("button", { name: "打开高级诊断", exact: true }).click();
  await page.screenshot({ path: join(scratch, "advanced.png"), animations: "disabled" });
  await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "dark";
    BrowserWindow.getAllWindows()[0].setSize(900, 700);
  });
  await page.screenshot({
    path: join(scratch, "advanced-narrow-dark.png"),
    animations: "disabled",
  });
  await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "system";
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  });
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    join(scratch, "diagnostics.json"),
  );
  await page.getByRole("button", { name: /导出诊断包/ }).click();
  const exported = JSON.parse(
    await until(
      () => readFile(join(scratch, "diagnostics.json"), "utf8").catch(() => null),
      "diagnostics export",
    ),
  );
  assert.equal(exported.format, "areal-harness-diagnostics-v1");
  checks.push("Advanced diagnostics opens and exports through Electron IPC");
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, "project ready");
  await send("FIRST_DIAGNOSTIC_TASK");
  streams
    .at(-1)
    .end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  await until(
    async () => thread(await snapshot())?.turns.at(-1)?.status === "completed",
    "first task completed",
  );
  const status = await host.status();
  corePids.push(
    ...status.projects
      .flatMap((item) => (item.service ? [item.service.hostPid, item.service.corePid] : []))
      .filter(Boolean),
  );
  checks.push("Real Core completes a task using local deterministic model");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".provider-catalog-row").filter({ hasText: "Fixture saved" }).click();
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("Fixture applied");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const applied = await until(
    async () => {
      const result = await page.evaluate(() =>
        window.arealDesktop.command("providers", { operation: "list" }),
      );
      if (
        !result.ok ||
        result.value.pendingApply ||
        !result.value.data?.some((item) => item.id === "fixture" && item.name === "Fixture applied")
      )
        return null;
      const projectId = project(await snapshot()).id;
      return result.value.projects?.some((item) => item.projectId === projectId && item.applied)
        ? result.value
        : null;
    },
    "provider applies to active Core",
    180000,
  );
  const afterSave = workspaceService(await host.status());
  assert.equal(afterSave.corePid, workspaceService(status).corePid);
  assert.equal(afterSave.generation, workspaceService(status).generation);
  await writeFile(
    join(scratch, "provider-applied.json"),
    JSON.stringify(
      {
        revision: applied.revision,
        projects: applied.projects,
        before: status.projects,
        after: (await host.status()).projects,
      },
      null,
      2,
    ),
  );
  checks.push("Provider save applies to active Core without restarting it");
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  const original = workspaceService(await host.status());
  assert.ok(original?.corePid, "Host identifies the isolated Core to fault");
  const threadId = thread(await snapshot()).id;
  await assertActiveWorkspace(threadId);
  process.kill(original.corePid, "SIGKILL");
  await until(() => {
    try {
      process.kill(original.corePid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "original workspace Core exits");
  await until(
    async () => {
      const current = workspaceService(await host.status());
      return (
        current &&
        current.corePid !== original.corePid &&
        current.generation !== original.generation &&
        current.serviceId === original.serviceId &&
        project(await snapshot())?.state?.connected
      );
    },
    "automatic Core recovery",
    180000,
  );
  const successor = workspaceService(await host.status());
  corePids.push(successor.hostPid, successor.corePid);
  assert.equal(thread(await snapshot()).id, threadId);
  await assertActiveWorkspace(threadId);
  await writeFile(
    join(scratch, "recovery-identities.json"),
    JSON.stringify({ workspace, threadId, original, successor }, null, 2),
  );
  await until(
    async () =>
      project(await snapshot())?.models?.some(
        (model) => model.providerId === "fixture" && model.available,
      ),
    "recovered model catalog",
    60000,
  );
  await writeFile(
    join(scratch, "recovered-snapshot.json"),
    JSON.stringify(await snapshot(), null, 2),
  );
  await page.getByText("FIRST_DIAGNOSTIC_TASK", { exact: true }).waitFor();
  assert.equal(await page.getByText("历史内容加载失败，请重试。", { exact: true }).count(), 0);
  await page.screenshot({ path: join(scratch, "recovered.png"), animations: "disabled" });
  const previousTurns = thread(await snapshot()).turns.length;
  await send("SECOND_DIAGNOSTIC_TASK");
  streams
    .at(-1)
    .end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  await until(
    async () => thread(await snapshot())?.turns.at(-1)?.status === "completed",
    "continued task completed",
  );
  await assertActiveWorkspace(threadId);
  assert.equal(thread(await snapshot()).turns.length, previousTurns + 1);
  await page.getByText("FIRST_DIAGNOSTIC_TASK", { exact: true }).waitFor();
  await page.getByText("SECOND_DIAGNOSTIC_TASK", { exact: true }).waitFor();
  assert.equal(await page.getByText("历史内容加载失败，请重试。", { exact: true }).count(), 0);
  await writeFile(
    join(scratch, "continued-snapshot.json"),
    JSON.stringify(await snapshot(), null, 2),
  );
  checks.push("Injected workspace Core crash recovers automatically and same thread continues");
  passed = true;
} catch (error) {
  errors.push(error.stack);
  if (page && !page.isClosed()) {
    await writeFile(
      join(scratch, "failure-snapshot.json"),
      JSON.stringify(await snapshot(), null, 2),
    ).catch(() => {});
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
  if (app && child?.exitCode === null) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "owned GUI cleanup",
    ).catch((e) => errors.push(e.message));
  }
  host?.close();
  await cleanupHost();
  for (const stream of streams) stream.destroy();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await application?.close();
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(sha(await readFile(join(dirname(binary), name))), hash);
  passed = passed && errors.length === 0 && cleanup?.exited === true;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        cleanup,
        binary,
        hashes,
        source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        diffSha256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
        scope:
          "Isolated source Electron and fixed Core; deterministic loopback model; injected native folder and save dialogs; no physical input, real provider or package.",
      },
      null,
      2,
    ),
  );
  console.log(passed ? "PASS" : "FAIL", checks, errors, cleanup);
  if (!passed) process.exitCode = 1;
}
