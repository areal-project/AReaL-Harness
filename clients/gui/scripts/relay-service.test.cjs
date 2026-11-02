const { attachRemoteHostFixture } = require("./remote-host-fixture.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm, mkdir, chmod } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { request } = require("node:http");
const { createRequire } = require("node:module");
const { RemoteControl } = require("../app/src/core/remote.cjs");
const { RelayService, localAddress, privateAddress } = require("../app/src/core/relay-service.cjs");
const {
  isRemoteRequest,
  isRemoteStatus,
} = require("../packages/workbench/client/desktop-contract/desktop-control.cjs");
const appRequire = createRequire(join(__dirname, "../app/package.json"));
const WebSocket = appRequire("ws");

const interfaces = () => ({ en0: [{ address: "192.168.50.20", family: "IPv4", internal: false }] });
async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Relay state deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function host(t, home, { keepHome = false } = {}) {
  home ??= await mkdtemp(join(tmpdir(), "relay-local-"));
  const remote = new RemoteControl({
    schedule() {},
    backend: {
      home,
      saved: [{ id: "project", name: "Test project", root: home }],
      projects: new Map(),
      async save(name, value) {
        await writeFile(join(home, name), JSON.stringify(value));
      },
    },
  });
  attachRemoteHostFixture(remote, {
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  });
  remote.relayService = new RelayService(remote, { interfaces });
  await remote.init();
  t.after(async () => {
    try {
      if (remote.relayService.server) await remote.control({ operation: "relayServiceStopLocal" });
    } finally {
      remote.close();
      if (!keepHome) await rm(home, { recursive: true, force: true });
    }
  });
  return remote;
}
function http(origin, path, method = "GET", body = "") {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${url.port}${path}`,
      {
        method,
        headers: {
          host: url.host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const data = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(data).toString() }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

test("private address selection accepts reachable private VPN routes and rejects public or link-local interfaces", () => {
  for (const address of [
    "10.7.2.3",
    "172.16.4.5",
    "172.31.3.4",
    "192.168.2.5",
    "fc00::1",
    "fd12::1",
  ])
    assert.equal(privateAddress(address), true, address);
  for (const address of [
    "127.0.0.1",
    "169.254.2.3",
    "172.32.1.2",
    "100.100.1.2",
    "8.8.8.8",
    "fe80::1",
    "ff00::1",
    "example.com",
  ])
    assert.equal(privateAddress(address), false, address);
  assert.equal(
    localAddress({ vpn: [{ address: "10.8.0.7", internal: false, family: "IPv4" }] }),
    "10.8.0.7",
  );
  assert.equal(
    localAddress({ en0: [{ address: "169.254.2.3", internal: false, family: "IPv4" }] }),
    undefined,
  );
});

test("local Relay persists registration, hosts a native Noise pairing and reuses identity after stop and restart", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-lifecycle-"));
  const remote = await host(t, home);
  await remote.control({ operation: "relayServiceStartLocal" });
  await waitFor(() => remote.connected);
  const origin = remote.config.relay;
  const capability = remote.config.capability;
  const room = remote.config.room;
  const hostIdentity = remote.config.identity;
  assert.equal(remote.state().relayService.local.phase, "running");
  assert.equal(isRemoteStatus(remote.state()), true);
  assert.doesNotMatch(JSON.stringify(remote.state()), new RegExp(capability));
  const disk = JSON.parse(
    Buffer.from(
      JSON.parse(await readFile(join(home, "remote-host-fixture.json"), "utf8")).encrypted,
      "base64",
    ).toString(),
  );
  assert.equal(disk.relayProfiles[0].capability, capability);
  assert.equal((await http(origin, "/healthz")).status, 200);
  assert.equal(
    (await http(origin, "/enroll", "POST", JSON.stringify({ code: "x".repeat(43) }))).status,
    403,
  );
  const invitation = await remote.control({ operation: "pair", transport: "relay" });
  const fragment = new URLSearchParams(new URL(invitation.payload).hash.slice(1));
  assert.equal(fragment.get("local"), "1");
  assert.equal(fragment.get("room"), room);
  assert.equal(fragment.has("capability"), false);
  const { createIdentity, identityId } = await import("../packages/remote/src/channel.mjs");
  const { RemoteConnection } = await import("../packages/remote-client/src/index.mjs");
  const identity = await createIdentity();
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}/remote/socket`, {
    origin: "capacitor://localhost",
    headers: { Host: new URL(origin).host },
  });
  t.after(() => socket.terminate());
  const client = new RemoteConnection({
    socket,
    identity,
    host: identityId(hostIdentity),
    room,
    hello: { displayName: "Native test", clientKind: "ios", inviteSecret: fragment.get("invite") },
    isCurrent: () => true,
    onClose() {},
  });
  const connecting = client.connect({ onHandshake() {}, onReady() {}, onSession() {} });
  await waitFor(() => remote.pending.has(identityId(identity)));
  await remote.control({
    operation: "approve",
    id: identityId(identity),
    projects: ["project"],
    preset: "Observer",
  });
  const ready = await connecting;
  assert.equal(ready.hostId, identityId(hostIdentity));
  const description = await client.request({ method: "host.describe", params: {} });
  assert.equal(description.apiVersion, "areal.remote.v2");
  socket.terminate();
  await remote.control({ operation: "relayServiceStopLocal" });
  assert.equal(remote.state().enabled, false);
  assert.equal(remote.state().relayService.local.phase, "stopped");
  await assert.rejects(http(origin, "/healthz"));
  await remote.control({ operation: "relayServiceStartLocal" });
  await waitFor(() => remote.connected);
  assert.equal(remote.config.capability, capability);
  assert.equal(remote.config.room, room);
  assert.equal(remote.config.identity, hostIdentity);
  assert.equal(remote.config.deviceGrants[0].devicePeerId, identityId(identity));
  assert.equal(remote.config.relayLocal.port, new URL(origin).port * 1);
});

