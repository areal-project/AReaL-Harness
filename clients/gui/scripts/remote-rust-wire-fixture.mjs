import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { pushable } = await import(
  createRequire(new URL("../packages/remote/package.json", import.meta.url)).resolve("it-pushable")
);

export const fixtureBinary = () =>
  process.env.AREAL_REMOTE_RUST_WIRE_BINARY ??
  fileURLToPath(new URL("../../../target/debug/examples/remote-wire-fixture", import.meta.url));

export function fixtureCall(command) {
  const result = spawnSync(fixtureBinary(), [], {
    input: JSON.stringify(command) + "\n",
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const response = JSON.parse(result.stdout.trim());
  if (result.status !== 0 || response.ok === false)
    throw new Error(response.error ?? "Rust wire fixture failed");
  return response.value ?? response;
}

export function rustWireFixture() {
  accessSync(fixtureBinary(), constants.X_OK);
  const sessions = new Set();
  const exits = [];
  return {
    async secureChannel(wire, identity, hostPeer, limits = {}) {
      const child = spawn(fixtureBinary(), [], { stdio: ["pipe", "pipe", "pipe"] });
      const maxMessageBytes = limits.maxMessageBytes ?? 256 * 1024;
      const maxBufferedBytes = limits.maxBufferedBytes ?? 1024 * 1024;
      const messages = pushable({ objectMode: true });
      const pending = new Map();
      let pendingBytes = 0,
        receiveBytes = 0,
        consumedBytes = 0,
        messageBytes = 0,
        cipherBytes = 0,
        sequence = 0;
      let stopped = false,
        closing = false,
        failure,
        closeTimer,
        stderr = "";
      let resolveReady, rejectReady, resolveDone;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      let output = Promise.resolve();
      const write = (command) => {
        if (stopped || child.stdin.destroyed) return;
        child.stdin.write(JSON.stringify(command) + "\n");
      };
      const abort = (error) => {
        if (stopped) return;
        stopped = true;
        failure = error;
        rejectReady(error ?? new Error("连接已断开"));
        messages.end(error);
        child.kill("SIGTERM");
        wire.close();
      };
      const session = { abort, done };
      sessions.add(session);
      child.stderr.on("data", (bytes) => {
        stderr += bytes.toString();
      });
      child.stdin.on("error", (error) => abort(error));
      child.on("error", abort);
      child.on("close", (code, signal) => {
        clearTimeout(closeTimer);
        output = output.then(() => {
          const error =
            failure ??
            (code === 0 || signal === "SIGTERM"
              ? undefined
              : new Error(stderr || `Rust wire fixture exited ${code}`));
          stopped = true;
          rejectReady(error ?? new Error("连接已断开"));
          messages.end(error);
          wire.close();
          sessions.delete(session);
          exits.push({ pid: child.pid, code, signal });
          resolveDone();
        });
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        const event = JSON.parse(line);
        if (event.event === "bytes") cipherBytes += Buffer.from(event.data, "base64").length;
        output = output
          .then(async () => {
            if (stopped) return;
            if (event.event === "ready") resolveReady(event.peer);
            else if (event.event === "bytes") {
              const bytes = Buffer.from(event.data, "base64");
              if (!wire.stream.stopped) await wire.stream.sink([bytes]);
              cipherBytes -= bytes.length;
            } else if (event.event === "consumed") {
              receiveBytes -= event.total - consumedBytes;
              consumedBytes = event.total;
            } else if (event.event === "sent") {
              pendingBytes -= pending.get(event.id) ?? 0;
              pending.delete(event.id);
            } else if (event.event === "message") {
              const bytes = Buffer.from(event.data, "base64");
              messageBytes += bytes.length;
              if (receiveBytes + messageBytes > 2 * 1024 * 1024)
                throw new Error("连接接收缓冲已满");
              messages.push({
                value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
                size: bytes.length,
              });
            } else if (event.event === "error") throw new Error(event.error);
          })
          .catch(abort);
      });
      write({ op: "init", identity, hostPeer, maxMessageBytes, maxBufferedBytes });
      void (async () => {
        for await (const chunk of wire.stream.source) {
          if (stopped) return;
          const bytes = chunk.subarray();
          receiveBytes += bytes.length;
          if (receiveBytes + messageBytes > 2 * 1024 * 1024) throw new Error("连接接收缓冲已满");
          write({ op: "bytes", data: Buffer.from(bytes).toString("base64") });
        }
        write({ op: "eof" });
      })().catch(abort);
      const peer = await ready;
      return {
        peer,
        done,
        get bufferedBytes() {
          return (
            pendingBytes +
            cipherBytes +
            wire.stream.writeBufferLength +
            wire.stream.pendingWriteBytes
          );
        },
        get receiveBufferedBytes() {
          return receiveBytes + messageBytes + wire.bufferedBytes;
        },
        send(value) {
          if (stopped || closing) throw new Error("连接已断开");
          const bytes = Buffer.from(JSON.stringify(value));
          if (
            bytes.length > maxMessageBytes ||
            this.bufferedBytes + bytes.length > maxBufferedBytes
          ) {
            abort(new Error("数据超过传输上限"));
            throw new Error("数据超过传输上限");
          }
          const id = ++sequence;
          pending.set(id, bytes.length);
          pendingBytes += bytes.length;
          write({ op: "send", id, data: bytes.toString("base64") });
        },
        async *messages() {
          try {
            for await (const message of messages) {
              messageBytes -= message.size;
              yield message.value;
            }
          } finally {
            if (!closing) abort();
          }
        },
        close() {
          if (closing || stopped) return;
          closing = true;
          write({ op: "close" });
          closeTimer = setTimeout(() => abort(new Error("Rust wire close timed out")), 15000);
          closeTimer.unref();
        },
      };
    },
    close() {
      for (const session of sessions) session.abort();
    },
    async drained() {
      await Promise.all([...sessions].map((session) => session.done));
    },
    exits,
  };
}
