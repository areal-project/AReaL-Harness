import { HostClient } from "@areal/client/node";
import type { HostCoreClient } from "./host-core-client";
type Fields = Record<string, unknown>;
const record = (value: unknown): value is Fields =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Main领域回退仍在原宿主执行；Core请求、事件与工具回调都绑定原Host附件。 */
export async function createNativeHostTransport(
  backend: {
    host: { sourceId: string; home: string };
    hostCoreClients: Map<string, HostCoreClient>;
  },
  options: unknown,
) {
  const events = new HostClient({ desktopCore: true }),
    calls = new HostClient({ desktopCore: true }),
    replies = new HostClient({ desktopCore: true });
  let attachment = "",
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const client of backend.hostCoreClients.values()) client.close(false);
    events.close();
    calls.close();
    replies.close();
  };
  try {
    await Promise.all([
      events.connect(backend.host.home),
      calls.connect(backend.host.home),
      replies.connect(backend.host.home),
    ]);
    events.desktopCoreClosed = close;
    calls.desktopCoreClosed = close;
    replies.desktopCoreClosed = close;
    events.desktopCoreEvent = (value: unknown) => {
      if (!record(value) || value.attachmentId !== attachment || !record(value.event)) {
        close();
        return;
      }
      const event = value.event;
      if (event.event === "core.event") {
        for (const client of backend.hostCoreClients.values()) client.event(event);
      } else if (event.event === "core.callback" && typeof event.requestId === "string") {
        const client = [...backend.hostCoreClients.values()].find((client) =>
          client.owns(event.lease),
        );
        const reply = client
          ? client.callback({ ...event, requestId: event.coreRequestId })
          : Promise.reject(new Error("Original desktop owner unavailable"));
        void reply
          .then(
            (result) =>
              replies.request("desktop.core.callback", {
                attachmentId: attachment,
                requestId: event.requestId,
                result,
              }),
            () =>
              replies.request("desktop.core.callback", {
                attachmentId: attachment,
                requestId: event.requestId,
                error: { message: "Desktop tool unavailable" },
              }),
          )
          .catch(close);
      } else close();
    };
    const result: unknown = await events.request("desktop.core.subscribe", {
      sourceId: backend.host.sourceId,
      options,
    });
    if (!record(result) || typeof result.attachmentId !== "string")
      throw new Error("Invalid native desktop attachment");
    attachment = result.attachmentId;
    return {
      call: (call: string, params: unknown) => {
        if (closed) return Promise.reject(new Error("Native desktop attachment disconnected"));
        return calls.request("desktop.core.call", { attachmentId: attachment, call, params });
      },
      close,
      get closed() {
        return closed;
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** 只连接既有Host，退出前撤销原GUI来源的终端连接。 */
export async function closeGuiHostTerminals(options: Fields) {
  if (
    typeof options.hostHome !== "string" ||
    typeof options.guiProfile !== "string" ||
    typeof options.home !== "string" ||
    typeof options.harnessHome !== "string"
  )
    return;
  const client = new HostClient();
  try {
    await client.connect(options.hostHome);
    const state: unknown = await client.sourceState({
      profile: options.guiProfile,
      coreHome: options.home,
      legacyServiceHome: options.harnessHome,
    });
    if (record(state) && typeof state.sourceId === "string")
      await client.request("desktop.core.terminals.close", { sourceId: state.sourceId });
  } finally {
    client.close();
  }
}

/** 原生外壳只持有停止前的Host终端撤销句柄，不创建Core连接池。 */
export class NativeTerminalOwners {
  closed = false;
  static forOwner(owner: { options: Fields; home: string }) {
    return new NativeTerminalOwners({ options: () => ({ ...owner.options, home: owner.home }) });
  }
  constructor(private options: { options: () => Fields; backend?: () => unknown }) {}
  close() {
    this.closed = true;
    void closeGuiHostTerminals(this.options.options()).catch(() => {});
  }
}
