import type { HostStatus, LoopbackHelloParams } from "./protocol.js";
import { readHostBootstrap, record, type HostBootstrap } from "./bootstrap.js";
import type { JsonObject } from "./read-state.js";
import type {
  HostClientOptions,
  HostCommandContext,
  ReadContext,
  ReadConnectionIdentity,
} from "./index.js";

/** Host 只给代码时界面显示的原因；Host 自己写的说明原样显示。 */
const GENERIC_ERRORS = new Set([
  "Host command failed",
  "Host read failed",
  "Host read request failed",
]);
const ERROR_TEXT: Record<string, string> = {
  FORBIDDEN: "没有权限执行此操作。请在桌面应用的手机与网页设置里重新批准这个浏览器。",
  CAPABILITY_UNAVAILABLE: "桌面后台未运行，此功能暂不可用。",
  CORE_UNAVAILABLE: "项目服务暂不可用，请稍后重试。",
  RESYNC_REQUIRED: "状态已变化，请刷新后重试。",
  INVALID_PARAMS: "请求无效，请刷新后重试。",
  LIMIT_EXCEEDED: "内容超过大小限制。",
  COMMAND_CONFLICT: "这个操作与正在进行的操作冲突，请稍后重试。",
  RESOURCE_UNAVAILABLE: "目标已不存在或不可用。",
};

/**
 * 传输层失败带 clientCode 供界面选文案（renderer/src/errors/errorCopy.ts）。
 * 不用 code：带字符串 code 的错误表示 Host 明确拒绝，传输失败是“不知道是否受理”。
 */
