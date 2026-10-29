"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const Module = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");

const filename = resolve(__dirname, "../app/src/core/history-observation.cjs");
let { HistoryObservation } = require(filename);
// 可选旧源码在原模块路径解析依赖，比较时无需覆盖工作区或连接真实 Core。
if (process.argv[2]) {
  const baseline = new Module(filename, module);
  baseline.filename = filename;
  baseline.paths = require.cache[filename].paths;
  baseline._compile(readFileSync(process.argv[2], "utf8"), filename);
  ({ HistoryObservation } = baseline.exports);
}

const productionCache = process.env.AREAL_CATALOG_BENCH_CACHE === "production";
const count = Number(process.env.AREAL_CATALOG_BENCH_THREADS ?? 2_000);
assert.ok(Number.isInteger(count) && count > 0 && count <= 20_000);
const rows = Array.from({ length: count }, (_, index) => ({
  id: `thread-${String(index).padStart(4, "0")}`,
  createdAt: index,
  updatedAt: index,
  source: "appServer",
  desktop: {},
}));

async function sample(operation) {
  let requests = 0,
    writes = 0,
    summaryWrites = 0,
    activityUpdates = 0;
  const project = {
    id: "fixture",
    connectionGeneration: 1,
    summaries: rows,
    summariesLoaded: true,
    configurations: {},
    model: { event() {}, state: { threads: {} } },
  };
  const client = (project.client = {
    capabilities: { methods: ["areal/conversation/list"] },
    request: async (method, params, options) => {
      requests++;
      await new Promise((done) => setImmediate(done));
      if (method === "thread/read") {
        assert.equal(params.includeTurns, false);
        const response = { thread: rows.find((row) => row.id === params.threadId) };
        return options?.decode ? options.decode(response) : response;
      }
      assert.equal(method, "areal/conversation/list");
      const start = Number(params.cursor ?? 0);
      const response = {
        data: rows.slice(start, start + 100),
        nextCursor: start + 100 < rows.length ? String(start + 100) : null,
      };
      return options?.decode ? options.decode(response) : response;
    },
  });
  let cacheHome;
  let library = {
    value: {},
    recordThreadSummaries: async () => {
      writes++;
      summaryWrites++;
    },
    recordThreadActivity: async () => activityUpdates++,
  };
  if (productionCache) {
    const { CoreLibrary } = require("../app/src/core/library.cjs");
    const { CoreBackend } = require("../app/src/core/backend.cjs");
    cacheHome = await mkdtemp(join(tmpdir(), "areal-catalog-cache-"));
    const backend = {
      home: cacheHome,
      saves: new Map(),
      saved: [{ id: project.id }],
      onChange() {},
    };
    backend.save = (name, value) => {
      writes++;
      return CoreBackend.prototype.save.call(backend, name, value);
    };
    library = new CoreLibrary(backend);
    await library.recordThreadSummaries(project.id, rows);
    writes = 0;
    const summaries = library.recordThreadSummaries.bind(library);
    const activity = library.recordThreadActivity.bind(library);
    library.recordThreadSummaries = (...args) => {
      summaryWrites++;
      return summaries(...args);
    };
    library.recordThreadActivity = (...args) => {
      activityUpdates++;
      return activity(...args);
    };
  }
  const observation = new HistoryObservation({
    currentConnection: (p, c) => p.client === c,
    library,
    worktrees: { observeProject: async () => {} },
    analytics: { observe() {} },
    notifications: { observe() {} },
    providers: { requestReconciliation() {} },
    scheduleReconciliation() {},
    onChange() {},
  });
  const start = performance.now();
  if (operation === "full") {
    await Promise.all(Array.from({ length: 20 }, () => observation.listThreads(project)));
  } else {
    for (let index = 0; index < 20; index++) {
      observation.notification(project, client, index % 2 ? "turn/completed" : "turn/started", {
        threadId: rows[0].id,
        turn: { id: `turn-${index}` },
      });
    }
    await (project.summaryRead?.promise ?? project.summaryReads);
  }
  await library.writes;
  const elapsedMs = performance.now() - start;
  assert.equal(project.summaries.length, rows.length);
  let cacheBytes;
  if (cacheHome) {
    const contents = await readFile(join(cacheHome, "library.json"));
    cacheBytes = contents.length;
    const saved = JSON.parse(contents);
    assert.deepEqual(
      saved.projects[project.id].navigationSummaries.map((row) => row.id),
      project.summaries.map((row) => row.id),
    );
    if (operation === "notifications") {
      assert.equal(saved.threads[`${project.id}:${rows[0].id}`].completionId, "turn-19");
      assert.equal(saved.threads[`${project.id}:${rows[0].id}`].unread, true);
    }
    await rm(cacheHome, { recursive: true });
  }
  return {
    requests,
    writes,
    summaryWrites,
    activityUpdates,
    elapsedMs,
    cacheBytes,
    rows: project.summaries.length,
  };
}

(async () => {
  const cases = [];
  for (const operation of ["full", "notifications"]) {
    const samples = [];
    for (let index = 0; index < 5; index++) samples.push(await sample(operation));
    cases.push({ operation, samples });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        phase: process.env.AREAL_CATALOG_PERF_PHASE ?? "candidate",
        scope: productionCache
          ? "Production coordinator + CoreLibrary + CoreBackend.save; real cache IO, fixture Core transport; no UI rendering"
          : "Production history coordinator; fixture transport and cache, no real network or disk IO",
        threads: rows.length,
        burst: 20,
        cases,
      },
      null,
      2,
    )}\n`,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
