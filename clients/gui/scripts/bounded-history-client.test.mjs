import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";
import { createHash } from "node:crypto";
import { CoreClient } from "../packages/runtime-client/core.js";
const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { WorktreeAdmission } = require("../app/src/core/worktree-admission.cjs");
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
const { workspaceCommand } = require("../app/src/core/workspace.cjs");
const {
  readObservationResult,
  readThreadMetadata,
} = require("../packages/workbench/client/desktop-contract/conversation-history.cjs");
const { readThreadList } = require("../app/src/core/history-contract.cjs");

test("CLI naming configuration is readable without widening desktop create input", () => {
  for (const automaticSessionName of [false, true, null]) {
    const thread = {
      id: "cli-thread",
      turns: [],
      desktop: { configuration: { options: { automaticSessionName } } },
    };
    assert.deepEqual(readThreadList({ data: [thread] }).data, [thread]);
  }
  assert.throws(() =>
    readThreadList({
      data: [
        {
          id: "cli-thread",
          desktop: { configuration: { options: { automaticSessionName: "false" } } },
        },
      ],
    }),
  );
  assert.throws(
    () =>
      validateCommand("create", {
        projectId: "project",
        text: "hello",
        options: { automaticSessionName: false },
      }),
    { code: "INVALID_DESKTOP_REQUEST" },
  );
});

const item = (id, text = id) => ({ id, type: "agentMessage", text });
const turn = (id, items, status = "completed") => ({ id, items, status });
const entry = (turnId, value) => ({
  sourceThreadId: "thread",
  sourceTurnId: turnId,
  sourceItemId: value.id,
  sourceTurnStatus: "completed",
  turn: { id: turnId, status: "completed" },
  item: value,
});
const baseline = (archived = false) => ({
  thread: {
    id: "thread",
    status: { type: "idle" },
    turns: [turn("t1", []), turn("t2", [item("i2")])],
    desktop: {
      archived,
      configuration: { revision: 1 },
      queue: { revision: 1, items: [] },
      interactions: [],
      interactionRevision: 1,
    },
  },
  history: { snapshotId: "snapshot", nextCursor: "older", complete: false },
});

test("history reads accept the Core automatic session name option without accepting malformed options", () => {
  for (const automaticSessionName of [true, false, null]) {
    const response = baseline();
    response.thread.desktop.configuration.options = { automaticSessionName };
    assert.equal(readObservationResult(response), response);
    assert.equal(readThreadMetadata(response).thread, response.thread);
  }
  for (const options of [
    { automaticSessionName: "false" },
    { automaticSessionName: false, unsupported: true },
  ]) {
    const response = baseline();
    response.thread.desktop.configuration.options = options;
    assert.throws(() => readObservationResult(response), { code: "HISTORY_VIEW_UNAVAILABLE" });
    assert.throws(() => readThreadMetadata(response), { code: "HISTORY_VIEW_UNAVAILABLE" });
  }
});
function fixture(
  read,
  {
    archived = false,
    bounded = true,
    afterResult = () => {},
    inspection = { configuration: { revision: 1 } },
  } = {},
) {
  const calls = [];
  const project = {
    id: "project",
    model: new CoreTaskModel(),
    configurations: {},
    summaries: [{ id: "thread", desktop: { archived } }],
    connectionGeneration: 1,
  };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    projects: new Map([["project", project]]),
    starting: new Map(),
    worktrees: { assertAvailable() {}, records: new Map() },
    onChange() {},
    library: { recordThreadActivity: async () => {} },
    providers: { redact: (value) => value },
    lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
    start: async () => project,
  });
  backend.worktreeAdmission = new WorktreeAdmission(backend);
  project.client = {
    ready: true,
    closed: false,
    capabilities: {
      methods: ["areal/thread/observe", "areal/conversation/history", "areal/subscription/remove"],
      features: { boundedObservation: bounded, boundedHistory: bounded },
    },
    request: async (method, params, options) => {
      calls.push({ method, params, maxResponseBytes: options?.maxResponseBytes });
      const value =
        method === "areal/interaction/list"
          ? { revision: 1, data: [] }
          : method === "areal/thread/inspect"
            ? inspection
            : method === "areal/queue/list"
              ? { revision: 1, items: [] }
              : await read(method, params, options);
      options?.onResult?.(value);
      afterResult(method, value);
      return value;
    },
  };
  const history = (operation, extra = {}) =>
    backend.executeCommand("history", {
      projectId: "project",
      threadId: "thread",
      viewId: "view-a",
      operation,
      ...extra,
    });
  return { backend, project, calls, history };
}

function anchorFixture(count = 12, intercept = async () => {}) {
  return fixture(async (method, params) => {
    if (method === "areal/thread/observe") return baseline();
    await intercept(params);
    const n = params.cursor === "older" ? 0 : Number(params.cursor.slice(5));
    return page([entry("old", item(`anchor-${n}`))], n + 1 < count ? `page:${n + 1}` : null);
  });
}
const target = (n) => ({ turnId: "old", itemId: `anchor-${n}` });

