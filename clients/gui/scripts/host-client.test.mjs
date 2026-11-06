import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
const buildRequire = createRequire(new URL("../packages/gen-ui/package.json", import.meta.url));
const { WebSocketServer } = appRequire("ws");
const { outputFiles } = await buildRequire("esbuild").build({
  entryPoints: [fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { HostClient, readHostBootstrap } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const hostId = "ae883ffd-144b-4092-bb4c-c7b719bd9d06";
const generation = "dd6013a2-dfd2-42d5-afb9-f90e78af0dfe";
const origin = "areal-ui://app";
const status = {
  hostId,
  generation,
  state: "ready",
  projects: [],
  restartPending: false,
  stopIntent: false,
  capabilities: [],
};

async function server(t, respond) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const websocketUrl = `ws://127.0.0.1:${server.address().port}/host/socket`;
  server.on("connection", (socket, request) => {
    assert.equal(request.url, "/host/socket");
    socket.on("message", (bytes) => respond(socket, JSON.parse(bytes.toString())));
  });
  return { server, websocketUrl };
}

function waitState(client, predicate) {
  if (predicate(client.snapshot())) return Promise.resolve(client.snapshot());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Host state deadline"));
    }, 2000);
    const unsubscribe = client.subscribe(() => {
      const state = client.snapshot();
      if (!predicate(state)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    });
  });
}

test("client authenticates in first frame, reads actual WS status and refreshes ticket after disconnect", async (t) => {
  const frames = [];
  let ticket = 0;
  const { server: listener, websocketUrl } = await server(t, (socket, frame) => {
    frames.push(frame);
    if (frame.method === "hello") {
      assert.equal(frame.params.ticket, `private-ticket-${ticket}`);
      socket.send(
        JSON.stringify({
          version: 1,
          id: frame.id,
          result: {
            version: 1,
            hostId,
            generation,
            capabilities: [],
            negotiatedCapabilities: ["gui-read-v1"],
            connectionId: "connection",
            gatewayGeneration: generation,
          },
        }),
      );
    } else if (frame.method === "shell.subscribe") {
      socket.send(
        JSON.stringify({
          version: 1,
          id: frame.id,
          result: {
            connectionId: "connection",
            gatewayGeneration: generation,
            subscriptionId: "shell",
            sequence: 0,
            snapshot: { projects: [], navigation: [] },
          },
        }),
      );
    } else if (frame.method === "shell.unsubscribe") {
      socket.send(JSON.stringify({ version: 1, id: frame.id, result: { closed: true } }));
    } else {
      assert.equal(frame.method, "host.status");
      socket.send(JSON.stringify({ version: 1, id: frame.id, result: status }));
    }
  });
  const client = new HostClient({
    origin,
    bootstrap: async () => ({
      version: 1,
      hostId,
      generation,
      origin,
      websocketUrl,
      ticket: `private-ticket-${++ticket}`,
      expiresAt: Date.now() + 30_000,
    }),
  });
  t.after(() => client.close());
  client.retry();
  const first = await waitState(client, (state) => state.connection === "ready");
  assert.deepEqual(first.value, status);
  const reconnecting = waitState(client, (state) => state.freshness === "stale");
  for (const socket of listener.clients) socket.close();
  assert.deepEqual((await reconnecting).previous, status);
  await waitState(client, (state) => state.connection === "ready");
  assert.equal(ticket, 2);
  assert.deepEqual(
    frames
      .filter((frame) => ["hello", "host.status"].includes(frame.method))
      .map((frame) => frame.method),
    ["hello", "host.status", "hello", "host.status"],
  );
});

test("client refuses a changed Host generation and never exposes it as fresh", async (t) => {
  const { websocketUrl } = await server(t, (socket, frame) => {
    socket.send(
      JSON.stringify({
        version: 1,
        id: frame.id,
        result: { version: 1, hostId, generation: "other", capabilities: [] },
      }),
    );
  });
  const client = new HostClient({
    origin,
    bootstrap: async () => ({
      version: 1,
      hostId,
      generation,
      origin,
      websocketUrl,
      ticket: "private-ticket",
      expiresAt: Date.now() + 30_000,
    }),
  });
  t.after(() => client.close());
  client.retry();
  const result = await waitState(client, (state) => state.connection === "offline");
  assert.equal(result.freshness, "unavailable");
});

