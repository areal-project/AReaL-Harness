import { makeTempDir } from "./support/temp.mjs";
// Actual Electron/Core hook definition review, no implicit execution and durable response-loss recovery.
// Failure contract: installation runs commands; trust is granted without review; lost response replays;
// stale selection grants another package; revocation leaves executable hooks; native UI never renders.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  stopFixtureHost,
} from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { openProjectInDesktop } from "./support/journey-fixture.mjs";
import { until } from "./support/desktop-fixture.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-plugin-gui-"),
  workspace = join(scratch, "demo"),
  userHome = join(scratch, "user");
await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const source = join(workspace, "packages", "hello");
await mkdir(join(source, "skills", "setup"), { recursive: true });
await writeFile(
  join(source, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "hello",
    version: "1.0.0",
    description: "A local package fixture.",
    extensions: {
      "com.openai": {
        interface: { displayName: "Hello Plugin" },
        onboardingSkill: "./skills/setup/SKILL.md",
      },
    },
  }),
);
await writeFile(
  join(source, "skills", "setup", "SKILL.md"),
  "---\nname: setup\ndescription: Configure the hello fixture.\n---\nGUI_PLUGIN_SETUP_BODY_MARKER\n",
);
await mkdir(join(source, "hooks"), { recursive: true });
await writeFile(
  join(source, "hooks/hook.sh"),
  [
    "IFS= read -r record || exit 1",
    'case "$record" in *\'"hook_event_name":"UserPromptSubmit"\'*) ;; *) exit 1 ;; esac',
    'printf \'%s\\n\' "$record" >> "$PLUGIN_DATA/gui-hooks.jsonl" || exit 1',
    'printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"GUI_HOOK_CONTEXT"}}\'',
  ].join("\n") + "\n",
);
await writeFile(
  join(source, "hooks/hooks.json"),
  JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: '. "${PLUGIN_ROOT}/hooks/hook.sh"', timeout: 3 }],
        },
      ],
    },
  }),
);
await writeFile(
  join(workspace, ".agents", "plugins", "marketplace.json"),
  JSON.stringify({
    name: "gui-p0",
    plugins: [
      {
        name: "hello",
        source: { source: "local", path: "./packages/hello" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  }),
);
const sourceRoot = resolve(gui, "../..");
const sourceFiles = {};
for (const path of new Set(
  execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean),
)) {
  if (/^(core\/|runtime\/|clients\/|scripts\/|schemas\/|Cargo\.|Makefile|upstream\/)/.test(path))
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(sourceRoot, path)))
      .digest("hex");
}
const sourceDiffSha256 = createHash("sha256")
  .update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: sourceRoot }))
  .digest("hex");
const requests = [],
  checks = [],
  errors = [];