test("late loadOlder deduplicates a cursor committed by ensureAnchor without reversing the frontier", async () => {
  let finish;
  let reads = 0;
  const f = anchorFixture(12, async () => {
    if (++reads === 1)
      await new Promise((resolve) => {
        finish = resolve;
      });
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  const pending = f.history("loadOlder");
  await new Promise((resolve) => setImmediate(resolve));
  const published = [];
  f.project.model.subscribe(() => published.push(f.project.model.state.threads.thread));
  assert.equal((await f.history("ensureAnchor", { revision: 1, anchor: target(2) })).kind, "ready");
  assert.equal(published.length, 1, "one atomic body, topology and frontier publication");
  finish();
  await pending;
  const window = f.backend.historyWindow(f.project, "thread");
  assert.deepEqual(
    window.pageRecords.map((record) => record.cursor),
    ["older", "page:1", "page:2"],
  );
  assert.equal(window.nextCursor, "page:3");
  assert.deepEqual(ids(f), ["anchor-2", "anchor-1", "anchor-0", "i2"]);
});

test("loadOlder cache refusal leaves cursor and topology untouched", async () => {
  const f = anchorFixture(20);
  await f.backend.openThread(f.project, "thread");
  for (let n = 0; n < 16; n++) {
    const viewId = `pin-${n}`;
    await f.history("acquire", { viewId });
    await f.history("ensureAnchor", { viewId, revision: 1, anchor: target(n) });
  }
  const window = f.backend.historyWindow(f.project, "thread");
  const before = JSON.stringify({
    cursor: window.nextCursor,
    records: window.pageRecords,
    ids: ids(f),
  });
  await assert.rejects(f.history("loadOlder", { viewId: "pin-0" }), /占用/);
  assert.equal(
    JSON.stringify({ cursor: window.nextCursor, records: window.pageRecords, ids: ids(f) }),
    before,
  );
});

test("partial replacement retains stale pinned bodies and counts their cache slots", async () => {
  let observed = 0;
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") {
      observed++;
      return baseline();
    }
    if (observed === 1)
      return page([entry("old", item("a", "pinned body")), entry("old", item("b"))], null);
    return params.cursor === "older"
      ? page([entry("old", item("b", "fresh b"))], "a-page")
      : page([entry("old", item("a", "fresh a"))], null);
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("acquire", { viewId: "view-b" });
  await f.history("ensureAnchor", { revision: 1, anchor: { turnId: "old", itemId: "a" } });
  await f.backend.openThread(f.project, "thread");
  await f.history("loadOlder", { viewId: "view-b" });
  const window = f.backend.historyWindow(f.project, "thread");
  assert.deepEqual(ids(f), ["a", "b", "i2"]);
  assert.equal(window.stalePages.length + window.pages.length, 2);
  assert.equal(window.stalePages[0].data[0].item.text, "pinned body");
  assert.deepEqual(
    window.stalePages[0].data.map((entry) => entry.sourceItemId),
    ["a"],
  );
  assert.equal(
    (await f.history("ensureAnchor", { revision: 2, anchor: { turnId: "old", itemId: "a" } })).kind,
    "ready",
  );
  assert.equal(window.stalePages.length, 0);
  assert.equal(f.project.model.state.threads.thread.turns[0].items[0].text, "fresh a");
});

test("reobserve keeps same-turn multi-pin chronological order", async () => {
  const f = anchorFixture();
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("acquire", { viewId: "view-b" });
  await f.history("ensureAnchor", { revision: 1, anchor: target(0) });
  await f.history("ensureAnchor", { viewId: "view-b", revision: 1, anchor: target(6) });
  await f.backend.openThread(f.project, "thread");
  assert.deepEqual(ids(f), ["anchor-6", "anchor-0", "i2"]);
});

test("reobserve treats a pinned item in the fresh baseline as authoritative", async () => {
  for (const complete of [false, true]) {
    let observations = 0;
    const f = fixture(async (method) => {
      if (method === "areal/thread/observe") {
        if (++observations === 1) return baseline();
        return {
          ...baseline(),
          thread: {
            ...baseline().thread,
            turns: [turn("old", [item("a", "fresh baseline")]), turn("t2", [item("i2")])],
          },
          history: { snapshotId: "snapshot", nextCursor: complete ? null : "older", complete },
        };
      }
      return page([entry("old", item("a", "old page"))], null);
    });
    const anchor = { turnId: "old", itemId: "a" };
    await f.backend.openThread(f.project, "thread");
    await f.history("acquire");
    assert.equal((await f.history("ensureAnchor", { revision: 1, anchor })).kind, "ready");
    await f.backend.openThread(f.project, "thread");
    const reads = f.calls.filter((call) => call.method === "areal/conversation/history").length;
    assert.equal((await f.history("ensureAnchor", { revision: 2, anchor })).kind, "ready");
    assert.equal(
      f.calls.filter((call) => call.method === "areal/conversation/history").length,
      reads,
    );
    assert.equal(f.project.model.state.threads.thread.turns[0].items[0].text, "fresh baseline");
    await f.history("release");
    assert.deepEqual(ids(f), ["a", "i2"]);
  }
});

test("stale ensureAnchor refreshes observation and explicit retry uses the fresh cursor", async () => {
  let observations = 0;
  const cursors = [];
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") {
      observations++;
      return {
        ...baseline(),
        history: { ...baseline().history, nextCursor: observations === 1 ? "older" : "fresh" },
      };
    }
    cursors.push(params.cursor);
    if (params.cursor === "older")
      throw Object.assign(new Error("edited"), { reason: "HISTORY_CURSOR_STALE" });
    return page([entry("old", item("anchor-0"))], null);
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  assert.notEqual(
    (await f.history("ensureAnchor", { revision: 1, anchor: target(0) })).kind,
    "ready",
  );
  assert.equal(observations, 2);
  assert.deepEqual(cursors, ["older"]);
  assert.equal((await f.history("ensureAnchor", { revision: 2, anchor: target(0) })).kind, "ready");
  assert.deepEqual(cursors, ["older", "fresh"]);
});

test("page topology stays bounded while pinned bodies and evicted cursors remain readable", async () => {
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") return baseline();
    const n = params.cursor === "older" ? 0 : Number(params.cursor.slice(5));
    return page(
      Array.from({ length: 32 }, (_, i) => entry("old", item(`${n}-${i}`))),
      n < 59 ? `page:${n + 1}` : null,
    );
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("loadOlder");
  await f.history("retain", { revision: 1, anchor: { turnId: "old", itemId: "0-0" } });
  for (let n = 1; n < 60; n++) await f.history("loadOlder");
  const window = f.backend.historyWindow(f.project, "thread");
  const history = f.project.model.state.threads.thread.displayHistory;
  assert.ok(Buffer.byteLength(JSON.stringify(history.pageTopology)) <= 64 * 1024);
  assert.ok(window.pages.length + window.stalePages.length <= 16);
  assert.ok(
    history.pageTopology.some((record) => record.items.some((item) => item.itemId === "0-0")),
  );
  const evicted = window.pageRecords.find((record) => record.cursor === "page:10");
  assert.equal(evicted.items.length, 0);
  assert.ok(history.gaps.some((gap) => gap.topologyKnown === false));
  await f.history("loadOlder", { pageId: evicted.id });
  assert.ok(ids(f).includes("10-0") && ids(f).includes("0-0"));
  const restored = await f.history("ensureAnchor", {
    revision: 2,
    anchor: { turnId: "old", itemId: "11-0" },
  });
  assert.equal(restored.kind, "ready");
  assert.ok(ids(f).includes("11-0"));
  assert.ok(window.pageRecords.find((record) => record.cursor === "page:11").items.length);
});

