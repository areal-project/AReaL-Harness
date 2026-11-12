// Actual Core/Store/CLI acceptance; only the external model is deterministic.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnNative } from "./native-child.mjs";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url));
const WebSocket = require("ws"),
  exec = promisify(execFile);
const scratch = await realpath(await trackedMkdtemp("/private/tmp/areal-plugin-p0-"));
const workspace = join(scratch, "workspace"),
  home = join(scratch, "config-home");
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const coreSha256 = createHash("sha256")
  .update(await readFile(bin))
  .digest("hex");
const config = join(scratch, "config.toml"),
  source = join(workspace, "packages", "reviewer");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("AREAL_") && !k.startsWith("OTEL_")),
  ),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const sourceRoot = resolve(".");
const sourceFiles = {};
for (const path of new Set(
  execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean),
)) {
  if (/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path))
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(sourceRoot, path)))
      .digest("hex");
}
const sourceDiffSha256 = createHash("sha256")
  .update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: sourceRoot }))
  .digest("hex");
const checks = [],
  requests = [],
  clients = [];
let service,
  failure,
  passed = false;
const model = createServer(async (req, res) => {
  let body = "";
  for await (const p of req) body += p;
  requests.push(JSON.parse(body));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "PLUGIN_SETUP_OK" }, finish_reason: null }],
      }) +
      "\n\n" +
      "data: " +
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
async function cli(args) {
  const r = await exec(bin, args, { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(r.stdout);
}
async function connect(token, endpoint = service.endpoint, authFile = service.authFile) {
  const auth = JSON.parse(await readFile(authFile, "utf8"));
  let ignoredReplyId = null;
  const c = new CoreClient({
    createSocket: () => {
      const socket = new WebSocket(endpoint, {
        headers: { Authorization: "Bearer " + (token ?? auth.principals[0].token) },
      });
      const add = socket.addEventListener.bind(socket);
      socket.addEventListener = (name, listener, options) =>
        add(
          name,
          name === "message"
            ? (event) => {
                const reply = JSON.parse(event.data.toString());
                if (reply.id === ignoredReplyId) {
                  ignoredReplyId = null;
                  return;
                }
                listener(event);
              }
            : listener,
          options,
        );
      return socket;
    },
    timeoutMs: 30_000,
  });
  c.dropNextReply = () => {
    ignoredReplyId = c.nextId + 1;
  };
  await c.connect();
  clients.push(c);
  return c;
}
const ref = (s) => ({ id: s.id, revision: s.revision });
async function complete(client, id) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const t = (await client.request("thread/read", { threadId: id, includeTurns: true })).thread;
    if (t.turns?.at(-1)?.status === "completed") return t;
    if (t.turns?.at(-1)?.status === "failed") throw Error(JSON.stringify(t.turns.at(-1)));
    await new Promise((r) => setTimeout(r, 60));
  }
  throw Error("setup turn did not complete");
}
async function authorizationMatrix() {
  const authHome = join(scratch, "authorization"),
    authFile = join(authHome, "auth.json"),
    ready = join(authHome, "ready.json");
  await mkdir(authHome, { recursive: true });
  const principals = [
    { id: "desktop", token: randomUUID(), permissions: ["observe", "interact", "manage", "tools"] },
    { id: "observer", token: randomUUID(), permissions: ["observe"] },
    {
      id: "scoped",
      token: randomUUID(),
      permissions: ["observe", "interact", "manage", "tools"],
      threadIds: [],
    },
  ];
  await writeFile(authFile, JSON.stringify({ version: 1, principals }), { mode: 0o600 });
  let log = "";
  const child = spawnNative(
    bin,
    [
      "app-server",
      "--management",
      "--auth-file",
      authFile,
      "--config",
      config,
      "--data-dir",
      join(authHome, "data"),
      "--ready-metadata-file",
      ready,
    ],
    {
      cwd: workspace,
      env: { ...env, AREAL_HARNESS_HOME: join(authHome, "config-home") },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (b) => {
    log = (log + b).slice(-32768);
  });
  try {
    let metadata;
    const deadline = Date.now() + 30_000;
    while (!metadata) {
      try {
        metadata = JSON.parse(await readFile(ready, "utf8"));
      } catch (e) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw Error("auth Core startup: " + log);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const admin = await connect(principals[0].token, metadata.endpoint, authFile);
    const before = await admin.request("areal/plugin/list", {});
    assert(before.data.some((x) => x.id === "reviewer@p0-market"));
    for (const principal of principals.slice(1)) {
      const restricted = await connect(principal.token, metadata.endpoint, authFile);
      for (const [method, params] of [
        ["areal/plugin/list", {}],
        ["areal/plugin/read", { id: "reviewer@p0-market" }],
        [
          "areal/plugin/install",
          {
            id: "reviewer@p0-market",
            scope: "user",
            expectedRevision: before.revision,
            source,
            expectedDigest: before.data[0].sourceDigest,
            requestId: randomUUID(),
          },
        ],
        [
          "areal/plugin/configure",
          {
            id: "reviewer@p0-market",
            scope: "user",
            enabled: false,
            expectedRevision: before.revision,
            requestId: randomUUID(),
          },
        ],
        [
          "areal/plugin/uninstall",
          { id: "reviewer@p0-market", expectedRevision: before.revision, requestId: randomUUID() },
        ],
        ["areal/plugin/setup", { id: "reviewer@p0-market", requestId: randomUUID() }],
        [
          "areal/marketplace/add",
          { root: workspace, expectedRevision: before.revision, requestId: randomUUID() },
        ],
      ]) {
        await assert.rejects(
          restricted.request(method, params),
          (e) => e.code === -32003,
          principal.id + ": " + method,
        );
      }
      restricted.close();
    }
    assert.deepEqual(await admin.request("areal/plugin/list", {}), before);
    admin.close();
    checks.push(
      "authenticated observer and thread-scoped identities cannot read or mutate global plugin state/setup",
    );
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("auth Core did not stop"));
        }, 15_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
}
try {
  await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
  await mkdir(join(source, "skills", "review"), { recursive: true });
  await mkdir(join(source, "skills", "setup"), { recursive: true });
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "reviewer",
      version: "1.0.0",
      description: "P0 original package",
      extensions: {
        "com.openai": {
          onboardingSkill: "./skills/setup/SKILL.md",
          interface: { displayName: "P0 Reviewer" },
        },
      },
    }),
  );
  await writeFile(
    join(source, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review a fixture.\n---\nREVIEW_ORIGINAL\nSee ../../assets/shared.txt.\n",
  );
  await writeFile(
    join(source, "skills", "setup", "SKILL.md"),
    "---\nname: setup\ndescription: Set up the fixture.\n---\nSETUP_SKILL_BODY_MARKER\n",
  );
  await writeFile(join(source, "assets", "shared.txt"), "SHARED_PACKAGE_ORIGINAL");
  await writeFile(join(source, "danger.sh"), "#!/bin/sh\nexit 99\n");
  await writeFile(
    join(workspace, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "p0-market",
      plugins: [
        {
          name: "reviewer",
          source: { source: "local", path: "./packages/reviewer" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Productivity",
        },
      ],
    }),
  );
  await writeFile(
    config,
    'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:' +
      model.address().port +
      '"\n',
  );
  await authorizationMatrix();
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    config,
  ]);
  const c = await connect();
  assert(c.capabilities.methods.includes("areal/plugin/list"));
  let list = await c.request("areal/plugin/list", {}),
    row = list.data.find((x) => x.id === "reviewer@p0-market");
  assert(row && !row.installed);
  assert.equal(requests.length, 0);
  checks.push("original local marketplace discovered without model/package execution");
  const thread = (await c.request("thread/start", { cwd: workspace })).thread;
  const installRequest = {
    id: row.id,
    scope: "project",
    expectedRevision: list.revision,
    source: row.source,
    expectedDigest: row.sourceDigest,
    requestId: randomUUID(),
  };
  const installed = await c.request("areal/plugin/install", installRequest);
  assert(installed.installed && installed.enabled);
  assert.equal(requests.length, 0);
  assert.deepEqual(await c.request("areal/plugin/install", installRequest), installed);
  await assert.rejects(
    c.request("areal/plugin/install", { ...installRequest, scope: "user" }),
    (e) => e.code === -32009 || /conflict/i.test(e.message),
  );
  checks.push("install and request receipts preserve original package and deduplicate");
  const skill = installed.skills.find((s) => s.name === "review");
  const directory = await c.request("areal/skill/list", { threadId: thread.id });
  assert(directory.data.some((s) => s.id === skill.id && s.available));
  const selection = (await c.request("areal/thread/inspect", { threadId: thread.id }))
    .configuration;
  await c.request("areal/thread/configure", {
    threadId: thread.id,
    expectedRevision: selection.revision,
    selectedSkills: [ref(skill)],
    requestId: randomUUID(),
  });
  let page = await c.request("areal/skill/read", { threadId: thread.id, skill: ref(skill) });
  assert.match(page.text, /REVIEW_ORIGINAL/);
  assert.equal(
    (
      await c.request("areal/skill/read", {
        threadId: thread.id,
        skill: ref(skill),
        resource: "../../assets/shared.txt",
      })
    ).text,
    "SHARED_PACKAGE_ORIGINAL",
  );
  await assert.rejects(
    c.request("areal/skill/read", {
      threadId: thread.id,
      skill: ref(skill),
      resource: "../../../config.toml",
    }),
  );
  await writeFile(join(source, "skills", "review", "SKILL.md"), "SOURCE_CHANGED_WITHOUT_UPDATE");
  page = await c.request("areal/skill/read", { threadId: thread.id, skill: ref(skill) });
  assert.match(page.text, /REVIEW_ORIGINAL/);
  checks.push(
    "existing ordinary chat sees plugin; immutable package and contained shared resources",
  );
  list = await c.request("areal/plugin/list", {});
  await assert.rejects(
    c.request("areal/plugin/install", {
      ...installRequest,
      expectedRevision: list.revision,
      requestId: randomUUID(),
    }),
    (e) => /changed|SOURCE_CHANGED/i.test(e.message),
  );
  checks.push("reviewed source digest rejects source drift");
  await c.request("areal/plugin/configure", {
    id: row.id,
    scope: "project",
    enabled: false,
    expectedRevision: list.revision,
    requestId: randomUUID(),
  });
  await assert.rejects(c.request("areal/skill/read", { threadId: thread.id, skill: ref(skill) }));
  list = await c.request("areal/plugin/list", {});
  await assert.rejects(
    c.request("areal/plugin/configure", {
      id: row.id,
      scope: "project",
      enabled: true,
      expectedRevision: list.revision - 1,
      requestId: randomUUID(),
    }),
    (e) => e.code === -32009 || /conflict/i.test(e.message),
  );
  await c.request("areal/plugin/configure", {
    id: row.id,
    scope: "project",
    enabled: true,
    expectedRevision: list.revision,
    requestId: randomUUID(),
  });
  assert.match(
    (await c.request("areal/skill/read", { threadId: thread.id, skill: ref(skill) })).text,
    /REVIEW_ORIGINAL/,
  );
  checks.push("disable revokes existing refs, stale revision rejects, reenable recovers");
  const setupRequest = { id: row.id, requestId: randomUUID() };
  const setup = await c.request("areal/plugin/setup", setupRequest);
  assert(setup.thread.id && setup.turn.id);
  await complete(c, setup.thread.id);
  const priorCount = requests.length;
  assert.deepEqual(await c.request("areal/plugin/setup", setupRequest), setup);
  assert.equal(requests.length, priorCount);
  assert(requests.some((r) => JSON.stringify(r.messages).includes("SETUP_SKILL_BODY_MARKER")));
  const receipt = await c.request("areal/request/read", { requestId: setupRequest.requestId });
  assert(
    receipt.data.some(
      (x) =>
        x.method === "areal/plugin/setup" &&
        x.state === "completed" &&
        x.response.result.thread.id === setup.thread.id,
    ),
  );
  checks.push(
    "explicit setup normal turn loads authoritative skill and recovers via receipt without replay",
  );
  const lostSetup = { id: row.id, threadId: setup.thread.id, requestId: randomUUID() };
  c.dropNextReply();
  await assert.rejects(
    c.request("areal/plugin/setup", lostSetup, { timeoutMs: 250 }),
    (e) => e.submissionUnknown === true,
  );
  await complete(c, setup.thread.id);
  const countAfterLoss = requests.length;
  const lostReceipt = await c.request("areal/request/read", { requestId: lostSetup.requestId });
  const recovered = lostReceipt.data.find((x) => x.method === "areal/plugin/setup");
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.response.result.thread.id, setup.thread.id);
  assert.equal(requests.length, countAfterLoss, "receipt lookup cannot replay setup");
  checks.push(
    "real executed setup with dropped transport reply recovers by receipt without replay",
  );

  const cliList = await cli(["plugin", "--workspace", workspace, "list", "--json"]);
  assert(cliList.data.find((x) => x.id === row.id).installed);
  checks.push("CLI reads the same Core installation state");
  for (const x of clients) x.close();
  clients.length = 0;
  await cli(["service", "stop", "--json", "--instance", service.serviceId]);
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    config,
  ]);
  const restarted = await connect();
  list = await restarted.request("areal/plugin/list", {});
  assert(list.data.find((x) => x.id === row.id).installed);
  assert.match(
    (await restarted.request("areal/skill/read", { threadId: thread.id, skill: ref(skill) })).text,
    /REVIEW_ORIGINAL/,
  );
  checks.push("Core restart restores installation, refs and original cached bytes");
  await restarted.request("areal/plugin/uninstall", {
    id: row.id,
    expectedRevision: list.revision,
    requestId: randomUUID(),
  });
  await assert.rejects(
    restarted.request("areal/skill/read", { threadId: thread.id, skill: ref(skill) }),
  );
  checks.push("uninstall revokes retained revision reads");
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack, code: error.code };
  process.exitCode = 1;
} finally {
  for (const c of clients) c.close();
  if (service)
    try {
      await cli(["service", "stop", "--json", "--instance", service.serviceId]);
    } catch (error) {
      failure ??= { message: "cleanup: " + error.message };
      process.exitCode = 1;
      passed = false;
    }
  await new Promise((r) => model.close(r));
  const manifest = {
    passed,
    scratch,
    bin,
    coreSha256,
    coreUnchanged:
      createHash("sha256")
        .update(await readFile(bin))
        .digest("hex") === coreSha256,
    sourceFiles,
    sourceDiffSha256,
    checks,
    modelRequests: requests.length,
    failure,
    evidenceClass:
      "actual Core/Store/CLI with deterministic external model; no native GUI/provider/package acceptance",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
