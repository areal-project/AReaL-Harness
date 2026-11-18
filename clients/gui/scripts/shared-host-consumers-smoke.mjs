import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../examples/desktop-api/client.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";
import { stopAndAssertFixtureHost } from "./application-cleanup.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { GuiSourceSession } = require("@areal/client/gui-source");
const { HostClient } = require("@areal/client/node");
const {
  createNativeShellTransport,
} = require("../app/src/core/generated/native-host-transport.cjs");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = process.env.AREAL_TEST_BIN_DIR
  ? join(process.env.AREAL_TEST_BIN_DIR, "areal")
  : (process.env.AREAL_CORE_BIN ?? join(repository, ".local/shared-host-bin/areal"));
const root = await realpath(await mkdtemp("/tmp/ah-consumers-"));
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
const home = join(root, "host");
const user = join(root, "user");
const workspace = join(root, "cli-workspace");
const guiWorkspace = join(root, "gui-workspace");
const cliProject = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", root: workspace };
const cliData = join(source.coreHome, cliProject.id, "state");
const cliScratch = join(root, "cli-scratch");
for (const path of [home, user, workspace, guiWorkspace, cliScratch, ...Object.values(source)])
  await mkdir(path, { mode: 0o700 });
await writeFile(join(source.coreHome, "projects.json"), JSON.stringify([cliProject]), {
  mode: 0o600,
});
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
const credential = "synthetic-fixture-key";
const authorization = [];
let modelFailure;
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const bytes of request) body += bytes;
    if (respondToSessionName(JSON.parse(body), response)) return;
    authorization.push(request.headers.authorization === `Bearer ${credential}`);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"choices":[{"index":0,"delta":{"content":"fixture result"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
const cli = new HostClient();
const owner = new GuiSourceSession({ binary, home, source, singletonHeld: true });
let hostPid, shell, core, failure;

try {
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const config = join(user, "config.toml");
  const endpoint = `http://127.0.0.1:${model.address().port}/v1/chat/completions`;
  await writeFile(
    config,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\napi_key_env="FIXTURE_API_KEY"\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\nmodels=[{id="fixture",enabled=true}]\n`,
    { mode: 0o600 },
  );
  const cliConfig = join(user, "cli.toml");
  await writeFile(cliConfig, 'schema_version=1\n[model]\nname="cli-fixture"\n', { mode: 0o600 });
  await cli.connectOrStart(home, binary);
  hostPid = cli.identity.pid;
  await cli.registerProject(randomUUID(), {
    projectId: "original-cli-project",
    workspace,
    dataDir: cliData,
    source: { kind: "cli" },
    defaultBinding: true,
  });
  const cliStarted = await cli.ensureProject(randomUUID(), "original-cli-project", {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    configPath: cliConfig,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace,
      data_dir: cliData,
      scratch: cliScratch,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  });
  await owner.init({ deferCredentials: true });
  const launch = await owner.prepareNative(
    {
      binary,
      home: source.coreHome,
      guiProfile: source.profile,
      hostHome: home,
      harnessHome: source.legacyServiceHome,
      config,
      configHome: user,
      userHome: user,
    },
    { FIXTURE_API_KEY: credential },
  );
  assert.deepEqual(launch.environmentCredentials, { FIXTURE_API_KEY: credential });
  assert.equal(JSON.stringify(launch.options).includes(credential), false);
  owner.client.desktopCoreEvent = () => {};
  const { attachmentId } = await owner.client.request("desktop.core.subscribe", {
    sourceId: owner.sourceId,
    options: launch.options,
    environmentCredentials: launch.environmentCredentials,
  });
  const { projectId: alias } = await owner.client.request("desktop.core.call", {
    attachmentId,
    call: "worktree.project.add",
    params: { root: guiWorkspace },
  });
  let snapshot;
  shell = await createNativeShellTransport({
    home,
    profile: source.profile,
    hostId: cli.hostId,
    generation: cli.generation,
    onShell: (value) => {
      snapshot = value;
    },
    onClosed() {},
  });
  const foreign = snapshot.projects.find((project) => project.workspace === workspace);
  assert.equal(foreign?.projectId, "original-cli-project");
  assert.equal(foreign.alias?.projectId, cliProject.id);
  assert.equal(foreign.serviceGeneration, cliStarted.service.generation);
  const gui = snapshot.projects.find(
    (project) => project.workspace === guiWorkspace && project.alias?.projectId === alias,
  );
  assert.ok(gui);
  const guiStarted = await owner.client.ensureProject(randomUUID(), gui.projectId);
  assert.equal(guiStarted.project.state, "ready");
  const launchPath = (id) =>
    join(home, "host", "launch", createHash("sha256").update(id).digest("hex"), "inputs.json");
  const guiInputs = await readFile(launchPath(gui.projectId), "utf8");
  assert.deepEqual(new Set(JSON.parse(guiInputs).credentialNames), new Set(["FIXTURE_API_KEY"]));
  assert.equal(guiInputs.includes(credential), false);
  const foreignAfter = (await cli.status()).projects.find(
    ({ registration }) => registration.projectId === foreign.projectId,
  );
  assert.equal(foreignAfter.registration.source.kind, "cli");
  assert.equal(foreignAfter.registration.dataDir, cliData);
  assert.equal(foreignAfter.service.generation, cliStarted.service.generation);
  assert.equal(
    JSON.parse(await readFile(launchPath(foreign.projectId), "utf8")).configPath,
    cliConfig,
  );

  core = await connect(guiStarted.service.endpoint, guiStarted.service.authFile);
  const { thread } = await core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: guiWorkspace,
  });
  const { turn } = await core.call("areal/turn/start", {
    requestId: randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "Verify the synthetic credential." }],
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (modelFailure) throw modelFailure;
    const { thread: current } = await core.call("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const original = current.turns.find(({ id }) => id === turn.id);
    if (original?.status === "completed") break;
    assert.ok(Date.now() < deadline, "original GUI Turn completes");
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.deepEqual(authorization, [true]);
} catch (error) {
  failure = error;
} finally {
  core?.socket.close();
  shell?.close();
  owner.close();
  cli.close();
  try {
    if (hostPid) await stopAndAssertFixtureHost(binary, process.env, root);
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "Consumer journey and cleanup failed")
      : error;
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
}
if (failure) throw failure;
const result = {
  root,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [
    "named-credential-authenticates-original-turn-with-secret-outside-launch",
    "equivalent-cli-binding-keeps-configuration-owner",
    "foreign-core-generation-preserved",
  ],
};
await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
