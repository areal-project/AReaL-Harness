import assert from "node:assert/strict";
import test from "node:test";
import { readTurnToolDetails } from "./tool-history.mjs";

function fixture({ status = "completed", deferred = true } = {}) {
  const result = {
    type: "dynamicToolCall",
    id: "tool",
    tool: "browser_v1",
    success: true,
    arguments: { operation: "observe" },
    contentItems: [{ text: '{"observationId":"observed","ref":"r1"}' }],
  };
  const placeholder = {
    type: "historyDeferred",
    id: "tool",
    originalType: "dynamicToolCall",
    preview: { ...result, contentItems: null },
    cursor: "bounded-cursor",
    version: "version",
  };
  let thread = {
    id: "thread",
    turns: [
      { id: "target", status, items: [deferred ? placeholder : result] },
      { id: "other", status: "completed", items: [{ ...placeholder, id: "other-tool" }] },
    ],
  };
  const calls = [];
  const options = {
    projectId: "project",
    threadId: "thread",
    turnId: "target",
    readThread: async () => structuredClone(thread),
    command: async (name, params) => {
      assert.equal(name, "history");
      assert.equal(params.projectId, "project");
      assert.equal(params.threadId, "thread");
      calls.push(params);
      if (params.operation === "acquire") return { supported: true };
      if (params.operation === "loadItem") {
        assert.equal(params.itemId, "tool", "other Turn details must stay deferred");
        thread.turns[0].items = [structuredClone(result)];
        return { loaded: true, itemId: params.itemId };
      }
      assert.equal(params.operation, "release");
      thread.turns[0].items = [placeholder];
      return { released: true };
    },
  };
  return { options, calls, result };
}

test("bounded detail reads return fresh exact-Turn records before releasing the view", async () => {
  const { options, calls, result } = fixture();
  const actual = await readTurnToolDetails(options);
  assert.deepEqual(actual.items, [result]);
  assert.equal(actual.id, "target");
  assert.deepEqual(
    calls.map((x) => x.operation),
    ["acquire", "loadItem", "release"],
  );
  assert.equal(new Set(calls.map((x) => x.viewId)).size, 1);
  assert.equal((await options.readThread()).turns[0].items[0].type, "historyDeferred");
});

for (const status of ["completed", "failed", "interrupted"])
  test(`inline ${status} results preserve terminal state without requiring bounded-history support`, async () => {
    const { options, calls } = fixture({ status, deferred: false });
    assert.equal((await readTurnToolDetails(options)).status, status);
    assert.deepEqual(calls, []);
  });

for (const broken of ["acquire", "loadItem", "wrong-item", "not-loaded"])
  test(`${broken} fails closed and releases the view without retrying`, async () => {
    const { options, calls } = fixture();
    const command = options.command;
    options.command = async (name, params) => {
      if (params.operation === broken) {
        calls.push(params);
        throw Error("injected failure");
      }
      if (params.operation === "loadItem" && broken === "wrong-item") {
        calls.push(params);
        return { loaded: true, itemId: "foreign" };
      }
      if (params.operation === "loadItem" && broken === "not-loaded") {
        calls.push(params);
        return { loaded: false, itemId: "tool" };
      }
      return command(name, params);
    };
    await assert.rejects(readTurnToolDetails(options));
    assert.equal(calls.at(-1).operation, "release");
    assert.ok(calls.filter((x) => x.operation === "loadItem").length <= 1);
  });

test("detail and cleanup failures both remain visible", async () => {
  const { options } = fixture();
  const command = options.command;
  options.command = async (name, params) => {
    if (params.operation !== "acquire") throw Error(params.operation);
    return command(name, params);
  };
  await assert.rejects(
    readTurnToolDetails(options),
    (error) =>
      error instanceof AggregateError &&
      error.errors.map((x) => x.message).join() === "loadItem,release",
  );
});

test("a changed Turn identity cannot satisfy the original tool read", async () => {
  const { options, calls } = fixture();
  const command = options.command;
  const readThread = options.readThread;
  let changed = false;
  options.readThread = async () => (changed ? { id: "thread", turns: [] } : readThread());
  options.command = async (name, params) => {
    const result = await command(name, params);
    if (params.operation === "loadItem") changed = true;
    return result;
  };
  await assert.rejects(readTurnToolDetails(options), /original Turn remains present/);
  assert.equal(calls.at(-1).operation, "release");
});

test("a deferred result cannot silently fall back to unsupported full-history reads", async () => {
  const { options, calls } = fixture();
  const command = options.command;
  options.command = async (name, params) => {
    if (params.operation === "acquire") {
      calls.push(params);
      return { supported: false };
    }
    return command(name, params);
  };
  await assert.rejects(readTurnToolDetails(options), /bounded history must support/);
  assert.deepEqual(
    calls.map((item) => item.operation),
    ["acquire", "release"],
  );
});
