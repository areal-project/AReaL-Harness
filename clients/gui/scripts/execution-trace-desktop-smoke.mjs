#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

const tempRoot = await realpath(tmpdir());
const localRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = resolve(process.env.AREAL_VERIFY_ROOT || localRoot);
const {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} = await import(join(root, "clients/gui/scripts/application-cleanup.mjs"));
const { respondToSessionName } = await import(join(root, "clients/gui/scripts/model-fixture.mjs"));
const desktop = join(root, "clients/gui/app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const { readCoreThread } = await import(
  join(root, "clients/gui/scripts/support/core-observation.mjs")
);
const { openProjectInDesktop, sendReady } = await import(
  join(root, "clients/gui/scripts/support/journey-fixture.mjs")
);
const { selectConversation } = await import(join(root, "clients/gui/scripts/smoke-navigation.mjs"));
const { verificationDoctor, lockVerificationSlot } = await import(
  new URL("./verification-build.mjs", import.meta.url)
);
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(isAbsolute(binary), "AREAL_CORE_BIN must be an absolute path");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const command = "conversation";
const single = process.env.AREAL_TRACE_SINGLE === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw Error(`Timeout: ${label}`);
}
async function preflight() {
  assert.equal(process.platform, "darwin", "This helper is proven on macOS only");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Node >=22.19 required");
  const diagnosticsRoot = join(localRoot, ".scratch/execution-trace");
  await mkdir(diagnosticsRoot, { recursive: true });
  const diagnostics = await verificationDoctor({ root, binary, evidence: diagnosticsRoot });
  await access(binary, constants.X_OK);
  await access("/usr/bin/python3", constants.X_OK);
  await access(require("electron"), constants.X_OK);
  await access(join(root, "clients/gui/renderer/dist/index.html"));
  return {
    root,
    binary,
    diagnostics,
    coreVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
    coreSHA256: sha(await readFile(binary)),
    electron: require("electron/package.json").version,
    playwright: require("playwright-core/package.json").version,
    node: process.version,
  };
}
function environment(state) {
  const env = { ...process.env };
  // Do not inherit another verification run's Core/configuration/credentials.
  for (const key of Object.keys(env))
    if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(",");
  return {
    ...env,
    HOME: join(state, "user"),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    AREAL_GUI_USER_DATA: join(state, "electron"),
    AREAL_CORE_HOME: join(state, "core"),
    AREAL_CORE_USER_HOME: join(state, "user"),
    AREAL_HARNESS_HOME: join(state, "config-home"),
    AREAL_HARNESS_SERVICE_HOME: join(state, "registry"),
    AREAL_CORE_CONFIG: join(state, "config.toml"),
    AREAL_CORE_DESKTOP_CONFIG: join(state, "desktop.json"),
    AREAL_CORE_BIN: binary,
  };
}
async function cleanup(run) {
  assert.equal(dirname(run.state), tempRoot);
  assert.match(basename(run.state), /^av-[a-zA-Z0-9]+$/);
  try {
    assert.equal(await realpath(run.state), run.state);
    assert.equal(await readFile(join(run.state, ".owner"), "utf8"), run.owner);
  } catch (error) {
    if (error.code === "ENOENT") return { alreadyRemoved: true };
    throw error;
  }
  const env = environment(run.state);
  const metadata = await readFile(join(run.evidence, "latest-launch.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (metadata) {
    await settleFixtureHostAfterQuit(binary, env, run.evidence, {
      host: { hostId: metadata.hostId, generation: metadata.generation, pid: metadata.hostPid },
      pid: metadata.pid,
    });
  } else {
    assert.equal(await readFixtureHost(env), null, "original launch identity was not recorded");
    await assertApplicationStopped(binary, env, null);
  }
  await rm(run.state, { recursive: true });
  return { coreStopped: true, stateRemoved: true };
}
if (command === "doctor") {
  console.log(JSON.stringify(await preflight(), null, 2));
} else if (command === "cleanup" && process.argv[3]) {
  const evidence = resolve(process.argv[3]);
  const run = JSON.parse(await readFile(join(evidence, "run.json"), "utf8"));
  const result = await cleanup(run);
  await json(join(evidence, "cleanup.json"), result);
  console.log(JSON.stringify({ evidence, cleanup: result }));
} else if (command === "conversation" || command === "selection") {
  const releaseSlot = await lockVerificationSlot(binary);
  const build = await preflight().catch(async (error) => {
    await releaseSlot();
    throw error;
  });
  const evidenceRoot = join(localRoot, ".scratch/execution-trace");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await trackedMkdtemp(join(evidenceRoot, "run-"));
  const state = await trackedMkdtemp(join(tempRoot, "av-"));
  const run = { evidence, state, owner: randomUUID() };
  await writeFile(join(state, ".owner"), run.owner);
  await json(join(evidence, "run.json"), run);
  console.log(`Evidence: ${evidence}`);
  const requests = [],
    actions = [],
    errors = [],
    electronStderr = [];
  let app, page, server, failure, cleanupResult, originalHost;
  const exits = [];
  async function closeGUI() {
    if (!app) return;
    const current = app;
    app = null;
    const child = current.process();
    const pid = child.pid;
    const host = originalHost;
    originalHost = null;
    const exitEvidence = join(evidence, `exit-${pid}`);
    await mkdir(exitEvidence);
    await closeSmokeApplication({
      process: () => child,
      close: () =>
        current.evaluate(({ app, dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 });
          app.quit();
        }),
    });
    const receipt = await settleFixtureHostAfterQuit(binary, environment(state), exitEvidence, {
      host,
      pid,
    });
    assert.ok(receipt, "fixture Host issued a stop receipt");
    assert.ok(child.exitCode === 0 && child.signalCode === null);
    exits.push({ pid, hostPid: host?.pid, exitCode: child.exitCode, requestId: receipt.requestId });
    await json(join(evidence, "exits.json"), exits);
  }
  const record = async (action) => {
    actions.push({ at: new Date().toISOString(), action });
    await json(join(evidence, "actions.json"), actions);
  };
  const manifest = {
    build,
    feature: command,
    entry: single
      ? "project picker → one shared child → trace copy → GUI reopen → trace copy"
      : "project picker → nested shared delegation → trace copy → GUI reopen → trace copy",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    diffSHA256: sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })),
    helperSHA256: sha(await readFile(fileURLToPath(import.meta.url))),
    scope:
      "source Electron/Main/preload + real Core/Runtime; deterministic local model; native project picker injected",
  };
  try {
    const workspace = join(state, "demo");
    await mkdir(workspace);
    await mkdir(join(state, "user"));
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (respondToSessionName(body, res)) return;
        requests.push(body);
        const messages = body.messages ?? [];
        const content = (value) =>
          typeof value === "string" ? value : JSON.stringify(value ?? "");
        const users = messages.filter((m) => m.role === "user").map((m) => content(m.content));
        const level = users.some((v) => v.includes("TRACE_NESTED"))
          ? "nested"
          : users.some((v) => v.includes("TRACE_CHILD"))
            ? "child"
            : "root";
        const results = messages
          .filter((m) => m.role === "tool")
          .map((m) => {
            try {
              return JSON.parse(content(m.content));
            } catch {
              return {};
            }
          });
        let delta, finish;
        if (level === "nested" || (single && level === "child")) {
          delta = { content: level === "child" ? "TRACE_CHILD_DONE" : "TRACE_NESTED_DONE" };
          finish = "stop";
        } else if (!results.length) {
          delta = {
            tool_calls: [
              {
                index: 0,
                id: `spawn-${level}`,
                type: "function",
                function: {
                  name: "agent_spawn",
                  arguments: JSON.stringify({
                    prompt: level === "root" ? "TRACE_CHILD" : "TRACE_NESTED",
                    intent: "inspect",
                    delivery: "report",
                  }),
                },
              },
            ],
          };
          finish = "tool_calls";
        } else if (results.length === 1 && (results[0].executionId || results[0].threadId)) {
          const key = results[0].executionId ? "executionId" : "threadId";
          delta = {
            tool_calls: [
              {
                index: 0,
                id: `wait-${level}`,
                type: "function",
                function: {
                  name: "agent_wait",
                  arguments: JSON.stringify({ [key]: results[0][key], timeoutMs: 60000 }),
                },
              },
            ],
          };
          finish = "tool_calls";
        } else {
          delta = { content: level === "root" ? "TRACE_ROOT_DONE" : "TRACE_CHILD_DONE" };
          finish = "stop";
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        );
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(
      join(state, "config.toml"),
      `schema_version=1\n[delegation]\ninspection_permissions="inherit"\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
    );
    await json(join(state, "desktop.json"), {
      profiles: [
        {
          id: "verification",
          revision: "v1",
          displayName: "Verification",
          instructions: "Write the requested proof file.",
        },
      ],
    });
    const env = environment(state);

    const capture = async (name) => {
      await page.screenshot({
        path: join(evidence, `${name}.png`),
        animations: "disabled",
        timeout: 10000,
      });
      await writeFile(
        join(evidence, `${name}.aria.txt`),
        await page.locator("body").ariaSnapshot(),
      );
    };
    async function launch() {
      app = await electron.launch({
        executablePath: require("electron"),
        args: [desktop],
        env,
        timeout: 120000,
      });
      app.process().stderr.on("data", (data) => electronStderr.push(String(data)));
      page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      const ready = page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]');
      await ready.waitFor({ timeout: 120000 });
      const preferencesChanged = await page.evaluate(() => {
        const key = "areal-gui:application-preferences";
        const prefs = JSON.parse(localStorage.getItem(key) || "{}");
        if (prefs.locale === "zh-CN" && prefs.nextPromptSuggestions === false) return false;
        localStorage.setItem(
          key,
          JSON.stringify({ ...prefs, locale: "zh-CN", nextPromptSuggestions: false }),
        );
        return true;
      });
      if (preferencesChanged) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await ready.waitFor();
      }
      const actual = await app.evaluate(({ app, BrowserWindow }) => {
        const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return {
          pid: process.pid,
          electron: process.versions.electron,
          userData: app.getPath("userData"),
          sandbox: p.sandbox,
          contextIsolation: p.contextIsolation,
          nodeIntegration: p.nodeIntegration,
        };
      });
      assert.equal(actual.userData, env.AREAL_GUI_USER_DATA);
      assert.equal(actual.electron, build.electron);
      assert.equal(actual.sandbox, true);
      assert.equal(actual.contextIsolation, true);
      assert.equal(actual.nodeIntegration, false);
      originalHost = await until(async () => {
        const descriptor = await readFixtureHost(env);
        return descriptor?.pid > 1 ? descriptor : false;
      }, "isolated Host identity published");
      process.kill(originalHost.pid, 0);
      const connection = new HostClient();
      try {
        await connection.connect(env.AREAL_HARNESS_SERVICE_HOME);
        assert.equal(connection.hostId, originalHost.hostId);
        assert.equal(connection.generation, originalHost.generation);
      } finally {
        connection.close();
      }
      const instanceDoctor = {
        ...actual,
        hostId: originalHost.hostId,
        generation: originalHost.generation,
        hostPid: originalHost.pid,
        coreSHA256: sha(await readFile(binary)),
        modelAddress: server.address(),
        ownedState: state,
      };
      await json(join(evidence, "latest-launch.json"), instanceDoctor);
      await json(join(evidence, `doctor-${actual.pid}.json`), instanceDoctor);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setSize(1440, 960);
      });
    }
    await record("launch fresh isolated source Electron");
    await launch();
    await openProjectInDesktop(app, page, workspace);
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("radio", { name: "fixture", exact: true }).click();
    await page.getByTestId("chat-input").fill("TRACE_ROOT");
    await sendReady(page);
    await page.getByTestId("chat-send-button").click();
    await page.getByText("TRACE_ROOT_DONE", { exact: true }).waitFor({ timeout: 120000 });
    const tid = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    assert.ok(tid);
    const coreOptions = { binary, env, gui: dirname(desktop), workspace, threadId: tid };
    const history = await until(async () => {
      const thread = await readCoreThread(coreOptions);
      return thread.turns?.at(-1)?.status === "completed" ? thread : null;
    }, "original Core Turn completed");
    const turn = history.turns.at(-1);
    assert.ok(
      turn.items.some((item) => item.type === "agentMessage" && item.text === "TRACE_ROOT_DONE"),
    );
    await json(join(evidence, "history-before.json"), history);
    async function openTrace() {
      await page.getByRole("button", { name: "任务操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "查看调用轨迹", exact: true }).click();
      await page.getByRole("region", { name: "调用轨迹" }).waitFor();
      await until(
        async () => (await page.locator("[data-execution-id]").count()) > 0,
        "delegation trace loaded",
      );
    }
    await openTrace();
    const first = page.locator("[data-execution-id]").first();
    await first.getByRole("button").first().click();
    if (single)
      await page
        .getByRole("region", { name: "调用轨迹" })
        .getByRole("button", { name: /助手消息 TRACE_CHILD_DONE/ })
        .waitFor();
    else {
      await until(
        async () => (await page.locator("[data-execution-id]").count()) >= 2,
        "nested delegation visible",
      );
      await page.locator("[data-execution-id]").nth(1).getByRole("button").first().click();
      await page.getByText("TRACE_NESTED_DONE", { exact: false }).first().waitFor();
    }
    await capture("01-trace");
    async function copyConversation() {
      const previous = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) => {
        // 在复制前实体化，各 MIME 类型都留在 Main 内存中。
        return Promise.all(
          (await clipboard.read()).map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(
                  await Promise.all(
                    item.types.map(async (type) => [type, await item.getType(type)]),
                  ),
                ),
              ),
          ),
        );
      });
      let copiedText;
      try {
        await page.getByRole("button", { name: "复制当前会话全部轨迹", exact: true }).click();
        await page.getByRole("button", { name: "已复制当前会话全部轨迹", exact: true }).waitFor();
        return await until(async () => {
          const text = await app.evaluate(({ clipboard }) => clipboard.readText());
          try {
            const value = JSON.parse(text);
            if (value.scope !== "conversationIncludingSubagents" || value.threadId !== tid)
              return null;
            copiedText = text;
            return value;
          } catch {
            return null;
          }
        }, "current conversation copied to clipboard");
      } finally {
        try {
          if (copiedText) {
            await app.evaluate(
              async ({ clipboard }, { previous, copiedText }) => {
                if ((await clipboard.readText()) !== copiedText) return;
                if (previous.length === 0) clipboard.clear();
                else await clipboard.write(previous);
              },
              { previous, copiedText },
            );
          }
        } finally {
          await previous.dispose();
        }
      }
    }
    const copied = await copyConversation();
    assert.equal(copied.scope, "conversationIncludingSubagents");
    assert.ok(
      copied.children?.length && (single || copied.children[0].sources?.[0].children?.length),
      "copied nested execution",
    );
    await json(join(evidence, "trace-copy-before.json"), copied);
    const count = requests.length;
    await closeGUI();
    await launch();
    await selectConversation(page, tid);
    await page.getByText("TRACE_ROOT_DONE", { exact: true }).waitFor();
    await openTrace();
    await page.locator("[data-execution-id]").first().getByRole("button").first().click();
    if (single)
      await page
        .getByRole("region", { name: "调用轨迹" })
        .getByRole("button", { name: /助手消息 TRACE_CHILD_DONE/ })
        .waitFor();
    else {
      await until(
        async () => (await page.locator("[data-execution-id]").count()) >= 2,
        "restored nested delegation",
      );
      await page.locator("[data-execution-id]").nth(1).getByRole("button").first().click();
      await page.getByText("TRACE_NESTED_DONE", { exact: false }).first().waitFor();
    }
    const restoredCopy = await copyConversation();
    assert.deepEqual(
      restoredCopy.children.map(({ execution, sources }) => [
        execution.executionId,
        sources.map(({ threadId }) => threadId),
      ]),
      copied.children.map(({ execution, sources }) => [
        execution.executionId,
        sources.map(({ threadId }) => threadId),
      ]),
      "restored copy includes the original execution and child Threads",
    );
    assert.equal(requests.length, count, "reopening and copying trace do not issue model requests");
    await json(join(evidence, "trace-copy-after.json"), restoredCopy);
    await capture("02-reopened");
    const restored = await readCoreThread(coreOptions);
    assert.deepEqual(restored.turns, history.turns, "reopen preserves the original Core Turns");
    await json(join(evidence, "history-after.json"), restored);
    manifest.delegationScope = single
      ? "one shared child; nested not tested"
      : "nested shared children";
    manifest.threadId = tid;
    manifest.requests = requests.length;
  } catch (error) {
    failure = error.stack ?? String(error);
    console.error(failure);
    if (page) {
      await page
        .screenshot({ path: join(evidence, "failure.png"), timeout: 10000 })
        .catch(() => {});
      await writeFile(
        join(evidence, "failure.aria.txt"),
        await page
          .locator("body")
          .ariaSnapshot()
          .catch(() => ""),
      ).catch(() => {});
    }
  } finally {
    if (app) {
      await closeGUI().catch((error) => errors.push(`close GUI: ${error.message}`));
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await json(join(evidence, "model-requests.json"), requests);
    await writeFile(join(evidence, "electron.stderr.log"), electronStderr.join(""));
    try {
      cleanupResult = await cleanup(run);
    } catch (error) {
      errors.push(`cleanup: ${error.stack}`);
    }
    const coreUnchanged = sha(await readFile(binary)) === build.coreSHA256;
    if (!coreUnchanged) errors.push("Core binary changed during verification");
    const passed = !failure && errors.length === 0 && cleanupResult?.stateRemoved === true;
    await json(
      join(evidence, "cleanup.json"),
      cleanupResult ?? { failed: true, stateRetained: state },
    );
    await json(join(evidence, "manifest.json"), {
      ...manifest,
      passed,
      failure,
      errors,
      coreUnchanged,
      stderrHasErrors: electronStderr.some((text) => /Error/.test(text)),
      cleanup: cleanupResult,
    });
    await access(join(evidence, "manifest.json"));
    console.log(JSON.stringify({ passed, evidence, state, cleanup: cleanupResult }));
    if (cleanupResult?.stateRemoved === true) await releaseSlot();
    if (!passed) process.exitCode = 1;
  }
} else {
  console.error(
    "Usage: control.mjs doctor | conversation | selection | cleanup <evidence-directory>",
  );
  process.exitCode = 2;
}
