import { attachRemoteHostFixture } from "./remote-host-fixture.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemoteControl } from "@areal/workbench-service/desktop/core/remote.cjs";
import { createRemoteNetworkAdapter } from "@areal/workbench-service/desktop/core/remote-network.cjs";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "rc11-host-"));
  const cli = join(home, "fixture cli; no-shell");
  const cliState = join(home, "cli.json");
  const journal = join(home, "remote-host-fixture.json");
  await writeFile(cliState, JSON.stringify({ config: {} }));
  await writeFile(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(cliState)}, journal = ${JSON.stringify(journal)};
const s = JSON.parse(fs.readFileSync(file, 'utf8')), a = process.argv.slice(2);
if (a[0] === 'version') console.log(JSON.stringify({short:s.version || '1.52.0'}));
else if (a[0] === 'status') console.log(JSON.stringify(s.status || {BackendState:'Running',Self:{DNSName:'fixture.example.ts.net.',CapMap:{https:[],funnel:[],'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000':[]}},CertDomains:['fixture.example.ts.net']}));
else if (a.join(' ') === 'serve status --json') console.log(JSON.stringify(s.config));
else if (a[0] === 'serve' || a[0] === 'funnel') {
 const saved = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(journal,'utf8')).encrypted,'base64').toString());
 if (saved.network.mapping.state !== 'pending') process.exit(9);
 if (s.fail) process.exit(8);
 const port = a[2].split('=')[1], hp = 'fixture.example.ts.net:'+port;
 if (a.at(-1) === 'off') { if (s.requireDisabled) {
  if (saved.directEnabled) process.exit(10);
  const probe = require('node:child_process').spawnSync(process.execPath, ['-e', "const s=require('node:net').connect("+saved.directPort+",'127.0.0.1');s.once('connect',()=>process.exit(12));s.once('error',()=>process.exit(0));setTimeout(()=>process.exit(13),500).unref();"], {timeout:1000});
  if (probe.status !== 0) process.exit(11);
 } delete s.config.TCP[port]; delete s.config.Web[hp]; if(!Object.keys(s.config.TCP).length) delete s.config.TCP; if(!Object.keys(s.config.Web).length) delete s.config.Web; }
 else { s.config.TCP ||= {}; s.config.Web ||= {}; s.config.TCP[port] = {HTTPS:true}; s.config.Web[hp] = {Handlers:{'/':{Proxy:a.at(-1)}}}; }
 if (a[0] === 'funnel') { s.config.AllowFunnel ||= {}; s.config.AllowFunnel[hp] = true; }
 else if (s.config.AllowFunnel) { delete s.config.AllowFunnel[hp]; if (!Object.keys(s.config.AllowFunnel).length) delete s.config.AllowFunnel; }
 s.mutations = [...(s.mutations || []), a]; fs.writeFileSync(file,JSON.stringify(s));
} else process.exit(4);
`,
    { mode: 0o700 },
  );
  const encryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  let rejectSave = () => false;
  const service = {
    schedule() {},
    backend: {
      home,
      saved: [],
      async save(name, value) {
        if (rejectSave(value)) throw new Error("fixture disk failure");
        await writeFile(join(home, name), JSON.stringify(value));
      },
    },
  };
  const options = {
    networkAdapterFactory: (options) => createRemoteNetworkAdapter({ ...options, executable: cli }),
  };
  const instances = [];
  const make = async () => {
    const r = new RemoteControl(service, options);
    attachRemoteHostFixture(r, encryption);
    instances.push(r);
    await r.init();
    return r;
  };
  const remote = await make();
  return {
    remote,
    make,
    service,
    rejectSave: (fn) => {
      rejectSave = fn;
    },
    readCli: async () => JSON.parse(await readFile(cliState, "utf8")),
    setCli: async (value) => writeFile(cliState, JSON.stringify(value)),
    persisted: async () =>
      JSON.parse(
        encryption.decryptString(
          Buffer.from(JSON.parse(await readFile(journal, "utf8")).encrypted, "base64"),
        ),
      ),
    async cleanup() {
      for (const r of instances) r.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("Desktop proposal is sanitized and only the owned live Direct listener can become a mapping", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    const proposal = await f.remote.control({ operation: "networkPropose" });
    assert.deepEqual(Object.keys(proposal).sort(), ["confirmation", "proposalId", "publicOrigin"]);
    assert.equal(proposal.publicOrigin, "https://fixture.example.ts.net");
    assert.match(proposal.confirmation, /手机.*tailnet/);
    assert.throws(
      () => f.remote.control({ operation: "networkApply", proposalId: proposal.proposalId }),
      /无效手机设置参数/,
    );
    await f.remote.control({
      operation: "networkApply",
      proposalId: proposal.proposalId,
      confirmed: true,
    });
    const persisted = await f.persisted();
    assert.equal(persisted.network.mapping.state, "owned");
    assert.equal(persisted.network.mapping.target, f.remote.direct.origin);
    assert.equal(persisted.directPort, f.remote.direct.server.address().port);
    assert.equal(f.remote.state().directUrl, "https://fixture.example.ts.net");
    assert.equal(JSON.stringify(f.remote.state()).includes("target"), false);
    assert.match(
      (await f.remote.control({ operation: "pair" })).payload,
      /^https:\/\/fixture.example.ts.net\/#/,
    );
    const cli = await f.readCli();
    await f.setCli({ ...cli, requireDisabled: true });
    const disabled = await f.remote.control({ operation: "disableDirect" });
    assert.equal(disabled.network.diagnostic, "");
    assert.deepEqual((await f.readCli()).config, {});
    assert.equal((await f.persisted()).network.mapping.state, "removed");
  } finally {
    await f.cleanup();
  }
});

test("organization origin admits exact Host/Origin tuples and revokes invitations and sockets on change", async () => {
  const f = await fixture();
  const { request } = await import("node:http");
  const { createRequire } = await import("node:module");
  const WebSocket = createRequire(new URL("../app/package.json", import.meta.url))("ws");
  const get = (origin, headers) =>
    new Promise((resolve, reject) => {
      const req = request(origin, { headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  const connect = (url, headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.on("error", reject);
      ws.on("open", () => resolve(ws));
    });
  try {
    await f.remote.control({ operation: "enableDirect" });
    await f.remote.control({
      operation: "networkConfigureOrganization",
      publicOrigin: "https://organization.example:8443",
      visibility: "private",
      confirmed: true,
    });
    assert.equal(await get(f.remote.direct.origin, { Host: "organization.example:8443" }), 200);
    assert.equal(
      await get(f.remote.direct.origin, {
        Host: "evil.example",
        "X-Forwarded-Host": "organization.example:8443",
        "X-Forwarded-Proto": "https",
      }),
      404,
    );
    assert.equal(await get(f.remote.direct.origin, { Host: "organization.example" }), 404);
    const ws = await connect(f.remote.direct.ws, {
      Host: "organization.example:8443",
      Origin: "https://organization.example:8443",
    });
    await assert.rejects(
      connect(f.remote.direct.ws, {
        Host: "organization.example:8443",
        Origin: f.remote.direct.origin,
      }),
    );
    await assert.rejects(
      connect(f.remote.direct.ws, {
        Host: new URL(f.remote.direct.origin).host,
        Origin: "https://organization.example:8443",
      }),
    );
    await assert.rejects(connect(f.remote.direct.ws, { Host: "organization.example:8443" }));
    await f.remote.control({ operation: "pair" });
    const closed = new Promise((resolve) => ws.once("close", resolve));
    await f.remote.control({
      operation: "networkConfigureOrganization",
      publicOrigin: "https://second.example",
      visibility: "private",
      confirmed: true,
    });
    await closed;
    assert.equal(f.remote.invite, null);
    assert.equal(await get(f.remote.direct.origin, { Host: "organization.example:8443" }), 404);
    assert.equal(await get(f.remote.direct.origin, { Host: "second.example" }), 200);
    await assert.rejects(
      f.remote.control({
        operation: "networkConfigureOrganization",
        publicOrigin: "https://public.example",
        visibility: "public",
        confirmed: true,
      }),
      { code: "public-confirmation-required" },
    );
  } finally {
    await f.cleanup();
  }
});

test("mapped port and owned mapping survive process close and reconcile before HTTPS advertisement", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    const p = await f.remote.control({ operation: "networkPropose" });
    await f.remote.control({
      operation: "networkApply",
      proposalId: p.proposalId,
      confirmed: true,
    });
    const port = f.remote.direct.server.address().port;
    const stopped = new Promise((resolve) => f.remote.direct.server.once("close", resolve));
    f.remote.close();
    await stopped;
    const restarted = await f.make();
    assert.equal(restarted.direct.server.address().port, port);
    assert.equal(restarted.state().directUrl, "https://fixture.example.ts.net");
    assert.equal(
      (await f.readCli()).mutations.length,
      1,
      "close performs no abandoned CLI cleanup",
    );
    const stopAgain = new Promise((resolve) => restarted.direct.server.once("close", resolve));
    restarted.close();
    await stopAgain;
    const { createServer } = await import("node:http");
    const foreign = createServer();
    await new Promise((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    try {
      const collision = await f.make();
      assert.equal(collision.state().directEnabled, false);
      assert.equal(collision.state().directUrl, "");
      assert.equal(collision.direct, null);
      assert.deepEqual(
        (await f.readCli()).config,
        {},
        "port collision removes the exact retained forwarding record instead of leaving it aimed at another process",
      );
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  } finally {
    await f.cleanup();
  }
});

test("disable closes the listener after durable disable and before awaited owned-only cleanup; failure remains recoverable", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    const p = await f.remote.control({ operation: "networkPropose" });
    await f.remote.control({
      operation: "networkApply",
      proposalId: p.proposalId,
      confirmed: true,
    });
    const cli = await f.readCli();
    cli.fail = true;
    cli.requireDisabled = true;
    await f.setCli(cli);
    const state = await f.remote.control({ operation: "disableDirect" });
    assert.equal(state.directEnabled, false);
    assert.equal(state.directUrl, "");
    assert.equal(f.remote.direct, null);
    assert.equal((await f.persisted()).network.mapping.state, "pending");
    assert.equal((await f.persisted()).network.mapping.operation, "remove");
    assert.equal(state.network.diagnostic, "cli-failed");
    const failed = await f.readCli();
    failed.fail = false;
    await f.setCli(failed);
    await f.remote.control({ operation: "networkRemove", confirmed: true });
    assert.deepEqual((await f.readCli()).config, {});
    assert.equal((await f.persisted()).network.mapping.state, "removed");
    assert.equal(f.remote.state().network.diagnostic, "");
  } finally {
    await f.cleanup();
  }
});

test("inspection projects only diagnostics and withdraws advertisement on mapping drift without mutating foreign config", async () => {
  const f = await fixture();
  try {
    const initial = await f.remote.control({ operation: "networkInspect" });
    assert.equal(initial.network.inspection.policy, "unknown");
    assert.equal(initial.network.inspection.login, "logged-in");
    assert.equal(JSON.stringify(initial).includes("Self"), false);
    assert.equal(JSON.stringify(initial).includes("config"), false);
    await f.remote.control({ operation: "enableDirect" });
    const p = await f.remote.control({ operation: "networkPropose" });
    await f.remote.control({
      operation: "networkApply",
      proposalId: p.proposalId,
      confirmed: true,
    });
    const cli = await f.readCli();
    cli.config.Web["fixture.example.ts.net:443"].Handlers["/"].Proxy = "http://127.0.0.1:1";
    await f.setCli(cli);
    const state = await f.remote.control({ operation: "networkInspect" });
    assert.equal(state.network.diagnostic, "mapping-changed");
    assert.equal(state.network.publicOrigin, "");
    assert.equal(state.directUrl, f.remote.direct.origin);
    await f.remote.control({ operation: "networkRemove", confirmed: true });
    assert.deepEqual((await f.readCli()).config, cli.config);
    assert.equal(f.remote.state().network.diagnostic, "mapping-changed");
  } finally {
    await f.cleanup();
  }
});

test("failed final mapping persistence keeps the pending journal and withdraws the old organization origin until recovery", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    await f.remote.control({
      operation: "networkConfigureOrganization",
      publicOrigin: "https://old.example",
      visibility: "private",
      confirmed: true,
    });
    const p = await f.remote.control({ operation: "networkPropose" });
    f.rejectSave(
      (value) =>
        JSON.parse(Buffer.from(value.encrypted, "base64")).network?.mapping?.state === "owned",
    );
    await assert.rejects(
      f.remote.control({ operation: "networkApply", proposalId: p.proposalId, confirmed: true }),
    );
    assert.equal((await f.persisted()).network.mapping.state, "pending");
    assert.equal(f.remote.state().network.publicOrigin, "");
    assert.equal(f.remote.state().network.diagnostic, "persistence-failed");
    assert.equal(
      (await f.remote.control({ operation: "networkRecover", confirmed: true })).network.diagnostic,
      "persistence-failed",
    );
    const before = (await f.readCli()).mutations.length;
    f.rejectSave(() => false);
    await f.remote.control({ operation: "networkRecover", confirmed: true });
    assert.equal((await f.persisted()).network.mapping.state, "owned");
    assert.equal(f.remote.state().network.publicOrigin, "https://fixture.example.ts.net");
    assert.equal((await f.readCli()).mutations.length, before, "recovery does not repeat apply");
  } finally {
    await f.cleanup();
  }
});

test("renderer targets, executables, stale proposals and disappeared listeners cannot mutate Serve", async () => {
  const f = await fixture();
  const { createServer } = await import("node:http");
  let privateRequests = 0;
  const privateServer = createServer((_req, res) => {
    privateRequests++;
    res.end("private");
  });
  await new Promise((resolve) => privateServer.listen(0, "127.0.0.1", resolve));
  try {
    await f.remote.control({ operation: "enableDirect" });
    for (const extra of [
      { remoteListener: { host: "127.0.0.1", port: privateServer.address().port } },
      { target: `http://127.0.0.1:${privateServer.address().port}` },
      { executable: "/bin/echo" },
      { publicOrigin: "https://evil.example" },
    ]) {
      assert.throws(
        () => f.remote.control({ operation: "networkPropose", ...extra }),
        /无效手机设置参数/,
      );
    }
    const p = await f.remote.control({ operation: "networkPropose" });
    assert.throws(
      () =>
        f.remote.control({
          operation: "networkApply",
          proposalId: p.proposalId,
          confirmed: true,
          target: `http://127.0.0.1:${privateServer.address().port}`,
        }),
      /无效手机设置参数/,
    );
    await f.remote.control({ operation: "disableDirect" });
    await f.remote.control({ operation: "enableDirect" });
    await assert.rejects(
      f.remote.control({ operation: "networkApply", proposalId: p.proposalId, confirmed: true }),
      { code: "stale-proposal" },
    );
    const changed = await f.remote.control({ operation: "networkPropose" });
    const listener = f.remote.direct;
    await f.remote.control({
      operation: "networkConfigureOrganization",
      publicOrigin: "https://config-change.example",
      visibility: "private",
      confirmed: true,
    });
    assert.equal(
      f.remote.direct,
      listener,
      "configuration changes without replacing the owned listener",
    );
    await assert.rejects(
      f.remote.control({
        operation: "networkApply",
        proposalId: changed.proposalId,
        confirmed: true,
      }),
      { code: "stale-proposal" },
    );
    const fresh = await f.remote.control({ operation: "networkPropose" });
    await new Promise((resolve) => f.remote.direct.server.close(resolve));
    await assert.rejects(
      f.remote.control({
        operation: "networkApply",
        proposalId: fresh.proposalId,
        confirmed: true,
      }),
      { code: "unverified-listener" },
    );
    assert.equal((await f.readCli()).mutations, undefined);
    assert.equal(privateRequests, 0, "management/Core-like endpoint is never probed or forwarded");
  } finally {
    await f.cleanup();
    await new Promise((resolve) => privateServer.close(resolve));
  }
});

