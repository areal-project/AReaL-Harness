import type { HostStatus, LoopbackHelloParams } from "./protocol.js";
import { readHostBootstrap, record, type HostBootstrap } from "./bootstrap.js";
import type { JsonObject } from "./read-state.js";
import type {
  HostClientOptions,
  HostCommandContext,
  ReadContext,
  ReadConnectionIdentity,
} from "./index.js";

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
      entry.reject(new Error("Host disconnected"));
    }
    pending.clear();
    socket.close();
  };
  const request = (method: string, params: JsonObject, context?: ReadContext) =>
    new Promise<unknown>((resolve, reject) => {
      if (!current() || socket.readyState !== WebSocket.OPEN)
        return reject(new Error("Connection unavailable"));
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Host read timed out"));
        if (method === "session.open") close();
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
        reject(new Error("Host send failed"));
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
        return reject(new Error("Connection unavailable"));
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Host command timed out"));
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
        reject(new Error("Host send failed"));
      }
    });
  signal.addEventListener("abort", close, { once: true });
  const transport = { request, write, close };
  let connected = false;
  let connectionIdentity: ReadConnectionIdentity | undefined;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error("Host connection timed out"));
      close();
    }, 15_000);
    socket.onerror = () => {
      clearTimeout(deadline);
      bootstrap = undefined;
      reject(new Error("Host unavailable"));
    };
    socket.onclose = () => {
      signal.removeEventListener("abort", close);
      clearTimeout(deadline);
      bootstrap = undefined;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Host disconnected"));
      }
      pending.clear();
      reject(new Error("Host disconnected"));
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
        capabilities: options.writes ? ["gui-read-v1", "gui-write-v1"] : ["gui-read-v1"],
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
        if (record(message.error))
          handler.reject(
            Object.assign(
              new Error(String(message.error.message ?? "Host read failed")),
              message.error,
            ),
          );
        else handler.resolve(message.result);
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
