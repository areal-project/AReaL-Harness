import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer as tcpServer, connect } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { proxyForUrl, subscriptionNetwork } from "../packages/chatgpt-provider/network.js";

const require = createRequire(import.meta.url);
const { parseSystemProxy, systemProxyEnvironment } = require("@areal/workbench/node/system-proxy");
const { proxyRelay } = require("../app/src/core/proxy-relay.cjs");
const settings = (entries) => `<dictionary> {\n${entries}\n}\n`;

test("constructing and closing an unused transport never loads system certificates", () => {
  // 独立子进程替换 TLS 探针，避免改动其他并行用例的全局绑定。
  const networkUrl = new URL("../packages/chatgpt-provider/network.js", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import tls from 'node:tls';
    import { syncBuiltinESMExports } from 'node:module';
    tls.getCACertificates = () => { throw Error('unexpected system certificate access'); };
    syncBuiltinESMExports();
    const { subscriptionNetwork } = await import(${JSON.stringify(networkUrl)});
    const network = subscriptionNetwork({ AREAL_CHATGPT_PROXY_ERROR: 'unavailable' });
    network.close();
    try { await network.fetch('https://example.invalid'); throw Error('unexpected request'); }
    catch (error) { if (error.message !== 'ChatGPT proxy unavailable') throw error; }
    network.close();
  `,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test("active macOS settings map HTTP, HTTPS CONNECT and SOCKS with explicit environment precedence", async () => {
  const text = settings(
    `HTTPEnable : 1\nHTTPProxy : http.proxy\nHTTPPort : 8080\nHTTPSEnable : 1\nHTTPSProxy : secure.proxy\nHTTPSPort : 8443\nSOCKSEnable : 1\nSOCKSProxy : ::1\nSOCKSPort : 1080\nExceptionsList : <array> {\n0 : *.internal.test\n1 : 10.0.0.0/8\n}\n__SCOPED__ : <dictionary> {\nen0 : <dictionary> {\nHTTPProxy : ignored.proxy\n}\n}`,
  );
  const parsed = parseSystemProxy(text);
  assert.equal(parsed.http, "http://http.proxy:8080");
  assert.equal(parsed.https, "http://secure.proxy:8443");
  assert.equal(parsed.socks, "socks5h://[::1]:1080");
  const run = async (binary, args, options) => {
    assert.equal(binary, "/usr/sbin/scutil");
    assert.deepEqual(args, ["--proxy"]);
    assert.equal(options.timeout, 5000);
    return { stdout: text };
  };
  const env = await systemProxyEnvironment({}, "darwin", run);
  assert.equal(env.HTTPS_PROXY, parsed.https);
  assert.equal(env.https_proxy, parsed.https);
  assert.match(env.NO_PROXY, /\.internal\.test,10\.0\.0\.0\/8/);
  const overridden = await systemProxyEnvironment(
    {
      all_proxy: "socks5h://override:1080",
      HTTP_PROXY: "http://explicit:3128",
      http_proxy: "http://lowercase:8080",
      NO_PROXY: "existing.test",
    },
    "darwin",
    run,
  );
  assert.equal(overridden.HTTP_PROXY, "http://explicit:3128");
  assert.equal(overridden.http_proxy, overridden.HTTP_PROXY);
  assert.equal(overridden.HTTPS_PROXY, "socks5h://override:1080");
  assert.match(overridden.NO_PROXY, /^existing\.test,/);
  await systemProxyEnvironment({}, "linux", () =>
    assert.fail("other platforms must not invoke scutil"),
  );
  assert.throws(
    () => parseSystemProxy(settings("SOCKSEnable : 1\nSOCKSProxy : proxy\nSOCKSPort : 65536")),
    /端口无效/,
  );
});

test("no proxy and bypass rules preserve local controls, domain, IP, CIDR and port exemptions", () => {
  const source = {
    HTTP_PROXY: "http://proxy:8080",
    HTTPS_PROXY: "socks5h://proxy:1080",
    NO_PROXY: ".internal.test,10.0.0.0/8,[2001:db8::]/32,port.test:8443",
  };
  for (const url of [
    "http://localhost:8080",
    "http://127.3.2.1:8080",
    "http://[::1]:8080",
    "https://app.localhost",
    "https://internal.test",
    "https://child.internal.test",
    "http://10.5.4.3",
    "http://[2001:db8::1]",
    "https://port.test:8443",
  ])
    assert.equal(proxyForUrl(url, source), "", url);
  assert.equal(proxyForUrl("https://otherinternal.test", source), source.HTTPS_PROXY);
  assert.equal(proxyForUrl("https://port.test:443", source), source.HTTPS_PROXY);
  assert.equal(proxyForUrl("http://model.test", source), source.HTTP_PROXY);
  assert.equal(proxyForUrl("https://model.test", { ...source, NO_PROXY: "*" }), "");
  assert.equal(proxyForUrl("https://model.test", {}), "");
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function origin(t, secure) {
  const requests = [];
  const handler = async (req, res) => {
    for await (const _ of req) {
      /* 读完请求后返回确定性响应。 */
    }
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'data: {"choices":[{"index":0,"delta":{"content":"proxy works"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      );
    }
  };
  const server = secure
    ? httpsServer(
        {
          key: await readFile(new URL("../../../tests/fixtures/proxy/key.pem", import.meta.url)),
          cert: await readFile(new URL("../../../tests/fixtures/proxy/cert.pem", import.meta.url)),
        },
        handler,
      )
    : httpServer(handler);
  return { port: await listen(t, server), requests };
}

async function proxy(t, kind, originPort) {
  const requests = [];
  let server;
  if (kind === "http") {
    server = httpServer((req, res) => {
      const url = new URL(req.url);
      requests.push(url.hostname);
      const upstream = require("node:http").request(
        {
          host: "127.0.0.1",
          port: originPort,
          path: url.pathname,
          method: req.method,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    server.on("connect", (req, socket, head) => {
      requests.push(req.url);
      const upstream = connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    });
  } else {
    server = tcpServer((socket) => {
      let buffer = Buffer.alloc(0),
        state = "greeting";
      const receive = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (state === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          assert.equal(buffer[0], 5);
          buffer = buffer.subarray(2 + buffer[1]);
          state = "request";
          socket.write(Buffer.from([5, 0]));
        }
        if (state === "request") {
          if (buffer.length < 5) return;
          assert.equal(buffer[3], 3, "SOCKS5h sends the unresolved hostname to the proxy");
          const length = buffer[4];
          if (buffer.length < 7 + length) return;
          requests.push(buffer.subarray(5, 5 + length).toString());
          const tail = buffer.subarray(7 + length);
          state = "connected";
          socket.removeListener("data", receive);
          const upstream = connect(originPort, "127.0.0.1", () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (tail.length) upstream.write(tail);
            socket.pipe(upstream).pipe(socket);
          });
          upstream.on("error", () => socket.destroy());
          socket.on("close", () => upstream.destroy());
        }
      };
      socket.on("data", receive);
    });
  }
  return { port: await listen(t, server), requests };
}

for (const kind of ["http", "socks"])
  for (const secure of [false, true]) {
    test(
      `subscription JSON and streaming transport use system ${kind} for ${secure ? "HTTPS" : "HTTP"}`,
      { timeout: 15000 },
      async (t) => {
        const target = await origin(t, secure),
          gateway = await proxy(t, kind, target.port);
        const settingsText =
          kind === "socks"
            ? settings(`SOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\nSOCKSPort : ${gateway.port}`)
            : settings(
                `HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : ${gateway.port}\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : ${gateway.port}`,
              );
        const upstreamEnv = await systemProxyEnvironment({}, "darwin", async () => ({
          stdout: settingsText,
        }));
        const relay = await proxyRelay(upstreamEnv, { platform: "darwin" });
        t.after(() => relay.close());
        const network = subscriptionNetwork({
          ...relay.environment,
          NODE_EXTRA_CA_CERTS: fileURLToPath(
            new URL("../../../tests/fixtures/proxy/cert.pem", import.meta.url),
          ),
        });
        t.after(() => network.close());
        const base = `${secure ? "https" : "http"}://model.invalid:${target.port}`;
        const models = await network.fetch(`${base}/v1/models`);
        assert.ok(models.ok);
        assert.deepEqual((await models.json()).data, [{ id: "fixture-model" }]);
        const stream = await network.fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "fixture-model", stream: true }),
        });
        assert.ok(stream.ok);
        assert.match(stream.headers.get("Content-Type"), /^text\/event-stream/);
        assert.match(await stream.text(), /proxy works.*\n\ndata: \[DONE\]/);
        assert.deepEqual(
          target.requests.map((req) => req.path),
          ["/v1/models", "/v1/chat/completions"],
        );
        assert.equal(gateway.requests.length, 2);
        assert.ok(gateway.requests.every((host) => host.startsWith("model.invalid")));
      },
    );
  }

