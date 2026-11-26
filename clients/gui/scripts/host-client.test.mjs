import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
const buildRequire = createRequire(
  new URL("../packages/browser-data/package.json", import.meta.url),
);
const { WebSocketServer } = appRequire("ws");
const { HostClient: NativeHostClient } = appRequire("@areal/client/node");
const { outputFiles } = await buildRequire("esbuild").build({
  entryPoints: [fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { HostClient, readHostBootstrap, beginSessionLoad, sessionLoadTiming } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

test("native desktop negotiated frames accept fragmented history while ordinary Host frames stay bounded", () => {
  const result = "x".repeat(1024 * 1024 + 256);
  const bytes = Buffer.from(JSON.stringify({ version: 1, id: "large", result }) + "\n");
  const native = new NativeHostClient({ desktopCore: true });
  let received;
  native.pending.set("large", {
    resolve: (value) => {
      received = value;
    },
    reject: assert.fail,
  });
  native.receive(bytes.subarray(0, bytes.length - 1));
  assert.equal(native.pending.has("large"), true);
  native.receive(bytes.subarray(bytes.length - 1));
  assert.equal(received, result);
  const ordinary = new NativeHostClient();
  let rejected;
  ordinary.pending.set("large", {
    resolve: assert.fail,
    reject: (error) => {
      rejected = error;
    },
  });
  ordinary.receive(bytes.subarray(0, bytes.length - 1));
  assert.match(rejected.message, /exceeds/);
});

test("session latency ignores superseded reads and records each milestone once", () => {
  performance.clearMeasures("areal.session-load");
  beginSessionLoad("first");
  const original = sessionLoadTiming("first");
  original.mark("cache", false);
  beginSessionLoad("second");
  original.mark("response");
  assert.equal(sessionLoadTiming("first"), undefined);
  beginSessionLoad("first");
  original.mark("messagesPainted");
  const current = sessionLoadTiming("first");
  current.mark("cache", true);
  current.mark("projection");
  current.mark("projection");
  current.mark("messagesPainted");
  const entries = performance.getEntriesByName("areal.session-load");
  assert.equal(entries.filter((entry) => entry.detail.sample === original.sample).length, 2);
  const latest = entries.filter((entry) => entry.detail.sample === current.sample);
  assert.deepEqual(
    latest.map((entry) => entry.detail.stage),
    ["selected", "cache", "projection", "messagesPainted"],
  );
  assert.equal(latest.at(-1).detail.cache, "hit");
  assert.ok(latest.every((entry) => entry.duration >= 0));
  beginSessionLoad("");
  assert.equal(sessionLoadTiming("first"), undefined);
  performance.clearMeasures("areal.session-load");
});
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

test("focus and online events preserve an in-flight Host handshake", async () => {
  const events = new EventTarget();
  const signals = [];
  const rejectors = [];
  const client = new HostClient({
    origin,
    bootstrap: async () => {},
    events,
    transport: ({ signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => rejectors.push(reject));
    },
  });
  const connecting = client.retry();
  try {
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("online"));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
  } finally {
    client.close();
    for (const reject of rejectors) reject(new Error("fixture closed"));
    await connecting;
  }
});

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
async function readServer(t, handler = () => false, options = {}) {
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
    ...options,
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

test("reselecting a fresh conversation keeps the baseline visible and records a cache hit", async (t) => {
  const { client, frames } = await readServer(t);
  const target = { projectId: project.projectId, threadId: "thread" };
  await client.selectSession(target);
  beginSessionLoad(target.threadId);
  await client.selectSession(target);
  assert.equal(client.readsSnapshot().session.state, "fresh");
  assert.equal(frames.filter((frame) => frame.method === "session.open").length, 1);
  const timing = sessionLoadTiming(target.threadId);
  timing.mark("cache", true);
  assert.equal(performance.getEntriesByName("areal.session-load").at(-1)?.detail.cache, "hit");
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

test("an explicit shell refresh keeps the current catalog fresh until the new baseline arrives", async (t) => {
  const { client, frames } = await readServer(t);
  const shell = client.readsSnapshot().shell.value;
  const states = [];
  const stop = client.subscribeReads(() => states.push(client.readsSnapshot().shell.state));
  client.refreshShell();
  await waitReads(
    client,
    (state) =>
      state.shell.state === "fresh" && state.shell.value.subscriptionId !== shell.subscriptionId,
  );
  assert.ok(states.every((state) => state === "fresh"));
  assert.equal(frames.filter((frame) => frame.method === "shell.subscribe").length, 2);
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
  assert.deepEqual(frames[0].params.capabilities, [
    "gui-read-v1",
    "gui-write-v1",
    "persistedHistoryV1",
    "sessionOpenAutoV1",
  ]);
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
  await assert.rejects(client.upload(project.projectId, "t", new Uint8Array(0), "text/plain"), {
    code: "ATTACHMENT_UNSUPPORTED",
  });
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
  assert.deepEqual(hello.params.capabilities, [
    "gui-read-v1",
    "persistedHistoryV1",
    "sessionOpenAutoV1",
  ]);
  assert.equal(client.writable("session.send"), false);
});

test("a ready Core selection never reopens a persisted Store reader", async (t) => {
  let fixture;
  fixture = await readServer(t, ({ frame, reply }) => {
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "persistedHistoryV1"],
        connectionId: "read-connection",
        gatewayGeneration: generation,
      });
      return true;
    }
    if (frame.method === "session.openPersisted") {
      [...fixture.listener.clients][0].send(
        JSON.stringify({
          version: 1,
          id: frame.id,
          error: { code: "RESOURCE_BUSY", message: "Host read request failed" },
        }),
      );
      return true;
    }
    return false;
  });
  await fixture.client.selectSession({
    projectId: project.projectId,
    threadId: "thread",
    persisted: true,
  });
  assert.equal(fixture.client.readsSnapshot().session.state, "fresh");
  assert.equal(fixture.frames.filter((f) => f.method === "session.openPersisted").length, 0);
  assert.equal(fixture.frames.filter((f) => f.method === "session.open").length, 1);
});

test("failed conversation reads keep the Host code for the detail view, not the message", async (t) => {
  let fixture;
  fixture = await readServer(t, ({ frame }) => {
    if (frame.method !== "session.open") return false;
    [...fixture.listener.clients][0].send(
      JSON.stringify({
        version: 1,
        id: frame.id,
        error: { code: "CORE_UNAVAILABLE", message: "Host read request failed" },
      }),
    );
    return true;
  });
  await assert.rejects(
    fixture.client.selectSession({ projectId: project.projectId, threadId: "thread" }),
  );
  const read = fixture.client.readsSnapshot().session;
  assert.equal(read.state, "unavailable");
  // 上屏文案按 code 取；错误码只作详情，不拼进 message。
  assert.doesNotMatch(read.error, /CORE_UNAVAILABLE|session\.open/);
});

test("a queue-full rejection keeps its message readable and its method and reason in the detail", async (t) => {
  let fixture;
  fixture = await readServer(t, ({ frame }) => {
    if (frame.method !== "session.open") return false;
    [...fixture.listener.clients][0].send(
      JSON.stringify({
        version: 1,
        id: frame.id,
        error: {
          code: "CAPACITY_EXCEEDED",
          message: "Host command failed",
          method: "session.open",
          reason: "commandQueueFull",
        },
      }),
    );
    return true;
  });
  await assert.rejects(
    fixture.client.selectSession({ projectId: project.projectId, threadId: "thread" }),
  );
  // 上屏文案由 code 决定；message 只承载 method 和队列原因，供“查看详情”使用。
  const failure = await fixture.client
    .selectSession({ projectId: project.projectId, threadId: "thread" })
    .catch((error) => error);
  assert.equal(failure.code, "CAPACITY_EXCEEDED");
  assert.equal(failure.method, "session.open");
  assert.equal(failure.reason, "commandQueueFull");
  assert.notEqual(failure.message, "Host command failed");
  assert.match(failure.detail, /session\.open/);
  assert.match(failure.detail, /commandQueueFull/);
  assert.doesNotMatch(failure.message, /CAPACITY_EXCEEDED|session\.open|commandQueueFull/);
});

test("idle hibernation transitions an open live session through stopping to persisted history without errors", async (t) => {
  let fixture;
  let shellSequence = 0;
  let openCount = 0;
  let persistedCount = 0;
  let currentServiceGeneration = project.serviceGeneration;
  fixture = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "persistedHistoryV1"],
        connectionId: "read-connection",
        gatewayGeneration: generation,
      });
      return true;
    }
    if (frame.method === "session.open") {
      openCount++;
      reply({
        ...sessionIdentity(frame.params.threadId),
        serviceGeneration: currentServiceGeneration,
        subscriptionId: `live-sub-${openCount}`,
        sequence: 0,
        snapshot: { thread: { id: frame.params.threadId, turns: [{ id: "t1", items: [] }] } },
      });
      return true;
    }
    if (frame.method === "session.openPersisted") {
      persistedCount++;
      reply({
        ...sessionIdentity(frame.params.threadId),
        serviceGeneration: project.serviceGeneration,
        subscriptionId: `persisted-sub-${persistedCount}`,
        sequence: 0,
        access: { kind: "persisted", readOnly: true, snapshotId: "snap-1" },
        snapshot: {
          thread: { id: frame.params.threadId, turns: [{ id: "t1", items: [] }] },
          access: { kind: "persisted", readOnly: true, snapshotId: "snap-1" },
        },
      });
      return true;
    }
    return false;
  });

  await fixture.client.selectSession({ projectId: project.projectId, threadId: "thread" });
  const observedSessions = [];
  const off = fixture.client.subscribeReads(() => {
    observedSessions.push(fixture.client.readsSnapshot().session);
  });
  t.after(off);

  const socket = [...fixture.listener.clients][0];
  const shellSub = fixture.client.readsSnapshot().shell.value.subscriptionId;
  const liveSub = fixture.client.readsSnapshot().session.value.subscriptionId;

  // 1) Host enters stopping: sends shell.updated first, then session.invalidated.
  socket.send(
    JSON.stringify({
      version: 1,
      method: "shell.updated",
      params: {
        connectionId: "read-connection",
        gatewayGeneration: generation,
        subscriptionId: shellSub,
        sequence: ++shellSequence,
        event: "shell.updated",
        delta: {
          projects: {
            upsert: [{ ...project, state: "stopping" }],
            remove: [],
          },
          navigation: { upsert: [], remove: [] },
        },
      },
    }),
  );
  socket.send(
    JSON.stringify({
      version: 1,
      method: "session.invalidated",
      params: {
        connectionId: "read-connection",
        gatewayGeneration: generation,
        subscriptionId: liveSub,
        projectId: project.projectId,
        serviceGeneration: project.serviceGeneration,
        threadId: "thread",
        view: "conversation",
        sequence: 1,
        event: "session.invalidated",
        error: { code: "RESYNC_REQUIRED", message: "resync" },
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(openCount, 1, "must not retry session.open while project is stopping");
  assert.equal(persistedCount, 0, "must wait for stopped before opening persisted history");
  assert.equal(fixture.client.readsSnapshot().session.state, "stale");
  assert.equal(fixture.client.readsSnapshot().session.error, undefined);

  // 2) Host finishes stopping -> state becomes stopped.
  socket.send(
    JSON.stringify({
      version: 1,
      method: "shell.updated",
      params: {
        connectionId: "read-connection",
        gatewayGeneration: generation,
        subscriptionId: shellSub,
        sequence: ++shellSequence,
        event: "shell.updated",
        delta: {
          projects: {
            upsert: [{ ...project, state: "stopped", serviceGeneration: undefined }],
            remove: [],
          },
          navigation: { upsert: [], remove: [] },
        },
      },
    }),
  );

  await waitReads(
    fixture.client,
    (reads) => reads.session.state === "fresh" && reads.session.value.access?.kind === "persisted",
  );
  assert.equal(openCount, 1);
  assert.equal(persistedCount, 1);

  // 3) User wakes project -> state becomes ready with new generation.
  currentServiceGeneration = "core-gen-2";
  socket.send(
    JSON.stringify({
      version: 1,
      method: "shell.updated",
      params: {
        connectionId: "read-connection",
        gatewayGeneration: generation,
        subscriptionId: shellSub,
        sequence: ++shellSequence,
        event: "shell.updated",
        delta: {
          projects: {
            upsert: [{ ...project, state: "ready", serviceGeneration: "core-gen-2" }],
            remove: [],
          },
          navigation: { upsert: [], remove: [] },
        },
      },
    }),
  );

  await waitReads(
    fixture.client,
    (reads) =>
      reads.session.state === "fresh" &&
      reads.session.value.serviceGeneration === "core-gen-2" &&
      reads.session.value.access === undefined,
  );
  assert.equal(openCount, 2);
  assert.equal(
    observedSessions.some((entry) => entry.state === "unavailable" || Boolean(entry.error)),
    false,
    `expected zero errors during hibernation lifecycle, observed: ${JSON.stringify(observedSessions)}`,
  );
});

test("history remains readable when a ready Core becomes stopped after selection", async (t) => {
  let shellReads = 0;
  const { client, frames } = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "persistedHistoryV1"],
        connectionId: "read-connection",
        gatewayGeneration: generation,
      });
      return true;
    }
    if (frame.method === "shell.subscribe") {
      reply({
        connectionId: "read-connection",
        gatewayGeneration: generation,
        subscriptionId: `shell-test-${++shellReads}`,
        sequence: 0,
        snapshot: {
          projects: [
            shellReads === 1
              ? project
              : { ...project, state: "stopped", serviceGeneration: undefined },
          ],
          navigation: [],
        },
      });
      return true;
    }
    if (frame.method === "session.openPersisted") {
      reply({
        ...sessionIdentity(frame.params.threadId),
        subscriptionId: "persisted-test",
        sequence: 0,
        access: { kind: "persisted", readOnly: true, snapshotId: "saved" },
        snapshot: nativeObservation(frame.params.threadId),
      });
      return true;
    }
    return false;
  });
  await client.selectSession({ projectId: project.projectId, threadId: "thread" });
  await client.refreshShell();
  const result = await waitReads(
    client,
    (s) => s.session.state === "fresh" && s.session.value.access?.kind === "persisted",
  );
  assert.equal(result.session.value.threadId, "thread");
  assert.equal(frames.filter((f) => f.method === "session.openPersisted").length, 1);
});

