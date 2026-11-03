import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { waitForServiceProcessExit } = require("../app/src/core/service-client.cjs");
const observe = process.argv.includes("--observe");
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--observe"),
  "Only --observe is supported",
);
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, ".local/dev-bin/areal"));
assert.ok(
  binary.startsWith(join(root, ".local/dev-bin/")),
  "Use the existing private fixed Core build",
);
await mkdir(join(root, ".scratch/gui-feedback-20261020"), { recursive: true });
const evidence = await mkdtemp(join(root, ".scratch/gui-feedback-20261020/run-"));
const scratch = await makeTempDir("af-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (name, value) => writeFile(join(evidence, name), JSON.stringify(value, null, 2));
const smallBefore = "unchanged\nsmall-before\n";
const smallAfter = "unchanged\nsmall-after\nsmall-added\n";
const largeBefore =
  "large-before\n" +
  Array.from(
    { length: 240 },
    (_, i) => `line-${String(i).padStart(3, "0")} ${"x".repeat(38)}\n`,
  ).join("");
const largeAfter = largeBefore.replace("large-before\n", "large-after\nlarge-added\n");
assert.ok(Buffer.byteLength(largeBefore) > 8192 && Buffer.byteLength(largeBefore) < 16384);
const scenarios = [
  {
    id: "read-file",
    prompt: "FEEDBACK_SMALL",
    path: "small.txt",
    before: smallBefore,
    after: smallAfter,
    additions: 2,
    deletions: 1,
    tools: [
      ["read_file", { path: "small.txt" }],
      [
        "fs_apply_patches",
        {
          path: "small.txt",
          patches: [{ oldText: "small-before\n", newText: "small-after\nsmall-added\n" }],
        },
      ],
    ],
  },
  {
    id: "partial-read-file",
    prompt: "FEEDBACK_PARTIAL",
    path: "partial.txt",
    before: smallBefore,
    after: smallAfter,
    additions: 2,
    deletions: 1,
    tools: [
      ["read_file", { path: "partial.txt", offset: 1, limit: 1 }],
      [
        "fs_apply_patches",
        {
          path: "partial.txt",
          patches: [{ oldText: "small-before\n", newText: "small-after\nsmall-added\n" }],
        },
      ],
    ],
  },
  {
    id: "paged-fs-read",
    prompt: "FEEDBACK_LARGE",
    path: "large.txt",
    before: largeBefore,
    after: largeAfter,
    additions: 2,
    deletions: 1,
    tools: [
      ["fs_read", { path: "large.txt", offset: 0, maxBytes: 8192 }],
      ["fs_read", { path: "large.txt", offset: 8192, maxBytes: 8192 }],
      [
        "fs_apply_patches",
        {
          path: "large.txt",
          patches: [{ oldText: "large-before\n", newText: "large-after\nlarge-added\n" }],
        },
      ],
    ],
  },
  {
    id: "create-control",
    prompt: "FEEDBACK_CREATE",
    path: "created.txt",
    after: "created\n",
    additions: 1,
    deletions: 0,
    tools: [["fs_create", { path: "created.txt", text: "created\n" }]],
  },
];
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
await mkdir(join(userHome, "feedback-bin"));
await writeFile(
  join(userHome, ".zprofile"),
  'export AREAL_FEEDBACK_PROFILE=profile\nexport PATH="$HOME/feedback-bin:$PATH"\n',
);
await writeFile(join(userHome, ".zshrc"), "export AREAL_FEEDBACK_RC=rc\n");
await writeFile(join(userHome, "feedback-bin/feedback-tool"), "#!/bin/sh\nprintf startup-tool\n", {
  mode: 0o755,
});
for (const scenario of scenarios.filter((scenario) => scenario.before))
  await writeFile(join(workspace, scenario.path), scenario.before);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
const requests = [],
  checks = [],
  pageErrors = [],
  stderr = [],
  actions = [],
  completedTurns = [];
let app, page, guiProcess, metadata, threadId, projectId, fatal, cleanup;
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (snapshot) =>
  snapshot.projects.find((project) => project.root === workspace && !project.projectless);
const thread = (snapshot) => project(snapshot)?.state?.threads?.[threadId];
const button = (name) => page.getByRole("button", { name, exact: true });
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw Error(`Timeout: ${label}`);
}
async function check(id, operation) {
  try {
    const detail = await operation();
    checks.push({ id, passed: true, detail });
  } catch (error) {
    checks.push({ id, passed: false, error: error.stack || String(error) });
  }
  console.log(JSON.stringify(checks.at(-1)));
  await json("checks.json", checks);
}
async function capture(name) {
  actions.push({ name, at: new Date().toISOString() });
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    animations: "disabled",
    timeout: 10000,
  });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}
