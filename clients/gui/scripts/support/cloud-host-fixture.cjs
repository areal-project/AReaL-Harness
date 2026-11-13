"use strict";
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { WebSocket } = createRequire(resolve(__dirname, "../../app/package.json"))("ws");

/**
 * 测试用 Host：把 cloud.attach / core.request 接到夹具的原生 WebSocket app-server。
 * 远端拨号在 Rust Host 里，这里只为驱动仍在工作台后台的 Cloud 投影逻辑。
 */
function cloudHost() {
  /** @type {Map<string,import('@areal/workbench-service/host-core-client').HostCoreClient>} */
  const clients = new Map();
  const attachments = new Map();
  const owner = (lease) => [...clients.values()].find((client) => client.owns(lease));
  const call = (attachment, method, params) =>
    new Promise((done, fail) => {
      const id = ++attachment.nextId;
      attachment.pending.set(id, { done, fail });
      attachment.socket.send(JSON.stringify({ id, method, params }));
    });
  async function host(method, params) {
    if (method === "cloud.attach") {
      const socket = new WebSocket(params.baseURL, {
        headers: { Authorization: `Bearer ${params.token}` },
      });
      const lease = randomUUID();
      const attachment = { socket, pending: new Map(), nextId: 0, sequence: 0 };
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        const pending = frame.id === undefined ? undefined : attachment.pending.get(frame.id);
        if (pending) {
          attachment.pending.delete(frame.id);
          // 回执带上它到达时的事件序号，之后到的通知由投影按序补发。
          pending.done({ ...frame, sequence: attachment.sequence });
        } else if (typeof frame.method === "string")
          owner(lease)?.event({ ...frame, lease, sequence: ++attachment.sequence });
      });
      socket.on("close", () => {
        for (const pending of attachment.pending.values())
          pending.fail(Object.assign(new Error("Cloud closed"), { code: "DISCONNECTED" }));
        attachment.pending.clear();
        owner(lease)?.event({ lease, method: "host/connectionClosed" });
      });
      await new Promise((done, fail) => socket.once("open", done).once("error", fail));
      await call(attachment, "initialize", {});
      const { result: capabilities } = await call(attachment, "areal/capabilities", {});
      attachments.set(lease, attachment);
      return {
        lease,
        coreInstanceId: "cloud",
        coreGeneration: lease,
        connectionId: lease,
        projectId: "cloud",
        capabilities,
      };
    }
    const attachment = attachments.get(params.lease);
    if (!attachment) throw Object.assign(new Error("Cloud lease closed"), { code: "DISCONNECTED" });
    if (method === "core.detach") {
      attachments.delete(params.lease);
      attachment.socket.close();
      return {};
    }
    if (method !== "core.request" && method !== "execution.submit")
      throw new Error(`unexpected Host method ${method}`);
    return call(attachment, params.method, params.params);
  }
  return { host, sourceId: "cloud-fixture", clients };
}

module.exports = { cloudHost };
