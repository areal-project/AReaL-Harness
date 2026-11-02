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
  const holds = new Map();
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
        const reply = () =>
          socket.write(
            JSON.stringify({ version: 1, id: request.id, ...(error ? { error } : { result }) }) +
              "\n",
          );
        const held = holds.get(method);
        if (held) {
          holds.delete(method);
          held.resolve({ request, reply });
        } else reply();
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const instances = [];
  const desktops = [];
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
    for (const desktop of desktops) desktop.close();
    await Promise.allSettled(
      [...instances, ...desktops.map((desktop) => desktop.remote)]
        .filter(Boolean)
        .map((remote) => remote.close()),
    );
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    service,
    desktops,
    instances,
    hold(method) {
      const held = Promise.withResolvers();
      holds.set(method, held);
      return held.promise;
    },
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
    async released() {
      if (lease) await once(lease, "close");
    },
    state: () => ({ config, revision, leased: !!lease }),
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

test("retained Desktop hostReconnect restores its closed Remote without replacing the Desktop", async (t) => {
  const { DesktopService, PROTOCOL } = require("../app/src/core/service-protocol.cjs");
  const f = await fixture(t);
  const desktop = new DesktopService(f.service.backend, "fixture");
  desktop.schedule = () => {};
  desktop.backend.reconnectHost = async () => ({
    hostId: "fixture-host",
    generation: "fixture-generation",
  });
  const remote = await f.make();
  desktop.remote = remote;
  await remote.save({ enabled: false, schemaVersion: 2, identity: "retained-noise", devices: [] });
  const disconnected = once(remote.storage.client.socket, "close");
  await f.drop();
  await disconnected;
  assert.equal(remote.closed, true);
  const main = {
    readyState: 1,
    bufferedAmount: 0,
    packets: [],
    send(value, done) {
      this.packets.push(JSON.parse(value));
      done?.();
    },
  };
  desktop.clients.add(main);
  desktop.computerSocket = main;
  t.after(() => desktop.close());
  await desktop.receive(
    main,
    Buffer.from(JSON.stringify({ id: 1, method: "hostReconnect", params: { protocol: PROTOCOL } })),
  );
  assert.deepEqual(main.packets[0].result, {
    hostId: "fixture-host",
    generation: "fixture-generation",
  });
  assert.notEqual(desktop.remote, remote);
  assert.equal(desktop.remote.closed, false);
  assert.equal(desktop.remote.config.identity, "retained-noise");
  assert.notEqual(desktop.remote.gatewayGeneration, remote.gatewayGeneration);
  assert.equal(desktop.remote.storageAvailable(), true);
});

function retainedDesktop(f) {
  const { DesktopService } = require("../app/src/core/service-protocol.cjs");
  const desktop = new DesktopService(f.service.backend, "fixture");
  desktop.schedule = () => {};
  desktop.backend.reconnectHost = async () => ({
    hostId: "fixture-host",
    generation: "fixture-generation",
  });
  f.desktops.push(desktop);
  return desktop;
}

test("healthy Remote survives repeated and concurrent explicit reconnects", async (t) => {
  const f = await fixture(t);
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  const remote = desktop.remote;
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let reconnects = 0;
  desktop.backend.reconnectHost = async () => {
    reconnects++;
    entered.resolve();
    await resume.promise;
    return { hostId: "fixture-host", generation: "fixture-generation" };
  };
  const first = desktop.reconnectHost();
  await entered.promise;
  const second = desktop.reconnectHost();
  resume.resolve();
  await Promise.all([first, second]);
  assert.equal(reconnects, 1);
  assert.equal(desktop.remote, remote);
  assert.equal(f.requests.filter((request) => request.method === "remote.acquire").length, 1);
  await desktop.reconnectHost();
  assert.equal(desktop.remote, remote);
});

