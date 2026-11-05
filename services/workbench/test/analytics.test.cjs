"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { UsageAnalytics } = require("../src/domains/analytics.cjs");
const { createBackend } = require("../src/backend.cjs");

const usage = (inputTokens) => ({ inputTokens, outputTokens: 1, cachedInputTokens: 0 });
const skill = (id) => ({
  id,
  type: "dynamicToolCall",
  tool: "skill_read",
  status: "completed",
  success: true,
  arguments: { skill: { id: "review" } },
});

async function fixture(core = {}) {
  const data = await mkdtemp(join(tmpdir(), "areal-workbench-analytics-"));
  const calls = [];
  const backend = createBackend({
    data,
    host: async (call, params) => {
      calls.push([call, params]);
      if (call === "projects.list")
        return { projects: [{ projectId: "p", ready: true }, { projectId: "cold", ready: false }] };
      const answer = core[params.method]?.(params.params);
      if (answer === undefined) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      return answer;
    },
  });
  let now = new Date("2026-11-05T10:00:00").getTime();
  const analytics = new UsageAnalytics(backend, () => now);
  await analytics.init();
  return { data, calls, analytics, advance: (ms) => (now += ms), at: () => now };
}

test("sync pages every thread of ready projects through Host and keeps live dates", async () => {
  const threads = {
    a: { id: "a", turns: [{ id: "t1", usage: usage(10), items: [skill("i1")] }] },
    b: { id: "b", turns: [{ id: "t2", usage: usage(5), items: [] }] },
    c: {
      id: "c",
      turns: [{ id: "t3", usage: usage(2), items: [], startedAt: new Date("2026-11-03T09:00:00").getTime() / 1000 }],
    },
  };
  const { analytics, calls } = await fixture({
    "thread/list": ({ cursor }) =>
      cursor ? { data: [{ id: "b" }, { id: "c" }], nextCursor: null } : { data: [{ id: "a" }], nextCursor: "1" },
    "thread/read": ({ threadId }) => ({ thread: threads[threadId] }),
  });
  analytics.observe("p", "turn/completed", { threadId: "a", turn: { id: "t1" } });
  const summary = await analytics.command({ operation: "sync" });
  assert.equal(summary.tokens, 20);
  assert.equal(summary.undatedTokens, 6);
  assert.equal(summary.days["2026-11-05"].tokens, 11);
  assert.equal(summary.days["2026-11-03"].tokens, 3);
  assert.deepEqual(summary.skills, [{ name: "review", calls: 1 }]);
  assert.equal(summary.error, null);
  assert.deepEqual(
    calls.filter(([call]) => call === "core.request").map(([, p]) => [p.projectId, p.method]),
    [
      ["p", "thread/list"],
      ["p", "thread/list"],
      ["p", "thread/read"],
      ["p", "thread/read"],
      ["p", "thread/read"],
    ],
  );
});

test("a failed Core read is reported and does not block the summary", async () => {
  const { analytics } = await fixture({});
  const summary = await analytics.command({ operation: "sync" });
  assert.match(summary.error, /部分历史尚未同步/);
});

test("activity from several clients counts the focused union once", async () => {
  const { analytics, advance } = await fixture();
  analytics.activity("gui", { focused: true });
  analytics.activity("browser", { focused: true });
  advance(5000);
  analytics.activity("gui", { focused: true });
  analytics.activity("browser", { focused: true });
  advance(5000);
  analytics.activity("gui", { focused: false });
  analytics.activity("browser", { focused: false });
  advance(5000);
  analytics.activity("gui", { focused: false });
  assert.equal(analytics.summary().days["2026-11-05"].activeMs, 10000);
});

test("import merges the Main file, persists, and refuses after an unreadable file", async () => {
  const { analytics, data } = await fixture();
  analytics.recordTurn("p", "a", { id: "t1", usage: usage(3) }, "2026-11-05");
  analytics.import({
    version: 1,
    since: 1,
    days: { "2026-11-04": 4000 },
    turns: {
      '["p","a","t1"]': { date: "2026-01-01", usage: usage(99) },
      '["p","a","t0"]': { date: "2026-11-04", usage: usage(1) },
    },
    skills: {},
  });
  await analytics.flush();
  const saved = JSON.parse(await readFile(join(data, "analytics.json"), "utf8"));
  assert.equal(saved.since, 1);
  assert.equal(saved.days["2026-11-04"], 4000);
  assert.equal(saved.turns['["p","a","t1"]'].usage.inputTokens, 3);
  assert.equal(saved.turns['["p","a","t0"]'].date, "2026-11-04");
  assert.throws(() => analytics.import({ version: 1, since: 1, days: { x: "bad" } }));

  await writeFile(join(data, "analytics.json"), "{broken");
  const reopened = new UsageAnalytics(createBackend({ data, host: async () => ({}) }));
  await reopened.init();
  assert.throws(() => reopened.import({ version: 1, since: 1, days: {}, turns: {}, skills: {} }));
});
