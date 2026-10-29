const assert = require("node:assert/strict");
const { test } = require("node:test");
const { HistoryObservation } = require("../app/src/core/history-observation.cjs");

const row = (id, extra = {}) => ({
  id,
  createdAt: 1,
  updatedAt: 1,
  source: "appServer",
  desktop: {},
  ...extra,
});
const barrier = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

function fixture(read, { classified = true, loaded = false, summaries = [] } = {}) {
  const calls = [],
    saves = [],
    observed = [];
  const project = {
    id: "project",
    connectionGeneration: 1,
    summaries,
    summariesLoaded: loaded,
    model: { event() {}, state: { threads: {} } },
    configurations: {},
  };
  const client = (project.client = {
    ready: true,
    capabilities: { methods: classified ? ["areal/conversation/list"] : [] },
    request: async (method, params, options) => {
      calls.push({ method, params });
      const response = await read(method, params);
      return options?.decode ? options.decode(response) : response;
    },
  });
  const observation = new HistoryObservation({
    currentConnection: (p, c) => p.client === c,
    library: {
      value: {},
      recordThreadSummaries: async (_id, rows) => saves.push(structuredClone(rows)),
      recordThreadActivity: async () => {},
    },
    worktrees: {
      observeProject: async (p) =>
        observed.push({ complete: p.summariesLoaded, ids: p.summaries.map((t) => t.id) }),
    },
    analytics: { observe() {} },
    notifications: { observe() {} },
    providers: { requestReconciliation() {} },
    scheduleReconciliation() {},
    onChange() {},
  });
  return { observation, project, client, calls, saves, observed };
}

test("twenty simultaneous complete refreshes share one paginated directory read", async () => {
  const f = fixture(async (_method, params) => {
    await new Promise((resolve) => setImmediate(resolve));
    const offset = Number(params.cursor ?? 0);
    return {
      data: Array.from({ length: 100 }, (_, i) => row(String(offset + i))),
      nextCursor: offset + 100 < 2_000 ? String(offset + 100) : null,
    };
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => f.observation.listThreads(f.project)),
  );
  assert.equal(f.calls.length, 20);
  assert.equal(f.saves.length, 1);
  assert.equal(f.project.summaries.length, 2_000);
  assert.ok(results.every((value) => value === f.project.summaries));
  assert.deepEqual(f.observed, [{ complete: true, ids: f.project.summaries.map((t) => t.id) }]);
});

test("refreshes received during an in-flight read trigger one newer complete read", async () => {
  const entered = barrier(),
    release = barrier();
  let reads = 0;
  const f = fixture(
    async () => {
      if (++reads === 1) {
        entered.release();
        await release.promise;
        return { data: [row("old")] };
      }
      return { data: [row("new")] };
    },
    { loaded: true },
  );
  const first = f.observation.listThreads(f.project);
  await entered.promise;
  const pending = Array.from({ length: 20 }, () => f.observation.listThreads(f.project));
  release.release();
  await Promise.all([first, ...pending]);
  assert.equal(reads, 2);
  assert.deepEqual(
    f.saves.map((rows) => rows.map((t) => t.id)),
    [["old"], ["new"]],
  );
});

