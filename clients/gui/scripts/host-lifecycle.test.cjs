"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { mkdir, realpath, writeFile, readFile, chmod } = require("node:fs/promises");
const { trackedMkdtemp } = require("./support/host-cleanup.cjs");
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
  const root = await realpath(await trackedMkdtemp("/tmp/ah-host-stop-"));
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
                "idleReleaseV1",
                "stopOperations",
                "guiImport",
                "projects",
                "scheduledActivation",
                "scheduledPreparation",
              ],
            };
          } else if (request.method === "host.release")
            result = { requestId: request.params.requestId, generation, state: "armed" };
          else if (handler) result = await handler(request, socket);
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

test("ordinary quit arms the original reclamation request without stopping a shared Host", async (t) => {
  const f = await fixture(t);
  await f.backend.completeApplicationQuit({ keepBackground: true });
  const reopened = new SharedCoreBackend({
    app: { getPath: () => f.profile },
    home: f.home,
    hostHome: f.hostHome,
  });
  await reopened.completeApplicationQuit({ keepBackground: true });
  const requests = f.calls.filter((request) => request.method === "host.release");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.requestId, requests[1].params.requestId);
  assert.equal(requests[0].params.expectedGeneration, f.generation);
  assert.equal(
    f.calls.some((request) => request.method === "host.stop"),
    false,
  );
});
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
  const { NativeTerminalOwners } = require("../app/src/core/generated/native-host-transport.cjs");
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
    [
      "gui.source",
      "gui.source",
      "projects.list",
      "host.status",
      "gui.source",
      "projects.list",
      "host.status",
      "host.status",
    ],
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
  desktop.browserSocket = main;
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
  await assert.rejects(f.backend.init(), /Host 后台启动配置不完整/);
  assert.equal(reconnects, 0);
  assert.equal(f.backend.hostReferences.has(requestId), true);
  assert.equal(
    JSON.parse(await readFile(f.backend.controlPath, "utf8")).references[0].requestId,
    requestId,
  );
  await assert.rejects(f.backend.initialize(), /Host 后台启动配置不完整/);
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

test("automatic initialization resumes after a definitively refused Host stop", async (t) => {
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
  f.operations.set(requestId, { ...f.receipt(requestId, "blocked"), preparationInterrupted: true });
  f.backend.hostReferences.set(requestId, reference);
  await f.backend.persistReferences();
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
  };
  await f.backend.init({ automatic: true });
  assert.equal(starts, 1);
  assert.equal(f.backend.hostReferences.size, 0);
  assert.equal(
    f.calls.some((request) => request.method === "host.stop"),
    false,
  );
});

test("native Main handles Host-created leases on independent callback socket", async (t) => {
  const f = await fixture(t);
  const {
    createNativeHostTransport,
  } = require("../app/src/core/generated/native-host-transport.cjs");
  let eventSocket, callSocket;
  const reply = Promise.withResolvers();
  const frame = {
    event: "core.callback",
    requestId: "host-request",
    coreRequestId: 17,
    projectId: "project",
    lease: "host-created-lease",
    coreInstanceId: "core",
    coreGeneration: "generation",
    sourceId: "source",
    connectionId: "original-connection",
    guiProjectId: "logical",
    workspacePath: f.root,
    method: "item/tool/call",
    params: { tool: "browser_v1" },
  };
  f.setHandler(async (request, socket) => {
    if (request.method === "desktop.core.subscribe") {
      eventSocket = socket;
      return { attachmentId: "attachment" };
    }
    if (request.method === "desktop.core.call") {
      callSocket = socket;
      eventSocket.write(
        JSON.stringify({
          version: 1,
          method: "desktop.core.event",
          params: { attachmentId: "attachment", event: frame },
        }) + "\n",
      );
      return await reply.promise;
    }
    assert.equal(request.method, "desktop.core.callback");
    assert.notEqual(socket, callSocket);
    assert.notEqual(socket, eventSocket);
    assert.deepEqual(request.params, {
      attachmentId: "attachment",
      requestId: "host-request",
      result: { handled: true },
    });
    reply.resolve({ result: { alive: true } });
    return { received: true };
  });
  const transport = await createNativeHostTransport({
    home: f.hostHome,
    sourceId: "source",
    launch: {},
    onCallback: async (received, signal) => {
      assert.deepEqual(received, frame);
      assert.equal(signal.aborted, false);
      return { handled: true };
    },
    onEvent: () => {},
    onClosed: () => {},
  });
  t.after(() => transport.close());
  assert.deepEqual(
    await transport.call("core.request", { projectId: "project", lease: frame.lease }),
    { result: { alive: true } },
  );
});

