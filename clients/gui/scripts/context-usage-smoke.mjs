import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import {
  captureSmokeFailure,
  createProjectConversation,
  resizeConversation,
  selectConversation,
} from "./smoke-navigation.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const WebSocket = require("ws");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary, "Set AREAL_CORE_BIN to the isolated built Core binary");
const scratch = await makeTempDir("acu-");
console.log(`Context usage evidence: ${scratch}`);
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user"),
  skill = join(scratch, "skill");
for (const path of [workspace, userHome, skill]) await mkdir(path);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
await writeFile(join(workspace, "evidence.txt"), "RUNTIME_FILE_EVIDENCE\n");
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: usage-skill\ndescription: Usage fixture\n---\nACTUAL_SKILL_BODY: inspect the fixture evidence.\n",
);
const deployment = join(scratch, "desktop.json"),
  extensions = join(scratch, "tools.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [{ id: "usage-skill", revision: "v1", root: skill }],
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task.",
        allowThreadProcesses: true,
        skills: [{ id: "usage-skill", revision: "v1" }],
      },
    ],
  }),
);
await writeFile(
  extensions,
  JSON.stringify({
    tools: [
      {
        definition: {
          name: "fixture_cli",
          description: "Local command fixture",
          inputSchema: { type: "object", properties: {} },
        },
        argv: ["/usr/bin/true"],
        timeoutMs: 1000,
      },
    ],
  }),
);
const requests = [],
  checks = [],
  errors = [],
  identities = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let held,
  app,
  page,
  projectId,
  failure,
  passed = false;