test("missing one stale pin preserves another pin from the same former page", async () => {
  let observations = 0;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") {
      observations++;
      return baseline();
    }
    return page(
      observations === 1
        ? [entry("old", item("a")), entry("old", item("b"))]
        : [entry("old", item("b"))],
      null,
    );
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("acquire", { viewId: "view-b" });
  await f.history("ensureAnchor", { revision: 1, anchor: { turnId: "old", itemId: "a" } });
  await f.history("retain", {
    viewId: "view-b",
    revision: 1,
    anchor: { turnId: "old", itemId: "b" },
  });
  await f.backend.openThread(f.project, "thread");
  assert.equal(
    (await f.history("ensureAnchor", { revision: 2, anchor: { turnId: "old", itemId: "a" } })).kind,
    "missing",
  );
  assert.deepEqual(ids(f), ["b", "i2"]);
  assert.equal(f.backend.historyWindow(f.project, "thread").stalePages.length, 1);
});

test("concurrent anchor scans merge page identity and keep both targets pinned", async () => {
  const f = anchorFixture();
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("acquire", { viewId: "view-b" });
  const results = await Promise.all([
    f.history("ensureAnchor", { revision: 1, anchor: target(3) }),
    f.history("ensureAnchor", { viewId: "view-b", revision: 1, anchor: target(8) }),
  ]);
  assert.ok(results.every((result) => result.kind === "ready"));
  const window = f.backend.historyWindow(f.project, "thread");
  assert.equal(
    new Set(window.pageRecords.map((record) => record.cursor)).size,
    window.pageRecords.length,
  );
  assert.ok(ids(f).includes("anchor-3") && ids(f).includes("anchor-8"));
  assert.ok(
    window.pages.every((page) => window.pageRecords.some((record) => record.id === page.pageId)),
  );
  for (let index = 0; index < 4; index++) await f.history("loadOlder");
  assert.ok(ids(f).includes("anchor-3") && ids(f).includes("anchor-8"));
});

test("ensureAnchor restores beyond four pages atomically and preserves live output", async () => {
  const f = anchorFixture();
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  const published = [];
  f.project.model.subscribe(() => published.push(f.project.model.state.threads.thread));
  const result = await f.history("ensureAnchor", { revision: 1, anchor: target(8) });
  assert.equal(result.kind, "ready");
  assert.ok(ids(f).includes("anchor-8"));
  assert.ok(ids(f).includes("i2"));
  assert.ok(f.backend.historyWindow(f.project, "thread").pages.length <= 4);
  assert.ok(
    published.every(
      (thread) =>
        !thread.turns.some((t) => t.items.some((i) => i.id.startsWith("anchor-"))) ||
        thread.turns.some((t) => t.items.some((i) => i.id === "anchor-8")),
    ),
  );
});

test("two view pins survive paging and releasing one view frees only its pin", async () => {
  const f = anchorFixture();
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("acquire", { viewId: "view-b" });
  await f.history("ensureAnchor", { revision: 1, anchor: target(0) });
  await f.history("ensureAnchor", { viewId: "view-b", revision: 1, anchor: target(6) });
  for (let n = 0; n < 4; n++) await f.history("loadOlder");
  assert.ok(ids(f).includes("anchor-0"));
  assert.ok(ids(f).includes("anchor-6"));
  await f.history("release");
  assert.ok(ids(f).includes("anchor-6"));
  await f.history("release", { viewId: "view-b" });
  assert.deepEqual(ids(f), ["i2"]);
});

test("full pinned cache returns limited without evicting a reader or exceeding sixteen pages", async () => {
  const f = anchorFixture(20);
  await f.backend.openThread(f.project, "thread");
  for (let n = 0; n < 17; n++) {
    const viewId = `view-${n}`;
    await f.history("acquire", { viewId });
    const result = await f.history("ensureAnchor", { viewId, revision: 1, anchor: target(n) });
    assert.equal(result.kind, n === 16 ? "limited" : "ready");
  }
  assert.equal(f.backend.historyWindow(f.project, "thread").pages.length, 16);
  for (let n = 0; n < 16; n++) assert.ok(ids(f).includes(`anchor-${n}`));
});