test("closed owner discards late bootstrap without opening another connection", async (t) => {
  let resolveBootstrap;
  const { server: listener, websocketUrl } = await server(t, () =>
    assert.fail("closed owner opened a socket"),
  );
  const bootstrap = new Promise((resolve) => {
    resolveBootstrap = resolve;
  });
  const client = new HostClient({ origin, bootstrap: () => bootstrap });
  client.retry();
  client.close();
  resolveBootstrap({
    version: 1,
    hostId,
    generation,
    origin,
    websocketUrl,
    ticket: "private-ticket",
    expiresAt: Date.now() + 30_000,
  });
  await bootstrap;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listener.clients.size, 0);
});

test("bootstrap rejects credentials in URL and foreign origins before opening transport", () => {
  const base = {
    version: 1,
    hostId,
    generation,
    origin,
    websocketUrl: "ws://127.0.0.1:12345/host/socket",
    ticket: "private-ticket",
    expiresAt: Date.now() + 30_000,
  };
  assert.equal(readHostBootstrap(base), base);
  for (const change of [
    { websocketUrl: base.websocketUrl + "?ticket=private-ticket" },
    { websocketUrl: "ws://user:secret@127.0.0.1:12345/host/socket" },
    { websocketUrl: "ws://example.com/host/socket" },
    { origin: "https://example.com" },
    { expiresAt: Date.now() - 1 },
  ])
    assert.throws(() => readHostBootstrap({ ...base, ...change }));
});

function waitReads(client, predicate) {
  if (predicate(client.readsSnapshot())) return Promise.resolve(client.readsSnapshot());
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("Host read state deadline"));
    }, 2000);
    const stop = client.subscribeReads(() => {
      const state = client.readsSnapshot();
      if (!predicate(state)) return;
      clearTimeout(deadline);
      stop();
      resolve(state);
    });
  });
}
const project = {
  projectId: "canonical-project",
  workspace: "/workspace",
  projectless: false,
  state: "ready",
  serviceGeneration: "core-1",
  summaries: {
    state: "fresh",
    items: [{ id: "thread", desktop: { archived: false }, name: "Native title" }],
  },
  attention: { state: "unknown" },
};
const nativeObservation = (threadId) => ({
  thread: {
    id: threadId,
    name: "Native title",
    turns: [
      {
        id: "turn1",
        status: "completed",
        items: [
          {
            id: "item1",
            type: "dynamicToolCall",
            arguments: { nested: ["untouched", 42] },
            media: [{ type: "image", source: "core-owned" }],
          },
        ],
      },
      {
        id: "turn2",
        status: "inProgress",
        items: [{ id: "item2", type: "agentMessage", text: "before" }],
      },
    ],
  },
  history: { snapshotId: "native-history", nextCursor: "opaque-core-cursor", complete: false },
  ownership: { sourceThreadId: "native-source" },
});
async function readServer(t, handler = () => false) {
  let socket,
    shellSubscriptions = 0,
    sessionSubscriptions = 0,
    sessionSequence = 0;
  const frames = [];
  const envelope = (frame, result) =>
    socket.send(JSON.stringify({ version: 1, id: frame.id, result }));
  const identity = () => ({ connectionId: "read-connection", gatewayGeneration: generation });
  const sessionIdentity = (threadId) => ({
    ...identity(),
    projectId: project.projectId,
    serviceGeneration: "core-1",
    threadId,
    view: "conversation",
  });
  const nativePage = {
    snapshotId: "native-history",
    nextCursor: "next-core-cursor",
    complete: false,
    data: [
      {
        sourceThreadId: "source-thread",
        sourceTurnId: "source-turn",
        sourceItemId: "source-item",
        sourceTurnStatus: "completed",
        turn: { id: "source-turn" },
        item: {
          id: "source-item",
          type: "userMessage",
          content: [{ type: "image", data: "preserved" }],
        },
      },
    ],
  };
  const listener = await server(t, (connection, frame) => {
    socket = connection;
    frames.push(frame);
    if (handler({ frame, reply: (result) => envelope(frame, result), sessionIdentity, frames }))
      return;
    switch (frame.method) {
      case "hello":
        envelope(frame, {
          version: 1,
          hostId,
          generation,
          capabilities: [],
          negotiatedCapabilities: ["gui-read-v1"],
          ...identity(),
        });
        break;
      case "host.status":
        envelope(frame, status);
        break;
      case "shell.subscribe":
        envelope(frame, {
          ...identity(),
          subscriptionId: `shell-${++shellSubscriptions}`,
          sequence: 0,
          snapshot: { projects: [project], navigation: [] },
        });
        break;
      case "session.open":
        envelope(frame, {
          ...sessionIdentity(frame.params.threadId),
          subscriptionId: `session-${++sessionSubscriptions}`,
          sequence: 0,
          snapshot: nativeObservation(frame.params.threadId),
        });
        break;
      case "session.history":
        envelope(frame, {
          ...sessionIdentity(frame.params.threadId),
          subscriptionId: frame.params.subscriptionId,
          sequence: sessionSequence,
          page: nativePage,
        });
        break;
      case "subscription.close":
      case "shell.unsubscribe":
        envelope(frame, { closed: true });
        break;
      default:
        assert.fail(`Unexpected method ${frame.method}`);
    }
  });
  const client = new HostClient({
    origin,
    bootstrap: async () => ({
      version: 1,
      hostId,
      generation,
      origin,
      websocketUrl: listener.websocketUrl,
      ticket: "private-ticket",
      expiresAt: Date.now() + 30_000,
    }),
  });
  t.after(() => client.close());
  client.retry();
  await waitReads(client, (state) => state.shell.state === "fresh");
  return {
    client,
    frames,
    listener: listener.server,
    nativePage,
    send: (event) => {
      if (event.event === "session.updated") sessionSequence = event.sequence;
      socket.send(JSON.stringify({ version: 1, method: event.event, params: event }));
    },
  };
}

