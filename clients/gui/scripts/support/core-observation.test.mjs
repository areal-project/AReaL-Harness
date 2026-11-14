import assert from "node:assert/strict";
import test from "node:test";
import { listCoreSides, readCoreThread } from "./core-observation.mjs";

test("lists every Side including archived pages on the target Core", async () => {
  const calls = [];
  const ids = await listCoreSides({
    threadId: "parent",
    workspace: "/main",
    inventory: [{ state: "ready", workspace: "/main" }],
    connect: async () => ({
      request: async (method, params) => {
        calls.push([method, params]);
        return params.cursor
          ? { data: [{ id: "archived" }], nextCursor: null }
          : { data: [{ id: "open" }], nextCursor: "next" };
      },
      close: () => calls.push("closed"),
    }),
  });
  assert.deepEqual(ids, ["open", "archived"]);
  assert.deepEqual(calls, [
    ["areal/conversation/list", { view: "side", includeArchived: true, limit: 100 }],
    [
      "areal/conversation/list",
      { view: "side", includeArchived: true, limit: 100, cursor: "next" },
    ],
    "closed",
  ]);
});

test("observes the target thread in its execution worktree and closes the client", async () => {
  const target = {
    state: "ready",
    serviceId: "worktree-core",
    generation: "worktree-generation",
    workspace: "/worktree",
  };
  const calls = [];
  const thread = await readCoreThread({
    threadId: "thread-1",
    workspace: "/main",
    project: {
      core: { instanceId: "main-generation", serviceGeneration: "main-generation" },
      state: {
        threads: {
          "thread-1": {
            executionCore: {
              instanceId: "worktree-generation",
              serviceGeneration: "worktree-generation",
            },
            worktree: { directory: "/worktree" },
          },
        },
      },
    },
    inventory: [
      { state: "ready", serviceId: "main-core", generation: "main-generation", workspace: "/main" },
      target,
    ],
    connect: async (descriptor) => ({
      request: async (method, params) => {
        calls.push([descriptor, method, params]);
        return { thread: { id: "thread-1" } };
      },
      close: () => calls.push("closed"),
    }),
  });
  assert.deepEqual(thread, { id: "thread-1" });
  assert.deepEqual(calls, [
    [target, "thread/read", { threadId: "thread-1", includeTurns: true }],
    "closed",
  ]);
});

test("rejects a single descriptor for a different generation", async () => {
  await assert.rejects(
    readCoreThread({
      threadId: "t",
      workspace: "/main",
      project: {
        core: { instanceId: "expected-generation", serviceGeneration: "expected-generation" },
        state: { threads: { t: {} } },
      },
      inventory: {
        state: "ready",
        serviceId: "core",
        generation: "other-generation",
        workspace: "/main",
      },
      connect: () => assert.fail("must not connect"),
    }),
    /exactly one matching ready Core/,
  );
});

test("rejects ambiguous or wrong workspace before connecting", async () => {
  for (const inventory of [
    [],
    [{ state: "ready", workspace: "/wrong" }],
    Array(2).fill({ state: "ready", workspace: "/main" }),
  ]) {
    await assert.rejects(
      readCoreThread({
        threadId: "t",
        workspace: "/main",
        inventory,
        connect: () => assert.fail("must not connect"),
      }),
      /exactly one matching ready Core/,
    );
  }
});

test("preserves a read failure and closes its connection", async () => {
  const failure = Error("read failed");
  let closed = false;
  await assert.rejects(
    readCoreThread({
      threadId: "t",
      workspace: "/main",
      inventory: [{ state: "ready", workspace: "/main" }],
      connect: async () => ({
        request: async () => {
          throw failure;
        },
        close: () => {
          closed = true;
        },
      }),
    }),
    (error) => error === failure,
  );
  assert.equal(closed, true);
});

test("explicit worktree cannot discard a conflicting projected execution identity", async () => {
  await assert.rejects(
    readCoreThread({
      threadId: "t",
      workspace: "/main",
      executionWorkspace: "/requested",
      project: {
        core: { serviceGeneration: "main" },
        state: {
          threads: {
            t: { executionCore: { serviceGeneration: "other" }, worktree: { directory: "/other" } },
          },
        },
      },
      inventory: [{ state: "ready", workspace: "/other", generation: "other" }],
      connect: () => assert.fail("must reject conflicting target before connecting"),
    }),
    /execution workspace disagrees/,
  );
});

test("rejects a response for another thread and closes the observer", async () => {
  let closed = false;
  await assert.rejects(
    readCoreThread({
      threadId: "original",
      workspace: "/main",
      inventory: [{ state: "ready", workspace: "/main" }],
      connect: async () => ({
        request: async () => ({ thread: { id: "different" } }),
        close: () => {
          closed = true;
        },
      }),
    }),
    /original thread/,
  );
  assert.equal(closed, true);
});

test("an explicit unprojected worktree uses its descriptor, never the parent generation", async () => {
  const target = { state: "ready", workspace: "/worktree", generation: "child" };
  const observed = await readCoreThread({
    threadId: "child",
    workspace: "/main",
    executionWorkspace: "/worktree",
    project: { core: { serviceGeneration: "parent" } },
    inventory: [{ state: "ready", workspace: "/main", generation: "parent" }, target],
    connect: async (descriptor) => {
      assert.equal(descriptor, target);
      return { request: async () => ({ thread: { id: "child" } }), close() {} };
    },
  });
  assert.equal(observed.id, "child");
});

test("repeated Side cursor fails deterministically and releases the observer", async () => {
  let reads = 0;
  let closed = false;
  await assert.rejects(
    listCoreSides({
      threadId: "original",
      workspace: "/main",
      inventory: [{ state: "ready", workspace: "/main" }],
      connect: async () => ({
        request: async () => {
          reads++;
          return { data: [{ id: "side" }], nextCursor: "same" };
        },
        close: () => {
          closed = true;
        },
      }),
    }),
    /cursor must advance/,
  );
  assert.equal(reads, 2);
  assert.equal(closed, true);
});