const write = (response, value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
const chunk = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const usage = (input = 120, output = 30, cache = 20) => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input + output,
  prompt_tokens_details: { cached_tokens: cache },
});
const end = (response, value, reason = "stop") => {
  write(response, {
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(value ? { usage: value } : {}),
  });
  response.end("data: [DONE]\n\n");
};
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    const summary = body.messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.startsWith("Summarize this session prefix"),
    );
    const userIndex = body.messages.findLastIndex(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("USAGE_"),
    );
    const user = body.messages[userIndex];
    const prompt = JSON.stringify(user?.content ?? "");
    const mode = summary
      ? "summary"
      : (["ACTIVITY", "TOOLS", "SINGLE", "UNKNOWN", "ZERO", "ERROR", "CANCEL", "LONG", "LIVE"].find(
          (mode) => prompt.includes(`USAGE_${mode}`),
        ) ?? "normal");
    const record = { model: body.model, mode, request: body, startedAt: Date.now() };
    requests.push(record);
    if (mode === "ERROR") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Deterministic pre-stream error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "ACTIVITY") {
      const tools = body.messages.slice(userIndex + 1).filter((m) => m.role === "tool");
      if (!tools.length) {
        held = () => {
          held = null;
          write(response, {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: randomUUID(),
                      type: "function",
                      function: {
                        name: "fs_read",
                        arguments: JSON.stringify({
                          path: "workspace://repo/evidence.txt",
                          offset: 0,
                          maxBytes: 4096,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          end(response, usage(), "tool_calls");
        };
      } else {
        assert.ok(JSON.stringify(tools).includes("RUNTIME_FILE_EVIDENCE"));
        held = () => {
          write(response, chunk("USAGE_ACTIVITY_OK"));
          held = () => {
            held = null;
            end(response, usage());
          };
        };
      }
      return;
    }
    if (mode === "TOOLS") {
      const tools = body.messages.slice(userIndex + 1).filter((m) => m.role === "tool");
      if (tools.length < 2) {
        const name = tools.length === 0 ? "skill_read" : "fs_read";
        const args =
          tools.length === 0
            ? {
                skill: { id: "usage-skill", revision: "v1" },
                resource: "SKILL.md",
                offset: 0,
                maxBytes: 8192,
              }
            : { path: "workspace://repo/evidence.txt", offset: 0, maxBytes: 4096 };
        write(response, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: randomUUID(),
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        end(response, usage(), "tool_calls");
        return;
      }
      assert.ok(
        JSON.stringify(tools).includes("ACTUAL_SKILL_BODY"),
        "actual skill text reaches final request",
      );
      assert.ok(
        JSON.stringify(tools).includes("RUNTIME_FILE_EVIDENCE"),
        "real Runtime file result reaches final request",
      );
    }
    const answer = summary
      ? "The fixture inspected its local evidence. No work remains."
      : mode === "LONG"
        ? "Long observed result. ".repeat(600)
        : `USAGE_${mode}_OK`;
    const first =
      mode === "SINGLE" || mode === "ZERO" || mode === "CANCEL"
        ? answer
        : answer.slice(0, Math.ceil(answer.length / 2));
    write(response, chunk(first));
    record.firstContentAt = Date.now();
    if (mode === "CANCEL") {
      held = () => {
        end(response, usage());
        held = null;
      };
      return;
    }
    if (mode === "LIVE") {
      held = () => {
        write(response, chunk(" live continuation"));
        end(response, usage());
        held = null;
      };
      return;
    }
    await delay(70);
    if (mode !== "SINGLE" && mode !== "ZERO") write(response, chunk(answer.slice(first.length)));
    await delay(70);
    end(
      response,
      mode === "UNKNOWN"
        ? null
        : mode === "ZERO"
          ? usage(0, 0, 0)
          : summary
            ? usage(70, 8, 0)
            : usage(),
    );
    record.eofAt = Date.now();
  } catch (error) {
    errors.push(error.stack);
    response.destroy(error);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="areal_openai"\nname="gpt-6.1-sol"\n[model.providers.fixture]\nname="Fixture"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\nparameters={contextWindowTokens=32000}\nmodels=[{id="alpha",displayName="Alpha",enabled=true,parameters={contextWindowTokens=64000}},{id="beta",displayName="Beta",enabled=true,parameters={contextWindowTokens=128000}},{id="gamma",displayName="Gamma",enabled=true}]\n[tools]\nextensions_file=${JSON.stringify(extensions)}\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
});
const fixture = await applicationFixture(gui, join(scratch, "application"));
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const evidence = {
  sourceRoot: root,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDiffSha256: createHash("sha256")
    .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
    .digest("hex"),
  binary,
  binarySha256: await hash(binary),
  rendererIndexSha256: await hash(join(gui, "renderer/dist/index.html")),
  scratch,
  checks,
  identities,
  requests,
  errors,
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (s) => s.projects.find((p) => p.id === projectId || p.root === workspace);
const thread = (s, id) => project(s)?.state?.threads?.[id];
async function call(name, parameters = {}) {
  const response = await page.evaluate(
    ({ name, parameters }) => window.arealDesktop.command(name, parameters),
    { name, parameters },
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.value;
}
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const s = await state();
    if (predicate(s)) return s;
    await delay(80);
  }
  throw Error(`Timeout: ${label}`);
}
const currentId = () => page.getByTestId("areal-workbench").getAttribute("data-thread-id");
const context = (id) =>
  call("manage", { projectId, threadId: id, operation: "context", offset: 0, limit: 1 });
async function choose(label) {
  await page.getByTestId("composer-model-trigger").click();
  await page.getByRole("tab", { name: "Fixture", exact: true }).click();
  await page.getByRole("radio", { name: label, exact: true }).click();
  await dismissPopovers();
  await page.waitForFunction((label) => {
    const model = document.querySelector('[data-testid="composer-model-trigger"]');
    return model && !model.disabled && model.textContent.includes(label);
  }, label);
}
async function send(prompt, expectedStatus = "completed") {
  const before = (thread(await state(), await currentId())?.turns ?? []).length;
  await page.getByTestId("chat-input").fill(prompt);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=areal-workbench]")?.dataset.threadId,
  );
  const id = await currentId();
  await until(
    (s) =>
      thread(s, id)?.turns?.length > before && thread(s, id).turns.at(-1).status === expectedStatus,
    `turn ${prompt}`,
  );
  return { id, turn: thread(await state(), id).turns.at(-1) };
}
async function dismissPopovers() {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-slot=popover-content]"));
}
async function showContext(id) {
  await page.getByTestId("context-popover").waitFor({ state: "detached" });
  await page.getByTestId("context-meter").click();
  await page.getByTestId("context-popover").waitFor();
  await page.waitForFunction(() =>
    document.querySelector("[data-testid=context-popover]")?.textContent.includes("输出预留"),
  );
  const result = await context(id);
  const capacity = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(result.contextUsage.budget.windowTokens);
  await page.waitForFunction(
    (capacity) => document.querySelector(".context-usage-total")?.textContent.includes(capacity),
    capacity,
  );
  if (result.contextUsage.kind === "ready")
    assert.equal(
      result.contextUsage.estimate.parts.reduce((sum, part) => sum + part.estimatedTokens, 0),
      result.contextUsage.estimate.tokens,
    );
  return result;
}
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  const child = app.process();
  child.stderr?.on("data", (bytes) =>
    appendFileSync(join(scratch, `electron-${child.pid}.stderr.log`), bytes),
  );
  child.stdout?.on("data", (bytes) =>
    appendFileSync(join(scratch, `electron-${child.pid}.stdout.log`), bytes),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until((s) => s.connection?.state === "ready", "desktop ready");
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 960);
    const p = window.webContents.getLastWebPreferences();
    return {
      electronPid: process.pid,
      userData: app.getPath("userData"),
      url: window.webContents.getURL(),
      security: {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      },
    };
  });
  assert.deepEqual(identity.security, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const { ServiceConnection } = require("../app/src/core/service-client.cjs");
  const observer = new ServiceConnection();
  try {
    await observer.connect(metadata);
    await observer.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
    process.kill(metadata.pid, 0);
    const { token: _token, ...service } = metadata;
    identity.service = service;
    identity.authenticatedHello = true;
  } finally {
    observer.close();
  }
  identities.push(identity);
}
async function close() {
  if (!app) return;
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const child = app.process();
  await app.evaluate(({ app }) => app.quit());
  for (let i = 0; i < 200 && child.exitCode === null; i++) await delay(100);
  assert.notEqual(child.exitCode, null, "Electron exits");
  await assertApplicationStopped(binary, env, metadata);
  app = null;
}
async function verifyAccountCapacity() {
  const descriptor = JSON.parse(
    execFileSync(
      binary,
      ["service", "status", "--instance", project(await state()).core.instanceId, "--json"],
      { env, encoding: "utf8", timeout: 20000 },
    ),
  );
  assert.equal(descriptor.workspace, workspace);
  assert.equal(descriptor.dataDir, join(env.AREAL_CORE_HOME, projectId, "state"));
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find((item) =>
    ["observe", "interact", "manage"].every((permission) => item.permissions?.includes(permission)),
  );
  assert.equal(typeof principal?.token, "string");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${principal.token}` },
        followRedirects: false,
        maxPayload: 4 * 1024 * 1024,
      }),
  });
  try {
    await client.connect();
    let account = await client.request("areal/provider/upsert", {
      expectedRevision: 0,
      provider: {
        id: "fixture_account",
        revision: 0,
        endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        protocol: "chatCompletions",
        contextSource: "account",
        models: ["gpt-6.1-sol", "gpt-6-sol"],
        parameters: {},
        modelParameters: { "gpt-6.1-sol": { contextWindowTokens: 1050000 } },
      },
    });
    const refreshCatalog = async () => {
      await page.waitForFunction(async () => {
        const reply = await window.arealDesktop.command("serviceStatus", {});
        return (
          reply.ok &&
          !reply.value.busy &&
          !reply.value.activeCommands &&
          !reply.value.starting &&
          !reply.value.providerUpdating
        );
      });
      const current = await call("providers", { operation: "list" });
      await call("providers", { operation: "apply", expectedRevision: current.revision });
    };
    await refreshCatalog();
    const created = await call("create", {
      projectId,
      profile: { id: "standard", revision: "v1" },
      model: { providerId: account.id, modelId: "gpt-6.1-sol" },
    });
    const id = created.threadId;
    await selectConversation(page, id);
    const originalBudget = (await showContext(id)).contextUsage.budget;
    assert.equal(originalBudget.windowTokens, 1050000);
    assert.equal(originalBudget.reportedWindowTokens, 1050000);
    assert.equal(originalBudget.windowSource, "account");
    await page
      .getByTestId("context-popover")
      .getByText(/账号报告/)
      .waitFor();
    await dismissPopovers();
    await send("USAGE_ACCOUNT_BEFORE");
    const before = (await client.request("thread/read", { threadId: id, includeTurns: true }))
      .thread;
    assert.equal(before.turns[0].configuration.contextWindow.reportedWindowTokens, 1050000);
    await writeFile(join(scratch, "account-history-before.json"), JSON.stringify(before, null, 2));
    account = await client.request("areal/provider/upsert", {
      expectedRevision: account.revision,
      provider: { ...account, modelParameters: { "gpt-6.1-sol": { contextWindowTokens: 500000 } } },
    });
    await refreshCatalog();
    const updatedBudget = (await showContext(id)).contextUsage.budget;
    assert.equal(updatedBudget.windowTokens, 500000);
    assert.equal(updatedBudget.reportedWindowTokens, 500000);
    assert.equal(updatedBudget.windowSource, "account");
    await page
      .getByTestId("context-popover")
      .getByText(/账号报告/)
      .waitFor();
    await page.screenshot({ path: join(scratch, "10-account-capacity-updated.png") });
    await dismissPopovers();
    assert.deepEqual(
      (await client.request("thread/read", { threadId: id, includeTurns: true })).thread.turns,
      before.turns,
      "account refresh cannot rewrite historical turns",
    );
    await send("USAGE_ACCOUNT_AFTER");
    const after = (await client.request("thread/read", { threadId: id, includeTurns: true }))
      .thread;
    assert.equal(after.turns.length, 2);
    assert.deepEqual(
      after.turns[0],
      before.turns[0],
      "the next admission preserves the complete earlier turn",
    );
    assert.equal(after.turns[1].configuration.contextWindow.reportedWindowTokens, 500000);
    assert.equal(requests.at(-1).model, "gpt-6.1-sol");
    assert.ok(
      requests
        .at(-1)
        .request.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("USAGE_ACCOUNT_BEFORE"),
        ),
      "the old session retains its conversation prefix",
    );
    await writeFile(join(scratch, "account-history-after.json"), JSON.stringify(after, null, 2));
    await call("configure", {
      projectId,
      threadId: id,
      parameters: { contextWindowTokens: 900000 },
    });
    const cappedBudget = (await showContext(id)).contextUsage.budget;
    assert.equal(cappedBudget.windowTokens, 500000);
    assert.equal(cappedBudget.reportedWindowTokens, 500000);
    assert.equal(cappedBudget.userBudgetTokens, 900000);
    assert.equal(cappedBudget.windowSource, "account");
    const popover = page.getByTestId("context-popover");
    await popover.getByText(/账号报告/).waitFor();
    await popover.getByText("用户预算 900K", { exact: true }).waitFor();
    await popover.getByText("用户预算超出报告容量，按报告容量计算。", { exact: true }).waitFor();
    await page.screenshot({ path: join(scratch, "11-account-caps-user-budget.png") });
    await dismissPopovers();
    await call("configure", {
      projectId,
      threadId: id,
      parameters: { contextWindowTokens: 64000 },
    });
    const userBudget = (await showContext(id)).contextUsage.budget;
    assert.equal(userBudget.windowTokens, 64000);
    assert.equal(userBudget.reportedWindowTokens, 500000);
    assert.equal(userBudget.userBudgetTokens, 64000);
    assert.equal(userBudget.windowSource, "user");
    await popover.getByText("用户预算 64K", { exact: true }).waitFor();
    await page.screenshot({ path: join(scratch, "12-user-budget.png") });
    await dismissPopovers();
    const missing = await call("create", {
      projectId,
      profile: { id: "standard", revision: "v1" },
      model: { providerId: account.id, modelId: "gpt-6-sol" },
    });
    await selectConversation(page, missing.threadId);
    const fallbackBudget = (await showContext(missing.threadId)).contextUsage.budget;
    assert.equal(fallbackBudget.windowTokens, 131072);
    assert.equal(fallbackBudget.windowSource, "fallback");
    assert.equal(fallbackBudget.reportedWindowTokens ?? null, null);
    assert.equal(fallbackBudget.userBudgetTokens ?? null, null);
    await popover.getByText(/后备配置/).waitFor();
    await page.screenshot({ path: join(scratch, "13-account-no-report-fallback.png") });
    await dismissPopovers();
    await writeFile(
      join(scratch, "account-budgets.json"),
      JSON.stringify(
        {
          originalBudget,
          updatedBudget,
          cappedBudget,
          userBudget,
          fallbackBudget,
          fixtureBoundary:
            "Authenticated Core provider catalog simulates account reports; user budgets use the public configure command. No subscription account UI or real upstream account is exercised.",
        },
        null,
        2,
      ),
    );
    checks.push(
      "authenticated account-report fixture updates an old session from 1050K to 500K before next admission without rewriting history; ContextMeter reports account provenance, separate user budgets and missing-report fallback",
    );
  } finally {
    client.close();
  }
}
try {
  await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => project(s)?.state?.connected, "project connected");
  projectId = project(await state()).id;
  const activityThread = await call("create", {
    projectId,
    profile: { id: "standard", revision: "v1" },
    model: { providerId: "fixture", modelId: "alpha" },
  });
  await selectConversation(page, activityThread.threadId);
  await page.getByTestId("chat-input").fill("USAGE_ACTIVITY");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const activityObservations = [];
  for (const [stage, label] of [
    ["waiting", "等待模型响应…"],
    ["after-tool", "等待模型继续…"],
    ["streaming", "正在生成回复…"],
  ]) {
    await until(() => !!held, `activity ${stage} barrier`);
    const active = page.locator('[data-turn-status="inProgress"]');
    await active.getByTestId("turn-activity").getByText(label, { exact: true }).waitFor();
    activityObservations.push({
      stage,
      activityCount: await active.getByTestId("turn-activity").count(),
      usageCount: await active.getByTestId("turn-usage").count(),
      statuses: await active.getByRole("status").allTextContents(),
    });
    await page.screenshot({ path: join(scratch, `activity-${stage}.png`) });
    held();
  }
  await until(
    (s) => thread(s, activityThread.threadId)?.turns?.at(-1)?.status === "completed",
    "activity completed",
  );
  await writeFile(
    join(scratch, "activity-observations.json"),
    JSON.stringify(activityObservations, null, 2),
  );
  console.log(JSON.stringify(activityObservations));
  for (const observation of activityObservations) {
    assert.equal(observation.activityCount, 1, `${observation.stage} has one detailed activity`);
    assert.equal(observation.usageCount, 0, `${observation.stage} has no duplicate usage status`);
  }
  assert.equal(await page.getByTestId("turn-activity").count(), 0, "completed activity disappears");
  assert.match(await page.getByTestId("turn-usage").innerText(), /^300 Token/);
  checks.push(
    "one activity during initial wait, after real Runtime tool result and streaming; completed usage replaces activity",
  );
  const created = await call("create", {
    projectId,
    profile: { id: "standard", revision: "v1" },
    model: { providerId: "fixture", modelId: "alpha" },
  });
  const source = created.threadId;
  await selectConversation(page, source);
  const requestsBeforeSelection = requests.length;
  identities.at(-1).coreServices = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 20000 }),
  );
  assert.equal((await showContext(source)).contextUsage.budget.windowTokens, 64000);
  const popup = await page.getByTestId("context-popover").boundingBox();
  const composer = await page.locator(".composer-input-stack .composer-surface").boundingBox();
  await page.screenshot({ path: join(scratch, "00-context-layout.png") });
  assert.ok(composer, "composer is present");
  assert.ok(popup.y + popup.height <= composer.y, "context popup sits above the entire composer");
  assert.ok(
    Math.abs(popup.x + popup.width - composer.x - composer.width) <= 2,
    "context popup aligns with composer right edge",
  );
  assert.equal(
    await page
      .getByTestId("context-popover")
      .getByRole("button", { name: /刷新|压缩上下文/ })
      .count(),
    0,
    "context is observation only",
  );
  await dismissPopovers();
  await choose("Gamma");
  assert.equal((await showContext(source)).contextUsage.budget.windowTokens, 32000);
  await dismissPopovers();
  await choose("Beta");
  assert.equal((await showContext(source)).contextUsage.budget.windowTokens, 128000);
  assert.equal((await context(source)).contextUsage.budget.windowSource, "user");
  assert.equal((await context(source)).contextUsage.budget.userBudgetTokens, 128000);
  await page
    .getByTestId("context-popover")
    .getByText(/用户预算/)
    .waitFor();
  assert.equal(
    requests.length,
    requestsBeforeSelection,
    "A -> provider fallback -> B capacity updates before sending",
  );
  assert.equal(
    await page.getByTestId("context-meter").innerText(),
    "",
    "Composer control is only a ring",
  );
  await page.screenshot({ path: join(scratch, "01-selected-capacity.png") });
  await dismissPopovers();
  const first = await send("USAGE_NORMAL");
  assert.equal(first.turn.usage.inputTokens, 120);
  assert.equal(first.turn.usage.cachedInputTokens, 20);
  assert.equal(first.turn.generation.outputTokens, 30);
  assert.equal(first.turn.generation.measuredRequests, 1);
  assert.ok(first.turn.generation.durationMs >= 100 && first.turn.generation.durationMs < 5000);
  const usageRow = page.getByTestId("turn-usage").last().locator("..");
  assert.ok(
    (await usageRow.getAttribute("class")).includes("message-actions"),
    "usage shares the response action row",
  );
  const branchButton = usageRow.getByRole("button", { name: "从此轮创建聊天分支", exact: true });
  const usageBounds = await page.getByTestId("turn-usage").last().boundingBox(),
    branchBounds = await branchButton.boundingBox();
  assert.ok(usageBounds.x + usageBounds.width <= branchBounds.x + 1, "usage is left of branch");
  assert.equal(
    await page.getByRole("button", { name: /^轮次操作 / }).count(),
    0,
    "there is no separate three-dot turn menu",
  );
  await page.getByTestId("turn-usage").last().click();
  assert.match(
    await page.getByTestId("turn-usage").last().innerText(),
    /^150 Token · [\d.]+ tok\/s$/,
  );
  await page
    .getByTestId("turn-usage-popover")
    .locator("dd")
    .first()
    .getByText("150", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "本轮", exact: true }).click();
  await page.screenshot({ path: join(scratch, "02-turn-usage.png") });
  await dismissPopovers();
  await choose("Alpha");
  const changed = await showContext(source);
  assert.equal(changed.contextUsage.kind, "unavailable");
  assert.equal(changed.contextUsage.budget.windowTokens, 64000);
  await dismissPopovers();
  await branchButton.click();
  const forkDialog = page.getByRole("dialog", { name: "从这里创建聊天分支", exact: true });
  await forkDialog.waitFor();
  assert.equal(
    await page.getByRole("menuitem", { name: /在此轮(之前|之后)分支/ }).count(),
    0,
    "Branch opens the target dialog without a boundary menu",
  );
  await page.keyboard.press("Escape");
  await forkDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("turn-fork-trigger"));
  await branchButton.click();
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await page.waitForFunction(
    (source) =>
      document.querySelector("[data-testid=areal-workbench]")?.dataset.threadId !== source,
    source,
  );
  const fork = { threadId: await currentId() };
  let forkContext = await context(fork.threadId);
  assert.equal(
    forkContext.contextUsage.budget.windowTokens,
    128000,
    "fork keeps accepted anchor configuration",
  );
  assert.equal(forkContext.sessionUsage.knownTurns, 0);
  assert.equal(forkContext.sessionUsage.usage, null);
  await send("USAGE_FORK");
  forkContext = await context(fork.threadId);
  assert.ok(
    requests
      .at(-1)
      .request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("USAGE_NORMAL"),
      ),
    "fork replays the selected first turn instead of an empty prefix",
  );
  assert.equal(
    forkContext.sessionUsage.usage.inputTokens,
    120,
    "fork subtotal excludes ancestor spend",
  );
  checks.push(
    "selected model/provider capacities before send, neutral changed instruction basis, matched generation, fork anchor and own-turn subtotal",
  );
  await createProjectConversation(page, "workspace");
  assert.match(await page.getByTestId("composer-model-trigger").innerText(), /Beta/);
  await send("USAGE_NEW_ACCEPTED");
  assert.equal(requests.at(-1).model, "beta");
  await selectConversation(page, source);
  await choose("Beta");
  const tool = await send("USAGE_TOOLS");
  assert.equal(tool.turn.usage.inputTokens, 360);
  assert.equal(tool.turn.generation.measuredRequests, 1);
  assert.equal(tool.turn.generation.unmeasuredRequests, 2);
  assert.equal(
    tool.turn.generation.outputTokens,
    30,
    "tool-only output is excluded from measured rate numerator",
  );
  const categories = (await showContext(source)).contextUsage.estimate.parts;
  assert.ok(
    categories.find((p) => p.kind === "skills")?.children.some((p) => p.name === "usage-skill"),
  );
  const definitions = categories.find((p) => p.kind === "toolDefinitions").children;
  assert.ok(definitions.some((p) => p.name === "CLI · fixture_cli"));
  assert.ok(definitions.some((p) => p.name === "内置 · run_command"));
  const collapsedFrame = await page.getByTestId("context-popover").boundingBox();
  await page.screenshot({ path: join(scratch, "08-context-collapsed.png") });
  // 分类直接列出占用最多的几项（R-CHECK-019），不再逐个展开。
  assert.equal(await page.locator(".context-category summary").count(), 0);
  const expandedFrame = await page.getByTestId("context-popover").boundingBox();
  await page.screenshot({ path: join(scratch, "03-context-categories.png") });
  await writeFile(
    join(scratch, "context-frame.json"),
    JSON.stringify({ collapsedFrame, expandedFrame }, null, 2),
  );
  for (const axis of ["x", "y", "width", "height"])
    assert.ok(
      Math.abs(collapsedFrame[axis] - expandedFrame[axis]) <= 1,
      `context frame ${axis} stays fixed when categories expand`,
    );
  const scroller = await page.locator(".context-categories").evaluate((element) => ({
    height: element.clientHeight,
    content: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  assert.equal(scroller.overflow, "auto", "categories scroll inside the fixed frame");
  if (scroller.content > scroller.height) {
    await page.locator(".context-categories").hover();
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => document.querySelector(".context-categories")?.scrollTop > 0);
    const scrolledFrame = await page.getByTestId("context-popover").boundingBox();
    for (const axis of ["x", "y", "width", "height"])
      assert.ok(
        Math.abs(expandedFrame[axis] - scrolledFrame[axis]) <= 1,
        `context frame ${axis} stays fixed while scrolling`,
      );
  }
  await page.screenshot({ path: join(scratch, "09-context-scrolled.png") });
  await dismissPopovers();
  for (const mode of ["SINGLE", "UNKNOWN", "ZERO", "ERROR"]) {
    const { turn } = await send(`USAGE_${mode}`, mode === "ERROR" ? "failed" : "completed");
    assert.equal(turn.generation.measuredRequests, 0);
    assert.equal(turn.generation.unmeasuredRequests, 1);
    assert.equal(turn.generation.missingUsageRequests, ["UNKNOWN", "ERROR"].includes(mode) ? 1 : 0);
    if (mode === "ZERO")
      assert.deepEqual(turn.usage, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    assert.ok(!(await page.getByTestId("turn-usage").last().innerText()).includes("tok/s"));
  }
  await page.getByTestId("chat-input").fill("USAGE_CANCEL");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => !!held, "cancel stream began");
  const cancellationReply = delay(250).then(() => held?.());
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until((s) => thread(s, source)?.turns?.at(-1)?.status === "interrupted", "cancel settled");
  const cancelled = thread(await state(), source).turns.at(-1);
  assert.equal(cancelled.usage.inputTokens, 120);
  assert.equal(cancelled.generation.measuredRequests, 0);
  assert.equal(cancelled.generation.usageRequests, 1);
  await cancellationReply;
  await page.getByTestId("chat-input").fill("USAGE_LIVE");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => !!held, "live content is held before provider usage");
  const live = page.locator('[data-turn-status="inProgress"]');
  await live.getByTestId("turn-activity").getByText("正在生成回复…", { exact: true }).waitFor();
  assert.equal(
    await live.getByTestId("turn-usage").count(),
    0,
    "no duplicate activity or invented streaming rate",
  );
  await page.screenshot({ path: join(scratch, "06-generating.png") });
  held();
  await until(
    (s) => thread(s, source)?.turns?.at(-1)?.status === "completed",
    "live stream finishes",
  );
  assert.match(
    await page.getByTestId("turn-usage").last().innerText(),
    /^150 Token · [\d.]+ tok\/s$/,
  );
  const long = await send("USAGE_LONG");
  await showContext(source);
  const beforeCompact = (await context(source)).contextUsage.estimate.tokens;
  await call("manage", { projectId, threadId: source, operation: "contextCompact" });
  await page.waitForFunction(
    (before) => {
      const shown = document.querySelector(".context-usage-total")?.textContent;
      return shown && !shown.includes(before);
    },
    new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
      beforeCompact,
    ),
  );
  await until(
    (s) => thread(s, source)?.turns?.at(-1)?.usage?.inputTokens === 190,
    "manual compact refreshes saved turn usage",
  );
  const compacted = thread(await state(), source).turns.at(-1);
  assert.equal(compacted.id, long.turn.id);
  assert.equal(compacted.usage.outputTokens, 38);
  assert.equal(compacted.generation.outputTokens, 38);
  assert.equal(compacted.generation.measuredRequests, 2);
  await dismissPopovers();
  assert.match(await page.getByTestId("turn-usage").last().innerText(), /^228 Token/);
  const subtotal = (await context(source)).sessionUsage;
  assert.equal(subtotal.unknownTurns, 2);
  assert.equal(subtotal.generation.missingUsageRequests, 2);
  const own = thread(await state(), source).turns;
  assert.equal(
    subtotal.usage.inputTokens,
    own.reduce((n, t) => n + (t.usage?.inputTokens ?? 0), 0),
  );
  checks.push(
    "accepted new-session preference, actual Skills and Runtime results, CLI registry classification, single/missing/zero/error/cancel coverage, compact updates saved usage and matched rate",
  );
  await showContext(source);
  await page.screenshot({ path: join(scratch, "07-final-context.png") });
  await dismissPopovers();
  await resizeConversation(app, page, 780, 900);
  await showContext(source);
  const bounds = await page.getByTestId("context-popover").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 780);
  await page.screenshot({ path: join(scratch, "04-narrow-context.png") });
  await dismissPopovers();
  const before = requests.length,
    saved = structuredClone(
      thread(await state(), source).turns.map(({ usage, generation }) => ({ usage, generation })),
    );
  await close();
  await launch();
  await until((s) => project(s)?.state?.connected, "reopened project");
  await selectConversation(page, source);
  assert.deepEqual(
    thread(await state(), source).turns.map(({ usage, generation }) => ({ usage, generation })),
    saved,
  );
  assert.equal(requests.length, before, "reopen never resubmits model requests");
  await page.getByTestId("turn-usage").last().click();
  await page.getByText("部分用量未确认", { exact: true }).waitFor();
  await page.screenshot({ path: join(scratch, "05-reopened-usage.png") });
  await dismissPopovers();
  const localeRequests = requests.length;
  const localeTurns = structuredClone(thread(await state(), source).turns);
  const localeWindow = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  const localeSidebarOpen = await page
    .getByRole("button", { name: "收起侧栏", exact: true })
    .isVisible();
  const localeDraft = "LOCALE_DRAFT_UNSENT";
  await page.getByTestId("chat-input").fill(localeDraft);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator(".settings-category-navigation")
    .getByRole("button", { name: "常规", exact: true })
    .click();
  await page
    .getByRole("tablist", { name: "语言", exact: true })
    .getByRole("tab", { name: "English", exact: true })
    .click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  assert.equal((await page.getByTestId("chat-input").innerText()).trim(), localeDraft);
  await resizeConversation(app, page, 780, 900);
  await page.getByRole("button", { name: "Context usage", exact: true }).click();
  const englishContext = page.getByTestId("context-popover");
  await englishContext.getByText("Context", { exact: true }).waitFor();
  await englishContext.getByText(/^Output reserve /).waitFor();
  await englishContext.getByText("All values are estimates", { exact: true }).waitFor();
  const englishBounds = await englishContext.boundingBox();
  assert.ok(
    englishBounds.x >= 0 && englishBounds.x + englishBounds.width <= 780,
    "English context fits the narrow viewport",
  );
  await page.screenshot({ path: join(scratch, "14-english-context.png") });
  await englishContext.getByRole("button", { name: "Close context details", exact: true }).click();
  await englishContext.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "View token usage", exact: true }).last().click();
  const englishUsage = page.getByTestId("turn-usage-popover");
  await englishUsage.getByText("Usage details", { exact: true }).waitFor();
  await englishUsage.getByRole("button", { name: "This turn", exact: true }).click();
  assert.equal(
    await englishUsage
      .getByRole("button", { name: "This turn", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await englishUsage.getByText("Input", { exact: true }).locator("..").locator("dd").innerText(),
    "190",
  );
  await englishUsage.getByText("2 / 2 requests", { exact: true }).waitFor();
  await englishUsage.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
  await page.screenshot({ path: join(scratch, "15-english-usage.png") });
  await dismissPopovers();
  const englishActivity = page.getByRole("button", { name: /^Activity: / }).first();
  const activityExpanded = await englishActivity.getAttribute("aria-expanded");
  await englishActivity.click();
  assert.notEqual(await englishActivity.getAttribute("aria-expanded"), activityExpanded);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-category-navigation")
    .getByRole("button", { name: "General", exact: true })
    .click();
  await page
    .getByRole("tablist", { name: "Language", exact: true })
    .getByRole("tab", { name: "简体中文", exact: true })
    .click();
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  assert.equal((await page.getByTestId("chat-input").innerText()).trim(), localeDraft);
  assert.deepEqual(
    thread(await state(), source).turns,
    localeTurns,
    "Locale switches preserve authoritative history and usage",
  );
  assert.equal(
    requests.length,
    localeRequests,
    "Locale switches and translated controls never invoke the model",
  );
  await page.getByTestId("chat-input").fill("");
  checks.push(
    "real zh-CN/en settings switch preserves draft and history; English context, usage scope, literal counts, ICU request plural and activity disclosure work in a narrow viewport",
  );
  await resizeConversation(app, page, localeWindow.width, localeWindow.height);
  if (localeSidebarOpen) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await verifyAccountCapacity();
  assert.deepEqual(errors, []);
  checks.push("narrow popover, Escape, persistence and reopen without resubmission");
  passed = true;
} catch (error) {
  failure = error;
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  held?.();
  try {
    await close();
  } catch (error) {
    failure ??= error;
    passed = false;
  }
  await fixture.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const cleanup = { servicesStopped: !app, removed: [], preserved: !passed || !!failure };
  if (passed && !failure) {
    for (const name of [
      "core",
      "electron",
      "registry",
      "workspace",
      "user",
      "skill",
      "application",
      "config.toml",
      "desktop.json",
      "tools.json",
    ]) {
      const path = join(scratch, name);
      await rm(path, { recursive: true, force: true });
      cleanup.removed.push(path);
    }
  }
  await writeFile(join(scratch, "cleanup.json"), JSON.stringify(cleanup, null, 2));
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify(
      { ...evidence, passed, failure: failure?.stack, completedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(JSON.stringify({ passed, checks, evidence: join(scratch, "evidence.json") }, null, 2));
