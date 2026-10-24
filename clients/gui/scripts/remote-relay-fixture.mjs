import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer as tlsServer } from "node:tls";
import { createServer as netServer, connect } from "node:net";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { createRequire } from "node:module";
import { CoreClient } from "../packages/runtime-client/core.js";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
import { RemoteControl } from "../app/src/core/remote.cjs";

export async function certificates() {
  const home = await mkdtemp(join(tmpdir(), "rc12-tls-"));
  const run = (args) => execFileSync("openssl", args, { cwd: home, stdio: "pipe" });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-subj",
    "/CN=RC12 isolated test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost",
  ]);
  await writeFile(
    join(home, "extensions"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  run([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.pem",
    "-days",
    "1",
    "-extfile",
    "extensions",
  ]);
  await writeFile(
    join(home, "wrong-extensions"),
    "subjectAltName=DNS:wrong.invalid\nextendedKeyUsage=serverAuth\n",
  );
  run([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "wrong.pem",
    "-days",
    "1",
    "-extfile",
    "wrong-extensions",
  ]);
  await writeFile(join(home, "index"), "");
  await writeFile(join(home, "serial"), "01\n");
  await writeFile(
    join(home, "ca.cnf"),
    "[ca]\ndefault_ca=local\n[local]\ndatabase=index\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\nserial=serial\ndefault_md=sha256\npolicy=policy\nx509_extensions=ext\n[policy]\ncommonName=supplied\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  run([
    "ca",
    "-batch",
    "-config",
    "ca.cnf",
    "-in",
    "server.csr",
    "-out",
    "expired.pem",
    "-startdate",
    "200101000000Z",
    "-enddate",
    "200102000000Z",
  ]);
  return home;
}
export async function waitFor(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("fixture deadline");
}
export async function relayFixture(
  t,
  {
    assetsDir,
    certificate = "server.pem",
    relayOptions = {},
    tlsHome = process.env.RC12_TLS_HOME,
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "rc12-relay-"));
  const probe = netServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const backendPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const sockets = new Set();
  const proxy = tlsServer(
    {
      key: await readFile(join(tlsHome, "server.key")),
      cert: await readFile(join(tlsHome, certificate)),
    },
    (socket) => {
      const upstream = connect(backendPort, "127.0.0.1");
      sockets.add(socket);
      sockets.add(upstream);
      socket.pipe(upstream).pipe(socket);
      for (const s of [socket, upstream]) {
        s.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
        s.on("close", () => {
          sockets.delete(s);
          socket.destroy();
          upstream.destroy();
        });
      }
    },
  );
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  const config = join(home, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      publicOrigin: origin,
      listen: `127.0.0.1:${backendPort}`,
      trustedLocalTlsProxy: true,
      allowedClientOrigins: [origin],
      dataDir: join(home, "data"),
      ...(assetsDir ? { assetsDir } : {}),
      ...relayOptions,
    }),
  );
  const cli = new URL("../../../services/remote-relay/src/cli.mjs", import.meta.url).pathname;
  let child,
    logs = "";
  const resources = {
    proxy: { pid: process.pid, port: proxy.address().port, closed: false },
    cli: [],
  };
  const f = {
    resources,
    home,
    origin,
    config,
    logs: () => logs,
    admin: (...args) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, ...args, "--config", config], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    async start() {
      const logStart = logs.length;
      child = spawn(process.execPath, [cli, "serve", "--config", config], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const receipt = { pid: child.pid, exited: false };
      resources.cli.push(receipt);
      child.once("exit", (code, signal) => Object.assign(receipt, { exited: true, code, signal }));
      child.stdout.on("data", (b) => {
        logs += b;
      });
      child.stderr.on("data", (b) => {
        logs += b;
      });
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error("Relay CLI exited");
        return logs.slice(logStart).includes('"event":"listening"');
      });
    },
    async stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
      child = null;
    },
  };
  t.after(async () => {
    await f.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => proxy.close(r));
    resources.proxy.closed = true;
    await rm(home, { recursive: true, force: true });
  });
  try {
    await f.start();
  } catch (error) {
    error.fixtureResources = resources;
    throw error;
  }
  return f;
}
export async function hostFixture(t, { config, commands = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rc12-host-"));
  const key = randomBytes(32);
  let rejectSave = false;
  const savedWrites = [];
  const encryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture-aes-gcm",
    encryptString(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    },
  };
  const service = {
    schedule() {},
    backend: {
      home,
      saved: [{ id: "project", root: "/fixture/Project" }],
      projects: new Map(),
      async save(name, value) {
        if (rejectSave) throw new Error("fixture storage unavailable");
        savedWrites.push(name);
        await writeFile(join(home, name), JSON.stringify(value));
      },
    },
  };
  if (commands) {
    const { CoreBackend } = require("../app/src/core/backend.cjs");
    const backend = new CoreBackend({ home, binary: "/unused-source-fixture" });
    backend.saved = service.backend.saved;
    const save = backend.save.bind(backend);
    backend.save = (name, value) => {
      if (rejectSave) return Promise.reject(new Error("fixture storage unavailable"));
      savedWrites.push(name);
      return save(name, value);
    };
    backend.start =
      backend.launch =
      backend.connect =
      backend.openThread =
        () => {
          throw new Error("forbidden source-fixture lifecycle effect");
        };
    service.backend = backend;
  }
  if (config)
    await service.backend.save("remote.json", {
      encrypted: encryption.encryptString(JSON.stringify(config)).toString("base64"),
    });
  const instances = [];
  const make = async () => {
    const remote = new RemoteControl(service, encryption);
    instances.push(remote);
    await remote.init();
    return remote;
  };
  t.after(async () => {
    for (const remote of instances) remote.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    remote: await make(),
    make,
    home,
    service,
    savedWrites,
    rejectSave: (value) => {
      rejectSave = value;
    },
    persisted: async () =>
      JSON.parse(
        encryption.decryptString(
          Buffer.from(
            JSON.parse(await readFile(join(home, "remote.json"), "utf8")).encrypted,
            "base64",
          ),
        ),
      ),
  };
}

// Native-shaped RPC 边界夹具；真实 CoreClient 连接，可选命令回应，绝不启动原生 Core。
export async function nativeProject(t, fixture, { large = false, commands = false } = {}) {
  const wss = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const calls = [],
    sockets = new Set();
  let version = 1;
  wss.on("connection", (socket, request) => {
    if (request.headers.authorization !== "Bearer source-fixture-only") {
      socket.terminate();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const request = JSON.parse(raw);
      calls.push(request.method);
      if (request.method === "initialized") return;
      let result;
      if (request.method === "initialize") result = {};
      else if (request.method === "areal/capabilities")
        result = {
          methods: [
            "areal/thread/observe",
            "thread/read",
            "areal/subscription/remove",
            ...(commands ? ["areal/thread/start"] : []),
          ],
          features: {
            ...(commands ? { threadStartAdmissionGuard: true, permissionPresets: true } : {}),
            atomicObserve: true,
            atomicObserveOwnership: true,
            subscriptionRemoval: true,
          },
        };
      else if (["areal/thread/observe", "thread/read"].includes(request.method))
        result = {
          ownership: { kind: "ordinary" },
          thread: {
            id: "thread",
            preview: `Baseline ${version}`,
            status: { type: "idle" },
            turns: [
              {
                id: "turn",
                status: "completed",
                items: large
                  ? Array.from({ length: 100 }, (_, index) => ({
                      id: `item-${index}`,
                      type: "agentMessage",
                      text: "x".repeat(1024),
                    }))
                  : [{ id: "item", type: "agentMessage", text: `Projection ${version}` }],
              },
            ],
          },
        };
      else if (commands && request.method === "areal/thread/start")
        result = { thread: { id: `created-${calls.length}` } };
      else if (request.method === "areal/subscription/remove") result = {};
      else {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: "Unexpected non-read method" },
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const endpoint = `ws://127.0.0.1:${wss.address().port}`;
  const desktop = new CoreClient({
    createSocket: () =>
      new WebSocket(endpoint, { headers: { Authorization: "Bearer source-fixture-only" } }),
  });
  await desktop.connect();
  const project = commands ? await fixture.service.backend.loadProjectJournal("project") : {};
  fixture.service.backend.projects.set(
    "project",
    Object.assign(project, {
      root: "/fixture/Project",
      endpoint,
      token: "source-fixture-only",
      service: { serviceId: "native-fixture", generation: "generation-1" },
      client: desktop,
      model: commands ? project.model : { state: { connected: true }, subscribe: () => () => {} },
    }),
  );
  if (commands) project.model.connection(true);
  t.after(async () => {
    desktop.close();
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  return {
    calls,
    connections: () => sockets.size,
    setVersion: (value) => {
      version = value;
    },
  };
}