test("native callback cancellation binds the original lease and request", async (t) => {
  const f = await fixture(t);
  const {
    createNativeHostTransport,
  } = require("../app/src/core/generated/native-host-transport.cjs");
  let eventSocket;
  const started = Promise.withResolvers(),
    cancelled = Promise.withResolvers(),
    answered = Promise.withResolvers(),
    observed = Promise.withResolvers();
  f.setHandler(async (request, socket) => {
    if (request.method === "desktop.core.subscribe") {
      eventSocket = socket;
      return { attachmentId: "attachment" };
    }
    assert.equal(request.method, "desktop.core.callback");
    assert.deepEqual(request.params.error, { message: "Desktop tool unavailable" });
    answered.resolve();
    return { received: true };
  });
  const transport = await createNativeHostTransport({
    home: f.hostHome,
    sourceId: "source",
    launch: {},
    onCallback: async (_, signal) => {
      started.resolve(signal);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      cancelled.resolve();
      return { lateSuccess: true };
    },
    onEvent: () => observed.resolve(),
    onClosed: () => {},
  });
  t.after(() => transport.close());
  const emit = (event) =>
    eventSocket.write(
      JSON.stringify({
        version: 1,
        method: "desktop.core.event",
        params: { attachmentId: "attachment", event },
      }) + "\n",
    );
  emit({
    event: "core.callback",
    requestId: "callback",
    coreRequestId: 17,
    projectId: "project",
    lease: "original",
    coreInstanceId: "core",
    coreGeneration: "generation",
    sourceId: "source",
    connectionId: "connection",
    guiProjectId: "logical",
    workspacePath: f.root,
    method: "item/tool/call",
    params: {},
  });
  const signal = await started.promise;
  emit({
    event: "core.event",
    lease: "other",
    method: "areal/tool/cancelled",
    params: { requestId: 17 },
  });
  await observed.promise;
  assert.equal(signal.aborted, false);
  emit({
    event: "core.event",
    lease: "original",
    method: "areal/tool/cancelled",
    params: { requestId: 17 },
  });
  await cancelled.promise;
  await answered.promise;
  assert.equal(transport.closed, false);
});

test("production Main installs native callback ownership before a late subscription baseline", async (t) => {
  const f = await fixture(t);
  const received = Promise.withResolvers(),
    revoked = Promise.withResolvers();
  let eventSocket;
  const frame = {
    event: "core.callback",
    sourceId: "source",
    requestId: "callback",
    coreRequestId: 17,
    projectId: "execution",
    guiProjectId: "logical",
    workspacePath: f.root,
    lease: "original-lease",
    coreInstanceId: "core",
    coreGeneration: "generation",
    connectionId: "connection",
    method: "item/tool/call",
    params: { threadId: "thread" },
  };
  const emit = (event) =>
    eventSocket.write(
      JSON.stringify({
        version: 1,
        method: "desktop.core.event",
        params: { attachmentId: "attachment", event },
      }) + "\n",
    );
  f.setHandler(async (request, socket) => {
    if (request.method === "desktop.core.subscribe") {
      eventSocket = socket;
      // 先送事件，覆盖订阅回复与事件处于同一读取批次时的微任务顺序。
      emit(frame);
      return { attachmentId: "attachment" };
    }
    if (request.method === "desktop.core.call") {
      assert.equal(request.params.call, "core.blob");
      assert.equal(request.params.params.lease, frame.lease);
      return { uri: "areal://media/original" };
    }
    assert.equal(request.method, "desktop.core.callback");
    assert.deepEqual(request.params.result, { handled: true });
    received.resolve();
    return { received: true };
  });
  f.backend.onNativeBrowserRequest = async (callback) => {
    assert.equal(f.backend.nativeBrowserCurrent(callback), true);
    assert.equal(f.backend.ownsThread("logical", "thread"), true);
    assert.equal(f.backend.browserCoreIdentity("logical", "thread"), "core");
    assert.equal(
      f.backend.nativeBrowserWorkspace({ projectId: "logical", threadId: "thread" }).root,
      f.root,
    );
    const image = await f.backend.nativeBrowserCall("core.blob", {
      projectId: "execution",
      lease: callback.lease,
    });
    assert.equal(image.uri, "areal://media/original");
    return { handled: true };
  };
  f.backend.onNativeBrowserRevoked = (projectId, threadId) =>
    revoked.resolve({ projectId, threadId });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  await received.promise;
  emit({ event: "core.event", lease: "other-lease", method: "host/connectionClosed" });
  emit({
    event: "core.event",
    lease: frame.lease,
    method: "areal/thread/archived",
    params: { threadId: "thread" },
  });
  assert.deepEqual(await revoked.promise, { projectId: "logical", threadId: "thread" });
  assert.equal(f.backend.ownsThread("logical", "thread"), false);
});

