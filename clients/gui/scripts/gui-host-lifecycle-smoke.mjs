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

const require = createRequire(import.meta.url);
const { GuiHostProjects, requestIdFor } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { HostClient } = createRequire(new URL("../app/package.json", import.meta.url))(
  "@areal/client/node",
);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = join(
  process.env.AREAL_TEST_BIN_DIR || join(repository, ".local/shared-host-bin"),
  "areal",
);
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
const owner = new GuiHostProjects({ binary, home, source, singletonHeld: true });
const checks = [];
const clients = [owner.client];
let core;
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
  await owner.init();
  assert.ok(owner.sourceId);
  assert.deepEqual(await owner.client.activity(), {
    complete: true,
    projects: [],
    totalActiveTasks: 0,
  });
  checks.push("ordinary-owner-source-init-empty-secret-manifest");
  const id = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  const project = {
    id,
    root: workspace,
    worktreeResources: "fixture-resources",
    projectless: true,
    projectlessRequestId: randomUUID(),
  };
  await owner.register(requestIdFor(`${owner.sourceId}:register:${id}`), project);
  await writeFile(join(source.coreHome, "projects.json"), JSON.stringify([project]), {
    mode: 0o600,
  });
  assert.deepEqual((await owner.list())[0], project);
  const binding = owner.resolve(id);
  assert.equal(binding.dataDir, join(source.coreHome, id, "state"));
  const dormant = await owner.client.activity();
  assert.equal(dormant.complete, true);
  assert.equal(
    dormant.projects.find((item) => item.projectId === binding.projectId).idleAllowed,
    true,
  );
  await assert.rejects(readFile(join(binding.dataDir, "service.lock")), { code: "ENOENT" });
  checks.push("activity-does-not-start-or-create-core-locks-for-registration");
  assert.deepEqual((await owner.journal(id).read()).snapshot, {
    version: 1,
    pending: [],
    outcomes: {},
  });
  await mkdir(binding.scratchDir, { recursive: true, mode: 0o700 });
  const launch = {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace,
      data_dir: binding.dataDir,
      scratch: binding.scratchDir,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  };
  const started = await owner.ensure(randomUUID(), id, launch);
  assert.equal(started.descriptor.owner.kind, "host");
  assert.equal(started.descriptor.owner.hostId, owner.client.hostId);
  owner.close();
  const observer = new GuiHostProjects({ binary, home, source, singletonHeld: false });
  clients.push(observer.client);
  await observer.init();
  const observed = await observer.observe(id);
  assert.equal(observed.descriptor.generation, started.descriptor.generation);
  checks.push("gui-client-disconnect-keeps-host-core-generation");
  const requestId = randomUUID();
  const receipt = await observer.stop(requestId, id, observed.descriptor.generation, "ifIdle");
  assert.equal(receipt.state, "completed");
  assert.deepEqual(await observer.operation(requestId), receipt);
  await assert.rejects(observer.observe(id), (error) => error.code === "CORE_STOPPED");
  assert.equal((await observer.status(id)).state, "stopped");
  const stoppedActivity = await observer.client.activity();
  assert.equal(stoppedActivity.complete, true);
  assert.equal(stoppedActivity.totalActiveTasks, 0);
  assert.equal(
    stoppedActivity.projects.find((item) => item.projectId === binding.projectId).idleAllowed,
    true,
  );
  checks.push("original-stop-receipt-and-passive-observation-no-restart");
  const cliWorkspace = join(root, "cli-workspace");
  await mkdir(cliWorkspace);
  await observer.client.registerProject(randomUUID(), {
    projectId: "cli-test-project",
    workspace: cliWorkspace,
    dataDir: join(root, "cli-data"),
    source: { kind: "cli" },
    defaultBinding: true,
  });
  const listed = await observer.list();
  const cli = listed.find((item) => item.root === cliWorkspace);
  assert.match(cli.id, /^[a-f0-9]{24}$/);
  assert.equal(observer.resolve(cli.id).projectId, "cli-test-project");
  assert.equal(observer.resolve(cli.id).dataDir, join(root, "cli-data"));
  assert.deepEqual((await observer.journal(cli.id).read()).snapshot, {
    version: 1,
    pending: [],
    outcomes: {},
  });
  checks.push("cli-registration-stable-local-alias-and-original-store");
  const reopened = await observer.ensure(randomUUID(), id, launch);
  assert.notEqual(reopened.descriptor.generation, observed.descriptor.generation);
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
    ...launch,
    workspace: cliWorkspace,
    cwd: cliWorkspace,
    configPath: config,
    options: {
      ...launch.options,
      workspace: cliWorkspace,
      data_dir: join(root, "cli-data"),
      scratch: join(root, "cli-scratch"),
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
  const busy = await observer.client.activity();
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
    const activity = await observer.client.activity();
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
  const stopped = await observer.client.request("host.stop", {
    requestId: randomUUID(),
    expectedGeneration: observer.client.generation,
    strategy: "ifIdle",
  });
  assert.equal(stopped.state, "completed");
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
} finally {
  core?.socket.close();
  for (const client of clients) client.close();
  const cleanup = new HostClient();
  try {
    await cleanup.connect(home);
    const stopped = await cleanup.request("host.stop", {
      requestId: randomUUID(),
      expectedGeneration: cleanup.generation,
      strategy: "cancel",
    });
    assert.equal(stopped.state, "completed");
  } catch (error) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(error.code) &&
      !error.message.includes("connection closed")
    )
      console.error("cleanup", error.message);
  } finally {
    cleanup.close();
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
}
