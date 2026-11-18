import assert from "node:assert/strict";
import test from "node:test";
import { MobileWorkspace } from "../renderer/src/mobile/mobile-workspace.mjs";

test("lists only Host-authorized projects and appends the requested session page", async (t) => {
  const requests = [];
  const ready = {
    connectionId: "connection",
    gatewayGeneration: "gateway",
    capabilities: ["observe"],
  };
  const client = {
    connection: { ready },
    snapshot: () => ({ kind: "connected", ready }),
    subscribe: () => () => {},
    async request(envelope) {
      requests.push(envelope);
      if (envelope.method === "project.list") {
        return { projects: [{ projectId: "p", name: "Authorized", connectionState: "online" }] };
      }
      assert.equal(envelope.method, "work.list");
      assert.deepEqual(envelope.context, { projectId: "p" });
      assert.equal(envelope.params.limit, 5);
      const next = envelope.params.cursor === "next-page";
      return {
        serviceGeneration: "core",
        data: Array.from({ length: 5 }, (_, index) => {
          const rank = (next ? 5 : 0) + index;
          return { kind: "session", threadId: `session-${rank}`, sourceUpdatedAt: 10 - rank };
        }),
        nextCursor: next ? null : "next-page",
      };
    },
  };
  const workspace = new MobileWorkspace(client);
  t.after(() => workspace.dispose());
  await workspace.refresh();
  assert.deepEqual(
    workspace.snapshot().projects.map((project) => project.projectId),
    ["p"],
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ["project.list"],
  );
  await workspace.navigate({ kind: "work", projectId: "p" });
  assert.equal(workspace.snapshot().groups.p.data.length, 5);
  await workspace.more();
  await workspace.more();
  assert.deepEqual(
    requests.map((request) => request.params.cursor),
    [undefined, undefined, "next-page"],
  );
  assert.deepEqual(
    workspace.snapshot().groups.p.data.map((row) => row.threadId),
    Array.from({ length: 10 }, (_, rank) => `session-${rank}`),
  );
  assert.equal(workspace.snapshot().groups.p.nextCursor, null);
  await workspace.navigate({ kind: "projects" });
  await workspace.navigate({ kind: "work", projectId: "p" });
  assert.equal(workspace.snapshot().groups.p.data[7].threadId, "session-7");
  assert.equal(workspace.snapshot().groups.p.nextCursor, null);
});

test("same-device reconnection keeps the conversation visible until a fresh baseline arrives", async (t) => {
  const ready = {
    hostId: "host",
    grantRevision: 1,
    gatewayGeneration: "gateway",
    connectionId: "first",
  };
  let state = { kind: "connected", ready, hostId: ready.hostId };
  let listener;
  const response = Promise.withResolvers();
  const client = {
    connection: { ready },
    snapshot: () => state,
    subscribe: (callback) => {
      listener = callback;
      return () => {};
    },
    async request({ method }, onResult) {
      if (method === "project.list") return { projects: [] };
      assert.equal(method, "session.open");
      onResult(await response.promise);
    },
  };
  const workspace = new MobileWorkspace(client);
  t.after(() => workspace.dispose());
  listener();
  await Promise.resolve();
  const page = { kind: "session", projectId: "project", threadId: "thread" };
  const turns = [{ id: "turn", items: [] }];
  workspace.publish({ page, turns });
  state = { kind: "offline", hostId: ready.hostId };
  client.connection = null;
  listener();
  assert.equal(workspace.snapshot().stale, true);
  assert.equal(workspace.snapshot().page, page);
  assert.equal(workspace.snapshot().turns, turns);

  const next = { ...ready, connectionId: "second" };
  state = { kind: "connected", ready: next, hostId: ready.hostId };
  client.connection = { ready: next };
  listener();
  assert.equal(workspace.snapshot().turns, turns);
  response.resolve({
    ...next,
    projectId: "project",
    sequence: 0,
    snapshot: { threadId: "thread", history: {}, turns: [] },
  });
  await new Promise(setImmediate);
  assert.equal(workspace.snapshot().stale, false);
  assert.equal(workspace.snapshot().detail.connectionId, "second");
  assert.equal(workspace.snapshot().page, page);

  state = { kind: "offline", hostId: ready.hostId, grantChanged: true };
  client.connection = null;
  listener();
  assert.equal(workspace.snapshot().stale, false);
  assert.equal(workspace.snapshot().accessChanged, true);
  assert.equal(workspace.snapshot().detail, null);
  assert.deepEqual(workspace.snapshot().turns, []);
});

test("shows a stopped project's saved session summaries without starting it", async (t) => {
  const ready = {
    connectionId: "connection",
    gatewayGeneration: "gateway",
    capabilities: ["observe"],
  };
  const client = {
    connection: { ready },
    snapshot: () => ({ kind: "connected", ready }),
    subscribe: () => () => {},
    request: async () => assert.fail("reading saved summaries must not activate execution"),
  };
  const workspace = new MobileWorkspace(client);
  t.after(() => workspace.dispose());
  workspace.publish({ projects: [{ projectId: "alias", connectionState: "offline" }] });
  workspace.shell = {
    snapshot: {
      projects: [
        {
          projectId: "canonical",
          alias: { projectId: "alias" },
          state: "stopped",
          summaries: {
            items: Array.from({ length: 7 }, (_, index) => ({
              id: `saved-${index}`,
              name: `Saved conversation ${index}`,
              updatedAt: 7 - index,
            })),
          },
        },
      ],
    },
  };
  await workspace.navigate({ kind: "work", projectId: "alias" });
  assert.equal(workspace.snapshot().groups.alias.data[0].title, "Saved conversation 0");
  assert.equal(workspace.snapshot().groups.alias.data.length, 5);
  await workspace.more();
  assert.equal(workspace.snapshot().groups.alias.data.length, 7);
  assert.equal(workspace.snapshot().groups.alias.nextCursor, null);
  assert.equal(workspace.snapshot().error, false);
});
