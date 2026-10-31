#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
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
const { assertApplicationStopped, closeSmokeApplication } = await import(
  join(root, "clients/gui/scripts/application-cleanup.mjs")
);
const { respondToSessionName } = await import(join(root, "clients/gui/scripts/model-fixture.mjs"));
const desktop = join(root, "clients/gui/app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceExit } = require(
  join(desktop, "src/core/service-client.cjs"),
);
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
  // Stop only this run's Core instances; safe adapter shutdown normally does this itself.
  const metadataPath = join(run.state, "core/service.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (metadata?.applicationOwner) {
    await assertApplicationStopped(binary, env, metadata);
  } else if (metadata) {
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      await until(async () => {
        try {
          return await connection.request("stopService", { protocol: metadata.protocol }, true);
        } catch (error) {
          if (error.message.includes("后台仍有任务")) {
            const owned = JSON.parse(
              execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
            );
            for (const instance of owned) {
              assert.ok(
                instance.workspace.startsWith(run.state + "/"),
                "workspace outside owned state",
              );
              assert.ok(
                instance.dataDir.startsWith(join(run.state, "core") + "/"),
                "data outside owned state",
              );
              if (instance.state !== "stopped")
                execFileSync(
                  binary,
                  ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
                  { env, timeout: 60000 },
                );
            }
            return null;
          }
          throw error;
        }
      }, "safe stop of owned adapter");
    } finally {
      connection.close();
    }
    await waitForServiceExit(join(run.state, "core"), metadata);
    await until(async () => {
      try {
        process.kill(metadata.pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    }, "owned adapter process exits");
  }
  const instances = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
  );
  for (const instance of instances) {
    assert.ok(instance.workspace.startsWith(run.state + "/"), "workspace outside owned state");
    assert.ok(
      instance.dataDir.startsWith(join(run.state, "core") + "/"),
      "data outside owned state",
    );
    if (instance.state !== "stopped")
      execFileSync(
        binary,
        ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
        { env, timeout: 60000 },
      );
  }
  const remaining = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
  );
  assert.ok(
    remaining.every((instance) => instance.state === "stopped"),
    "Core remains live",
  );
  await rm(run.state, { recursive: true });
  return { adapterExited: true, coreStopped: true, stateRemoved: true };
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
  const evidence = await mkdtemp(join(evidenceRoot, "run-"));
  const state = await mkdtemp(join(tempRoot, "av-"));
  const run = { evidence, state, owner: randomUUID() };
  await writeFile(join(state, ".owner"), run.owner);
  await json(join(evidence, "run.json"), run);
  console.log(`Evidence: ${evidence}`);
  const requests = [],
    actions = [],
    errors = [],
    electronStderr = [];
  let app, page, server, failure, cleanupResult;
  async function closeGUI() {
    if (!app) return;
    const current = app;
    app = null;
    const child = current.process();
    try {
      await current.evaluate(({ dialog, Menu }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
        const quit = Menu.getApplicationMenu().items[0].submenu.items.find(
          (item) => item.label === "退出 AReaL Harness",
        );
        if (!quit) throw Error("Safe application quit menu is missing");
        quit.click();
      });
    } finally {
      await closeSmokeApplication({
        process: () => child,
        close: () =>
          until(() => child.exitCode !== null || child.signalCode !== null, "owned Electron exit"),
      });
    }
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
    const workspace = join(state, "workspace");
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
      `schema_version=2\n[delegation]\ninspection_permissions="inherit"\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
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
    const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
    const project = (state) => state.projects.find((item) => item.root === workspace);
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
      {
        await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
        await page.evaluate(() => {
          const key = "areal-gui:application-preferences";
          const prefs = JSON.parse(localStorage.getItem(key) || "{}");
          localStorage.setItem(key, JSON.stringify({ ...prefs, nextPromptSuggestions: false }));
        });
        await page.reload();
      }
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
      await until(
        async () => (await snapshot()).connection?.state === "ready",
        "usable desktop service",
      );
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
      const metadata = JSON.parse(await readFile(join(state, "core/service.json"), "utf8"));
      process.kill(metadata.pid, 0);
      const connection = new ServiceConnection();
      try {
        await connection.connect(metadata);
        await connection.request("hello", {
          protocol: metadata.protocol,
          identity: metadata.identity,
        });
      } finally {
        connection.close();
      }
      const instanceDoctor = {
        ...actual,
        adapterPid: metadata.pid,
        coreSHA256: sha(await readFile(binary)),
        modelAddress: server.address(),
        ownedState: state,
      };
      await json(join(evidence, "doctor.json"), instanceDoctor);
      await json(join(evidence, `doctor-${actual.pid}.json`), instanceDoctor);
      const { doctor } = await import(
        join(root, ".agents/skills/verify-areal-harness/scripts/instance-doctor.mjs")
      );
      await doctor({
        app,
        page,
        env,
        binary,
        expectedSHA256: build.coreSHA256,
        evidence,
        label: `${actual.pid}-launch`,
      });
      await app.evaluate(({ BrowserWindow, dialog }, path) => {
        BrowserWindow.getAllWindows()[0].setSize(1440, 960);
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, workspace);
    }
    await record("launch fresh isolated source Electron");
    await launch();
    await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
    await until(async () => project(await snapshot())?.state?.connected, "project connected");
    await page.getByTestId("chat-input").fill("TRACE_ROOT");
    await page.getByTestId("chat-send-button").click();
    await page.getByText("TRACE_ROOT_DONE", { exact: true }).waitFor({ timeout: 120000 });
    const tid = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    assert.ok(tid);
    await until(
      async () =>
        project(await snapshot()).state.threads[tid]?.turns?.at(-1)?.status === "completed",
      "root completed",
    );
    await json(join(evidence, "history-before.json"), project(await snapshot()).state.threads[tid]);
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
      await app.evaluate(({ clipboard }) => clipboard.clear());
      await page.getByRole("button", { name: "复制当前会话全部轨迹", exact: true }).click();
      await page.getByRole("button", { name: "已复制当前会话全部轨迹", exact: true }).waitFor();
      return until(async () => {
        const text = await app.evaluate(({ clipboard }) => clipboard.readText());
        try {
          const value = JSON.parse(text);
          return value.scope === "conversationIncludingSubagents" && value.threadId === tid
            ? value
            : null;
        } catch {
          return null;
        }
      }, "current conversation copied to clipboard");
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
    await until(async () => project(await snapshot())?.state?.connected, "restored project");
    await page.getByTestId(`task-item-${tid}`).click();
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
    assert.equal(requests.length, count, "reopening trace does not issue model requests");
    const restoredCopy = await copyConversation();
    assert.ok(restoredCopy.children?.length, "restored copy includes shared child");
    await json(join(evidence, "trace-copy-after.json"), restoredCopy);
    await capture("02-reopened");
    await json(join(evidence, "history-after.json"), project(await snapshot()).state.threads[tid]);
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
      const { doctor } = await import(
        join(root, ".agents/skills/verify-areal-harness/scripts/instance-doctor.mjs")
      );
      await doctor({
        app,
        page,
        env: environment(state),
        binary,
        expectedSHA256: build.coreSHA256,
        evidence,
        label: "failure",
      }).catch((error) => errors.push(`failure doctor: ${error.message}`));
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