test("a completed refresh does not wait for later notifications to become idle", async () => {
  const entered = barrier(),
    release = barrier(),
    nextEntered = barrier(),
    nextRelease = barrier();
  const f = fixture(
    async (method) => {
      if (method === "areal/conversation/list") {
        entered.release();
        await release.promise;
        return { data: [row("a")] };
      }
      nextEntered.release();
      await nextRelease.promise;
      return { thread: row("a", { name: "later" }) };
    },
    { loaded: true, summaries: [row("a")] },
  );
  const first = f.observation.listThreads(f.project);
  await entered.promise;
  const next = f.observation.refreshThreadSummary(f.project, "a");
  let drained = false;
  const backendBarrier = f.project.summaryReads.then(() => {
    drained = true;
  });
  release.release();
  await nextEntered.promise;
  let timer;
  const completed = await Promise.race([
    first.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(drained, false, "backend disconnect must still wait for the queued batch");
  nextRelease.release();
  await next;
  await backendBarrier;
  assert.equal(drained, true);
  assert.equal(completed, true);
  assert.equal(f.project.summaries[0].name, "later");
});

test("Turn notifications refresh one metadata row and retain the complete directory", async () => {
  const f = fixture(
    async (method, params) => {
      assert.equal(method, "thread/read");
      assert.deepEqual(params, { threadId: "changed", includeTurns: false });
      return { thread: row("changed", { name: "Current title", updatedAt: 20 }) };
    },
    { loaded: true, summaries: [row("changed"), row("other")] },
  );
  for (let i = 0; i < 20; i++)
    f.observation.notification(f.project, f.client, i % 2 ? "turn/completed" : "turn/started", {
      threadId: "changed",
      turn: { id: `turn-${i}` },
    });
  await f.project.summaryRead.promise;
  assert.equal(f.calls.length, 1);
  assert.equal(f.saves.length, 1);
  assert.equal(f.project.summaries.find((t) => t.id === "changed").name, "Current title");
  assert.deepEqual(f.observed, [{ complete: true, ids: ["changed", "other"] }]);
});

test("a notification during a target read is followed by a fresh target read", async () => {
  const entered = barrier(),
    release = barrier();
  let reads = 0;
  const f = fixture(
    async () => {
      if (++reads === 1) {
        entered.release();
        await release.promise;
        return { thread: row("a", { name: "old" }) };
      }
      return { thread: row("a", { name: "new" }) };
    },
    { loaded: true, summaries: [row("a")] },
  );
  const first = f.observation.refreshThreadSummary(f.project, "a");
  await entered.promise;
  const pending = Array.from({ length: 20 }, () =>
    f.observation.refreshThreadSummary(f.project, "a"),
  );
  release.release();
  await Promise.all([first, ...pending]);
  assert.equal(reads, 2);
  assert.equal(f.project.summaries[0].name, "new");
});

test("target refresh queued during a complete read cannot be overwritten by its older page", async () => {
  const entered = barrier(),
    release = barrier();
  const f = fixture(
    async (method) => {
      if (method === "areal/conversation/list") {
        entered.release();
        await release.promise;
        return { data: [row("a", { name: "old" }), row("b")] };
      }
      return { thread: row("a", { name: "new" }) };
    },
    { loaded: true, summaries: [row("a"), row("b")] },
  );
  const first = f.observation.listThreads(f.project);
  await entered.promise;
  const newer = f.observation.refreshThreadSummary(f.project, "a");
  release.release();
  await Promise.all([first, newer]);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["areal/conversation/list", "thread/read"],
  );
  assert.equal(f.project.summaries[0].name, "new");
  assert.equal(f.project.summaries.length, 2);
});

test("initial lifecycle refresh obtains a complete directory before Worktree inspection", async () => {
  const f = fixture(async (method) => {
    assert.equal(method, "areal/conversation/list");
    return { data: [row("a"), row("b")] };
  });
  await f.observation.refreshThreadSummary(f.project, "a");
  assert.deepEqual(f.observed, [{ complete: true, ids: ["a", "b"] }]);
});

test("reconnection discards a stale page and leaves the successor refresh owner intact", async () => {
  const entered = barrier(),
    release = barrier();
  const f = fixture(async () => {
    entered.release();
    await release.promise;
    return { data: [row("old")], nextCursor: "more" };
  });
  const old = f.observation.listThreads(f.project);
  await entered.promise;
  f.project.connectionGeneration++;
  f.project.client = {
    capabilities: f.client.capabilities,
    request: async () => ({ data: [row("new")] }),
  };
  await f.observation.listThreads(f.project);
  release.release();
  await old;
  assert.deepEqual(
    f.project.summaries.map((t) => t.id),
    ["new"],
  );
  assert.deepEqual(
    f.saves.map((rows) => rows.map((t) => t.id)),
    [["new"]],
  );
  assert.equal(f.calls.length, 1, "the old connection must not fetch a second page");
  assert.equal(f.project.summaryRead, undefined);
});

test("generation changes invalidate a read even when a client object is reused", async () => {
  const entered = barrier(),
    release = barrier();
  const f = fixture(
    async () => {
      entered.release();
      await release.promise;
      return { data: [row("stale")] };
    },
    { loaded: true, summaries: [row("original")] },
  );
  const reading = f.observation.listThreads(f.project);
  await entered.promise;
  f.project.connectionGeneration++;
  release.release();
  await reading;
  assert.equal(f.saves.length, 0);
  assert.deepEqual(
    f.project.summaries.map((t) => t.id),
    ["original"],
  );
});

test("failed refresh releases its owner and permits an explicit fresh read", async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error("fixture read failure");
    return { data: [row("ok")] };
  });
  await assert.rejects(f.observation.listThreads(f.project), /fixture read failure/);
  assert.equal(f.project.summaryRead, undefined);
  fail = false;
  await f.observation.listThreads(f.project);
  assert.deepEqual(
    f.project.summaries.map((t) => t.id),
    ["ok"],
  );
});

