import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../examples/desktop-api/client.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { DesktopService, PROTOCOL } = require("../app/src/core/service-protocol.cjs");
const { ServiceConnection } = require("../app/src/core/service-connection.cjs");
const { HostClient } = createRequire(new URL("../app/package.json", import.meta.url))(
  "@areal/client/node",
);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = join(
  process.env.AREAL_TEST_BIN_DIR ?? join(repository, ".local/shared-host-bin"),
  "areal",
);
const root = await realpath(await mkdtemp("/tmp/ah-toolhost-"));
const home = join(root, "host");
const user = join(root, "user");
const workspace = join(root, "workspace");
const profile = join(root, "profile");
for (const path of [home, user, workspace, profile]) await mkdir(path, { mode: 0o700 });
const checks = [];
const requests = [];
const mains = [];
let release;
let modelError;
let observer;
let service;
let backend;
let metadata;
const host = new HostClient();
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
async function main(computerHost = true) {
  const connection = new ServiceConnection();
  mains.push(connection);
  await connection.connect(metadata);
  const packet = await connection.request("hello", {
    protocol: PROTOCOL,
    identity: metadata.identity,
    capabilities: computerHost ? { computerHost: 1 } : {},
  });
  assert.equal(packet.computerHostOwned, computerHost);
  return connection;
}
try {
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const config = join(user, "config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  backend = new CoreBackend({
    binary,
    home: join(profile, "core"),
    guiProfile: profile,
    hostHome: home,
    harnessHome: join(root, "legacy"),
    sourceSingletonHeld: true,
    config,
    configHome: user,
    userHome: user,
    sandboxProfile: "native",
  });
  await backend.init();
  service = new DesktopService(backend, "toolhost-native-fixture");
  metadata = await service.listen();
  const first = await main();
  const projectId = await backend.addProject(workspace);
  const project = backend.projects.get(projectId);
  assert.ok(project.client.ready);
  const originalClient = project.client;
  const originalService = { ...project.service };
  observer = await connect(project.endpoint, project.service.authFile);
  await host.connect(home);
  const { threadId } = await backend.command("create", { projectId });
  const initial = await observer.call("areal/thread/observe", { threadId });
  assert.ok(initial.thread.dynamicTools.some((tool) => tool.name === "browser_v1"));
  const spectator = await main(false);
  spectator.close();
  await until(() => service.clients.size === 1, "ordinary observer disconnects");
  assert.equal(originalClient.closed, false);
  checks.push("ordinary-desktop-observer-cannot-revoke-main-toolhost");

  await backend.command("send", { projectId, threadId, text: "Hold the original turn." });
  await until(() => release, "model request is held");
  const active = await observer.call("areal/thread/observe", { threadId });
  const turnId = active.thread.turns.at(-1).id;
  first.close();
  await until(() => originalClient.closed, "Main disconnect closes actual Core ToolHost socket");
  await until(
    () => project.client !== originalClient && project.client?.ready,
    "Desktop reconnects for observation",
  );
  assert.equal(service.closed, false);
  assert.deepEqual(backend.desktopTools(project), []);
  assert.equal(project.service.generation, originalService.generation);
  assert.equal(
    (await observer.call("areal/thread/observe", { threadId })).thread.turns.at(-1).id,
    turnId,
  );
  checks.push("main-disconnect-with-live-desktop-withdraws-toolhost-and-preserves-turn");

  const ownerless = project.client;
  await main();
  await until(
    () => project.client !== ownerless && project.client?.ready,
    "successor Main uses a fresh observation connection",
  );
  await assert.rejects(project.client.request("thread/resume", { threadId }), { code: -32009 });
  assert.equal(project.service.generation, originalService.generation);
  release();
  release = undefined;
  await until(async () => {
    const current = await observer.call("areal/thread/observe", { threadId });
    return current.thread.turns.at(-1)?.status === "completed";
  }, "original turn completes without tool host rebinding");
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find((message) => message.role === "tool");
  assert.ok(toolResult, "Core reports a tool result to the model");
  assert.match(JSON.stringify(toolResult), /unavailable|disconnect|closed/i);
  assert.equal(service.browserPending.size, 0);
  assert.equal(
    (await observer.call("areal/thread/observe", { threadId })).thread.turns.at(-1).id,
    turnId,
  );
  checks.push("successor-does-not-rebind-active-turn-or-replay-original-tool");

  await backend.ensureBrowserTools(project, threadId);
  await assert.rejects(observer.call("thread/resume", { threadId }), { code: -32009 });
  const bound = await project.client.request("areal/thread/observe", { threadId });
  assert.equal(bound.thread.id, threadId);
  assert.equal(project.service.generation, originalService.generation);
  checks.push("idle-explicit-action-rebinds-to-current-main-only");
  const result = {
    root,
    binary,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    checks,
    serviceId: originalService.serviceId,
    generation: originalService.generation,
    threadId,
    turnId,
    modelRequests: requests.length,
    excluded: ["Electron UI", "real browser actions", "real provider", "package"],
  };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  release?.();
  for (const connection of mains) connection.close();
  service?.close();
  await backend?.disconnect();
  observer?.socket.close();
  try {
    if (host.socket && !host.socket.destroyed) {
      const result = await host.request("host.stop", {
        requestId: randomUUID(),
        expectedGeneration: host.generation,
        strategy: "cancel",
      });
      assert.equal(result.state, "completed");
    }
  } finally {
    host.close();
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
}
