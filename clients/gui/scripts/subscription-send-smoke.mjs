import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

const gui = resolve(import.meta.dirname, "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const startupMode = process.argv.includes("--startup");
const worktreeMode = process.argv.includes("--worktree");
assert.ok(!(startupMode && worktreeMode), "Choose one subscription regression mode");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "Set AREAL_CORE_BIN to an absolute fixed Core binary");
const scratch = await makeTempDir("subscription-send-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
if (worktreeMode) {
  await writeFile(join(workspace, "README.md"), "Committed subscription Worktree fixture.\n");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Seed Worktree fixture",
    ],
    { cwd: workspace, stdio: "ignore" },
  );
}
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
  NO_PROXY: [env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
});
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const identity = {
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
  guiDiffHash: createHash("sha256")
    .update(execFileSync("git", ["diff", "HEAD", "--", "clients/gui"], { cwd: root }))
    .digest("hex"),
  binary,
  coreHash: await hash(binary),
  scriptHash: await hash(new URL(import.meta.url)),
  rendererHash: await hash(join(gui, "renderer/dist/index.html")),
};
const requests = [],
  errors = [],
  checks = [],
  observations = [],
  expected = new Map();
const heldResponses = new Map();
const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const respond = (response, text) => {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    [
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "fixture-message",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
};
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (JSON.stringify(body).includes("Generate a concise semantic session title")) {
      respond(response, "Fixture session");
      return;
    }
    const messages = body.messages ?? (Array.isArray(body.input) ? body.input : []);
    const users = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !textOf(message).startsWith("AReaL runtime context (not a user request):"),
      )
      .map(textOf);
    const text = users.at(-1),
      entry = expected.get(text);
    assert.ok(entry, "Inference carries an expected exact user input");
    assert.equal(request.method, "POST", "Inference uses one model POST");
    if (entry.subscription !== false) {
      assert.equal(
        request.headers["x-subscription-send-fixture"],
        "synthetic-grant",
        "Inference traverses the real subscription custom fetch",
      );
      assert.equal(body.model, "gpt-6.1-sol", "Inference uses the selected subscription model");
    } else
      assert.equal(body.model, "fixture", "Inference uses the selected non-subscription model");
    assert.deepEqual(
      users,
      entry.history,
      "Inference receives exact user input and conversation history",
    );
    assert.equal(
      requests.filter((item) => item.text === text).length,
      0,
      "A UI send is never replayed",
    );
    requests.push({ text, users, model: body.model, at: Date.now() });
    if (entry.subscription === false) respond(response, entry.reply);
    else heldResponses.set(text, response);
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
const auditPath = join(scratch, "subscription.jsonl");
const controlPath = join(scratch, "catalog-control.json");
const catalogGate = join(scratch, "catalog.gate");
const worktreeGate = join(scratch, "worktree-subscription.gate");
const bootstrap = (endpoint) => `
const { AppProviders } = require(${JSON.stringify(join(gui, "app/src/core/providers.cjs"))});
const { CoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const { appendFileSync, existsSync, readFileSync, unlinkSync } = require('node:fs');
const stamp = value => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ at: Date.now(), ...value }) + String.fromCharCode(10));
if (!process.argv.includes('--areal-core-service')) {
  const { dialog } = require('electron');
  const showMessageBox = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = (...args) => {
    if (['退出 AReaL Harness？', 'Quit AReaL Harness?'].includes(args.at(-1).message)) {
      stamp({ boundary: 'quit.confirmation', injected: true });
      return Promise.resolve({ response: 1 });
    }
    return showMessageBox(...args);
  };
}
${
  worktreeMode
    ? `
