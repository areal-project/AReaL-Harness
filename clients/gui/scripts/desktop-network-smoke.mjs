import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionNetwork } from "../packages/chatgpt-provider/network.js";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function createLocalTlsFixture(directory) {
  await mkdir(directory, { recursive: true });
  const servers = [], sockets = new Set(), requests = [];
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  };
  const openssl = args => execFileSync("openssl", args, { cwd: directory, stdio: "ignore", timeout: 15000 });
  try {
    for (const name of ["root", "unrelated-root"]) {
      openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "1", "-subj", `/CN=AReaL synthetic ${name}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    }
    const cases = [
      { name: "valid", ca: "root", host: "localhost", days: "1", accepted: true },
      { name: "wrong-host", ca: "root", host: "other.fixture.invalid", days: "1", accepted: false },
      { name: "expired", ca: "root", host: "localhost", days: "1", accepted: false },
      { name: "unrelated", ca: "unrelated-root", host: "localhost", days: "1", accepted: false },
      { name: "unknown-critical", ca: "root", host: "localhost", days: "1", accepted: false },
    ];
    for (const test of cases) {
      openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${test.name}.key`, "-out", `${test.name}.csr`, "-subj", `/CN=${test.host}`]);
      await writeFile(join(directory, `${test.name}.ext`), `[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${test.host}\n${test.name === "unknown-critical" ? "1.2.3.4.5.6.7.8.1=critical,DER:05:00\n" : ""}`);
      if (test.name === "expired") {
        await writeFile(join(directory, "expired-index"), "");
        await writeFile(join(directory, "expired-serial"), "01\n");
        await writeFile(join(directory, "expired-ca.cnf"), "[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=expired-index\nnew_certs_dir=.\ncertificate=root.pem\nprivate_key=root.key\nserial=expired-serial\ndefault_md=sha256\npolicy=fixture_policy\n[fixture_policy]\ncommonName=supplied\n");
        openssl(["ca", "-batch", "-notext", "-config", "expired-ca.cnf", "-in", `${test.name}.csr`, "-out", `${test.name}.pem`, "-startdate", "20000101000000Z", "-enddate", "20000102000000Z", "-extfile", `${test.name}.ext`, "-extensions", "server"]);
      } else {
        openssl(["x509", "-req", "-in", `${test.name}.csr`, "-CA", `${test.ca}.pem`, "-CAkey", `${test.ca}.key`, "-CAcreateserial", "-out", `${test.name}.pem`, "-days", test.days, "-extfile", `${test.name}.ext`, "-extensions", "server"]);
      }
      const server = createHttpsServer({ key: await readFile(join(directory, `${test.name}.key`)), cert: await readFile(join(directory, `${test.name}.pem`)) }, (req, res) => {
        requests.push({ name: test.name, url: req.url });
        res.end(`tls-${test.name}`);
      });
      servers.push(server);
      server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      test.url = `https://localhost:${server.address().port}/`;
    }
    return { caPath: join(directory, "root.pem"), cases, requests, close };
  } catch (error) { await close(); throw error; }
}

