import { test } from "node:test";
import assert from "node:assert/strict";
import { installHostTransportBarrier } from "./host-transport-barrier.mjs";

class Socket {
  sent = [];
  onmessage = null;
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  reply(frame) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

test("matches request and response identity, holds and releases only the selected response", () => {
  globalThis.WebSocket = Socket;
  installHostTransportBarrier();
  const entry = { response: "hold" };
  const barrier = createHostTransportBarrier((frame) => (frame.method === "save" ? entry : null));
  const socket = new Socket();
  const received = [];
  const handler = (event) => received.push(JSON.parse(event.data));
  socket.onmessage = handler;
  socket.send(JSON.stringify({ id: 1, method: "save" }));
  socket.send(JSON.stringify({ id: 2, method: "other" }));
  socket.reply({ id: 2, result: "other" });
  assert.deepEqual(received, [{ id: 2, result: "other" }]);
  socket.reply({ id: 99, result: "unrelated" });
  assert.equal(entry.responseHit, undefined);
  assert.deepEqual(received.at(-1), { id: 99, result: "unrelated" });
  socket.reply({ id: 1, result: "saved" });
  assert.equal(entry.requestId, 1);
  assert.equal(entry.responseHit, 1);
  assert.equal(received.length, 2);
  entry.releaseResponse();
  assert.deepEqual(received.at(-1), { id: 1, result: "saved" });
  barrier.restore();
  assert.equal(socket.onmessage, handler);
});

test("rejects before send, replaces only a successful matching response, and restores held gates", async () => {
  globalThis.WebSocket = Socket;
  installHostTransportBarrier();
  const rejected = { reject: { code: "DENIED" } };
  const lost = { response: "replace", error: { code: "LOST", submissionUnknown: true } };
  const held = { holdRequest: true };
  const delayed = { response: "hold" };
  const barrier = createHostTransportBarrier(
    (frame) => ({ reject: rejected, lost, held, delayed })[frame.method],
  );
  const socket = new Socket();
  const received = [];
  const handler = (event) => received.push(JSON.parse(event.data));
  socket.onmessage = handler;
  for (const [id, method] of [
    [1, "reject"],
    [2, "lost"],
    [3, "held"],
    [4, "delayed"],
  ])
    socket.send(JSON.stringify({ id, method }));
  await Promise.resolve();
  assert.equal(rejected.rejectHit, 1);
  assert.equal(received[0].error.code, "DENIED");
  assert.deepEqual(
    socket.sent.map((frame) => frame.id),
    [2, 4],
  );
  socket.reply({ id: 2, result: "accepted" });
  assert.equal(lost.responseHit, 2);
  assert.equal(received.at(-1).error.submissionUnknown, true);
  socket.reply({ id: 4, result: "delayed" });
  assert.equal(held.requestHit, 3);
  barrier.restore();
  assert.equal(socket.onmessage, handler);
  assert.deepEqual(
    socket.sent.map((frame) => frame.id),
    [2, 4, 3],
  );
  assert.deepEqual(received.at(-1), { id: 4, result: "delayed" });
  barrier.restore();
  assert.equal(socket.sent.length, 3);
});

test("restore forwards pending replies and does not hide real errors", () => {
  globalThis.WebSocket = Socket;
  installHostTransportBarrier();
  const pending = { response: "replace", error: { code: "LOST" } };
  const barrier = createHostTransportBarrier((frame) => (frame.method === "save" ? pending : null));
  const socket = new Socket();
  const received = [];
  const handler = (event) => received.push(JSON.parse(event.data));
  socket.onmessage = handler;
  socket.send(JSON.stringify({ id: 1, method: "save" }));
  socket.reply({ id: 1, error: { code: "REAL_ERROR" } });
  assert.equal(received.at(-1).error.code, "REAL_ERROR");
  assert.equal(pending.responseHit, undefined);
  socket.send(JSON.stringify({ id: 2, method: "save" }));
  barrier.restore();
  socket.reply({ id: 2, result: "late" });
  assert.deepEqual(received.at(-1), { id: 2, result: "late" });
  assert.equal(socket.onmessage, handler);
});

test("explicit request data replacement reaches the transport with the same id", () => {
  globalThis.WebSocket = Socket;
  installHostTransportBarrier();
  const entry = { data: JSON.stringify({ id: 7, method: "read", params: { path: "changed" } }) };
  const barrier = createHostTransportBarrier((frame) => (frame.id === 7 ? entry : null));
  const socket = new Socket();
  socket.send(JSON.stringify({ id: 7, method: "read", params: { path: "original" } }));
  assert.equal(entry.requestId, 7);
  assert.equal(socket.sent[0].params.path, "changed");
  barrier.restore();
});