test("concurrent selection of the same conversation shares one subscription", async (t) => {
  const { client, frames } = await readServer(t);
  const target = { projectId: project.projectId, threadId: "thread" };
  await Promise.all([client.selectSession(target), client.selectSession(target)]);
  assert.equal(client.readsSnapshot().session.state, "fresh");
  await client.selectSession(target);
  assert.equal(frames.filter((frame) => frame.method === "session.open").length, 1);
  assert.equal(frames.filter((frame) => frame.method === "subscription.close").length, 0);
});

test("UI restoration joins the selected conversation's automatic reconnect", async (t) => {
  const { client, frames, listener } = await readServer(t);
  const target = { projectId: project.projectId, threadId: "thread" };
  await client.selectSession(target);
  const oldShell = client.readsSnapshot().shell.value.subscriptionId;
  const restored = waitReads(
    client,
    (state) => state.shell.state === "fresh" && state.shell.value.subscriptionId !== oldShell,
  );
  for (const socket of listener.clients) socket.terminate();
  await restored;
  await client.selectSession(target);
  assert.equal(client.readsSnapshot().session.state, "fresh");
  assert.equal(frames.filter((frame) => frame.method === "session.open").length, 2);
  assert.equal(frames.filter((frame) => frame.method === "subscription.close").length, 0);
});

test("page events are bound to the ready connection and stop after unsubscribe", async (t) => {
  const { client, send } = await readServer(t);
  const events = [];
  const page = {
    event: "pages.event",
    connectionId: "read-connection",
    gatewayGeneration: generation,
    token: "page",
    notification: { jsonrpc: "2.0", method: "ui/notifications/test" },
  };
  let accepted;
  const arrived = new Promise((resolve) => {
    accepted = resolve;
  });
  const off = client.subscribePageEvents((event) => {
    events.push(event);
    accepted();
  });
  send({ ...page, connectionId: "old-connection" });
  send({ ...page, gatewayGeneration: "old-generation" });
  send({ ...page, notification: [] });
  send(page);
  await arrived;
  assert.deepEqual(events, [page]);
  off();
  const barrier = new Promise((resolve) => client.subscribePageEvents(resolve));
  send({ ...page, token: "next" });
  await barrier;
  assert.equal(events.length, 1);
});

