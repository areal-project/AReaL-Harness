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
