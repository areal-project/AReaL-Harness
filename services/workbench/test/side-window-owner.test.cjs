"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { SideWindowOwners } = require("../src/backend-main.cjs");

test("window close waits for its own creation and cannot close another connection's child", async () => {
  const owners = new SideWindowOwners();
  let resolveCreate;
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    if (request.operation === "create" && request.requestId === "a")
      return new Promise((resolve) => {
        resolveCreate = resolve;
      });
    if (request.operation === "create")
      return { threadId: "child-b", requestId: request.requestId };
    if (request.operation === "close")
      return { cleanupConfirmed: true, requestId: request.requestId, threadId: request.threadId };
    throw Error("unexpected request");
  };
  const a = owners.command(
    "window-a",
    { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "a" },
    execute,
  );
  await Promise.resolve();
  await owners.command(
    "window-b",
    { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "b" },
    execute,
  );
  let settled = false;
  const closing = owners.command("window-a", { operation: "closeOwned" }, execute).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(
    owners.command(
      "window-a",
      { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "late" },
      execute,
    ),
    /窗口正在关闭/,
  );
  for (const operation of ["close", "recover"]) {
    await assert.rejects(
      owners.command(
        "window-a",
        { operation, projectId: "p", threadId: "child-a", requestId: "other" },
        execute,
      ),
      /窗口正在关闭/,
    );
  }
  assert.equal(calls.length, 2);
  resolveCreate({ threadId: "child-a", requestId: "a" });
  await a;
  await closing;
  assert.deepEqual(
    calls.filter((call) => call.operation === "close").map((call) => call.threadId),
    ["child-a"],
  );
  await owners.command("window-b", { operation: "closeOwned" }, execute);
  assert.deepEqual(
    calls.filter((call) => call.operation === "close").map((call) => call.threadId),
    ["child-a", "child-b"],
  );
});

test("unknown close is reconciled using its original request and never replayed", async () => {
  const owners = new SideWindowOwners();
  const calls = [];
  let closeId;
  const execute = async (request) => {
    calls.push(request);
    if (request.operation === "create") return { threadId: "child", requestId: request.requestId };
    if (request.operation === "close") {
      closeId = request.requestId;
      throw Error("response lost");
    }
    if (request.operation === "recover")
      return {
        confirmed: true,
        cleanupConfirmed: true,
        requestId: request.requestId,
        threadId: request.threadId,
      };
    throw Error("unexpected request");
  };
  await owners.command(
    "window",
    { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "create" },
    execute,
  );
  await assert.rejects(
    owners.command("window", { operation: "closeOwned" }, execute),
    /response lost/,
  );
  await owners.command("window", { operation: "closeOwned" }, execute);
  assert.equal(calls.filter((call) => call.operation === "close").length, 1);
  assert.deepEqual(calls.at(-1), {
    operation: "recover",
    method: "areal/side/close",
    projectId: "p",
    threadId: "child",
    requestId: closeId,
  });
});

test("window close waits for an explicit close already in flight", async () => {
  const owners = new SideWindowOwners();
  let release;
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    if (request.operation === "create") return { threadId: "child", requestId: request.requestId };
    if (request.operation === "close")
      return new Promise((resolve) => {
        release = resolve;
      });
    throw Error("must not reconcile while close is in flight");
  };
  await owners.command(
    "window",
    { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "create" },
    execute,
  );
  const explicit = owners.command(
    "window",
    { operation: "close", projectId: "p", threadId: "child", requestId: "close" },
    execute,
  );
  await Promise.resolve();
  const windowClose = owners.command("window", { operation: "closeOwned" }, execute);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  release({ cleanupConfirmed: true, requestId: "close", threadId: "child" });
  await explicit;
  await windowClose;
  assert.equal(calls.length, 2);
});

test("rejects rebound create identity and preserves unknown owner on disconnect", async () => {
  const owners = new SideWindowOwners();
  const execute = async () => {
    throw Error("lost");
  };
  await assert.rejects(
    owners.command(
      "window",
      { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "create" },
      execute,
    ),
    /lost/,
  );
  await assert.rejects(
    owners.command(
      "window",
      { operation: "create", projectId: "other", sourceThreadId: "parent", requestId: "create" },
      execute,
    ),
    /身份不匹配/,
  );
  owners.disconnect("window", async () => ({ confirmed: false }));
  await assert.rejects(
    owners.command("window", { operation: "closeOwned" }, async () => ({ confirmed: false })),
    /待核对/,
  );
  await assert.rejects(owners.command("window", { operation: "openOwned" }, execute), /仍在结算/);
});

test("disconnect fences and closes a late accepted creation on the original owner", async () => {
  const owners = new SideWindowOwners();
  let release;
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    if (request.operation === "create")
      return new Promise((resolve) => {
        release = resolve;
      });
    if (request.operation === "close")
      return { requestId: request.requestId, threadId: request.threadId, cleanupConfirmed: true };
    throw Error("unexpected request");
  };
  const creation = owners.command(
    "original",
    { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "create" },
    execute,
  );
  await Promise.resolve();
  owners.disconnect("original", execute);
  const settled = owners.command("original", { operation: "closeOwned" }, execute);
  release({ requestId: "create", threadId: "child" });
  await creation;
  await settled;
  assert.deepEqual(
    calls.map((item) => item.operation),
    ["create", "close"],
  );
  assert.equal(calls[1].threadId, "child");
});

test("mismatched close receipt preserves original owner for reconciliation", async () => {
  const owners = new SideWindowOwners();
  const execute = async (request) =>
    request.operation === "create"
      ? { requestId: request.requestId, threadId: "child" }
      : { requestId: request.requestId, threadId: "other", cleanupConfirmed: true };
  await owners.command(
    "window",
    { operation: "create", projectId: "p", sourceThreadId: "parent", requestId: "create" },
    execute,
  );
  await assert.rejects(owners.command("window", { operation: "closeOwned" }, execute), /待核对/);
  assert.equal(owners.owner("window").entries.size, 1);
});

test("unconfirmed creation remains owned; confirmed original failure releases it", async () => {
  const owners = new SideWindowOwners();
  const request = {
    operation: "create",
    projectId: "p",
    sourceThreadId: "parent",
    requestId: "create",
  };
  await assert.rejects(
    owners.command("window", request, async () => {
      throw Error("lost");
    }),
    /lost/,
  );
  const unconfirmed = await owners.command(
    "window",
    { ...request, operation: "recover", method: "areal/side/create" },
    async () => ({ confirmed: false }),
  );
  assert.equal(unconfirmed.confirmed, false);
  await assert.rejects(
    owners.command("window", { operation: "closeOwned" }, async () => ({ confirmed: false })),
    /待核对/,
  );
  const result = await owners.command("window", { operation: "closeOwned" }, async (value) => ({
    confirmed: true,
    requestId: value.requestId,
    status: "failed",
    accepted: false,
  }));
  assert.equal(result.settled, true);
  assert.equal(owners.owner("window").entries.size, 0);
});
