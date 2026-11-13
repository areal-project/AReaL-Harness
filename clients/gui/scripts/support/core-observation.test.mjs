import assert from "node:assert/strict";
import test from "node:test";
import { readCoreThread } from "./core-observation.mjs";

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
