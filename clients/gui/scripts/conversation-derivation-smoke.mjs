import { makeTempDir } from "./support/temp.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
// M1/M2 公开路径：集成且 GUI、Core 构建完成后运行一次。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
import { closeRecordedSmokeApplication } from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const evidenceRoot = join(root, ".scratch", "gui-evidence");
await mkdir(evidenceRoot, { recursive: true });
const scratch = await mkdtemp(join(evidenceRoot, "conversation-derivation-"));
// Unix socket 注册路径使用短的隔离目录；录屏和日志仍留在持久证据目录。
const serviceRegistry = await makeTempDir("scf-svc-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user-home");
await mkdir(workspace);
await mkdir(userHome);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const fixturePath = join(workspace, "shared.txt");
await writeFile(fixturePath, "current shared workspace\n");
await writeFile(
  join(workspace, "raw-result-evidence.txt"),
  Array.from({ length: 150 }, (_, row) => `finished raw evidence row ${row}\n`).join(""),
);
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const workspaceBefore = await hash(fixturePath);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const head = `SCF_HEAD_${randomUUID()}`;
const future = `SCF_FUTURE_${randomUUID()}`;
const forkQuestion = `SCF_BRANCH_${randomUUID()}`;
const activeQuestion = `SCF_ACTIVE_${randomUUID()}`;
const unicodeExcerpt = `旁路选区🌊汉字_${randomUUID()}`;
const sideQuestion = `SCF_SIDE_${randomUUID()}`;
const sideFollowUp = `SCF_SIDE_FOLLOW_${randomUUID()}`;
const sideFileQuestion = `SCF_SIDE_FILE_${randomUUID()}`;
const lateSentinel = `SCF_LATE_${randomUUID()}`;
const mainDraftSentinel = `SCF_MAIN_DRAFT_${randomUUID()}`;
const capacitySourceQuestion = `SCF_CAPACITY_SOURCE_${randomUUID()}`;
const capacitySideQuestion = `SCF_CAPACITY_SIDE_${randomUUID()}`;
const streamExcerpt = `SCF_STREAM_${randomUUID()}`;
const heldResponses = new Map();
const toolStarted = join(workspace, "source-tool-started.txt");
const toolRelease = join(workspace, "source-tool-release.txt");
const requests = [];
const events = [];
const checks = [];
const frames = [];
const pageErrors = [];
const electronStderr = [];
let app,
  page,
  server,
  passed = false,
  failure;
let sourceThreadId,
  targetThreadId,
  anchorTurnId,
  projectId,
  sandbox,
  sideThreadId,
  windowBounds,
  videoPath,
  restartVideoPath,
  firstMutations = [];
let activeTurnId, nestedThreadId;