test("preview resolves the original native Thread scope before any browser callback", async (t) => {
  const f = await fixture(t);
  const scope = {
    sourceId: "source",
    projectId: "execution",
    guiProjectId: "logical",
    threadId: "thread",
    workspacePath: f.root,
    lease: "native-lease",
    coreInstanceId: "core",
    coreGeneration: "core-generation",
    connectionId: "core-connection",
  };
  let release;
  const waiting = Promise.withResolvers();
  f.setHandler(async (request) => {
    if (request.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(request.method, "desktop.core.call");
    assert.equal(request.params.call, "browser.scope");
    assert.deepEqual(request.params.params, { projectId: "logical", threadId: "thread" });
    if (release) {
      waiting.resolve();
      await release;
    }
    return scope;
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  f.backend.command = async () => {
    throw new Error("legacy Node path used");
  };
  await f.backend.ensureBrowserThread("logical", "thread");
  assert.equal(f.backend.ownsThread("logical", "thread"), true);
  assert.equal(f.backend.browserCoreIdentity("logical", "thread"), "core");
  assert.equal(
    f.backend.nativeBrowserWorkspace({ projectId: "logical", threadId: "thread" }).root,
    f.root,
  );
  let finish;
  release = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = f.backend.ensureBrowserThread("logical", "thread");
  await waiting.promise;
  f.backend.closeNativeBrowser();
  finish();
  await assert.rejects(pending, /changed|unavailable|disconnected/i);
  assert.equal(f.backend.ownsThread("logical", "thread"), false);
});

test("project picker registers through the native Host without a Node projection", async (t) => {
  const f = await fixture(t);
  f.setHandler(async (request) => {
    if (request.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(request.method, "desktop.core.call");
    assert.equal(request.params.call, "worktree.project.add");
    assert.deepEqual(request.params.params, { root: f.root });
    return { projectId: "a".repeat(24) };
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  f.backend.init = async () => {};
  assert.equal(await f.backend.addProject(f.root), "a".repeat(24));
  assert.equal(f.backend.connection, undefined);
});

test("projectless preparations use the native source without a Node connection", async (t) => {
  const f = await fixture(t);
  const request = { operation: "prepare", requestId: randomUUID() };
  f.setHandler(async (frame) => {
    if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(frame.method, "desktop.core.call");
    assert.equal(frame.params.call, "projectless.command");
    assert.deepEqual(frame.params.params, request);
    return { projectId: "a".repeat(24), cwd: f.root };
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  assert.deepEqual(await f.backend.command("projectless", request), {
    projectId: "a".repeat(24),
    cwd: f.root,
  });
  assert.equal(f.backend.connection, undefined);
});

test("a selected plugin archive imports on the persistent native source without Node", async (t) => {
  const f = await fixture(t);
  const { PluginArchives } = require("../app/src/core/plugin-archives.cjs");
  const requestId = randomUUID();
  f.setHandler(async (frame) => {
    if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(frame.method, "desktop.command");
    assert.deepEqual(frame.params, {
      sourceId: "source",
      command: "manage",
      request: {
        operation: "pluginArchiveImport",
        projectId: "project",
        path: join(f.root, "plugin.zip"),
        expectedRevision: 7,
        requestId,
      },
    });
    return { id: "imported-plugin" };
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  f.backend.status.commandContract =
    require("@areal/workbench-service/desktop/core/service-protocol.cjs").COMMAND_CONTRACT;
  f.backend.value.projects = [{ id: "project", root: f.root }];
  const archives = new PluginArchives({
    backend: f.backend,
    choose: async () => ({ canceled: false, filePaths: [join(f.root, "plugin.zip")] }),
  });
  const selection = await archives.command(
    { operation: "pluginArchivePick", projectId: "project" },
    () => {},
  );
  assert.deepEqual(
    await archives.command(
      {
        operation: "pluginArchiveImport",
        projectId: "project",
        selectionToken: selection.selectionToken,
        requestId,
        expectedRevision: 7,
      },
      () => {},
    ),
    { id: "imported-plugin" },
  );
  assert.equal(f.backend.connection, undefined);
  const business = f.calls.filter((frame) => frame.method === "desktop.command");
  assert.equal(business.length, 1);
});

test("native command late replies cannot settle a replacement source or replay a mutation", async (t) => {
  const f = await fixture(t);
  let release;
  const reply = new Promise((resolve) => {
    release = resolve;
  });
  let admitted;
  const entered = new Promise((resolve) => {
    admitted = resolve;
  });
  f.setHandler(async (frame) => {
    if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(frame.method, "desktop.command");
    admitted();
    await reply;
    return { id: "imported-plugin" };
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  f.backend.status.commandContract =
    require("@areal/workbench-service/desktop/core/service-protocol.cjs").COMMAND_CONTRACT;
  const requestId = randomUUID();
  const pending = f.backend.command("manage", {
    operation: "pluginArchiveImport",
    projectId: "project",
    path: join(f.root, "plugin.zip"),
    expectedRevision: 0,
    requestId,
  });
  const rejected = assert.rejects(
    pending,
    (error) =>
      error.code === "RESYNC_REQUIRED" &&
      error.requestId === requestId &&
      error.submissionUnknown === true,
  );
  await entered;
  f.backend.nativeBrowserEpoch = {};
  release();
  await rejected;
  assert.equal(f.calls.filter((frame) => frame.method === "desktop.command").length, 1);
});

for (const replaced of [false, true])
  test(`native lifecycle recovery reads the original Host receipt (replacement=${replaced})`, async (t) => {
    const f = await fixture(t);
    const requestId = randomUUID(),
      desktopGeneration = randomUUID();
    const reference = {
      requestId,
      desktopGeneration,
      kind: "stopProject",
      mode: "cancel",
      desktop: { pid: process.pid, identity: "original-desktop" },
      targets: [
        { projectId: "project", serviceId: "original-core", generation: "original-generation" },
      ],
    };
    const receipt = {
      version: 1,
      requestId,
      desktopGeneration,
      kind: "stopProject",
      mode: "cancel",
      phase: "completed",
      desktopExit: "notRequested",
      targets: [{ ...reference.targets[0], phase: "completed" }],
    };
    f.setHandler(async (frame) => {
      if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
      assert.equal(frame.method, "desktop.core.call");
      assert.equal(frame.params.call, "lifecycle.read");
      assert.deepEqual(frame.params.params, {
        sourceId: "source",
        operation: "reconcile",
        requestId,
        desktopGeneration,
      });
      if (replaced) f.backend.nativeBrowserEpoch = {};
      return receipt;
    });
    await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
    t.after(() => f.backend.closeNativeBrowser());
    f.backend.status.connected = true;
    f.backend.lifecycleReferences.set(requestId, reference);
    if (replaced) {
      await assert.rejects(
        f.backend.readLifecycle(reference),
        (error) => error.code === "RESYNC_REQUIRED",
      );
      assert.equal(f.backend.lifecycleReferences.get(requestId), reference);
      assert.equal(f.backend.lifecycleReceipts.size, 0);
    } else {
      assert.deepEqual(await f.backend.readLifecycle(reference), receipt);
      assert.equal(f.backend.lifecycleReferences.size, 0);
    }
    assert.equal(f.backend.connection, undefined);
  });

test("resource settings use the native source without a Node connection", async (t) => {
  const f = await fixture(t);
  const request = { operation: "skills", scope: "user" };
  const response = { revision: 0, data: [], customDeployment: false };
  f.setHandler(async (frame) => {
    if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(frame.method, "desktop.core.call");
    assert.equal(frame.params.call, "resources.command");
    assert.deepEqual(frame.params.params, request);
    return response;
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  assert.deepEqual(await f.backend.command("resources", request), response);
  assert.equal(f.backend.connection, undefined);
});

test("cold lifecycle recovery reads the original receipt without opening a workbench connection", async (t) => {
  const f = await fixture(t);
  f.backend.options.guiProfile = f.profile;
  const requestId = randomUUID(),
    desktopGeneration = randomUUID();
  const reference = {
    requestId,
    desktopGeneration,
    kind: "stopProject",
    mode: "cancel",
    desktop: { pid: process.pid, identity: "original-desktop" },
    targets: [{ projectId: "project", serviceId: "core", generation: "original" }],
  };
  f.backend.lifecycleReferences.set(requestId, reference);
  const receipt = {
    version: 1,
    requestId,
    desktopGeneration,
    kind: reference.kind,
    mode: reference.mode,
    phase: "admissionUnconfirmed",
    desktopExit: "notRequested",
    targets: [{ ...reference.targets[0], phase: "admissionUnconfirmed" }],
  };
  f.setHandler(async (frame) => {
    assert.equal(frame.method, "lifecycle.read");
    assert.deepEqual(frame.params, {
      profile: f.profile,
      requestId,
      desktopGeneration,
      operation: "reconcile",
    });
    return receipt;
  });
  assert.deepEqual(await f.backend.readLifecycle(reference), receipt);
  assert.equal(f.backend.lifecycleReferences.get(requestId), reference);
  assert.equal(f.backend.connection, undefined);
  assert.equal(f.calls.filter((frame) => frame.method === "lifecycle.read").length, 1);
});

test("Skill Creator preparation uses native Host without a Node connection", async (t) => {
  const f = await fixture(t);
  const request = { projectId: "project", profile: { id: "standard", revision: "v2" } };
  const response = {
    projectId: "project",
    profile: request.profile,
    skill: {
      id: "openai-skill-creator",
      revision: "pinned",
      name: "Skill Creator",
      description: "Create skills",
    },
    provenance: {
      upstream: "https://github.com/openai/skills",
      revision: "upstream",
      contentDigest: "digest",
    },
  };
  f.setHandler(async (frame) => {
    if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(frame.method, "desktop.core.call");
    assert.equal(frame.params.call, "resources.prepareCreator");
    assert.deepEqual(frame.params.params, request);
    return response;
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  assert.deepEqual(await f.backend.command("prepareCreator", request), response);
  assert.equal(f.backend.connection, undefined);
});

test("legacy Cloud import binds original bytes and native source without rewriting ciphertext", async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({
    baseURL: "https://cloud.example.invalid",
    secret: Buffer.from("ciphertext").toString("base64"),
  });
  const path = join(f.home, "cloud.json");
  await writeFile(path, raw, { mode: 0o600 });
  f.backend.nativeBrowserEpoch = {};
  f.backend.nativeBrowserSource = "source";
  const imports = [];
  f.backend.nativeBrowserCall = async (call, params) => {
    if (call === "cloud.settings")
      throw Object.assign(new Error("Import pending"), { code: "CLOUD_IMPORT_REQUIRED" });
    assert.equal(call, "cloud.import");
    imports.push(params);
    return { baseURL: "wss://cloud.example.invalid/openapi/v1/app-server", tokenConfigured: true };
  };
  const encryption = {
    isEncryptionAvailable: () => true,
    decryptString: (value) => {
      assert.equal(value.toString(), "ciphertext");
      return "synthetic-import-token";
    },
  };
  await f.backend.importNativeCloud("source", encryption);
  await f.backend.importNativeCloud("source", encryption);
  assert.equal(imports.length, 2);
  assert.deepEqual(imports[0], imports[1]);
  assert.match(imports[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(imports[0].token, "synthetic-import-token");
  assert.equal(await readFile(path, "utf8"), raw);
  const original = f.backend.nativeBrowserEpoch;
  f.backend.nativeBrowserCall = async () => {
    f.backend.nativeBrowserEpoch = {};
    throw Object.assign(new Error("Import pending"), { code: "CLOUD_IMPORT_REQUIRED" });
  };
  await assert.rejects(f.backend.importNativeCloud("source", encryption), /source changed/);
  assert.notEqual(f.backend.nativeBrowserEpoch, original);
});

for (const [command, call, request, response] of [
  ["cloud", "cloud.settings", { operation: "status" }, { baseURL: "", tokenConfigured: false }],
  [
    "cloudSession",
    "cloud.session",
    { operation: "create", projectId: "project", requestId: "creation" },
    { threadId: "thread", sessionId: "creation" },
  ],
]) {
  test(`${command} uses the native source without a Node connection`, async (t) => {
    const f = await fixture(t);
    f.setHandler(async (frame) => {
      if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
      assert.equal(frame.method, "desktop.core.call");
      assert.equal(frame.params.call, call);
      assert.deepEqual(frame.params.params, request);
      return response;
    });
    await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
    t.after(() => f.backend.closeNativeBrowser());
    f.backend.status.connected = true;
    assert.deepEqual(await f.backend.command(command, request), response);
    assert.equal(f.backend.connection, undefined);
  });
}

test("GUI terminals use native Host commands and confirm cleanup without a Node connection", async (t) => {
  const f = await fixture(t);
  const request = {
    operation: "processStart",
    projectId: "project",
    threadId: "thread",
    requestId: randomUUID(),
    guiOwned: true,
    lifetime: "connection",
    terminal: true,
    tty: true,
  };
  let closed = false;
  const operations = [];
  f.setHandler(async (frame) => {
    if (frame.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(frame.method, "desktop.core.call");
    assert.equal(frame.params.call, "terminal.command");
    const params = frame.params.params;
    operations.push(params.operation);
    assert.equal(params.projectId, "project");
    assert.equal(params.threadId, "thread");
    assert.equal(params.guiOwned, true);
    if (params.operation === "processStart") {
      assert.equal(params.requestId, request.requestId);
      return { id: "native-terminal" };
    }
    if (params.operation === "processes")
      return { data: [{ id: "native-terminal", cleanupConfirmed: closed }] };
    if (params.operation === "processTerminate") {
      closed = true;
      return {};
    }
    assert.fail(`unexpected native terminal operation ${params.operation}`);
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  assert.deepEqual(await f.backend.command("manage", request), { id: "native-terminal" });
  assert.equal(f.backend.guiTerminals.has("native-terminal"), true);
  await f.backend.settleGuiTerminals();
  assert.deepEqual(operations, ["processStart", "processes", "processTerminate", "processes"]);
  assert.equal(f.backend.guiTerminals.size, 0);
  assert.equal(f.backend.connection, undefined);
});

test("native shell uses the shared Host read contract and never starts a Node backend", async (t) => {
  const f = await fixture(t);
  const { WebSocketServer } = require("node:module").createRequire(
    require.resolve("../app/package.json"),
  )("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  const methods = [];
  const shell = {
    projects: [
      {
        projectId: "canonical",
        workspace: f.root,
        projectless: false,
        state: "stopped",
        summaries: { state: "unknown", items: [] },
        attention: { state: "unknown" },
      },
    ],
    navigation: [
      {
        sourceId: "source",
        state: "available",
        bindings: [{ projectId: "canonical", alias: "alias", projectless: false }],
        preferences: {},
        settings: { showInMenuBar: false },
        projects: {},
        threads: {},
        projectOrder: ["alias"],
        sections: [],
        sidebarThreadOrder: [],
        sidebarRevision: 0,
      },
    ],
  };
  const identity = {
    connectionId: "read",
    gatewayGeneration: f.generation,
    subscriptionId: "shell",
    sequence: 0,
  };
  let socket;
  server.on("connection", (ws, request) => {
    assert.equal(request.headers.origin, "areal-ui://app");
    socket = ws;
    ws.on("message", (raw) => {
      const q = JSON.parse(String(raw));
      methods.push(q.method);
      const result =
        q.method === "hello"
          ? {
              hostId: f.hostId,
              generation: f.generation,
              negotiatedCapabilities: ["gui-read-v1"],
              connectionId: "read",
              gatewayGeneration: f.generation,
            }
          : q.method === "host.status"
            ? {
                hostId: f.hostId,
                generation: f.generation,
                state: "running",
                restartPending: false,
                stopIntent: false,
                capabilities: [],
                projects: [],
              }
            : { ...identity, snapshot: shell };
      ws.send(JSON.stringify({ version: 1, id: q.id, result }));
    });
  });
  f.setHandler(async (q) => {
    assert.equal(q.method, "web.ticket");
    assert.equal(q.params.profile, f.profile);
    return {
      version: 1,
      hostId: f.hostId,
      generation: f.generation,
      origin: "areal-ui://app",
      websocketUrl: `ws://127.0.0.1:${server.address().port}/`,
      ticket: "synthetic",
      expiresAt: Date.now() + 30000,
    };
  });
  const updates = [];
  let changed;
  const change = new Promise((resolve) => {
    changed = resolve;
  });
  let disconnected;
  const disconnect = new Promise((resolve) => {
    disconnected = resolve;
  });
  const {
    createNativeShellTransport,
  } = require("../app/src/core/generated/native-host-transport.cjs");
  const owner = await createNativeShellTransport({
    home: f.hostHome,
    profile: f.profile,
    hostId: f.hostId,
    generation: f.generation,
    onShell: (value) => {
      updates.push(value);
      if (updates.length === 2) changed();
    },
    onClosed: () => disconnected(),
  });
  t.after(() => owner.close());
  assert.deepEqual(updates[0], shell);
  const navigation = { ...shell.navigation[0], settings: { showInMenuBar: true } };
  socket.send(
    JSON.stringify({
      version: 1,
      method: "shell.updated",
      params: {
        ...identity,
        event: "shell.updated",
        sequence: 1,
        delta: {
          projects: { upsert: [], remove: [] },
          navigation: { upsert: [navigation], remove: [] },
        },
      },
    }),
  );
  await Promise.race([
    change,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("native shell delta missing")), 2000).unref(),
    ),
  ]);
  assert.equal(updates[1].navigation[0].settings.showInMenuBar, true);
  assert.deepEqual(methods, ["hello", "host.status", "shell.subscribe"]);
  assert.equal(
    f.calls.some((q) => q.method === "backend.ensure"),
    false,
  );
  socket.close();
  await Promise.race([
    disconnect,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("native shell disconnect missing")), 2000).unref(),
    ),
  ]);
  assert.equal(server.clients.size, 0);
});

test("native shell metadata stays bound to the original GUI source and attachment", async (t) => {
  const f = await fixture(t);
  const epoch = {};
  f.backend.nativeBrowserEpoch = epoch;
  f.backend.nativeBrowserSource = "source";
  const navigation = {
    sourceId: "source",
    state: "available",
    settings: { showInMenuBar: false },
    projects: { alias: { title: "Native project" } },
    threads: {},
    projectOrder: ["alias"],
    sections: [],
    sidebarThreadOrder: [],
    sidebarRevision: 2,
    bindings: [{ projectId: "canonical", alias: "alias", projectless: false }],
  };
  const shell = {
    navigation: [navigation],
    projects: [
      {
        projectId: "canonical",
        workspace: f.root,
        projectless: false,
        state: "stopped",
        summaries: { state: "fresh", items: [{ id: "thread", desktop: { archived: false } }] },
        attention: { state: "unknown" },
      },
      {
        projectId: "foreign",
        workspace: "/foreign",
        state: "ready",
        summaries: { state: "unknown", items: [] },
        attention: { state: "unknown" },
      },
    ],
  };
  f.backend.acceptNativeShell(shell, "source", epoch);
  const snapshot = f.backend.snapshot();
  assert.equal(snapshot.library.settings.showInMenuBar, false);
  assert.deepEqual(
    snapshot.projects.map((p) => p.id),
    ["alias"],
  );
  assert.equal(snapshot.projects[0].root, f.root);
  assert.equal(snapshot.projects[0].summaries[0].id, "thread");
  f.backend.acceptNativeShell(
    { ...shell, navigation: [{ ...navigation, state: "unknown", settings: {} }] },
    "source",
    epoch,
  );
  assert.equal(f.backend.snapshot().library.settings.showInMenuBar, false);
  assert.equal(f.backend.snapshot().projects[0].summaries[0].id, "thread");
  f.backend.acceptNativeShell(
    { ...shell, navigation: [{ ...navigation, settings: { showInMenuBar: true } }] },
    "source",
    {},
  );
  assert.equal(f.backend.snapshot().library.settings.showInMenuBar, false);
});

test("remaining Node remote adapter delegates control to the native Host owner", async () => {
  const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
  const calls = [];
  const socket = {};
  const service = {
    backend: {
      host: { sourceId: "source" },
      providers: { redact: (value) => value },
      hostCall: async (method, params) => {
        calls.push({ method, params });
        return { enabled: false };
      },
    },
    clients: new Set([socket]),
    inflight: 0,
    schedule() {},
    remote: { control: async () => assert.fail("Node remote controller must not execute") },
  };
  assert.deepEqual(
    await DesktopService.prototype.execute.call(service, socket, "remoteControl", {
      operation: "disable",
    }),
    { enabled: false },
  );
  assert.deepEqual(calls, [
    { method: "remote.control", params: { sourceId: "source", request: { operation: "disable" } } },
  ]);
});

test("Main resource and service status reads use native Host without a Node connection", async (t) => {
  const f = await fixture(t);
  const rows = [
    {
      projectId: "project",
      root: "/synthetic/project",
      started: true,
      observation: "known",
      restartSafe: false,
      resources: [],
      pendingRequests: [{ threadId: "thread", awaitingResponse: false }],
    },
  ];
  const status = {
    canStop: false,
    connected: true,
    busy: true,
    starting: 0,
    providerUpdating: false,
    projects: rows,
  };
  const operations = [];
  f.setHandler(async (q) => {
    if (q.method === "desktop.core.subscribe") return { attachmentId: "attachment" };
    assert.equal(q.method, "desktop.core.call");
    assert.equal(q.params.call, "resources.command");
    operations.push(q.params.params.operation);
    return q.params.params.operation === "status" ? status : rows;
  });
  await f.backend.connectNativeBrowser({ home: f.hostHome, sourceId: "source" }, {});
  t.after(() => f.backend.closeNativeBrowser());
  f.backend.status.connected = true;
  assert.deepEqual(await f.backend.resources({ operation: "inspect", includeTasks: true }), rows);
  assert.deepEqual(await f.backend.serviceStatus(), status);
  assert.deepEqual(operations, ["inspect", "status"]);
  assert.equal(f.backend.connection, undefined);
});

test("native update readiness observes Host resources and treats missing observations as busy", async (t) => {
  const f = await fixture(t);
  f.backend.nativeBrowserEpoch = {};
  f.backend.status.connected = true;
  let canStop = true;
  f.backend.serviceStatus = async () => ({ canStop });
  f.backend.observeLifecycle = async () => assert.fail("Node lifecycle must not be read");
  assert.equal(await f.backend.hasUpdateWork(), false);
  canStop = false;
  assert.equal(await f.backend.hasUpdateWork(), true);
  f.backend.serviceStatus = async () => {
    throw new Error("original connection lost");
  };
  assert.equal(await f.backend.hasUpdateWork(), true);
});

test("native recovery stops through the original Host receipt without Node lifecycle", async (t) => {
  const f = await fixture(t);
  const { recoverConnectedService } = require("../app/src/core/startup-recovery.cjs");
  f.backend.nativeBrowserEpoch = {};
  f.backend.status.connected = true;
  f.backend.observeLifecycle = async () => assert.fail("Node lifecycle must not be read");
  f.setHandler(async (q) => {
    assert.equal(q.method, "host.stop");
    const value = f.receipt(q.params.requestId);
    f.operations.set(q.params.requestId, value);
    return value;
  });
  const result = await recoverConnectedService({
    backend: f.backend,
    notify: async () => ({ response: 1 }),
    purpose: "update",
  });
  assert.equal(result.stopped, true);
  assert.equal(result.operation.kind, "stopHost");
  const saved = readReferences((await f.backend.readControl()).references);
  assert.equal(saved[0].requestId, result.operation.requestId);
  assert.equal(f.backend.connection, null);
});

test("native update keeps one original stop receipt and restarts only after completion", async (t) => {
  const f = await fixture(t);
  f.backend.nativeBrowserEpoch = {};
  f.backend.status.connected = true;
  f.backend.options.binary = "/unused/areal";
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
  };
  f.backend.observeLifecycle = async () => assert.fail("Node lifecycle must not be read");
  let stopId;
  f.setHandler(async (q) => {
    if (q.method === "host.stop") {
      stopId = q.params.requestId;
      const receipt = f.receipt(stopId, "acceptedPending");
      f.operations.set(stopId, receipt);
      return receipt;
    }
    assert.equal(q.method, "host.operation");
    return { operation: f.operations.get(q.params.requestId) };
  });
  const notify = async () => ({ response: 1 });
  await assert.rejects(f.backend.applyUpdate({ notify }), { code: "LIFECYCLE_INCOMPLETE" });
  assert.equal(starts, 0);
  assert.ok(stopId);
  assert.equal(f.backend.hostReferences.size, 1);
  f.operations.set(stopId, f.receipt(stopId));
  const result = await f.backend.applyUpdate({ notify });
  assert.equal(result.stopped, true);
  assert.equal(result.operation.requestId, stopId);
  assert.equal(starts, 1);
  assert.equal(f.calls.filter((q) => q.method === "host.stop").length, 1);
  assert.equal(f.backend.hostReferences.has(stopId), true);
});

test("Main startup prepares the source and attaches native Host without Node startup or projection", async (t) => {
  const f = await fixture(t);
  const { GuiSourceSession } = require("node:module").createRequire(
    require.resolve("../app/package.json"),
  )("@areal/client/gui-source");
  const requireApp = require("node:module").createRequire(require.resolve("../app/package.json"));
  const upgrade = requireApp("@areal/client/desktop-upgrade");
  const config = require("../app/src/core/service-config.cjs");
  const patch = (owner, name, value) => {
    const original = owner[name];
    owner[name] = value;
    t.after(() => {
      owner[name] = original;
    });
  };
  const steps = [];
  patch(upgrade, "ensureDesktopHost", async () => async () => {
    steps.push("upgrade-complete");
  });
  patch(upgrade, "desktopBuildIdentity", async () => "build");
  patch(config, "serviceIdentity", async () => "service");
  patch(GuiSourceSession.prototype, "init", async function () {
    steps.push("source");
    this.sourceId = "source";
  });
  patch(GuiSourceSession.prototype, "prepareNative", async function () {
    steps.push("prepare");
    this.environmentCredentials = {};
    return { options: { prepared: true } };
  });
  f.backend.options = {
    ...f.backend.options,
    binary: "/synthetic/areal",
    guiProfile: f.profile,
    harnessHome: f.hostHome,
  };
  f.backend.prerequisiteCheck = async () => {};
  f.backend.attach = async () => assert.fail("Node projection must not attach");
  f.backend.connectNativeBrowser = async (source, options) => {
    assert.equal(source.sourceId, "source");
    assert.equal(options.prepared, true);
    steps.push("native");
  };
  f.backend.connectNativeShell = async (source) => {
    assert.equal(source.sourceId, "source");
    steps.push("shell");
  };
  f.backend.importNativeCloud = async () => {};
  await f.backend.initializeHostBackend();
  assert.deepEqual(steps, ["source", "prepare", "native", "shell", "upgrade-complete"]);
  assert.equal(f.backend.connectionState.state, "ready");
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.connection, undefined);
  steps.length = 0;
  await f.backend.initializeHostBackend({ recover: true });
  assert.deepEqual(steps, ["source", "prepare", "native", "shell", "upgrade-complete"]);
  let revoked = 0;
  f.backend.closeNativeBrowser = () => {
    revoked++;
  };
  f.backend.connectNativeShell = async () => {
    throw new Error("synthetic shell observation failure");
  };
  await assert.rejects(f.backend.initializeHostBackend(), /synthetic shell observation failure/);
  assert.equal(revoked, 1);
  assert.equal(f.backend.status.connected, false);
});

test("native update readiness requires the original stopped Host PID to exit", async (t) => {
  const { spawn } = require("node:child_process");
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const requestId = randomUUID();
  const reference = {
    kind: "stopHost",
    requestId,
    home: f.hostHome,
    hostId: f.hostId,
    generation: f.generation,
    strategy: "cancel",
    pid: child.pid,
  };
  f.backend.hostReferences.set(requestId, reference);
  f.backend.hostReceipts.set(requestId, f.receipt(requestId));
  f.backend.status.connected = false;
  assert.equal(f.backend.serviceExited, false, "receipt alone is not process exit");
  const readiness = f.backend.hasUpdateWork();
  child.kill();
  await once(child, "exit");
  assert.equal(f.backend.serviceExited, true);
  assert.equal(await readiness, false);
  assert.equal(await f.backend.hasUpdateWork(), false);
  f.backend.status.connected = true;
  assert.equal(f.backend.serviceExited, false, "an old stop cannot stop a new attachment");
});

test("native application readiness leaves accepted business work with Host", async (t) => {
  const f = await fixture(t);
  f.backend.nativeBrowserEpoch = {};
  f.backend.status.connected = true;
  f.backend.requireConnection = () =>
    assert.fail("native quit must not read the retired Node snapshot");
  await f.backend.waitForApplicationReady();
});

test("native shutdown revokes its attachment without requesting Node activity", async (t) => {
  const f = await fixture(t);
  f.backend.nativeBrowserEpoch = {};
  let closed = 0;
  f.backend.nativeBrowser = { close: () => closed++ };
  f.backend.status.connected = true;
  f.backend.requireConnection = () =>
    assert.fail("native shutdown cannot require a Node projection");
  await f.backend.shutdown();
  assert.equal(closed, 1);
  assert.equal(f.backend.nativeBrowserEpoch, undefined);
});
