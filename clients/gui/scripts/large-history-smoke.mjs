import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogBackend = process.env.AREAL_CATALOG_TEST_BACKEND ?? "memory";
assert.ok(["memory", "sqlite", "memory-lazy", "sqlite-lazy"].includes(catalogBackend));
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { DesktopService, PROTOCOL } = require("../app/src/core/service-protocol.cjs");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
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
  `schema_version=1\n[storage]\nsession_catalog="${catalogBackend}"\n[model]\nprovider="fixture"\nname="fixture"\ncontext_window_tokens=2000000\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      { id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Complete the task" },
    ],
  }),
);
const options = {
  binary: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
  home,
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
  desktopConfig: deployment,
  defaultProfile: { id: "fixture", revision: "v1" },
};
let backend = new CoreBackend(options),
  passed = false,
  service,
  connection,
  desktopPacket,
  stage = "seed";
const progress = (value, data = {}) => {
  stage = value;
  console.log(JSON.stringify({ stage, ...data }));
};
const rpcTimings = [];
let maxCacheBytes = 0;
const checks = [],
  wireBytes = [];
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timeout: ${label}`);
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const ids = (thread) => thread.turns.flatMap((turn) => turn.items.map((item) => item.id));
const history = (projectId, threadId, operation, extra = {}) =>
  backend.command("history", {
    projectId,
    threadId,
    viewId: `smoke:${threadId}`,
    operation,
    ...extra,
  });
