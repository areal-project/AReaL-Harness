import { RemoteConnection } from "@areal/remote-client";
import { record } from "./bootstrap.js";
import type { HostClientOptions, ReadTransport } from "./index.js";
export function createNoiseReadTransport(options: {
  socket(): Promise<WebSocket>;
  identity: unknown;
  host: string;
  room?: string;
  hello?: Record<string, unknown>;
  onHandshake?(phase: string): void;
}): NonNullable<HostClientOptions["transport"]> {
  return async (lifecycle) => {
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
      hello: { ...options.hello, capabilities: ["gui-read-v1"] },
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
        close,
      };
      return {
        transport,
        identity: {
          hostId: ready.authorityHostId,
          hostGeneration: ready.hostGeneration,
          connectionId: ready.connectionId,
          gatewayGeneration: ready.gatewayGeneration,
        },
      };
    } catch (error) {
      lifecycle.signal.removeEventListener("abort", close);
      close();
      throw error;
    }
  };
}
