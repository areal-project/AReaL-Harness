"use strict";
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { realpath, mkdtemp, mkdir, writeFile, readFile, chmod, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const directModule = require("../app/src/core/remote-direct.cjs");
const originalStartDirect = directModule.startDirect;
let directStartup;
directModule.startDirect = (...args) =>
  directStartup ? directStartup(...args) : originalStartDirect(...args);
const { RemoteControl } = require("../app/src/core/remote.cjs");
after(() => {
  directModule.startDirect = originalStartDirect;
});

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-remote-")));
  await mkdir(join(home, "host"), { mode: 0o700 });
  const socketPath = join(home, "control.sock");
  const authFile = join(home, "host/auth.json");
  await writeFile(authFile, JSON.stringify("fixture"), { mode: 0o600 });
  await writeFile(
    join(home, "host/host.json"),
    JSON.stringify({
      version: 1,
      hostId: "fixture-host",
      generation: "fixture-generation",
      socketPath,
      authFile,
    }),
    { mode: 0o600 },
  );
  let config = null;
  let revision = 0;
  let lease;
  let loseReply = false;
  let noReceipt = false;
  const requests = [];
  const receipts = new Map();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (lease === socket) lease = undefined;
    });
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk;
      for (;;) {
        const end = bytes.indexOf("\n");
        if (end < 0) break;
        const request = JSON.parse(bytes.slice(0, end));
        bytes = bytes.slice(end + 1);
        requests.push(request);
        const { method, params } = request;
        let result;
        let error;
        if (method === "hello")
          result = {
            version: 1,
            hostId: "fixture-host",
            generation: "fixture-generation",
            capabilities: ["remoteState"],
          };
        else if (method === "remote.acquire") {
          if (lease && lease !== socket) error = { code: "remoteBusy", message: "Remote busy" };
          else {
            lease = socket;
            result = { leaseId: "fixture-lease", sourceId: params.sourceId };
          }
        } else if (method === "remote.read")
          result = { config, revision, sourceId: config ? "source" : null };
        else if (method === "remote.replace") {
          assert.equal(lease, socket);
          if (params.expectedRevision !== revision)
            error = { code: "revisionConflict", message: "stale revision" };
          else {
            config = params.config;
            revision += 1;
            result = {
              requestId: params.requestId,
              method,
              sourceId: "source",
              previousRevision: params.expectedRevision,
              revision,
              state: "completed",
            };
            if (!noReceipt) receipts.set(params.requestId, result);
            if (loseReply) {
              loseReply = false;
              socket.destroy();
              continue;
            }
          }
        } else if (method === "host.operation")
          result = { operation: receipts.get(params.requestId) ?? null };
        else throw new Error(`Unexpected method ${method}`);
        socket.write(
          JSON.stringify({ version: 1, id: request.id, ...(error ? { error } : { result }) }) +
            "\n",
        );
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const instances = [];
  const service = {
    schedule() {},
    backend: {
      home,
      host: { home, sourceId: "source" },
      async save(name, value) {
        await writeFile(join(home, name), JSON.stringify(value), { mode: 0o600 });
      },
    },
  };
  const make = async () => {
    const remote = new RemoteControl(service);
    instances.push(remote);
    try {
      await remote.init();
    } catch (error) {
      remote.close();
      throw error;
    }
    return remote;
  };
  t.after(async () => {
    for (const remote of instances) remote.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    instances,
    requests,
    receipts,
    make,
    loseReply(value = false) {
      loseReply = true;
      noReceipt = value;
    },
    async drop() {
      const closed = [...sockets].map((socket) => once(socket, "close"));
      for (const socket of sockets) socket.destroy();
      await Promise.all(closed);
    },
    state: () => ({ config, revision }),
    externalChange(value) {
      config = value;
      revision += 1;
    },
  };
}

test("fresh Remote reads Host without safeStorage and persists only operation metadata locally", async (t) => {
  const f = await fixture(t);
  const remote = await f.make();
  assert.deepEqual(remote.config, { enabled: false, devices: [] });
  await remote.save({ enabled: false, identity: "dummy-noise-secret", devices: [] });
  assert.equal(f.state().revision, 1);
  assert.equal(remote.config.identity, "dummy-noise-secret");
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))), {
    version: 1,
    pending: null,
  });
  await assert.rejects(readFile(join(f.home, "remote.json")), { code: "ENOENT" });
});