test("failed pending persistence performs no CLI mutation; failed durable disable leaves the previous state intact", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    const before = await f.persisted();
    const p = await f.remote.control({ operation: "networkPropose" });
    f.rejectSave(() => true);
    await assert.rejects(
      f.remote.control({ operation: "networkApply", proposalId: p.proposalId, confirmed: true }),
      { code: "persistence-failed" },
    );
    assert.deepEqual(await f.persisted(), before);
    assert.equal((await f.readCli()).mutations, undefined);
    await assert.rejects(f.remote.control({ operation: "disableDirect" }));
    assert.equal(f.remote.state().directEnabled, true);
    assert.equal(f.remote.direct.server.listening, true);
    f.rejectSave(() => false);
    const fresh = await f.remote.control({ operation: "networkPropose" });
    await f.remote.control({
      operation: "networkApply",
      proposalId: fresh.proposalId,
      confirmed: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("strict local HTTPS proxy preserves same-origin WSS, Noise pairing and project-only access without bypassing certificate validation", async () => {
  const f = await fixture();
  const https = await import("node:https");
  const http = await import("node:http");
  const net = await import("node:net");
  const { createRequire } = await import("node:module");
  const { once } = await import("node:events");
  const crypto = await import("../packages/remote/src/channel.mjs");
  const WebSocket = createRequire(new URL("../app/package.json", import.meta.url))("ws");
  const cert = await readFile(new URL("../../../tests/fixtures/proxy/cert.pem", import.meta.url));
  const key = await readFile(new URL("../../../tests/fixtures/proxy/key.pem", import.meta.url));
  const sockets = new Set();
  let proxy, secure;
  const get = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const req = https.get(url, options, (res) => {
        let body = "";
        res.on("data", (v) => (body += v));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
    });
  try {
    f.service.backend.saved = [{ id: "project-1", root: "/fixture/project" }];
    await f.remote.control({ operation: "enableDirect" });
    proxy = https.createServer({ cert, key }, (request, response) => {
      const upstream = http.request(
        new URL(request.url, f.remote.direct.origin),
        { method: request.method, headers: request.headers },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    });
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("upgrade", (request, socket, head) => {
      const upstream = net.connect(f.remote.direct.server.address().port, "127.0.0.1", () => {
        upstream.write(
          `${request.method} ${request.url} HTTP/1.1\r\n${request.rawHeaders.reduce((all, value, index) => all + (index % 2 ? value + "\r\n" : value + ": "), "")}\r\n`,
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const origin = `https://127.0.0.1:${proxy.address().port}`;
    await f.remote.control({
      operation: "networkConfigureOrganization",
      publicOrigin: origin,
      visibility: "private",
      confirmed: true,
    });
    await assert.rejects(get(origin), (error) =>
      ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.code),
    );
    await assert.rejects(get(origin, { ca: cert, servername: "wrong.example" }), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    const shell = await get(origin, { ca: cert });
    assert.equal(shell.status, 200);
    assert.ok(
      shell.headers["content-security-policy"].includes(
        `connect-src 'self' wss://127.0.0.1:${proxy.address().port};`,
      ),
    );
    for (const path of ["/service.json", "/command", "/core/socket"])
      assert.equal((await get(origin + path, { ca: cert })).status, 404);
    const invitation = await f.remote.control({ operation: "pair" });
    assert.equal(new URL(invitation.payload).origin, origin);
    const inviteSecret = new URLSearchParams(new URL(invitation.payload).hash.slice(1)).get(
      "invite",
    );
    const device = await crypto.createIdentity();
    const ws = new WebSocket(origin.replace("https:", "wss:") + "/remote/socket", {
      ca: cert,
      origin,
    });
    await once(ws, "open");
    const wire = crypto.byteChannel(
      (bytes) => ws.send(bytes),
      () => ws.close(),
    );
    ws.on("message", (bytes) => wire.receive(bytes));
    ws.on("close", () => wire.close());
    secure = await crypto.secureChannel(wire, device, crypto.identityId(f.remote.config.identity));
    const messages = secure.messages();
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "fixture",
      displayName: "TLS phone fixture",
      inviteSecret,
    });
    assert.equal((await messages.next()).value.event, "pairing");
    await f.remote.control({
      operation: "approve",
      id: crypto.identityId(device),
      projects: ["project-1"],
      preset: "Observer",
    });
    assert.equal((await messages.next()).value.event, "ready");
    secure.send({ id: "projects", method: "project.list", params: {} });
    const projects = (await messages.next()).value.result.projects;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].projectId, "project-1");
    for (const method of ["remoteControl", "networkProposeScope", "networkChangeScope"]) {
      secure.send({
        id: `forbidden-${method}`,
        method,
        params: {
          operation: "networkChangeScope",
          proposalId: "spoof",
          confirmed: true,
          publicConfirmed: true,
        },
      });
      assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
    }
    assert.equal((await f.readCli()).mutations, undefined);
  } finally {
    secure?.close();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await f.cleanup();
  }
});

test("restart recovers pending apply and pending remove journals without replaying either CLI mutation", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    const p = await f.remote.control({ operation: "networkPropose" });
    f.rejectSave(
      (value) =>
        JSON.parse(Buffer.from(value.encrypted, "base64")).network?.mapping?.state === "owned",
    );
    await assert.rejects(
      f.remote.control({ operation: "networkApply", proposalId: p.proposalId, confirmed: true }),
    );
    assert.equal((await f.persisted()).network.mapping.state, "pending");
    const stopped = new Promise((resolve) => f.remote.direct.server.once("close", resolve));
    f.remote.close();
    await stopped;
    f.rejectSave(() => false);
    const restarted = await f.make();
    assert.equal(restarted.state().network.publicOrigin, "https://fixture.example.ts.net");
    assert.equal((await f.persisted()).network.mapping.state, "owned");
    assert.equal((await f.readCli()).mutations.length, 1);
    f.rejectSave(
      (value) =>
        JSON.parse(Buffer.from(value.encrypted, "base64")).network?.mapping?.state === "removed",
    );
    const disabled = await restarted.control({ operation: "disableDirect" });
    assert.equal(disabled.directEnabled, false);
    assert.equal(disabled.network.diagnostic, "persistence-failed");
    assert.equal((await f.persisted()).network.mapping.operation, "remove");
    assert.equal((await f.persisted()).network.mapping.state, "pending");
    assert.deepEqual((await f.readCli()).config, {});
    restarted.close();
    f.rejectSave(() => false);
    const clean = await f.make();
    assert.equal(clean.state().directUrl, "");
    assert.equal((await f.persisted()).network.mapping.state, "removed");
    assert.equal((await f.readCli()).mutations.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("a successful reinspection clears obsolete diagnostics while keeping phone and policy unknown", async () => {
  const f = await fixture();
  try {
    await f.setCli({ config: { FutureSchema: {} } });
    assert.equal(
      (await f.remote.control({ operation: "networkInspect" })).network.diagnostic,
      "unknown-config",
    );
    await f.setCli({ config: {} });
    const current = await f.remote.control({ operation: "networkInspect" });
    assert.equal(current.network.diagnostic, "");
    assert.equal(current.network.policy, "unknown");
    assert.equal(current.network.phoneAccess, "unknown");
  } finally {
    await f.cleanup();
  }
});

test("Funnel scope requires both local confirmations, binds a fresh proposal and closes old invitations at the same origin", async () => {
  const f = await fixture();
  try {
    await f.remote.control({ operation: "enableDirect" });
    const privatePlan = await f.remote.control({ operation: "networkPropose" });
    await f.remote.control({
      operation: "networkApply",
      proposalId: privatePlan.proposalId,
      confirmed: true,
    });
    const plan = await f.remote.control({ operation: "networkProposeScope", scope: "public" });
    assert.equal(plan.sourceScope, "private");
    assert.equal(plan.scope, "public");
    assert.equal(plan.publicOrigin, privatePlan.publicOrigin);
    assert.notEqual(plan.proposalId, privatePlan.proposalId);
    assert.equal(JSON.stringify(plan).includes("target"), false);
    for (const confirmations of [{ confirmed: true }, { publicConfirmed: true }]) {
      const request = {
        operation: "networkChangeScope",
        proposalId: plan.proposalId,
        ...confirmations,
      };
      if (confirmations.confirmed)
        await assert.rejects(f.remote.control(request), { code: "public-confirmation-required" });
      if (!confirmations.confirmed)
        assert.throws(() => f.remote.control(request), /无效手机设置参数/);
      assert.equal((await f.readCli()).mutations.length, 1);
    }
    const { createRequire } = await import("node:module");
    const { once } = await import("node:events");
    const WebSocket = createRequire(new URL("../app/package.json", import.meta.url))("ws");
    const socket = new WebSocket(f.remote.direct.ws, {
      headers: { Host: "fixture.example.ts.net", Origin: plan.publicOrigin },
    });
    await once(socket, "open");
    await f.remote.control({ operation: "pair" });
    const closed = once(socket, "close");
    const result = await f.remote.control({
      operation: "networkChangeScope",
      proposalId: plan.proposalId,
      confirmed: true,
      publicConfirmed: true,
    });
    await closed;
    assert.equal(f.remote.invite, null);
    assert.equal(result.network.scope, "public");
    assert.equal(result.directUrl, plan.publicOrigin);
    assert.equal(result.network.policy, "unknown");
    assert.equal(result.network.phoneAccess, "unknown");
    assert.equal((await f.persisted()).network.mapping.scope, "public");
    assert.equal((await f.readCli()).mutations.at(-1)[0], "funnel");
    await assert.rejects(
      f.remote.control({
        operation: "networkChangeScope",
        proposalId: plan.proposalId,
        confirmed: true,
        publicConfirmed: true,
      }),
      { code: "stale-proposal" },
    );
  } finally {
    await f.cleanup();
  }
});

async function privateMapping(f) {
  await f.remote.control({ operation: "enableDirect" });
  const plan = await f.remote.control({ operation: "networkPropose" });
  await f.remote.control({
    operation: "networkApply",
    proposalId: plan.proposalId,
    confirmed: true,
  });
}
async function changeScope(f, scope) {
  const plan = await f.remote.control({ operation: "networkProposeScope", scope });
  return f.remote.control({
    operation: "networkChangeScope",
    proposalId: plan.proposalId,
    confirmed: true,
    publicConfirmed: true,
  });
}

test("interrupted scope restart classifies destination, source, absent and drift read-only; recovery never replays Funnel", async (t) => {
  for (const observed of ["destination", "source", "absent", "changed"])
    await t.test(observed, async () => {
      const f = await fixture();
      try {
        await privateMapping(f);
        const source = (await f.readCli()).config;
        f.rejectSave(
          (value) =>
            JSON.parse(Buffer.from(value.encrypted, "base64")).network?.mapping?.state === "owned",
        );
        await assert.rejects(changeScope(f, "public"), { code: "persistence-failed" });
        assert.equal((await f.persisted()).network.mapping.state, "pending");
        assert.equal(f.remote.state().network.publicOrigin, "");
        const cli = await f.readCli();
        if (observed === "source") cli.config = source;
        if (observed === "absent") cli.config = {};
        if (observed === "changed")
          cli.config.Web["fixture.example.ts.net:443"].Handlers["/"].Proxy = "http://127.0.0.1:1";
        await f.setCli(cli);
        const stopped = new Promise((resolve) => f.remote.direct.server.once("close", resolve));
        f.remote.close();
        await stopped;
        f.rejectSave(() => false);
        const restarted = await f.make();
        assert.equal(restarted.state().network.reconciliation, observed);
        assert.equal(restarted.state().network.publicOrigin, "");
        assert.equal(
          (await f.persisted()).network.mapping.state,
          "pending",
          "startup must retain uncertain journal until local recovery",
        );
        assert.equal((await f.readCli()).mutations.length, 2);
        const recovered = await restarted.control({ operation: "networkRecover", confirmed: true });
        const saved = (await f.persisted()).network.mapping;
        if (observed === "changed") {
          assert.equal(saved.state, "pending");
          assert.equal(recovered.network.diagnostic, "mapping-changed");
        } else if (observed === "absent") {
          assert.equal(saved.state, "removed");
          assert.equal(recovered.network.publicOrigin, "");
        } else {
          assert.equal(saved.state, "owned");
          assert.equal(saved.scope, observed === "source" ? "private" : "public");
          assert.equal(recovered.network.publicOrigin, "https://fixture.example.ts.net");
        }
        assert.equal((await f.readCli()).mutations.length, 2);
        assert.deepEqual((await f.readCli()).config, cli.config);
      } finally {
        await f.cleanup();
      }
    });
});

test("public scope denies stale proposals, injected authority, listener loss and pending save failure before CLI", async (t) => {
  for (const reason of ["replacement", "config", "listener", "mapping", "save"])
    await t.test(reason, async () => {
      const f = await fixture();
      try {
        await privateMapping(f);
        const plan = await f.remote.control({ operation: "networkProposeScope", scope: "public" });
        for (const extra of [
          { target: "http://127.0.0.1:1" },
          { executable: "/bin/echo" },
          { record: {} },
          { scope: "private" },
        ])
          assert.throws(
            () =>
              f.remote.control({
                operation: "networkChangeScope",
                proposalId: plan.proposalId,
                confirmed: true,
                publicConfirmed: true,
                ...extra,
              }),
            /无效手机设置参数/,
          );
        if (reason === "replacement")
          await f.remote.control({ operation: "networkProposeScope", scope: "public" });
        if (reason === "config") await f.remote.control({ operation: "disable" });
        if (reason === "listener")
          await new Promise((resolve) => f.remote.direct.server.close(resolve));
        if (reason === "mapping") {
          const cli = await f.readCli();
          cli.config.Web["fixture.example.ts.net:443"].Handlers["/"].Proxy = "http://127.0.0.1:1";
          await f.setCli(cli);
        }
        if (reason === "save") f.rejectSave(() => true);
        const before = await f.persisted();
        await assert.rejects(
          f.remote.control({
            operation: "networkChangeScope",
            proposalId: plan.proposalId,
            confirmed: true,
            publicConfirmed: true,
          }),
          {
            code: {
              replacement: "stale-proposal",
              config: "stale-proposal",
              listener: "unverified-listener",
              mapping: "mapping-changed",
              save: "persistence-failed",
            }[reason],
          },
        );
        assert.equal((await f.readCli()).mutations.length, 1);
        assert.deepEqual(await f.persisted(), before);
      } finally {
        await f.cleanup();
      }
    });
});

test("private restore and disable work after Funnel grant loss without changing foreign mappings", async (t) => {
  for (const operation of ["restore", "remove", "pending-source", "pending-destination"])
    await t.test(operation, async () => {
      const f = await fixture();
      try {
        const foreign = {
          TCP: { 8443: { HTTPS: true } },
          Web: { "foreign.example:8443": { Handlers: { "/": { Text: "keep" } } } },
          AllowFunnel: { "foreign.example:8443": true },
          Foreground: { other: { TCP: { 10000: { TCPForward: "localhost:99" } } } },
        };
        await f.setCli({ config: foreign });
        await privateMapping(f);
        if (operation.startsWith("pending"))
          f.rejectSave(
            (value) =>
              JSON.parse(Buffer.from(value.encrypted, "base64")).network?.mapping?.state ===
              "owned",
          );
        if (operation.startsWith("pending")) await assert.rejects(changeScope(f, "public"));
        else await changeScope(f, "public");
        const cli = await f.readCli();
        if (operation === "pending-source")
          delete cli.config.AllowFunnel["fixture.example.ts.net:443"];
        cli.status = {
          BackendState: "Running",
          Self: { DNSName: "fixture.example.ts.net.", CapMap: {} },
          CertDomains: ["fixture.example.ts.net"],
        };
        await f.setCli(cli);
        f.rejectSave(() => false);
        if (operation === "restore") {
          const state = await changeScope(f, "private");
          assert.equal(state.network.scope, "private");
          assert.deepEqual((await f.readCli()).config.AllowFunnel, foreign.AllowFunnel);
        }
        const state = await f.remote.control({ operation: "disableDirect" });
        assert.equal(state.network.diagnostic, "");
        assert.equal((await f.persisted()).network.mapping.state, "removed");
        assert.deepEqual((await f.readCli()).config, foreign);
      } finally {
        await f.cleanup();
      }
    });
});

test("ambiguous local Funnel capabilities and unsupported requested port refuse proposals without mutation", async (t) => {
  for (const reason of ["ambiguous", "missing", "malformed", "port"])
    await t.test(reason, async () => {
      const f = await fixture();
      try {
        await f.remote.control({ operation: "enableDirect" });
        const p = await f.remote.control({
          operation: "networkPropose",
          httpsPort: reason === "port" ? 9443 : 443,
        });
        await f.remote.control({
          operation: "networkApply",
          proposalId: p.proposalId,
          confirmed: true,
        });
        const cli = await f.readCli();
        const caps = {
          https: [],
          funnel: [],
          "https://tailscale.com/cap/funnel-ports?ports=443": [],
        };
        if (reason === "ambiguous")
          caps["https://tailscale.com/cap/funnel-ports?ports=443,8443"] = [];
        if (reason === "missing") delete caps.funnel;
        if (reason === "malformed") caps.funnel = {};
        cli.status = {
          BackendState: "Running",
          Self: { DNSName: "fixture.example.ts.net.", CapMap: caps },
          CertDomains: ["fixture.example.ts.net"],
        };
        await f.setCli(cli);
        await assert.rejects(
          f.remote.control({ operation: "networkProposeScope", scope: "public" }),
          {
            code:
              reason === "port"
                ? "unsupported-funnel-port"
                : reason === "missing"
                  ? "funnel-port-denied"
                  : "funnel-capability-unknown",
          },
        );
        assert.equal((await f.readCli()).mutations.length, 1);
      } finally {
        await f.cleanup();
      }
    });
});