test("late cached history is scoped to the current selected thread", async (t) => {
  let resolveCache, failOpen;
  const cached = new Promise((resolve) => {
    resolveCache = resolve;
  });
  const { client } = await readServer(
    t,
    ({ frame }) => {
      if (frame.method === "session.open" && frame.params.threadId === "slow") {
        failOpen = true;
        return true;
      }
      return false;
    },
    { cache: { loadSession: () => cached } },
  );
  void client.selectSession({ projectId: project.projectId, threadId: "slow" }).catch(() => {});
  while (!failOpen) await new Promise((resolve) => setImmediate(resolve));
  await client.selectSession({ projectId: project.projectId, threadId: "current" });
  const current = client.readsSnapshot().session.value;
  resolveCache({ ...current, threadId: "slow" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.readsSnapshot().session.value.threadId, "current");
});

test("an asynchronous cache may restore only the selected conversation while its live read waits", async (t) => {
  let resolveCache;
  const pendingCache = new Promise((resolve) => {
    resolveCache = resolve;
  });
  const { client } = await readServer(
    t,
    ({ frame }) => frame.method === "session.open" && frame.params.threadId === "slow",
    { cache: { loadSession: () => pendingCache } },
  );
  await client.selectSession({ projectId: project.projectId, threadId: "baseline" });
  const baseline = client.readsSnapshot().session.value;
  void client.selectSession({ projectId: project.projectId, threadId: "slow" }).catch(() => {});
  resolveCache({ ...baseline, threadId: "slow" });
  const reads = await waitReads(
    client,
    (s) => s.session.state === "stale" && s.session.value.threadId === "slow",
  );
  assert.equal(reads.session.value.projectId, project.projectId);
});

test("persisted intent and live selection share the same ready Core subscription", async (t) => {
  const { client, frames } = await readServer(t);
  const target = { projectId: project.projectId, threadId: "thread" };
  await client.selectSession({ ...target, persisted: true });
  await client.selectSession(target);
  await client.selectSession({ ...target, persisted: true });
  assert.equal(frames.filter((frame) => frame.method === "session.open").length, 1);
  assert.equal(frames.filter((frame) => frame.method === "subscription.close").length, 0);
});

test("disconnected Cloud session opens atomically with mode auto and retains stale content without openPersisted on disconnect", async (t) => {
  const cloudId = "cloud-session:src:rec-1";
  let fixture;
  fixture = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    const base = sessionIdentity("cloud-thread");
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "sessionOpenAutoV1"],
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
      });
      return true;
    }
    if (frame.method === "shell.subscribe") {
      reply({
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
        subscriptionId: "shell-sub",
        sequence: 0,
        snapshot: {
          projects: [
            {
              ...project,
              projectId: cloudId,
              kind: "cloud",
              state: "unavailable",
              serviceGeneration: undefined,
              summaries: {
                state: "cached",
                items: [
                  {
                    id: "cloud-thread",
                    desktop: { archived: false },
                    cloud: {
                      sessionId: "rec-1",
                      connected: false,
                      connectionState: "disconnected",
                      error: "Cloud 尚未连接",
                    },
                  },
                ],
              },
            },
          ],
          navigation: [],
        },
      });
      return true;
    }
    if (frame.method === "session.open") {
      assert.equal(frame.params.mode, "auto");
      reply({
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
        subscriptionId: "cloud-sub",
        sequence: 0,
        projectId: cloudId,
        serviceGeneration: "cloud-lease-1",
        threadId: "cloud-thread",
        view: "conversation",
        snapshot: { thread: { id: "cloud-thread", turns: [] } },
      });
      return true;
    }
    return false;
  });

  await fixture.client.selectSession({ projectId: cloudId, threadId: "cloud-thread" });
  const opened = fixture.client.readsSnapshot().session;
  assert.equal(opened.state, "fresh");
  assert.equal(opened.value.serviceGeneration, "cloud-lease-1");

  // 模拟云端连接建立后又收到 core_close_frame 断开：正文必须保留为 stale，且绝不调用 session.openPersisted。
  const { connectionId, gatewayGeneration } = opened.value;
  const pushShell = (sequence, nextState, nextGen) =>
    fixture.send({
      event: "shell.updated",
      connectionId,
      gatewayGeneration,
      subscriptionId: "shell-sub",
      sequence,
      delta: {
        projects: {
          upsert: [
            {
              ...project,
              projectId: cloudId,
              kind: "cloud",
              state: nextState,
              ...(nextGen ? { serviceGeneration: nextGen } : { serviceGeneration: undefined }),
              summaries: {
                state: nextState === "ready" ? "fresh" : "cached",
                items: [
                  {
                    id: "cloud-thread",
                    desktop: { archived: false },
                    cloud: {
                      sessionId: "rec-1",
                      connected: nextState === "ready",
                      connectionState: nextState === "ready" ? "connected" : "disconnected",
                      error: nextState === "ready" ? null : "Cloud 尚未连接",
                    },
                  },
                ],
              },
            },
          ],
          remove: [],
        },
        navigation: { upsert: [], remove: [] },
      },
    });
  pushShell(1, "ready", "cloud-lease-1");
  pushShell(2, "unavailable", undefined);
  fixture.send({
    event: "session.invalidated",
    connectionId,
    gatewayGeneration,
    subscriptionId: "cloud-sub",
    sequence: 1,
    projectId: cloudId,
    serviceGeneration: "cloud-lease-1",
    threadId: "cloud-thread",
    view: "conversation",
    error: { code: "RESYNC_REQUIRED", message: "连接已关闭" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(fixture.client.readsSnapshot().session.state, "stale");
  assert.equal(fixture.client.readsSnapshot().session.value.threadId, "cloud-thread");
  assert.equal(fixture.client.readsSnapshot().session.failure?.code, "RESYNC_REQUIRED");
  assert.equal(fixture.frames.filter((f) => f.method === "session.openPersisted").length, 0);
});

test("Cloud explicit reconnect is one-shot across mid-flight shell updates, sequence gap re-observes, and older Host omits mode", async (t) => {
  const cloudId = "cloud-session:src:rec-reconnect";
  let fixture;
  let openCalls = 0;
  let resolveFirstReconnect;
  fixture = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    const base = sessionIdentity("cloud-thread");
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "sessionOpenAutoV1"],
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
      });
      return true;
    }
    if (frame.method === "shell.subscribe") {
      reply({
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
        subscriptionId: "shell-sub",
        sequence: 0,
        snapshot: {
          projects: [
            {
              ...project,
              projectId: cloudId,
              kind: "cloud",
              state: "unavailable",
              serviceGeneration: undefined,
              summaries: { state: "cached", items: [] },
            },
          ],
          navigation: [],
        },
      });
      return true;
    }
    if (frame.method === "session.open") {
      openCalls += 1;
      if (openCalls === 1) {
        assert.equal(frame.params.mode, "auto");
        assert.equal(frame.params.reconnect, true);
        resolveFirstReconnect = () =>
          reply({
            connectionId: base.connectionId,
            gatewayGeneration: base.gatewayGeneration,
            subscriptionId: "cloud-sub-1",
            sequence: 0,
            projectId: cloudId,
            serviceGeneration: "cloud-lease-1",
            threadId: "cloud-thread",
            view: "conversation",
            snapshot: { thread: { id: "cloud-thread", turns: [] } },
          });
        return true;
      }
      assert.equal(frame.params.mode, "auto");
      assert.equal(frame.params.reconnect, undefined);
      reply({
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
        subscriptionId: `cloud-sub-${openCalls}`,
        sequence: 0,
        projectId: cloudId,
        serviceGeneration: "cloud-lease-1",
        threadId: "cloud-thread",
        view: "conversation",
        snapshot: { thread: { id: "cloud-thread", turns: [] } },
      });
      return true;
    }
    return false;
  });

  const reconnecting = fixture.client.selectSession({
    projectId: cloudId,
    threadId: "cloud-thread",
    mode: "auto",
    reconnect: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(openCalls, 1);

  // 重连进行中收到 starting -> ready 目录推送，以及非强制的重复 selectSession，都必须合并到同一次重连，绝不二次发 reconnect。
  const conn = fixture.client.snapshot().identity;
  const pushCloudShell = (sequence, state, serviceGeneration) =>
    fixture.send({
      event: "shell.updated",
      connectionId: conn.connectionId,
      gatewayGeneration: conn.gatewayGeneration,
      subscriptionId: "shell-sub",
      sequence,
      delta: {
        projects: {
          upsert: [
            {
              ...project,
              projectId: cloudId,
              kind: "cloud",
              state,
              ...(serviceGeneration ? { serviceGeneration } : { serviceGeneration: undefined }),
              summaries: { state: "fresh", items: [] },
            },
          ],
          remove: [],
        },
        navigation: { upsert: [], remove: [] },
      },
    });
  pushCloudShell(1, "starting", undefined);
  pushCloudShell(2, "ready", "cloud-lease-1");
  const joined = fixture.client.selectSession({
    projectId: cloudId,
    threadId: "cloud-thread",
    mode: "auto",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(openCalls, 1);

  resolveFirstReconnect();
  await Promise.all([reconnecting, joined]);
  assert.equal(fixture.client.readsSnapshot().session.state, "fresh");

  // 健康的 Cloud 会话遇到序号缺口（sequence=3 != 0+1）时必须主动重新观察，不能卡死在 stale。
  fixture.send({
    event: "session.updated",
    connectionId: conn.connectionId,
    gatewayGeneration: conn.gatewayGeneration,
    subscriptionId: "cloud-sub-1",
    sequence: 3,
    projectId: cloudId,
    serviceGeneration: "cloud-lease-1",
    threadId: "cloud-thread",
    view: "conversation",
    patch: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(openCalls, 2);
  assert.equal(fixture.client.readsSnapshot().session.state, "fresh");
  assert.equal(fixture.client.readsSnapshot().session.value.subscriptionId, "cloud-sub-2");

  // 旧版 Host 未协商 sessionOpenAutoV1 时，客户端不得发送 mode/reconnect 字段。
  const olderHost = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    if (frame.method === "session.open") {
      assert.equal("mode" in frame.params, false);
      assert.equal("reconnect" in frame.params, false);
      reply({
        ...sessionIdentity(frame.params.threadId),
        subscriptionId: "older-sub",
        sequence: 0,
        snapshot: nativeObservation(frame.params.threadId),
      });
      return true;
    }
    return false;
  });
  await olderHost.client.selectSession({
    projectId: project.projectId,
    threadId: "thread",
    mode: "auto",
  });
  assert.equal(olderHost.client.readsSnapshot().session.state, "fresh");
});

test("local session.invalidated arriving before shell.updated reconciles stopping state without surfacing a transient error", async (t) => {
  let shellPhase = "ready";
  let openAttempts = 0;
  let fixture;
  fixture = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    const base = sessionIdentity("thread");
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "persistedHistoryV1"],
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
      });
      return true;
    }
    if (frame.method === "shell.subscribe") {
      reply({
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
        subscriptionId: `shell-${shellPhase}`,
        sequence: 0,
        snapshot: {
          projects: [
            {
              ...project,
              state: shellPhase,
              serviceGeneration: shellPhase === "ready" ? "core-1" : undefined,
            },
          ],
          navigation: [],
        },
      });
      return true;
    }
    if (frame.method === "session.open") {
      openAttempts += 1;
      if (openAttempts === 1) {
        reply({
          ...base,
          subscriptionId: "sub-live",
          sequence: 0,
          snapshot: nativeObservation("thread"),
        });
        return true;
      }
      // 模拟 Core 已进入 stopping，目录尚未送达，Host 返回 scheduleHostUnavailable。
      [...fixture.listener.clients][0].send(
        JSON.stringify({
          version: 1,
          id: frame.id,
          error: { code: "scheduleHostUnavailable", message: "Core is stopping" },
        }),
      );
      return true;
    }
    if (frame.method === "session.openPersisted") {
      reply({
        ...base,
        serviceGeneration: "core-1",
        subscriptionId: "sub-persisted",
        sequence: 0,
        access: { kind: "persisted", readOnly: true, snapshotId: "snap-1" },
        snapshot: nativeObservation("thread"),
      });
      return true;
    }
    return false;
  });

  await fixture.client.selectSession({ projectId: project.projectId, threadId: "thread" });
  const opened = fixture.client.readsSnapshot().session;
  assert.equal(opened.state, "fresh");
  let observedError;
  const unsub = fixture.client.subscribeReads(() => {
    const state = fixture.client.readsSnapshot().session;
    if (state.state === "stale" && (state.error || state.failure)) {
      observedError = state.error ?? state.failure?.code;
    }
  });
  t.after(unsub);

  // Core 已进入 stopping，但 session.invalidated 先于 shell.updated 到达。
  shellPhase = "stopping";
  fixture.send({
    event: "session.invalidated",
    connectionId: opened.value.connectionId,
    gatewayGeneration: opened.value.gatewayGeneration,
    subscriptionId: opened.value.subscriptionId,
    sequence: 1,
    projectId: project.projectId,
    serviceGeneration: opened.value.serviceGeneration,
    threadId: "thread",
    view: "conversation",
    error: { code: "RESYNC_REQUIRED", message: "resync" },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(observedError, undefined);
  assert.equal(fixture.client.readsSnapshot().session.state, "stale");
});