test("new intent and generation cancel late anchor reads without publication", async () => {
  for (const replace of [false, true]) {
    let finish;
    const f = anchorFixture(
      12,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.backend.openThread(f.project, "thread");
    await f.history("acquire");
    const pending = f.history("ensureAnchor", { revision: 1, anchor: target(8) });
    await Promise.race([pending, new Promise((resolve) => setImmediate(resolve))]);
    assert.equal(typeof finish, "function");
    if (replace) await f.backend.openThread(f.project, "thread");
    else await f.history("retain", { revision: 2, anchor: null });
    finish();
    assert.equal((await pending).kind, "cancelled");
    assert.deepEqual(ids(f), ["i2"]);
  }
});

test("missing, bounded scan limit and legacy Core are explicit anchor outcomes", async () => {
  for (const [count, kind] of [
    [2, "missing"],
    [40, "limited"],
  ]) {
    const f = anchorFixture(count);
    await f.backend.openThread(f.project, "thread");
    await f.history("acquire");
    assert.equal((await f.history("ensureAnchor", { revision: 1, anchor: target(99) })).kind, kind);
    assert.ok(f.calls.filter((call) => call.method === "areal/conversation/history").length <= 32);
    assert.deepEqual(ids(f), ["i2"]);
  }
  const f = fixture(async () => ({ thread: baseline().thread }), { bounded: false });
  assert.equal(
    (await f.history("ensureAnchor", { revision: 1, anchor: target(0) })).supported,
    false,
  );
});

test("reobserve keeps only pinned snapshots until a fresh cursor confirms or misses the target", async () => {
  let removed = false;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe")
      return {
        ...baseline(),
        history: {
          snapshotId: removed ? "new" : "snapshot",
          nextCursor: removed ? "fresh" : "older",
          complete: false,
        },
      };
    return {
      ...page(
        removed ? [entry("old", item("replacement"))] : [entry("old", item("anchor-0"))],
        null,
      ),
      snapshotId: removed ? "new" : "snapshot",
    };
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("ensureAnchor", { revision: 1, anchor: target(0) });
  removed = true;
  await f.backend.openThread(f.project, "thread");
  assert.ok(ids(f).includes("anchor-0"));
  const result = await f.history("ensureAnchor", { revision: 2, anchor: target(0) });
  assert.equal(result.kind, "missing");
  assert.equal(f.calls.at(-1).params.cursor, "fresh");
  assert.ok(!ids(f).includes("anchor-0"));
});

test("deferred anchor and byte budget never report ready without authoritative body", async () => {
  for (const oversized of [false, true]) {
    const f = fixture(async (method) =>
      method === "areal/thread/observe"
        ? baseline()
        : page(
            [
              entry(
                "old",
                oversized
                  ? item("anchor-0", "x".repeat(8 * 1024 * 1024))
                  : {
                      id: "anchor-0",
                      type: "historyDeferred",
                      cursor: "body",
                      version: "v1",
                      totalBytes: 9000000,
                    },
              ),
            ],
            null,
          ),
    );
    await f.backend.openThread(f.project, "thread");
    await f.history("acquire");
    const result = await f.history("ensureAnchor", { revision: 1, anchor: target(0) });
    assert.equal(result.kind, "limited");
    assert.equal(result.reason, oversized ? "scanBudget" : "deferred");
    assert.deepEqual(ids(f), ["i2"]);
  }
});

test("history capability is a validated read with an explicit view owner", () => {
  assert.equal(commandSemantics("history", { operation: "loadOlder" }).effect, "read");
  validateCommand("history", { projectId: "p", threadId: "t", viewId: "v", operation: "acquire" });
  for (const extra of [
    { viewId: "" },
    { operation: "execute" },
    { maxBytes: 2 ** 21 },
    { cursor: "unowned-cursor" },
  ])
    assert.throws(() =>
      validateCommand("history", {
        projectId: "p",
        threadId: "t",
        viewId: "v",
        operation: "loadOlder",
        ...extra,
      }),
    );
});

test("completing more live history re-bounds a view even after an explicit old item was loaded", async () => {
  const f = fixture(async () => baseline());
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  const window = f.backend.historyWindow(f.project, "thread");
  window.loaded.set("i2", { bytes: 2000000, placeholder: { id: "i2", type: "historyDeferred" } });
  f.project.model.replace({
    ...baseline().thread,
    turns: [turn("t2", [item("i2", "x".repeat(2000000))])],
  });
  f.project.client.close = () => {};
  const request = f.project.client.request,
    originalConnect = CoreClient.prototype.connect;
  Object.assign(f.backend, {
    stopReconciliation() {},
    scheduleReconciliation() {},
    listThreads: async () => {},
    analytics: { observe() {} },
    notifications: { observe() {} },
    library: { value: {}, recordThreadActivity: async () => {} },
    providers: { ...f.backend.providers, requestReconciliation() {} },
  });
  CoreClient.prototype.connect = async () => {
    throw new Error("fixture stops before transport");
  };
  try {
    await assert.rejects(f.backend.connect(f.project), /fixture stops/);
  } finally {
    CoreClient.prototype.connect = originalConnect;
  }
  const client = f.project.client;
  Object.assign(client, {
    ready: true,
    capabilities: {
      methods: ["areal/thread/observe"],
      features: { boundedObservation: true, boundedHistory: true },
    },
    request,
  });
  for (const notify of client.listeners)
    notify("turn/completed", {
      threadId: "thread",
      turn: turn("next", [item("next", "y".repeat(2000000))]),
    });
  await new Promise((resolve) => setImmediate(resolve));
  await f.project.observationReads?.get("thread")?.promise;
  assert.ok(
    Buffer.byteLength(JSON.stringify(f.project.model.state.threads.thread)) < 1048576,
    "completed live history cannot bypass the bound because another item was loaded",
  );
  assert.equal(
    f.backend.historyWindow(f.project, "thread").loaded.size,
    0,
    "refresh returns explicit content to the Core-owned read window",
  );
});

test("a requested loaded tool can be reviewed while an unrelated tool remains deferred", async () => {
  const f = fixture(async () => baseline());
  f.backend.saved = [{ id: "project", root: "/fixture" }];
  f.project.model.replace({
    ...baseline().thread,
    turns: [
      turn("t2", [
        {
          id: "loaded",
          type: "dynamicToolCall",
          tool: "fs_create",
          status: "completed",
          success: true,
          execution: { backend: "runtime", outcome: "succeeded" },
          arguments: { path: "workspace://repo/test.txt", text: "hello" },
          contentItems: [
            {
              type: "text",
              text: JSON.stringify({
                path: "workspace://repo/test.txt",
                size: 5,
                sha256: createHash("sha256").update("hello").digest("hex"),
              }),
            },
          ],
        },
        { id: "other", type: "historyDeferred", originalType: "dynamicToolCall" },
      ]),
    ],
  });
  const request = {
    operation: "turnReview",
    projectId: "project",
    threadId: "thread",
    turnId: "t2",
  };
  assert.equal(
    (await workspaceCommand(f.backend, { ...request, itemId: "loaded" })).files[0].afterText,
    "hello",
  );
  await assert.rejects(workspaceCommand(f.backend, request), /完整工具内容/);
});

test("conversation reading mode is negotiated only when Core advertises it", async () => {
  for (const supported of [false, true]) {
    const f = fixture(async (method, params) => {
      assert.equal(method, "areal/thread/observe");
      assert.equal(params.mode, supported ? "conversation" : "bounded");
      return baseline();
    });
    f.project.client.capabilities.features.conversationObservation = supported;
    await f.backend.openThread(f.project, "thread");
  }
});

for (const archived of [false, true])
  test(`bounded baseline is negotiated before synchronous install (archived=${archived})`, async () => {
    const f = fixture(
      async (method, params) => {
        assert.equal(method, "areal/thread/observe");
        assert.equal(params.mode, "bounded");
        assert.ok(params.maxBytes <= 1048576);
        return baseline(archived);
      },
      {
        archived,
        afterResult(method) {
          if (method !== "areal/thread/observe") return;
          f.project.model.event("turn/started", {
            threadId: "thread",
            turn: turn("t3", [], "inProgress"),
          });
          f.project.model.event("item/agentMessage/delta", {
            threadId: "thread",
            turnId: "t3",
            itemId: "i3",
            delta: "live",
          });
        },
      },
    );
    await f.backend.openThread(f.project, "thread");
    assert.equal(f.project.model.state.threads.thread.turns.at(-1).items[0].text, "live");
    assert.equal(
      f.calls.some((call) => call.method === "thread/read"),
      false,
    );
  });

test("older own page merges by IDs without overwriting a live delta", async () => {
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") return baseline();
    assert.equal(method, "areal/conversation/history");
    assert.equal(params.view, "own");
    f.project.model.event("item/agentMessage/delta", {
      threadId: "thread",
      turnId: "t2",
      itemId: "i2",
      delta: ":new",
    });
    return {
      snapshotId: "snapshot",
      data: [entry("t1", item("i0")), entry("t1", item("i1"))],
      nextCursor: null,
      complete: true,
    };
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("loadOlder");
  assert.deepEqual(
    f.project.model.state.threads.thread.turns.flatMap((t) => t.items.map((i) => i.id)),
    ["i0", "i1", "i2"],
  );
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items[0].text, "i2:new");
});