const sse = (answer) =>
  [
    {
      id: "scf-fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: answer }, finish_reason: null }],
    },
    {
      id: "scf-fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("") + "data: [DONE]\n\n";
const toolSse = (name, args) =>
  [
    {
      id: "scf-tool",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `scf-call-${randomUUID()}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "scf-tool",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("") + "data: [DONE]\n\n";

// Use the production effect catalog instead of a second, drifting read whitelist.
const { commandSemantics, validateCommand } = require("@areal/workbench/desktop-contract");
const isNonMutatingObservation = (entry, owner) => {
  if (
    ![owner?.projectId, owner?.sourceThreadId, owner?.sideThreadId].every(
      (id) => typeof id === "string" && id.length > 0,
    )
  )
    return false;
  try {
    validateCommand(entry.command, entry.parameters);
    if (
      commandSemantics(entry.command, entry.parameters).effect !== "read" ||
      entry.mutation === true
    )
      return false;
    if (entry.parameters.projectId !== undefined && entry.parameters.projectId !== owner.projectId)
      return false;
    return [entry.parameters.threadId, entry.parameters.sourceThreadId].every(
      (id) => id === undefined || [owner.sourceThreadId, owner.sideThreadId].includes(id),
    );
  } catch {
    return false;
  }
};
const observationOwner = { projectId: "project", sourceThreadId: "source", sideThreadId: "side" };
const observationHistory = {
  command: "history",
  parameters: { projectId: "project", threadId: "side", viewId: "view", operation: "acquire" },
};
assert.ok(
  isNonMutatingObservation(observationHistory, observationOwner),
  "history view ownership is observation, not a business mutation",
);
for (const entry of [
  ...["send", "configure", "queueEdit", "steer", "fork"].map((command) => ({
    command,
    parameters: {
      projectId: "project",
      threadId: "source",
      requestId: "00000000-0000-4000-8000-000000000001",
    },
  })),
  ...["start", "send"].map((operation) => ({
    command: "side",
    parameters: {
      projectId: "project",
      threadId: "side",
      sourceThreadId: "source",
      operation,
      text: "mutation",
    },
  })),
  ...["mcpFormRespond", "mcpExtensionCall", "mcpConnect", "contextCompact", "processStart"].map(
    (operation) => ({
      command: "manage",
      parameters: { projectId: "project", threadId: "source", operation },
    }),
  ),
  { command: "feedback", parameters: { operation: "preference", enabled: true } },
  { command: "trajectory", parameters: { operation: "retry" } },
  { command: "unknown", parameters: {} },
  { ...observationHistory, parameters: { ...observationHistory.parameters, projectId: "other" } },
  { ...observationHistory, parameters: { ...observationHistory.parameters, threadId: "other" } },
  {
    ...observationHistory,
    parameters: { ...observationHistory.parameters, requestId: "mutation" },
  },
  {
    command: "manage",
    parameters: {
      projectId: "project",
      threadId: "other",
      operation: "context",
      offset: 0,
      limit: 1,
    },
  },
])
  assert.equal(isNonMutatingObservation(entry, observationOwner), false, JSON.stringify(entry));

// Effective snapshots also contain resolved provider/plugin metadata; model ownership
// is the durable configuration revision and the user's selected configuration.
const modelConfiguration = (config) => {
  assert.ok(config && Number.isSafeInteger(config.revision), "Core configuration is required");
  const { revision, model, defaultModelRevision, parameters, profile, options, selectedSkills } =
    config;
  return structuredClone({
    revision,
    model,
    defaultModelRevision,
    parameters,
    profile,
    options,
    selectedSkills,
  });
};

async function state() {
  return withSmokeDeadline("renderer snapshot", () =>
    page.evaluate(() => window.arealDesktop.snapshot()),
  );
}

async function recordMainFailures(application) {
  // 原生异常弹窗可能阻塞 IPC；先落盘错误栈，保留默认异常处理与失败事实。
  await application.evaluate(
    (_, path) => {
      process.on("uncaughtExceptionMonitor", (error) => {
        process.getBuiltinModule("fs").appendFileSync(path, `${error.stack ?? error}\n`);
      });
    },
    join(scratch, "main-exceptions.log"),
  );
}
const project = (snapshot) => snapshot.projects.find((p) => p.root === workspace && !p.projectless);
async function selectMessageExcerpt(body, excerpt, keyboard = false) {
  await body.evaluate(async (element) => {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  if (keyboard) {
    await page.bringToFront();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await body.evaluate((element) => {
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    });
  }
  const selected = await body.evaluate(
    (element, { text, keyboard }) => {
      // 流式动画会把文字拆进多个 span；选区按完整正文定位，再映射到原生 Range。
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      const start = nodes
        .map((node) => node.textContent)
        .join("")
        .indexOf(text);
      if (start < 0 || !text.length) throw Error("source excerpt missing");
      const end = start + text.length;
      const range = document.createRange();
      let offset = 0,
        started = false;
      for (const node of nodes) {
        const next = offset + node.textContent.length;
        if (!started && start < next) {
          range.setStart(node, start - offset);
          started = true;
        }
        if (started && end <= next) {
          range.setEnd(node, end - offset);
          break;
        }
        offset = next;
      }
      const selectedText = range.toString();
      // 非编辑正文的键盘扩选需要已有非空选区；以一个字符为起点保留真实 Shift+方向键验证。
      if (keyboard) {
        const initialEnd = start + [...text][0].length;
        let consumed = 0;
        for (const node of nodes) {
          const next = consumed + node.textContent.length;
          if (initialEnd <= next) {
            range.setEnd(node, initialEnd - consumed);
            break;
          }
          consumed = next;
        }
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!keyboard) element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selectedText;
    },
    { text: excerpt, keyboard },
  );
  assert.equal(
    selected,
    excerpt,
    "native selection preserves the complete source excerpt across text nodes",
  );
  if (keyboard) {
    assert.equal(
      await page.evaluate(() => window.getSelection().toString()),
      [...excerpt][0],
      "keyboard extension starts from one selected character",
    );
    await page.keyboard.down("Shift");
    try {
      for (const _character of [...excerpt].slice(1)) await page.keyboard.press("ArrowRight");
      await body.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    } finally {
      await page.keyboard.up("Shift");
    }
    assert.equal(
      await page.evaluate(() => window.getSelection().toString()),
      excerpt,
      "keyboard selection preserves Unicode text",
    );
    await page.getByTestId("transcript-selection-actions").waitFor();
  }
}
async function until(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const snapshot = await state();
    if (await predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function untilFile(path, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function shot(name) {
  await page.screenshot({ path: join(scratch, name), scale: "css", animations: "disabled" });
  frames.push(name);
}
async function composeText(input, text, label, append = false) {
  const prefix = append
    ? await input.evaluate((element) =>
        element.isContentEditable ? element.innerText : element.value,
      )
    : "";
  if (!append) await input.fill("");
  await input.focus();
  if (append)
    await input.evaluate((element) => {
      const selection = window.getSelection();
      selection.selectAllChildren(element);
      selection.collapseToEnd();
    });
  const before = requests.length;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.debugger.attach("1.3"),
  );
  const command = (method, params) =>
    app.evaluate(
      async ({ BrowserWindow }, { method, params }) =>
        BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand(method, params),
      { method, params },
    );
  try {
    // Chromium 生成真实 composition 事件；候选确认键不应触发提交。
    await command("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await input.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(requests.length, before, `${label}: candidate Enter must not submit`);
    await command("Input.insertText", { text });
    assert.equal(
      await input.evaluate((element) =>
        element.isContentEditable ? element.innerText : element.value,
      ),
      prefix + text,
    );
    assert.ok(
      await input.evaluate((element) => document.activeElement === element),
      `${label}: focus stays in editor`,
    );
  } finally {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.debugger.detach(),
    );
  }
}
async function send(text, threadId) {
  const previousCount = threadId
    ? (project(await state())?.state?.threads?.[threadId]?.turns?.length ?? 0)
    : 0;
  const previousRequests = requests.length;
  await page.getByTestId("chat-input").fill(text);
  await page
    .locator(".composer-dock:not(.side-chat-composer)")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await page.waitForFunction((id) => {
    const active = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return active && (!id || active === id);
  }, threadId);
  const activeId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(activeId);
  if (threadId) assert.equal(activeId, threadId);
  const snapshot = await until((s) => {
    const turns = project(s)?.state?.threads?.[activeId]?.turns;
    return (
      turns?.length > previousCount &&
      turns.at(-1)?.status === "completed" &&
      requests.length > previousRequests
    );
  }, `completed send ${text}`);
  const turns = project(snapshot).state.threads[activeId].turns;
  assert.ok(turns.at(-1)?.id);
  return { threadId: activeId, turnId: turns.at(-1).id };
}
async function stopService(env) {
  const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
  const { DesktopLifecycle } = require(join(desktop, "src/core/lifecycle.cjs"));
  const { executeCore } = require(join(desktop, "src/core/core-process.cjs"));
  const service = async (args) =>
    JSON.parse(
      (
        await executeCore(binary, ["service", ...args, "--json"], {
          env: { ...env, AREAL_HARNESS_SERVICE_HOME: serviceRegistry },
          timeout: 30000,
        })
      ).stdout,
    );
  const cleanup = {
    registry: serviceRegistry,
    stopped: false,
    stopOutcomeUnknown: false,
    instances: [],
    errors: [],
  };
  events.push({ serviceCleanup: cleanup });
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") cleanup.errors.push(error.message);
  }
  if (metadata)
    try {
      const connection = new ServiceConnection();
      try {
        await connection.connect(metadata);
        await connection.request("hello", {
          protocol: metadata.protocol,
          identity: metadata.identity,
        });
        const lifecycle = new DesktopLifecycle({
          connection,
          metadata,
          home: join(scratch, "core"),
          forUpdate: false,
          notify: async () => ({ response: 1 }),
        });
        const observed = await lifecycle.observe();
        const instances = await service(["list"]);
        assert.ok(Array.isArray(instances), "isolated service list must be an array");
        for (const target of observed.targets)
          if (target.serviceId !== null) {
            assert.ok(
              instances.some(
                (instance) =>
                  instance.serviceId === target.serviceId &&
                  instance.generation === target.generation,
              ),
              "desktop cleanup target must belong to the isolated registry generation",
            );
          }
        const result = await lifecycle.stop({ mode: "cancel", observed });
        assert.equal(result.kind, "exited", "desktop lifecycle exit must be confirmed");
      } finally {
        connection.close();
      }
    } catch (error) {
      cleanup.stopOutcomeUnknown = error.submissionUnknown === true;
      cleanup.errors.push(error.message);
    }
  try {
    const instances = await service(["list"]);
    assert.ok(Array.isArray(instances), "isolated service list must be an array");
    for (const instance of instances)
      if (instance.state !== "stopped" && !cleanup.stopOutcomeUnknown) {
        try {
          const stopped = await service([
            "stop",
            "--instance",
            instance.serviceId,
            "--expected-generation",
            instance.generation,
            "--cancel",
          ]);
          assert.equal(
            stopped.state,
            "stopped",
            `service ${instance.serviceId} stop must be confirmed`,
          );
        } catch (error) {
          cleanup.errors.push(`${instance.serviceId}: ${error.message}`);
        }
      }
    const remaining = await service(["list"]);
    assert.ok(Array.isArray(remaining), "isolated service confirmation must be an array");
    cleanup.instances = remaining.map(({ serviceId, generation, workspace, state }) => ({
      serviceId,
      generation,
      workspace,
      state,
    }));
    assert.ok(
      remaining.every((instance) => instance.state === "stopped"),
      "isolated registry still has live or unconfirmed services",
    );
  } catch (error) {
    cleanup.errors.push(error.message);
  }
  if (metadata)
    try {
      try {
        await readFile(join(scratch, "core/service.json"), "utf8");
        throw Error("desktop service metadata remains after stop");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } catch (error) {
      cleanup.errors.push(error.message);
    }
  if (cleanup.errors.length)
    throw Error(`isolated service cleanup not confirmed: ${cleanup.errors.join("; ")}`);
  cleanup.stopped = true;
  checks.push(
    "isolated desktop service exited and all registry Core services stopped, including projectless",
  );
  return cleanup;
}

console.log("GUI evidence:", scratch);
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: serviceRegistry,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
delete env.AREAL_HARNESS_HOME;
delete env.AREAL_DEV_CONVERSATION_DERIVATION;
try {
  server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (respondToSessionName(body, res)) return;
      requests.push({ sequence: requests.length + 1, method: req.method, path: req.url, body });
      const lastUser = body.messages?.findLast(
        (message) =>
          message.role === "user" &&
          !(
            typeof message.content === "string" &&
            message.content.startsWith("AReaL runtime context (not a user request):")
          ),
      );
      const answer = `FIXTURE_OK_${requests.length}: ${typeof lastUser?.content === "string" ? lastUser.content : "received"}`;
      if ([capacitySourceQuestion, capacitySideQuestion].includes(lastUser?.content)) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (lastUser.content === capacitySourceQuestion) {
          res.write(
            `data: ${JSON.stringify({
              id: "scf-held",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: streamExcerpt }, finish_reason: null }],
            })}\n\n`,
          );
        }
        // This fixture holds capacity, not an idle transport. UI/evidence work
        // may outlast the real stream idle deadline; comments add no model text.
        const heartbeat = setInterval(
          () => res.write(": fixture awaiting explicit release\n\n"),
          1000,
        );
        res.once("close", () => clearInterval(heartbeat));
        heldResponses.set(lastUser.content, () => {
          clearInterval(heartbeat);
          res.end(sse(answer));
        });
        return;
      }
      if (
        lastUser?.content === sideFileQuestion &&
        !body.messages.some((message) => message.role === "tool")
      ) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(toolSse("fs_read", { path: "workspace://repo/shared.txt" }));
        return;
      }
      // 来源长工具必须由 Core/Runtime 真正执行，文件标记确认其已启动。
      if (
        lastUser?.content === activeQuestion &&
        !body.messages.some((message) => message.role === "tool")
      ) {
        const command = `printf started > '${toolStarted}'; while [ ! -f '${toolRelease}' ]; do sleep 0.1; done; printf finished`;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          toolSse("run_command", {
            argv: ["/bin/sh", "-c", command],
            cwd: "workspace://repo",
            timeoutMs: 120000,
          }),
        );
        return;
      }
      if (
        lastUser?.content === activeQuestion &&
        !body.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.tool_calls?.some((call) => call.function?.name === "read_file"),
        )
      ) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          toolSse("read_file", { path: "workspace://repo/raw-result-evidence.txt", limit: 120 }),
        );
        return;
      }
      if (body.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(answer));
    } catch (error) {
      events.push({ fixtureError: error.message });
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const config = join(scratch, "config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\nmodels=[{id="fixture",enabled=true},{id="fixture-alternate",enabled=true}]\n[limits]\nmodel_concurrency=1\n`,
  );
  env.AREAL_CORE_CONFIG = config;
  const deployment = join(scratch, "desktop.json");
  await writeFile(
    deployment,
    JSON.stringify({
      profiles: [
        {
          id: "standard",
          revision: "v1",
          displayName: "标准",
          instructions: "Reply with plain text",
          allowThreadProcesses: true,
          approvalTools: [],
          skills: [],
        },
        {
          id: "zz-scf-automatic",
          revision: "v1",
          displayName: "SCF Automatic",
          instructions: "",
          workflow: { id: "scf-flow", revision: "v1" },
        },
      ],
      workflows: [
        {
          id: "scf-flow",
          revision: "v1",
          displayName: "SCF Flow",
          plan: {
            objective: "must not start",
            tasks: [{ id: "one", instruction: "must not execute", writes: [] }],
          },
        },
      ],
    }),
  );
  env.AREAL_CORE_DESKTOP_CONFIG = deployment;
  const videoDir = join(scratch, "video");
  await mkdir(videoDir);
  const launchOptions = {
    executablePath: require("electron"),
    args: [desktop],
    env,
    timeout: 120000,
    recordVideo: { dir: videoDir, size: { width: 1440, height: 960 } },
  };
  app = await electron.launch(launchOptions);
  await recordMainFailures(app);
  app.process().stderr.on("data", (chunk) => {
    electronStderr.push(String(chunk));
    if (String(chunk).includes("Error")) process.stderr.write(chunk);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") events.push({ rendererConsoleError: message.text() });
  });
  page.on("crash", () => events.push({ rendererCrashed: true }));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  // 本专项统计执行请求；提示预测由独立专项验收，避免辅助请求混入不重放断言。
  const preferencesChanged = await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (preferences.nextPromptSuggestions === false) return false;
    localStorage.setItem(key, JSON.stringify({ ...preferences, nextPromptSuggestions: false }));
    return true;
  });
  if (preferencesChanged) {
    await page.reload();
    await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  windowBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  sandbox = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    };
  });
  assert.deepEqual(sandbox, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => project(s)?.state?.connected, "project connection");
  projectId = project(await state()).id;
  const sourceModelTrigger = page
    .getByTestId("composer-model-trigger")
    .filter({ hasText: "fixture" });
  await sourceModelTrigger.waitFor();
  // 新草稿需显式选择目录中的模型，再开始本专项的来源对话。
  await sourceModelTrigger.click();
  await page.getByRole("tab", { name: "fixture", exact: true }).click();
  await page.locator('[data-model-value="fixture/fixture"]').getByRole("radio").click();
  await page.keyboard.press("Escape");
  // 共享后台独立运行；在真实连接的返回边界记录 Core 已确认的创建键。
  await app.evaluate(
    ({ app }, connectionPath) => {
      const read = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { ServiceConnection } = read(connectionPath);
      const original = ServiceConnection.prototype.request;
      globalThis.__scfMutations = [];
      ServiceConnection.prototype.request = async function (method, parameters, mutation) {
        globalThis.__scfConnection = this;
        if (method !== "command") {
          return original.call(this, method, parameters, mutation);
        }
        // 一次性修改出站参数，拒绝结果仍由真实 Core 产生。
        const fixture = globalThis.__scfRejectNext;
        if (fixture === "workflow" && parameters.name === "fork") {
          parameters = {
            ...parameters,
            request: {
              ...parameters.request,
              target: { agentProfile: { id: "zz-scf-automatic", revision: "v1" } },
            },
          };
          globalThis.__scfRejectNext = null;
        } else if (
          fixture === "selection" &&
          parameters.name === "side" &&
          parameters.request.operation === "start"
        ) {
          parameters = {
            ...parameters,
            request: {
              ...parameters.request,
              selection: { ...parameters.request.selection, textSha256: "0".repeat(64) },
            },
          };
          globalThis.__scfRejectNext = null;
        } else if (
          fixture === "workspace-read" &&
          parameters.name === "side" &&
          parameters.request.operation === "start"
        ) {
          parameters = {
            ...parameters,
            request: { ...parameters.request, workspaceAccess: "readOnly" },
          };
          globalThis.__scfRejectNext = null;
        }
        const entry = {
          command: parameters.name,
          parameters: parameters.request,
          mutation: mutation === true,
          accepted: false,
        };
        if (fixture && !globalThis.__scfRejectNext) entry.fixture = fixture;
        globalThis.__scfMutations.push(entry);
        try {
          const result = await original.call(this, method, parameters, mutation);
          entry.accepted = true;
          entry.requestId = result?.requestId ?? parameters.request?.requestId ?? null;
          entry.resultThreadId = result?.threadId ?? result?.thread?.id ?? null;
          if (parameters.name === "media" && result?.bytes) {
            const bytes = Buffer.from(result.bytes, "base64");
            entry.resultSha256 = process
              .getBuiltinModule("crypto")
              .createHash("sha256")
              .update(bytes)
              .digest("hex");
            entry.resultLength = bytes.length;
          }
          if (parameters.name === "fork" && globalThis.__scfLoseNextForkResponse) {
            globalThis.__scfLoseNextForkResponse = false;
            entry.fixture = "committed GUI response lost";
            throw Object.assign(new Error("SCF fixture: committed GUI response lost"), {
              submissionUnknown: true,
              requestId: entry.requestId,
            });
          }
          return result;
        } catch (error) {
          entry.error = error.message;
          throw error;
        }
      };
    },
    join(desktop, "src/core/service-client.cjs"),
  );
  const first = await send(`${head} ${unicodeExcerpt}`);
  sourceThreadId = first.threadId;
  anchorTurnId = first.turnId;
  const second = await send(future, sourceThreadId);
  assert.notEqual(second.turnId, anchorTurnId);
  assert.equal(requests.length, 2, "plain-text source should require exactly two fixture requests");
  await shot("01-source.png");
  const sourceTurns = project(await state()).state.threads[sourceThreadId].turns.map(
    (turn) => turn.id,
  );
  const beforeCreation = {
    modelRequests: requests.length,
    workspaceSha256: await hash(fixturePath),
  };
  assert.equal(beforeCreation.workspaceSha256, workspaceBefore);
  const anchor = page.locator(`[data-turn-id="${anchorTurnId}"]`);
  await anchor.getByRole("button", { name: "从此轮创建聊天分支", exact: true }).click();
  let forkDialog = page.getByRole("dialog", { name: "从这里创建聊天分支", exact: true });
  await forkDialog.waitFor();
  assert.equal(
    await page.getByRole("menuitem", { name: /在此轮(之前|之后)分支/ }).count(),
    0,
    "Branch opens its target dialog directly",
  );
  assert.equal(await forkDialog.getByText("在当前工作区中创建", { exact: true }).count(), 1);
  assert.equal(await forkDialog.getByText("在新工作树中创建", { exact: true }).count(), 0);
  assert.equal(await forkDialog.getByRole("button").count(), 1);
  assert.equal(
    await forkDialog.locator("select, details, [data-slot=popover-description]").count(),
    0,
  );
  await page.waitForFunction(() => {
    const dialog = document.querySelector(".fork-target-dialog");
    if (!dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return (
      Math.abs(rect.x + rect.width / 2 - innerWidth / 2) <= 1 &&
      Math.abs(rect.y + rect.height / 2 - innerHeight / 2) <= 1
    );
  });
  await shot("01-fork-actions.png");
  await page.keyboard.press("Escape");
  await forkDialog.waitFor({ state: "hidden" });
  await anchor.getByRole("button", { name: "从此轮创建聊天分支", exact: true }).click();
  await forkDialog.waitFor();
  await page.getByTestId("chat-input").click();
  await forkDialog.waitFor({ state: "hidden" });
  await anchor.getByRole("button", { name: "从此轮创建聊天分支", exact: true }).click();
  await forkDialog.waitFor();
  await app.evaluate(() => {
    globalThis.__scfRejectNext = "workflow";
  });
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await forkDialog.getByRole("alert").filter({ hasText: "PROFILE_NOT_SUPPORTED" }).waitFor();
  assert.equal(
    await forkDialog.getByRole("button", { name: "创建分支", exact: true }).isEnabled(),
    true,
  );
  assert.equal(requests.length, beforeCreation.modelRequests);
  assert.equal(Object.keys(project(await state()).state.threads).length, 1);
  await shot("01a-fork-config-refusal.png");
  checks.push(
    "AC15/61: compact Fork offers one inherited-config action, dismisses via Escape/outside click, and preserves retry after actual Core Workflow rejection without a target or model request",
  );
  await app.evaluate(() => {
    globalThis.__scfLoseNextForkResponse = true;
  });
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await forkDialog.getByRole("button", { name: "核对受理结果", exact: true }).waitFor();
  await forkDialog.getByRole("alert").filter({ hasText: "请先核对原提交" }).waitFor();
  assert.equal(await forkDialog.getByRole("button", { name: "创建分支", exact: true }).count(), 0);
  const lostResult = (await app.evaluate(() => globalThis.__scfMutations)).find(
    (entry) => entry.fixture === "committed GUI response lost",
  );
  assert.ok(lostResult?.accepted && lostResult.resultThreadId && lostResult.requestId);
  assert.equal(requests.length, beforeCreation.modelRequests);
  assert.equal(Object.keys(project(await state()).state.threads).length, 2);
  await shot("01b-fork-response-unknown.png");
  await page.keyboard.press("Escape");
  await forkDialog.waitFor({ state: "hidden" });
  await selectConversation(page, lostResult.resultThreadId);
  checks.push(
    "AC27: discarded GUI response after a real committed Fork shows reconciliation instead of resend; exactly one idle target exists and manual navigation opens it",
  );
  await page.locator(".messages .message-column").waitFor();
  targetThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(targetThreadId && targetThreadId !== sourceThreadId);
  assert.equal(
    requests.length,
    beforeCreation.modelRequests,
    "fork creation must not call the model",
  );
  assert.equal(
    await hash(fixturePath),
    beforeCreation.workspaceSha256,
    "fork creation must not change files",
  );
  const target = project(await state()).state.threads[targetThreadId];
  assert.equal(target.conversation?.kind, "fork");
  assert.equal(target.conversation?.origin?.sourceThreadId, sourceThreadId);
  assert.equal(target.conversation?.origin?.sourceTurnId, anchorTurnId);
  assert.equal(target.turns?.length, 0, "target starts with empty local turns");
  const inherited = page.locator(".messages .message-column");
  await inherited
    .locator(".user-bubble")
    .getByText(`${head} ${unicodeExcerpt}`, { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: /继承历史/ }).count(),
    0,
    "Fork history must be directly visible without a disclosure",
  );
  assert.equal(
    await inherited.getByText(future, { exact: false }).count(),
    0,
    "future source Turn must not appear in inherited history",
  );
  assert.ok(
    await inherited
      .locator(`[data-turn-id="${anchorTurnId}"] .assistant-message-final .conversation-markdown`)
      .count(),
    "inherited answers reuse the main Markdown component",
  );
  assert.equal((await page.getByTestId("chat-input").innerText()).trim(), "");
  await shot("02-fork-empty.png");
  checks.push(
    "AC01/02/06: older Turn GUI fork is idle, empty, source-owned, current shared workspace and bounded inherited history",
  );
  const requestsBeforeNested = requests.length;
  await inherited
    .locator(`[data-turn-id="${anchorTurnId}"]`)
    .getByRole("button", { name: "从此轮创建聊天分支", exact: true })
    .click();
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await page.waitForFunction((id) => {
    const current = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return current && current !== id;
  }, targetThreadId);
  nestedThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const nestedFork = project(await state()).state.threads[nestedThreadId];
  assert.equal(nestedFork.conversation.origin.sourceThreadId, targetThreadId);
  assert.equal(nestedFork.conversation.historySeed.turnCount, 1);
  assert.equal(nestedFork.turns.length, 0);
  assert.equal(requests.length, requestsBeforeNested);
  await selectConversation(page, targetThreadId);
  checks.push(
    "AC09: inherited Turn menu creates one flattened logical prefix and an empty independent Fork without execution",
  );
  const forkDraftPrefix = "已有主会话文字";
  await page.getByTestId("chat-input").fill(forkDraftPrefix);
  await page.waitForFunction(() => {
    const primary = document.querySelector(
      ".composer-dock:not(.side-chat-composer) .composer-primary-action",
    );
    return primary && !primary.disabled;
  });
  const requestsBeforeMainQuote = requests.length;
  await selectMessageExcerpt(
    inherited
      .locator(`[data-turn-id="${anchorTurnId}"] [data-side-item-id] .conversation-markdown`)
      .first(),
    unicodeExcerpt,
    true,
  );
  await page
    .getByTestId("transcript-selection-actions")
    .getByRole("button", { name: "添加到聊天", exact: true })
    .click();
  assert.equal(await page.getByTestId("chat-input").innerText(), forkDraftPrefix);
  await composeText(
    page.getByTestId("chat-input"),
    forkQuestion,
    "main question after selection",
    true,
  );
  assert.equal(
    requests.length,
    requestsBeforeMainQuote,
    "selection and further typing must not call the model",
  );
  await send(await page.getByTestId("chat-input").innerText(), targetThreadId);
  const branchRequest = requests.at(-1)?.body;
  const branchInput = JSON.stringify(branchRequest?.messages ?? []);
  assert.ok(
    branchInput.includes(head) &&
      branchInput.includes(forkQuestion) &&
      branchInput.includes(forkDraftPrefix),
    "model input must include selected source prefix and preserved/extended explicit input",
  );
  const branchUserMessage = project(await state())
    .state.threads[targetThreadId].turns.at(-1)
    .items.find((item) => item.type === "userMessage");
  const branchUserText = (branchUserMessage.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.ok(
    branchUserText.includes(forkDraftPrefix) &&
      branchUserText.includes(forkQuestion) &&
      branchUserText.includes(unicodeExcerpt),
    "explicit main send includes staged quote and extra typing in actual accepted user input",
  );
  assert.ok(!branchInput.includes(future), "model input must exclude future source Turn");
  assert.deepEqual(
    project(await state()).state.threads[sourceThreadId].turns.map((turn) => turn.id),
    sourceTurns,
  );
  assert.equal(await hash(fixturePath), workspaceBefore);
  await shot("03-fork-sent.png");
  checks.push(
    "AC06: actual model input excludes the future sentinel; explicit send leaves source Turn IDs and workspace bytes unchanged",
  );
  await selectConversation(page, sourceThreadId);
  await page.getByTestId("chat-input").fill(activeQuestion);
  await page
    .locator(".composer-dock:not(.side-chat-composer)")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  const running = await until((s) => {
    const turn = project(s)?.state?.threads?.[sourceThreadId]?.turns?.at(-1);
    return (
      turn &&
      !sourceTurns.includes(turn.id) &&
      turn.status === "inProgress" &&
      JSON.stringify(requests.at(-1)?.body?.messages ?? []).includes(activeQuestion)
    );
  }, "source active Turn at model barrier");
  activeTurnId = project(running).state.threads[sourceThreadId].turns.at(-1).id;
  await untilFile(toolStarted, "Core/Runtime source command marker");
  const sourceProject = project(await state());
  const sourceConfig = sourceProject.configurations?.[sourceThreadId];
  assert.ok(
    Number.isInteger(sourceConfig?.revision) && sourceConfig.revision > 0,
    "source must have an actual Core configuration before retention check",
  );
  assert.equal(
    requests.at(-1)?.body?.model,
    "fixture",
    "the running source request must use the configured fixture model",
  );
  await page.getByTestId("chat-input").fill(mainDraftSentinel);
  await page.locator('.composer-dock input[type="file"]').setInputFiles({
    name: "main-attachment.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("keep this main attachment"),
  });
  await page.getByTestId("composer-attachments").getByText("main-attachment.txt").waitFor();
  assert.equal(project(running).state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  checks.push(
    "AC30: source run_command entered the real Core/Runtime process and remains held while Side begins",
  );
  await shot("04-source-tool-running.png");
  // 通过真实消息选区界面选择首个持久轮次中的 Unicode 子串。
  const selectSideExcerpt = () =>
    selectMessageExcerpt(
      page
        .locator(`[data-turn-id="${anchorTurnId}"] [data-side-item-id] .conversation-markdown`)
        .first(),
      unicodeExcerpt,
    );
  await selectSideExcerpt();
  let sideTrigger = page.getByRole("button", { name: "在旁路中询问所选内容", exact: true });
  const selectionActions = page.getByTestId("transcript-selection-actions");
  const addToChat = selectionActions.getByRole("button", { name: "添加到聊天", exact: true });
  await selectionActions.waitFor();
  await sideTrigger.waitFor();
  assert.equal(await sideTrigger.count(), 1, "选区浮层只显示一个旁路入口");
  assert.equal(
    await page
      .locator(".message-actions")
      .getByRole("button", { name: "在旁路中询问所选内容", exact: true })
      .count(),
    0,
  );
  await shot("04a-selection-floating-actions.png");
  const beforeStaging = requests.length;
  await addToChat.click();
  await page
    .locator(
      ".composer-dock:not(.side-chat-composer) [data-conversation-selection-reference-count]",
    )
    .click();
  const stagedMain = page
    .getByTestId("conversation-selection-reference")
    .filter({ hasText: unicodeExcerpt });
  await stagedMain.waitFor();
  assert.equal(await page.getByTestId("chat-input").innerText(), mainDraftSentinel);
  assert.equal(
    await page
      .getByTestId("composer-attachment")
      .filter({ hasText: "main-attachment.txt" })
      .count(),
    1,
  );
  assert.equal(requests.length, beforeStaging, "staging a quote must not send or steer");
  await stagedMain.getByRole("button", { name: "移除引用", exact: true }).click();
  await selectSideExcerpt();
  await addToChat.click();
  await page
    .locator(
      ".composer-dock:not(.side-chat-composer) [data-conversation-selection-reference-count]",
    )
    .click();
  await stagedMain.waitFor();
  await stagedMain.getByRole("button", { name: "移除引用", exact: true }).click();
  await selectSideExcerpt();
  await page.keyboard.press("Escape");
  await selectionActions.waitFor({ state: "hidden" });
  assert.equal(
    project(await state()).state.threads[sourceThreadId].turns.at(-1).status,
    "inProgress",
    "dismissing selection actions must not stop the source Turn",
  );
  await selectSideExcerpt();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await selectionActions.waitFor({ state: "hidden" });
  await selectSideExcerpt();
  await page.getByTestId("chat-input").click();
  await selectionActions.waitFor({ state: "hidden" });
  await selectSideExcerpt();
  await page.locator(".messages").evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await selectionActions.waitFor({ state: "hidden" });
  await selectSideExcerpt();
  await selectConversation(page, targetThreadId);
  assert.equal(await sideTrigger.count(), 0, "来源 A 的选区不能在切换后的 B 会话显示或提交");
  await selectConversation(page, sourceThreadId);
  // 导航会补全默认模型的权威版本；在打开 Side 前固定完整配置基线。
  const refreshedSource = await until((s) => {
    const configuration = project(s)?.configurations?.[sourceThreadId];
    return (
      (configuration?.model?.providerId === "fixture" &&
        configuration.model.modelId === "fixture") ||
      (configuration?.model === null &&
        typeof configuration.defaultModelRevision === "string" &&
        configuration.defaultModelRevision.length > 0)
    );
  }, "source configured fixture model restored after navigation");
  const mainConfigBefore = modelConfiguration(
    project(refreshedSource).configurations[sourceThreadId],
  );
  // 路由身份先于历史恢复发布；等待 Composer 解除恢复阻塞后再建立选区。
  await page.waitForFunction(() => {
    const primary = document.querySelector(
      ".composer-dock:not(.side-chat-composer) .composer-primary-action",
    );
    return primary && !primary.disabled;
  });
  await selectSideExcerpt();
  checks.push(
    "AC55: floating selection actions and Add to Chat preserve main text/files, remove/readd quotes without sending, dismiss on Escape/collapse/outside/scroll, and invalidate on source navigation",
  );
  const beforeCurrentSide = requests.length;
  const sourceTurnIdsBeforeSide = project(await state()).state.threads[sourceThreadId].turns.map(
    (turn) => turn.id,
  );
  await sideTrigger.click();
  const sidePane = page.getByTestId("side-chat-pane").filter({ visible: true });
  await sidePane.waitFor();
  sideThreadId = await sidePane.getAttribute("data-thread-id");
  const sideState = await until(
    (snapshot) => project(snapshot).state.threads[sideThreadId],
    "current Side child admitted",
  );
  assert.equal(
    project(sideState).state.threads[sideThreadId].conversation.policy.kind,
    "sideExecutableV2",
  );
  assert.equal(project(sideState).state.threads[sideThreadId].turns.length, 0);
  assert.equal(
    requests.length,
    beforeCurrentSide,
    "selection creates an idle child without model execution",
  );
  await sidePane.locator("[data-conversation-selection-reference-count]").waitFor();
  const sideInput = sidePane.getByRole("textbox", { name: "随心输入", exact: true });
  await sideInput.fill(sideQuestion);
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  const sideAnswered = await until(
    (snapshot) =>
      project(snapshot).state.threads[sideThreadId]?.turns.at(-1)?.status === "completed",
    "current Side answer completed",
  );
  const sourceAfter = project(sideAnswered).state.threads[sourceThreadId];
  assert.deepEqual(
    sourceAfter.turns.map((turn) => turn.id),
    sourceTurnIdsBeforeSide,
  );
  assert.equal(sourceAfter.turns.at(-1).status, "inProgress");
  assert.deepEqual(
    modelConfiguration(project(sideAnswered).configurations[sourceThreadId]),
    mainConfigBefore,
  );
  const sideRequest = JSON.stringify(
    requests.slice(beforeCurrentSide).map((request) => request.body),
  );
  assert.ok(
    sideRequest.includes(unicodeExcerpt),
    "selected Unicode evidence reaches the real child request",
  );
  assert.ok(sideRequest.includes(sideQuestion));
  assert.ok(
    !sideRequest.includes(lateSentinel),
    "unfinished source output cannot enter the child request",
  );
  await shot("05-current-side-answered.png");
  await writeFile(toolRelease, "release\n");
  await until(
    (snapshot) =>
      project(snapshot).state.threads[sourceThreadId].turns.at(-1)?.status === "completed",
    "source Runtime command settled",
  );
  checks.push(
    "current selection-to-Side creates an idle executable child, sends verified Unicode context only on explicit send, and preserves source identity/configuration while its real Runtime command is active",
  );
  assert.deepEqual(pageErrors, []);
  passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(error);
  await writeFile(
    join(scratch, "failure.log"),
    [failure, ...electronStderr, ...pageErrors].join("\n"),
  );
  if (app)
    try {
      events.push({
        failureWindows: await withSmokeDeadline("native window diagnostics", () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              url: window.webContents.getURL(),
              visible: window.isVisible(),
              loading: window.webContents.isLoading(),
              crashed: window.webContents.isCrashed(),
            })),
          ),
        ),
      });
    } catch (diagnosticError) {
      events.push({ windowDiagnosticError: diagnosticError.message });
    }
  if (page)
    frames.push(
      ...(await captureSmokeFailure(page, scratch, error)).filter((name) => name.endsWith(".png")),
    );
  process.exitCode = 1;
} finally {
  await writeFile(toolRelease, "cleanup\n");
  for (const release of heldResponses.values()) release();
  heldResponses.clear();
  if (app) {
    if (!firstMutations.length)
      try {
        firstMutations = await withSmokeDeadline("mutation evidence", () =>
          app.evaluate(() => globalThis.__scfMutations ?? []),
        );
      } catch (error) {
        events.push({ requestCaptureError: error.message });
      }
    try {
      await closeRecordedSmokeApplication(app, 20000, async () => {
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 });
        });
        if (videoPath) restartVideoPath = await page?.video()?.path();
        else videoPath = await page?.video()?.path();
      });
    } catch (error) {
      events.push({ electronCloseError: error.message });
      failure ??= error.stack ?? String(error);
      passed = false;
      process.exitCode = 1;
    }
  }
  try {
    await stopService(env);
    await cp(serviceRegistry, join(scratch, "service-registry"), { recursive: true });
    await rm(serviceRegistry, { recursive: true, force: true });
  } catch (error) {
    events.push({ cleanupFailed: error.message, retainedRegistry: serviceRegistry });
    failure ??= error.stack ?? String(error);
    passed = false;
    process.exitCode = 1;
    await cp(serviceRegistry, join(scratch, "service-registry"), { recursive: true }).catch(
      (copyError) => events.push({ registryEvidenceCopyError: copyError.message }),
    );
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const mainFailures = await readFile(join(scratch, "main-exceptions.log"), "utf8").catch(
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    },
  );
  if (mainFailures) {
    failure ??= mainFailures;
    passed = false;
    process.exitCode = 1;
  }
  const videos = await readdir(join(scratch, "video")).catch(() => []);
  if (!videoPath && videos.length === 1) videoPath = join(scratch, "video", videos[0]);
  const sourceDiff = execFileSync("git", ["diff", "--binary"], { cwd: root });
  const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
  });
  const manifest = {
    passed,
    failure,
    scenario: "conversation-derivation",
    checks,
    events,
    pageErrors,
    electronStderr,
    frames,
    sourceCommit,
    command: "pnpm --dir clients/gui run test:conversation-derivation",
    runtime:
      "source Electron renderer + Rust Core + actual Runtime run_command + deterministic local HTTP/SSE model",
    limitations: [
      "retired read-only Side UI is not exercised; Core side_access/side_history_recovery/side_workspace_read preserve legacy contracts; current Side parity covers P1-P6",
      "local fixture model, not a real provider",
      "source build, not a copied installed package",
      "native project chooser, archive confirmation and download save location are fixtures and have no native-dialog acceptance claim",
      "Browser preview is outside this journey",
      "IME uses Chromium CDP composition and a candidate Enter event, not a physical input method",
    ],
    operatingSystem: {
      platform: process.platform,
      release: (await import("node:os")).release(),
      architecture: process.arch,
    },
    windowBounds,
    videoPath,
    videoSegments: [
      { path: videoPath, process: "initial Electron run", continuous: true },
      { path: restartVideoPath, process: "restarted Electron run", continuous: true },
    ],
    framePredicates: Object.fromEntries(
      frames.map((name) => [name, "captured current Fork/selection/Side journey"]),
    ),
    sourceDirtyStatus: sourceStatus,
    sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
    sandbox,
    requestedRuntimeSandboxProfile: env.AREAL_CORE_SANDBOX_PROFILE || "full-access",
    developmentCapabilityFlag: env.AREAL_DEV_CONVERSATION_DERIVATION ?? null,
    binary,
    binarySha256: await hash(binary).catch(() => null),
    smokeScriptSha256: await hash(fileURLToPath(import.meta.url)),
    sourceThreadId,
    targetThreadId,
    nestedThreadId,
    sideThreadId,
    anchorTurnId,
    activeTurnId,
    projectId,
    serviceRegistry,
    fixture: {
      head,
      future,
      forkQuestion,
      activeQuestion,
      unicodeExcerpt,
      sideQuestion,
      sideFollowUp,
      lateSentinel,
      mainDraftSentinel,
      workspace,
      workspaceSha256Before: workspaceBefore,
      workspaceSha256After: await hash(fixturePath),
      toolStarted,
      toolRelease,
    },
    requests,
    mutations: firstMutations,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, failure }));
}
