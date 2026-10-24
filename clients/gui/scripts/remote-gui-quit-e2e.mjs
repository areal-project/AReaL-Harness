import { selectRemoteTransport, requireBrowserTransport } from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
await requireBrowserTransport(transport, "remote-gui-quit-e2e");
import assert from "node:assert/strict";
import {selectConversation,captureSmokeFailure} from "./smoke-navigation.mjs";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const prompt = "RC13 approval continuity";
const effect = "approved once";
function modelStage(body) {
  assert.equal(body.stream, true);
  const messages = body.messages ?? [];
  // Core wraps areal_context as user-role text for Chat Completions.
  // Preserve original user-Turn scoping while excluding that explicit wrapper.
  const last = messages.findLastIndex((message) => message.role === "user" &&
    !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):\n")));
  assert.ok(
    JSON.stringify(messages[last]?.content).includes(prompt),
    "only original GUI turn may call model",
  );
  const tools = messages.slice(last + 1).filter((message) => message.role === "tool");
  assert.ok(tools.length <= 1, "one filesystem result");
  return tools.length ? "completion" : "approval";
}
function modelDelta(stage) {
  return stage === "approval"
    ? {
        tool_calls: [
          {
            index: 0,
            id: "rc13-write",
            type: "function",
            function: {
              name: "fs_create",
              arguments: JSON.stringify({ path: "approved.txt", text: effect }),
            },
          },
        ],
      }
    : { content: "RC13 original turn completed." };
}
// 纯模型检查不载入 Electron，也不启动网络或服务。
if (process.argv.includes("--self-test")) {
  const first = { stream: true, messages: [{ role: "user", content: prompt }] };
  assert.equal(modelStage(first), "approval");
  assert.equal(
    modelStage({ ...first, messages: [...first.messages, { role: "tool", content: "created" }] }),
    "completion",
  );
  assert.throws(() =>
    modelStage({ ...first, messages: [{ role: "user", content: "unexpected" }] }),
  );
  assert.throws(() =>
    modelStage({ ...first, messages: [...first.messages, { role: "tool" }, { role: "tool" }] }),
  );
  assert.deepEqual(JSON.parse(modelDelta("approval").tool_calls[0].function.arguments), {
    path: "approved.txt",
    text: effect,
  });
  console.log("PASS: deterministic two-stage model and rejection checks (source-only)");
} else await run();

