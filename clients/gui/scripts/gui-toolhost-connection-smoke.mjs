import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "../../../examples/desktop-api/client.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";
import { stopAndAssertFixtureHost } from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { GuiSourceSession } = require("@areal/client/gui-source");
const {
  createNativeHostTransport,
} = require("../app/src/core/generated/native-host-transport.cjs");
const WebSocket = require("ws");
const { build } = createRequire(join(gui, "packages/browser-data/package.json"))("esbuild");
const binary =
  process.env.AREAL_CORE_BIN ??
  join(process.env.AREAL_TEST_BIN_DIR ?? resolve(gui, "../../.local/shared-host-bin"), "areal");
const root = await realpath(await mkdtemp("/tmp/atool-"));
const home = join(root, "registry");
const user = join(root, "user");
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const coreHome = join(root, "core");
const legacyServiceHome = join(root, "prior-registry");
for (const key of Object.keys(process.env)) {
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE")
    delete process.env[key];
}
Object.assign(process.env, {
  AREAL_HARNESS_HOME: user,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_HOME: coreHome,
  AREAL_CORE_USER_HOME: user,
  AREAL_GUI_USER_DATA: profile,
});
for (const path of [home, user, workspace, profile]) await mkdir(path, { mode: 0o700 });
const bundle = join(root, "host-websocket.mjs");
await build({
  entryPoints: [join(gui, "packages/client/src/websocket.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
});
const { connectWebSocket } = await import(pathToFileURL(bundle));
const source = new GuiSourceSession({
  home,
  binary,
  source: { profile, coreHome, legacyServiceHome },
  singletonHeld: true,
});
const checks = [];
const requests = [];
const mains = [];
const callbacks = [];
let release, modelError, observer, web, created, sent, failure;
const model = createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    const reply = (delta, reason) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    if (requests.length === 1) {
      release = () =>
        reply(
          {
            tool_calls: [
              {
                index: 0,
                id: "original-browser-call",
                type: "function",
                function: {
                  name: "browser_v1",
                  arguments: JSON.stringify({ operation: "describe", parameters: {} }),
                },
              },
            ],
          },
          "tool_calls",
        );
      return;
    }
    reply({ content: "Original turn settled after host disconnect." }, "stop");
  } catch (error) {
    modelError = error;
    response.destroy(error);
  }
});
async function until(check, label) {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (modelError) throw modelError;
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 40));
  }
}
try {
  console.log("GUI ToolHost evidence:", root);
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const config = join(user, "config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  await source.init({ deferCredentials: true });
  const launch = await source.prepareNative(
    {
      binary,
      home: coreHome,
      guiProfile: profile,
      hostHome: home,
      harnessHome: legacyServiceHome,
      config,
      configHome: user,
      userHome: user,
      sandboxProfile: "native",
    },
    process.env,
  );
  const attach = async () => {
    const main = await createNativeHostTransport({
      home,
      sourceId: source.sourceId,
      launch: launch.options,
      environmentCredentials: source.environmentCredentials,
      onCallback: async (event) => {
        callbacks.push({ lease: event.lease, threadId: event.params.threadId });
        throw new Error("Unexpected native browser callback");
      },
      onEvent() {},
      onClosed() {},
    });
    mains.push(main);
    return main;
  };
  const first = await attach();
  const { projectId } = await first.call("worktree.project.add", { root: workspace });
  const origin = "areal-ui://app";
  const ticket = await source.client.request("web.ticket", {
    origin,
    expectedGeneration: source.client.generation,
    profile,
  });
  web = await connectWebSocket(
    { origin, writes: true, bootstrap: async () => ticket },
    () => true,
    AbortSignal.timeout(120000),
    () => {},
    () => {},
    (url) => new WebSocket(url, { origin, followRedirects: false }),
  );
  const shell = await web.transport.request("shell.subscribe", {});
  const registered = shell.snapshot.projects.find(
    (entry) =>
      entry.workspace === workspace &&
      entry.alias?.sourceId === source.sourceId &&
      entry.alias.projectId === projectId,
  );
  assert.ok(registered, "Host shell must bind the source project to its canonical ID");
  const activate = () =>
    web.transport.write("project.activate", {}, { projectId: registered.projectId });
  const { serviceGeneration } = await activate();
  assert.ok(serviceGeneration);
  const context = { projectId: registered.projectId, serviceGeneration };
  const createId = randomUUID();
  created = await web.transport.write(
    "session.create",
    {
      requestId: createId,
      model: { providerId: "fixture", modelId: "fixture" },
      options: { permissionPreset: "ask" },
      worktree: { mode: "source" },
      browserEnabled: true,
    },
    context,
    createId,
  );
  assert.equal(created.admissionState, "accepted");
  const { threadId } = created;
  const originalScope = await first.call("browser.scope", { projectId, threadId });
  const originalService = JSON.parse(
    execFileSync(
      binary,
      ["service", "status", "--instance", originalScope.coreInstanceId, "--json"],
      { encoding: "utf8", timeout: 20000 },
    ),
  );
  assert.equal(originalService.generation, serviceGeneration);
  assert.equal(originalService.workspace, workspace);
  observer = await connect(originalService.endpoint, originalService.authFile);
  const read = async () => (await observer.call("areal/thread/observe", { threadId })).thread;
  const initial = await read();
  assert.ok(initial.dynamicTools.some((tool) => tool.name === "browser_v1"));

  const spectator = await connect(originalService.endpoint, originalService.authFile);
  try {
    await spectator.call("areal/thread/observe", { threadId });
  } finally {
    await spectator.close();
  }
  assert.deepEqual(await first.call("browser.scope", { projectId, threadId }), originalScope);
  checks.push("ordinary Core observation cannot revoke the original browser owner");

  sent = await web.transport.write(
    "session.send",
    {
      threadId,
      expectedConfigRevision: initial.desktop.configuration.revision,
      text: "Hold the original turn.",
    },
    context,
    randomUUID(),
  );
  assert.equal(sent.admissionState, "accepted");
  await until(() => release, "model request is held");
  const { turnId } = sent;
  assert.equal((await read()).turns.at(-1).id, turnId);
  first.close();
  const successor = await until(async () => {
    try {
      return await attach();
    } catch (error) {
      if (error.code === "COMMAND_CONFLICT") return null;
      throw error;
    }
  }, "Host observes original desktop attachment disconnect");
  const successorScope = await successor.call("browser.scope", { projectId, threadId });
  assert.notEqual(successorScope.lease, originalScope.lease);
  assert.equal(successorScope.coreGeneration, originalScope.coreGeneration);
  assert.equal((await read()).turns.at(-1).id, turnId);
  assert.equal((await read()).turns.at(-1).status, "inProgress");
  await assert.rejects(observer.call("thread/resume", { threadId }), { code: -32009 });
  checks.push("Main loss withdraws its lease and preserves the original active turn");

  release();
  release = undefined;
  let responded = false;
  const settled = await until(async () => {
    const thread = await read();
    if (thread.turns.at(-1)?.status === "completed") return thread;
    if (!responded) {
      const { data } = await observer.call("areal/interaction/list", { threadId });
      const approval = data.find((item) => item.kind === "approval" && item.status === "pending");
      if (approval) {
        assert.equal(approval.turnId, turnId);
        responded = true;
        await observer.call("areal/interaction/respond", {
          threadId,
          turnId,
          requestId: approval.requestId,
          decision: "allowOnce",
          argumentsDigest: approval.argumentsDigest,
        });
      }
    }
    return null;
  }, "original turn completes without browser callback replay");
  assert.equal(settled.turns.at(-1).id, turnId);
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find((message) => message.role === "tool");
  assert.ok(toolResult, "Core reports a tool result to the model");
  assert.match(JSON.stringify(toolResult), /unavailable|disconnect|closed/i);
  assert.deepEqual(callbacks, []);
  checks.push("successor does not take the active turn or replay its browser call");

  const next = await web.transport.write(
    "session.send",
    {
      threadId,
      expectedConfigRevision: settled.desktop.configuration.revision,
      text: "Submit after explicit idle rebind.",
    },
    context,
    randomUUID(),
  );
  assert.equal(next.admissionState, "accepted");
  assert.notEqual(next.turnId, turnId);
  await until(async () => {
    const turn = (await read()).turns.at(-1);
    return turn?.id === next.turnId && turn.status === "completed";
  }, "successor Turn completes");
  await assert.rejects(observer.call("thread/resume", { threadId }), { code: -32009 });
  assert.deepEqual(await successor.call("browser.scope", { projectId, threadId }), successorScope);
  assert.equal((await activate()).serviceGeneration, serviceGeneration);
  checks.push("idle explicit send rebinds to the current Main without restarting Core");
} catch (error) {
  failure = error;
} finally {
  release?.();
  for (const main of mains) main.close();
  web?.transport.close();
  observer?.socket.close();
  source.close();
  try {
    const runningHost = await readFile(join(home, "host/host.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (runningHost) await stopAndAssertFixtureHost(binary, process.env, root);
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "ToolHost journey and cleanup failed")
      : error;
  } finally {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
}
if (failure) throw failure;
const result = {
  root,
  binary,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks,
  threadId: created.threadId,
  turnId: sent.turnId,
  modelRequests: requests.length,
};
await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
