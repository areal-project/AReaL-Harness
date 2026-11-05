import { remoteReadConnection, type HostClientOptions } from "@areal/client";

/** 手机与远程网页已有的配对连接：配对、记住设备、前后台与撤销仍由它们自己管。 */
export type PairedConnection = {
  snapshot(): { kind: string };
  subscribe(listener: () => void): () => void;
  connection: { ready?: unknown } | null | undefined;
  onSession: (message: unknown) => void;
  request(envelope: Record<string, unknown>): Promise<unknown>;
};

/**
 * 共享界面借用已配对的远程连接：HostClient 只在连接就绪时接上，
 * 断开后等原页面重连再接，不另开连接、不重放写。
 */
export function pairedTransport(
  client: PairedConnection,
): NonNullable<HostClientOptions["transport"]> {
  return (lifecycle) =>
    new Promise((resolve, reject) => {
      const attach = () => {
        const state = client.snapshot();
        const connection = client.connection;
        if (state.kind !== "connected" || !connection) return false;
        let closed = false;
        const stop = client.subscribe(() => {
          if (client.connection === connection && client.snapshot().kind === "connected") return;
          stop();
          if (closed) return;
          closed = true;
          lifecycle.onClose();
        });
        client.onSession = (message: unknown) => {
          if (!closed) lifecycle.onEvent(message);
        };
        try {
          resolve(
            remoteReadConnection(
              { request: (envelope) => client.request(envelope) },
              connection.ready,
              {
                writes: true,
                close: () => {
                  closed = true;
                  stop();
                },
              },
            ),
          );
        } catch (error) {
          closed = true;
          stop();
          reject(error);
        }
        return true;
      };
      if (attach()) return;
      const wait = client.subscribe(() => {
        if (lifecycle.current() && attach()) wait();
      });
      lifecycle.signal.addEventListener(
        "abort",
        () => {
          wait();
          reject(new Error("Connection cancelled"));
        },
        { once: true },
      );
    });
}
