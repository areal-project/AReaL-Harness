import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { freezeContext } = require("@areal/workbench-service/feedback-context");
const { UserFeedback } = require("@areal/workbench-service/feedback");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { validateCommand } = require("@areal/workbench/desktop-contract");

test("feedback refreshes Host credentials first and does not call Host after refresh fails", async () => {
  let credential = "stale-fixture",
    calls = 0;
  const backend = {
    hostCall: async () => {
      calls++;
      return { credential };
    },
    providers: {
      config: {
        refreshCredentials: async () => {
          credential = "rotated-fixture";
        },
      },
    },
  };
  const feedback = new UserFeedback(backend);
  assert.deepEqual(await feedback.cli("feedback-status"), { credential: "rotated-fixture" });
  backend.providers.config.refreshCredentials = async () => {
    throw new Error("Host unavailable");
  };
  await assert.rejects(feedback.cli("feedback-status"), /Host unavailable/);
  assert.equal(calls, 1);
});

const thread = () => ({
  id: "main",
  turns: [
    {
      id: "first",
      status: "completed",
      items: [
        { id: "question", type: "userMessage", content: [{ type: "text", text: "original" }] },
        { id: "reply", type: "agentMessage", text: "answer" },
        { id: "after-reply", type: "modelContext", value: "later" },
      ],
    },
    {
      id: "future",
      status: "inProgress",
      items: [
        {
          id: "new-question",
          type: "userMessage",
          content: [{ type: "text", text: "future question" }],
        },
      ],
    },
  ],
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "areal-feedback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const main = thread(),
    sent = [],
    sideCalls = [];
  const project = {
    client: {
      request: async (method, p) => {
        assert.equal(method, "thread/read");
        return {
          thread:
            p.threadId === "side"
              ? {
                  id: "side",
                  conversation: { kind: "side", origin: { sourceThreadId: "main" } },
                  turns: [
                    {
                      id: "refine-turn",
                      status: "completed",
                      items: [{ id: "analysis", type: "agentMessage", text: "polished analysis" }],
                    },
                  ],
                }
              : structuredClone(main),
        };
      },
    },
  };
  const backend = {
    home,
    save: async (name, value) =>
      writeFile(join(home, name), JSON.stringify(value), { mode: 0o600 }),
    start: async () => project,
    openThread: async () => {},
    executeCommand: async (name, request) => {
      sideCalls.push({ name, request });
      return { threadId: "side" };
    },
  };
  const feedback = new UserFeedback(backend);
  await feedback.init();
  feedback.cli = async (operation, payload) => {
    if (operation === "feedback-status")
      return {
        enabled: true,
        connected: true,
        destination: "destination",
        account: "alice",
        installation: "00000000-0000-4000-8000-000000000001",
      };
    sent.push(structuredClone(payload));
    return {
      feedback_id: payload.feedback_id,
      rating: payload.rating,
      source_id: "external-source",
    };
  };
  const prepare = () =>
    feedback.command({
      operation: "prepare",
      projectId: "project",
      threadId: "main",
      turnId: "first",
      itemId: "reply",
      rating: "down",
    });
  return { feedback, backend, main, sent, sideCalls, prepare, home };
}

test("feedback uses the routed execution owner after public request validation", async (t) => {
  const x = await fixture(t);
  const backend = new CoreBackend({ binary: "/fixture/areal", home: x.home });
  backend.saved = [
    { id: "project", root: x.home },
    { id: "execution", root: join(x.home, "worktree"), logicalProjectId: "project" },
  ];
  backend.worktrees.threadOwners.set("main", "execution");
  backend.feedback = x.feedback;
  const draft = await backend.command("feedback", {
    operation: "prepare",
    projectId: "project",
    threadId: "main",
    turnId: "first",
    itemId: "reply",
    rating: "down",
  });
  assert.equal(draft.projectId, "execution");
  assert.equal(draft.threadId, "main");
  await assert.rejects(
    backend.command("feedback", {
      operation: "prepare",
      projectId: "project",
      threadId: "main",
      turnId: "first",
      itemId: "reply",
      rating: "down",
      logicalProjectId: "project",
    }),
    /无效桌面操作或参数/,
  );
});

test("freezes authoritative history through rated reply and excludes later items and turns", async () => {
  const main = thread();
  const frozen = await freezeContext(
    { request: async () => ({ thread: main }) },
    "main",
    "first",
    "reply",
  );
  assert.equal(frozen.context.turns.length, 1);
  assert.deepEqual(
    frozen.context.turns[0].items.map((x) => x.id),
    ["question", "reply"],
  );
  main.turns[0].items[0].content[0].text = "changed";
  assert.equal(frozen.context.turns[0].items[0].content[0].text, "original");
  assert.match(frozen.contextSha256, /^[0-9a-f]{64}$/);
  await assert.rejects(
    () =>
      freezeContext({ request: async () => ({ thread: main }) }, "main", "future", "new-question"),
    /回复结束/,
  );
});

test("fork feedback assembles full inherited fragments and rejects snapshot drift", async () => {
  const main = thread();
  main.conversation = { kind: "fork", historySeed: { snapshotId: "frozen-seed" } };
  const entry = {
    sourceThreadId: "ancestor",
    sourceTurnId: "inherited",
    sourceTurnStatus: "completed",
    sourceItemId: "old-reply",
    turn: { id: "inherited", status: "completed" },
    item: { id: "old-reply", type: "agentMessage", text: "完整继承上下文🌊" },
  };
  const raw = JSON.stringify(entry),
    split = raw.indexOf("🌊");
  const part = (offset, text) => ({
    sourceItemId: entry.sourceItemId,
    fragment: { offsetUtf8: offset, totalBytes: Buffer.byteLength(raw), text },
  });
  const pages = [
    {
      snapshotId: "frozen-seed",
      data: [part(0, raw.slice(0, split))],
      complete: false,
      nextCursor: "page2",
    },
    {
      snapshotId: "frozen-seed",
      data: [part(Buffer.byteLength(raw.slice(0, split)), raw.slice(split))],
      complete: true,
    },
  ];
  const client = {
    request: async (method) => (method === "thread/read" ? { thread: main } : pages.shift()),
  };
  const frozen = await freezeContext(client, "main", "first", "reply");
  assert.equal(frozen.context.turns[0].sourceThreadId, "ancestor");
  assert.equal(frozen.context.turns[0].items[0].text, "完整继承上下文🌊");
  assert.equal(frozen.context.turns.length, 2);
  await assert.rejects(
    () =>
      freezeContext(
        {
          request: async (method) =>
            method === "thread/read"
              ? { thread: main }
              : { snapshotId: "changed", data: [], complete: true },
        },
        "main",
        "first",
        "reply",
      ),
    /快照已变化/,
  );
});

test("renderer cannot choose endpoint, context, installation or unsupported ratings", () => {
  validateCommand("feedback", {
    operation: "prepare",
    projectId: "p",
    threadId: "t",
    turnId: "turn",
    itemId: "item",
    rating: "up",
  });
  for (const extra of [
    { endpoint: "https://other.test" },
    { context: {} },
    { installation_id: "other" },
    { rating: "maybe" },
  ])
    assert.throws(() =>
      validateCommand("feedback", {
        operation: "prepare",
        projectId: "p",
        threadId: "t",
        turnId: "turn",
        itemId: "item",
        rating: "up",
        ...extra,
      }),
    );
  assert.throws(() =>
    validateCommand("feedback", {
      operation: "submit",
      projectId: "p",
      threadId: "t",
      id: "id",
      reason: "中".repeat(20000),
    }),
  );
});

test("polishing uses anchored independent Side and main continuation never enters submitted context", async (t) => {
  const x = await fixture(t),
    draft = await x.prepare();
  assert.equal(x.sent.length, 0);
  await x.feedback.command({
    operation: "refine",
    projectId: "project",
    threadId: "main",
    id: draft.id,
    reason: "遗漏约束",
  });
  assert.equal(x.sideCalls[0].name, "side");
  assert.equal(x.sideCalls[0].request.workspaceAccess, "none");
  assert.match(x.sideCalls[0].request.text, /frozen-feedback-context/);
  assert.match(x.sideCalls[0].request.text, /original/);
  assert.doesNotMatch(x.sideCalls[0].request.text, /future question/);
  assert.deepEqual(x.sideCalls[0].request.anchor, {
    kind: "turn",
    turnId: "first",
    boundary: "after",
  });
  x.main.turns.push({ id: "more-main-work", status: "completed", items: [] });
  const result = await x.feedback.command({
    operation: "submit",
    projectId: "project",
    threadId: "main",
    id: draft.id,
    reason: "原始意见",
    analysis: "确认后的分析",
  });
  assert.equal(result.state, "submitted");
  assert.equal(x.sent[0].reason, "原始意见");
  assert.equal(x.sent[0].analysis, "确认后的分析");
  assert.deepEqual(
    x.sent[0].context.turns.map((x) => x.id),
    ["first"],
  );
  assert.equal(x.sent[0].context.refinement.thread_id, "side");
  assert.equal(x.sent[0].expected_owner, "alice");
});

test("unknown feedback submission reuses persisted original body despite newer editor input", async (t) => {
  const x = await fixture(t),
    draft = await x.prepare();
  const original = x.feedback.cli;
  let failed = false;
  x.feedback.cli = async (op, payload) => {
    if (op === "feedback-submit" && !failed) {
      failed = true;
      x.sent.push(structuredClone(payload));
      throw Object.assign(new Error("network"), { submissionUnknown: true });
    }
    return original(op, payload);
  };
  await assert.rejects(() =>
    x.feedback.command({
      operation: "submit",
      projectId: "project",
      threadId: "main",
      id: draft.id,
      reason: "first opinion",
    }),
  );
  const saved = JSON.parse(await readFile(join(x.home, `feedback-${draft.id}.json`), "utf8"));
  assert.equal(saved.submission.reason, "first opinion");
  await x.feedback.command({
    operation: "submit",
    projectId: "project",
    threadId: "main",
    id: draft.id,
    reason: "different opinion",
  });
  assert.deepEqual(x.sent[0], x.sent[1]);
});

test("opt-out, owner and destination changes prevent accidental delivery", async (t) => {
  const x = await fixture(t),
    draft = await x.prepare();
  await x.feedback.command({ operation: "preference", enabled: false });
  await assert.rejects(
    () =>
      x.feedback.command({
        operation: "submit",
        projectId: "project",
        threadId: "main",
        id: draft.id,
      }),
    /不可用/,
  );
  await x.feedback.command({ operation: "preference", enabled: true });
  for (const [changes, message] of [
    [{ destination: "another" }, /接收端已变化/],
    [{ installation: "00000000-0000-4000-8000-000000000002" }, /安装队列已变化/],
  ]) {
    x.feedback.cli = async () => ({
      enabled: true,
      connected: true,
      destination: "destination",
      account: "alice",
      installation: "00000000-0000-4000-8000-000000000001",
      ...changes,
    });
    await assert.rejects(
      () =>
        x.feedback.command({
          operation: "submit",
          projectId: "project",
          threadId: "main",
          id: draft.id,
        }),
      message,
    );
  }
  x.feedback.cli = async () => ({
    enabled: true,
    connected: true,
    destination: "destination",
    account: "bob",
    installation: "00000000-0000-4000-8000-000000000001",
  });
  await assert.rejects(
    () =>
      x.feedback.command({
        operation: "submit",
        projectId: "project",
        threadId: "main",
        id: draft.id,
      }),
    /账号已变化/,
  );
  assert.equal(x.sent.length, 0);
  await assert.rejects(
    () =>
      x.feedback.command({ operation: "read", projectId: "other", threadId: "main", id: draft.id }),
    /不属于/,
  );
});

test("uncertain Side creation recovers by receipt without sending a duplicate first prompt", async (t) => {
  const x = await fixture(t),
    draft = await x.prepare();
  let starts = 0;
  x.backend.executeCommand = async (name, p) => {
    if (p.operation === "start") {
      starts++;
      throw Object.assign(new Error("unknown"), { submissionUnknown: true });
    }
    if (p.operation === "recover") return { confirmed: true, threadId: "side" };
    throw new Error("unexpected duplicate send");
  };
  await assert.rejects(() =>
    x.feedback.command({
      operation: "refine",
      projectId: "project",
      threadId: "main",
      id: draft.id,
      reason: "opinion",
    }),
  );
  const result = await x.feedback.command({
    operation: "refine",
    projectId: "project",
    threadId: "main",
    id: draft.id,
    reason: "updated opinion",
  });
  assert.equal(result.sideThreadId, "side");
  assert.equal(starts, 1);
});
