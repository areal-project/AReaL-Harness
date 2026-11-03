import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { MobileWorkspace } from "../renderer/src/mobile/mobile-workspace.mjs";
const require = createRequire(import.meta.url);
const { historyPage } = require("../app/src/core/remote-session-projection.cjs");
const scope = ["project", "service", "subscription", "thread"];
const turn = (index) => ({
  id: `t${index}`,
  status: "completed",
  items: [{ id: `i${index}`, type: "agentMessage", text: `message ${index}` }],
});
function fixture() {
  const thread = {
    id: "thread",
    turns: Array.from({ length: 200 }, (_, index) => turn(index + 1)),
  };
  const keys = {
    projectId: "project",
    connectionId: "connection",
    gatewayGeneration: "gateway",
    serviceGeneration: "service",
    subscriptionId: "subscription",
  };
  let opens = 0;
  const client = {
    subscribe: () => () => {},
    snapshot: () => ({ kind: "connected", ready: keys }),
    connection: { request: async () => ({ closed: true }) },
    request: async (request, onResult) => {
      if (request.method === "session.open") {
        opens++;
        const page = historyPage(thread, scope);
        const value = {
          ...keys,
          sequence: 0,
          snapshot: { threadId: thread.id, turns: page.turns, history: page },
        };
        onResult(value);
        return value;
      }
      if (request.method === "session.history")
        return {
          ...keys,
          threadId: thread.id,
          ...historyPage(thread, scope, request.params.cursor),
        };
      throw new Error(request.method);
    },
  };
  const workspace = new MobileWorkspace(client);
  workspace.publish({ page: { kind: "session", projectId: "project", threadId: "thread" } });
  const update = (index, sequence) => {
    thread.turns.push(turn(index));
    const page = historyPage(thread, scope);
    workspace.sessionEvent({
      ...keys,
      event: "session.updated",
      sequence,
      snapshot: { threadId: thread.id, turns: page.turns, history: page },
    });
  };
  return { workspace, client, update, opens: () => opens };
}
for (const historyFirst of [false, true])
  test(`moving live tail retains the old boundary (${historyFirst ? "history first" : "live first"})`, async () => {
    const { workspace, update } = fixture();
    await workspace.refresh();
    if (historyFirst) await workspace.older();
    update(201, 1);
    if (!historyFirst) await workspace.older();
    assert.deepEqual(
      workspace.state.turns.flatMap((value) => value.items.map((item) => item.id)),
      Array.from({ length: 201 }, (_, index) => `i${index + 1}`),
    );
    assert.equal(workspace.historyView().complete, true);
    workspace.dispose();
  });
test("new observation clears an old history request's loading state", async () => {
  const { workspace, client, update, opens } = fixture();
  await workspace.refresh();
  const deferred = Promise.withResolvers();
  const request = client.request;
  client.request = (value, callback) =>
    value.method === "session.history"
      ? deferred.promise.then(() => request(value, callback))
      : request(value, callback);
  const loading = workspace.older();
  update(201, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(opens(), 2);
  deferred.resolve();
  await loading;
  assert.equal(workspace.state.loadingOlder, false);
  await workspace.older();
  assert.equal(workspace.state.turns[0].id, "t2");
  assert.equal(workspace.historyView().complete, false);
  workspace.dispose();
});
test("polling refreshes the first page and preserves expanded rows and cursor", async () => {
  const { workspace, client } = fixture();
  let generation = 0;
  client.request = async ({ params }) =>
    params.cursor
      ? { serviceGeneration: "s", data: [{ threadId: "older" }], nextCursor: "last" }
      : {
          serviceGeneration: "s",
          data: [{ threadId: "newest", generation: generation++ }],
          nextCursor: "older",
        };
  workspace.publish({ page: { kind: "work", projectId: "project" } });
  await workspace.refresh();
  await workspace.more();
  await workspace.refresh(true);
  assert.deepEqual(
    workspace.state.groups.project.data.map((row) => row.threadId),
    ["newest", "older"],
  );
  assert.equal(workspace.state.groups.project.data[0].generation, 1);
  assert.equal(workspace.state.groups.project.nextCursor, "last");
  workspace.dispose();
});

test("clearing a device discards navigation targets from the previous computer", async () => {
  const { workspace, client } = fixture();
  await workspace.refresh();
  client.snapshot = () => ({ kind: "unpaired", cleared: true });
  workspace.connectionChanged();
  assert.deepEqual(workspace.state.page, { kind: "projects" });
  assert.equal(workspace.state.detail, null);
  assert.deepEqual(workspace.state.turns, []);
  assert.deepEqual(workspace.visibleTurns, []);
  workspace.dispose();
});

test("work pages and refreshes merge by modification time descending", async () => {
  const { workspace, client } = fixture();
  let refreshed = false;
  client.request = async ({ params }) =>
    params.cursor
      ? {
          serviceGeneration: "s",
          data: [{ threadId: "older", sourceUpdatedAt: 100 }],
          nextCursor: "last",
        }
      : {
          serviceGeneration: "s",
          data: [
            { threadId: "recent", sourceUpdatedAt: 300 },
            { threadId: "updated", sourceUpdatedAt: refreshed ? 400 : 200 },
          ],
          nextCursor: "older",
        };
  workspace.publish({ page: { kind: "work", projectId: "project" } });
  await workspace.refresh();
  await workspace.more();
  assert.deepEqual(
    workspace.state.groups.project.data.map((row) => row.threadId),
    ["recent", "updated", "older"],
  );
  refreshed = true;
  await workspace.refresh(true);
  assert.deepEqual(
    workspace.state.groups.project.data.map((row) => row.threadId),
    ["updated", "recent", "older"],
  );
  assert.equal(workspace.state.groups.project.nextCursor, "last");
  workspace.dispose();
});

if (!process.env.RC12_TLS_HOME) {
  test(
    "Rust Host mobile workspace source uses the isolated process CA",
    { timeout: 300000 },
    async () => {
      const { runWithIsolatedCA } = await import("./remote-native-push-fixture.mjs");
      await runWithIsolatedCA(import.meta.filename);
    },
  );
} else {
  test(
    "production MobileClient preserves Rust history, live tail and late response identity",
    { timeout: 240000 },
    async (t) => {
      const { nativeMobileWorkspace } = await import("./mobile-workspace-native-fixture.mjs");
      await nativeMobileWorkspace(t);
    },
  );
}
