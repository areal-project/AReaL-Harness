import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../examples/desktop-api/client.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";
import { assertApplicationStopped, stopAndAssertFixtureHost } from "./application-cleanup.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { GuiSourceSession } = require("@areal/client/gui-source");
const { HostClient } = require("@areal/client/node");
const {
  createNativeShellTransport,
} = require("../app/src/core/generated/native-host-transport.cjs");
const { readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary =
  process.env.AREAL_CORE_BIN ??
  join(process.env.AREAL_TEST_BIN_DIR || join(repository, ".local/shared-host-bin"), "areal");
const root = await realpath(await mkdtemp("/tmp/ah-gui-lifecycle-"));
const home = join(root, "host");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
const user = join(root, "user");
const workspace = join(root, "workspace");
for (const path of [home, user, workspace, ...Object.values(source)])
  await mkdir(path, { mode: 0o700 });
await writeFile(join(source.coreHome, "projects.json"), "[]", { mode: 0o600 });
for (const key of Object.keys(process.env)) {
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE")
    delete process.env[key];
}
Object.assign(process.env, {
  AREAL_HARNESS_HOME: user,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_HOME: source.coreHome,
  AREAL_CORE_USER_HOME: user,
  AREAL_GUI_USER_DATA: source.profile,
});
const owner = new GuiSourceSession({ binary, home, source, singletonHeld: true });
const checks = [];
const clients = [owner.client];
let core, shell, originalStop, hostPid, failure;
let releaseModel;
let modelFailure;
const modelRequested = Promise.withResolvers();
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const bytes of request) body += bytes;
    const input = JSON.parse(body);
    if (respondToSessionName(input, response)) return;
    assert.equal(releaseModel, undefined, "only one active model request");
    releaseModel = () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    modelRequested.resolve();
  } catch (error) {
    modelFailure = error;
    modelRequested.reject(error);
    response.destroy(error);
  }
});
async function until(check, message) {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (modelFailure) throw modelFailure;
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 30));
  }
}
try {
  await owner.init({ deferCredentials: true });
  assert.ok(owner.sourceId);
  hostPid = owner.client.identity.pid;
  assert.deepEqual(await owner.client.activity(), {
    complete: true,
    projects: [],
    totalActiveTasks: 0,
  });
  checks.push("ordinary-owner-source-init-empty-secret-manifest");
  const launchOptions = await owner.prepareNative(
    {
      binary,
      home: source.coreHome,
      guiProfile: source.profile,
      hostHome: home,
      harnessHome: source.legacyServiceHome,
      userHome: user,
      configHome: user,
    },
    process.env,
  );
  owner.client.desktopCoreEvent = () => {};
  const { attachmentId } = await owner.client.request("desktop.core.subscribe", {
    sourceId: owner.sourceId,
    options: launchOptions.options,
    environmentCredentials: launchOptions.environmentCredentials,
  });
  const identifiers = { projectlessRequestId: randomUUID(), worktreeResources: randomUUID() };
  const { projectId: alias } = await owner.client.request("desktop.core.call", {
    attachmentId,
    call: "worktree.project.add",
    params: { root: workspace, ...identifiers },
  });
  assert.equal(alias, createHash("sha256").update(workspace).digest("hex").slice(0, 24));
  const [project] = JSON.parse(await readFile(join(source.coreHome, "projects.json"), "utf8"));
  assert.deepEqual(project, { id: alias, root: workspace, projectless: true, ...identifiers });
  const binding = (await owner.client.status()).projects.find(
    ({ registration }) => registration.workspace === workspace,
  ).registration;
  assert.equal(binding.dataDir, join(source.coreHome, alias, "state"));
  const dormant = await owner.client.activity();
  assert.equal(dormant.complete, true);
  assert.equal(
    dormant.projects.find((item) => item.projectId === binding.projectId).idleAllowed,
    true,
  );
  await assert.rejects(readFile(join(binding.dataDir, "service.lock")), { code: "ENOENT" });
  checks.push("activity-does-not-start-or-create-core-locks-for-registration");
  const emptyJournal = { version: 1, pending: [], outcomes: {} };
  assert.deepEqual((await owner.client.journal(binding.projectId).read()).snapshot, emptyJournal);
  const started = await owner.client.ensureProject(randomUUID(), binding.projectId);
  assert.equal(started.service.owner.kind, "host");
  assert.equal(started.service.owner.hostId, owner.client.hostId);
  owner.close();
  const observer = new HostClient();
  clients.push(observer);
  await observer.connect(home);
  const status = async (id) =>
    (await observer.status()).projects.find(({ registration }) => registration.projectId === id);
  const observed = await status(binding.projectId);
  assert.equal(observed.service.generation, started.service.generation);
  checks.push("gui-client-disconnect-keeps-host-core-generation");
  const requestId = randomUUID();
  const receipt = await observer.request("project.stop", {
    requestId,
    expectedGeneration: observer.generation,
    projectId: binding.projectId,
    serviceGeneration: observed.service.generation,
    strategy: "ifIdle",
  });
  assert.equal(receipt.state, "completed");
  assert.deepEqual((await observer.operation(requestId)).operation, receipt);
  assert.equal((await status(binding.projectId)).state, "stopped");
  const stoppedActivity = await observer.activity();
  assert.equal(stoppedActivity.complete, true);
  assert.equal(stoppedActivity.totalActiveTasks, 0);
  assert.equal(
    stoppedActivity.projects.find((item) => item.projectId === binding.projectId).idleAllowed,
    true,
  );
  checks.push("original-stop-receipt-and-passive-observation-no-restart");
  const cliWorkspace = join(root, "cli-workspace");
  await mkdir(cliWorkspace);
  await observer.registerProject(randomUUID(), {
    projectId: "cli-test-project",
    workspace: cliWorkspace,
    dataDir: join(root, "cli-data"),
    source: { kind: "cli" },
    defaultBinding: true,
  });
  let snapshot;
  shell = await createNativeShellTransport({
    home,
    profile: source.profile,
    hostId: observer.hostId,
    generation: observer.generation,
    onShell: (value) => {
      snapshot = value;
    },
    onClosed() {},
  });
  const cli = snapshot.projects.find((item) => item.workspace === cliWorkspace);
  assert.equal(cli?.projectId, "cli-test-project");
  assert.equal((await status(cli.projectId)).registration.dataDir, join(root, "cli-data"));
  assert.deepEqual((await observer.journal(cli.projectId).read()).snapshot, emptyJournal);
  checks.push("cli-registration-visible-through-host-shell-with-original-store");
  const reopened = await observer.ensureProject(randomUUID(), binding.projectId);
  assert.notEqual(reopened.service.generation, observed.service.generation);
  checks.push("explicit-open-creates-successor-after-completed-stop");
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const config = join(user, "activity-config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  const independent = new HostClient();
  clients.push(independent);
  await independent.connect(home);
  await mkdir(join(root, "cli-scratch"), { mode: 0o700 });
  const cliStarted = await independent.ensureProject(randomUUID(), "cli-test-project", {
    workspace: cliWorkspace,
    cwd: cliWorkspace,
    configHome: user,
    homedir: user,
    configPath: config,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace: cliWorkspace,
      data_dir: join(root, "cli-data"),
      scratch: join(root, "cli-scratch"),
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  });
  core = await connect(cliStarted.service.endpoint, cliStarted.service.authFile);
  const thread = await core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: cliWorkspace,
  });
  await core.call("areal/turn/start", {
    requestId: randomUUID(),
    threadId: thread.thread.id,
    input: [{ type: "text", text: "hold activity query" }],
  });
  await Promise.race([
    modelRequested.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("model request timeout")), 20000);
      modelRequested.promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
  independent.close();
  const busy = await observer.activity();
  assert.equal(busy.complete, true);
  assert.equal(busy.totalActiveTasks, 0);
  assert.deepEqual(
    busy.projects.find((item) => item.projectId === "cli-test-project"),
    {
      projectId: "cli-test-project",
      state: "observed",
      activeTasks: 0,
      activeTurns: 1,
      activeGoals: 0,
      pendingQueueItems: 0,
      idleAllowed: false,
    },
  );
  assert.equal(
    busy.projects.find((item) => item.projectId === binding.projectId).idleAllowed,
    true,
  );
  assert.equal((await core.call("areal/server/status")).acceptingWork, true);
  checks.push("activity-includes-independent-client-turn-without-counting-it-as-task");
  releaseModel();
  await until(async () => {
    const activity = await observer.activity();
    return activity.complete && activity.projects.every((item) => item.idleAllowed);
  }, "activity returns idle after original turn settles");
  const history = await core.call("thread/read", {
    threadId: thread.thread.id,
    includeTurns: true,
  });
  assert.equal(history.thread.turns.length, 1);
  assert.equal(history.thread.turns[0].status, "completed");
  checks.push("activity-observation-preserves-original-turn-and-settles-without-restart");
  core.socket.close();
  shell.close();
  originalStop = {
    kind: "stopHost",
    requestId: randomUUID(),
    home,
    hostId: observer.hostId,
    generation: observer.generation,
    strategy: "ifIdle",
  };
  const stopped = await observer.stop(originalStop.requestId, originalStop.generation, "ifIdle");
  assert.equal(stopped.state, "completed");
  assert.deepEqual(await readOfflineHostReceipt(binary, originalStop), stopped);
  await assertApplicationStopped(binary, process.env, { hostPid });
  await writeFile(join(root, "host-stop.json"), JSON.stringify(stopped, null, 2));
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        root,
        binary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        checks,
        excluded: [
          "Electron singleton",
          "Electron renderer and quit interaction",
          "legacy writer handoff",
          "Keychain",
          "provider",
          "package",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, checks }));
} catch (error) {
  failure = error;
} finally {
  core?.socket.close();
  shell?.close();
  for (const client of clients) client.close();
  try {
    if (originalStop) {
      assert.equal((await readOfflineHostReceipt(binary, originalStop))?.state, "completed");
      await assertApplicationStopped(binary, process.env, { hostPid });
    } else if (hostPid) {
      await stopAndAssertFixtureHost(binary, process.env, root);
    }
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "Lifecycle journey and cleanup failed")
      : error;
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
}
if (failure) throw failure;
