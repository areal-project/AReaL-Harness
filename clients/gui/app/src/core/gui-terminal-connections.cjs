// @ts-check
"use strict";
const WebSocket = require("ws");
const METHODS = new Set([
  "areal/process/start",
  "areal/process/list",
  "areal/process/get",
  "areal/process/read",
  "areal/process/write",
  "areal/process/resize",
  "areal/process/closeStdin",
  "areal/process/terminate",
  "areal/process/wait",
  "areal/request/read",
]);
/** @typedef {{projectId:string,serviceId:string,generation:string,endpoint:string,token:string,method:string,params:Record<string,unknown>}} TerminalRequest */
/** @param {unknown} value @returns {value is TerminalRequest} */
function terminalRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = /** @type {Record<string,unknown>} */ (value);
  if (
    !["projectId", "serviceId", "generation", "endpoint", "token", "method"].every(
      (key) => typeof request[key] === "string" && request[key],
    )
  )
    return false;
  if (
    !METHODS.has(String(request.method)) ||
    !request.params ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  )
    return false;
  if (!URL.canParse(String(request.endpoint))) return false;
  const url = new URL(String(request.endpoint));
  return url.protocol === "ws:" && url.hostname === "127.0.0.1" && !url.username && !url.password;
}
class GuiTerminalConnections {
  constructor() {
    /** @type {Map<string,{key:string,client:import('@areal/runtime-client/core').CoreClient,ready:Promise<unknown>}>} */
    this.connections = new Map();
    this.closed = false;
  }
  /** @param {unknown} value */
  async request(value) {
    if (!terminalRequest(value) || this.closed)
      throw new Error("GUI terminal connection is unavailable");
    const { CoreClient } = await import("@areal/runtime-client/core");
    if (this.closed) throw new Error("GUI terminal connection is unavailable");
    const key = JSON.stringify([value.serviceId, value.generation, value.endpoint, value.token]);
    let entry = this.connections.get(value.projectId);
    if (entry && entry.key !== key) {
      entry.client.close();
      this.connections.delete(value.projectId);
      entry = undefined;
    }
    if (!entry) {
      const client = new CoreClient({
        createSocket: () =>
          new WebSocket(value.endpoint, {
            headers: { Authorization: `Bearer ${value.token}` },
            followRedirects: false,
          }),
      });
      const retire = () => {
        if (this.connections.get(value.projectId)?.client === client)
          this.connections.delete(value.projectId);
      };
      client.onClose(retire);
      const ready = client
        .connect()
        .then(async () => {
          const url = new URL(value.endpoint);
          url.protocol = "http:";
          url.pathname = "/areal/service";
          url.search = "";
          url.hash = "";
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${value.token}` },
            redirect: "error",
            signal: AbortSignal.timeout(2500),
          });
          if (!response.ok) throw new Error("GUI terminal Core identity is unavailable");
          const identity = await response.json();
          if (
            identity?.protocolVersion !== 1 ||
            identity?.serviceId !== value.serviceId ||
            identity?.generation !== value.generation
          )
            throw new Error("GUI terminal Core identity or generation changed");
        })
        .catch((error) => {
          retire();
          client.close();
          throw error;
        });
      entry = { key, client, ready };
      this.connections.set(value.projectId, entry);
    }
    await entry.ready;
    if (this.closed || this.connections.get(value.projectId) !== entry) {
      entry.client.close();
      throw new Error("GUI terminal connection ended during startup");
    }
    if (
      value.method === "areal/process/start" &&
      entry.client.capabilities?.features?.connectionProcesses !== true
    )
      throw Object.assign(new Error("Core does not support connection processes"), {
        submissionUnknown: false,
        outcome: { kind: "rejected" },
        recovery: { kind: "none" },
      });
    if (value.method === "areal/process/start" && value.params.lifetime !== "connection")
      throw Object.assign(new Error("GUI terminal requires connection lifetime"), {
        submissionUnknown: false,
        outcome: { kind: "rejected" },
        recovery: { kind: "none" },
      });
    return entry.client.request(value.method, value.params);
  }
  close() {
    this.closed = true;
    for (const entry of this.connections.values()) entry.client.close();
    this.connections.clear();
  }
}
module.exports = { GuiTerminalConnections, terminalRequest, METHODS };