async function writableDirectories(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writableDirectories(join(directory, entry.name));
  }
}
async function command(name, params) {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const recordedCommands = () => app.evaluate(() => globalThis.__feedbackCommands || []);
const settledReview = (turnId) =>
  until(
    async () =>
      (await recordedCommands()).findLast(
        (entry) =>
          entry.request.turnId === turnId &&
          entry.request.operation === "turnReview" &&
          entry.settled,
      ),
    "turn comparison settled",
  );
async function returnToChat() {
  if (await button("返回工作区").isVisible()) await button("返回工作区").click();
  await page.getByTestId("chat-input").waitFor();
}
async function hashes() {
  const files = [
    "app/src/core/main.cjs",
    "app/src/core/service-client.cjs",
    "renderer/src/App.tsx",
    "renderer/src/TurnFileSummary.tsx",
    "renderer/src/terminal/coreTerminalService.ts",
    "renderer/src/terminal/TerminalPane.tsx",
    "packages/workspace-git/turn-review.js",
    "scripts/gui-feedback-smoke.mjs",
    "renderer/dist/index.html",
  ];
  const source = Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, sha(await readFile(join(gui, file)))])),
  );
  const binaries = Object.fromEntries(
    await Promise.all(
      ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
        name,
        sha(await readFile(join(dirname(binary), name))),
      ]),
    ),
  );
  return {
    source,
    binaries,
    diffSha256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
  };
}
const initialHashes = await hashes();
const run = {
  evidence,
  scratch,
  workspace,
  binary,
  observe,
  initialHashes,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
};
await json("run.json", run);
console.log("GUI feedback evidence:", evidence);
const application = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
const { ServiceConnection } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const originalFeedbackRequest = ServiceConnection.prototype.request;
globalThis.__feedbackCommands = [];
ServiceConnection.prototype.request = async function(method, parameters, mutation) {
  const watched = method === 'command' && ((parameters.name === 'workspace' && parameters.request.operation === 'turnReview') || (parameters.name === 'manage' && ['processStart', 'process'].includes(parameters.request.operation)));
  const entry = watched ? { name: parameters.name, request: structuredClone(parameters.request), settled: false } : null;
  if (entry) globalThis.__feedbackCommands.push(entry);
  try { const result = await originalFeedbackRequest.call(this, method, parameters, mutation); if (entry) entry.result = result; return result; }
  catch (error) { if (entry) entry.error = error.message; throw error; }
  finally { if (entry) entry.settled = true; }
};
`,
);
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const piece of req) raw += piece;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, res)) return;
    requests.push(body);
    const messages = body.messages || [];
    const lastUser = messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        !String(message.content).startsWith("AReaL runtime context (not a user request):"),
    );
    const text =
      typeof messages[lastUser]?.content === "string"
        ? messages[lastUser].content
        : JSON.stringify(messages[lastUser]?.content);
    const scenario = scenarios.find((scenario) => text?.includes(scenario.prompt));
    assert.ok(scenario, `Known fixture prompt: ${text}`);
    const completed = messages
      .slice(lastUser + 1)
      .filter((message) => message.role === "tool").length;
    const next = scenario.tools[completed];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = next
      ? {
          tool_calls: [
            {
              index: 0,
              id: `${scenario.id}-${completed}`,
              type: "function",
              function: { name: next[0], arguments: JSON.stringify(next[1]) },
            },
          ],
        }
      : { content: `Completed ${scenario.prompt}.` };
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: next ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    stderr.push(`Model fixture: ${error.stack}`);
    res.destroy(error);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n[permissions]\nmode="YOLO"\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  SHELL: "/bin/zsh",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  USER: process.env.USER || "feedback-user",
  LOGNAME: process.env.LOGNAME || process.env.USER || "feedback-user",
  AREAL_FEEDBACK_ENV: "sentinel",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 60000,
  });
  guiProcess = app.process();
  guiProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  await until(async () => (await state()).connection?.state === "ready", "desktop service ready");
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 960);
    const preferences = window.webContents.getLastWebPreferences();
    return {
      pid: process.pid,
      userData: app.getPath("userData"),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    };
  });
  assert.deepEqual(
    {
      sandbox: identity.sandbox,
      contextIsolation: identity.contextIsolation,
      nodeIntegration: identity.nodeIntegration,
    },
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  await json("identity.json", {
    ...identity,
    desktop: { pid: metadata.pid, identity: metadata.identity, endpoint: metadata.endpoint },
  });
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await state())?.state?.connected, "fixture project connected");
  projectId = project(await state()).id;
  for (const scenario of scenarios) {
    await returnToChat();
    const before = threadId ? thread(await state()).turns.length : 0;
    await page.getByTestId("chat-input").fill(scenario.prompt);
    await page.getByTestId("chat-send-button").click();
    await until(
      async () => {
        threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
        return (
          threadId &&
          thread(await state())?.turns?.length > before &&
          thread(await state()).turns.at(-1).status === "completed"
        );
      },
      `${scenario.prompt} completed`,
      45000,
    );
    const turn = thread(await state()).turns.at(-1);
    completedTurns.push({ ...scenario, turnId: turn.id });
    await json(`${scenario.id}-turn.json`, turn);
    await check(`${scenario.id}/runtime-write`, async () => {
      assert.equal(await readFile(join(workspace, scenario.path), "utf8"), scenario.after);
      const calls = turn.items.filter((item) => item.type === "dynamicToolCall");
      assert.deepEqual(
        calls.map((call) => ({ tool: call.tool, status: call.status, success: call.success })),
        scenario.tools.map(([tool]) => ({ tool, status: "completed", success: true })),
      );
      return { turnId: turn.id, path: scenario.path, sha256: sha(scenario.after) };
    });
    const summary = page.getByTestId("turn-file-summary").last();
    await check(`${scenario.id}/summary-line-counts`, async () => {
      await summary.waitFor();
      await settledReview(turn.id);
      const text = await summary.innerText();
      await writeFile(join(evidence, `${scenario.id}-summary.txt`), text);
      await capture(`${scenario.id}-summary`);
      assert.equal(
        await summary
          .getByLabel(`合计新增 ${scenario.additions} 行，删除 ${scenario.deletions} 行`, {
            exact: true,
          })
          .count(),
        1,
        text,
      );
      assert.equal(
        await summary
          .getByRole("button", { name: `打开 ${scenario.path}`, exact: true })
          .getByLabel(`新增 ${scenario.additions} 行，删除 ${scenario.deletions} 行`, {
            exact: true,
          })
          .count(),
        1,
        text,
      );
      return { text };
    });
    await check(`${scenario.id}/open-file`, async () => {
      await summary.getByRole("button", { name: `打开 ${scenario.path}`, exact: true }).click();
      await page.getByTestId("workspace-file-preview").waitFor();
      assert.equal(
        await page
          .getByTestId("workspace-file-preview")
          .getByRole("navigation", { name: "文件路径", exact: true })
          .getAttribute("aria-description"),
        `${workspace}/${scenario.path}`,
      );
      await capture(`${scenario.id}-file`);
      assert.equal(
        await page.getByRole("alert").count(),
        0,
        await page.locator("body").innerText(),
      );
    });
    await writeFile(join(workspace, scenario.path), "external edit after this turn\n");
    await check(`${scenario.id}/historical-versions`, async () => {
      const review = await command("workspace", {
        projectId,
        threadId,
        operation: "turnReview",
        turnId: turn.id,
      });
      const changed = review.files.find((file) => file.path === scenario.path);
      assert.equal(changed?.beforeText, scenario.before || "");
      assert.equal(changed?.afterText, scenario.after);
      const item = turn.items.findLast((item) => item.type === "dynamicToolCall");
      const single = await command("workspace", {
        projectId,
        threadId,
        operation: "turnReview",
        turnId: turn.id,
        itemId: item.id,
      });
      assert.equal(single.files[0]?.beforeText, scenario.before || "");
      assert.equal(single.files[0]?.afterText, scenario.after);
      return { turnId: turn.id, itemId: item.id, currentDiskIsDifferent: true };
    });
    await returnToChat();
    await check(`${scenario.id}/open-diff`, async () => {
      await summary.getByRole("button", { name: "查看变更", exact: true }).click();
      const review = page.getByTestId("workspace-review");
      await review.waitFor();
      await until(
        async () =>
          (await review.locator("[data-review-path]").count()) ||
          (await review.getByRole("alert").count()),
        "Diff result or error",
      );
      const text = await review.innerText();
      await writeFile(join(evidence, `${scenario.id}-diff.txt`), text);
      await capture(`${scenario.id}-diff`);
      assert.equal(await review.getByRole("alert").count(), 0, text);
      const file = review.locator(`[data-review-path="${scenario.path}"]`);
      assert.equal(await file.count(), 1, text);
      assert.equal(await file.locator(".text-diff-added").innerText(), `+${scenario.additions}`);
      assert.equal(await file.locator(".text-diff-removed").innerText(), `-${scenario.deletions}`);
      return { text };
    });
  }
  await returnToChat();
  await page.keyboard.press("Control+Backquote");
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.waitFor();
  const processes = await until(async () => {
    const result = await command("manage", { projectId, threadId, operation: "processes" });
    return result.data?.length ? result.data : null;
  }, "terminal Runtime process registered");
  assert.equal(processes.length, 1, "only the UI-created terminal exists");
  const processId = processes[0].id;
  const probe =
    'printf \'\\nAREAL_FEEDBACK_BEGIN\\nshell=%s\\nargv0=%s\\nflags=%s\\npath=%s\\nprofile=%s\\nrc=%s\\nenv=%s\\nuser=%s\\nlogname=%s\\nterm=%s\\nprobe=%s\\nAREAL_FEEDBACK_END\\n\' "$SHELL" "$0" "$-" "$PATH" "${AREAL_FEEDBACK_PROFILE-}" "${AREAL_FEEDBACK_RC-}" "${AREAL_FEEDBACK_ENV-}" "${USER-}" "${LOGNAME-}" "${TERM-}" "$(feedback-tool 2>/dev/null)"';
  await terminal.pressSequentially(probe);
  await terminal.press("Enter");
  let output = "";
  await until(async () => {
    const result = await command("manage", {
      projectId,
      threadId,
      operation: "processOutput",
      id: processId,
      maxBytes: 65536,
    });
    output = (result.chunks || [])
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString())
      .join("");
    return /\r?\nAREAL_FEEDBACK_BEGIN\r?\n[\s\S]*?\r?\nAREAL_FEEDBACK_END(?:\r?\n|$)/.test(output);
  }, "actual PTY probe output");
  await writeFile(join(evidence, "terminal-output.txt"), output);
  const block = output.match(/\r?\nAREAL_FEEDBACK_BEGIN\r?\n([\s\S]*?)\r?\nAREAL_FEEDBACK_END/)[1];
  const fields = Object.fromEntries(
    block
      .split(/\r?\n/)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  await json("terminal-probe.json", fields);
  await check("terminal/login-interactive-shell", async () => {
    assert.equal(fields.shell, "/bin/zsh");
    assert.match(fields.flags, /i/);
    assert.match(fields.argv0, /(?:^|\/)zsh$/);
    assert.equal(fields.profile, "profile");
    assert.equal(fields.rc, "rc");
    return fields;
  });
  await check("terminal/startup-path-environment", async () => {
    assert.equal(fields.probe, "startup-tool");
    assert.ok(fields.path.split(":").includes(join(userHome, "feedback-bin")), fields.path);
    assert.equal(fields.user, env.USER);
    assert.equal(fields.logname, env.LOGNAME);
    assert.equal(fields.term, "xterm-256color");
    return fields;
  });
  await check("terminal/running-status", async () => {
    await until(
      async () =>
        (await recordedCommands()).some(
          (entry) =>
            entry.request.operation === "process" && entry.result?.runtime?.state === "running",
        ),
      "Core confirms the terminal is running",
    );
    const status = page.getByLabel("终端运行状态", { exact: true });
    const text = await page.locator(".terminal-pane").innerText();
    await writeFile(join(evidence, "terminal-status.txt"), text);
    await capture("terminal-running");
    assert.equal(await status.count(), 0, text);
    assert.ok(!text.includes("终端资源尚未确认清理"), text);
    return { text };
  });
  await command("manage", { projectId, threadId, operation: "processTerminate", id: processId });
  const previousMetadata = metadata,
    requestCount = requests.length;
  await app.close();
  app = null;
  await waitForServiceProcessExit(env.AREAL_CORE_HOME, previousMetadata);
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 60000,
  });
  guiProcess = app.process();
  guiProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  await until(
    async () => (await state()).connection?.state === "ready",
    "reopened desktop service ready",
  );
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  await check("history/restart-without-replay", async () => {
    assert.notEqual(metadata.pid, previousMetadata.pid);
    for (const scenario of completedTurns) {
      const review = await command("workspace", {
        projectId,
        threadId,
        operation: "turnReview",
        turnId: scenario.turnId,
      });
      const file = review.files.find((file) => file.path === scenario.path);
      assert.equal(file?.beforeText, scenario.before || "");
      assert.equal(file?.afterText, scenario.after);
    }
    assert.equal(
      requests.length,
      requestCount,
      "Reopening historical comparisons must not invoke the model",
    );
    await capture("reopened-history");
    return {
      turns: completedTurns.map((turn) => turn.turnId),
      previousPid: previousMetadata.pid,
      pid: metadata.pid,
      extraModelCalls: 0,
    };
  });
  await json("final-snapshot.json", await state());
} catch (error) {
  fatal = error.stack || String(error);
  console.error(error);
  if (page) await captureSmokeFailure(page, evidence, error).catch(() => {});
} finally {
  await writeFile(
    join(evidence, "service.log"),
    await readFile(join(env.AREAL_CORE_HOME, "service.log"), "utf8").catch(() => ""),
  ).catch(() => {});
  if (app) await json("desktop-commands.json", await recordedCommands().catch(() => []));
  if (app && projectId && threadId) {
    const records = await command("manage", { projectId, threadId, operation: "processes" }).catch(
      () => null,
    );
    for (const process of records?.data || [])
      if (!process.cleanupConfirmed) {
        await command("manage", {
          projectId,
          threadId,
          operation: "processTerminate",
          id: process.id,
        }).catch((error) => stderr.push(`Terminal cleanup: ${error.message}`));
      }
  }
  if (app) await app.close().catch((error) => stderr.push(`GUI close: ${error.message}`));
  await application.close();
  cleanup = { passed: false, errors: [] };
  try {
    if (guiProcess)
      await until(
        () => guiProcess.exitCode !== null || guiProcess.signalCode !== null,
        "owned GUI exits",
      );
    if (!metadata)
      metadata = await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
    if (metadata) await waitForServiceProcessExit(env.AREAL_CORE_HOME, metadata);
    const serviceRoot = join(env.AREAL_HARNESS_SERVICE_HOME, "services");
    const names = await readdir(serviceRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const services = [];
    for (const name of names) {
      const record = JSON.parse(await readFile(join(serviceRoot, name, "service.json"), "utf8"));
      assert.ok(
        record.workspace === workspace ||
          record.workspace.startsWith(`${join(userHome, "Documents/AReaL")}/`),
        "private registry workspaces stay inside this isolated run",
      );
      for (const pid of [record.hostPid, record.corePid])
        if (Number.isSafeInteger(pid) && pid > 1)
          await until(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          }, `owned service process ${pid} exits`);
      services.push({
        serviceId: record.serviceId,
        generation: record.generation,
        state: record.state,
        hostPid: record.hostPid,
        corePid: record.corePid,
      });
    }
    await writableDirectories(scratch);
    await rm(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 });
    cleanup = { passed: true, services, removed: scratch };
  } catch (error) {
    cleanup = { passed: false, errors: [error.stack || String(error)] };
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const finalHashes = await hashes();
  await check("artifacts/stable", async () =>
    assert.deepEqual(
      finalHashes,
      initialHashes,
      "Source and fixed binaries remain unchanged during this run",
    ),
  );
  await check("renderer/no-page-errors", async () => assert.deepEqual(pageErrors, []));
  const passed = !fatal && cleanup.passed && checks.every((check) => check.passed);
  await json("model-requests.json", requests);
  await json("actions.json", actions);
  await json("cleanup.json", cleanup);
  await writeFile(join(evidence, "electron.stderr.log"), stderr.join(""));
  await json("manifest.json", {
    passed,
    observe,
    fatal,
    checks,
    cleanup,
    pageErrors,
    initialHashes,
    finalHashes,
    sourceCommit: run.sourceCommit,
    boundary:
      "Real source Electron/Core/Runtime, UI sends and PTY input, deterministic local SSE model, stubbed native directory picker. No real provider, physical keyboard or packaged-app acceptance.",
  });
  console.log(
    JSON.stringify({
      passed,
      observe,
      evidence,
      fatal,
      failedChecks: checks.filter((check) => !check.passed).map((check) => check.id),
      cleanup,
    }),
  );
  if (fatal || !cleanup.passed || (!observe && !passed)) process.exitCode = 1;
}
