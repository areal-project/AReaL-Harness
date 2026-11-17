import { HostClient } from "@areal/client/node";
import { HostClient as ReadClient, readHostBootstrap, type ShellView } from "@areal/client";
import { connectWebSocket } from "../../../packages/client/src/websocket.js";
import WebSocket from "ws";
type Fields = Record<string, unknown>;
const record = (value: unknown): value is Fields =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 原生功能与Renderer复用Host的shell基线、增量与身份校验。 */
export async function createNativeShellTransport(options: {
  home: string;
  profile: string;
  hostId: string;
  generation: string;
  onShell: (shell: ShellView) => void;
  onClosed: () => void;
}) {
  let closed = false;
  const clientOptions = {
    origin: "areal-ui://app",
    bootstrap: async () => {
      const local = new HostClient();
      try {
        await local.connect(options.home);
        if (local.hostId !== options.hostId || local.generation !== options.generation)
          throw new Error("Original native Host changed");
        const ticket = readHostBootstrap(
          await local.request("web.ticket", {
            origin: "areal-ui://app",
            expectedGeneration: options.generation,
            profile: options.profile,
          }),
        );
        if (ticket.hostId !== options.hostId || ticket.generation !== options.generation)
          throw new Error("Original native Host ticket changed");
        return ticket;
      } finally {
        local.close();
      }
    },
  };
  const reads = new ReadClient({
    ...clientOptions,
    transport: ({ current, signal, onEvent }) =>
      connectWebSocket(
        clientOptions,
        current,
        signal,
        onEvent,
        () => {
          if (closed) return;
          close();
          options.onClosed();
        },
        (url) =>
          new WebSocket(url, { origin: clientOptions.origin }) as unknown as globalThis.WebSocket,
      ),
  });
  const close = () => {
    if (closed) return;
    closed = true;
    reads.close();
  };
  reads.subscribe(() => {
    if (reads.snapshot().connection === "offline" && !closed) {
      close();
      options.onClosed();
    }
  });
  reads.subscribeReads(() => {
    const shell = reads.readsSnapshot().shell;
    if (!closed && shell.state === "fresh") options.onShell(shell.value.snapshot);
  });
  await reads.retry();
  if (closed || reads.readsSnapshot().shell.state !== "fresh") {
    close();
    throw new Error("Native Host shell unavailable");
  }
  return { close };
}
export type DesktopCallback = {
  sourceId: string;
  projectId: string;
  guiProjectId: string;
  workspacePath: string;
  lease: string;
  coreInstanceId: string;
  coreGeneration: string;
  connectionId: string;
  method: string;
  params: unknown;
  coreRequestId: unknown;
};

export type DesktopThreadScope = Pick<
  DesktopCallback,
  | "sourceId"
  | "projectId"
  | "guiProjectId"
  | "workspacePath"
  | "lease"
  | "coreInstanceId"
  | "coreGeneration"
  | "connectionId"
> & { threadId: string };

/** Main只持有原生附件；Host创建的租约无需Node投影预先登记。 */
export async function createNativeHostTransport(options: {
  home: string;
  sourceId: string;
  launch: unknown;
  environmentCredentials?: Record<string, string>;
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
  const early: unknown[] = [];
  let earlyBytes = 0;
  let attachment = "",
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
    early.length = 0;
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
    const handleEvent = (value: unknown) => {
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
        frame.sourceId !== options.sourceId ||
        typeof frame.requestId !== "string" ||
        ![
          "projectId",
          "guiProjectId",
          "workspacePath",
          "lease",
          "coreInstanceId",
          "coreGeneration",
          "connectionId",
          "method",
        ].every((key) => typeof frame[key] === "string" && frame[key] !== "") ||
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
    events.desktopCoreEvent = (value: unknown) => {
      if (attachment) return handleEvent(value);
      earlyBytes += Buffer.byteLength(JSON.stringify(value));
      if (early.length >= 64 || earlyBytes > 8 * 1024 * 1024) return close();
      early.push(value);
    };
    const result: unknown = await events.request("desktop.core.subscribe", {
      sourceId: options.sourceId,
      options: options.launch,
      ...(options.environmentCredentials
        ? { environmentCredentials: options.environmentCredentials }
        : {}),
    });
    if (
      closed ||
      !record(result) ||
      typeof result.attachmentId !== "string" ||
      !result.attachmentId
    )
      throw new Error("Invalid native desktop attachment");
    attachment = result.attachmentId;
    for (const event of early.splice(0)) {
      if (closed) break;
      handleEvent(event);
    }
    if (closed) throw new Error("Native desktop attachment disconnected during subscription");
    return {
      hostId: events.hostId,
      generation: events.generation,
      call: (call: string, params: unknown) => {
        if (closed) return Promise.reject(new Error("Native desktop attachment disconnected"));
        return calls.request("desktop.core.call", { attachmentId: attachment, call, params });
      },
      command: (command: string, request: unknown) => {
        if (closed) return Promise.reject(new Error("Native desktop attachment disconnected"));
        return calls.request("desktop.command", { sourceId: options.sourceId, command, request });
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
      // 过渡：到 0.2.0 删；停机导入仍按原来源摘要核对旧目录。
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