test("explicit Remote lease conflict fails visibly and permits a later retry", async (t) => {
  const f = await fixture(t);
  const first = await f.make();
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  assert.equal(desktop.remote.closed, true);
  assert.match(desktop.remote.state().directError, /其他桌面连接/);
  await assert.rejects(desktop.reconnectHost(), /其他桌面连接/);
  assert.equal(first.storageAvailable(), true);
  const failed = desktop.remote;
  const disconnected = once(first.storage.client.socket, "close");
  await first.close();
  await disconnected;
  await f.released();
  await desktop.reconnectHost();
  assert.notEqual(desktop.remote, failed);
  assert.equal(desktop.remote.storageAvailable(), true);
});

test("retained Desktop recovers the original UNKNOWN write without replay or grant changes", async (t) => {
  const f = await fixture(t);
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  const grants = [
    {
      devicePeerId: "active-peer",
      displayName: "Phone",
      projectIds: ["p1"],
      capabilities: ["session.read"],
      revision: 2,
      status: "active",
    },
    {
      devicePeerId: "revoked-peer",
      displayName: "Old phone",
      projectIds: ["p2"],
      capabilities: [],
      revision: 3,
      status: "revoked",
      revokedAt: 42,
    },
  ];
  f.loseReply();
  await assert.rejects(
    desktop.remote.save({
      enabled: false,
      schemaVersion: 2,
      identity: "original-noise",
      devices: [],
      deviceGrants: grants,
    }),
  );
  await desktop.remote.close();
  const originalId = JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending
    .requestId;
  await Promise.all([desktop.reconnectHost(), desktop.reconnectHost()]);
  assert.equal(desktop.remote.config.identity, "original-noise");
  assert.deepEqual(desktop.remote.config.deviceGrants, grants);
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 1);
  assert.deepEqual(
    f.requests
      .filter((request) => request.method === "host.operation")
      .map((request) => request.params.requestId),
    [originalId],
  );
  assert.equal(
    JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending,
    null,
  );
});

test("retained Desktop keeps absent or mismatched UNKNOWN receipts pending and settles a matched blocked receipt", async (t) => {
  const f = await fixture(t);
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  f.loseReply(true);
  await assert.rejects(
    desktop.remote.save({ enabled: false, identity: "unknown-noise", devices: [] }),
  );
  await desktop.remote.close();
  const pending = JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending;
  await assert.rejects(desktop.reconnectHost(), /仍待确认/);
  assert.equal(desktop.remote.closed, true);
  f.receipts.set(pending.requestId, {
    ...pending,
    method: "remote.replace",
    previousRevision: pending.expectedRevision + 1,
    state: "completed",
  });
  await assert.rejects(desktop.reconnectHost(), /仍待确认/);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending,
    pending,
  );
  f.receipts.set(pending.requestId, {
    requestId: pending.requestId,
    method: "remote.replace",
    sourceId: pending.sourceId,
    previousRevision: pending.expectedRevision,
    state: "blocked",
  });
  await desktop.reconnectHost();
  assert.equal(desktop.remote.storageAvailable(), true);
  assert.equal(
    JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending,
    null,
  );
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 1);
});

for (const method of ["hello", "remote.acquire", "remote.read"]) {
  test(`Desktop close during ${method} leaves no execution lease or replacement Gateway`, async (t) => {
    const f = await fixture(t);
    const desktop = retainedDesktop(f);
    const held = f.hold(method);
    const initializing = desktop.initRemote();
    await held;
    const remote = desktop.remote;
    const disconnected = once(remote.storage.client.socket, "close");
    desktop.close();
    await assert.rejects(initializing);
    await disconnected;
    await remote.close();
    await f.released();
    assert.equal(remote.storageAvailable(), false);
    assert.equal(f.state().leased, false);
    if (method === "hello")
      assert.equal(
        f.requests.some((request) => request.method === "remote.acquire"),
        false,
      );
    await assert.rejects(desktop.reconnectHost(), /closing/);
    assert.equal(desktop.remote, remote);
  });
}