const clientError = (clientCode: "DISCONNECTED" | "TIMEOUT", message: string) =>
  Object.assign(new Error(message), { clientCode });

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export async function connectWebSocket(
  options: HostClientOptions,
  current: () => boolean,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
  onClose: () => void,
) {
  let bootstrap: HostBootstrap | undefined = readHostBootstrap(await options.bootstrap());
  if (bootstrap.origin !== options.origin) throw new Error("Host origin mismatch");
  const { hostId, generation } = bootstrap;
  const preferredSourceId =
    "preferredSourceId" in bootstrap && typeof bootstrap.preferredSourceId === "string"
      ? bootstrap.preferredSourceId
      : undefined;
  if (!current()) throw new Error("Connection cancelled");
  const socket = new WebSocket(bootstrap.websocketUrl);
  let sequence = 0;
  const pending = new Map<string, Pending>();
  const close = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(clientError("DISCONNECTED", "Host disconnected"));
    }
    pending.clear();
    socket.close();
  };
  const request = (method: string, params: JsonObject, context?: ReadContext) =>
    new Promise<unknown>((resolve, reject) => {
      if (!current() || socket.readyState !== WebSocket.OPEN)
        return reject(clientError("DISCONNECTED", "Connection unavailable"));
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(clientError("TIMEOUT", "Host read timed out"));
        if (method === "session.open" || method === "session.openPersisted") close();
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            version: 1,
            id,
            method,
            params,
            ...(context
              ? {
                  context: {
                    projectId: context.projectId,
                    serviceGeneration: context.serviceGeneration,
                  },
                }
              : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(clientError("DISCONNECTED", "Host send failed"));
      }
    });
  // 写请求超时不关闭连接、不重发；调用方按 commandId 查回执。
  const write = (
    method: string,
    params: JsonObject,
    context: HostCommandContext | null,
    commandId?: string,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      if (!current() || socket.readyState !== WebSocket.OPEN)
        return reject(clientError("DISCONNECTED", "Connection unavailable"));
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(clientError("TIMEOUT", "Host command timed out"));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            version: 1,
            id,
            method,
            params,
            ...(context
              ? {
                  context: {
                    projectId: context.projectId,
                    ...(method === "project.models"
                      ? {}
                      : {
                          serviceGeneration: context.serviceGeneration,
                          gatewayGeneration: generation,
                          grantRevision: 0,
                        }),
                  },
                }
              : {}),
            ...(commandId ? { commandId } : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(clientError("DISCONNECTED", "Host send failed"));
      }
    });
  signal.addEventListener("abort", close, { once: true });
  const transport = { request, write, close };
  let connected = false;
  let connectionIdentity: ReadConnectionIdentity | undefined;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(clientError("TIMEOUT", "Host connection timed out"));
      close();
    }, 15_000);
    socket.onerror = () => {
      clearTimeout(deadline);
      bootstrap = undefined;
      reject(clientError("DISCONNECTED", "Host unavailable"));
    };
    socket.onclose = () => {
      signal.removeEventListener("abort", close);
      clearTimeout(deadline);
      bootstrap = undefined;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(clientError("DISCONNECTED", "Host disconnected"));
      }
      pending.clear();
      reject(clientError("DISCONNECTED", "Host disconnected"));
      if (connected && current()) onClose();
    };
    socket.onopen = () => {
      if (!current() || !bootstrap) {
        close();
        return;
      }
      const ticket = bootstrap.ticket;
      bootstrap = undefined;
      void request("hello", {
        protocolVersions: [1],
        capabilities: options.writes
          ? ["gui-read-v1", "gui-write-v1", "persistedHistoryV1"]
          : ["gui-read-v1", "persistedHistoryV1"],
        ticket,
        expectedGeneration: generation,
      } satisfies LoopbackHelloParams)
        .then((value) => {
          if (
            !record(value) ||
            value.hostId !== hostId ||
            value.generation !== generation ||
            !Array.isArray(value.negotiatedCapabilities) ||
            !value.negotiatedCapabilities.includes("gui-read-v1")
          )
            throw new Error("Host read contract unavailable");
          if (typeof value.connectionId !== "string" || value.gatewayGeneration !== generation)
            throw new Error("Invalid Host connection identity");
          const writable =
            options.writes === true &&
            value.negotiatedCapabilities.includes("gui-write-v1") &&
            Array.isArray(value.writeMethods) &&
            record(value.writeLimits);
          connectionIdentity = {
            hostId,
            hostGeneration: generation,
            connectionId: value.connectionId,
            gatewayGeneration: generation,
            preferredSourceId,
            persistedHistory: value.negotiatedCapabilities.includes("persistedHistoryV1"),
            ...(writable
              ? {
                  writeMethods: (value.writeMethods as unknown[]).filter(
                    (method): method is string => typeof method === "string",
                  ),
                  writeLimits: Object.fromEntries(
                    Object.entries(value.writeLimits as JsonObject).filter(
                      (entry): entry is [string, number] => typeof entry[1] === "number",
                    ),
                  ),
                }
              : {}),
          };
          clearTimeout(deadline);
          resolve();
        })
        .catch((error) => {
          clearTimeout(deadline);
          reject(error);
          close();
        });
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      try {
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).length > 2 * 1024 * 1024
        )
          throw new Error("Invalid Host frame");
        const message: unknown = JSON.parse(event.data);
        if (!record(message) || message.version !== 1) throw new Error("Invalid Host envelope");
        if (typeof message.method === "string") {
          onEvent(message.params);
          return;
        }
        const handler = pending.get(String(message.id));
        if (!handler) return;
        pending.delete(String(message.id));
        clearTimeout(handler.timer);
        if (record(message.error)) {
          const generic = message.error.message;
          const text =
            typeof generic === "string" && generic && !GENERIC_ERRORS.has(generic)
              ? generic
              : (ERROR_TEXT[String(message.error.code)] ?? "Host 操作失败");
          handler.reject(Object.assign(new Error(text), message.error, { message: text }));
        } else handler.resolve(message.result);
      } catch {
        close();
      }
    };
  });
  try {
    const result = await request("host.status", {});
    if (!record(result) || result.hostId !== hostId || result.generation !== generation)
      throw new Error("Host identity changed");
    const status = readStatus(result);
    connected = true;
    if (!connectionIdentity) throw new Error("Missing Host connection identity");
    return { transport, status, identity: connectionIdentity };
  } catch (error) {
    close();
    throw error;
  }
}
function readStatus(value: JsonObject): HostStatus {
  if (
    typeof value.state !== "string" ||
    typeof value.restartPending !== "boolean" ||
    typeof value.stopIntent !== "boolean" ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((v) => typeof v === "string") ||
    !Array.isArray(value.projects)
  )
    throw new Error("Invalid Host status");
  for (const project of value.projects)
    if (
      !record(project) ||
      typeof project.state !== "string" ||
      !record(project.registration) ||
      typeof project.registration.projectId !== "string"
    )
      throw new Error("Invalid Host project status");
  return value as unknown as HostStatus;
}
