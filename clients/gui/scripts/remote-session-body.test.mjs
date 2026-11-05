import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const {
  snapshot,
  update,
} = require("@areal/workbench-service/desktop/core/remote-session-projection.cjs");
const {
  SessionObservers,
} = require("@areal/workbench-service/desktop/core/remote-session-observer.cjs");
const longText = "完整正文 😀 界\n".repeat(20000) + "正文结束_END";
const thread = {
  id: "t",
  turns: [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "answer", type: "agentMessage", text: longText },
        {
          id: "tool",
          type: "dynamicToolCall",
          tool: "run_command",
          arguments: { command: "printf TOOL_RESULT_END" },
          contentItems: [{ type: "inputText", text: "TOOL_RESULT_END" }],
          execution: { outcome: "succeeded", exitCode: 0, privateToken: "NEVER_EXPORT" },
        },
        { id: "hidden", type: "modelContext", text: "NEVER_EXPORT" },
      ],
    },
  ],
};
test("long public text is available remotely, including streamed overflow", () => {
  const view = snapshot(thread, ["p", "svc", "g", "t"], { kind: "ordinary" });
  assert.equal(view.turns[0].items[0].bodyDetail.state, "available");
  const live = snapshot({ id: "t", turns: [] }, ["p", "svc", "g", "t"], { kind: "ordinary" });
  update(
    live,
    "item/agentMessage/delta",
    { threadId: "t", turnId: "turn", itemId: "answer", delta: longText },
    ["p", "svc", "g", "t"],
  );
  assert.equal(live.turns[0].items[0].bodyDetail.state, "available");
});
function fixture() {
  const grant = {
    devicePeerId: "peer",
    status: "active",
    revision: 1,
    projectIds: ["p"],
    capabilities: ["observe"],
  };
  const project = {
    client: {
      ready: true,
      capabilities: {
        features: { atomicObserve: true, atomicObserveOwnership: true, subscriptionRemoval: true },
      },
    },
    model: { state: { connected: true } },
    service: { serviceId: "svc", generation: "g" },
  };
  const remote = {
    gatewayGeneration: "gw",
    config: { deviceGrants: [grant] },
    backend: { saved: [{ id: "p" }], projects: new Map([["p", project]]) },
  };
  const connection = {
    connectionId: "c",
    peer: "peer",
    grantRevision: 1,
    gatewayGeneration: "gw",
    alive: () => true,
  };
  const observers = new SessionObservers(remote);
  const entry = {
    projectId: "p",
    project,
    desktop: project.client,
    serviceId: "svc",
    generation: "g",
    gatewayGeneration: "gw",
    endpoint: undefined,
    token: undefined,
    threads: new Map(),
  };
  const observed = { id: "t", viewers: new Set() };
  const viewer = { connection, entry, thread: observed, id: "sub", published: true };
  observed.viewers.add(viewer);
  observers.viewers.set("c", viewer);
  observers.enqueue = async (_entry, work) => work();
  let reads = 0;
  observers.rpc = async (_entry, method, params, onResult) => {
    assert.equal(method, "thread/read");
    assert.equal(params.threadId, "t");
    reads++;
    const r = { thread: structuredClone(thread) };
    onResult?.(r);
    return r;
  };
  const read = (params = {}, projectId = "p") =>
    observers.body(
      connection,
      projectId,
      { threadId: "t", turnId: "turn", itemId: "answer", ...params },
      (x) => x,
    );
  return {
    observers,
    grant,
    project,
    viewer,
    read,
    reads: () => reads,
    close: () => {
      clearInterval(observers.timer);
    },
  };
}
test("full Unicode body is paged from one frozen public snapshot and excludes private metadata", async () => {
  const f = fixture();
  try {
    let page = await f.read();
    let encoded = page.body.chunk;
    const first = page;
    while (page.nextCursor) {
      page = await f.read({ cursor: page.nextCursor });
      assert.ok(Buffer.byteLength(page.body.chunk) <= 32768);
      encoded += page.body.chunk;
    }
    assert.equal(JSON.parse(encoded).text, longText);
    assert.equal(Buffer.byteLength(encoded), first.body.totalBytes);
    assert.equal(f.reads(), 1);
    const tool = await f.read({ itemId: "tool" });
    const body = JSON.parse(tool.body.chunk);
    assert.deepEqual(body.arguments, { command: "printf TOOL_RESULT_END" });
    assert.equal(body.contentItems[0].text, "TOOL_RESULT_END");
    assert.ok(!JSON.stringify(tool).includes("NEVER_EXPORT"));
    await assert.rejects(f.read({ itemId: "hidden" }), { code: "FORBIDDEN" });
  } finally {
    f.close();
  }
});
test("body cursor cannot cross items, projects, subscriptions, generations or a revoked grant", async () => {
  const f = fixture();
  try {
    const page = await f.read();
    assert.ok(page.nextCursor);
    await assert.rejects(f.read({ itemId: "tool", cursor: page.nextCursor }), {
      code: "RESYNC_REQUIRED",
    });
    await assert.rejects(f.read({}, "other"), { code: "INVALID_PARAMS" });
    f.grant.status = "revoked";
    await assert.rejects(f.read({ cursor: page.nextCursor }), { code: "GRANT_CHANGED" });
    f.grant.status = "active";
    f.project.service.generation = "new";
    await assert.rejects(f.read({ cursor: page.nextCursor }), { code: "RESYNC_REQUIRED" });
    f.project.service.generation = "g";
    f.observers.viewers.delete("c");
    await assert.rejects(f.read({ cursor: page.nextCursor }), { code: "INVALID_PARAMS" });
  } finally {
    f.close();
  }
});
test("revocation during native body read publishes nothing", async () => {
  const f = fixture();
  try {
    let published = false;
    f.observers.rpc = async () => {
      f.grant.status = "revoked";
      return { thread };
    };
    await assert.rejects(
      f.observers.body(
        f.viewer.connection,
        "p",
        { threadId: "t", turnId: "turn", itemId: "answer" },
        () => (published = true),
      ),
      { code: "GRANT_CHANGED" },
    );
    assert.equal(published, false);
  } finally {
    f.close();
  }
});