test(
  "loopback with authentication stays direct even with an unreachable proxy",
  { timeout: 5000 },
  async (t) => {
    const target = await origin(t, false);
    const network = subscriptionNetwork({ ALL_PROXY: "socks5h://127.0.0.1:1" });
    t.after(() => network.close());
    const response = await network.fetch(`http://127.0.0.1:${target.port}/v1/models`, {
      headers: { Authorization: "Bearer local-fixture" },
    });
    assert.deepEqual((await response.json()).data, [{ id: "fixture-model" }]);
    assert.equal(target.requests[0].authorization, "Bearer local-fixture");
  },
);

test(
  "SOCKS relay preserves authentication bytes, stable ports, and closes active sockets",
  { timeout: 5000 },
  async (t) => {
    const echo = tcpServer((socket) => socket.pipe(socket));
    const port = await listen(t, echo);
    const proxyUrl = `socks5h://fixture:secret@127.0.0.1:${port}`;
    const source = {
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
      NO_PROXY: "localhost",
      HTTP_PROXY: "http://127.0.0.1:3128",
    };
    let saved;
    let relay = await proxyRelay(source, {
      platform: "darwin",
      save: async (ports) => {
        saved = { ...ports };
      },
    });
    t.after(() => relay.close());
    const forwarded = new URL(relay.environment.HTTPS_PROXY);
    assert.equal(forwarded.username, "fixture");
    assert.equal(forwarded.password, "secret");
    assert.equal(relay.environment.https_proxy, forwarded.href);
    assert.equal(relay.environment.ALL_PROXY, forwarded.href);
    assert.equal(relay.environment.HTTP_PROXY, source.HTTP_PROXY);
    assert.equal(relay.environment.NO_PROXY, source.NO_PROXY);
    assert.equal(Object.keys(saved).length, 1);
    assert.ok(!JSON.stringify(saved).includes("secret"));
    const socket = connect(Number(forwarded.port), "127.0.0.1");
    await once(socket, "connect");
    const bytes = Buffer.from([
      5, 2, 0, 2, 1, 7, 102, 105, 120, 116, 117, 114, 101, 6, 115, 101, 99, 114, 101, 116,
    ]);
    socket.write(bytes);
    const [reply] = await once(socket, "data");
    assert.deepEqual(reply, bytes);
    const closed = once(socket, "close");
    await relay.close();
    await closed;
    relay = await proxyRelay(source, { platform: "darwin", ports: saved });
    assert.equal(relay.environment.HTTPS_PROXY, forwarded.href);
    const direct = await proxyRelay(source, { platform: "linux" });
    assert.deepEqual(direct.environment, source);
    await direct.close();
  },
);