test("closing Remote before initialization cannot create a late Host connection", async (t) => {
  const f = await fixture(t);
  const remote = new RemoteControl(f.service);
  const initializing = remote.init();
  await remote.close();
  await assert.rejects(initializing, /closed/);
  assert.equal(f.requests.length, 0);
});

test("Remote recovery waits for the old pending clear write before reading or writing new metadata", async (t) => {
  const f = await fixture(t);
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  const old = desktop.remote;
  const save = desktop.backend.save;
  const clearing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  desktop.backend.save = async (name, value) => {
    if (value.pending === null) {
      clearing.resolve();
      await resume.promise;
    }
    await save(name, value);
  };
  const writing = old.save({ enabled: false, identity: "settled-noise", devices: [] });
  await clearing.promise;
  old.close();
  const acquiring = f.requests.filter((request) => request.method === "remote.acquire").length;
  const recovering = desktop.reconnectHost();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.requests.filter((request) => request.method === "remote.acquire").length,
    acquiring,
  );
  desktop.backend.save = save;
  resume.resolve();
  await assert.rejects(writing);
  await recovering;
  await desktop.remote.save({ ...desktop.remote.config, room: "new-metadata" });
  assert.equal(f.state().config.room, "new-metadata");
  assert.equal(
    JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending,
    null,
  );
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 2);
});

test("failed pending metadata persistence blocks object handoff", async (t) => {
  const f = await fixture(t);
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  const remote = desktop.remote;
  desktop.backend.save = async () => {
    throw new Error("fixture disk failure");
  };
  await assert.rejects(
    remote.save({ enabled: false, identity: "unsaved-noise", devices: [] }),
    /disk failure/,
  );
  const disconnected = once(remote.storage.client.socket, "close");
  await assert.rejects(remote.close(), /disk failure/);
  await disconnected;
  await assert.rejects(desktop.reconnectHost(), /disk failure/);
  assert.equal(desktop.remote, remote);
  assert.equal(f.requests.filter((request) => request.method === "remote.acquire").length, 1);
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 0);
});

test("Remote recovery preserves pending identity when close races its first durable write", async (t) => {
  const f = await fixture(t);
  const desktop = retainedDesktop(f);
  await desktop.initRemote();
  const old = desktop.remote;
  const save = desktop.backend.save;
  const writing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  desktop.backend.save = async (name, value) => {
    writing.resolve(value.pending);
    await resume.promise;
    await save(name, value);
  };
  const mutation = old.save({ enabled: false, identity: "never-admitted", devices: [] });
  const pending = await writing.promise;
  old.close();
  const recovering = desktop.reconnectHost();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(desktop.remote, old);
  desktop.backend.save = save;
  resume.resolve();
  await assert.rejects(mutation);
  await assert.rejects(recovering, /仍待确认/);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.home, "host-remote-operation.json"))).pending,
    pending,
  );
  assert.equal(f.requests.filter((request) => request.method === "remote.replace").length, 0);
  assert.deepEqual(
    f.requests
      .filter((request) => request.method === "host.operation")
      .map((request) => request.params.requestId),
    [pending.requestId],
  );
});

test("Desktop close waits for a late Direct listener to finish closing", async (t) => {
  const f = await fixture(t);
  f.externalChange({ enabled: false, directEnabled: true, devices: [] });
  const desktop = retainedDesktop(f);
  const entered = Promise.withResolvers();
  const listener = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const closed = Promise.withResolvers();
  directStartup = () => {
    entered.resolve();
    return listener.promise;
  };
  t.after(() => {
    directStartup = undefined;
  });
  const initialization = desktop.initRemote();
  await entered.promise;
  desktop.close();
  let done = false;
  const completion = desktop.remote.close().then(() => {
    done = true;
  });
  listener.resolve({
    origin: "http://fixture",
    ws: "ws://fixture",
    close: () => {
      closing.resolve();
      return closed.promise;
    },
  });
  await closing.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  closed.resolve();
  await completion;
  await assert.rejects(initialization, /closing/);
  await f.released();
  assert.equal(f.state().leased, false);
  assert.equal(desktop.remote.direct, null);
});