test("no private interface reports an unavailable local entry without creating a registration", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-no-network-"));
  const remote = await host(t, home);
  remote.relayService.interfaces = () => ({});
  await assert.rejects(remote.control({ operation: "relayServiceStartLocal" }), /内网地址/);
  assert.equal(remote.state().relayService.local.phase, "failed");
  assert.equal(remote.state().enabled, false);
  assert.equal(remote.config.capability, undefined);
});

test("reopening a desktop retains a disabled Host while its local Relay runtime resumes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-disabled-restart-"));
  const first = await host(t, home, { keepHome: true });
  await first.control({ operation: "relayServiceStartLocal" });
  await waitFor(() => first.connected);
  await first.control({ operation: "disable" });
  assert.equal(first.config.enabled, false);
  assert.equal(first.config.relayLocal.enabled, true);
  first.close();
  await waitFor(() => first.relayService.store === null);
  const reopened = await host(t, home);
  assert.equal(reopened.relayService.local.phase, "running");
  assert.equal(reopened.config.enabled, false);
  assert.equal(reopened.connected, false);
  await assert.rejects(reopened.control({ operation: "pair", transport: "relay" }));
});

test("desktop deployment boundary rejects option injection and credential-bearing or HTTP endpoints", () => {
  const valid = {
    operation: "relayServiceDeploy",
    target: "root@relay.example",
    port: 22,
    address: "https://relay.example",
  };
  assert.equal(isRemoteRequest(valid), true);
  for (const value of [
    { target: "-oProxyCommand=evil" },
    { target: "root@host;evil" },
    { address: "http://192.168.1.1" },
    { address: "https://user:secret@relay.example" },
    { address: "https://relay.example/" },
    { port: 0 },
  ])
    assert.equal(isRemoteRequest({ ...valid, ...value }), false);
});

