"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { mkdtemp, mkdir, realpath, writeFile, readFile, chmod } = require("node:fs/promises");
const { join } = require("node:path");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const { readReferences } = require("../app/src/core/service-control.cjs");
const { readHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
const {
  validateResponse,
} = require("../packages/workbench/client/desktop-contract/desktop-control.cjs");
const {
  isLifecycleProjection,
} = require("../packages/workbench/client/desktop-contract/shared.cjs");
async function fixture(t, extraCapabilities = []) {
  const root = await realpath(await mkdtemp("/tmp/ah-host-stop-"));
  const home = join(root, "desktop"),
    hostHome = join(root, "host"),
    profile = join(root, "profile");
  for (const path of [home, profile, join(hostHome, "host")])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const hostId = randomUUID();
  let generation = randomUUID();
  const authFile = join(hostHome, "host/auth.json"),
    socketPath = join(hostHome, "host/control.sock");
  await writeFile(authFile, JSON.stringify("test-token"), { mode: 0o600 });
  await writeFile(
    join(hostHome, "host/host.json"),
    JSON.stringify({ version: 1, hostId, generation, socketPath, authFile, pid: process.pid }),
    { mode: 0o600 },
  );
  const calls = [],
    sockets = new Set(),
    operations = new Map();
  let handler;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk;
      for (;;) {
        const end = bytes.indexOf("\n");
        if (end < 0) break;
        const request = JSON.parse(bytes.slice(0, end));
        bytes = bytes.slice(end + 1);
        calls.push(request);
        void (async () => {
          let result;
          if (request.method === "hello") {
            assert.equal(request.params.authToken, "test-token");
            result = {
              version: 1,
              hostId,
              generation,
              capabilities: [
                ...extraCapabilities,
                "activity",
                "stopOperations",
                "guiImport",
                "projects",
                "scheduledActivation",
                "scheduledPreparation",
              ],
            };
          } else if (handler) result = await handler(request, socket);
          else result = { operation: operations.get(request.params.requestId) ?? null };
          if (!socket.destroyed)
            socket.write(JSON.stringify({ version: 1, id: request.id, result }) + "\n");
        })().catch((error) => {
          socket.destroy(error);
        });
      }
    });
    socket.on("error", () => {});
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const backend = new SharedCoreBackend({ app: { getPath: () => profile }, home, hostHome });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  });
  const receipt = (requestId, state = "completed", projects = []) => ({
    version: 1,
    requestId,
    hostId,
    generation,
    strategy: "cancel",
    state,
    projects,
  });
  return {
    root,
    home,
    hostHome,
    profile,
    hostId,
    generation,
    calls,
    operations,
    backend,
    receipt,
    setHandler: (value) => {
      handler = value;
    },
    setGeneration: async (value) => {
      generation = value;
      await writeFile(
        join(hostHome, "host/host.json"),
        JSON.stringify({ version: 1, hostId, generation, socketPath, authFile, pid: process.pid }),
        { mode: 0o600 },
      );
    },
  };
}
for (const action of ["prepare", "apply"]) {
  test(`Host update ${action} settles its original wrapped receipt after reconnect`, async (t) => {
    const f = await fixture(t, ["updates"]);
    const requestId = randomUUID();
    let original;
    f.setHandler(async (request, socket) => {
      if (request.method === "host.update") {
        const control = JSON.parse(await readFile(f.backend.controlPath, "utf8"));
        assert.equal(control.hostUpdate.requestId, requestId);
        original = {
          version: 1,
          requestId,
          hostId: f.hostId,
          generation: f.generation,
          action,
          targetVersion: "0.1.9",
          state: action === "prepare" ? "prepared" : "completed",
          evidence: { target: "/private/target" },
        };
        socket.destroy();
        return;
      }
      if (request.method === "host.operation") {
        assert.equal(request.params.requestId, requestId);
        return { operation: original };
      }
      assert.equal(request.method, "host.updateStatus");
      return {
        restartPending: action === "prepare",
        targetVersion: "0.1.9",
        prepareRequestId: requestId,
        operation: original,
      };
    });
    await assert.rejects(
      f.backend.hostUpdate({ operation: action, requestId, targetVersion: "0.1.9" }),
    );
    await f.setGeneration(randomUUID());
    const restarted = new SharedCoreBackend({
      app: { getPath: () => f.profile },
      home: f.home,
      hostHome: f.hostHome,
    });
    const status = await restarted.hostUpdate({ operation: "check" });
    assert.equal(status.operation.requestId, requestId);
    assert.equal(status.operation.generation, f.generation);
    assert.equal(status.operation.state, action === "prepare" ? "prepared" : "completed");
    assert.equal("evidence" in status.operation, false);
    assert.equal(restarted.hostUpdateReference, null);
    assert.equal(f.calls.filter((call) => call.method === "host.update").length, 1);
  });
}
test("Host update null lookup preserves UNKNOWN and blocks a new mutation without replay", async (t) => {
  const f = await fixture(t, ["updates"]);
  const requestId = randomUUID();
  f.setHandler(async (request, socket) => {
    if (request.method === "host.update") {
      socket.destroy();
      return;
    }
    assert.equal(request.method, "host.operation");
    assert.equal(request.params.requestId, requestId);
    return { operation: null };
  });
  await assert.rejects(
    f.backend.hostUpdate({ operation: "prepare", requestId, targetVersion: "0.1.9" }),
  );
  const restarted = new SharedCoreBackend({
    app: { getPath: () => f.profile },
    home: f.home,
    hostHome: f.hostHome,
  });
  const status = await restarted.hostUpdate({ operation: "check" });
  assert.equal(status.operation.state, "admissionUnknown");
  assert.equal(status.operation.requestId, requestId);
  await assert.rejects(
    restarted.hostUpdate({ operation: "prepare", requestId: randomUUID(), targetVersion: "0.1.9" }),
    /原升级请求结果待核查/,
  );
  assert.equal(
    JSON.parse(await readFile(restarted.controlPath, "utf8")).hostUpdate.requestId,
    requestId,
  );
  assert.equal(f.calls.filter((call) => call.method === "host.update").length, 1);
});
test("Host activity is passive and whole-Host stop is durable before one dispatch", async (t) => {
  const f = await fixture(t);
  const activity = {
    complete: true,
    projects: [
      {
        projectId: "cli-only",
        state: "observed",
        activeTasks: 1,
        activeTurns: 1,
        activeGoals: 0,
        pendingQueueItems: 0,
        idleAllowed: false,
      },
    ],
    totalActiveTasks: 1,
  };
  f.setHandler(async (request) => {
    if (request.method === "host.activity") return activity;
    if (request.method === "host.operation")
      return { operation: f.receipt(request.params.requestId) };
    assert.equal(request.method, "host.stop");
    const control = JSON.parse(await readFile(f.backend.controlPath, "utf8"));
    assert.equal(control.version, 3);
    assert.equal(control.references[0].kind, "stopHost");
    assert.equal(control.references[0].requestId, request.params.requestId);
    assert.equal(control.references[0].home, f.hostHome);
    assert.equal(control.references[0].generation, f.generation);
    return f.receipt(request.params.requestId);
  });
  f.backend.attach = async () => {
    throw new Error("must not attach Desktop");
  };
  let closed = false;
  f.backend.connection = { close: () => (closed = true) };
  f.backend.status.connected = true;
  f.backend.connectionState = { state: "ready" };
  assert.deepEqual(await f.backend.readHostActivity(), activity);
  f.backend.guiTerminals.set("terminal", { projectId: "p", threadId: "t", id: "terminal" });
  const result = await f.backend.requestHostStop({ strategy: "cancel" });
  assert.equal(result.stopped, true);
  assert.equal(result.operation.kind, "stopHost");
  assert.doesNotThrow(() => validateResponse("stopService", {}, result));
  assert.equal(f.calls.filter((request) => request.method === "host.stop").length, 1);
  assert.equal(f.backend.guiTerminals.size, 0);
  assert.equal(f.backend.terminalConnections.closed, true);
  assert.equal(closed, true);
  assert.equal(f.backend.snapshot().connection.state, "unavailable");
  assert.equal(f.backend.snapshot().connection.recovery, "reconnect");
  assert.equal(f.backend.canReconnect(), false);
  assert.equal(isLifecycleProjection(f.backend.lifecycleProjection()), true);
  f.backend.initialize = async () => {
    f.backend.status.connected = true;
    f.backend.connectionState = { state: "ready" };
  };
  await f.backend.init();
  assert.equal(f.backend.snapshot().connection.state, "ready");
  assert.equal(f.backend.hostReferences.size, 0);
});
test("lost stop response and reopened Main only query the durable original ID", async (t) => {
  const f = await fixture(t);
  let stopped;
  f.setHandler(async (request, socket) => {
    if (request.method === "host.stop") {
      stopped = request.params.requestId;
      f.operations.set(stopped, f.receipt(stopped, "admissionUnknown"));
      socket.destroy();
      return;
    }
    assert.equal(request.method, "host.operation");
    return { operation: f.operations.get(request.params.requestId) ?? null };
  });
  const first = await f.backend.requestHostStop({ strategy: "cancel" });
  assert.equal(first.stopped, false);
  assert.equal(first.operation.phase, "admissionUnconfirmed");
  const reopened = new SharedCoreBackend({
    app: { getPath: () => f.profile },
    home: f.home,
    hostHome: f.hostHome,
  });
  reopened.attach = async () => {
    throw new Error("pending Host read must not attach");
  };
  await reopened.checkLifecycle();
  assert.equal(reopened.connectionState.recovery, "check");
  assert.equal(reopened.canReconnect(), false);
  const again = await reopened.requestHostStop({ strategy: "cancel" });
  assert.equal(again.operation.requestId, stopped);
  assert.equal(again.stopped, false);
  assert.equal(f.calls.filter((request) => request.method === "host.stop").length, 1);
  await reopened.completeApplicationQuit({ keepBackground: true });
  assert.equal(
    JSON.parse(await readFile(reopened.controlPath, "utf8")).references[0].requestId,
    stopped,
  );
  f.operations.set(stopped, f.receipt(stopped));
  await reopened.checkLifecycle();
  assert.equal(reopened.hostReceipts.get(stopped).state, "completed");
  assert.equal(reopened.connectionState.recovery, "reconnect");
  let starts = 0;
  reopened.initialize = async () => {
    starts++;
  };
  assert.deepEqual(await reopened.recoverBackend({ notify: async () => ({ response: 0 }) }), {
    recovered: true,
  });
  assert.equal(starts, 1);
});
test("missing original receipt stays UNKNOWN and preserves old Desktop references", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  const original = {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
  };
  const desktop = {
    kind: "stopDesktop",
    requestId: randomUUID(),
    desktopGeneration: randomUUID(),
    mode: "cancel",
    targets: [],
    desktop: { pid: process.pid, identity: "old-desktop" },
  };
  f.backend.lifecycleReferences.set(desktop.requestId, desktop);
  f.backend.hostReferences.set(requestId, original);
  await f.backend.persistReferences();
  const value = readReferences(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references,
  );
  assert.equal(value.length, 2);
  const result = await f.backend.requestHostStop({ strategy: "cancel" });
  assert.equal(result.stopped, false);
  assert.equal(result.operation.requestId, requestId);
  await f.backend.completeApplicationQuit({ keepBackground: true });
  assert.equal(
    readReferences(JSON.parse(await readFile(f.backend.controlPath, "utf8")).references).length,
    2,
  );
  assert.equal(
    f.calls.some((request) => request.method === "host.stop"),
    false,
  );
  await assert.rejects(f.backend.requestHostStop({ strategy: "ifIdle", requestId }), {
    code: "LIFECYCLE_REQUEST_CONFLICT",
  });
});
test("Host stop receipt requires original identities and completed child proof", () => {
  const reference = {
    kind: "stopHost",
    requestId: randomUUID(),
    home: "/tmp/host",
    hostId: randomUUID(),
    generation: randomUUID(),
    strategy: "cancel",
  };
  const target = {
    projectId: "cli-only",
    serviceId: "core",
    serviceGeneration: randomUUID(),
    requestId: randomUUID(),
    dispatch: "started",
  };
  target.receipt = {
    version: 1,
    requestId: target.requestId,
    projectId: target.projectId,
    serviceId: target.serviceId,
    serviceGeneration: target.serviceGeneration,
    strategy: "cancel",
    state: "completed",
  };
  const receipt = {
    version: 1,
    requestId: reference.requestId,
    hostId: reference.hostId,
    generation: reference.generation,
    strategy: "cancel",
    state: "completed",
    projects: [target],
  };
  assert.equal(readHostReceipt(reference, receipt), receipt);
  for (const delta of [
    { hostId: randomUUID() },
    { generation: randomUUID() },
    { requestId: randomUUID() },
    { strategy: "ifIdle" },
    { projects: [{ ...target, receipt: { ...target.receipt, state: "acceptedPending" } }] },
    { projects: [{ ...target, receipt: { ...target.receipt, serviceGeneration: randomUUID() } }] },
  ])
    assert.throws(() => readHostReceipt(reference, { ...receipt, ...delta }), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
});
test("offline original lookup invokes only host operation with the original home and ID", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID(),
    reference = {
      kind: "stopHost",
      requestId,
      home: f.hostHome,
      hostId: f.hostId,
      generation: f.generation,
      strategy: "cancel",
    };
  const binary = join(f.root, "offline-fixture");
  await writeFile(
    binary,
    `#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\np=Path(os.environ['AREAL_HARNESS_HOME'])\n(p/'argv.json').write_text(json.dumps(sys.argv[1:]))\nprint((p/'original.json').read_text())\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(f.hostHome, "original.json"),
    JSON.stringify({ operation: f.receipt(requestId) }),
  );
  f.backend.options.binary = binary;
  f.backend.hostReferences.set(requestId, reference);
  f.setHandler(async (_request, socket) => {
    socket.destroy();
  });
  const result = await f.backend.readHostStop(reference);
  assert.equal(result.stopped, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.hostHome, "argv.json"), "utf8")), [
    "host",
    "operation",
    requestId,
    "--json",
  ]);
  assert.equal(
    f.calls.some((request) => request.method === "host.stop"),
    false,
  );
});

test("passive activity failure creates no Host directories or starts", async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, "missing");
  f.backend.options.hostHome = missing;
  await assert.rejects(f.backend.readHostActivity());
  await assert.rejects(require("node:fs/promises").stat(missing), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});
test("concurrent stop callers share one dispatch and a new intent follows settled refusal", async (t) => {
  const f = await fixture(t);
  let count = 0;
  f.setHandler(async (request) => {
    assert.equal(request.method, "host.stop");
    count++;
    await new Promise((done) => setTimeout(done, 10));
    return f.receipt(request.params.requestId, count === 1 ? "blocked" : "completed");
  });
  const [a, b] = await Promise.all([
    f.backend.requestHostStop({ strategy: "cancel" }),
    f.backend.requestHostStop({ strategy: "cancel" }),
  ]);
  assert.equal(a.operation.requestId, b.operation.requestId);
  assert.equal(a.stopped, false);
  assert.equal(count, 1);
  const c = await f.backend.requestHostStop({ strategy: "cancel" });
  assert.equal(c.stopped, true);
  assert.notEqual(c.operation.requestId, a.operation.requestId);
  assert.equal(count, 2);
});

test("completed original stop cannot clear successor Main terminal ownership", async (t) => {
  const f = await fixture(t);
  let requestId;
  f.setHandler(async (request) => {
    if (request.method === "host.stop") {
      requestId = request.params.requestId;
      return f.receipt(requestId, "acceptedPending");
    }
    return { operation: f.receipt(request.params.requestId) };
  });
  const first = await f.backend.requestHostStop({ strategy: "cancel" });
  assert.equal(first.stopped, false);
  const { NativeTerminalOwners } = require("@areal/workbench-service/native-host-transport");
  f.backend.terminalConnections = new NativeTerminalOwners({ options: () => ({}) });
  let closed = false;
  f.backend.connection = { close: () => (closed = true) };
  f.backend.status.connected = true;
  f.backend.connectionState = { state: "ready" };
  f.backend.guiTerminals.set("successor", { projectId: "new", threadId: "new", id: "successor" });
  const final = await f.backend.readHostStop(f.backend.hostReferences.get(requestId));
  assert.equal(final.stopped, true);
  assert.equal(f.backend.terminalConnections.closed, false);
  assert.equal(f.backend.guiTerminals.has("successor"), true);
  assert.equal(closed, false);
  assert.equal(f.backend.snapshot().connection.state, "ready");
});
for (const state of ["partial", "settlementIncomplete", "completed"]) {
  test(`${state} original stop is queried without a new stop intent`, async (t) => {
    const f = await fixture(t);
    let original;
    f.setHandler(async (request) => {
      if (request.method === "host.stop") {
        original = f.receipt(request.params.requestId, state);
        return original;
      }
      assert.equal(request.method, "host.operation");
      assert.equal(request.params.requestId, original.requestId);
      return { operation: original };
    });
    const first = await f.backend.requestHostStop({ strategy: "cancel" });
    const second = await f.backend.requestHostStop({ strategy: "cancel" });
    assert.equal(first.operation.requestId, second.operation.requestId);
    assert.equal(second.stopped, state === "completed");
    assert.equal(f.calls.filter((request) => request.method === "host.stop").length, 1);
  });
}
test("automatic initialization checks completed stop without starting Host; explicit reconnect clears it", async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  const reference = {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
  };
  f.operations.set(requestId, f.receipt(requestId));
  f.backend.hostReferences.set(requestId, reference);
  await f.backend.persistReferences();
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
  };
  await f.backend.init({ automatic: true });
  assert.equal(starts, 0);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(f.backend.connectionState.recovery, "reconnect");
  assert.equal(f.backend.canReconnect(), false);
  await f.backend.init();
  assert.equal(starts, 1);
  assert.equal(f.backend.hostReferences.size, 0);
  assert.equal(
    f.calls.some((request) => request.method === "host.stop"),
    false,
  );
});

test("new explicit stop targets a successor generation after the original completed", async (t) => {
  const f = await fixture(t);
  f.setHandler(async (request) => {
    if (request.method === "host.stop") {
      const receipt = f.receipt(request.params.requestId);
      assert.equal(request.params.expectedGeneration, receipt.generation);
      f.operations.set(receipt.requestId, receipt);
      return receipt;
    }
    return { operation: f.operations.get(request.params.requestId) };
  });
  const first = await f.backend.requestHostStop({ strategy: "cancel" });
  const successor = randomUUID();
  await f.setGeneration(successor);
  const second = await f.backend.requestHostStop({ strategy: "cancel" });
  assert.equal(second.stopped, true);
  assert.equal(second.receipt.generation, successor);
  assert.notEqual(first.operation.requestId, second.operation.requestId);
  assert.equal(f.calls.filter((request) => request.method === "host.stop").length, 2);
  assert.equal(f.backend.hostReferences.get(first.operation.requestId).generation, f.generation);
});
test("blocked automatic startup exposes explicit reconnect and recovery starts only on user action", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  f.operations.set(requestId, f.receipt(requestId, "blocked"));
  f.backend.hostReferences.set(requestId, {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
  });
  await f.backend.persistReferences();
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
  };
  await f.backend.init({ automatic: true });
  assert.equal(starts, 0);
  assert.equal(f.backend.connectionState.recovery, "reconnect");
  assert.deepEqual(await f.backend.recoverBackend({ notify: async () => ({ response: 0 }) }), {
    recovered: true,
  });
  assert.equal(starts, 1);
});
test("unverifiable successor discovery does not report the original completion as a fresh stop", async (t) => {
  const f = await fixture(t);
  f.setHandler(async (request) => {
    if (request.method === "host.stop") {
      const receipt = f.receipt(request.params.requestId);
      f.operations.set(receipt.requestId, receipt);
      return receipt;
    }
    return { operation: f.operations.get(request.params.requestId) };
  });
  await f.backend.requestHostStop({ strategy: "cancel" });
  await writeFile(
    join(f.hostHome, "host/host.json"),
    JSON.stringify({ version: 1, generation: "invalid" }),
    { mode: 0o600 },
  );
  await assert.rejects(
    f.backend.requestHostStop({ strategy: "cancel" }),
    /Invalid Host descriptor/,
  );
  assert.equal(f.calls.filter((request) => request.method === "host.stop").length, 1);
});

test("in-place project reconnect refreshes source bindings through an existing Host without import or activation", async (t) => {
  const f = await fixture(t);
  const {
    GuiHostProjects,
  } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
  const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
  const source = {
    profile: f.profile,
    coreHome: join(f.profile, "core"),
    legacyServiceHome: join(f.root, "legacy"),
  };
  await mkdir(source.coreHome, { recursive: true });
  const sourceId = randomUUID();
  const registration = {
    projectId: "independent-cli",
    workspace: join(f.root, "workspace"),
    dataDir: join(f.root, "state"),
    source: { kind: "cli" },
    defaultBinding: true,
  };
  f.setHandler(async (request) => {
    if (request.method === "gui.source") return { sourceId, bindings: [] };
    if (request.method === "host.status") return { projects: [] };
    assert.equal(request.method, "projects.list");
    return { projects: [registration] };
  });
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: f.hostHome,
    source,
    singletonHeld: true,
  });
  owner.sourceId = sourceId;
  await owner.client.connect(f.hostHome);
  const client = owner.client;
  owner.bindings.set("stale", {});
  await f.setGeneration(randomUUID());
  let changes = 0;
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    host: owner,
    closing: false,
    saved: [],
    onChange: () => changes++,
  });
  const result = await backend.reconnectHost();
  assert.equal(owner.client, client);
  assert.equal(result.generation, owner.client.generation);
  assert.equal(owner.bindings.has("stale"), false);
  assert.equal(backend.saved.length, 1);
  assert.equal(backend.saved[0].root, registration.workspace);
  assert.equal(changes, 1);
  assert.deepEqual(
    f.calls.filter((request) => request.method !== "hello").map((request) => request.method),
    ["gui.source", "gui.source", "projects.list", "gui.source", "projects.list", "host.status"],
  );
  owner.close();
});
test("Desktop Host reconnect is available only to its authenticated Main owner", async () => {
  const {
    DesktopService,
    PROTOCOL,
  } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
  let reconnects = 0;
  const backend = {
    projects: new Map(),
    providers: { redact: (value) => value },
    analytics: { sample() {} },
    starting: new Map(),
    hasWork: () => false,
    reconnectHost: async () => {
      reconnects++;
      return { hostId: "host", generation: "next" };
    },
  };
  const desktop = new DesktopService(backend, "fixture");
  desktop.schedule = () => {};
  const socket = () => ({
    readyState: 1,
    bufferedAmount: 0,
    packets: [],
    send(value, done) {
      this.packets.push(JSON.parse(value));
      done?.();
    },
  });
  const main = socket(),
    observer = socket();
  desktop.clients.add(main);
  desktop.clients.add(observer);
  desktop.computerSocket = main;
  await desktop.receive(
    observer,
    Buffer.from(JSON.stringify({ id: 1, method: "hostReconnect", params: { protocol: PROTOCOL } })),
  );
  assert.equal(reconnects, 0);
  assert.match(observer.packets[0].error.message, /current local Main/);
  await desktop.receive(
    main,
    Buffer.from(JSON.stringify({ id: 2, method: "hostReconnect", params: { protocol: PROTOCOL } })),
  );
  assert.equal(reconnects, 1);
  assert.deepEqual(main.packets[0].result, { hostId: "host", generation: "next" });
  desktop.close();
});
test("failed explicit reconnect keeps the original Host reference durable", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  f.operations.set(requestId, f.receipt(requestId));
  f.backend.hostReferences.set(requestId, {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
  });
  await f.backend.persistReferences();
  f.backend.initialize = async () => {
    throw new Error("explicit reconnect failed");
  };
  await assert.rejects(f.backend.init(), /explicit reconnect failed/);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references[0].requestId,
    requestId,
  );
});
test("missing Core executable preserves the original explicit Host recovery intent", async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  f.operations.set(requestId, f.receipt(requestId));
  f.backend.hostReferences.set(requestId, {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
  });
  await f.backend.persistReferences();
  let reconnects = 0;
  f.backend.attach = async () => {
    f.backend.status.connected = true;
    f.backend.connection = {
      request: async () => {
        reconnects++;
      },
    };
    return true;
  };
  await assert.rejects(f.backend.init(), /Core 程序路径不可用/);
  assert.equal(reconnects, 0);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references[0].requestId,
    requestId,
  );
  await assert.rejects(f.backend.initialize(), /Core 程序路径不可用/);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references[0].requestId,
    requestId,
  );
  assert.equal(reconnects, 0);
});
test("explicit reconnect rejects a simultaneous new stop before any dispatch", async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  f.operations.set(requestId, f.receipt(requestId));
  f.backend.hostReferences.set(requestId, {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
  });
  await f.backend.persistReferences();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.backend.initialize = async () => {
    entered.resolve();
    await release.promise;
  };
  const connecting = f.backend.init();
  await entered.promise;
  await assert.rejects(f.backend.requestHostStop({ strategy: "cancel" }), {
    code: "LIFECYCLE_BLOCKED",
  });
  assert.equal(
    f.calls.some((request) => request.method === "host.stop"),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references[0].requestId,
    requestId,
  );
  release.resolve();
  await connecting;
});
test("an in-flight stop rejects reconnect and keeps the new UNKNOWN reference durable", async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let requestId;
  f.setHandler(async (request) => {
    if (request.method === "host.stop") {
      requestId = request.params.requestId;
      const receipt = f.receipt(requestId, "admissionUnknown");
      f.operations.set(requestId, receipt);
      entered.resolve();
      await release.promise;
      return receipt;
    }
    return { operation: f.operations.get(request.params.requestId) };
  });
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
  };
  const stopping = f.backend.requestHostStop({ strategy: "cancel" });
  await entered.promise;
  await assert.rejects(f.backend.init(), { code: "LIFECYCLE_BLOCKED" });
  assert.equal(starts, 0);
  release.resolve();
  const result = await stopping;
  assert.equal(result.stopped, false);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references[0].requestId,
    requestId,
  );
  await f.backend.init();
  assert.equal(starts, 0);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(f.calls.filter((request) => request.method === "host.stop").length, 1);
});
