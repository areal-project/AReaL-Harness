import { record } from "./bootstrap.js";
import type { HostClientOptions, ReadConnection, ReadTransport } from "./index.js";

/** 远程连接上 hello 要声明的能力；手机与远程网页用同一份界面时声明写。 */
export function remoteCapabilities(writes?: boolean) {
  return writes ? ["gui-read-v1", "gui-write-v1"] : ["gui-read-v1"];
}

/**
 * 把一条已握手的远程连接包成共享界面的读写通道。远程设备没有单独的写方法表：
 * 方法表即本连接可调的方法，授权由 Host 按设备授权与项目范围判定。
 */
export function remoteReadConnection(
  connection: { request(envelope: Record<string, unknown>): Promise<unknown> },
  ready: unknown,
  options: { writes?: boolean; close(): void },
): ReadConnection {
  if (
    !record(ready) ||
    !Array.isArray(ready.negotiatedCapabilities) ||
    !ready.negotiatedCapabilities.includes("gui-read-v1") ||
    typeof ready.authorityHostId !== "string" ||
    typeof ready.hostGeneration !== "string" ||
    typeof ready.connectionId !== "string" ||
    typeof ready.gatewayGeneration !== "string"
  )
    throw new Error("Host read contract unavailable");
  const gatewayGeneration = ready.gatewayGeneration;
  const grantRevision = ready.grantRevision;
  const writable =
    options.writes === true &&
    ready.negotiatedCapabilities.includes("gui-write-v1") &&
    Array.isArray(ready.methods) &&
    typeof grantRevision === "number" &&
    record(ready.writeLimits);
  const transport: ReadTransport = {
    request: (method, params, context) =>
      connection.request({
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
    ...(writable
      ? {
          write: (method, params, context, commandId) =>
            connection.request({
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
                            gatewayGeneration,
                            grantRevision,
                          }),
                    },
                  }
                : {}),
              ...(commandId ? { commandId } : {}),
            }),
        }
      : {}),
    close: options.close,
  };
  return {
    transport,
    identity: {
      hostId: ready.authorityHostId,
      hostGeneration: ready.hostGeneration,
      connectionId: ready.connectionId,
      gatewayGeneration,
      ...(writable
        ? {
            writeMethods: (ready.methods as unknown[]).filter(
              (method): method is string => typeof method === "string",
            ),
            writeLimits: Object.fromEntries(
              Object.entries(ready.writeLimits as Record<string, unknown>).filter(
                (entry): entry is [string, number] => typeof entry[1] === "number",
              ),
            ),
          }
        : {}),
    },
  };
}

export function createNoiseReadTransport(options: {
  socket(): Promise<WebSocket>;
  identity: unknown;
  host: string;
  room?: string;
  hello?: Record<string, unknown>;
  writes?: boolean;
  onHandshake?(phase: string): void;
}): NonNullable<HostClientOptions["transport"]> {
  return async (lifecycle) => {
    const { RemoteConnection } = await import("@areal/remote-client");
    if (!lifecycle.current()) throw new Error("Connection cancelled");
    const socket = await options.socket();
    if (!lifecycle.current()) {
      socket.close();
      throw new Error("Connection cancelled");
    }
    const close = () => socket.close();
    lifecycle.signal.addEventListener("abort", close, { once: true });
    const connection = new RemoteConnection({
      socket,
      identity: options.identity,
      host: options.host,
      room: options.room ?? null,
      hello: { ...options.hello, capabilities: remoteCapabilities(options.writes) },
      isCurrent: lifecycle.current,
      onClose: () => {
        lifecycle.signal.removeEventListener("abort", close);
        lifecycle.onClose();
      },
    });
    try {
      const ready: unknown = await connection.connect({
        onHandshake: options.onHandshake ?? (() => {}),
        onReady: () => {},
        onSession: lifecycle.onEvent,
      });
      return remoteReadConnection(connection, ready, { writes: options.writes, close });
    } catch (error) {
      lifecycle.signal.removeEventListener("abort", close);
      close();
      throw error;
    }
  };
}