test("explicit item loading validates UTF8 fragments and release does not discard another view", async () => {
  const value = entry("t2", item("i2", '雪\\\"🙂'.repeat(90000)));
  const bytes = Buffer.from(JSON.stringify(value));
  let offset = 0,
    reads = 0;
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") {
      const result = baseline();
      result.thread.turns.at(-1).items = [
        {
          type: "historyDeferred",
          id: "i2",
          originalType: "agentMessage",
          version: "v1",
          cursor: "item:0",
          totalBytes: bytes.length,
        },
      ];
      return result;
    }
    assert.equal(method, "areal/conversation/history");
    assert.equal(
      params.maxBytes,
      1048576,
      "explicit content uses the negotiated maximum fragment budget",
    );
    reads++;
    let end = Math.min(offset + 20000, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const text = bytes.subarray(offset, end).toString();
    const fragment = { version: "v1", offsetUtf8: offset, totalBytes: bytes.length, text };
    offset = end;
    return {
      snapshotId: "snapshot",
      data: [{ sourceThreadId: "thread", sourceTurnId: "t2", sourceItemId: "i2", fragment }],
      nextCursor: offset < bytes.length ? `item:${offset}` : null,
      complete: offset === bytes.length,
    };
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("acquire", { viewId: "view-b" });
  assert.equal(reads, 0, "opening a view must not eagerly materialize huge content");
  await f.history("loadItem", { itemId: "i2" });
  assert.deepEqual(f.project.model.state.threads.thread.turns.at(-1).items[0], value.item);
  await f.history("release");
  assert.equal(
    f.calls.some((call) => call.method === "areal/subscription/remove"),
    false,
  );
  assert.deepEqual(f.project.model.state.threads.thread.turns.at(-1).items[0], value.item);
  await f.history("release", { viewId: "view-b" });
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items[0].type, "historyDeferred");
});

test("basic conversation remains published while a tool detail read is blocked", async () => {
  const tool = { id: "tool", type: "dynamicToolCall", tool: "shell", status: "completed" };
  const complete = entry("ordinary", tool);
  const serialized = JSON.stringify(complete);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const deferred = {
    id: "tool",
    type: "historyDeferred",
    originalType: "dynamicToolCall",
    cursor: "detail",
    version: "v1",
    totalBytes: Buffer.byteLength(serialized),
  };
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") {
      const value = baseline();
      value.thread.turns = [
        turn("ordinary", [
          { id: "prompt", type: "userMessage", content: [{ type: "text", text: "question" }] },
          deferred,
          item("reply", "answer"),
        ]),
      ];
      value.history = { snapshotId: "snapshot", nextCursor: null, complete: true };
      return value;
    }
    await gate;
    return {
      snapshotId: "snapshot",
      complete: true,
      nextCursor: null,
      data: [
        {
          sourceThreadId: "thread",
          sourceTurnId: "ordinary",
          sourceItemId: "tool",
          sourceTurnStatus: "completed",
          fragment: {
            text: serialized,
            offsetUtf8: 0,
            nextOffsetUtf8: Buffer.byteLength(serialized),
            totalBytes: Buffer.byteLength(serialized),
            version: "v1",
          },
        },
      ],
    };
  });
  f.project.client.capabilities.features.conversationObservation = true;
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  assert.equal(f.calls.length, 1, "basic reading does not fetch tool details");
  const detail = f.history("loadItem", { itemId: "tool" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ids(f), ["prompt", "tool", "reply"]);
  assert.deepEqual(f.project.model.state.threads.thread.turns[0].items[1], deferred);
  release();
  await detail;
  assert.deepEqual(ids(f), ["prompt", "tool", "reply"]);
  assert.equal(f.project.model.state.threads.thread.turns[0].items[1].type, "dynamicToolCall");
});

test("ordinary observation uses the supported maximum budget on its first request", async () => {
  const f = fixture(async (method, params, options) => {
    assert.equal(method, "areal/thread/observe");
    assert.equal(params.maxBytes, 1048576);
    assert.equal(options.maxResponseBytes, 1048576);
    const value = baseline();
    value.thread.turns = [turn("ordinary", [item("user-sized", "x".repeat(300000))])];
    value.history = { snapshotId: "snapshot", nextCursor: null, complete: true };
    return value;
  });
  await f.backend.openThread(f.project, "thread");
  assert.equal(f.calls.length, 1);
  assert.equal(f.project.model.state.threads.thread.turns[0].items[0].text.length, 300000);
});

test("metadata exceeding the supported maximum fails without repeating the observation", async () => {
  let observations = 0;
  const f = fixture(async (method, params) => {
    assert.equal(method, "areal/thread/observe");
    observations++;
    assert.equal(params.maxBytes, 1048576);
    throw Object.assign(new Error("metadata too large"), {
      code: -32012,
      reason: "HISTORY_BUDGET_TOO_SMALL",
      recovery: { kind: "none" },
    });
  });
  await assert.rejects(f.backend.openThread(f.project, "thread"), /metadata too large/);
  assert.equal(observations, 1);
});

test("stale old page resets its display window without retrying a mutation", async () => {
  let observations = 0;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") {
      observations++;
      const value = baseline();
      if (observations > 1) {
        value.thread.turns = [turn("edited", [item("edited")])];
        value.history = { snapshotId: "edited", nextCursor: null, complete: true };
      }
      return value;
    }
    assert.equal(method, "areal/conversation/history");
    throw Object.assign(new Error("history edited"), {
      code: -32012,
      reason: "HISTORY_CURSOR_STALE",
      data: { reset: true, reason: "HISTORY_CURSOR_STALE" },
    });
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("loadOlder").catch(() => {});
  assert.deepEqual(
    f.project.model.state.threads.thread.turns.flatMap((t) => t.items.map((i) => i.id)),
    ["edited"],
  );
  assert.equal(
    f.calls.some((call) => /submit|start|steer/.test(call.method)),
    false,
  );
});

test("changed item restarts once and never mixes two serialized versions", async () => {
  const value = entry("t2", item("i2", "新版本🙂"));
  const json = JSON.stringify(value);
  let reads = 0;
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") {
      const result = baseline();
      result.thread.turns.at(-1).items = [
        {
          type: "historyDeferred",
          id: "i2",
          originalType: "agentMessage",
          version: "old",
          cursor: "old:0",
          totalBytes: 1000,
        },
      ];
      return result;
    }
    reads++;
    if (reads === 1)
      throw Object.assign(new Error("changed"), {
        code: -32012,
        reason: "HISTORY_ITEM_CHANGED",
        data: { restartCursor: "new:0", reason: "HISTORY_ITEM_CHANGED" },
      });
    assert.equal(params.cursor, "new:0");
    return {
      snapshotId: "snapshot",
      data: [
        {
          sourceThreadId: "thread",
          sourceTurnId: "t2",
          sourceItemId: "i2",
          fragment: {
            offsetUtf8: 0,
            version: "new",
            totalBytes: Buffer.byteLength(json),
            text: json,
          },
        },
      ],
      complete: true,
      nextCursor: null,
    };
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  await f.history("loadItem", { itemId: "i2" });
  assert.equal(reads, 2);
  assert.deepEqual(f.project.model.state.threads.thread.turns.at(-1).items[0], value.item);
});

