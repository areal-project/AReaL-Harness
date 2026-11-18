import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readCoreThread } from "./support/core-observation.mjs";
import {
  assertApplicationStopped,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogBackend = process.env.AREAL_CATALOG_TEST_BACKEND ?? "memory";
assert.ok(["memory", "sqlite", "memory-lazy", "sqlite-lazy"].includes(catalogBackend));
const require = createRequire(join(gui, "app/package.json"));
const { GuiSourceSession } = require("@areal/client/gui-source");
const {
  createNativeHostTransport,
} = require("../app/src/core/generated/native-host-transport.cjs");
const { build } = createRequire(join(gui, "packages/browser-data/package.json"))("esbuild");
const WebSocket = require("ws");
const execute = promisify(execFile);
const scratch = await makeTempDir("areal-large-history-");
// Focused paging acceptance excludes the independent >64MiB fragment workload.
const pagesOnly = process.argv.includes("--pages-only");
const workspace = join(scratch, "workspace"),
  home = join(scratch, "desktop");
await mkdir(workspace);
await mkdir(join(scratch, "user", ".areal"), { recursive: true });
const modelCalls = [];
const workRequests = () => modelCalls.filter((call) => !call.title).length;
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const title =
    body.messages?.[0]?.content?.startsWith("Generate a concise semantic session title") === true;
  modelCalls.push({ title, at: Date.now() });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: title ? "History fixture" : "MODEL_RECEIPT_SENTINEL" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(scratch, "user", ".areal", "config.toml"),
  `schema_version=1\n[storage]\nsession_catalog="${catalogBackend}"\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\ncontext_window_tokens=2000000\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
const deployment = join(gui, "packages/workbench/assets/desktop-profile.json");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const userHome = join(scratch, "user");
const profile = join(scratch, "electron");
const registry = join(scratch, "registry");
const priorRegistry = join(scratch, "prior-registry");
for (const key of Object.keys(process.env)) {
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE")
    delete process.env[key];
}
Object.assign(process.env, {
  HOME: userHome,
  AREAL_CORE_HOME: home,
  AREAL_CORE_USER_HOME: userHome,
  AREAL_GUI_USER_DATA: profile,
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: registry,
});
const env = { ...process.env };
await mkdir(profile);
const source = new GuiSourceSession({
  binary,
  home: registry,
  source: { profile, coreHome: home, legacyServiceHome: priorRegistry },
  singletonHeld: true,
});
let main,
  web,
  originalHost,
  passed = false;
let stage = "seed";
let failure, cleanupError, fragmentOffset;
const checks = [],
  wireBytes = [],
  rpcTimings = [];
const progress = (value, data = {}) => {
  stage = value;
  console.log(JSON.stringify({ stage, ...data }));
};
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const ids = (thread) => thread.turns.flatMap((turn) => turn.items.map((item) => item.id));
const origin = "areal-ui://app";
let projectId, sourceProjectId, serviceGeneration;
const bundle = join(scratch, "host-websocket.mjs");
await build({
  entryPoints: [join(gui, "packages/client/src/websocket.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
});
const { connectWebSocket } = await import(pathToFileURL(bundle));
async function connectWeb() {
  const ticket = await source.client.request("web.ticket", {
    origin,
    expectedGeneration: source.client.generation,
    profile,
  });
  const connection = await connectWebSocket(
    { origin, writes: true, bootstrap: async () => ticket },
    () => true,
    AbortSignal.timeout(120000),
    () => {},
    () => {},
    (url) => {
      const socket = new WebSocket(url, { origin, followRedirects: false });
      socket.on("message", (data) => {
        const { result } = JSON.parse(String(data));
        if (result?.view === "conversation" && (result.snapshot || result.page))
          wireBytes.push(Buffer.byteLength(data));
      });
      return socket;
    },
  );
  return connection.transport;
}
const context = () => ({ projectId, serviceGeneration });
const open = (threadId) =>
  web.request("session.open", { threadId, view: "conversation" }, context());
const history = async (baseline, cursor) => {
  const started = performance.now();
  const timing = { serviceGeneration, fragmentOffset };
  rpcTimings.push(timing);
  try {
    const result = await web.request(
      "session.history",
      {
        threadId: baseline.threadId,
        subscriptionId: baseline.subscriptionId,
        view: "own",
        cursor,
        maxBytes: 131072,
      },
      context(),
    );
    for (const key of [
      "connectionId",
      "serviceGeneration",
      "projectId",
      "threadId",
      "subscriptionId",
    ])
      assert.equal(result[key], baseline[key]);
    timing.complete = result.page.complete;
    return result.page;
  } finally {
    timing.elapsedMs = Math.round(performance.now() - started);
  }
};
try {
  console.log("History evidence:", scratch);
  await source.init({ deferCredentials: true });
  originalHost = await readFixtureHost(env);
  const launch = await source.prepareNative(
    {
      binary,
      home,
      guiProfile: profile,
      hostHome: registry,
      harnessHome: priorRegistry,
      userHome,
      configHome: userHome,
      config: join(userHome, ".areal/config.toml"),
      desktopConfig: deployment,
      defaultProfile: { id: "areal-standard", revision: "v2" },
    },
    env,
  );
  main = await createNativeHostTransport({
    home: registry,
    sourceId: source.sourceId,
    launch: launch.options,
    environmentCredentials: source.environmentCredentials,
    onCallback: () => {
      throw new Error("History fixture must not require a native tool");
    },
    onEvent() {},
    onClosed() {},
  });
  ({ projectId: sourceProjectId } = await main.call("worktree.project.add", { root: workspace }));
  web = await connectWeb();
  const shell = await web.request("shell.subscribe", {});
  ({ projectId } = shell.snapshot.projects.find(
    (entry) =>
      entry.alias?.sourceId === source.sourceId && entry.alias.projectId === sourceProjectId,
  ));
  ({ serviceGeneration } = await web.write("project.activate", {}, { projectId }));
  assert.ok(serviceGeneration);
  const createThread = async () => {
    const requestId = randomUUID();
    const result = await web.write(
      "session.create",
      {
        requestId,
        model: { providerId: "fixture", modelId: "fixture" },
        worktree: { mode: "source" },
      },
      context(),
      requestId,
    );
    assert.equal(result.admissionState, "accepted", JSON.stringify(result));
    return result.threadId;
  };
  const threadId = await createThread();
  const archivedId = await createThread();
  const hugeId = pagesOnly ? null : await createThread();
  const additionalIds = [];
  for (let n = 0; n < 7; n++) additionalIds.push(await createThread());
  const seed = await readCoreThread({ binary, env, gui, threadId, workspace });
  const result = await web.write(
    "session.send",
    {
      threadId,
      text: "fixture seed",
      expectedConfigRevision: seed.desktop.configuration.revision,
    },
    context(),
    randomUUID(),
  );
  assert.equal(result.admissionState, "accepted", JSON.stringify(result));
  await until(async () => {
    const thread = await readCoreThread({ binary, env, gui, threadId, workspace });
    return thread.turns.some((turn) => turn.id === result.turnId && turn.status === "completed");
  }, "Seed Turn completed");
  const modelRequests = workRequests();
  const { stdout } = await execute(binary, ["service", "list", "--json"], { env, timeout: 20000 });
  const { dataDir } = JSON.parse(stdout).find(
    (record) => record.workspace === workspace && record.generation === serviceGeneration,
  );
  assert.ok(dataDir.startsWith(home + "/"), "Persisted fixture must stay inside its Core home");
  if (catalogBackend === "sqlite")
    assert.ok((await readFile(join(dataDir, "catalog/index.sqlite3"))).length > 0);
  progress("seed-stop");
  web.close();
  web = null;
  const stopId = randomUUID();
  const stopped = await source.client.stopProject(
    stopId,
    projectId,
    serviceGeneration,
    "cancel",
    false,
  );
  assert.equal(stopped.requestId, stopId);
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  await assertApplicationStopped(binary, env);
  await writeFile(join(scratch, "seed-stop.json"), JSON.stringify(stopped, null, 2));
  const makeTurn = (n) => ({
    id: `turn-${n}`,
    status: "completed",
    items: [
      { id: `user-${n}`, type: "userMessage", content: [{ type: "text", text: `question ${n}` }] },
      { id: `answer-${n}`, type: "agentMessage", text: `${n}:雪\\"🙂\n`.repeat(6000) },
    ],
  });
  const turns = Array.from({ length: 90 }, (_, n) => makeTurn(n));
  await mkdir(join(dataDir, "history"), { recursive: true });
  let previous = null;
  for (let end = 10; end <= 80; end += 10) {
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, previous, turns: turns.slice(end - 10, end) }),
    );
    const head = digest(bytes);
    await writeFile(join(dataDir, "history", head), bytes);
    previous = {
      head,
      throughItemId: `answer-${end - 1}`,
      completedTurns: end,
      items: end * 2,
      bytes: bytes.length,
    };
  }
  for (const id of [threadId, archivedId, ...additionalIds]) {
    const path = join(dataDir, `${id}.json`),
      record = JSON.parse(await readFile(path, "utf8"));
    record.thread.turns = turns.slice(80);
    record.thread.historyArchive = previous;
    record.thread.desktop.archived = id === archivedId;
    await writeFile(path, JSON.stringify(record));
  }
  let hugeHash;
  if (hugeId) {
    const path = join(dataDir, `${hugeId}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    const hugeText = '雪\\\"🙂\n'.repeat(5500000);
    hugeHash = digest(hugeText);
    record.thread.turns = [
      {
        id: "huge-turn",
        status: "completed",
        items: [
          {
            id: "huge-user",
            type: "userMessage",
            content: [{ type: "text", text: "huge fixture" }],
          },
          { id: "huge-item", type: "agentMessage", text: hugeText },
        ],
      },
    ];
    const bytes = JSON.stringify(record);
    assert.ok(Buffer.byteLength(bytes) > 64 * 1024 * 1024);
    await writeFile(path, bytes);
  }
  const persisted = new Map();
  const receiptHash = async (id) => {
    const value = JSON.parse(await readFile(join(dataDir, `${id}.json`), "utf8")).thread;
    return digest(JSON.stringify({ turns: value.turns, receipts: value.receipts }));
  };
  for (const id of [threadId, archivedId, hugeId, ...additionalIds].filter(Boolean))
    persisted.set(id, await receiptHash(id));

  web = await connectWeb();
  const originalGeneration = serviceGeneration;
  ({ serviceGeneration } = await web.write("project.activate", {}, { projectId }));
  assert.ok(serviceGeneration && serviceGeneration !== originalGeneration);
  if (catalogBackend.endsWith("-lazy")) {
    const name = catalogBackend.startsWith("sqlite") ? "metadata.sqlite3" : "metadata.json";
    assert.ok((await readFile(join(dataDir, "catalog", name))).length > 0);
  }
  for (const id of [threadId, archivedId]) {
    progress(id === archivedId ? "archived-pages" : "ordinary-pages");
    const baseline = await open(id);
    const expected = turns.flatMap((turn) => turn.items.map((item) => item.id));
    let ordered = ids(baseline.snapshot.thread);
    let cursor = baseline.snapshot.history.nextCursor;
    const firstCursor = cursor;
    let first;
    const visited = new Set();
    while (cursor) {
      assert.ok(!visited.has(cursor), "History cursor advanced");
      visited.add(cursor);
      const page = await history(baseline, cursor);
      assert.ok(page.data.length && visited.size <= expected.length);
      first ??= page;
      ordered = [...page.data.map((item) => item.sourceItemId), ...ordered];
      assert.equal(Boolean(page.nextCursor), !page.complete);
      cursor = page.nextCursor;
    }
    assert.deepEqual(ordered, expected);
    assert.ok(firstCursor && first);
    assert.deepEqual((await history(baseline, firstCursor)).data, first.data);
  }
  checks.push(
    "Original ordinary and archived history is traversed in order, and an old page can be read again by its cursor",
  );
  if (hugeId) {
    progress("huge-fragments");
    const baseline = await open(hugeId);
    const deferred = baseline.snapshot.thread.turns[0].items.find(
      (item) => item.id === "huge-item",
    );
    assert.equal(deferred.type, "historyDeferred");
    assert.ok(deferred.totalBytes > 64 * 1024 * 1024);
    let cursor = deferred.cursor,
      offset = 0;
    const buffers = [];
    do {
      fragmentOffset = offset;
      const page = await history(baseline, cursor);
      assert.ok(page.data.length, "History fragment reply must advance by at least one byte");
      for (const entry of page.data) {
        assert.equal(entry.sourceThreadId, hugeId);
        assert.equal(entry.sourceTurnId, "huge-turn");
        assert.equal(entry.sourceItemId, "huge-item");
        assert.equal(entry.fragment.version, deferred.version);
        assert.equal(entry.fragment.totalBytes, deferred.totalBytes);
        assert.equal(entry.fragment.offsetUtf8, offset);
        const bytes = Buffer.from(entry.fragment.text);
        assert.ok(bytes.length);
        offset += bytes.length;
        assert.equal(offset, entry.fragment.nextOffsetUtf8);
        assert.ok(offset <= deferred.totalBytes);
        buffers.push(bytes);
      }
      assert.ok(page.complete || (page.nextCursor && page.nextCursor !== cursor));
      cursor = page.nextCursor;
    } while (cursor);
    fragmentOffset = undefined;
    assert.equal(offset, deferred.totalBytes);
    const entry = JSON.parse(Buffer.concat(buffers, offset).toString("utf8"));
    assert.equal(entry.item.id, "huge-item");
    assert.equal(digest(entry.item.text), hugeHash);
    checks.push(
      "An explicit history read reconstructs a greater-than-64 MiB item with the same digest from bounded ordered fragments",
    );
    progress("reconnect");
    web.close();
    web = await connectWeb();
    const reopened = await open(hugeId);
    assert.equal(reopened.serviceGeneration, serviceGeneration);
    assert.notEqual(reopened.connectionId, baseline.connectionId);
    assert.equal(
      reopened.snapshot.thread.turns[0].items.find((item) => item.id === "huge-item").type,
      "historyDeferred",
    );
    checks.push("Reconnecting to the same Core keeps the oversized item deferred");
  }
  progress("select-many");
  let previousView;
  for (const id of [...additionalIds, threadId, archivedId]) {
    const baseline = await open(id);
    assert.equal(baseline.threadId, id);
    assert.equal(baseline.serviceGeneration, serviceGeneration);
    assert.ok(baseline.snapshot.history.nextCursor);
    if (previousView)
      await assert.rejects(history(previousView, previousView.snapshot.history.nextCursor), {
        code: "INVALID_PARAMS",
      });
    previousView = baseline;
  }
  assert.ok(
    wireBytes.length > 10 && Math.max(...wireBytes) <= 1048576,
    "Every history baseline or page envelope stays below 1 MiB",
  );
  for (const [id, hash] of persisted)
    assert.equal(
      await receiptHash(id),
      hash,
      "History reads must preserve execution history and receipts",
    );
  assert.equal(workRequests(), modelRequests, "History operations never submit model work");
  checks.push(
    "Selecting another conversation closes the previous reading view, with bounded frames and no execution or receipt changes",
  );
  passed = true;
} catch (error) {
  failure = error;
  console.error(
    JSON.stringify({
      stage,
      failure: error.message,
      code: error.code,
      historyResponses: wireBytes.length,
      lastRpc: rpcTimings.at(-1),
    }),
  );
} finally {
  web?.close();
  main?.close();
  source.close();
  try {
    await settleFixtureHostAfterQuit(binary, env, scratch, { host: originalHost });
  } catch (error) {
    cleanupError = error;
    passed = false;
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        binarySHA256: digest(await readFile(binary)),
        scriptSHA256: digest(await readFile(import.meta.filename)),
        workRequests: workRequests(),
        titleRequests: modelCalls.filter((call) => call.title).length,
        modelCalls,
        stage,
        cleanupError: cleanupError?.message,
        rpcTimings,
        historyResponses: wireBytes.length,
        maxHistoryResponseBytes: Math.max(0, ...wireBytes),
        pagesOnly,
        scope:
          "Native Host WebSocket and real Core, isolated persisted multi-segment fixtures and local deterministic model. pagesOnly skips huge fragments/reconnect. Renderer cache limits have separate tests.",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
}
if (failure && cleanupError)
  throw new AggregateError([failure, cleanupError], "History verification and cleanup failed");
if (failure) throw failure;
if (cleanupError) throw cleanupError;
