import { HostClient } from "@areal/client/node";
type Fields = Record<string, unknown>;
const record = (value: unknown): value is Fields =>
  !!value && typeof value === "object" && !Array.isArray(value);
export type DesktopCallback = {
  projectId: string;
  lease: string;
  coreInstanceId: string;
  coreGeneration: string;
  connectionId: string;
  method: string;
  params: unknown;
  coreRequestId: unknown;
};

/** Main只持有原生附件；Host创建的租约无需Node投影预先登记。 */
export async function createNativeHostTransport(options: {
  home: string;
  sourceId: string;
  launch: unknown;
  onCallback: (frame: DesktopCallback, signal: AbortSignal) => Promise<unknown>;
  onEvent: (frame: Fields) => void;
  onClosed: () => void;
}) {
  const events = new HostClient({ desktopCore: true });
  const calls = new HostClient({ desktopCore: true });
  const replies = new HostClient({ desktopCore: true });
  const pending = new Map<
    string,
    { lease: string; coreRequestId: unknown; controller: AbortController }
  >();
  let attachment = "",
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
    events.close();
    calls.close();
    replies.close();
    options.onClosed();
  };
  try {
    await Promise.all([
      events.connect(options.home),
      calls.connect(options.home),
      replies.connect(options.home),
    ]);
    if (
      calls.hostId !== events.hostId ||
      replies.hostId !== events.hostId ||
      calls.generation !== events.generation ||
      replies.generation !== events.generation
    )
      throw new Error("Host changed during desktop attachment");
    for (const client of [events, calls, replies]) client.desktopCoreClosed = close;
    events.desktopCoreEvent = (value: unknown) => {
      if (!record(value) || value.attachmentId !== attachment || !record(value.event))
        return close();
      const frame = value.event;
      if (frame.event === "core.event") {
        if (typeof frame.lease !== "string" || typeof frame.method !== "string") return close();
        for (const entry of pending.values())
          if (
            entry.lease === frame.lease &&
            (frame.method === "host/connectionClosed" ||
              (frame.method === "areal/tool/cancelled" &&
                record(frame.params) &&
                String(frame.params.requestId) === String(entry.coreRequestId)))
          )
            entry.controller.abort();
        options.onEvent(frame);
        return;
      }
      if (
        frame.event !== "core.callback" ||
        typeof frame.requestId !== "string" ||
        !["projectId", "lease", "coreInstanceId", "coreGeneration", "connectionId", "method"].every(
          (key) => typeof frame[key] === "string" && frame[key] !== "",
        ) ||
        pending.has(frame.requestId)
      )
        return close();
      const id = frame.requestId;
      const entry = {
        lease: String(frame.lease),
        coreRequestId: frame.coreRequestId,
        controller: new AbortController(),
      };
      pending.set(id, entry);
      void Promise.resolve()
        .then(async () => {
          let response: { result: unknown } | { error: { message: string } };
          try {
            const result = await options.onCallback(
              frame as DesktopCallback,
              entry.controller.signal,
            );
            if (entry.controller.signal.aborted) throw new Error("Desktop callback owner changed");
            response = { result };
          } catch {
            response = { error: { message: "Desktop tool unavailable" } };
          }
          if (!closed)
            await replies.request("desktop.core.callback", {
              attachmentId: attachment,
              requestId: id,
              ...response,
            });
        })
        .catch(close)
        .finally(() => pending.delete(id));
    };
    const result: unknown = await events.request("desktop.core.subscribe", {
      sourceId: options.sourceId,
      options: options.launch,
    });
    if (
      closed ||
      !record(result) ||
      typeof result.attachmentId !== "string" ||
      !result.attachmentId
    )
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
  constructor(private options: { options: () => Fields }) {}
  close() {
    this.closed = true;
    void closeGuiHostTerminals(this.options.options()).catch(() => {});
  }
}