test("one WS multiplexes shell and native session; deltas retain native fields and untouched references", async (t) => {
  const { client, frames, listener, nativePage, send } = await readServer(t);
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  const before = client.readsSnapshot().session.value;
  const unchangedTurn = before.snapshot.thread.turns[0];
  send({
    ...before,
    event: "session.updated",
    sequence: 1,
    snapshot: undefined,
    patch: {
      turns: [
        {
          id: "turn2",
          items: [{ id: "item2", value: { id: "item2", type: "agentMessage", text: "after" } }],
        },
      ],
    },
  });
  const after = (
    await waitReads(
      client,
      (state) => state.session.state === "fresh" && state.session.value.sequence === 1,
    )
  ).session.value;
  assert.equal(after.snapshot.thread.turns[0], unchangedTurn);
  assert.deepEqual(after.snapshot.thread.turns[0].items[0].arguments, {
    nested: ["untouched", 42],
  });
  assert.deepEqual(after.snapshot.thread.turns[0].items[0].media, [
    { type: "image", source: "core-owned" },
  ]);
  assert.equal(after.snapshot.thread.turns[1].items[0].text, "after");
  assert.deepEqual(after.snapshot.history, nativeObservation("thread").history);
  assert.deepEqual(
    await client.history({ view: "inherited", cursor: "opaque:core/source", maxBytes: 65536 }),
    nativePage,
  );
  const history = frames.find((frame) => frame.method === "session.history");
  assert.deepEqual(history.context, { projectId: project.projectId, serviceGeneration: "core-1" });
  assert.equal(history.params.cursor, "opaque:core/source");
  assert.equal(listener.clients.size, 1);
  assert.equal(frames.filter((frame) => frame.method === "hello").length, 1);
  assert.ok(
    frames.every(
      (frame) => !["connect", "project.ensure", "session.send", "command"].includes(frame.method),
    ),
  );
});

test("current sequence gaps resubscribe and ignore old subscription events", async (t) => {
  const { client, send, frames } = await readServer(t);
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  const before = client.readsSnapshot().session.value;
  const transitions = [];
  const stop = client.subscribeReads(() => transitions.push(client.readsSnapshot().session.state));
  send({ ...before, event: "session.updated", sequence: 2, patch: { turns: [] } });
  const recovered = (
    await waitReads(
      client,
      (state) =>
        state.session.state === "fresh" &&
        state.session.value.subscriptionId !== before.subscriptionId,
    )
  ).session.value;
  assert.ok(transitions.includes("stale"));
  assert.equal(recovered.sequence, 0);
  const shell = client.readsSnapshot().shell.value;
  send({
    ...shell,
    event: "shell.updated",
    sequence: 2,
    delta: { projects: { upsert: [], remove: [] }, navigation: { upsert: [], remove: [] } },
  });
  await waitReads(
    client,
    (state) =>
      state.shell.state === "fresh" && state.shell.value.subscriptionId !== shell.subscriptionId,
  );
  const restoredShell = client.readsSnapshot().shell.value;
  send({
    ...restoredShell,
    event: "shell.invalidated",
    sequence: 1,
    error: { code: "SHELL_UNAVAILABLE", message: "refresh" },
  });
  await waitReads(
    client,
    (state) =>
      state.shell.state === "fresh" &&
      state.shell.value.subscriptionId !== restoredShell.subscriptionId,
  );
  send({
    ...before,
    event: "session.updated",
    sequence: 1,
    patch: {
      turns: [{ id: "turn2", items: [{ id: "item2", value: { id: "item2", text: "stale" } }] }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.readsSnapshot().session.value, recovered);
  assert.equal(frames.filter((frame) => frame.method === "shell.subscribe").length, 3);
  assert.equal(frames.filter((frame) => frame.method === "session.open").length, 2);
  stop();
});

test("shell baseline recovery reopens the selected conversation for the new Core generation", async (t) => {
  for (const cause of ["gap", "invalidated"])
    await t.test(cause, async (t) => {
      let subscriptions = 0,
        opens = 0;
      const { client, send } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
        if (frame.method === "shell.subscribe" && ++subscriptions > 1) {
          reply({
            connectionId: "read-connection",
            gatewayGeneration: generation,
            subscriptionId: `replacement-shell-${subscriptions}`,
            sequence: 0,
            snapshot: { projects: [{ ...project, serviceGeneration: "core-2" }], navigation: [] },
          });
          return true;
        }
        if (frame.method === "session.open") {
          reply({
            ...sessionIdentity(frame.params.threadId),
            serviceGeneration: frame.context.serviceGeneration,
            subscriptionId: `replacement-session-${++opens}`,
            sequence: 0,
            snapshot: nativeObservation(frame.params.threadId),
          });
          return true;
        }
        return false;
      });
      await client.selectSession({ projectId: project.projectId, threadId: "thread" });
      const shell = client.readsSnapshot().shell.value;
      send({
        ...shell,
        event: cause === "gap" ? "shell.updated" : "shell.invalidated",
        sequence: cause === "gap" ? 2 : 1,
        delta: { projects: { upsert: [], remove: [] }, navigation: { upsert: [], remove: [] } },
        error: { code: "RESYNC_REQUIRED", message: "Core changed" },
      });
      const recovered = await waitReads(
        client,
        (state) =>
          state.session.state === "fresh" && state.session.value.serviceGeneration === "core-2",
      );
      assert.equal(recovered.session.value.threadId, "thread");
      assert.equal(opens, 2);
    });
});

test("selection cancellation drops late native open and closes its subscription", async (t) => {
  let release, closed;
  const closedRequest = new Promise((resolve) => {
    closed = resolve;
  });
  const { client, frames } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (
      frame.method === "subscription.close" &&
      frame.params.subscriptionId === "late-subscription"
    )
      closed();
    if (frame.method !== "session.open" || frame.params.threadId !== "slow") return false;
    release = () =>
      reply({
        ...sessionIdentity("slow"),
        subscriptionId: "late-subscription",
        sequence: 0,
        snapshot: nativeObservation("slow"),
      });
    return true;
  });
  const slow = client.selectSession({ projectId: project.projectId, threadId: "slow" });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await client.selectSession({ projectId: project.projectId, threadId: "current" });
  release();
  await slow;
  assert.equal(client.readsSnapshot().session.value.threadId, "current");
  await closedRequest;
  assert.ok(
    frames.some(
      (frame) =>
        frame.method === "subscription.close" &&
        frame.params.subscriptionId === "late-subscription",
    ),
  );
});

