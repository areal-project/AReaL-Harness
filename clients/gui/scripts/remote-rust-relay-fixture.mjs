import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:tls";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { waitFor } from "./remote-relay-fixture.mjs";

export const nativeResources = [];
export const observerResources = [];

export async function nativeRelay(t, config, { trusted = true } = {}) {
  const environment = { ...process.env };
  if (trusted) {
    environment.SSL_CERT_FILE = join(process.env.RC12_TLS_HOME, "ca.pem");
    environment.SSL_CERT_DIR = "/nonexistent-isolated-relay-certs";
  } else {
    delete environment.SSL_CERT_FILE;
    delete environment.SSL_CERT_DIR;
  }
  const child = spawn(
    process.env.AREAL_REMOTE_RUST_RELAY_BINARY ??
      fileURLToPath(
        new URL("../../../target/debug/examples/remote-relay-fixture", import.meta.url),
      ),
    [],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    },
  );
  const events = [],
    resources = { pid: child.pid, exited: false };
  nativeResources.push(resources);
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const done = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      Object.assign(resources, { exited: true, code, signal });
      resolve();
    }),
  );
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (line) =>
    events.push({ ...JSON.parse(line), at: performance.now() }),
  );
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const fixture = {
    child,
    events,
    resources,
    send,
    stderr: () => stderr,
    async event(predicate, after = 0, timeout = 10000) {
      return waitFor(() => {
        const found = events.slice(after).find(predicate);
        if (found) return found;
        if (resources.exited)
          throw new Error(`native Relay fixture exited ${JSON.stringify(resources)} ${stderr}`);
      }, timeout);
    },
    async stop() {
      if (!resources.exited) {
        send({ op: "stop" });
        child.stdin.end();
      }
      await Promise.race([
        done,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("native Relay stop deadline"));
          }, 3000);
          timer.unref();
          done.then(() => clearTimeout(timer));
        }),
      ]);
    },
  };
  t.after(() => fixture.stop());
  send(config);
  return fixture;
}

// 只观察实际 TLS 解密后的 WebSocket 传输，不替换 Relay 服务的限额判断。
export async function observedRelay(t, relay, certificate = "server.pem") {
  const backend = JSON.parse(await readFile(relay.config, "utf8")).listen;
  const backendPort = Number(backend.split(":").at(-1));
  const frames = [],
    sockets = new Set();
  let sequence = 0;
  const server = createServer(
    {
      key: await readFile(join(process.env.RC12_TLS_HOME, "server.key")),
      cert: await readFile(join(process.env.RC12_TLS_HOME, certificate)),
    },
    (socket) => {
      const upstream = connect(backendPort, "127.0.0.1");
      const connection = ++sequence;
      let buffer = Buffer.alloc(0),
        upgraded = false;
      sockets.add(socket);
      sockets.add(upstream);
      upstream.pipe(socket);
      socket.on("data", (chunk) => {
        if (!upgraded) {
          buffer = Buffer.concat([buffer, chunk]);
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const header = buffer
            .subarray(0, end + 4)
            .toString()
            .replace(/^host:.*$/im, `Host: ${new URL(relay.origin).host}`);
          upstream.write(header);
          chunk = buffer.subarray(end + 4);
          buffer = Buffer.alloc(0);
          upgraded = true;
        }
        upstream.write(chunk);
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) break;
          const opcode = buffer[0] & 15,
            masked = Boolean(buffer[1] & 128);
          let length = buffer[1] & 127,
            header = 2;
          if (length === 126) {
            if (buffer.length < 4) break;
            length = buffer.readUInt16BE(2);
            header = 4;
          } else if (length === 127) {
            if (buffer.length < 10) break;
            length = Number(buffer.readBigUInt64BE(2));
            header = 10;
          }
          if (buffer.length < header + (masked ? 4 : 0) + length) break;
          const mask = masked ? buffer.subarray(header, header + 4) : null;
          if (masked) header += 4;
          const payload = Buffer.from(buffer.subarray(header, header + length));
          if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          let message;
          if (opcode === 1) message = JSON.parse(payload.toString());
          frames.push({
            at: performance.now(),
            connection,
            opcode,
            bytes: length,
            type: message?.type ?? message?.role,
            channel: message?.channel,
          });
          buffer = buffer.subarray(header + length);
        }
      });
      for (const value of [socket, upstream]) {
        value.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
        value.on("close", () => {
          sockets.delete(value);
          socket.destroy();
          upstream.destroy();
        });
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const resources = { port: server.address().port, closed: false };
  observerResources.push(resources);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    resources.closed = true;
  });
  return { url: `wss://127.0.0.1:${resources.port}/remote/socket`, frames, resources };
}

export function rollingWindows(frames) {
  let maxFrames = 0,
    maxBytes = 0;
  for (const frame of frames) {
    const window = frames.filter(
      (value) =>
        value.connection === frame.connection && value.at >= frame.at && value.at - frame.at < 1000,
    );
    maxFrames = Math.max(maxFrames, window.length);
    maxBytes = Math.max(
      maxBytes,
      window.reduce((sum, value) => sum + value.bytes, 0),
    );
  }
  return { maxFrames, maxBytes };
}
