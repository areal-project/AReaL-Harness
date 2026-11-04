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
          result: { version: 1, hostId, generation, capabilities: [] },
        }),
      );
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
    frames.map((frame) => frame.method),
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