test("revisiting retains the native snapshot as stale until a new subscription baseline", async (t) => {
  let opens = 0,
    release;
  const { client, frames } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method !== "session.open" || frame.params.threadId !== "thread") return false;
    if (++opens === 1) return false;
    release = () =>
      reply({
        ...sessionIdentity("thread"),
        subscriptionId: "revisited-subscription",
        sequence: 0,
        snapshot: nativeObservation("thread"),
      });
    return true;
  });
  const target = { projectId: project.projectId, threadId: "thread" };
  await client.selectSession(target);
  const before = client.readsSnapshot().session.value;
  await client.selectSession(null);
  const revisit = client.selectSession(target);
  assert.equal(client.readsSnapshot().session.state, "stale");
  assert.equal(client.readsSnapshot().session.value, before);
  await assert.rejects(
    client.history({ view: "own", cursor: before.snapshot.history.nextCursor }),
    /unavailable/,
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await revisit;
  assert.equal(client.readsSnapshot().session.state, "fresh");
  assert.equal(client.readsSnapshot().session.value.subscriptionId, "revisited-subscription");
  assert.equal(frames.filter((frame) => frame.method === "session.history").length, 0);
});

test("left-session snapshots expire after three minutes and evict the least recent beyond eight", async (t) => {
  const { client } = await readServer(t);
  const target = (threadId) => ({ projectId: project.projectId, threadId });
  for (let index = 0; index < 10; ++index) await client.selectSession(target(`thread-${index}`));
  const transitions = [];
  const stop = client.subscribeReads(() => transitions.push(client.readsSnapshot().session));
  await client.selectSession(target("thread-0"));
  assert.equal(transitions[0].state, "loading");
  transitions.length = 0;
  await client.selectSession(target("thread-8"));
  assert.equal(transitions[0].state, "stale");
  assert.equal(transitions[0].value.threadId, "thread-8");
  await client.selectSession(null);
  transitions.length = 0;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 3 * 60 * 1000 + 1);
  await client.selectSession(target("thread-8"));
  assert.equal(transitions[0].state, "loading");
  stop();
});

test("a new Core generation cannot revive a cached old-generation session", async (t) => {
  let core = "core-1";
  const { client, send } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method !== "session.open") return false;
    reply({
      ...sessionIdentity(frame.params.threadId),
      serviceGeneration: core,
      subscriptionId: `session-${core}`,
      sequence: 0,
      snapshot: nativeObservation(frame.params.threadId),
    });
    return true;
  });
  const target = { projectId: project.projectId, threadId: "thread" };
  await client.selectSession(target);
  await client.selectSession(null);
  core = "core-2";
  const shell = client.readsSnapshot().shell.value;
  send({
    ...shell,
    event: "shell.updated",
    sequence: 1,
    delta: {
      projects: { upsert: [{ ...project, serviceGeneration: core }], remove: [] },
      navigation: { upsert: [], remove: [] },
    },
  });
  await waitReads(
    client,
    (state) => state.shell.state === "fresh" && state.shell.value.sequence === 1,
  );
  const transitions = [];
  const stop = client.subscribeReads(() => transitions.push(client.readsSnapshot().session.state));
  await client.selectSession(target);
  assert.equal(transitions[0], "loading");
  assert.equal(client.readsSnapshot().session.value.serviceGeneration, core);
  stop();
});

