import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { createServer } from "vite-plus";
import { fileURLToPath } from "node:url";
import { parseEndpointLink } from "../renderer/src/mobile/device-store.mjs";
import { MobileClient } from "../renderer/src/mobile/mobile-client.mjs";

const hostA = "A".repeat(40);
const hostB = "B".repeat(40);
const room = "b".repeat(64);
const invite = "c".repeat(64);

function makeShell(projectIds) {
  return {
    connectionId: "conn-1",
    gatewayGeneration: "gw-1",
    subscriptionId: "sub-1",
    sequence: 0,
    snapshot: {
      projects: projectIds.map((id) => ({
        projectId: id,
        workspace: `/work/${id}`,
        state: "ready",
        projectless: false,
        serviceGeneration: `sg-${id}`,
        summaries: {
          state: "fresh",
          items: [
            {
              id: `thread-${id}-1`,
              name: `Session ${id}`,
              updatedAt: 1000,
              desktop: { archived: false },
            },
          ],
        },
        attention: { state: "fresh", count: 0 },
      })),
      navigation: [],
    },
  };
}

function makeSession(projectId, threadId, text = "hello") {
  return {
    connectionId: "conn-1",
    gatewayGeneration: "gw-1",
    subscriptionId: `sub-${threadId}`,
    sequence: 0,
    projectId,
    serviceGeneration: `sg-${projectId}`,
    threadId,
    view: "conversation",
    snapshot: {
      thread: {
        id: threadId,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [{ id: "item-1", type: "userMessage", preview: text }],
          },
        ],
      },
      history: { snapshotId: "snap-1", nextCursor: null, complete: true },
    },
  };
}

test("MobileCacheStore caches authorized projects, respects selection toggles, and prunes revoked grants", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../renderer/", import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
  });
  try {
    const { MobileCacheStore } = await vite.ssrLoadModule("/src/mobile/mobile-cache.ts");
    const store = new MobileCacheStore(fakeIndexedDB);

    await store.saveShell(hostA, 1, makeShell(["p1", "p2"]));
    await store.saveSession(hostA, makeSession("p1", "thread-p1-1", "from p1"));
    await store.saveSession(hostA, makeSession("p2", "thread-p2-1", "from p2"));
    await store.saveShell(hostB, 1, makeShell(["p1"]));
    await store.saveSession(hostB, makeSession("p1", "thread-p1-1", "from hostB"));

    assert.equal(
      (await store.loadSession(hostA, "p1", "thread-p1-1")).snapshot.thread.turns[0].items[0]
        .preview,
      "from p1",
    );
    assert.equal(
      (await store.loadSession(hostB, "p1", "thread-p1-1")).snapshot.thread.turns[0].items[0]
        .preview,
      "from hostB",
    );

    // 取消勾选 p2 的离线缓存：立即清理 p2 会话缓存并阻止后续写入。
    await store.toggleProjectCache(hostA, "p2", false);
    assert.equal(await store.loadSession(hostA, "p2", "thread-p2-1"), undefined);
    await store.saveSession(hostA, makeSession("p2", "thread-p2-2", "ignored"));
    assert.equal(await store.loadSession(hostA, "p2", "thread-p2-2"), undefined);

    // 授权缩窄（p2 从电脑授权里被移出）：自动清理并保留 p1。
    await store.saveShell(hostA, 2, makeShell(["p1"]));
    const view = await store.loadView(hostA);
    assert.deepEqual(
      view.meta.shell.snapshot.projects.map((p) => p.projectId),
      ["p1"],
    );
    assert.ok(await store.loadSession(hostA, "p1", "thread-p1-1"));

    // 清除 hostA 不影响 hostB 缓存。
    await store.clearHost(hostA);
    assert.equal(await store.loadShell(hostA), undefined);
    assert.ok(await store.loadSession(hostB, "p1", "thread-p1-1"));
  } finally {
    await vite.close();
  }
});

test("HostClient populates stale shell & session from cache before network ready", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../renderer/", import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
  });
  try {
    const { HostClient } = await vite.ssrLoadModule(
      fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url)),
    );
    const cachedShell = makeShell(["p1"]);
    const cachedSession = makeSession("p1", "thread-p1-1", "cached-offline-message");
    const client = new HostClient({
      bootstrap: () => new Promise(() => {}),
      origin: "capacitor://localhost",
      transport: () => new Promise(() => {}),
      cache: {
        loadShell: async () => cachedShell,
        loadSession: async ({ projectId, threadId }) =>
          projectId === "p1" && threadId === "thread-p1-1" ? cachedSession : undefined,
      },
    });
    client.retry();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.readsSnapshot().shell.state, "stale");
    assert.equal(client.readsSnapshot().shell.value.snapshot.projects[0].projectId, "p1");

    await client.selectSession({ projectId: "p1", threadId: "thread-p1-1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.readsSnapshot().session.state, "stale");
    assert.equal(client.readsSnapshot().session.value.threadId, "thread-p1-1");
    client.close();
  } finally {
    await vite.close();
  }
});

test("MobileClient reconnects on GRANT_CHANGED, purges cache on AUTH_REVOKED, and updates local endpoint", async () => {
  let stored = JSON.stringify({
    schema: 1,
    relayOrigin: "http://192.168.1.10:47820",
    grantRevision: 1,
    client: {
      schema: 1,
      revision: "rev-1",
      credential: {
        instance: "inst-1",
        identity: "opaque",
        peerId: "peer-1",
        hostId: hostA,
        relayRoom: room,
      },
      locators: [],
    },
  });
  const client = new MobileClient({
    clientKind: "ios",
    keychain: {
      load: async () => ({ value: stored }),
      save: async ({ value }) => {
        stored = value;
      },
      clear: async () => {
        stored = null;
      },
      deviceName: async () => ({ name: "iPhone" }),
    },
  });
  client.identities.identityId = () => "peer-1";
  client.active = true;

  let revokedHost;
  client.onRevoked = (id) => {
    revokedHost = id;
  };
  client.pairedHostId = hostA;
  client.failure(Object.assign(new Error("GRANT_CHANGED"), { code: "GRANT_CHANGED" }), true);
  assert.equal(client.snapshot().kind, "offline");
  clearTimeout(client.retry);

  client.failure(Object.assign(new Error("AUTH_REVOKED"), { code: "AUTH_REVOKED" }), true);
  assert.equal(client.snapshot().kind, "revoked");
  assert.equal(revokedHost, hostA);

  // parseEndpointLink accepts reconnect links without invite for local relay.
  const endpoint = parseEndpointLink(
    `http://192.168.1.99:47820/#host=${hostA}&room=${room}&local=1`,
  );
  assert.equal(endpoint.relayOrigin, "http://192.168.1.99:47820");
  assert.equal(endpoint.host, hostA);
  // Mismatched host update is rejected without corrupting device store.
  await client.identities.restore();
  await assert.rejects(
    client.updateEndpoint(`http://192.168.1.99:47820/#host=${hostB}&room=${room}&local=1`),
    /HOST_MISMATCH/,
  );
  let reconnectedTo = null;
  client.connect = async (target) => {
    reconnectedTo = target.relayOrigin;
  };
  await client.updateEndpoint(
    `http://192.168.1.99:47820/#host=${hostA}&room=${room}&local=1`,
  );
  assert.equal(reconnectedTo, "http://192.168.1.99:47820");
  assert.equal(JSON.parse(stored).relayOrigin, "http://192.168.1.99:47820");
  client.disconnect();
});