const gatedOwners = new Map();
const appliedOwners = new Set();
const applySubscription = AppProviders.prototype.applySubscription;
AppProviders.prototype.applySubscription = async function(scope, ...args) {
  const project = scope.target.project;
  const sample = existsSync(${JSON.stringify(worktreeGate)}) ? readFileSync(${JSON.stringify(worktreeGate)}, 'utf8') : undefined;
  if (sample && project.logicalProjectId && !appliedOwners.has(project.id)) {
    if (!gatedOwners.has(sample)) gatedOwners.set(sample, project.id);
    if (gatedOwners.get(sample) === project.id) {
      stamp({ boundary: 'worktree.subscription', phase: 'held', sample, projectId: project.id, logicalProjectId: project.logicalProjectId, root: project.root, coreServiceId: project.service?.serviceId });
      while (existsSync(${JSON.stringify(worktreeGate)}) && readFileSync(${JSON.stringify(worktreeGate)}, 'utf8') === sample)
        await new Promise(resolve => setTimeout(resolve, 20));
      stamp({ boundary: 'worktree.subscription', phase: 'released', sample, projectId: project.id, logicalProjectId: project.logicalProjectId });
    }
  }
  const result = await applySubscription.call(this, scope, ...args);
  appliedOwners.add(project.id);
  stamp({ boundary: 'worktree.subscription', phase: 'applied', sample, projectId: project.id, logicalProjectId: project.logicalProjectId, providerId: result?.id });
  return result;
};
let instrumented = false;
const connect = CoreBackend.prototype.connect;
CoreBackend.prototype.connect = async function(...args) {
  if (!instrumented) {
    const { CoreClient } = await import(${JSON.stringify(join(gui, "packages/runtime-client/core.js"))});
    const backend = this;
    const request = CoreClient.prototype.request;
    CoreClient.prototype.request = function(method, params, ...options) {
      if (!['areal/thread/start', 'areal/provider/upsert'].includes(method))
        return request.call(this, method, params, ...options);
      const project = [...backend.projects.values()].find(project => project.client === this);
      const owner = { projectId: project?.id, logicalProjectId: project?.logicalProjectId, root: project?.root, coreServiceId: project?.service?.serviceId };
      stamp({ boundary: 'worktree.rpc', phase: 'dispatch', method, ...owner, requestId: params?.requestId, model: params?.model, providerId: params?.provider?.id });
      return request.call(this, method, params, ...options).then(result => {
        stamp({ boundary: 'worktree.rpc', phase: 'response', method, ...owner, requestId: params?.requestId, threadId: result?.thread?.id });
        return result;
      }, error => {
        stamp({ boundary: 'worktree.rpc', phase: 'error', method, ...owner, requestId: params?.requestId, code: error.code, message: error.message, data: error.data });
        throw error;
      });
    };
    instrumented = true;
  }
  return connect.call(this, ...args);
};
`
    : ""
}
let catalogControl;
const dispatch = CoreBackend.prototype.dispatchCommand;
CoreBackend.prototype.dispatchCommand = async function(invocation, ...args) {
  if (invocation.name === 'send' && existsSync(${JSON.stringify(controlPath)})) {
    catalogControl = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
    unlinkSync(${JSON.stringify(controlPath)});
    const service = await this.providers.openai();
    service.catalog.expiresAt = 0;
    stamp({ boundary: 'catalog.expire', sample: catalogControl.sample, models: service.models.map(model => model.id), metadata: service.catalog.metadata(), revision: service.account.revision });
    if (catalogControl.background) void service.discover().catch(error => stamp({ boundary: 'catalog.background.error', code: error.code }));
  }
  return dispatch.call(this, invocation, ...args);
};
AppProviders.prototype.openai = function() {
  if (!this.openaiPromise) this.openaiPromise = import(${JSON.stringify(join(gui, "packages/chatgpt-provider/core.js"))}).then(({ CoreSubscription }) => {
    let record = { kind: 'grant', payload: { type: 'oauth', access: 'synthetic-fixture-access', refresh: 'synthetic-fixture-refresh',
      expires: Date.now() + 3600000, accountId: 'fixture-account', clientId: 'fixture-client', subject: 'fixture-account',
      hostId: 'urn:uuid:fixture', issuer: 'https://auth.openai.com', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] } };
    let chain = Promise.resolve();
    const store = { check() {}, readRecord: async () => structuredClone(record),
      modifyRecord(_key, mutate) { const work = chain.then(async () => { const next = await mutate(structuredClone(record)); if (next !== undefined) record = next; return structuredClone(record); }); chain = work.catch(() => {}); return work; },
      deleteRecord: async () => { record = undefined; } };
    this.openaiStore = store;
    return this.openaiService = new CoreSubscription({ store, token: this.openaiToken, port: this.transport.port, kind: 'openai',
      onListen: async port => { this.transport.port = port; await this.backend.save('subscription-transport.json', this.transport); },
      onRequest: value => stamp({ boundary: 'inference.audit', providerId: value.providerId, model: value.model, outcome: value.outcome }),
      fetch: async (url, options) => {
        if (url === 'https://api.openai.com/v1/models') {
          if (existsSync(${JSON.stringify(controlPath)})) {
            catalogControl = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
            unlinkSync(${JSON.stringify(controlPath)});
          }
          const control = catalogControl;
          stamp({ boundary: 'catalog.fetch', phase: 'start', sample: control?.sample, mode: control?.mode });
          if (control?.mode === 'held') {
            stamp({ boundary: 'catalog.gate', phase: 'held', sample: control.sample });
            while (existsSync(${JSON.stringify(catalogGate)})) {
              options.signal.throwIfAborted();
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          if (control?.mode === 'rejected') {
            stamp({ boundary: 'catalog.fetch', phase: 'rejected', sample: control.sample });
            return Response.json({ error: { message: 'Synthetic catalog unavailable' } }, { status: 503 });
          }
          stamp({ boundary: 'catalog.fetch', phase: 'finish', sample: control?.sample });
          return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'Fixture GPT 6.1', visibility: 'list', context_window: 200000 }] });
        }
        if (url === 'https://api.openai.com/v1/responses') {
          stamp({ boundary: 'inference.fetch', model: JSON.parse(options.body).model });
          return fetch(${JSON.stringify(endpoint)}, { ...options, headers: { ...options.headers, 'x-subscription-send-fixture': 'synthetic-grant' } });
        }
        throw Error('Unexpected synthetic subscription URL');
      } });
  });
  return this.openaiPromise;
};
`;
let application,
  app,
  page,
  metadata,
  passed = false,
  failure,
  cleanup;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const projectOf = (value) => value.projects.find((item) => item.root === workspace);