test("ordinary history keeps loaded prompts and replies resident on return visits", async () => {
  let reads = 0;
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") return baseline();
    const n = params.cursor === "older" ? 0 : Number(params.cursor.slice(5));
    reads++;
    return page(
      [
        entry(`turn-${n}`, {
          id: `user-${n}`,
          type: "userMessage",
          content: [{ type: "text", text: `Question ${n}` }],
        }),
        entry(`turn-${n}`, item(`answer-${n}`)),
      ],
      n < 11 ? `page:${n + 1}` : null,
    );
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  for (let n = 0; n < 12; n++) await f.history("loadOlder");
  for (const [index, n] of [0, 11, 1, 10, 5, 0].entries()) {
    const result = await f.history("ensureAnchor", {
      revision: index + 1,
      anchor: { turnId: `turn-${n}`, itemId: `user-${n}` },
    });
    assert.equal(result.kind, "ready");
  }
  assert.equal(reads, 12, "returning to loaded messages does not fetch them again");
  const thread = f.project.model.state.threads.thread;
  assert.equal(thread.displayHistory.omitted, false);
  assert.deepEqual(thread.displayHistory.gaps, []);
  for (let n = 0; n < 12; n++) {
    assert.ok(ids(f).includes(`user-${n}`));
    assert.ok(ids(f).includes(`answer-${n}`));
  }
});

test("retained old-page window stays finite and reports its omitted interval", async () => {
  let reads = 0;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") return baseline();
    reads++;
    return {
      snapshotId: "snapshot",
      data: [entry(`old-${reads}`, item(`old-${reads}`, "x".repeat(100000)))],
      nextCursor: `page:${reads}`,
      complete: false,
    };
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  for (let n = 0; n < 20; n++) await f.history("loadOlder");
  const thread = f.project.model.state.threads.thread;
  assert.ok(Buffer.byteLength(JSON.stringify(thread)) < 17 * 262144);
  assert.equal(thread.displayHistory.omitted, true);
  assert.equal(thread.turns.at(-1).items[0].id, "i2", "latest live window remains visible");
  await f.history("release");
  assert.deepEqual(
    f.project.model.state.threads.thread.turns.flatMap((t) => t.items.map((i) => i.id)),
    ["i2"],
  );
});

// Failure modes: restoring an evicted page must use its original cursor, keep
// chronological order, and retain only sixteen page bodies, including same-turn pages.
test("evicted pages can be revisited in both directions without losing the live tail", async () => {
  const cursors = [];
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") return baseline();
    cursors.push(params.cursor);
    const n = params.cursor === "older" ? 0 : Number(params.cursor.slice(5));
    return {
      snapshotId: "snapshot",
      data: [entry("shared", item(`page-item-${n}`))],
      nextCursor: n === 19 ? null : `page:${n + 1}`,
      complete: n === 19,
    };
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  for (let n = 0; n < 20; n++) await f.history("loadOlder");
  const state = () => f.project.model.state.threads.thread;
  assert.ok(state().displayHistory.gaps.length);
  const gap = state().displayHistory.gaps[0];
  await f.history("loadOlder", { pageId: gap.id });
  assert.equal(cursors.at(-1), "page:3");
  for (let n = 0; n < 3; n++) {
    const gap = state().displayHistory.gaps.find((gap) => gap.beforeItemId === "i2");
    await f.history("loadOlder", { pageId: gap.id });
  }
  assert.ok(
    state()
      .turns.flatMap((t) => t.items)
      .some((i) => i.id === "page-item-0"),
  );
  await f.history("loadOlder");
  assert.equal(
    cursors.at(-1),
    "page:16",
    "top navigation revisits known older pages before frontier",
  );
  assert.ok(f.backend.historyWindow(f.project, "thread").pages.length <= 16);
  const values = state()
    .turns.find((t) => t.id === "shared")
    .items.map((i) => Number(i.id.slice(10)));
  assert.deepEqual(
    values,
    [...values].sort((a, b) => b - a),
  );
  assert.equal(state().turns.at(-1).items[0].id, "i2");
  await f.history("release");
  assert.deepEqual(state().displayHistory.gaps, []);
});

const partialBaseline = () => ({
  ...baseline(),
  thread: { ...baseline().thread, turns: [turn("t2", [item("i2")], "inProgress")] },
});
const page = (data, nextCursor, complete = !nextCursor) => ({
  snapshotId: "snapshot",
  data,
  nextCursor,
  complete,
});
const ids = (f) =>
  f.project.model.state.threads.thread.turns.flatMap((value) =>
    value.items.map((value) => value.id),
  );

test("acquire restores the entire latest turn beyond four pages and pins it through eviction and release", async () => {
  let reads = 0;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") return partialBaseline();
    assert.equal(method, "areal/conversation/history");
    reads++;
    if (reads <= 6)
      return page(
        [
          entry(
            "t2",
            reads === 5
              ? {
                  id: "steer",
                  type: "userMessage",
                  content: [{ type: "inputText", text: "continue" }],
                }
              : item(`latest-${7 - reads}`),
          ),
        ],
        `latest:${reads}`,
      );
    if (reads === 7)
      return page(
        [
          entry("t1", item("spill")),
          entry("t2", {
            id: "prompt",
            type: "userMessage",
            content: [{ type: "inputText", text: "work" }],
          }),
        ],
        "old:0",
      );
    return page([entry(`old-${reads}`, item(`old-${reads}`))], `old:${reads}`);
  });
  await f.backend.openThread(f.project, "thread");
  assert.equal(
    f.calls.filter((call) => call.method === "areal/conversation/history").length,
    0,
    "baseline installation stays synchronous and bounded",
  );
  await f.history("acquire");
  assert.equal(reads, 7, "steering messages do not truncate the same turn");
  const latest = [
    "prompt",
    "latest-1",
    "steer",
    "latest-3",
    "latest-4",
    "latest-5",
    "latest-6",
    "i2",
  ];
  assert.deepEqual(
    f.project.model.state.threads.thread.turns.at(-1).items.map((value) => value.id),
    latest,
  );
  assert.equal(f.project.model.state.threads.thread.displayHistory.latestTurnComplete, true);
  for (let n = 0; n < 6; n++) await f.history("loadOlder");
  assert.deepEqual(
    f.project.model.state.threads.thread.turns.at(-1).items.map((value) => value.id),
    latest,
  );
  await f.history("release");
  assert.deepEqual(ids(f), ["spill", ...latest]);
  assert.ok(
    f.calls
      .filter((call) => call.method === "areal/conversation/history")
      .every((call) => call.params.maxBytes === 262144 && call.maxResponseBytes === 262144),
  );
  assert.equal(
    f.calls.some((call) => /submit|resume|start|steer/.test(call.method)),
    false,
  );
});