async function run() {
  const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const desktop = join(gui, "app");
  const require = createRequire(join(desktop, "package.json"));
  const { _electron: electron, chromium } = require("playwright-core");
  const scratch = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "rc13-quit-"),
  );
  const workspace = join(scratch, "workspace");
  await mkdir(workspace);
  await mkdir(join(scratch, "user-home"));
  const stages = [],
    modelErrors = [],
    checks = [];
  const report = {
    status: "failed",
    scratch,
    checks,
    providerStages: stages,
    coreRpcDispatchCount: "not observable through public GUI/PWA interfaces",
  };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const stage = modelStage(JSON.parse(raw));
      assert.equal(stage, stages.length === 0 ? "approval" : "completion");
      assert.ok(stages.length < 2, "no provider replay");
      stages.push(stage);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [modelDelta(stage), null],
        [{}, stage === "approval" ? "tool_calls" : "stop"],
      ])
        response.write(
          `data: ${JSON.stringify({ id: "rc13", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    } catch (error) {
      modelErrors.push(error.message);
      response.writeHead(500);
      response.end("fixture rejected unexpected model request");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(scratch, "config.toml"),
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(
    join(scratch, "desktop.json"),
    JSON.stringify({
      profiles: [
        {
          id: "standard",
          revision: "v1",
          displayName: "RC13",
          instructions: "Complete the task",
          approvalTools: ["fs_create"],
        },
      ],
    }),
  );
  const env = {
    ...process.env,
    AREAL_GUI: "workbench",
    AREAL_BACKEND: "areal",
    AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
    AREAL_CORE_HOME: join(scratch, "core"),
    AREAL_CORE_USER_HOME: join(scratch, "user-home"),
    AREAL_HARNESS_HOME: join(scratch, "runtime"),
    AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
    AREAL_CORE_CONFIG: join(scratch, "config.toml"),
    AREAL_CORE_DESKTOP_CONFIG: join(scratch, "desktop.json"),
    AREAL_GUI_USER_DATA: join(scratch, "electron"),
  };
  for (const key of [
    "AREAL_CORE_WORKSPACE",
    "AREAL_HARNESS_CONFIG",
    "AREAL_HARNESS_TOOL_EXTENSIONS",
    "AREAL_CORE_WORKGROUP_POLICY",
    "AREAL_CORE_WORKGROUP_TOOLCHAIN",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  for (const key of ["NO_PROXY", "no_proxy"])
    env[key] = [env[key], "127.0.0.1", "localhost"].filter(Boolean).join(",");
  const executablePath = process.env.AREAL_GUI_EXECUTABLE || require("electron");
  if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
  let app, page, browser, remote, projectId, threadId, adapter;
  const json = async (path) => JSON.parse(await readFile(path, "utf8"));
  const exists = async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const until = async (predicate, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout: ${label}`);
  };
  const state = () => page.evaluate(() => window.arealDesktop.snapshot());
  const call = async (name, params = {}) => {
    const result = await page.evaluate(
      async ({ name, params }) => window.arealDesktop.command(name, params),
      { name, params },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const project = (snapshot) => snapshot.projects.find((value) => value.id === projectId);
  const thread = (snapshot) => project(snapshot)?.state?.threads[threadId];
  const button = (name) => page.getByRole("button", { name, exact: true });
  const launch = async () => {
    app = await electron.launch({
      executablePath,
      args: process.env.AREAL_GUI_EXECUTABLE ? [] : [desktop],
      env,
      timeout: 120000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  };
  const quit = async () => {
    const pid = app.process().pid;
    await app.close();
    app = null;
    await until(() => !alive(pid), "normal GUI process exit");
  };
  // 只读取本测试独占注册目录的身份；不输出端点或凭据。
  const generation = async () => {
    const directory = join(env.AREAL_HARNESS_SERVICE_HOME, "services");
    const records = [];
    for (const name of await readdir(directory)) {
      const path = join(directory, name, "service.json");
      if (await exists(path)) {
        const record = await json(path);
        if (record.workspace === workspace) records.push(record);
      }
    }
    assert.equal(records.length, 1, "exactly one Core service for the isolated project workspace");
    assert.ok(records[0].generation);
    return records[0].generation;
  };
  const descriptorPath = join(env.AREAL_CORE_HOME, "service.json");
  const sameOwner = async () => {
    const current = await json(descriptorPath);
    assert.equal(current.pid, adapter.pid);
    assert.equal(current.identity, adapter.identity);
    assert.ok(alive(adapter.pid));
    assert.equal(await generation(), report.coreGeneration);
  };
  try {
    await launch();
    await app.evaluate(({ dialog }, workspace) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    }, workspace);
    await button("不在项目中工作").click();
    await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
    await until(
      async () => (await state()).projects.find(project => project.root === workspace)?.state?.connected,
      "isolated project ready",
    );
    projectId = (await state()).projects.find(project => project.root === workspace).id;
    await button("设置").click();
    await button("手机连接").click();
    // 生产后台 safeStorage gate 是唯一 oracle；不替换加密实现。
    try {
      await call("remoteControl", { operation: "enableDirect" });
    } catch (error) {
      report.status = "blocked";
      report.blockedAt = "production enableDirect gate";
      throw error;
    }
    await button("生成配对链接").click();
    const invite = await page.getByRole("textbox", { name: "配对链接", exact: true }).inputValue();
    browser = await chromium.launch({
      executablePath:
        process.env.AREAL_CHROME_EXECUTABLE ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    remote = await browser.newPage();
    await remote.goto(invite);
    await remote.getByRole("button", { name: "连接电脑", exact: true }).click();
    await remote
      .getByRole("status")
      .getByText(/等待桌面确认/)
      .waitFor();
    const pending = (await call("remoteControl", { operation: "status" })).pending;
    assert.equal(pending.length, 1);
    const approval = page.getByRole("group", { name: `确认设备 ${pending[0].id}`, exact: true });
    await approval.getByLabel("workspace", { exact: true }).check();
    await approval.getByRole("radio", {name:"可操作",exact:true}).check();
    await approval.getByRole("button", { name: "确认配对", exact: true }).click();
    await remote
      .getByRole("status")
      .getByText(/已连接/)
      .waitFor();
    await button("返回应用").click();
    ({ threadId } = await call("create", {
      projectId,
      profile: { id: "standard", revision: "v1" },
    }));
    await selectConversation(page,threadId);
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});
    await call("send", { projectId, threadId, text: prompt });
    const interaction = await until(
      async () =>
        project(await state())?.state?.interactions[threadId]?.data?.find(
          (item) => item.status === "pending",
        ),
      "original approval",
    );
    const original = thread(await state());
    assert.equal(original.turns.length, 1);
    const turnId = original.turns[0].id;
    assert.equal(interaction.turnId, turnId);
    report.original = { projectId, threadId, turnId, interactionId: interaction.requestId };
    adapter = await json(descriptorPath);
    report.adapterPid = adapter.pid;
    report.adapterIdentity = adapter.identity;
    report.coreGeneration = await generation();
    const projectButton=remote.getByRole("button",{name:"workspace",exact:true});
    if(await projectButton.getAttribute("aria-expanded")==="true")await projectButton.click();
    await projectButton.click();
    await remote.locator(`.remote-session-row[data-thread-id="${threadId}"]`).click();
    await remote.getByRole("button",{name:"返回项目列表",exact:true}).click();
    await remote.getByRole("button", { name: "审阅待处理事项", exact: true }).click();
    await until(async () => {
      if (
        (await remote.locator("#attention-more").isVisible()) &&
        (await remote.locator("#attention-more").isEnabled())
      )
        await remote.locator("#attention-more").click();
      return !(await remote.locator("#attention-allow").isDisabled());
    }, "full authoritative review");
    assert.equal(
      await remote.locator("#attention-target").textContent(),
      `Thread ${threadId} · Turn ${turnId} · 交互 ${interaction.requestId}`,
    );
    assert.match(await remote.locator("#attention-body").textContent(), /approved.txt/);
    assert.equal(await exists(join(workspace, "approved.txt")), false);
    assert.deepEqual(stages, ["approval"]);
    await quit();
    await sameOwner();
    checks.push(
      "normal GUI exit preserves production adapter PID and Core generation with original approval pending",
    );
    await remote.locator("#attention-refresh").click();
    await until(
      async () => !(await remote.locator("#attention-allow").isDisabled()),
      "review after GUI exit",
    );
    await remote.locator("#attention-allow").click();
    await remote.getByRole("button",{name:"关闭审阅",exact:true}).click();
    await remote.locator(`.remote-session-row[data-thread-id="${threadId}"]`).click();
    await until(async () =>
      await remote.locator(`#remote-session-ui [data-turn-id="${turnId}"]`).getAttribute('data-turn-status') === 'completed',
      "original remote turn completed");
    assert.equal(await remote.locator("#remote-session-ui [data-turn-id]").count(), 1);
    assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), effect);
    assert.deepEqual(stages, ["approval", "completion"]);
    assert.deepEqual(modelErrors, []);
    await sameOwner();
    checks.push("PWA allowOnce after GUI exit completes the original turn and filesystem effect");
    await launch();
    await until(async () => project(await state())?.state?.connected, "reopened GUI connected");
    await call("open", { projectId, threadId });
    await until(
      async () => thread(await state())?.turns[0]?.status === "completed",
      "original history restored",
    );
    const restored = thread(await state());
    assert.deepEqual(
      restored.turns.map((turn) => turn.id),
      [turnId],
    );
    const tools = restored.turns[0].items.filter(
      (item) => item.type === "dynamicToolCall" && item.tool === "fs_create",
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, "completed");
    assert.equal(tools[0].success, true);
    const outcomes = Object.values(
      await json(join(env.AREAL_CORE_HOME, `${projectId}-outcomes.json`)),
    ).filter((value) => value.remote);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].method, "areal/interaction/respond");
    assert.equal(outcomes[0].accepted, true);
    assert.equal(outcomes[0].threadId, threadId);
    assert.equal(outcomes[0].turnId, turnId);
    report.remoteCommand = {
      commandId: outcomes[0].remote.commandId,
      persistedAcceptedCount: outcomes.length,
    };
    assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), effect);
    await sameOwner();
    assert.deepEqual(stages, ["approval", "completion"]);
    checks.push(
      "reopen restores one original turn and one completed fs_create without provider replay",
    );
    await until(async () => {
      const status = await call("serviceStatus");
      return !status.busy && !status.activeCommands && !status.starting && !status.providerUpdating;
    }, "service settled");
    // 仅为正常公开停止对话框提供显式选择，不改变服务实现。
    await app.evaluate(({ dialog }) => {
      const previous = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) =>
        args.at(-1).message === "停止共享后台服务？"
          ? { response: 1 }
          : previous.apply(dialog, args);
    });
    assert.equal((await call("stopService")).stopped, true);
    assert.equal(
      (await json(join(env.AREAL_GUI_USER_DATA, "service-control.json"))).state,
      "stopped",
    );
    await until(
      async () => !(await exists(descriptorPath)) && !alive(adapter.pid),
      "adapter stopped and descriptor removed",
    );
    await remote
      .getByRole("status")
      .getByText(/已断开|不可用/)
      .waitFor();
    await quit();
    await launch();
    await until(
      async () => JSON.stringify(await state()).includes("后台服务已停止"),
      "persisted stop blocks automatic start",
    );
    assert.equal(await exists(descriptorPath), false);
    assert.equal(alive(adapter.pid), false);
    assert.deepEqual(stages, ["approval", "completion"]);
    assert.deepEqual(modelErrors, []);
    checks.push(
      "public stopService persists stopped intent, disconnects Remote and prevents automatic restart",
    );
    report.status = "passed";
  } catch (error) {
    report.error = error.message.replace(/#(?:host|invite)=[^\s"']+/g, "#[redacted]");
    report.modelErrors = modelErrors;
    if(page)await captureSmokeFailure(page,scratch,error);
    process.exitCode = report.status === "blocked" ? 2 : 1;
  } finally {
    // 失败时保留独占 scratch 与 PID 供人工恢复，绝不强杀未知或未结算工作。
    if (app)
      await quit().catch((error) => {
        report.cleanupError = error.message;
        report.status = "failed";
        process.exitCode = 1;
      });
    await browser?.close().catch((error) => {
      report.browserCleanupError = error.message;
      report.status = "failed";
      process.exitCode = 1;
    });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    report.adapterStillAlive = adapter ? alive(adapter.pid) : await exists(descriptorPath);
    if (report.adapterStillAlive)
      report.cleanupRequired =
        "Inspect this isolated service and stop explicitly after settling work; scratch retained.";
    await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