test("structured Cloud read failure preserves code, stage, diagnosticId, and detail on readsSnapshot", async (t) => {
  const cloudId = "cloud-session:src:rec-err";
  let fixture;
  fixture = await readServer(t, ({ frame, reply, sessionIdentity }) => {
    const base = sessionIdentity("cloud-thread");
    if (frame.method === "hello") {
      reply({
        version: 1,
        hostId,
        generation,
        capabilities: [],
        negotiatedCapabilities: ["gui-read-v1", "sessionOpenAutoV1"],
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
      });
      return true;
    }
    if (frame.method === "shell.subscribe") {
      reply({
        connectionId: base.connectionId,
        gatewayGeneration: base.gatewayGeneration,
        subscriptionId: "shell-sub",
        sequence: 0,
        snapshot: {
          projects: [
            {
              ...project,
              projectId: cloudId,
              kind: "cloud",
              state: "unavailable",
              serviceGeneration: undefined,
              summaries: { state: "cached", items: [] },
            },
          ],
          navigation: [],
        },
      });
      return true;
    }
    if (frame.method === "session.open") {
      [...fixture.listener.clients][0].send(
        JSON.stringify({
          version: 1,
          id: frame.id,
          error: {
            code: "CLOUD_AUTH_REJECTED",
            message: "云端凭据验证未通过，请检查 Cloud 设置中的地址与令牌。",
            stage: "cloud_connect",
            detail: "HTTP 401",
            diagnosticId: "a1b2c3d4",
            retryable: false,
          },
        }),
      );
      return true;
    }
    return false;
  });

  await assert.rejects(
    () => fixture.client.selectSession({ projectId: cloudId, threadId: "cloud-thread" }),
    (error) => {
      assert.equal(error.code, "CLOUD_AUTH_REJECTED");
      assert.equal(error.stage, "cloud_connect");
      assert.equal(error.diagnosticId, "a1b2c3d4");
      assert.match(error.detail, /HTTP 401/);
      assert.match(error.detail, /#a1b2c3d4/);
      return true;
    },
  );
  const reads = fixture.client.readsSnapshot();
  assert.equal(reads.session.state, "unavailable");
  assert.equal(reads.session.failure.code, "CLOUD_AUTH_REJECTED");
  assert.equal(reads.session.failure.stage, "cloud_connect");
  assert.equal(reads.session.failure.diagnosticId, "a1b2c3d4");
  assert.equal(reads.session.failure.retryable, false);
});