const audit = async () =>
  (
    await readFile(auditPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  )
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const until = async (read, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Timeout: ${label}`);
};
const turnFor = (project, text) => {
  for (const thread of Object.values(project?.state?.threads ?? {})) {
    const turn = thread.turns?.find((turn) =>
      turn.items?.some((item) => item.type === "userMessage" && textOf(item) === text),
    );
    if (turn) return { thread, turn };
  }
};
async function restartWithHeldCatalog(sample) {
  await app.close();
  app = null;
  page = null;
  await assertApplicationStopped(binary, env, metadata);
  await writeFile(catalogGate, "held");
  await writeFile(controlPath, JSON.stringify({ sample, mode: "held" }));
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void writeFile(join(scratch, `${sample}-electron.log`), chunk, { flag: "a" });
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await until(
    async () =>
      (await audit()).some((item) => item.boundary === "catalog.gate" && item.sample === sample),
    `${sample} reaches the real external subscription catalog gate`,
  );
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
}
async function startup() {
  const historyText = "Startup history remains available while the subscription catalog waits.";
  const draftText = "Startup draft survives the held subscription catalog.";
  const historyReply = "STARTUP_HISTORY_RESTORED";
  const draftReply = "STARTUP_NORMAL_SEND_COMPLETE";
  expected.set(historyText, { subscription: false, history: [historyText], reply: historyReply });
  await page.getByTestId("chat-input").fill(historyText);
  await page.getByTestId("chat-send-button").click();
  const seeded = await until(async () => {
    const result = turnFor(projectOf(await snapshot()), historyText);
    return result?.turn.status === "completed" && result.thread.status?.type === "idle"
      ? result
      : false;
  }, "First launch persists real Core history");
  const projectId = projectOf(await snapshot()).id;
  const threadId = seeded.thread.id;
  const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
  await page.getByTestId("chat-input").fill(draftText);
  await until(
    () =>
      page.evaluate(({ key, text }) => localStorage.getItem(key) === text, {
        key: draftKey,
        text: draftText,
      }),
    "Composer persists the exact draft",
  );
  await page.screenshot({ path: join(scratch, "startup-seeded.png") });
  await writeFile(join(scratch, "startup-seeded.json"), JSON.stringify(await snapshot(), null, 2));
  const requestsBeforeRestart = requests.length;
  await restartWithHeldCatalog("startup-held");
  try {
    await until(
      async () => {
        const state = await snapshot();
        const project = projectOf(state);
        const visible = await page.locator("body").innerText();
        return (
          state.connection?.state === "ready" &&
          project?.state?.connected &&
          project.state.threads[threadId]?.turns?.some((turn) =>
            turn.items?.some((item) => item.type === "agentMessage" && item.text === historyReply),
          ) &&
          visible.includes(historyText) &&
          visible.includes(historyReply) &&
          (await page.getByTestId("chat-input").count()) === 1 &&
          (await page.getByTestId("chat-input").innerText()) === draftText &&
          (await page.getByTestId("chat-input").isEditable()) &&
          (await page.getByTestId("chat-send-button").isEnabled())
        );
      },
      "Saved history and draft are usable while subscription catalog remains held",
      15000,
    );
  } finally {
    const evidence = {
      snapshot: await snapshot(),
      body: await page.locator("body").innerText(),
      audit: await audit(),
      requests,
    };
    await writeFile(join(scratch, "startup-held.json"), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: join(scratch, "startup-held.png") });
  }
  assert.equal(
    requests.length,
    requestsBeforeRestart,
    "Restart never replays historical inference",
  );
  assert.ok(
    !(await audit()).some(
      (item) =>
        item.boundary === "catalog.fetch" &&
        item.phase === "finish" &&
        item.sample === "startup-held",
    ),
    "Catalog remains held during restored history and draft assertions",
  );
  expected.set(draftText, {
    subscription: false,
    history: [historyText, draftText],
    reply: draftReply,
  });
  await page.getByTestId("chat-send-button").click();
  await until(
    async () => {
      const result = turnFor(projectOf(await snapshot()), draftText);
      return (
        result?.turn.status === "completed" &&
        result.thread.status?.type === "idle" &&
        result.turn.items?.some((item) => item.type === "agentMessage" && item.text === draftReply)
      );
    },
    "Restored non-subscription conversation sends and completes while catalog remains held",
    8000,
  );
  assert.equal(
    requests.filter((item) => item.text === draftText).length,
    1,
    "Normal-provider draft is sent exactly once",
  );
  assert.ok(
    !(await audit()).some(
      (item) =>
        item.boundary === "catalog.fetch" &&
        item.phase === "finish" &&
        item.sample === "startup-held",
    ),
    "Normal-provider inference completes before catalog release",
  );
  checks.push(
    "Fresh owned restart restores saved project, exact Core history and editable persisted draft while subscription catalog is held; normal-provider send completes exactly once before release",
  );
  await rm(catalogGate);
  await until(
    async () =>
      projectOf(await snapshot())?.models?.some(
        (model) =>
          model.providerId === "areal_openai" &&
          model.modelId === "gpt-6.1-sol" &&
          model.availability === "available",
      ),
    "Released subscription catalog eventually publishes available models",
  );
  assert.ok(
    (await audit()).some(
      (item) =>
        item.boundary === "catalog.fetch" &&
        item.phase === "finish" &&
        item.sample === "startup-held",
    ),
    "Subscription model publication follows released external discovery",
  );
  checks.push(
    "Releasing the external catalog publishes the subscription model without restarting or discarding history",
  );

  const subscriptionDraft = "Startup subscription draft survives until account model readiness.";
  const subscriptionReply = "STARTUP_SUBSCRIPTION_SEND_COMPLETE";
  await page.getByTestId("composer-model-trigger").click();
  await page.getByRole("tab", { name: "ChatGPT", exact: true }).click();
  await page.locator('[data-model-value="areal_openai/gpt-6.1-sol"]').getByRole("radio").click();
  await page.keyboard.press("Escape");
  await until(
    async () =>
      projectOf(await snapshot())?.configurations?.[threadId]?.model?.providerId === "areal_openai",
    "Existing conversation persists the subscription selection through the UI",
  );
  await page.getByTestId("chat-input").fill(subscriptionDraft);
  await until(
    () =>
      page.evaluate(({ key, text }) => localStorage.getItem(key) === text, {
        key: draftKey,
        text: subscriptionDraft,
      }),
    "Subscription-selected conversation persists the exact draft",
  );
  await writeFile(
    join(scratch, "startup-subscription-seeded.json"),
    JSON.stringify(await snapshot(), null, 2),
  );
  await page.screenshot({ path: join(scratch, "startup-subscription-seeded.png") });
  const requestsBeforeSubscriptionRestart = requests.length;
  await restartWithHeldCatalog("startup-subscription-held");
  try {
    await until(
      async () => {
        const state = await snapshot(),
          project = projectOf(state);
        const visible = await page.locator("body").innerText();
        const selected = project?.configurations?.[threadId]?.model;
        return (
          state.connection?.state === "ready" &&
          project?.state?.connected &&
          selected?.providerId === "areal_openai" &&
          selected.modelId === "gpt-6.1-sol" &&
          state.subscription?.authenticated === true &&
          state.subscription?.availability === "checking" &&
          visible.includes(historyText) &&
          visible.includes(historyReply) &&
          visible.includes(draftText) &&
          visible.includes(draftReply) &&
          (await page.getByTestId("chat-input").count()) === 1 &&
          (await page.getByTestId("chat-input").innerText()) === subscriptionDraft &&
          (await page.getByTestId("chat-input").isEditable()) &&
          (await page.getByTestId("chat-send-button").isEnabled()) &&
          (await page.getByTestId("composer-model-trigger").isEnabled())
        );
      },
      "Subscription-selected restart restores history, draft and Send before account catalog readiness",
      15000,
    );
    await page.getByTestId("composer-model-trigger").click();
    await page.getByRole("tab", { name: "fixture", exact: true }).click();
    assert.equal(
      await page.locator('[data-model-value="fixture/fixture"]').getByRole("radio").isEnabled(),
      true,
      "Held subscription discovery leaves the normal-provider model choice available",
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.getByTestId("chat-input").innerText(),
      subscriptionDraft,
      "Opening model choices preserves the exact subscription draft",
    );
    assert.equal(
      await page.getByTestId("chat-send-button").isEnabled(),
      true,
      "The checking subscription selection remains sendable",
    );
    assert.equal(
      requests.length,
      requestsBeforeSubscriptionRestart,
      "Subscription-selected restart and model choices never replay inference",
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .locator(".settings-category-navigation")
      .getByRole("button", { name: "模型设置", exact: true })
      .click();
    const subscriptionRow = page
      .locator(".provider-navigation")
      .getByRole("button", { name: "ChatGPT", exact: true });
    await subscriptionRow.waitFor();
    const grouping = await subscriptionRow.evaluate((element) => ({
      group: element.closest("section")?.textContent,
      text: element.textContent,
      top: element.getBoundingClientRect().top,
    }));
    assert.ok(
      grouping.group?.includes("已启用"),
      "Validated durable authentication places ChatGPT in enabled providers before discovery finishes",
    );
    await page.screenshot({ path: join(scratch, "startup-subscription-settings-held.png") });
    await writeFile(
      join(scratch, "startup-subscription-settings-held.json"),
      JSON.stringify({ grouping, snapshot: await snapshot() }, null, 2),
    );
    await page.getByRole("button", { name: "返回应用", exact: true }).click();
    expected.set(subscriptionDraft, {
      history: [historyText, draftText, subscriptionDraft],
      reply: subscriptionReply,
    });
    await page.getByTestId("chat-send-button").click();
    await until(
      async () => await page.getByTestId("chat-send-button").isDisabled(),
      "Subscription submission enters its first initialization barrier",
    );
    assert.equal(
      requests.length,
      requestsBeforeSubscriptionRestart,
      "First initialization does not dispatch inference before catalog preparation",
    );

    assert.ok(
      !(await audit()).some(
        (item) =>
          item.boundary === "catalog.fetch" &&
          item.phase === "finish" &&
          item.sample === "startup-subscription-held",
      ),
      "Subscription readiness assertions finish while external catalog remains held",
    );
  } finally {
    await writeFile(
      join(scratch, "startup-subscription-held.json"),
      JSON.stringify(
        {
          snapshot: await snapshot(),
          body: await page.locator("body").innerText(),
          audit: await audit(),
          requests,
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: join(scratch, "startup-subscription-held.png") });
  }
  checks.push(
    "Second cold restart restores the subscription selection, draft, history and enabled Send while account catalog discovery is held",
  );
  await rm(catalogGate);
  await until(
    async () =>
      projectOf(await snapshot())?.models?.some(
        (model) =>
          model.providerId === "areal_openai" &&
          model.modelId === "gpt-6.1-sol" &&
          model.availability === "available",
      ),
    "Released account catalog initializes the persisted subscription selection without restart",
  );
  assert.ok(
    (await audit()).some(
      (item) =>
        item.boundary === "catalog.fetch" &&
        item.phase === "finish" &&
        item.sample === "startup-subscription-held",
    ),
    "Subscription readiness follows release of the second external catalog request",
  );
  await until(
    async () =>
      requests.some((item) => item.text === subscriptionDraft) &&
      (await page.getByTestId("chat-input").innerText()).trim() === "" &&
      turnFor(projectOf(await snapshot()), subscriptionDraft)?.turn.status === "inProgress",
    "Restored subscription draft is admitted exactly once through the real subscription transport",
  );
  const response = heldResponses.get(subscriptionDraft);
  assert.ok(
    response && !response.writableEnded,
    "Subscription response remains held until draft admission is observed",
  );
  respond(response, subscriptionReply);
  heldResponses.delete(subscriptionDraft);
  await until(async () => {
    const result = turnFor(projectOf(await snapshot()), subscriptionDraft);
    return (
      result?.turn.status === "completed" &&
      result.thread.status?.type === "idle" &&
      result.turn.items?.some(
        (item) => item.type === "agentMessage" && item.text === subscriptionReply,
      ) &&
      (await page.locator("body").innerText()).includes(subscriptionReply)
    );
  }, "Subscription-selected restart completes the unchanged draft and returns to authoritative idle");
  assert.equal(
    requests.filter((item) => item.text === subscriptionDraft).length,
    1,
    "Restored subscription draft completes with exactly one inference POST",
  );
  assert.equal(
    requests.length,
    requestsBeforeSubscriptionRestart + 1,
    "Catalog release never replays saved conversation history",
  );
  checks.push(
    "Releasing the second catalog gate preserves the exact draft, enables Send without restart and completes exactly one real subscription-transport POST with the restored history",
  );
}
async function worktree() {
  for (const subscription of [false, true]) {
    const sample = subscription ? "subscription-worktree" : "normal-worktree";
    const text = `First prompt in ${sample}.`;
    const reply = `${sample.toUpperCase()}_COMPLETE`;
    await createProjectConversation(page, "workspace");
    await page.getByTestId("composer-model-trigger").click();
    await page
      .getByRole("tab", { name: subscription ? "ChatGPT" : "fixture", exact: true })
      .click();
    await page
      .locator(
        `[data-model-value="${subscription ? "areal_openai/gpt-6.1-sol" : "fixture/fixture"}"]`,
      )
      .getByRole("radio")
      .click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "新会话工作区", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "在新 Worktree 中工作", exact: true });
    await until(async () => await toggle.isEnabled(), "Worktree options load");
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    assert.equal(
      await toggle.getAttribute("aria-checked"),
      "true",
      "Fresh project draft selects Worktree before Send",
    );
    await page.keyboard.press("Escape");
    expected.set(text, { subscription, history: [text], reply });
    await writeFile(worktreeGate, sample);
    await page.getByTestId("chat-input").fill(text);
    await page.getByTestId("chat-send-button").click();
    const held = await until(
      async () =>
        (await audit()).find(
          (item) =>
            item.boundary === "worktree.subscription" &&
            item.phase === "held" &&
            item.sample === sample,
        ),
      `${sample} reaches execution-owner subscription synchronization`,
    );
    try {
      assert.equal(
        held.logicalProjectId,
        projectOf(await snapshot()).id,
        "Gate belongs to the logical project's execution owner",
      );
      assert.notEqual(held.projectId, held.logicalProjectId, "Worktree owns a distinct real Core");
      assert.notEqual(held.root, workspace, "Execution owner uses the created Git Worktree");
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: held.root, encoding: "utf8" }).trim(),
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(),
        "Worktree starts from the committed fixture",
      );
      if (!subscription) {
        await until(
          async () => turnFor(projectOf(await snapshot()), text)?.turn.status === "completed",
          "Normal-provider Worktree first prompt completes while subscription sync stays held",
          8000,
        );
        assert.equal(
          requests.filter((item) => item.text === text).length,
          1,
          "Normal Worktree first prompt reaches inference exactly once before subscription release",
        );
        checks.push(
          "Normal-provider Worktree first prompt completes once while its execution-owner subscription synchronization is held",
        );
      }
      if (subscription) {
        const deadline = Date.now() + 750;
        do {
          const events = await audit();
          assert.equal(
            events.some(
              (item) =>
                item.boundary === "worktree.rpc" &&
                item.phase === "dispatch" &&
                item.method === "areal/thread/start" &&
                item.projectId === held.projectId,
            ),
            false,
            "Subscription Worktree never dispatches thread/start to an execution Core before its provider is synchronized",
          );
          assert.equal(
            events.some(
              (item) =>
                item.boundary === "worktree.rpc" &&
                item.phase === "dispatch" &&
                item.method === "areal/provider/upsert" &&
                item.providerId === "areal_openai" &&
                item.projectId === held.projectId,
            ),
            false,
            "Gate holds the real provider application before provider upsert",
          );
          assert.equal(
            requests.some((item) => item.text === text),
            false,
            "Held subscription creation never falls back to another inference provider",
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
      }
    } finally {
      await writeFile(
        join(scratch, `${sample}-held.json`),
        JSON.stringify(
          { held, snapshot: await snapshot(), audit: await audit(), requests },
          null,
          2,
        ),
      );
      await page.screenshot({ path: join(scratch, `${sample}-held.png`) });
    }
    await rm(worktreeGate);
    if (subscription) {
      await until(
        () => heldResponses.has(text),
        "Released subscription Worktree reaches real subscription inference",
      );
      respond(heldResponses.get(text), reply);
      heldResponses.delete(text);
    }
    const completed = await until(async () => {
      const result = turnFor(projectOf(await snapshot()), text);
      return result?.turn.status === "completed" &&
        result.thread.status?.type === "idle" &&
        result.turn.items?.some((item) => item.type === "agentMessage" && item.text === reply)
        ? result
        : false;
    }, `${sample} completes its first prompt and returns to authoritative idle`);
    const current = projectOf(await snapshot());
    assert.deepEqual(
      current.configurations[completed.thread.id].model,
      {
        providerId: subscription ? "areal_openai" : "fixture",
        modelId: subscription ? "gpt-6.1-sol" : "fixture",
      },
      "Core preserves the selected Worktree model",
    );
    const events = await audit();
    const starts = events.filter(
      (item) =>
        item.boundary === "worktree.rpc" &&
        item.phase === "dispatch" &&
        item.method === "areal/thread/start" &&
        item.projectId === held.projectId,
    );
    assert.equal(starts.length, 1, "Worktree creates exactly one thread in its execution Core");
    assert.equal(
      events.some(
        (item) =>
          item.boundary === "worktree.rpc" &&
          item.phase === "error" &&
          item.projectId === held.projectId,
      ),
      false,
      "Execution Core reports no thread creation or provider errors",
    );
    assert.equal(
      requests.filter((item) => item.text === text).length,
      1,
      "First Worktree prompt completes with exactly one inference POST",
    );
    const operation = current.worktreeOperations.find(
      (item) => item.executionProjectId === held.projectId,
    );
    assert.equal(
      operation.threadId,
      completed.thread.id,
      "Worktree journal binds the authoritative created thread",
    );
    assert.equal(operation.state, "ready", "Worktree journal reaches ready");
    assert.equal(operation.setup, undefined, "First-prompt regression uses no environment script");
    await page.getByText(reply, { exact: true }).waitFor();
    await page.screenshot({ path: join(scratch, `${sample}-complete.png`) });
    await until(
      async () =>
        (await audit()).some(
          (item) =>
            item.boundary === "worktree.subscription" &&
            item.phase === "applied" &&
            item.projectId === held.projectId,
        ),
      "Released provider synchronization finishes before next scenario",
    );
    checks.push(
      `${sample} creates one thread in its distinct execution Core and completes the first prompt once with the selected model and ready Worktree journal`,
    );
  }
}
async function send(mode, kind, history) {
  const sample = `${mode}-${kind}`;
  const text = `Exact subscription send ${sample}.`;
  const reply = `SUBSCRIPTION_SEND_COMPLETE_${sample.toUpperCase()}`;
  const entry = { text, reply, history: [...history, text] };
  expected.set(text, entry);
  const before = await audit();
  const catalogStarts = before.filter(
    (item) => item.boundary === "catalog.fetch" && item.phase === "start",
  ).length;
  await writeFile(
    controlPath,
    JSON.stringify({ sample, mode, background: mode === "held" && kind === "new" }),
  );
  await page.getByTestId("chat-input").fill(text);
  await until(
    () => page.getByTestId("chat-send-button").isEnabled(),
    "Send is enabled for the selected subscription model",
    8000,
  );
  await page.getByTestId("chat-send-button").click();
  try {
    await until(
      async () => {
        const current = projectOf(await snapshot()),
          admitted = turnFor(current, text);
        const visible = await page.locator(".user-message-body").allTextContents();
        return requests.some((item) => item.text === text) &&
          (await page.getByTestId("chat-input").innerText()).trim() === "" &&
          visible.includes(text) &&
          admitted?.turn.status === "inProgress"
          ? admitted
          : false;
      },
      `${sample} is admitted with an empty Composer and exact visible user text before catalog or inference reply release`,
      8000,
    );
  } finally {
    const current = await snapshot();
    const observation = {
      sample,
      editorText: await page.getByTestId("chat-input").innerText(),
      requests: requests.filter((item) => item.text === text),
      snapshot: current,
      audit: await audit(),
    };
    observations.push(observation);
    await writeFile(join(scratch, `${sample}-held.json`), JSON.stringify(observation, null, 2));
  }
  const current = projectOf(await snapshot()),
    { thread, turn } = turnFor(current, text);
  assert.equal(
    turn.items.some((item) => item.type === "agentMessage" && item.text?.trim()),
    false,
    "Admission does not depend on assistant output",
  );
  const configuration = current.configurations[thread.id];
  assert.deepEqual(
    configuration.model,
    { providerId: "areal_openai", modelId: "gpt-6.1-sol" },
    "Core admits the selected subscription model",
  );
  assert.equal(
    configuration.contextWindow.reportedWindowSource,
    "account",
    "Model provenance comes from the real account catalog",
  );
  assert.equal(
    configuration.contextWindow.reportedWindowTokens,
    200000,
    "Core preserves account catalog model metadata",
  );
  const after = await audit();
  const starts = after.filter(
    (item) => item.boundary === "catalog.fetch" && item.phase === "start",
  ).length;
  assert.equal(
    starts,
    catalogStarts + (mode === "held" && kind === "new" ? 1 : 0),
    "Sending does not start an extra catalog GET",
  );
  assert.ok(
    after.some(
      (item) =>
        item.boundary === "catalog.expire" &&
        item.sample === sample &&
        !item.metadata.fresh &&
        item.models.includes("gpt-6.1-sol"),
    ),
    "A populated real catalog is expired before this send",
  );
  if (mode === "held") {
    assert.ok(
      after.some((item) => item.boundary === "catalog.gate" && item.phase === "held"),
      "A real catalog GET is held during admission",
    );
    assert.ok(
      !after.some(
        (item) =>
          item.boundary === "catalog.fetch" &&
          item.phase === "finish" &&
          item.sample === "held-new",
      ),
      "The held catalog GET has not finished",
    );
  }
  assert.equal(
    requests.filter((item) => item.text === text).length,
    1,
    "Exactly one inference POST is admitted",
  );
  const response = heldResponses.get(text);
  assert.ok(
    response && !response.writableEnded,
    "Inference response remains held during all admission assertions",
  );
  respond(response, reply);
  heldResponses.delete(text);
  await until(async () => {
    const result = turnFor(projectOf(await snapshot()), text);
    return (
      result?.turn.status === "completed" &&
      result.thread.status?.type === "idle" &&
      result.turn.items?.some((item) => item.type === "agentMessage" && item.text === reply)
    );
  }, `${sample} completes and returns to authoritative idle`);
  assert.ok(
    (await page.locator("body").innerText()).includes(reply),
    "The exact inference reply becomes visible after release",
  );
  assert.equal(
    requests.filter((item) => item.text === text).length,
    1,
    "Completion does not replay inference",
  );
  checks.push(
    `${sample} admitted before reply and catalog completion, then completed idle with one subscription POST`,
  );
  return entry.history;
}
console.log("Subscription send evidence:", scratch);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await mkdir(env.AREAL_CORE_HOME, { recursive: true });
  await writeFile(
    join(env.AREAL_CORE_HOME, "openai-subscription.json"),
    JSON.stringify({ secret: "synthetic-fixture-only" }),
  );
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="responses"\nendpoint="http://127.0.0.1:${server.address().port}/v1/responses"\n`,
  );
  application = await applicationFixture(
    gui,
    join(scratch, "app"),
    bootstrap(`http://127.0.0.1:${server.address().port}/v1/responses`),
  );
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" });
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "Desktop ready");
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => projectOf(await snapshot())?.state?.connected, "Project connected");
  await until(
    async () =>
      projectOf(await snapshot())?.models?.some(
        (model) =>
          model.providerId === "areal_openai" &&
          model.modelId === "gpt-6.1-sol" &&
          model.availability === "available",
      ),
    "Startup publishes the real subscription catalog",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator(".settings-category-navigation")
    .getByRole("button", { name: "常规", exact: true })
    .click();
  const predictions = page.getByRole("switch", { name: "预测下一条提示词", exact: true });
  if ((await predictions.getAttribute("aria-checked")) === "true") await predictions.click();
  assert.equal(await predictions.getAttribute("aria-checked"), "false");
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await createProjectConversation(page, "workspace");
  if (startupMode) await startup();
  else if (worktreeMode) await worktree();
  else {
    await page.getByTestId("composer-model-trigger").click();
    await page.getByRole("tab", { name: "ChatGPT", exact: true }).click();
    await page.locator('[data-model-value="areal_openai/gpt-6.1-sol"]').getByRole("radio").click();
    await page.keyboard.press("Escape");
    await writeFile(catalogGate, "held");
    const heldHistory = await send("held", "new", []);
    await send("held", "existing", heldHistory);
    await rm(catalogGate);
    await until(
      async () =>
        (await audit()).some(
          (item) =>
            item.boundary === "catalog.fetch" &&
            item.phase === "finish" &&
            item.sample === "held-new",
        ),
      "Background catalog refresh finishes after release",
    );
    await createProjectConversation(page, "workspace");
    const rejectedHistory = await send("rejected", "new", []);
    const finalHistory = await send("rejected", "existing", rejectedHistory);
    assert.equal(
      requests.length,
      4,
      "All four expired-catalog UI sends reach subscription inference exactly once",
    );
    await writeFile(controlPath, JSON.stringify({ sample: "explicit-failure", mode: "rejected" }));
    const failedStatus = await page.evaluate(() =>
      window.arealDesktop.command("chatgpt", { operation: "status", provider: "openai" }),
    );
    assert.equal(
      failedStatus.ok,
      true,
      "Explicit status reports a catalog failure through its normal response",
    );
    const failedSnapshot = await until(async () => {
      const value = (await snapshot()).subscription;
      return value?.modelError && !value.refreshing ? value : false;
    }, "Background catalog rejection reaches the pushed subscription snapshot");
    assert.ok(
      failedSnapshot.models.some((model) => model.id === "gpt-6.1-sol"),
      "A failed refresh retains the last public catalog",
    );
    await writeFile(controlPath, JSON.stringify({ sample: "explicit-recovery", mode: "ready" }));
    const recoveredStatus = await page.evaluate(() =>
      window.arealDesktop.command("chatgpt", { operation: "status", provider: "openai" }),
    );
    assert.equal(
      recoveredStatus.ok,
      true,
      "The existing explicit status action remains usable after catalog failure",
    );
    const recoveredSnapshot = await until(async () => {
      const value = (await snapshot()).subscription;
      return value?.availability === "available" && !value.refreshing && !value.modelError
        ? value
        : false;
    }, "Explicit refresh restores pushed account readiness");
    assert.equal(
      recoveredSnapshot.catalog.source,
      "account",
      "Explicit recovery retains account catalog provenance",
    );
    assert.equal(
      recoveredSnapshot.catalog.fresh,
      true,
      "Explicit recovery refreshes the real catalog",
    );
    await until(
      async () =>
        projectOf(await snapshot())?.models?.some(
          (model) =>
            model.providerId === "areal_openai" &&
            model.modelId === "gpt-6.1-sol" &&
            model.availability === "available",
        ),
      "Explicit refresh republishes the subscription model",
    );
    await writeFile(
      join(scratch, "explicit-recovery.json"),
      JSON.stringify({ failedStatus, recoveredStatus, audit: await audit() }, null, 2),
    );
    checks.push(
      "Explicit catalog failure retains public models and the existing status refresh recovers account readiness and model publication",
    );
    await send("ready", "existing", finalHistory);
    assert.equal(
      requests.length,
      5,
      "Recovery also admits exactly one subscription inference request",
    );
  }
  assert.deepEqual(errors, [], "No renderer or model fixture errors");
  await writeFile(join(scratch, "final-snapshot.json"), JSON.stringify(await snapshot(), null, 2));
  await page.screenshot({ path: join(scratch, "final.png") });
  passed = true;
} catch (error) {
  failure = error.stack;
  if (page)
    await writeFile(join(scratch, "failure-snapshot.json"), JSON.stringify(await snapshot())).catch(
      () => {},
    );
  console.error(failure);
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  await rm(controlPath, { force: true });
  await rm(catalogGate, { force: true });
  await rm(worktreeGate, { force: true });
  for (const response of heldResponses.values()) response.destroy();
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async (...args) => ({
          response: ["确认取消后台任务？", "退出 AReaL Harness？"].includes(args.at(-1).message)
            ? 1
            : (args.at(-1).cancelId ?? 0),
        });
      })
      .catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
  }
  await application?.close();
  try {
    await assertApplicationStopped(binary, env, metadata);
    cleanup = "passed";
  } catch (error) {
    cleanup = error.stack;
    passed = false;
  }
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if ((await hash(binary)) !== identity.coreHash) {
    errors.push("Core binary changed during run");
    passed = false;
  }
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        identity,
        checks,
        requests,
        observations: observations.map((item) => item.sample),
        failure,
        cleanup,
        errors,
        mode: startupMode ? "startup" : worktreeMode ? "worktree" : "send",
        boundary: worktreeMode
          ? "Source Electron and isolated real Core services. Committed Git fixture, real Worktree creation, UI model selection and first prompt. Execution-owner AppProviders.applySubscription is held before real provider upsert. Real Core RPC dispatch, response and error records include logical and execution owner identities. Ordinary provider first prompt completes while subscription synchronization is held. Subscription first prompt waits for provider application and completes exactly once after release. Synthetic external grant, catalog and inference only. No environment scripts."
          : startupMode
            ? "Source Electron and two fresh owned restarts with saved project, real Core history and persisted Composer drafts. Normal-provider selection remains sendable during held subscription discovery. Persisted subscription selection remains sendable with an editable draft during catalog refresh. The first submission waits for provider initialization and then sends once without restart. Real AppProviders, CoreSubscription, OpenAIAccount and ModelCatalog. Synthetic in-memory grant and custom external catalog fetch held by independent file-gate samples. Native folder picker and application quit confirmation stubbed. Inference uses real normal-provider Core HTTP and subscription custom fetch transports."
            : "Source Electron, real isolated Core, AppProviders, CoreSubscription, OpenAIAccount and ModelCatalog. Synthetic in-memory grant and custom external fetch. Native folder picker and application quit confirmation stubbed. Catalog expiry is injected at the send command boundary. Held case starts a real background catalog discovery. Rejected case arms a rejecting external GET that sending must not consult. Inference replies stay held until UI and authoritative Core admission assertions pass.",
        limits:
          "No real account, OAuth exchange, external network or packaged application acceptance. This is a dependency regression test, not a latency benchmark. Isolated state and evidence are retained; owned services must stop.",
      },
      null,
      2,
    ),
  );
  console.log(`${passed ? "PASS" : "FAIL"} subscription send`, scratch);
  if (!passed) process.exitCode = 1;
}
