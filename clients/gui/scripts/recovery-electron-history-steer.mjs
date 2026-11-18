import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/temp.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gui = join(repo, "clients/gui");
const require = createRequire(gui + "/app/package.json");
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const { stopFixtureHost } = await import(gui + "/scripts/application-cleanup.mjs");
const { selectCreatedConversation } = await import(gui + "/scripts/smoke-navigation.mjs");
const { connect } = await import(repo + "/examples/desktop-api/client.mjs");
const { respondToSessionName } = await import(repo + "/scripts/model-fixture.mjs");
const root = await makeTempDir("ah-hist-gui-");
const workspace = join(root, "workspace"),
  user = join(root, "user"),
  electronData = join(root, "electron"),
  coreHome = join(root, "core"),
  config = join(root, "config"),
  registry = join(root, "registry");
for (const d of [workspace, user, electronData, coreHome, config, registry])
  await mkdir(d, { mode: 0o700 });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const pkg = process.env.AREAL_TEST_PACKAGE;
assert(pkg, "Set AREAL_TEST_PACKAGE to an isolated signed .app path");
const binary = join(pkg, "Contents/Resources/areal-core/bin/areal"),
  exe = join(pkg, "Contents/MacOS/AReaL Harness GUI");
const requests = [],
  held = [];
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, res)) return;
  const text = JSON.stringify(
    (body.messages ?? []).findLast(
      (x) =>
        x.role === "user" &&
        /OLD_GUI_FIRST|OLD_GUI_QUEUE|NEW_GUI_HISTORY_SEND/.test(JSON.stringify(x.content)) &&
        !JSON.stringify(x.content).includes("AReaL runtime context"),
    )?.content ?? null,
  );
  requests.push({ text, tools: (body.tools ?? []).map((x) => x.function?.name) });
  const complete = () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "HISTORY_GUI_DONE" }, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  };
  if (text.includes("OLD_GUI_FIRST") || text.includes("OLD_GUI_QUEUE"))
    held.push({ text, complete });
  else complete();
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
await writeFile(
  join(config, "config.toml"),
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
await writeFile(
  join(config, "desktop.json"),
  JSON.stringify({
    profiles: [{ id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Respond." }],
  }),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith("AREAL_") && k !== "ELECTRON_RUN_AS_NODE",
  ),
);
Object.assign(env, {
  AREAL_GUI_USER_DATA: electronData,
  AREAL_CORE_HOME: coreHome,
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: config,
  AREAL_HARNESS_SERVICE_HOME: registry,
  AREAL_CORE_CONFIG: join(config, "config.toml"),
  AREAL_CORE_DESKTOP_CONFIG: join(config, "desktop.json"),
  NO_PROXY: "127.0.0.1,localhost",
});
const wait = async (f, label) => {
  let end = Date.now() + 60000,
    last;
  while (Date.now() < end) {
    last = await f();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("timeout " + label + " " + JSON.stringify(last));
};
let app,
  page,
  host,
  core,
  stage = "launch",
  record = {
    root,
    pkg,
    binary,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    stages: [],
    requests,
    scope: "packaged Electron, real Host/Core, synthetic model and injected UNKNOWN steer",
    excluded: ["real provider", "physical input", "real user data"],
  };
const mark = (name, data) => {
  stage = name;
  record.stages.push({ name, data });
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
try {
  app = await electron.launch({ executablePath: exe, args: [], env, timeout: 120000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await wait(async () => (await state()).connection?.state === "ready", "gui ready");
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, workspace);
  await page.locator(".composer-project").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  const project = await wait(
    async () => (await state()).projects.find((x) => x.root === workspace && x.state?.connected),
    "project",
  );
  mark("project", { id: project.id, core: project.core });
  await writeFile(join(root, "project.json"), JSON.stringify(project, null, 2));
  const reply = await page.evaluate(async (p) => window.arealDesktop.command("create", p), {
    projectId: project.id,
    browserEnabled: true,
    profile: { id: "fixture", revision: "v1" },
  });
  assert(reply.ok, JSON.stringify(reply));
  const threadId = reply.value.threadId;
  await selectCreatedConversation(page, project.id, threadId);
  mark("created", { threadId });
  await page.getByTestId("chat-input").fill("OLD_GUI_FIRST");
  await page.getByTestId("chat-send-button").click();
  await wait(() => held.find((x) => x.text.includes("OLD_GUI_FIRST")), "first model");
  const snapshot = await state();
  const pr = snapshot.projects.find((x) => x.id === project.id);
  mark("started", { threadId, serviceGeneration: pr.core.serviceGeneration });
  assert(
    requests.some((x) => x.tools.includes("browser_v1")),
    "browser tool must be available",
  );
  const list = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
  );
  const desc = list.find((x) => x.workspace === workspace && x.state === "ready");
  assert(desc, JSON.stringify(list));
  core = await connect(desc.endpoint, desc.authFile);
  const thread = (await core.call("thread/read", { threadId, includeTurns: true })).thread;
  const first = thread.turns.at(-1);
  const queued = await core.call("areal/turn/enqueue", {
    requestId: randomUUID(),
    threadId,
    input: [{ type: "text", text: "OLD_GUI_QUEUE" }],
  });
  const q = await core.call("areal/queue/list", { threadId });
  assert(q.items.some((x) => x.id === queued.queueItemId && x.status === "pending"));
  held.find((x) => x.text.includes("OLD_GUI_FIRST")).complete();
  await wait(() => held.find((x) => x.text.includes("OLD_GUI_QUEUE")), "queued model");
  held.find((x) => x.text.includes("OLD_GUI_QUEUE")).complete();
  await wait(async () => {
    const x = (await core.call("thread/read", { threadId, includeTurns: true })).thread;
    const queue = await core.call("areal/queue/list", { threadId });
    return (
      x.turns.length >= 2 &&
      x.turns.every((t) => t.status === "completed") &&
      queue.items.some((item) => item.id === queued.queueItemId && item.status === "completed")
    );
  }, "completed");
  mark("completed", { first: first.id, queue: queued.queueItemId, desc });
  host = new HostClient();
  await host.connect(registry);
  const status = await host.request("host.status", {});
  const hostProject = status.projects.find((x) => x.registration.workspace === workspace)
    .registration.projectId;
  const old = {
    rustOwner: true,
    method: "areal/queue/steer",
    params: {
      requestId: randomUUID(),
      threadId,
      queueItemId: queued.queueItemId,
      expectedTurnId: first.id,
      expectedRevision: 1,
    },
  };
  await host.journal(hostProject).change((x) => ({ ...x, pending: [...x.pending, old] }));
  assert.deepEqual(
    (await host.journal(hostProject).read()).snapshot.pending.find(
      (x) => x.params.requestId === old.params.requestId,
    ),
    old,
  );
  mark("unknown-injected", { old, hostProject });
  await page.getByRole("button", { name: "新聊天", exact: true }).click();
  assert.notEqual(
    await page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
    threadId,
  );
  assert.equal(await page.getByText("OLD_GUI_FIRST", { exact: true }).count(), 0);
  mark("navigated-away", {});
  core.close();
  core = null;
  const stopId = randomUUID();
  const stopped = await host.request("project.stop", {
    requestId: stopId,
    expectedGeneration: host.generation,
    projectId: hostProject,
    serviceGeneration: desc.generation,
    strategy: "ifIdle",
  });
  mark("stop-receipt", stopped);
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  const stoppedStatus = (await host.request("host.status", {})).projects.find(
    (entry) => entry.registration.projectId === hostProject,
  );
  mark("before-history-open", {
    state: stoppedStatus?.state,
    generation: stoppedStatus?.service?.generation,
  });
  await page.getByTestId(`task-item-${threadId}`).click();
  mark("opened-during-switch", {});
  const retry = page.getByRole("button", { name: "重试加载对话", exact: true });
  await page.getByText("OLD_GUI_FIRST", { exact: true }).waitFor({ timeout: 15000 });
  await page.getByText("OLD_GUI_QUEUE", { exact: true }).waitFor({ timeout: 15000 });
  record.stoppedHistoryVisible = true;
  mark("stopped-history-visible", {});
  const serviceState = await wait(async () => {
    const current = (await host.request("host.status", {})).projects.find(
      (entry) => entry.registration.projectId === hostProject,
    );
    return current && ["ready", "stopped"].includes(current.state) && current;
  }, "Core stopped or successor ready");
  mark("before-resume", {
    state: serviceState.state,
    generation: serviceState.service?.generation,
  });
  if (serviceState.state === "stopped") {
    const reconnect = await page.evaluate(
      async (id) =>
        window.arealDesktop.command("connect", { projectId: id, resumeScheduling: true }),
      project.id,
    );
    mark("fixture-connect", { ok: reconnect.ok, error: reconnect.error });
    assert(reconnect.ok, JSON.stringify(reconnect.error));
  }
  const refreshed = await wait(async () => {
    const x = (await state()).projects.find((x) => x.id === project.id);
    return x?.state?.connected && x.core?.serviceGeneration !== desc.generation && x;
  }, "new Core generation");
  mark("new-generation", { old: desc.generation, new: refreshed.core.serviceGeneration });
  if (await retry.isVisible()) await retry.click();
  await page.getByText("HISTORY_GUI_DONE", { exact: true }).first().waitFor();
  await page.getByText("OLD_GUI_FIRST", { exact: true }).waitFor();
  await page.getByText("OLD_GUI_QUEUE", { exact: true }).waitFor();
  mark("history-visible", {});
  await page.getByTestId("chat-input").fill("NEW_GUI_HISTORY_SEND");
  await page.getByTestId("chat-send-button").click();
  mark("clicked-send", {});
  await page.screenshot({ path: join(root, "after-send.png") });
  await wait(async () => {
    const x = (await state()).projects.find((x) => x.id === project.id)?.state?.threads?.[threadId];
    return x?.turns?.length >= 3 && x.turns.at(-1).status === "completed" && x;
  }, "new GUI send completed");
  const newList = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
  );
  const newDesc = newList.find(
    (x) => x.workspace === workspace && x.generation === refreshed.core.serviceGeneration,
  );
  assert(newDesc, "new Core descriptor must match the projected generation");
  core = await connect(newDesc.endpoint, newDesc.authFile);
  const authoritative = (await core.call("thread/read", { threadId, includeTurns: true })).thread;
  assert.equal(authoritative.turns.length, 3);
  assert.equal(authoritative.turns.at(-1).status, "completed");
  assert.equal(requests.filter((x) => x.text.includes("NEW_GUI_HISTORY_SEND")).length, 1);
  const pending = (await host.journal(hostProject).read()).snapshot.pending;
  assert.deepEqual(
    pending.find((x) => x.params.requestId === old.params.requestId),
    old,
  );
  await page.getByText("NEW_GUI_HISTORY_SEND", { exact: true }).waitFor();
  assert.equal(await page.getByText("HISTORY_GUI_DONE", { exact: true }).count(), 3);
  mark("send-completed", {
    turnId: authoritative.turns.at(-1).id,
    requestCount: 1,
    oldPending: old,
  });
  record.passed = true;
  console.log("STAGE_READY", root);
} catch (e) {
  process.exitCode = 1;
  record.error = { stage, message: e.message, stack: e.stack };
  console.error("STAGE_FAILURE", root, stage, e.stack);
  if (page) await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
} finally {
  core?.close();
  host?.close();
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await wait(
      () => app.process().exitCode !== null || app.process().signalCode !== null,
      "GUI exit",
    ).catch((error) => {
      process.exitCode = 1;
      record.guiCleanupError = error.message;
    });
  }
  await stopFixtureHost(binary, registry, root).catch((e) => {
    process.exitCode = 1;
    record.cleanupError = e.message;
  });
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  await writeFile(join(root, "result.json"), JSON.stringify(record, null, 2));
}