test("lost Remote write reply closes gateways and restart queries the original operation without replay", async (t) => {
  const f = await fixture(t);
  const remote = await f.make();
  let directClosed = 0;
  remote.direct = {
    close() {
      directClosed += 1;
    },
  };
  f.loseReply();
  await assert.rejects(
    remote.save({ enabled: false, identity: "original-noise-secret", devices: [] }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(remote.closed, true);
  assert.equal(directClosed, 1);
  const metadata = await readFile(join(f.home, "host-remote-operation.json"), "utf8");
  assert.equal(metadata.includes("original-noise-secret"), false);
  const originalId = JSON.parse(metadata).pending.requestId;
  const reopened = await f.make();
  assert.equal(reopened.config.identity, "original-noise-secret");
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 1);
  assert.ok(
    f.requests.some(
      (request) => request.method === "host.operation" && request.params.requestId === originalId,
    ),
  );
});

test("absent original receipt blocks further writes across Remote restart", async (t) => {
  const f = await fixture(t);
  const remote = await f.make();
  f.loseReply(true);
  await assert.rejects(remote.save({ enabled: false, identity: "unsettled-noise", devices: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.make(), /仍待确认/);
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 1);
});

test("Remote executor lease excludes a second Gateway and closes on Host disconnect", async (t) => {
  const f = await fixture(t);
  const first = await f.make();
  const second = await f.make();
  assert.equal(second.storageAvailable(), false);
  assert.match(second.state().directError, /其他桌面连接/);
  first.close();
  await new Promise((resolve) => setImmediate(resolve));
  const next = await f.make();
  assert.equal(next.storageAvailable(), true);
  const disconnected = once(next.storage.client.socket, "close");
  await f.drop();
  await disconnected;
  assert.equal(next.closed, true);
  assert.equal(next.storageAvailable(), false);
});

test("explicit revision conflict does not replay a stale Remote config", async (t) => {
  const f = await fixture(t);
  const remote = await f.make();
  await remote.save({ enabled: false, identity: "same-noise", devices: [] });
  f.externalChange({ enabled: false, identity: "same-noise", devices: [], room: "new-room" });
  await assert.rejects(remote.save({ ...remote.config, directEnabled: false }), {
    code: "revisionConflict",
  });
  assert.equal(f.state().config.room, "new-room");
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 2);
  assert.equal(
    JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending,
    null,
  );
  remote.config = await remote.storage.refresh();
  assert.equal(remote.config.room, "new-room");
});

test("Host disconnect during Direct startup closes the late listener and releases its lease", async (t) => {
  const f = await fixture(t);
  f.externalChange({ enabled: false, directEnabled: true, devices: [] });
  const entered = Promise.withResolvers();
  const listener = Promise.withResolvers();
  let closed = 0;
  directStartup = () => {
    entered.resolve();
    return listener.promise;
  };
  t.after(() => {
    directStartup = undefined;
  });
  const pending = f.make();
  await entered.promise;
  const remote = f.instances[0];
  const disconnected = once(remote.storage.client.socket, "close");
  await f.drop();
  await disconnected;
  listener.resolve({
    origin: "http://fixture",
    ws: "ws://fixture",
    close: () => {
      closed += 1;
    },
  });
  await pending;
  assert.equal(remote.closed, true);
  assert.equal(remote.direct, null);
  assert.equal(closed, 1);
  remote.close();
  assert.equal(closed, 1);
  directStartup = undefined;
  f.externalChange({ enabled: false, directEnabled: false, devices: [] });
  const replacement = await f.make();
  assert.equal(replacement.storageAvailable(), true);
  await assert.rejects(remote.startDirect(), /lease.*closed/);
});