for (const secure of [false, true]) {
  test(
    `native Core streams ${secure ? "HTTPS" : "HTTP"} through the GUI SOCKS relay`,
    { timeout: 15000, skip: !process.env.AREAL_TEST_MODEL_PROXY_BIN },
    async (t) => {
      const target = await origin(t, secure),
        gateway = await proxy(t, "socks", target.port);
      const relay = await proxyRelay(
        { ALL_PROXY: `socks5h://127.0.0.1:${gateway.port}`, NO_PROXY: "localhost,127.0.0.1" },
        { platform: "darwin" },
      );
      t.after(() => relay.close());
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (/^(http|https|all|no)_proxy$/i.test(key)) delete env[key];
      Object.assign(env, relay.environment, {
        AREAL_TEST_PROXY_ENDPOINT: `${secure ? "https" : "http"}://model.invalid:${target.port}/v1/chat/completions`,
        SSL_CERT_FILE: fileURLToPath(
          new URL("../../../tests/fixtures/proxy/cert.pem", import.meta.url),
        ),
      });
      const args = [
        process.env.AREAL_TEST_MODEL_PROXY_BIN,
        "--exact",
        "model_requests_use_proxy_environment",
        "--nocapture",
      ];
      // macOS 原生验证保留 Python 实际父进程，与产品可信启动链一致。
      const child =
        process.platform === "darwin"
          ? spawn(
              "/usr/bin/python3",
              [
                "-I",
                "-S",
                "-c",
                "import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))",
                ...args,
              ],
              { env },
            )
          : spawn(args[0], args.slice(1), { env });
      t.after(() => child.kill());
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const [exit] = await once(child, "exit");
      assert.equal(exit, 0, output);
      assert.deepEqual(gateway.requests, ["model.invalid"]);
      assert.deepEqual(
        target.requests.map((req) => req.path),
        ["/v1/chat/completions"],
      );
    },
  );
}

test(
  "SOCKS relay drains a large upstream response before EOF and cleans up failed persistence",
  { timeout: 5000 },
  async (t) => {
    const bytes = Buffer.alloc(1024 * 1024, 0xa5);
    const upstream = tcpServer((socket) => socket.end(bytes));
    const port = await listen(t, upstream);
    const source = { ALL_PROXY: `socks5h://127.0.0.1:${port}` };
    const relay = await proxyRelay(source, { platform: "darwin" });
    t.after(() => relay.close());
    const target = new URL(relay.environment.ALL_PROXY);
    const client = connect(Number(target.port), "127.0.0.1");
    t.after(() => client.destroy());
    const chunks = [];
    for await (const chunk of client) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    let saved;
    await assert.rejects(
      proxyRelay(source, {
        platform: "darwin",
        save: async (ports) => {
          saved = { ...ports };
          throw new Error("fixture save failed");
        },
      }),
      /fixture save failed/,
    );
    const recovered = await proxyRelay(source, { platform: "darwin", ports: saved });
    await recovered.close();
  },
);
