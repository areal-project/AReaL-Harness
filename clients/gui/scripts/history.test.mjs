import assert from "node:assert/strict";
import test from "node:test";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";

const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const agent = (id, text, phase = "commentary") => ({ id, type: "agentMessage", text, phase });
function fixture() {
  const model = new CoreTaskModel();
  const previous = {
    id: "previous",
    status: "completed",
    items: [user("old-user", "第一轮"), agent("old-agent", "第一轮回复", "final_answer")],
  };
  const items = [
    {
      ...user("user", "原始提问"),
      content: [...user("user", "原始提问").content, { type: "image", url: "areal-blob:fixture" }],
    },
    agent("early", "先检查已有实现"),
    { id: "tool", type: "dynamicToolCall", tool: "fs_read", status: "completed", success: true },
    user("steer", "补充要求"),
    agent("reply", "回复前缀"),
  ];
  model.replace({ id: "thread", turns: [previous, { id: "turn", status: "inProgress", items }] });
  const event = (method, params = {}) =>
    model.event(method, { threadId: "thread", turnId: "turn", ...params });
  const turn = () => model.state.threads.thread.turns.at(-1);
  return { model, previous, items, event, turn };
}

test("tool replacements and removals survive a late snapshot of the old catalog", () => {
  const model = new CoreTaskModel();
  const definition = (name) => ({ name, description: name, inputSchema: { type: "object" } });
  const source = { sourceTurnId: "first", configurationRevision: 1 };
  const original = {
    id: "thread",
    turns: [
      {
        id: "first",
        status: "completed",
        items: [{ id: "call", type: "dynamicToolCall", tool: "old" }],
      },
    ],
    dynamicTools: [definition("old")],
    desktop: { promptPrediction: { ...source, status: "ready", text: "Use the old tool" } },
  };
  model.replace(original);
  const update = (revision, tools) =>
    model.event("areal/thread/tools/attached", {
      threadId: original.id,
      toolsetRevision: revision,
      dynamicTools: tools,
    });
  const next = [definition("new")];
  update(1, next);
  const unavailable = { ...source, status: "unavailable" };
  model.event("areal/thread/predictionChanged", {
    threadId: original.id,
    promptPrediction: unavailable,
  });
  model.replace(original);
  const current = () => model.getSnapshot().threads.thread;
  assert.deepEqual(current().dynamicTools, next);
  assert.deepEqual(current().desktop.promptPrediction, unavailable);
  update(2, []);
  update(1, next);
  model.replace(original);
  assert.equal(current().toolsetRevision, 2);
  assert.deepEqual(current().dynamicTools, []);
  assert.deepEqual(current().turns, original.turns);
});

test("a budgeted display snapshot never turns a deferred toolset into an empty or older list", () => {
  const model = new CoreTaskModel();
  const id = "thread";
  const deferred = { id, toolsetRevision: 2, deferredDynamicToolCount: 1 };
  const tools = [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }];
  const head = () => model.getSnapshot().threads[id];
  const event = (toolsetRevision, dynamicTools) =>
    model.event("areal/thread/tools/attached", { threadId: id, toolsetRevision, dynamicTools });
  model.replace({ id, toolsetRevision: 1, dynamicTools: [{ name: "retired" }] });
  model.replace(deferred);
  assert.equal(head().dynamicTools, undefined);
  assert.equal(head().deferredDynamicToolCount, 1);
  event(2, tools);
  model.replace(deferred);
  assert.deepEqual(head().dynamicTools, tools);
  assert.equal(head().deferredDynamicToolCount, undefined);
  event(3, []);
  model.replace(deferred);
  assert.equal(head().toolsetRevision, 3);
  assert.deepEqual(head().dynamicTools, []);
  assert.equal(head().deferredDynamicToolCount, undefined);
});

for (const status of ["completed", "interrupted", "failed"]) {
  test(`compacted ${status} turn preserves user, steer, attachments and earlier agent messages`, () => {
    const { model, previous, items, event, turn } = fixture();
    event("areal/context/compacted");
    const reply = agent("reply", "回复前缀与完整结尾", "final_answer");
    const media = {
      id: "media",
      type: "agentMedia",
      modality: "image",
      media: { uri: "areal-blob:generated" },
    };
    const terminal = {
      id: "turn",
      status,
      durationMs: 3210,
      error: status === "failed" ? { message: "fixture failure" } : null,
      items: [reply, media],
    };
    event("turn/completed", { turn: terminal });
    assert.deepEqual(turn().items, [...items.slice(0, -1), reply, media]);
    assert.equal(turn().status, status);
    assert.equal(turn().durationMs, 3210);
    assert.deepEqual(turn().error, terminal.error);
    assert.deepEqual(model.state.threads.thread.turns[0], previous);
    event("turn/completed", { turn: terminal });
    assert.deepEqual(turn().items, [...items.slice(0, -1), reply, media], "重复终态不重复消息");
    event("turn/started", { turn: { id: "turn", status: "inProgress", items: [items[0]] } });
    assert.equal(turn().status, status, "迟到的开始回执不能回退终态");
    assert.deepEqual(turn().items, [...items.slice(0, -1), reply, media]);
  });
}

test("empty terminal suffix and repeated start preserve streamed messages", () => {
  const { event, turn, items } = fixture();
  event("turn/started", {
    turn: { id: "turn", status: "inProgress", items: [items[0], agent("reply", "")] },
  });
  assert.deepEqual(turn().items, items);
  event("turn/completed", { turn: { id: "turn", status: "interrupted", items: [] } });
  assert.deepEqual(turn().items, items);
});

test("discarded model response stays removed across compaction and terminal updates", () => {
  const { model, event, turn, items } = fixture();
  event("areal/model/completionDiscarded", { itemIds: ["reply"] });
  const replacement = agent("replacement", "重试后的完整回复", "final_answer");
  event("item/started", { item: agent("replacement", "") });
  event("item/agentMessage/delta", { itemId: "replacement", delta: replacement.text });
  event("item/completed", { item: replacement });
  event("turn/completed", { turn: { id: "turn", status: "completed", items: [replacement] } });
  const expected = [...items.slice(0, -1), replacement];
  assert.deepEqual(turn().items, expected);
  const snapshot = structuredClone(model.state.threads.thread);
  const recovered = new CoreTaskModel();
  recovered.replace(snapshot);
  assert.deepEqual(recovered.state.threads.thread.turns.at(-1).items, expected);
  // 完整读取是权威基线，不能把已丢弃的流式文本从本地缓存重新拼回。
  model.replace({
    ...snapshot,
    turns: [snapshot.turns[0], { ...turn(), items: [items[0], replacement] }],
  });
  assert.deepEqual(turn().items, [items[0], replacement]);
});