test("a replacement Host never displays the previous Host cached conversation", async (t) => {
  let hostGeneration = "host-1",
    release;
  const client = new HostClient({
    origin,
    bootstrap: async () => assert.fail("Unused bootstrap"),
    transport: async () => {
      const host = hostGeneration;
      const identity = {
        hostId,
        hostGeneration: host,
        connectionId: `connection-${host}`,
        gatewayGeneration: host,
      };
      return {
        identity,
        transport: {
          close() {},
          async request(method, params) {
            const keys = {
              connectionId: identity.connectionId,
              gatewayGeneration: host,
              sequence: 0,
            };
            if (method === "shell.subscribe")
              return {
                ...keys,
                subscriptionId: `shell-${host}`,
                snapshot: { projects: [project], navigation: [] },
              };
            if (method === "session.open") {
              if (host === "host-2")
                await new Promise((resolve) => {
                  release = resolve;
                });
              return {
                ...keys,
                subscriptionId: `session-${host}`,
                projectId: project.projectId,
                serviceGeneration: "core-1",
                threadId: params.threadId,
                view: "conversation",
                snapshot: nativeObservation(params.threadId),
              };
            }
            return { closed: true };
          },
        },
      };
    },
  });
  t.after(() => client.close());
  client.retry();
  await waitReads(client, (state) => state.shell.state === "fresh");
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  hostGeneration = "host-2";
  client.retry();
  await waitReads(
    client,
    (state) => state.shell.state === "fresh" && state.shell.value.subscriptionId === "shell-host-2",
  );
  assert.equal(client.readsSnapshot().session.state, "loading");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await waitReads(client, (state) => state.session.state === "fresh");
  assert.equal(client.readsSnapshot().session.value.subscriptionId, "session-host-2");
});

test("closing during the native handshake closes the in-progress socket", async (t) => {
  let observed;
  const hello = new Promise((resolve) => {
    observed = resolve;
  });
  const { websocketUrl } = await server(t, (socket, frame) => {
    assert.equal(frame.method, "hello");
    observed(socket);
  });
  const client = new HostClient({
    origin,
    bootstrap: async () => ({
      version: 1,
      hostId,
      generation,
      origin,
      websocketUrl,
      ticket: "private-ticket",
      expiresAt: Date.now() + 30_000,
    }),
  });
  client.retry();
  const socket = await hello;
  const closed = once(socket, "close");
  client.close();
  await closed;
  assert.equal(socket.readyState, socket.CLOSED);
});

test("stopped Core selection is unavailable without reconnecting or waking Core", async (t) => {
  const { client, frames, listener } = await readServer(t, ({ frame, reply }) => {
    if (frame.method !== "shell.subscribe") return false;
    reply({
      connectionId: "read-connection",
      gatewayGeneration: generation,
      subscriptionId: "stopped-shell",
      sequence: 0,
      snapshot: {
        projects: [{ ...project, state: "stopped", serviceGeneration: undefined }],
        navigation: [],
      },
    });
    return true;
  });
  await assert.rejects(
    client.selectSession({ projectId: project.projectId, threadId: "thread" }),
    /Core unavailable/,
  );
  assert.equal(client.snapshot().connection, "ready");
  assert.equal(client.readsSnapshot().shell.state, "fresh");
  assert.equal(client.readsSnapshot().session.state, "unavailable");
  assert.equal(listener.clients.size, 1);
  assert.deepEqual(
    frames.map((frame) => frame.method),
    ["hello", "host.status", "shell.subscribe"],
  );
});

