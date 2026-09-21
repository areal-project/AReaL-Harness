// 直接消费公开 WebSocket 协议；没有产品 SDK 或第二套 Agent loop。
import WebSocket from "ws";
import Ajv from "ajv/dist/2020.js";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

const schema = JSON.parse(
  await readFile(new URL("../../schemas/areal-core-v1.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map(
  Object.entries(schema.requests).map(([method, s]) => [method, ajv.compile(s)]),
);
const responses = new Map(Object.entries(schema.responses).map(([m, s]) => [m, ajv.compile(s)]));
const notifications = new Map(
  Object.entries(schema.notifications).map(([m, s]) => [m, ajv.compile(s)]),
);
const serverRequests = new Map(
  Object.entries(schema.serverRequests).map(([m, s]) => [m, ajv.compile(s)]),
);
const serverResponses = new Map(
  Object.entries(schema.serverResponses).map(([m, s]) => [m, ajv.compile(s)]),
);
function check(registry, method, value, kind) {
  const validate = registry.get(method);
  if (!validate) throw Error(`Missing ${kind} schema: ${method}`);
  if (!validate(value)) throw Error(`${kind} schema ${method}: ${JSON.stringify(validate.errors)}`);
  if (kind === "Response" && method === "areal/capabilities") {
    for (const name of value.methods)
      if (!validators.has(name) || !responses.has(name))
        throw Error(`Advertised method lacks schema: ${name}`);
    for (const name of value.notifications)
      if (!notifications.has(name)) throw Error(`Advertised notification lacks schema: ${name}`);
    for (const name of value.serverRequests)
      if (!serverRequests.has(name) || !serverResponses.has(name))
        throw Error(`Advertised server request lacks schema: ${name}`);
  }
}
export async function connect(endpoint, authFile, onTool) {
  const config = JSON.parse(await readFile(authFile, "utf8"));
  const token = config.principals[0].token;
  const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  const pending = new Map();
  const events = [];
  let next = 0;
  let failure;
  socket.on("message", async (bytes) => {
    const value = JSON.parse(bytes.toString());
    if (value.id !== undefined && value.method) {
      try {
        check(serverRequests, value.method, value.params, "Server request");
        if (!onTool) throw Error(`No tool host for ${value.method}`);
        const result = await onTool(value.params, { endpoint, token });
        check(serverResponses, value.method, result, "Server response");
        socket.send(JSON.stringify({ id: value.id, result }));
      } catch (error) {
        socket.send(
          JSON.stringify({ id: value.id, error: { code: -32000, message: error.message } }),
        );
      }
    } else if (value.id !== undefined) {
      const entry = pending.get(value.id);
      if (!entry) return;
      pending.delete(value.id);
      clearTimeout(entry.timer);
      if (value.error) entry.reject(Object.assign(Error(value.error.message), value.error));
      else {
        try {
          check(responses, entry.method, value.result, "Response");
          entry.resolve(value.result);
        } catch (error) {
          entry.reject(error);
        }
      }
    } else {
      try {
        check(notifications, value.method, value.params, "Notification");
      } catch (error) {
        failure = error;
        socket.close();
        return;
      }
      if (events.length >= 4096) {
        socket.close();
        return;
      }
      events.push(value);
    }
  });
  socket.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure ?? Error("connection closed; query accepted requests before retrying"));
    }
    pending.clear();
  });
  await once(socket, "open");
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      try {
        check(validators, method, params, "Request");
      } catch (error) {
        reject(error);
        return;
      }
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`RPC timeout: ${method}; acceptance may be unknown`));
      }, 20000);
      pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call("initialize", { clientInfo: { name: "desktop-api-example", version: "1" } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  return {
    call,
    events,
    socket,
    token,
    async close() {
      if (failure) throw failure;
      if (socket.readyState === WebSocket.CLOSED) return;
      const done = once(socket, "close");
      socket.close();
      await done;
    },
    async waitEvent(method, predicate = () => true) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const index = events.findIndex((e) => e.method === method && predicate(e.params));
        if (index >= 0) return events.splice(index, 1)[0].params;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error(`event timeout: ${method}`);
    },
  };
}