const model = createServer(async (req, res) => {
  let body = "";
  for await (const p of req) body += p;
  const payload = JSON.parse(body);
  if (respondToSessionName(payload, res)) return;
  requests.push(payload);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "GUI_PLUGIN_SETUP_OK" }, finish_reason: null }],
      }) +
      "\n\n" +
      "data: " +
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
await writeFile(
  join(userHome, ".areal", "config.toml"),
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: userHome,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_CONFIG: join(userHome, ".areal", "config.toml"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_HOME: join(scratch, "registry"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal"),
  NO_PROXY: [env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
});
const coreBinary = env.AREAL_CORE_BIN,
  coreSha256 = createHash("sha256")
    .update(await readFile(coreBinary))
    .digest("hex");
let app,
  page,
  failure,
  passed = false;
const button = (n) => page.getByRole("button", { name: n, exact: true });
let host, stopRequestId, loss;
const writes = [];
const originalReceipts = [];
function observePluginSocket(socket) {
  const remote = socket.connectToServer();
  const replies = new Map();
  socket.onMessage((message) => {
    const { id, method, params } = JSON.parse(message.toString());
    const request =
      method === "manage.command" || method === "manage.read"
        ? params
        : method === "desktop.command" && params.command === "manage"
          ? params.request
          : null;
    if (request?.operation === "pluginSubmission" && request.requestId === loss?.requestId)
      replies.set(id, { kind: "lookup", loss });
    if (request?.operation && request.operation === loss?.operation) {
      writes.push({ operation: request.operation, requestId: request.requestId });
      if (!loss.requestId) {
        loss.requestId = request.requestId;
        replies.set(id, { kind: "drop", loss });
      }
    }
    remote.send(message);
  });
  remote.onMessage((message) => {
    const { id, result, error } = JSON.parse(message.toString());
    const matched = replies.get(id);
    replies.delete(id);
    if (matched?.kind === "drop") {
      if (result && !error && result.submissionUnknown !== true) {
        matched.loss.dropped = true;
        void Promise.allSettled([socket.close(), remote.close()]);
        return;
      }
      matched.loss.failed = error?.code ?? result?.admissionState ?? "INVALID_RESPONSE";
    }
    if (matched?.kind === "lookup") matched.loss.lookup = result;
    socket.send(message);
  });
}
async function recoverPlugin(operation, trigger) {
  loss = { operation };
  const mark = writes.length;
  await button(trigger).click();
  await until(() => loss.dropped || loss.failed, `original ${operation} replied`);
  assert.equal(loss.dropped, true, String(loss.failed));
  await button("查看插件提交").click();
  const original = await until(
    () => loss.lookup?.confirmed && loss.lookup,
    "original plugin receipt",
  );
  originalReceipts.push({ operation, requestId: loss.requestId, receipt: original });
  assert.equal(original.status, "completed");
  assert.ok(original.result, "The original completed native receipt has its typed result");
  assert.deepEqual(writes.slice(mark), [{ operation, requestId: loss.requestId }]);
}
async function call(name, params) {
  const r = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), {
    name,
    params,
  });
  assert(r.ok, JSON.stringify(r));
  return r.value;
}
async function pluginState(predicate, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const row = (
      await call("manage", {
        projectId: await page.getByTestId("areal-workbench").getAttribute("data-project-id"),
        operation: "plugins",
      })
    ).data.find((x) => x.id === "hello@gui-p0");
    if (predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Error("timeout: " + label);
}
async function settings() {
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", { name: "个人", exact: true })
    .click();
  await button("查看插件 hello@gui-p0").click();
}
console.log("Plugin hooks evidence:", scratch);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => errors.push(e.message));
  const ready = page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]');
  await ready.waitFor({ timeout: 120_000 });
  host = await until(() => readFixtureHost(env), "original isolated Host");
  await page.routeWebSocket(/\/host\/socket$/, observePluginSocket);
  await page.evaluate(() =>
    localStorage.setItem(
      "areal-gui:application-preferences",
      JSON.stringify({
        locale: "zh-CN",
        nextPromptSuggestions: false,
      }),
    ),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready.waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await openProjectInDesktop(app, page, workspace);
  const projectId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
  assert.ok(projectId);
  await settings();
  await button("安装").click();
  await page.getByRole("region", { name: "来源解析与预览", exact: true }).waitFor();
  await button("安装到用户").click();
  await button("卸载插件").waitFor();
  assert.equal(requests.length, 0, "installation cannot run setup/model");
  checks.push("GUI discovers unmodified package and installs through Core without model execution");
  const hooks = page.getByRole("region", { name: "插件钩子", exact: true });
  await hooks.getByText("UserPromptSubmit", { exact: false }).first().waitFor();
  assert(await button("信任并启用当前钩子").isDisabled());
  assert.equal(
    (await call("manage", { projectId, operation: "pluginHooks" })).data.find(
      (r) => r.pluginId === "hello@gui-p0",
    ).definitions[0].trusted,
    false,
  );
  const readOnlyConsent = hooks.getByRole("checkbox", {
    name: /也允许以上命令钩子在只读子任务中运行/,
  });
  assert.equal(await readOnlyConsent.isChecked(), false);
  assert(await readOnlyConsent.isDisabled());
  await hooks.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(scratch, "hook-review.png"), animations: "disabled" });
  await page
    .getByRole("checkbox", {
      name: "我已审阅以上安装包摘要和全部钩子，允许当前定义运行。",
    })
    .check();
  await recoverPlugin("pluginHooksConfigure", "信任并启用当前钩子");
  loss = undefined;
  await button("刷新钩子").click();
  await hooks.getByText("当前定义已获信任", { exact: false }).waitFor();
  checks.push(
    "actual hook content/digests render, explicit review gates trust and lost trust response recovers via original receipt without replay",
  );
  assert.equal(
    (await call("manage", { projectId, operation: "pluginHooks" })).data.find(
      (r) => r.pluginId === "hello@gui-p0",
    ).definitions[0].readOnlyCommandTrusted,
    false,
  );
  checks.push("normal GUI trust and lost-reply recovery never imply read-only command consent");
  await hooks
    .getByRole("checkbox", {
      name: "我已审阅以上安装包摘要和全部钩子，允许当前定义运行。",
    })
    .check();
  await readOnlyConsent.check();
  await button("信任并启用当前钩子").click();
  await hooks.getByText("当前定义已单独获准", { exact: false }).waitFor();
  assert.equal(
    (await call("manage", { projectId, operation: "pluginHooks" })).data.find(
      (r) => r.pluginId === "hello@gui-p0",
    ).definitions[0].readOnlyCommandTrusted,
    true,
  );
  await hooks.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(scratch, "hook-readonly-consent.png"),
    animations: "disabled",
  });
  checks.push(
    "separate visible GUI read-only child consent reaches Core for the reviewed definitions",
  );

  await recoverPlugin("pluginSetup", "运行设置");
  loss = undefined;
  await button("打开设置对话").waitFor();
  await button("打开设置对话").click();
  await page.getByTestId("chat-input").waitFor();
  await page.getByText("GUI_PLUGIN_SETUP_OK", { exact: true }).waitFor();
  const setupThread = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert(setupThread);
  await page.getByTestId("task-item-" + setupThread).waitFor();
  assert(requests.some((r) => JSON.stringify(r.messages).includes("GUI_PLUGIN_SETUP_BODY_MARKER")));
  await selectConversation(page, setupThread);
  assert.equal(requests.length, 1, "receipt recovery must not replay setup");
  const history = await readCoreThread({
    binary: coreBinary,
    env,
    gui,
    workspace,
    threadId: setupThread,
  });
  const hook = history.desktop.hookRuns.find((run) => run.event === "UserPromptSubmit");
  assert.equal(hook?.outcome, "succeeded", JSON.stringify(hook));
  assert(requests.some((r) => JSON.stringify(r.messages).includes("GUI_HOOK_CONTEXT")));
  checks.push(
    "trusted hook executes through real Runtime and appears in the ordinary model request",
  );
  checks.push(
    "explicit setup enters ordinary accessible chat with packaged skill body and sidebar navigation",
  );
  checks.push(
    "GUI recovers completed setup after dropping its native Host reply using real Core receipt without replay",
  );
  await page.screenshot({ path: join(scratch, "setup-chat.png"), animations: "disabled" });
  await settings();
  await button("撤销钩子信任并停用").click();
  await button("刷新钩子").click();
  await page
    .getByRole("region", { name: "插件钩子" })
    .getByText("尚未授予信任", { exact: false })
    .waitFor();
  assert.equal(
    (await call("manage", { projectId, operation: "pluginHooks" })).data.find(
      (r) => r.pluginId === "hello@gui-p0",
    ).definitions[0].readOnlyCommandTrusted,
    false,
  );
  checks.push(
    "native revoke reaches authoritative Core definition trust and removes independent read-only consent",
  );
  await page.screenshot({ path: join(scratch, "hook-revoked.png"), animations: "disabled" });
  await button("管理启用范围").click();
  await button("在用户范围停用").click();
  await pluginState((r) => r?.enabled === false, "disable committed");
  const current = await call("manage", { projectId, operation: "plugins" });
  assert.equal(current.data.find((x) => x.id === "hello@gui-p0").enabled, false);
  checks.push("GUI disable reaches same Core state");
  await button("在用户范围启用").click();
  await pluginState((r) => r?.enabled === true, "enable committed");
  await button("卸载插件").click();
  await pluginState((r) => r?.installed === false, "uninstall committed");
  const removed = await call("manage", { projectId, operation: "plugins" });
  assert.equal(removed.data.find((x) => x.id === "hello@gui-p0").installed, false);
  checks.push("GUI enable/uninstall completes through management receipts");
  assert.deepEqual(errors, []);
  passed = true;
} catch (e) {
  failure = { message: e.message, stack: e.stack };
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, e);
} finally {
  const electronPid = app?.process().pid;
  host ??= await readFixtureHost(env);
  if (host) {
    try {
      const current = await readFixtureHost(env);
      assert.equal(current?.hostId, host.hostId);
      assert.equal(current.generation, host.generation);
      const receipt = await stopFixtureHost(coreBinary, env.AREAL_HARNESS_SERVICE_HOME, scratch);
      assert.equal(receipt?.state, "completed");
      stopRequestId = receipt.requestId;
    } catch (error) {
      errors.push(`Host stop: ${error.stack}`);
    }
  }
  try {
    if (app) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0 });
      });
      await closeSmokeApplication(app, 60_000);
    }
  } catch (error) {
    errors.push(`Electron quit: ${error.stack}`);
  }
  try {
    await assertApplicationStopped(coreBinary, env, { pid: electronPid, hostPid: host?.pid });
  } catch (error) {
    errors.push(`process exits: ${error.stack}`);
  }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    checks,
    errors,
    failure,
    scratch,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
    sourceFiles,
    sourceDiffSha256,
    core: {
      binary: coreBinary,
      sha256: coreSha256,
      unchanged:
        createHash("sha256")
          .update(await readFile(coreBinary))
          .digest("hex") === coreSha256,
    },
    modelRequests: requests.length,
    electronPid,
    hostPid: host?.pid,
    stopRequestId,
    writes,
    originalReceipts,
    scope:
      "source Electron/Core/Runtime P2 hook UI; deterministic external model; no packaged/provider acceptance",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