test("SSH jobs save their intended registration before writing and status remains readable through an unknown result", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-job-"));
  const remote = await host(t, home);
  const bin = join(home, "bin");
  await mkdir(bin);
  const fake = join(bin, "ssh");
  await writeFile(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = ${JSON.stringify(home)};
const file = path.join(home, 'remote-host-fixture.json');
const config = fs.existsSync(file) ? JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file)).encrypted, 'base64').toString()).relayDeployment : undefined;
if ((!config || config.phase !== 'pending') && process.argv.at(-1).includes('inspect')) {
  console.log(JSON.stringify({ ownerId: process.argv.at(-1).match(/[a-f0-9]{32}/)[0], installed: false, active: false, absent: true, dataRetained: false }));
  process.exit(0);
}
if (config.phase !== 'pending' || !config.ownerId || !config.room || !config.capability) process.exit(2);
fs.writeFileSync(path.join(home, 'started'), 'persisted');
process.stdin.resume();
process.stdin.on('end', () => {
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(home, 'finish'))) return;
    clearInterval(timer);
    if (process.argv.at(-1).includes('inspect') && fs.existsSync(path.join(home, 'inspect'))) {
      console.log(JSON.stringify({ ownerId: config.ownerId, installed: false, active: false, absent: true, dataRetained: false }));
      process.exit(0);
    }
    process.exit(1);
  }, 10);
});
`,
  );
  await chmod(fake, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const result = await remote.control({
    operation: "relayServiceDeploy",
    target: "root@relay.example",
    port: 22,
    address: "https://relay.example",
  });
  assert.equal(result.relayService.job.phase, "running");
  await waitFor(() => require("node:fs").existsSync(join(home, "started")));
  const status = await Promise.race([
    remote.control({ operation: "status" }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("status blocked by SSH")), 500);
      timer.unref();
    }),
  ]);
  assert.equal(status.relayService.job.phase, "running");
  assert.equal(status.relayService.deployment.phase, "pending");
  assert.equal(await readFile(join(home, "started"), "utf8"), "persisted");
  const owner = remote.config.relayDeployment.ownerId;
  const capability = remote.config.relayDeployment.capability;
  assert.equal(JSON.stringify(status).includes(capability), false);
  await writeFile(join(home, "finish"), "");
  await waitFor(() => remote.relayService.job.phase === "unknown");
  assert.equal(remote.config.relayDeployment.phase, "pending");
  await assert.rejects(
    remote.control({
      operation: "relayServiceDeploy",
      target: "root@corrected.example",
      port: 2222,
      address: "https://corrected.example",
    }),
    /核对/,
  );
  assert.equal(remote.config.relayDeployment.target, "root@relay.example");
  await assert.rejects(remote.control({ operation: "relayServiceUpgrade" }), /核对/);
  await writeFile(join(home, "inspect"), "");
  await remote.control({ operation: "relayServiceInspect" });
  await waitFor(() => remote.relayService.job.phase === "done");
  assert.equal(remote.config.relayDeployment.phase, "removed");
  assert.equal(remote.config.relayDeployment.ownerId, owner);
  assert.equal(remote.config.relayDeployment.capability, capability);
  assert.equal(remote.state().relayService.deployment.canReconfigure, true);
  await remote.control({
    operation: "relayServiceDeploy",
    target: "root@corrected.example",
    port: 2222,
    address: "https://corrected.example",
  });
  await waitFor(() => remote.relayService.job.phase === "unknown");
  assert.equal(remote.config.relayDeployment.target, "root@corrected.example");
  assert.equal(remote.config.relayDeployment.port, 2222);
  assert.equal(remote.config.relayDeployment.address, "https://corrected.example");
  assert.equal(remote.config.relayDeployment.capability, capability);
  assert.equal(remote.config.relayDeployment.ownerId, owner);
  assert.equal(remote.config.relayDeployment.canReconfigure, false);
});

test("two isolated desktops starting concurrently retain distinct bound ports and matching invitations", async (t) => {
  const first = await host(t);
  const second = await host(t);
  await Promise.all([
    first.control({ operation: "relayServiceStartLocal" }),
    second.control({ operation: "relayServiceStartLocal" }),
  ]);
  await waitFor(() => first.connected && second.connected);
  assert.notEqual(first.config.relayLocal.port, second.config.relayLocal.port);
  for (const remote of [first, second]) {
    const origin = remote.config.relay;
    assert.equal(remote.state().relayService.local.address, origin);
    assert.equal(
      remote.config.relayProfiles.find((profile) => profile.kind === "local").origin,
      origin,
    );
    assert.equal((await http(origin, "/healthz")).status, 200);
    assert.equal(
      new URL((await remote.control({ operation: "pair", transport: "relay" })).payload).origin,
      origin,
    );
  }
});

test("an unreachable SSH preflight leaves editable deployment details and never admits a write", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-preflight-"));
  const remote = await host(t, home);
  const bin = join(home, "bin");
  await mkdir(bin);
  const fake = join(bin, "ssh");
  await writeFile(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = ${JSON.stringify(home)};
if (!process.argv.at(-1).includes('inspect')) {
  fs.writeFileSync(path.join(home, 'mutated'), 'unexpected');
  process.exit(2);
}
fs.writeFileSync(path.join(home, 'preflight'), 'running');
process.stdin.resume();
process.stdin.on('end', () => {
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(home, 'finish'))) return;
    clearInterval(timer);
    process.exit(255);
  }, 10);
});
`,
  );
  await chmod(fake, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  await remote.control({
    operation: "relayServiceDeploy",
    target: "root@typo.example",
    port: 2222,
    address: "https://relay.example",
  });
  await waitFor(() => require("node:fs").existsSync(join(home, "preflight")));
  const status = await remote.control({ operation: "status" });
  assert.equal(status.relayService.job.phase, "running");
  assert.equal(status.relayService.deployment, null);
  assert.equal(remote.config.relayDeployment, undefined);
  await writeFile(join(home, "finish"), "");
  await waitFor(() => remote.relayService.job.phase === "failed");
  assert.equal(remote.config.relayDeployment, undefined);
  assert.equal(require("node:fs").existsSync(join(home, "mutated")), false);
  await remote.control({
    operation: "relayServiceDeploy",
    target: "root@corrected.example",
    port: 22,
    address: "https://corrected.example",
  });
  await waitFor(() => remote.relayService.job.phase === "failed");
  assert.equal(remote.config.relayDeployment, undefined);
});