async function desktopNetworkSmoke() {
  const evidenceRoot = join(root, ".scratch/settings-zcode");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, "network-"));
  const fixture = await mkdtemp("/private/tmp/areal-network-");
  console.log("Desktop network evidence:", evidence);
  const servers = [], transports = [], sockets = new Set(), checks = [];
  const source = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    diffSHA256: createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })).digest("hex"),
    files: Object.fromEntries(await Promise.all(["clients/gui/scripts/desktop-network-smoke.mjs", "clients/gui/app/src/core/desktop-network.cjs", "clients/gui/packages/chatgpt-provider/network.js"].map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")]))),
  };
  let passed = false, failure, tlsFixture, bypassError;
  async function listen(server) {
    servers.push(server);
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
  }
  function transport(env) { const result = subscriptionNetwork(env); transports.push(result); return result; }
  async function text(client, url) {
    const response = await client.fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.text();
  }
  try {
    const { resolveDesktopNetwork } = require("../app/src/core/desktop-network.cjs");
    const emptySource = { NO_PROXY: "", no_proxy: "", HTTP_PROXY: "", http_proxy: "", HTTPS_PROXY: "", https_proxy: "", ALL_PROXY: "", all_proxy: "" };
    const resolveNetwork = settings => resolveDesktopNetwork(settings, emptySource, { platform: "linux", caBundleDirectory: join(fixture, "merged-ca") });
    const originRequests = [], proxyRequests = [];
    const originPort = await listen(createHttpServer((req, res) => { originRequests.push(req.url); res.end("local-origin-ok"); }));
    const proxyPort = await listen(createHttpServer((req, res) => {
      proxyRequests.push(req.url);
      const target = new URL(req.url);
      const forwarded = httpRequest({ hostname: "127.0.0.1", port: originPort, path: target.pathname, method: req.method }, upstream => upstream.pipe(res));
      forwarded.on("error", error => res.destroy(error));
      req.pipe(forwarded);
    }));
    const proxy = `http://127.0.0.1:${proxyPort}`;
    const target = `http://settings.fixture.invalid:${originPort}/proxy`;
    const configured = await resolveNetwork({ httpProxy: ` ${proxy} `, httpProxyNoProxy: "" });
    assert.equal(await text(transport(configured), target), "local-origin-ok");
    assert.deepEqual(proxyRequests, [target], "explicit desktop proxy carries actual HTTP request");
    assert.deepEqual(originRequests, ["/proxy"]);
    checks.push("explicit desktop proxy reaches a real loopback HTTP proxy and origin");
    const bypass = await resolveNetwork({ httpProxy: proxy, httpProxyNoProxy: " settings.fixture.invalid " });
    await assert.rejects(() => text(transport(bypass), target), error => {
      bypassError = { name: error.name, code: error.code, message: error.message };
      return ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(error.code) || ["AbortError", "TimeoutError"].includes(error.name);
    }, "NO_PROXY takes the direct unresolved synthetic-host route rather than proxy");
    assert.equal(proxyRequests.length, 1, "NO_PROXY request never enters the proxy");
    assert.equal(await text(transport(configured), `http://127.0.0.1:${originPort}/loopback`), "local-origin-ok");
    assert.equal(proxyRequests.length, 1, "local control requests always bypass external proxy");
    checks.push("NO_PROXY bypass and unconditional loopback bypass have actual network evidence");
    tlsFixture = await createLocalTlsFixture(join(fixture, "tls"));
    const trustedEnv = await resolveNetwork({ httpProxyCaCertPath: tlsFixture.caPath });
    for (const test of tlsFixture.cases) {
      const client = transport(trustedEnv);
      if (test.accepted) assert.equal(await text(client, test.url), `tls-${test.name}`, "configured root authorizes an otherwise untrusted local certificate");
      else await assert.rejects(() => text(client, test.url), error => /certificate|cert|hostname|self.signed|expired|critical/i.test(error.message), `custom root never disables ${test.name} validation`);
      checks.push(`TLS ${test.name}: ${test.accepted ? "accepted" : "rejected"}`);
    }
    const clearedEnv = await resolveNetwork({ httpProxyCaCertPath: "" });
    await assert.rejects(() => text(transport(clearedEnv), tlsFixture.cases[0].url), "clearing the custom CA removes its authority");
    await writeFile(join(fixture, "invalid.pem"), "this is not a certificate\n");
    await assert.rejects(() => resolveNetwork({ httpProxyCaCertPath: join(fixture, "invalid.pem") }), "malformed custom CA rejects at settings boundary");
    await assert.rejects(() => resolveNetwork({ httpProxyCaCertPath: join(fixture, "absent.pem") }), "missing custom CA rejects at settings boundary");
    await assert.rejects(() => resolveNetwork({ httpProxy: "file:///invalid" }), "unsupported proxy URL rejects at settings boundary");
    checks.push("cleared CA removes synthetic trust and invalid proxy/CA settings reject");
    passed = true;
  } catch (error) {
    failure = error.stack ?? String(error);
    console.error(failure);
    process.exitCode = 1;
  } finally {
    for (const client of transports) client.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await tlsFixture?.close();
    await rm(fixture, { recursive: true, force: true });
    await writeFile(join(evidence, "manifest.json"), JSON.stringify({ passed, source, checks, failure, bypassError, fixtureCleaned: true,
      limits: ["synthetic local HTTP/HTTPS servers and proxy only", "NO_PROXY nonlocal target produces the recorded direct-network failure and no proxy access", "Node provider transport; Chromium verifier and Rust provider covered separately", "no real account or remote network"] }, null, 2));
    console.log(JSON.stringify({ passed, evidence, checks, failure }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await desktopNetworkSmoke();
