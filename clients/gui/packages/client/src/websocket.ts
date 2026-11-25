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
  CORE_UNAVAILABLE: "项目暂时没有响应。你的内容已保留，请稍后重试。",
  CORE_CONNECTION_TIMEOUT: "等待项目连接超时，你的内容已保留，请稍后重试。",
  CORE_EXPLICITLY_STOPPED: "项目已手动停止，请先恢复项目后再继续。",
  CORE_INCOMPATIBLE: "项目需要更新后才能继续使用，请重新打开应用完成更新。",
  CLOUD_NOT_CONFIGURED: "尚未配置云端地址或令牌，请先前往 Cloud 设置完成配置。",
  CLOUD_AUTH_REJECTED: "云端凭据验证未通过，请检查 Cloud 设置中的地址与令牌。",
  CLOUD_SANDBOX_EXPIRED: "云端沙箱已过期或不存在，请新建云端会话。",
  CLOUD_GATEWAY_UNAVAILABLE: "云端服务暂时不可达，请检查网络后重试。",
  CLOUD_HANDSHAKE_TIMEOUT: "连接云端沙箱超时，请稍后重试。",
  CLOUD_DISCONNECTED: "云端会话尚未连接，请重新连接以读取远端历史。",
  CLOUD_CONNECTION_CLOSED: "云端连接已断开，请重新连接。",
  CLOUD_UNSUPPORTED_SESSION: "此旧版云端会话需使用原客户端打开。",
  RESYNC_REQUIRED: "状态已变化，请刷新后重试。",
  INVALID_PARAMS: "请求无效，请刷新后重试。",
  LIMIT_EXCEEDED: "内容超过大小限制。",
  COMMAND_CONFLICT: "这个操作与正在进行的操作冲突，请稍后重试。",
  RESOURCE_UNAVAILABLE: "目标已不存在或不可用。",
  RESOURCE_BUSY: "会话正在切换读取方式，请重新读取。",
  PERSISTED_HISTORY_UNAVAILABLE: "保存的历史暂不可读，请恢复项目后重新读取。",
};

/**
 * 传输层失败带 clientCode 供界面选文案（renderer/src/errors/errorCopy.ts）。
 * 不用 code：带字符串 code 的错误表示 Host 明确拒绝，传输失败是“不知道是否受理”。
 */
const clientError = (clientCode: "DISCONNECTED" | "TIMEOUT", message: string) =>
  Object.assign(new Error(message), { clientCode });