test("concurrent owners share latest hydration and retain live deltas when the first owner closes", async () => {
  let resolvePage, started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") return partialBaseline();
    started();
    return new Promise((resolve) => {
      resolvePage = resolve;
    });
  });
  await f.backend.openThread(f.project, "thread");
  const first = f.history("acquire");
  await reading;
  const second = f.history("acquire", { viewId: "view-b" });
  const older = f.history("loadOlder", { viewId: "view-b" });
  await f.history("release");
  f.project.model.event("item/agentMessage/delta", {
    threadId: "thread",
    turnId: "t2",
    itemId: "i2",
    delta: ":live",
  });
  resolvePage(page([entry("t2", item("i1"))], null));
  await Promise.all([first, second, older]);
  assert.deepEqual(ids(f), ["i1", "i2"]);
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items.at(-1).text, "i2:live");
  assert.equal(f.calls.filter((call) => call.method === "areal/conversation/history").length, 1);
});

test("closing the last owner cancels pending hydration and reacquiring starts a fresh owned read", async () => {
  const pending = [];
  const f = fixture(async (method) =>
    method === "areal/thread/observe"
      ? partialBaseline()
      : new Promise((resolve) => pending.push(resolve)),
  );
  await f.backend.openThread(f.project, "thread");
  const first = f.history("acquire");
  await new Promise((resolve) => setImmediate(resolve));
  await f.history("release");
  const next = f.history("acquire");
  await new Promise((resolve) => setImmediate(resolve));
  pending[0](page([entry("t2", item("discarded"))], null));
  await assert.rejects(first, (error) => error.code === "HISTORY_VIEW_UNAVAILABLE");
  assert.equal(ids(f).includes("discarded"), false);
  assert.equal(f.project.model.state.threads.thread.displayHistory.loadingLatest, true);
  pending[1](page([entry("t2", item("kept"))], null));
  await next;
  assert.deepEqual(ids(f), ["kept", "i2"]);
});

test("refresh preserves the shown latest prefix until authoritative hydration replaces it", async () => {
  let refresh = false,
    resolvePage;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") return partialBaseline();
    if (!refresh)
      return page(
        [
          entry("t1", item("spill")),
          entry("t2", {
            id: "prompt",
            type: "userMessage",
            content: [{ type: "inputText", text: "keep me visible" }],
          }),
        ],
        "old",
      );
    return new Promise((resolve) => {
      resolvePage = resolve;
    });
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  const huge = item("huge", "x".repeat(2000000));
  f.project.model.replace({
    ...f.project.model.state.threads.thread,
    turns: [turn("t2", [huge, ...f.project.model.state.threads.thread.turns.at(-1).items])],
  });
  refresh = true;
  await f.backend.openThread(f.project, "thread");
  assert.equal(ids(f).includes("prompt"), true, "context refresh does not hide the known prompt");
  await new Promise((resolve) => setImmediate(resolve));
  // 已补全的视图在重新观察时仍显示原内容：权威补全在后台进行，不在已显示的对话上方再出现恢复提示。
  assert.equal(typeof resolvePage, "function", "authoritative hydration is still requested");
  assert.equal(f.project.model.state.threads.thread.displayHistory.loadingLatest, false);
  assert.equal(f.project.model.state.threads.thread.displayHistory.latestTurnComplete, true);
  resolvePage(
    page(
      [
        entry("t1", item("spill")),
        entry("t2", { id: "huge", type: "historyDeferred", originalType: "agentMessage" }),
        entry("t2", { id: "prompt", type: "historyDeferred", originalType: "userMessage" }),
      ],
      "old",
    ),
  );
  await f.history("acquire");
  const restored = f.project.model.state.threads.thread.turns.at(-1).items;
  assert.equal(
    restored.find((item) => item.id === "prompt").type,
    "userMessage",
    "known user content survives a deferred projection",
  );
  assert.equal(
    restored.find((item) => item.id === "huge").type,
    "historyDeferred",
    "unchanged retained oversized content respects the authoritative deferred entry",
  );
  f.project.connectionGeneration++;
  f.backend.installObservation(f.project, partialBaseline());
  assert.equal(ids(f).includes("prompt"), false, "a new connection cannot revive the old prefix");
  await f.history("release");
  resolvePage?.(page([], null));
});

test("explicit anchor recovery refreshes a stale failed latest-turn registration", async () => {
  let observations = 0;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") {
      observations++;
      if (observations === 1) return partialBaseline();
      return {
        ...baseline(),
        thread: { ...baseline().thread, turns: [turn("t2", [item("edited")])] },
        history: { snapshotId: "edited", complete: true, nextCursor: null },
      };
    }
    throw Object.assign(new Error("edited"), { reason: "HISTORY_CURSOR_STALE" });
  });
  await f.backend.openThread(f.project, "thread");
  await assert.rejects(f.history("acquire"));
  await assert.rejects(f.history("acquire"));
  assert.equal(observations, 1, "registration failure cannot start automatic refresh loops");
  const restored = await f.history("ensureAnchor", {
    revision: 1,
    anchor: { turnId: "t2", itemId: "edited" },
  });
  assert.equal(restored.kind, "ready");
  assert.equal(observations, 2);
  assert.deepEqual(ids(f), ["edited"]);
});

test("a stale latest cursor stops until explicit retry and cannot resurrect the old prefix", async () => {
  let stale = false,
    observations = 0;
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") {
      observations++;
      const value = partialBaseline();
      if (stale && observations > 2) {
        value.thread.turns = [turn("t2", [item("edited")])];
        value.history = { snapshotId: "edited", complete: true, nextCursor: null };
      }
      return value;
    }
    if (!stale) return page([entry("t2", item("old-prefix"))], null);
    throw Object.assign(new Error("edited"), { reason: "HISTORY_CURSOR_STALE" });
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  stale = true;
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire").catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observations, 2, "a stale latest read does not start background refresh loops");
  await f.history("loadOlder");
  assert.deepEqual(ids(f), ["edited"]);
  assert.equal(
    f.calls.some((call) => /submit|resume|start|steer/.test(call.method)),
    false,
  );
});