function capture(project) {
  const request = project.client.request.bind(project.client);
  project.client.request = (method, params, settings) => {
    if (["areal/thread/observe", "areal/conversation/history"].includes(method)) {
      assert.equal(
        params?.mode ?? params?.view,
        method === "areal/thread/observe" ? "bounded" : "own",
      );
      assert.ok(params.maxBytes <= 1048576);
      assert.ok(settings?.maxResponseBytes <= 1048576);
    }
    assert.ok(
      method !== "thread/read" || params?.includeTurns !== true,
      "ordinary Desktop history path must not bypass bounded observe",
    );
    const started = performance.now();
    return request(method, params, settings).then((result) => {
      if (["areal/thread/observe", "areal/conversation/history"].includes(method)) {
        const fragment = result.data?.[0]?.fragment;
        const timing = {
          method,
          elapsedMs: Math.round(performance.now() - started),
          ...(fragment ? { offsetUtf8: fragment.offsetUtf8, totalBytes: fragment.totalBytes } : {}),
        };
        rpcTimings.push(timing);
        progress(stage, timing);
      }
      return result;
    });
  };
  project.client.socket.on("message", (bytes) => {
    const value = JSON.parse(String(bytes));
    if (value.result?.history || (value.result?.snapshotId && value.result?.data))
      wireBytes.push(Buffer.byteLength(bytes));
  });
}
try {
  await backend.init();
  const projectId = await backend.addProject(workspace),
    project = backend.projects.get(projectId);
  assert.equal(
    project.client.capabilities?.features?.boundedObservation,
    true,
    "requires Unit4 Core capability",
  );
  const { threadId } = await backend.command("create", { projectId });
  const { threadId: archivedId } = await backend.command("create", { projectId });
  const { threadId: hugeId } = await backend.command("create", { projectId });
  const additionalIds = [];
  for (let n = 0; n < 7; n++)
    additionalIds.push((await backend.command("create", { projectId })).threadId);
  await backend.command("send", { projectId, threadId, text: "fixture seed" });
  await until(
    () => project.model.state.threads[threadId]?.turns.some((turn) => turn.status === "completed"),
    "seed completed",
  );
  const modelRequests = workRequests(),
    dataDir = project.service.dataDir;
  if (catalogBackend === "sqlite")
    assert.ok((await readFile(join(dataDir, "catalog/index.sqlite3"))).length > 0);
  await backend.shutdown();
  await backend.disconnect();
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
  const hugePath = join(dataDir, `${hugeId}.json`),
    hugeRecord = JSON.parse(await readFile(hugePath, "utf8"));
  const hugeText = '雪\\\"🙂\n'.repeat(5500000);
  const hugeHash = digest(hugeText);
  hugeRecord.thread.turns = [
    {
      id: "huge-turn",
      status: "completed",
      items: [
        { id: "huge-user", type: "userMessage", content: [{ type: "text", text: "huge fixture" }] },
        { id: "huge-item", type: "agentMessage", text: hugeText },
      ],
    },
  ];
  assert.ok(Buffer.byteLength(JSON.stringify(hugeRecord)) > 64 * 1024 * 1024);
  await writeFile(hugePath, JSON.stringify(hugeRecord));
  const persisted = new Map();
  for (const id of [threadId, archivedId, hugeId, ...additionalIds]) {
    const value = JSON.parse(await readFile(join(dataDir, `${id}.json`), "utf8")).thread;
    persisted.set(id, digest(JSON.stringify({ turns: value.turns, receipts: value.receipts })));
  }
  backend = new CoreBackend(options);
  await backend.init();
  await backend.start(projectId);
  if (catalogBackend.endsWith("-lazy")) {
    const name = catalogBackend.startsWith("sqlite") ? "metadata.sqlite3" : "metadata.json";
    assert.ok((await readFile(join(dataDir, "catalog", name))).length > 0);
  }
  const live = backend.projects.get(projectId);
  capture(live);
  for (const id of [threadId, archivedId]) {
    progress(id === archivedId ? "archived-pages" : "ordinary-pages");
    await backend.openThread(live, id);
    await history(projectId, id, "acquire");
    let ordered = ids(live.model.state.threads[id]);
    assert.ok(
      Buffer.byteLength(JSON.stringify(live.model.state.threads[id])) <= 1048576,
      "initial Desktop view is bounded",
    );
    let complete = live.model.state.threads[id].displayHistory.complete;
    while (!complete) {
      const page = await history(projectId, id, "loadOlder");
      ordered = [...page.data.map((entry) => entry.sourceItemId), ...ordered];
      complete = page.complete;
      assert.ok(
        Buffer.byteLength(JSON.stringify(live.model.state.threads[id])) < 6 * 1048576,
        "old display pages stay bounded while traversing all history",
      );
    }
    assert.deepEqual(
      ordered,
      turns.flatMap((turn) => turn.items.map((item) => item.id)),
      "all old page IDs are chronological without gaps or duplicates",
    );
    const gap = live.model.state.threads[id].displayHistory.gaps.find((gap) => !gap.atTop);
    assert.ok(gap, "eviction retains a reloadable gap beside the latest window");
    const restored = await history(projectId, id, "loadOlder", { pageId: gap.id });
    const shown = ids(live.model.state.threads[id]);
    assert.ok(
      restored.data.every((entry) => shown.includes(entry.sourceItemId)),
      "real Core cursors can reload evicted bodies",
    );
    assert.deepEqual(
      shown,
      ordered.filter((itemId) => shown.includes(itemId)),
      "reload preserves chronological order without duplicates",
    );
    assert.ok(
      backend.historyWindow(live, id).pages.length <= 4,
      "reloading uses the same four-page body budget",
    );
    await history(projectId, id, "release");
  }
  checks.push(
    "ordinary and archived multi-segment histories traverse in order and reload evicted bodies using real Core cursors within the four-page budget",
  );
  if (!pagesOnly) {
    progress("huge-baseline");
    await backend.openThread(live, hugeId);
    service = new DesktopService(backend, "large-history-fixture");
    const metadata = await service.listen();
    connection = new ServiceConnection(
      (packet) => {
        desktopPacket = packet;
      },
      () => {},
    );
    await connection.connect(metadata);
    await connection.request("hello", { protocol: PROTOCOL, identity: metadata.identity });
    const desktopHistory = (operation, extra = {}) =>
      connection.request("command", {
        name: "history",
        request: { projectId, threadId: hugeId, viewId: "desktop-huge", operation, ...extra },
      });
    await desktopHistory("acquire");
    assert.equal(
      live.model.state.threads[hugeId].turns[0].items.find((item) => item.id === "huge-item").type,
      "historyDeferred",
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(live.model.state.threads[hugeId])) <= 1048576,
      "huge item is not eagerly materialized",
    );
    progress("huge-fragments");
    await desktopHistory("loadItem", { itemId: "huge-item" });
    assert.equal(
      digest(
        live.model.state.threads[hugeId].turns[0].items.find((item) => item.id === "huge-item")
          .text,
      ),
      hugeHash,
    );
    const received = desktopPacket.snapshot.projects.find((project) => project.id === projectId)
      .state.threads[hugeId];
    assert.equal(
      digest(received.turns[0].items.find((item) => item.id === "huge-item").text),
      hugeHash,
      "actual Desktop transport preserves the full explicit item",
    );
    await desktopHistory("release");
    assert.equal(
      desktopPacket.snapshot.projects
        .find((project) => project.id === projectId)
        .state.threads[hugeId].turns[0].items.find((item) => item.id === "huge-item").type,
      "historyDeferred",
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(live.model.state.threads[hugeId])) <= 1048576,
      "last view release drops huge materialization",
    );
    checks.push(
      "escaped Unicode item above 64MiB reassembles exactly only after explicit load and is released with its view",
    );
    progress("reconnect");
    const before = live.client,
      generation = live.service.generation;
    before.socket.terminate();
    await until(
      () =>
        live.client !== before && live.model.state.connected && !backend.starting.has(projectId),
      "bounded reconnect",
    );
    capture(live);
    assert.equal(live.service.generation, generation);
    assert.equal(workRequests(), modelRequests, "reconnect starts no non-title model work");
    assert.equal(
      live.model.state.threads[hugeId].turns[0].items.find((item) => item.id === "huge-item").type,
      "historyDeferred",
    );
    assert.ok(
      wireBytes.length > 10 && Math.max(...wireBytes) <= 1048576,
      "every observed history RPC envelope is <=1MiB",
    );
    checks.push(
      "reconnect recovers the same bounded views without additional model work or Core restart",
    );
  }
  progress("cache-views");
  for (const id of [...additionalIds, threadId]) {
    await backend.openThread(live, id);
    await history(projectId, id, "acquire");
    for (let n = 0; n < 4 && !live.model.state.threads[id].displayHistory.complete; n++)
      await history(projectId, id, "loadOlder");
    const cacheBytes = Buffer.byteLength(
      JSON.stringify({
        threads: live.model.state.threads,
        pages: [...backend.historyWindows.values()].map((window) => window.pages),
      }),
    );
    maxCacheBytes = Math.max(maxCacheBytes, cacheBytes);
    assert.ok(
      backend.historyWindows.size <= 8 && cacheBytes < 20 * 1048576,
      "all Desktop history windows and retained page entries have finite combined size",
    );
  }
  await assert.rejects(backend.openThread(live, archivedId), /视图已达上限/);
  await history(projectId, additionalIds[0], "release");
  await backend.openThread(live, archivedId);
  assert.equal(backend.historyWindows.size, 8);
  for (const id of [...additionalIds, threadId]) await history(projectId, id, "release");
  checks.push(
    "more than eight conversation views evict unused windows with bounded combined model and page bytes",
  );
  for (const [id, hash] of persisted) {
    const value = JSON.parse(await readFile(join(dataDir, `${id}.json`), "utf8")).thread;
    assert.equal(
      digest(JSON.stringify({ turns: value.turns, receipts: value.receipts })),
      hash,
      "read/reconnect cannot append a Turn or change its authoritative effect receipts",
    );
  }
  assert.equal(workRequests(), modelRequests);
  passed = true;
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      failure: error.message,
      code: error.code,
      historyResponses: wireBytes.length,
      lastRpc: rpcTimings.at(-1),
    }),
  );
  throw error;
} finally {
  connection?.close();
  service?.close();
  for (const project of backend.projects.values()) {
    try {
      await project.client?.request("areal/server/drain", { strategy: "cancel" });
    } catch {}
  }
  await backend.shutdown().catch(() => {});
  await backend.disconnect().catch(() => {});
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        workRequests: workRequests(),
        titleRequests: modelCalls.filter((call) => call.title).length,
        modelCalls,
        stage,
        maxCacheBytes,
        rpcTimings,
        historyResponses: wireBytes.length,
        maxHistoryResponseBytes: Math.max(0, ...wireBytes),
        pagesOnly,
        scope:
          "production CoreBackend and real Core WebSocket plus DesktopService/ServiceConnection, isolated persisted multi-segment fixtures and local deterministic model; pagesOnly skips huge fragments/reconnect, no Renderer acceptance",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
}