test("native media chunks remain in one session and queue complete images without interleaving", async (t) => {
  const uriA = `areal://blob/${"a".repeat(64)}`,
    uriB = `areal://blob/${"b".repeat(64)}`;
  const bytes = Buffer.from("native-image-bytes");
  const reads = [];
  const { client } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method !== "artifact.read") return false;
    const params = frame.params;
    reads.push({ uri: params.uri, offset: params.offset });
    const part = bytes.subarray(params.offset, Math.min(bytes.length, params.offset + 6));
    reply({
      ...sessionIdentity(params.threadId),
      subscriptionId: params.subscriptionId,
      sequence: 0,
      sourceThreadId: params.sourceThreadId ?? params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      uri: params.uri,
      offset: params.offset,
      totalBytes: bytes.length,
      nextOffset: params.offset + part.length === bytes.length ? null : params.offset + part.length,
      mimeType: "image/png",
      base64: part.toString("base64"),
    });
    return true;
  });
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  const [first, second] = await Promise.all([
    client.media({ uri: uriA, turnId: "turn", itemId: "item-a" }),
    client.media({ uri: uriB, turnId: "turn", itemId: "item-b" }),
  ]);
  assert.deepEqual(Buffer.from(first.bytes), bytes);
  assert.deepEqual(Buffer.from(second.bytes), bytes);
  assert.equal(first.mime, "image/png");
  assert.deepEqual(
    reads.map((read) => read.uri),
    [uriA, uriA, uriA, uriB, uriB, uriB],
  );
  assert.deepEqual(
    reads.map((read) => read.offset),
    [0, 6, 12, 0, 6, 12],
  );
});

test("aborting native media prevents additional chunk reads", async (t) => {
  const abort = new AbortController();
  let reads = 0;
  const uri = `areal://blob/${"a".repeat(64)}`;
  const { client } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method !== "artifact.read") return false;
    ++reads;
    abort.abort();
    reply({
      ...sessionIdentity(frame.params.threadId),
      subscriptionId: frame.params.subscriptionId,
      sequence: 0,
      sourceThreadId: frame.params.threadId,
      turnId: "turn",
      itemId: "item",
      uri,
      offset: 0,
      totalBytes: 2,
      nextOffset: 1,
      mimeType: "image/png",
      base64: "YQ==",
    });
    return true;
  });
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  await assert.rejects(client.media({ uri, turnId: "turn", itemId: "item" }, abort.signal), {
    name: "AbortError",
  });
  assert.equal(reads, 1);
});

test("native media retains generic binary MIME and accepts an empty Core blob", async (t) => {
  const data = Buffer.from("%PDF-1.7\nopaque-document");
  const uri = `areal://blob/${"c".repeat(64)}`,
    emptyUri = `areal://blob/${"d".repeat(64)}`;
  const { client } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method !== "artifact.read") return false;
    const params = frame.params,
      bytes = params.uri === uri ? data : Buffer.alloc(0);
    reply({
      ...sessionIdentity(params.threadId),
      subscriptionId: params.subscriptionId,
      sequence: 0,
      sourceThreadId: params.sourceThreadId ?? params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      uri: params.uri,
      offset: 0,
      totalBytes: bytes.length,
      nextOffset: null,
      mimeType: params.uri === uri ? "application/pdf" : "application/octet-stream",
      base64: bytes.toString("base64"),
    });
    return true;
  });
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  const binary = await client.media({
    uri,
    turnId: "turn",
    itemId: "document",
    sourceThreadId: "inherited-source",
  });
  assert.equal(binary.mime, "application/pdf");
  assert.deepEqual(Buffer.from(binary.bytes), data);
  const empty = await client.media({ uri: emptyUri, turnId: "turn", itemId: "empty" });
  assert.equal(empty.mime, "application/octet-stream");
  assert.equal(empty.bytes.length, 0);
});

