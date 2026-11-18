// @ts-check
"use strict";
// 只供仍在迁移的旧桌面夹具使用。
const { createRequire } = require("node:module");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { desktopError } = require("@areal/workbench/desktop-contract");
const WebSocket = createRequire(require.resolve("../../app/package.json"))("ws");
const { PROTOCOL } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const diagnostics = require("@areal/workbench/node/diagnostics");
let diagnosticsConnectionGeneration = 0;
/** @typedef {Record<string,unknown> & {protocol:string,endpoint:string,token:string,identity:string,pid:number}} ServiceMetadata */
/** @typedef {{resolve:(value:unknown)=>void,reject:(error:unknown)=>void,timer:NodeJS.Timeout,mutation:boolean,requestId:unknown}} PendingRequest */
/** @typedef {Record<string,unknown> & {error?:({message:string,[key:string]:unknown})|null|false|0|''}} ServiceFrame */
/** @param {unknown} value @returns {value is ServiceFrame} */
function serviceFrame(value) {
  return (
    record(value) &&
    (value.error === undefined ||
      value.error === null ||
      value.error === false ||
      value.error === 0 ||
      value.error === "" ||
      (record(value.error) && typeof value.error.message === "string"))
  );
}
/** @param {unknown} value @returns {value is Record<string,unknown>&{requestId:number}} */
function browserRequest(value) {
  return (
    record(value) && typeof value.requestId === "number" && Number.isSafeInteger(value.requestId)
  );
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

class ServiceConnection {
  /** @param {(packet:unknown)=>void} [onState] @param {()=>void} [onClose]
   * @param {(value:unknown)=>void} [onNotification] @param {(value:unknown)=>void} [onNotificationOpen]
   * @param {((value:Record<string,unknown>&{requestId:number})=>unknown)|null} [onBrowserRequest]
   * @param {((value:unknown)=>void)|null} [onBrowserCancel] */
  constructor(
    onState = () => {},
    onClose = () => {},
    onNotification = () => {},
    onNotificationOpen = () => {},
    onBrowserRequest = null,
    onBrowserCancel = null,
  ) {
    this.onNotification = onNotification;
    this.onNotificationOpen = onNotificationOpen;
    this.onBrowserRequest = onBrowserRequest;
    this.onBrowserCancel = onBrowserCancel;
    this.onState = onState;
    this.onClose = onClose;
    /** @type {Map<number,PendingRequest>} */
    this.pending = new Map();
    /** @type {import("ws")|undefined} */
    this.socket = undefined;
    this.nextId = 0;
  }
  /** @param {unknown} metadata @returns {Promise<ServiceMetadata>} */
  async connect(metadata) {
    if (!record(metadata) || typeof metadata.endpoint !== "string")
      throw new Error("本地后台服务连接元数据无效");
    const url = new URL(metadata.endpoint);
    if (
      metadata.protocol !== PROTOCOL ||
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      typeof metadata.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.token) ||
      typeof metadata.identity !== "string" ||
      !metadata.identity ||
      typeof metadata.pid !== "number" ||
      !Number.isSafeInteger(metadata.pid) ||
      metadata.pid <= 1
    )
      throw new Error("本地后台服务连接元数据无效");
    const socket = (this.socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${metadata.token}` },
      followRedirects: false,
      maxPayload: 256 * 1024 * 1024,
    }));
    /** @satisfies {import("@areal/workbench/node/diagnostics").SocketTarget} */
    const target = Object.freeze({
      boundary: "main-desktop",
      hostPid: metadata.pid,
      coreGeneration:
        typeof metadata.desktopGeneration === "string" ? metadata.desktopGeneration : undefined,
      connectionGeneration: ++diagnosticsConnectionGeneration,
    });
    socket.on("open", () => diagnostics.record({ type: "socket-open", ...target }));
    socket.on("error", (error) =>
      diagnostics.record({
        type: "socket-error",
        ...target,
        code: "code" in error ? error.code : undefined,
      }),
    );
    socket.on("close", (closeCode) =>
      diagnostics.record({ type: "socket-close", ...target, closeCode }),
    );
    socket.on("message", (bytes) => {
      if (this.socket !== socket) return;
      /** @type {ServiceFrame} */
      let message;
      try {
        /** @type {unknown} */
        const parsed = JSON.parse(bytes.toString());
        if (!serviceFrame(parsed)) throw new Error("Invalid Desktop service frame");
        message = parsed;
      } catch {
        socket.terminate();
        return;
      }
      if (message.method === "notification") {
        this.onNotification(message.params);
        return;
      }
      if (message.method === "notificationOpen") {
        this.onNotificationOpen(message.params);
        return;
      }
      if (message.method === "state") {
        this.onState(message.params);
        return;
      }
      if (message.method === "browserCancel") {
        this.onBrowserCancel?.(message.params);
        return;
      }
      if (message.method === "browserRequest") {
        const request = message.params,
          onBrowserRequest = this.onBrowserRequest;
        if (!onBrowserRequest || !browserRequest(request)) {
          socket.terminate();
          return;
        }
        const requestId = request.requestId;
        void Promise.resolve()
          .then(() => onBrowserRequest(request))
          .then(
            (result) => {
              if (this.socket === socket && socket.readyState === WebSocket.OPEN)
                void this.request("browserResult", { requestId, result }, true).catch(() => {});
            },
            () => {
              if (this.socket === socket && socket.readyState === WebSocket.OPEN)
                void this.request("browserResult", { requestId, error: "host_failed" }, true).catch(
                  () => {},
                );
            },
          );
        return;
      }
      if (typeof message.id !== "number") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error)
        entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.result);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          Object.assign(
            new Error(
              entry.mutation
                ? "后台连接中断，操作结果未确认；请重连后核对任务，不会自动重发。"
                : "后台服务连接已断开",
            ),
            {
              submissionUnknown: entry.mutation,
              code: "DISCONNECTED",
              requestId: entry.requestId,
              recovery: { kind: entry.mutation ? "queryOriginal" : "retryRead" },
            },
          ),
        );
      }
      this.pending.clear();
      this.onClose();
    });
    await new Promise(
      /** @param {(value:void)=>void} resolve */ (resolve, reject) => {
        const fail = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("无法连接本地后台服务"), { code: "DISCONNECTED" }));
        };
        const timer = setTimeout(() => {
          fail();
          socket.terminate();
        }, 2000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", fail);
        socket.once("close", fail);
      },
    );
    return {
      ...metadata,
      protocol: metadata.protocol,
      endpoint: metadata.endpoint,
      token: metadata.token,
      identity: metadata.identity,
      pid: metadata.pid,
    };
  }
  /** @param {string} method @param {Record<string,unknown>} [params] @param {boolean} [mutation] @returns {Promise<unknown>} */
  request(method, params, mutation = false) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        Object.assign(new Error("后台服务已断开，请重新连接"), {
          code: "DISCONNECTED",
          submissionUnknown: false,
          outcome: { kind: mutation ? "rejected" : "noMutation" },
          recovery: { kind: mutation ? "none" : "retryRead" },
        }),
      );
    const id = ++this.nextId;
    const requestId =
      method === "command" && record(params?.request)
        ? (params.request.requestId ?? params.request.draftId)
        : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(
            new Error(
              mutation
                ? "后台请求超时，请核对结果后继续；不会自动重发。"
                : "读取状态超时，请重试。",
            ),
            {
              submissionUnknown: mutation,
              code: "TIMEOUT",
              requestId,
              recovery: { kind: mutation ? "queryOriginal" : "retryRead" },
            },
          ),
        );
      }, 150000);
      this.pending.set(id, { resolve, reject, timer, mutation, requestId });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) socket.terminate();
      });
    });
  }
  close() {
    this.socket?.close();
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} home @param {{desktopGeneration?:unknown,token?:unknown}} metadata */
async function waitForServiceExit(home, metadata) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      /** @type {unknown} */
      const current = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
      if (!record(current)) throw new Error("后台连接元数据无效");
      if (
        metadata.desktopGeneration
          ? current.desktopGeneration !== metadata.desktopGeneration
          : current.token !== metadata.token
      )
        return;
    } catch (error) {
      if (desktopError(error).code === "ENOENT") return;
      throw error;
    }
    await sleep(100);
  }
  throw new Error("旧后台尚未完成退出，请稍后重新连接。未删除任何任务数据。");
}
/** @param {string} home @param {{pid:number,desktopGeneration?:unknown,token?:unknown}} metadata */
async function waitForServiceProcessExit(home, metadata) {
  await waitForServiceExit(home, metadata);
  await require("../../app/src/core/service-client.cjs").waitForProcessExit(metadata.pid);
}
module.exports = { ServiceConnection, waitForServiceExit, waitForServiceProcessExit };