test("target metadata follows classified visibility including removal after a role change", async () => {
  const values = [
    row("child", { parentThreadId: "root" }),
    row("side", { conversation: { kind: "side" } }),
    row("worker", { source: "nativeTaskAgent" }),
    row("research", { source: "nativeResearchAgent" }),
    row("draft", {
      desktop: {
        configuration: { options: { appendInstructions: "AREAL_TASK_DRAFT_V1\nfixture" } },
      },
    }),
    row("kept"),
  ];
  const f = fixture(
    async (_method, { threadId }) => ({ thread: values.find((t) => t.id === threadId) }),
    { loaded: true, summaries: values.map((t) => row(t.id)) },
  );
  await Promise.all(values.map((t) => f.observation.refreshThreadSummary(f.project, t.id)));
  assert.deepEqual(
    f.project.summaries.map((t) => t.id),
    ["kept"],
  );
  assert.equal(f.saves.length, 1);
});

test("legacy metadata refresh preserves legacy child visibility and UUID ordering", async () => {
  const f = fixture(
    async (_method, { threadId }) => ({
      thread: row(threadId, { parentThreadId: "root", createdAt: 99 }),
    }),
    { classified: false, loaded: true, summaries: [row("b")] },
  );
  await f.observation.refreshThreadSummary(f.project, "a");
  assert.deepEqual(
    f.project.summaries.map((t) => t.id),
    ["a", "b"],
  );
});

test("only an authoritative not-found removes a target row", async () => {
  let code = -32003;
  const f = fixture(
    async () => {
      throw Object.assign(new Error("fixture RPC error"), { code });
    },
    { loaded: true, summaries: [row("a"), row("b")] },
  );
  await assert.rejects(f.observation.refreshThreadSummary(f.project, "a"));
  assert.equal(f.project.summaries.length, 2);
  code = -32004;
  await f.observation.refreshThreadSummary(f.project, "a");
  assert.deepEqual(
    f.project.summaries.map((t) => t.id),
    ["b"],
  );
});

test("invalid directory responses preserve the last complete cache and permit a fresh read", async () => {
  let valid = false;
  const f = fixture(async () => (valid ? { data: [row("fresh")] } : { data: [{ id: 1 }] }), {
    loaded: true,
    summaries: [row("kept")],
  });
  await assert.rejects(f.observation.listThreads(f.project), { code: "HISTORY_VIEW_UNAVAILABLE" });
  assert.deepEqual(
    f.project.summaries.map((thread) => thread.id),
    ["kept"],
  );
  assert.equal(f.saves.length, 0);
  valid = true;
  await f.observation.listThreads(f.project);
  assert.deepEqual(
    f.project.summaries.map((thread) => thread.id),
    ["fresh"],
  );
});

test("invalid target metadata never removes a previously visible session", async () => {
  const f = fixture(async () => ({ thread: { id: 1 } }), {
    loaded: true,
    summaries: [row("kept")],
  });
  await assert.rejects(f.observation.refreshThreadSummary(f.project, "kept"), {
    code: "HISTORY_VIEW_UNAVAILABLE",
  });
  assert.deepEqual(
    f.project.summaries.map((thread) => thread.id),
    ["kept"],
  );
  assert.equal(f.saves.length, 0);
});