test("desktop writes negotiate gui-write-v1, carry the Gateway context and never resend after a lost reply", async (t) => {
  const frames = [];
  const { websocketUrl } = await server(t, (socket, frame) => {
    frames.push(frame);
    const reply = (result) => socket.send(JSON.stringify({ version: 1, id: frame.id, result }));
    if (frame.method === "hello")
      return reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: frame.params.capabilities,
        connectionId: "connection",
        gatewayGeneration: generation,
        writeMethods: ["session.send", "command.read", "attachment.upload"],
        writeLimits: {
          commandTextBytes: 65536,
          attachments: 16,
          uploadChunkBytes: 4,
          uploadBytes: 64,
        },
      });
    if (frame.method === "shell.subscribe")
      return reply({
        connectionId: "connection",
        gatewayGeneration: generation,
        subscriptionId: "shell",
        sequence: 0,
        snapshot: { projects: [project], navigation: [] },
      });
    if (frame.method === "host.status") return reply(status);
    if (frame.method === "session.send" && frame.params.text === "rejected")
      return socket.send(
        JSON.stringify({ version: 1, id: frame.id, error: { code: "TURN_BUSY", message: "busy" } }),
      );
    if (frame.method === "session.send" && frame.params.text === "lost") return socket.close();
    if (frame.method === "session.send")
      return reply({ admissionState: "accepted", turnId: "turn" });
    if (frame.method === "command.read")
      return reply({ commandId: frame.params.commandId, admissionState: "accepted" });
    if (frame.method === "attachment.upload") {
      const received = frame.params.offset + Buffer.from(frame.params.base64, "base64").length;
      return reply({
        uploadId: frame.params.uploadId,
        receivedBytes: received,
        ...(received === frame.params.sizeBytes && {
          attachment: { uri: "areal://blob/abc", mimeType: "text/plain", sizeBytes: received },
        }),
      });
    }
  });
  const client = new HostClient({
    origin,
    writes: true,
    bootstrap: async () => ({
      version: 1,
      hostId,
      generation,
      origin,
      websocketUrl,
      ticket: "private-ticket",
      expiresAt: Date.now() + 30_000,
    }),
  });
  t.after(() => client.close());
  client.retry();
  await waitReads(client, (state) => state.shell.state === "fresh");
  assert.deepEqual(frames[0].params.capabilities, ["gui-read-v1", "gui-write-v1"]);
  assert.equal(client.writable("session.send"), true);
  assert.equal(client.writable("session.create"), false);
  const accepted = await client.command(
    "session.send",
    project.projectId,
    { threadId: "t", expectedConfigRevision: 1, text: "hi" },
    "8f0e1c1e-6b0e-4a7c-9a55-2f1f5c0d6c01",
  );
  assert.deepEqual(accepted, {
    admissionState: "accepted",
    turnId: "turn",
    commandId: "8f0e1c1e-6b0e-4a7c-9a55-2f1f5c0d6c01",
  });
  const sent = frames.find((frame) => frame.method === "session.send");
  assert.deepEqual(sent.context, {
    projectId: project.projectId,
    serviceGeneration: "core-1",
    gatewayGeneration: generation,
    grantRevision: 0,
  });
  assert.equal(sent.commandId, "8f0e1c1e-6b0e-4a7c-9a55-2f1f5c0d6c01");
  await assert.rejects(
    client.command("session.send", project.projectId, {
      threadId: "t",
      expectedConfigRevision: 1,
      text: "rejected",
    }),
    { code: "TURN_BUSY" },
  );
  const lost = await client.command("session.send", project.projectId, {
    threadId: "t",
    expectedConfigRevision: 1,
    text: "lost",
  });
  assert.equal(lost.admissionState, "unknown");
  assert.equal(frames.filter((frame) => frame.params?.text === "lost").length, 1);
  await waitState(client, (state) => state.connection === "ready");
  await waitReads(client, (state) => state.shell.state === "fresh");
  assert.deepEqual(await client.commandStatus(project.projectId, lost.commandId), {
    commandId: lost.commandId,
    admissionState: "accepted",
  });
  assert.equal(frames.filter((frame) => frame.params?.text === "lost").length, 1);
  const uploaded = await client.upload(
    project.projectId,
    "t",
    new TextEncoder().encode("0123456789"),
    "text/plain",
  );
  assert.deepEqual(uploaded, { uri: "areal://blob/abc", mimeType: "text/plain", sizeBytes: 10 });
  const chunks = frames.filter((frame) => frame.method === "attachment.upload");
  assert.deepEqual(
    chunks.map((frame) => [
      frame.params.offset,
      Buffer.from(frame.params.base64, "base64").toString(),
    ]),
    [
      [0, "0123"],
      [4, "4567"],
      [8, "89"],
    ],
  );
  assert.equal(new Set(chunks.map((frame) => frame.params.uploadId)).size, 1);
  assert.ok(chunks.every((frame) => frame.commandId === undefined));
  await assert.rejects(client.upload(project.projectId, "t", new Uint8Array(65), "text/plain"), {
    code: "LIMIT_EXCEEDED",
  });
});

test("browser clients never offer gui-write-v1", async (t) => {
  let hello;
  const { websocketUrl } = await server(t, (socket, frame) => {
    if (frame.method === "hello") hello = frame;
    socket.close();
  });
  const client = new HostClient({
    origin,
    bootstrap: async () => ({
      version: 1,
      hostId,
      generation,
      origin,
      websocketUrl,
      ticket: "t",
      expiresAt: Date.now() + 30_000,
    }),
  });
  t.after(() => client.close());
  client.retry();
  await waitState(client, (state) => state.connection === "offline");
  assert.deepEqual(hello.params.capabilities, ["gui-read-v1"]);
  assert.equal(client.writable("session.send"), false);
});