type Pending = {
  method: string;
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
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
) {
  let bootstrap: HostBootstrap | undefined = readHostBootstrap(await options.bootstrap());
  if (bootstrap.origin !== options.origin) throw new Error("Host origin mismatch");
  const { hostId, generation } = bootstrap;
  const preferredSourceId =
    "preferredSourceId" in bootstrap && typeof bootstrap.preferredSourceId === "string"
      ? bootstrap.preferredSourceId
      : undefined;
  if (!current()) throw new Error("Connection cancelled");
  const socket = createSocket(bootstrap.websocketUrl);
  let sequence = 0;
  const pending = new Map<string, Pending>();
  const timedOutOpens = new Map<string, ReadContext | undefined>();
  const close = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(clientError("DISCONNECTED", "Host disconnected"));
    }
    pending.clear();
    timedOutOpens.clear();
    socket.close();
  };
  const request = (method: string, params: JsonObject, context?: ReadContext) =>
    new Promise<unknown>((resolve, reject) => {
      if (!current() || socket.readyState !== WebSocket.OPEN)
        return reject(clientError("DISCONNECTED", "Connection unavailable"));
      const id = String(++sequence);
      // 与 Host 端到端预算对齐（Cloud 135s < 150s，本地 25s < 35s），
      // 且单次会话读取超时绝不拆毁整条 Host WebSocket；若迟到回复携带 subscriptionId 则主动关闭释放配额。
      const isSessionOpen = method === "session.open" || method === "session.openPersisted";
      const isCloudRead =
        method === "session.open" &&
        typeof context?.projectId === "string" &&
        context.projectId.startsWith("cloud-session:");
      const timeoutMs = isCloudRead ? 150_000 : isSessionOpen ? 35_000 : 15_000;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (isSessionOpen) {
          if (timedOutOpens.size >= 32) {
            const oldest = timedOutOpens.keys().next().value;
            if (oldest !== undefined) timedOutOpens.delete(oldest);
          }
          timedOutOpens.set(id, context);
        }
        reject(clientError("TIMEOUT", "Host read timed out"));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
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
                    ...(context.serviceGeneration
                      ? { serviceGeneration: context.serviceGeneration }
                      : {}),
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
      // Cloud 沙箱首次启动或休眠唤醒耗时较长，project.activate 与 cloudSession 共用 150s 预算。
      const isCloudWrite =
        (method === "desktop.command" && params.command === "cloudSession") ||
        (method === "project.activate" &&
          typeof context?.projectId === "string" &&
          context.projectId.startsWith("cloud-session:"));
      const timeoutMs = isCloudWrite ? 150_000 : 30_000;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(clientError("TIMEOUT", "Host command timed out"));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
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
                    ...(["project.models", "project.activate"].includes(method)
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
          ? ["gui-read-v1", "gui-write-v1", "persistedHistoryV1", "sessionOpenAutoV1"]
          : ["gui-read-v1", "persistedHistoryV1", "sessionOpenAutoV1"],
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
            sessionOpenAuto: value.negotiatedCapabilities.includes("sessionOpenAutoV1"),
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
        const messageId = String(message.id);
        const handler = pending.get(messageId);
        if (!handler) {
          if (timedOutOpens.has(messageId)) {
            const timedOutContext = timedOutOpens.get(messageId);
            timedOutOpens.delete(messageId);
            if (
              record(message.result) &&
              typeof message.result.subscriptionId === "string" &&
              message.result.subscriptionId &&
              timedOutContext?.projectId
            ) {
              void request(
                "subscription.close",
                { subscriptionId: message.result.subscriptionId },
                {
                  projectId: timedOutContext.projectId,
                  ...(typeof message.result.serviceGeneration === "string"
                    ? { serviceGeneration: message.result.serviceGeneration }
                    : {}),
                },
              ).catch(() => {});
            }
          }
          return;
        }
        pending.delete(messageId);
        clearTimeout(handler.timer);
        if (record(message.error)) {
          const generic = message.error.message;
          const summary =
            typeof generic === "string" && generic && !GENERIC_ERRORS.has(generic)
              ? generic
              : (ERROR_TEXT[String(message.error.code)] ?? "Host 操作失败");
          // message 只作原文和详情；上屏按 code 取文案（renderer 的 errors/errorCopy.ts）。
          // 被拒的方法和 Host 给的排队原因放进详情，用户不必再猜是哪里满了。
          const method = "method" in message.error ? message.error.method : handler.method;
          const reason = "reason" in message.error ? message.error.reason : undefined;
          const stage = "stage" in message.error ? message.error.stage : undefined;
          const rawDetail = "detail" in message.error ? message.error.detail : undefined;
          const diagnosticId =
            "diagnosticId" in message.error ? message.error.diagnosticId : undefined;
          const code = typeof message.error.code === "string" ? message.error.code : undefined;
          const detail = [
            summary,
            code,
            typeof stage === "string" ? stage : "",
            typeof method === "string" ? method : "",
            typeof reason === "string" ? reason : "",
            typeof rawDetail === "string" ? rawDetail : "",
            typeof diagnosticId === "string" ? `#${diagnosticId}` : "",
          ]
            .filter((part): part is string => typeof part === "string" && part !== "")
            .join(" · ");
          handler.reject(
            Object.assign(new Error(summary), message.error, { message: summary, detail }),
          );
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
