import { parseCoreCapabilities } from "./capabilities.js";
import {
  MAX_RESPONSE_BYTES,
  CoreRpcError,
  requestFailure,
  responseTooLarge,
  requestIdentity,
} from "./errors.js";
export { MAX_RESPONSE_BYTES, CoreRpcError } from "./errors.js";

export class CoreClient {
  constructor({ createSocket, timeoutMs = 30_000, onServerRequest }) {
    this.createSocket = createSocket;
    this.onServerRequest = onServerRequest;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.catalogReads = new Map();
    this.serverRequests = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.nextId = 0;
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.closeFailure = null;
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async connect() {
    if (this.socket)
      throw new Error("Core client already connected; create a new client to reconnect");
    const socket = (this.socket = this.createSocket());
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CoreRpcError("Core connection timed out"));
        socket.close();
      }, this.timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new CoreRpcError("Core connection failed"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new CoreRpcError("Core connection closed before initialization"));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", (event) => {
      if (event.code === 1009 && event.reason === "RESPONSE_TOO_LARGE")
        this.closeFailure = responseTooLarge();
      this.disconnected();
    });
    socket.addEventListener("error", (event) => {
      if ((event.error?.code ?? event.code) === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH")
        this.closeFailure = responseTooLarge();
    });
    try {
      await opened;
      await this.request("initialize", {
        clientInfo: { name: "areal-harness-desktop", version: "0.1.0" },
      });
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      this.capabilities = parseCoreCapabilities(
        await this.request("areal/capabilities", { apiVersion: "areal.core.v1" }),
      );
      if (this.closed)
        throw new CoreRpcError("Core disconnected during initialization", { code: "DISCONNECTED" });
      this.ready = true;
      return this.capabilities;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request(
    method,
    params = {},
    { decode, onResult, timeoutMs = this.timeoutMs, maxResponseBytes = MAX_RESPONSE_BYTES } = {},
  ) {
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_RESPONSE_BYTES
    )
      return Promise.reject(new RangeError("Invalid Core response byte budget"));
    const request = requestIdentity(method, params, this.capabilities);
    const effect = request.effect;
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      const readOnly = effect === "read" || effect === "subscription";
      return Promise.reject(
        new CoreRpcError("Core is disconnected", {
          code: "DISCONNECTED",
          method,
          data: {
            outcome: { kind: readOnly ? "noMutation" : "rejected" },
            recovery: { kind: readOnly ? "retryRead" : "none" },
          },
        }),
      );
    }
    const readOnly = effect === "read" || effect === "subscription";
    // 写前、写后都隔开在途目录读取，写后校验不能加入旧快照。
    if (!readOnly) this.catalogReads.clear();
    const catalogKey =
      effect === "read" &&
      ["areal/plugin/list", "areal/plugin/mcp/list"].includes(method) &&
      Object.keys(params).length === 0 &&
      decode === undefined &&
      onResult === undefined
        ? JSON.stringify([method, timeoutMs, maxResponseBytes])
        : null;
    if (catalogKey && this.catalogReads.has(catalogKey)) return this.catalogReads.get(catalogKey);
    const response = new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(requestFailure("Core response timed out", request, "TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...request,
        decode,
        onResult,
        maxResponseBytes,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          requestFailure("Core request could not be delivered", request, "DISCONNECTED", { cause }),
        );
      }
    });
    if (!readOnly) return response.finally(() => this.catalogReads.clear());
    if (!catalogKey) return response;
    const shared = response.finally(() => {
      if (this.catalogReads.get(catalogKey) === shared) this.catalogReads.delete(catalogKey);
    });
    this.catalogReads.set(catalogKey, shared);
    return shared;
  }

  receive(bytes) {
    // close 后仍可能收到 socket 缓冲中的包，不能让旧连接再次更新投影。
    if (this.closed) return;
    const text = String(bytes);
    const responseBytes = bytes?.byteLength ?? new TextEncoder().encode(text).byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) {
      this.closeFailure = responseTooLarge();
      this.close();
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.close();
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.close();
      return;
    }
    if (message.method && message.id !== undefined) {
      if (
        ![
          "item/tool/call",
          "areal/browser/prepare",
          "areal/computer/prepare",
          "areal/task/prepare",
          "areal/cua/turnEnded",
        ].includes(message.method) ||
        !this.onServerRequest
      ) {
        this.socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: "Client tool host is not available" },
          }),
        );
        return;
      }
      const socket = this.socket;
      const controller = new AbortController();
      this.serverRequests.set(String(message.id), controller);
      void Promise.resolve()
        .then(() =>
          this.onServerRequest(message.method, message.params, {
            requestId: String(message.id),
            signal: controller.signal,
          }),
        )
        .then(
          (result) => {
            this.serverRequests.delete(String(message.id));
            if (!this.closed && this.socket === socket && socket.readyState === 1)
              socket.send(JSON.stringify({ id: message.id, result }));
          },
          () => {
            this.serverRequests.delete(String(message.id));
            if (!this.closed && this.socket === socket && socket.readyState === 1)
              socket.send(
                JSON.stringify({
                  id: message.id,
                  error: { code: -32603, message: "Client tool host failed" },
                }),
              );
          },
        );
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (responseBytes > entry.maxResponseBytes) {
        entry.reject(
          requestFailure(
            "Core response exceeds the requested byte budget",
            entry,
            "RESPONSE_TOO_LARGE",
            {
              data: {
                reason: "RESPONSE_TOO_LARGE",
                limitBytes: entry.maxResponseBytes,
                retryable: false,
                delivery: "resultUnavailable",
              },
              received: true,
            },
          ),
        );
        return;
      }
      if (message.error) {
        const oversized = message.error.data?.reason === "RESPONSE_TOO_LARGE";
        entry.reject(
          requestFailure(
            message.error.message,
            entry,
            oversized ? "RESPONSE_TOO_LARGE" : message.error.code,
            { data: message.error.data, received: !oversized },
          ),
        );
      } else {
        let result;
        try {
          result = entry.decode ? entry.decode(message.result) : message.result;
        } catch (cause) {
          entry.reject(
            requestFailure(
              "Core response does not match the requested contract",
              entry,
              "RESPONSE_INVALID",
              {
                cause,
                data: {
                  reason: "RESPONSE_INVALID",
                  retryable: false,
                  delivery: "resultUnavailable",
                },
                received: true,
              },
            ),
          );
          return;
        }
        try {
          // 同一 socket 批次可能紧跟增量；解码后的快照必须在消息分派栈内先建立。
          entry.onResult?.(result);
          entry.resolve(result);
        } catch (error) {
          entry.reject(error);
        }
      }
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "areal/tool/cancelled")
        this.serverRequests.get(String(message.params?.requestId))?.abort();
      for (const listener of this.listeners) listener(message.method, message.params);
    }
  }

  disconnected() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        requestFailure(
          this.closeFailure?.message ?? "Core disconnected",
          entry,
          this.closeFailure?.code ?? "DISCONNECTED",
          { data: this.closeFailure?.data },
        ),
      );
    }
    this.pending.clear();
    this.catalogReads.clear();
    for (const controller of this.serverRequests.values()) controller.abort();
    this.serverRequests.clear();
    for (const listener of this.closeListeners)
      listener(
        this.closeFailure ?? new CoreRpcError("Core disconnected", { code: "DISCONNECTED" }),
      );
  }

  close() {
    this.ready = false;
    this.socket?.close();
    this.disconnected();
  }
}