test("release midway keeps partial pages hidden and reacquires from the committed cursor", async () => {
  let pending,
    reads = 0;
  const cursors = [];
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") return partialBaseline();
    cursors.push(params.cursor);
    reads++;
    if (params.cursor === "older") return page([entry("t2", item("prefix"))], "continue");
    if (reads === 2)
      return new Promise((resolve) => {
        pending = resolve;
      });
    return page([entry("t2", item("prompt"))], null);
  });
  await f.backend.openThread(f.project, "thread");
  const first = f.history("acquire");
  await new Promise((resolve) => setImmediate(resolve));
  await f.history("release");
  assert.deepEqual(ids(f), ["i2"]);
  await f.history("acquire");
  pending(page([entry("t2", item("discard"))], null));
  await assert.rejects(first, (error) => error.code === "HISTORY_VIEW_UNAVAILABLE");
  assert.deepEqual(cursors, ["older", "continue", "older", "continue"]);
  assert.deepEqual(ids(f), ["prompt", "prefix", "i2"]);
});

test("stale automatic hydration leaves an in-flight observation alone until explicit retry", async () => {
  let stale = false,
    observations = 0,
    finishObservation;
  const held = new Promise((resolve) => {
    finishObservation = resolve;
  });
  const f = fixture(async (method) => {
    if (method === "areal/thread/observe") {
      observations++;
      const value = partialBaseline();
      if (observations >= 3) {
        value.thread.turns = [turn("t2", [item("fresh")])];
        value.history = { snapshotId: "fresh", complete: true, nextCursor: null };
      }
      return value;
    }
    if (!stale) return page([entry("t2", item("prefix"))], null);
    throw Object.assign(new Error("edited"), { reason: "HISTORY_CURSOR_STALE" });
  });
  await f.backend.openThread(f.project, "thread");
  await f.history("acquire");
  stale = true;
  const request = f.project.client.request;
  f.project.client.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === "areal/thread/observe" && observations === 2) await held;
    return result;
  };
  const refresh = f.backend.openThread(f.project, "thread");
  await new Promise((resolve) => setImmediate(resolve));
  finishObservation();
  await refresh;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observations, 2);
  await f.history("loadOlder");
  assert.equal(observations, 3);
  assert.deepEqual(ids(f), ["fresh"]);
});

test("first visible observation includes configuration, interactions and queue before live events", async () => {
  const observed = [];
  const configuration = { revision: 1, model: { providerId: "provider", modelId: "chosen" } };
  const f = fixture(
    async () => {
      const result = baseline();
      result.thread.desktop.configuration = configuration;
      return result;
    },
    {
      afterResult(method) {
        if (method !== "areal/thread/observe") return;
        f.project.model.event("areal/queue/updated", {
          threadId: "thread",
          queue: { revision: 2, items: [{ id: "queued", status: "pending" }] },
        });
        f.project.model.event("item/agentMessage/delta", {
          threadId: "thread",
          turnId: "t2",
          itemId: "i2",
          delta: ":live",
        });
      },
    },
  );
  f.project.model.subscribe(() =>
    observed.push({
      configuration: f.project.configurations.thread,
      interactions: f.project.model.state.interactions.thread,
      queue: f.project.model.state.queues.thread,
      text: f.project.model.state.threads.thread?.turns.at(-1).items.at(-1).text,
    }),
  );
  await f.backend.openThread(f.project, "thread");
  assert.deepEqual(observed[0], {
    configuration,
    interactions: { revision: 1, data: [] },
    queue: { revision: 1, items: [] },
    text: "i2",
  });
  assert.equal(observed.at(-1).text, "i2:live");
  assert.equal(observed.at(-1).queue.revision, 2);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["areal/thread/observe"],
  );
});

test("latest hydration publishes all pages together and preserves concurrent live changes", async () => {
  let finish, reachedSecond;
  const secondPage = new Promise((resolve) => {
    reachedSecond = resolve;
  });
  const f = fixture(async (method, params) => {
    if (method === "areal/thread/observe") return partialBaseline();
    if (params.cursor === "older") return page([entry("t2", item("middle"))], "second");
    reachedSecond();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await f.backend.openThread(f.project, "thread");
  const observed = [];
  f.project.model.subscribe(() => observed.push(ids(f)));
  const hydration = f.history("acquire");
  await secondPage;
  assert.deepEqual(ids(f), ["i2"]);
  f.project.model.event("item/agentMessage/delta", {
    threadId: "thread",
    turnId: "t2",
    itemId: "i2",
    delta: ":live",
  });
  f.project.model.event("areal/queue/updated", {
    threadId: "thread",
    queue: { revision: 5, items: [{ id: "pending" }] },
  });
  finish(page([entry("t2", item("first"))], null));
  await hydration;
  assert.deepEqual(ids(f), ["first", "middle", "i2"]);
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items.at(-1).text, "i2:live");
  assert.equal(f.project.model.state.queues.thread.revision, 5);
  assert.ok(observed.every((values) => values.length === 1 || values.join() === "first,middle,i2"));
  assert.equal(observed.filter((values) => values.length === 3).length, 1);
});

test("implicit historical model inspection retains its revision-specific name and effort on re-observation", async () => {
  const configuration = { revision: 3, model: null, defaultModelRevision: "historic-default" };
  const snapshot = () => {
    const value = baseline();
    value.thread.desktop.configuration = configuration;
    return value;
  };
  const f = fixture(async () => snapshot(), {
    inspection: {
      configuration,
      modelName: "historical-model",
      resolvedParameters: { reasoningEffort: "high" },
    },
  });
  await f.backend.openThread(f.project, "thread");
  const enriched = {
    ...configuration,
    modelName: "historical-model",
    resolvedParameters: { reasoningEffort: "high" },
  };
  assert.deepEqual(f.project.configurations.thread, enriched);
  const configurations = [];
  f.project.model.subscribe(() => configurations.push(f.project.configurations.thread));
  await f.backend.openThread(f.project, "thread");
  assert.ok(configurations.length > 0);
  for (const value of configurations) assert.deepEqual(value, enriched);
  assert.equal(
    f.calls.some((call) => ["areal/interaction/list", "areal/queue/list"].includes(call.method)),
    false,
  );
});