test("retained server data permits correcting HTTPS on its owner but prevents moving the deployment", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-correct-origin-"));
  const remote = await host(t, home);
  const bin = join(home, "bin");
  await mkdir(bin);
  const fake = join(bin, "ssh");
  await writeFile(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = ${JSON.stringify(home)};
const command = process.argv.at(-1);
const file = path.join(home, 'remote-host-fixture.json');
const config = fs.existsSync(file) ? JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file)).encrypted, 'base64').toString()).relayDeployment : undefined;
const ownerId = command.match(/[a-f0-9]{32}/)[0];
if (command.includes('inspect')) {
  console.log(JSON.stringify({ownerId, installed:false, active:false, absent:!config, dataRetained:!!config}));
  process.exit(0);
}
if (!config || config.phase !== 'pending' || config.ownerId !== ownerId || !config.capability || !config.room) process.exit(2);
fs.appendFileSync(path.join(home, 'mutations'), JSON.stringify(config) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ownerId, installed:true, active:false, room:config.room, roomActive:true, address:config.address})));
`,
  );
  await chmod(fake, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  await remote.control({
    operation: "relayServiceDeploy",
    target: "root@relay.example",
    port: 22,
    address: "https://typo.example",
  });
  await waitFor(() => remote.relayService.job.phase === "failed");
  const original = { ...remote.config.relayDeployment };
  assert.equal(original.phase, "failed");
  await remote.control({ operation: "relayServiceInspect" });
  await waitFor(() => remote.relayService.job.phase === "done");
  assert.equal(remote.config.relayDeployment.phase, "removed");
  assert.equal(remote.state().relayService.deployment.canReconfigure, false);
  await assert.rejects(
    remote.control({
      operation: "relayServiceDeploy",
      target: "root@other.example",
      port: 22,
      address: "https://relay.example",
    }),
    /保留/,
  );
  await remote.control({
    operation: "relayServiceDeploy",
    target: "root@relay.example",
    port: 22,
    address: "https://corrected.example",
  });
  await waitFor(() => remote.relayService.job.phase === "failed");
  assert.equal(remote.config.relayDeployment.address, "https://corrected.example");
  assert.equal(remote.config.relayDeployment.ownerId, original.ownerId);
  assert.equal(remote.config.relayDeployment.room, original.room);
  assert.equal(remote.config.relayDeployment.capability, original.capability);
  const mutations = (await readFile(join(home, "mutations"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].address, "https://corrected.example");
  assert.equal(mutations[1].phase, "pending");
  assert.equal(mutations[1].ownerId, original.ownerId);
});

test("Relay close waits for its listener before releasing the store and preserves close errors", async () => {
  const remote = { config: {}, service: { schedule() {} } };
  const relay = new RelayService(remote);
  const released = Promise.withResolvers();
  let storeClosed = 0;
  relay.server = { close: () => released.promise };
  relay.store = {
    close: () => {
      storeClosed++;
    },
  };
  const closing = relay.close();
  assert.equal(relay.close(), closing);
  assert.equal(storeClosed, 0);
  released.resolve();
  await closing;
  assert.equal(storeClosed, 1);
  const failed = new RelayService(remote);
  failed.server = {
    close: async () => {
      throw new Error("listener close failed");
    },
  };
  failed.store = {
    close: () => {
      storeClosed++;
    },
  };
  await assert.rejects(failed.close(), /listener close failed/);
  assert.equal(storeClosed, 2);
});

test("Relay close owns a listener and store arriving during startLocal", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-close-start-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const serving = Promise.withResolvers();
  const served = Promise.withResolvers();
  const listenerClosing = Promise.withResolvers();
  const listenerClosed = Promise.withResolvers();
  let storeClosed = 0;
  const remote = {
    config: { identity: "fixture-identity" },
    service: { schedule() {} },
    backend: { home },
    async save(config) {
      this.config = config;
    },
  };
  const relay = new RelayService(remote, {
    interfaces,
    resources: async () => ({ bundleDir: home, version: "fixture" }),
    modules: async () => ({
      readConfig: () => ({}),
      openStore: () => ({
        provision() {},
        close() {
          storeClosed++;
        },
      }),
      serve: () => {
        serving.resolve();
        return served.promise;
      },
    }),
  });
  const starting = relay.startLocal(false);
  await serving.promise;
  let done = false;
  const closing = relay.close().then(() => {
    done = true;
  });
  served.resolve({
    close: () => {
      listenerClosing.resolve();
      return listenerClosed.promise;
    },
  });
  await listenerClosing.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(storeClosed, 0);
  listenerClosed.resolve();
  await assert.rejects(starting, /已关闭/);
  await closing;
  assert.equal(storeClosed, 1);
  assert.equal(relay.server, null);
  assert.equal(relay.store, null);
});
