import type {
  HostStatus,
  LoopbackMethodMap,
  LoopbackHelloParams,
  ConversationOpenParams,
  ConversationHistoryParams,
  ConversationMediaParams,
} from "./protocol.js";
import { readHostBootstrap, record, type HostBootstrap } from "./bootstrap.js";
import {
  applyConversationPatch,
  applyShellDelta,
  identity,
  previous,
  readShell,
  stale,
  sessionReadKey,
  SESSION_READ_CACHE_MS,
  SESSION_READ_CACHE_LIMIT,
  type ReadSnapshot,
  type SessionRead,
  type ShellRead,
  type JsonObject,
  type MediaSource,
  type MediaBytes,
} from "./read-state.js";
export { readHostBootstrap, type HostBootstrap } from "./bootstrap.js";
export type * from "./read-state.js";
export { sessionReadKey, SESSION_READ_CACHE_MS, SESSION_READ_CACHE_LIMIT } from "./read-state.js";
export type HostReadState =
  | {
      connection: "connecting" | "offline";
      freshness: "unavailable" | "stale";
      previous?: HostStatus;
    }
  | {
      connection: "ready";
      freshness: "fresh" | "unavailable";
      value?: HostStatus;
      identity: ReadConnectionIdentity;
    };
export type ReadConnectionIdentity = {
  hostId: string;
  hostGeneration: string;
  connectionId: string;
  gatewayGeneration: string;
  preferredSourceId?: string;
  writeMethods?: readonly string[];
  /** 与桌面输入框一致的上限：正文、附件、引用与 MCP 内容。 */
  writeLimits?: Readonly<Record<string, number>>;
};
/** 写命令的结果。传输中断时只返回 unknown，由调用方用同一 commandId 查 command.read，绝不重发。 */
export type HostCommandResult =
  | { admissionState: "unknown"; commandId: string; transportError: string }
  | (JsonObject & { commandId?: string });
export type HostCommandContext = { projectId: string; serviceGeneration: string };
export type ReadConnection = {
  transport: ReadTransport;
  identity: ReadConnectionIdentity;
  status?: HostStatus;
};
export type ReadContext = import("./protocol.js").ReadContext & { serviceGeneration: string };
export interface ReadTransport {
  write?(
    method: string,
    params: JsonObject,
    context: HostCommandContext,
    commandId?: string,
  ): Promise<unknown>;
  request(
    method: keyof LoopbackMethodMap,
    params: JsonObject,
    context?: ReadContext,
  ): Promise<unknown>;
  close(): void;
}
export interface HostClientOptions {
  bootstrap(): Promise<unknown>;
  origin: string;
  /** 只有桌面外壳签发的票据能协商写入；浏览器传 false 或不传。 */
  writes?: boolean;
  events?: Pick<Window, "addEventListener" | "removeEventListener">;
  transport?(options: {
    signal: AbortSignal;
    current(): boolean;
    onEvent(event: unknown): void;
    onClose(): void;
  }): Promise<ReadConnection>;
}
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export class HostClient {
  #state: HostReadState = { connection: "offline", freshness: "unavailable" };
  #reads: ReadSnapshot = { shell: { state: "loading" }, session: { state: "unavailable" } };
  #listeners = new Set<() => void>();
  #readListeners = new Set<() => void>();
  #epoch = 0;
  #selection = 0;
  #shellEpoch = 0;
  #closed = false;
  #transport?: ReadTransport;
  #abort?: AbortController;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #target?: { projectId: string; threadId: string };
  #sessionCache = new Map<string, { value: SessionRead; expires: number }>();
  #cacheTimer?: ReturnType<typeof setTimeout>;
  #connectedHost?: string;
  #mediaQueue = Promise.resolve();
  #wake = () => {
    if (this.#state.connection !== "ready") this.retry();
  };
  #restore = (event: PageTransitionEvent) => {
    if (event.persisted) this.retry();
  };
  constructor(private readonly options: HostClientOptions) {
    options.events?.addEventListener("online", this.#wake);
    options.events?.addEventListener("focus", this.#wake);
    options.events?.addEventListener("pageshow", this.#restore);
  }
  snapshot = () => this.#state;
  readsSnapshot = () => this.#reads;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  subscribeReads = (listener: () => void) => {
    this.#readListeners.add(listener);
    return () => {
      this.#readListeners.delete(listener);
    };
  };
  #publish(state: HostReadState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  #publishReads(state: ReadSnapshot) {
    this.#reads = state;
    for (const listener of this.#readListeners) listener();
  }
  #pruneSessionCache() {
    clearTimeout(this.#cacheTimer);
    for (const [key, entry] of this.#sessionCache)
      if (entry.expires <= Date.now()) this.#sessionCache.delete(key);
    const active =
      this.#reads.session.state === "fresh" && this.#state.connection === "ready"
        ? sessionReadKey(this.#state.identity, this.#reads.session.value)
        : undefined;
    const limit =
      SESSION_READ_CACHE_LIMIT - Number(active !== undefined && !this.#sessionCache.has(active));
    while (this.#sessionCache.size > limit)
      this.#sessionCache.delete(this.#sessionCache.keys().next().value!);
    const expires = Math.min(...[...this.#sessionCache.values()].map((entry) => entry.expires));
    if (Number.isFinite(expires))
      this.#cacheTimer = setTimeout(
        () => this.#pruneSessionCache(),
        Math.max(0, expires - Date.now()),
      );
  }
  #retainSession() {
    const session = this.#reads.session;
    if (session.state !== "fresh" || this.#state.connection !== "ready") return;
    const key = sessionReadKey(this.#state.identity, session.value);
    this.#sessionCache.delete(key);
    this.#sessionCache.set(key, {
      value: session.value,
      expires: Date.now() + SESSION_READ_CACHE_MS,
    });
    this.#pruneSessionCache();
  }
  retry() {
    if (this.#closed) return;
    this.#retainSession();
    clearTimeout(this.#timer);
    const epoch = ++this.#epoch;
    this.#abort?.abort();
    const abort = (this.#abort = new AbortController());
    ++this.#selection;
    ++this.#shellEpoch;
    this.#transport?.close();
    this.#transport = undefined;
    const value = this.#state.connection === "ready" ? this.#state.value : this.#state.previous;
    this.#publish({
      connection: "connecting",
      freshness: value ? "stale" : "unavailable",
      previous: value,
    });
    this.#publishReads({ shell: stale(this.#reads.shell), session: stale(this.#reads.session) });
    const current = () => !this.#closed && epoch === this.#epoch;
    void (async () => {
      const connection = this.options.transport
        ? await this.options.transport({
            signal: abort.signal,
            current,
            onEvent: (event) => this.#onEvent(event),
            onClose: () => {
              if (current()) this.retry();
            },
          })
        : await this.#connectWebSocket(current, abort.signal);
      if (!current()) {
        connection.transport.close();
        return;
      }
      this.#transport = connection.transport;
      this.#attempt = 0;
      const connectedHost = JSON.stringify([
        connection.identity.hostId,
        connection.identity.hostGeneration,
      ]);
      const changedHost =
        this.#connectedHost !== undefined && this.#connectedHost !== connectedHost;
      this.#connectedHost = connectedHost;
      this.#publish({
        connection: "ready",
        freshness: connection.status ? "fresh" : "unavailable",
        value: connection.status,
        identity: connection.identity,
      });
      if (changedHost)
        this.#publishReads({ shell: { state: "loading" }, session: { state: "loading" } });
      const selection = this.#selection;
      await this.#subscribeShell();
      if (current() && selection === this.#selection && this.#target)
        await this.#openSession().catch(() => {});
    })().catch(() => {
      if (!current()) return;
      ++this.#epoch;
      abort.abort();
      this.#transport?.close();
      this.#transport = undefined;
      this.#publish({
        connection: "offline",
        freshness: value ? "stale" : "unavailable",
        previous: value,
      });
      this.#publishReads({
        shell: stale(this.#reads.shell, "Host unavailable"),
        session: stale(this.#reads.session, "Host unavailable"),
      });
      const delay = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt++, 6));
      this.#timer = setTimeout(() => this.retry(), delay * (0.8 + Math.random() * 0.4));
    });
  }
  async #connectWebSocket(current: () => boolean, signal: AbortSignal) {
    let bootstrap: HostBootstrap | undefined = readHostBootstrap(await this.options.bootstrap());
    if (bootstrap.origin !== this.options.origin) throw new Error("Host origin mismatch");
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
      context: HostCommandContext,
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
              context: {
                projectId: context.projectId,
                serviceGeneration: context.serviceGeneration,
                gatewayGeneration: generation,
                grantRevision: 0,
              },
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
        if (connected && current()) this.retry();
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
          capabilities: this.options.writes ? ["gui-read-v1", "gui-write-v1"] : ["gui-read-v1"],
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
              this.options.writes === true &&
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
            this.#onEvent(message.params);
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
  async #subscribeShell() {
    const transport = this.#transport;
    if (!transport) return;
    const epoch = ++this.#shellEpoch;
    const old = previous(this.#reads.shell);
    this.#publishReads({ ...this.#reads, shell: stale(this.#reads.shell) });
    if (old)
      void transport
        .request("shell.unsubscribe", { subscriptionId: old.subscriptionId })
        .catch(() => {});
    const value = await transport.request("shell.subscribe", {});
    if (epoch !== this.#shellEpoch || transport !== this.#transport) return;
    if (
      !identity(value) ||
      value.sequence !== 0 ||
      this.#state.connection !== "ready" ||
      value.connectionId !== this.#state.identity.connectionId ||
      value.gatewayGeneration !== this.#state.identity.gatewayGeneration
    )
      throw new Error("Invalid shell baseline");
    const shell: ShellRead = { ...value, snapshot: readShell(value.snapshot) };
    this.#acceptShell(shell);
  }
  #acceptShell(value: ShellRead) {
    const selected = (shell?: ShellRead) =>
      shell?.snapshot.projects.find((project) => project.projectId === this.#target?.projectId);
    const before = selected(previous(this.#reads.shell)),
      after = selected(value);
    this.#publishReads({ ...this.#reads, shell: { state: "fresh", value } });
    if (
      !this.#target ||
      (before?.serviceGeneration === after?.serviceGeneration && before?.state === after?.state)
    )
      return;
    this.#publishReads({
      ...this.#reads,
      session:
        this.#reads.session.state === "loading" ? this.#reads.session : stale(this.#reads.session),
    });
    void this.#openSession().catch(() => {});
  }
  /** 当前连接是否能写，以及 Host 允许的方法。 */
  writable(method: string) {
    return (
      this.#state.connection === "ready" &&
      this.#transport?.write !== undefined &&
      this.#state.identity.writeMethods?.includes(method) === true
    );
  }
  #commandContext(projectId: string): HostCommandContext {
    const project = previous(this.#reads.shell)?.snapshot.projects.find(
      (value) => value.projectId === projectId,
    );
    if (!project?.serviceGeneration || project.state !== "ready")
      throw new Error("Project Core unavailable");
    return { projectId, serviceGeneration: project.serviceGeneration };
  }
  /** 带回执的写命令：commandId 由调用方保存，回复丢失时用 commandStatus 查原 ID。 */
  async command(
    method: string,
    projectId: string,
    params: JsonObject,
    commandId: string = crypto.randomUUID(),
  ): Promise<HostCommandResult> {
    const transport = this.#transport;
    if (!transport?.write || !this.writable(method)) throw new Error("Host writes unavailable");
    const context = this.#commandContext(projectId);
    try {
      const value = await transport.write(method, params, context, commandId);
      if (!record(value)) throw new Error("Invalid Host command result");
      return { ...value, commandId };
    } catch (error) {
      // Host 回了错误码就是明确的拒绝；只有传输层失败才是"不知道是否受理"。
      if (record(error) && typeof error.code === "string") throw error;
      return {
        admissionState: "unknown",
        commandId,
        transportError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  /** 只读的写前查询（review.read、task.read、project.models 等），不带 commandId。 */
  async query(method: string, projectId: string, params: JsonObject) {
    const transport = this.#transport;
    if (!transport?.write || !this.writable(method)) throw new Error("Host writes unavailable");
    return transport.write(method, params, this.#commandContext(projectId));
  }
  /**
   * 附件分块交给 Host，再由 Host 存进 Core；返回 areal://blob/ 引用。
   * Host 校验重发块与已收内容一致，所以传输失败时同一块可以原样重发一次。
   */
  async upload(
    projectId: string,
    threadId: string,
    bytes: Uint8Array,
    mimeType: string,
    uploadId: string = crypto.randomUUID(),
  ): Promise<{ uri: string; mimeType: string; sizeBytes: number }> {
    const limits =
      this.#state.connection === "ready" ? this.#state.identity.writeLimits : undefined;
    const chunk = limits?.uploadChunkBytes ?? 256 * 1024;
    if (bytes.length === 0 || bytes.length > (limits?.uploadBytes ?? 16 * 1024 * 1024))
      throw Object.assign(new Error("Attachment too large"), { code: "LIMIT_EXCEEDED" });
    for (let offset = 0; ; offset += chunk) {
      const part = bytes.subarray(offset, offset + chunk);
      let binary = "";
      for (let at = 0; at < part.length; at += 0x8000)
        binary += String.fromCharCode(...part.subarray(at, at + 0x8000));
      const params = {
        threadId,
        uploadId,
        mimeType,
        sizeBytes: bytes.length,
        offset,
        base64: btoa(binary),
      };
      let value: unknown;
      try {
        value = await this.query("attachment.upload", projectId, params);
      } catch (error) {
        if (record(error) && typeof error.code === "string") throw error;
        value = await this.query("attachment.upload", projectId, params);
      }
      if (!record(value) || typeof value.receivedBytes !== "number")
        throw new Error("Invalid Host upload result");
      const attachment = value.attachment;
      if (record(attachment)) {
        if (
          typeof attachment.uri !== "string" ||
          typeof attachment.mimeType !== "string" ||
          typeof attachment.sizeBytes !== "number"
        )
          throw new Error("Invalid Host upload result");
        return {
          uri: attachment.uri,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
      }
      if (offset + part.length >= bytes.length) throw new Error("Invalid Host upload result");
    }
  }
  commandStatus(projectId: string, commandId: string) {
    return this.query("command.read", projectId, { commandId });
  }
  async selectSession(target: { projectId: string; threadId: string } | null) {
    this.#retainSession();
    this.#target = target ?? undefined;
    ++this.#selection;
    const old = this.#reads.session.state === "fresh" ? this.#reads.session.value : undefined;
    if (old && this.#transport)
      void this.#transport
        .request("subscription.close", { subscriptionId: old.subscriptionId }, old)
        .catch(() => {});
    this.#pruneSessionCache();
    const project = previous(this.#reads.shell)?.snapshot.projects.find(
      (value) => value.projectId === target?.projectId,
    );
    const cached =
      target && project?.serviceGeneration && this.#state.connection === "ready"
        ? this.#sessionCache.get(
            sessionReadKey(this.#state.identity, {
              ...target,
              serviceGeneration: project.serviceGeneration,
            }),
          )?.value
        : undefined;
    this.#publishReads({
      ...this.#reads,
      session: cached ? { state: "stale", value: cached } : { state: "loading" },
    });
    if (target && this.#transport) await this.#openSession();
  }
  async #openSession() {
    const transport = this.#transport,
      target = this.#target,
      selection = ++this.#selection;
    if (!transport || !target) return;
    const shell = previous(this.#reads.shell);
    const project = shell?.snapshot.projects.find((p) => p.projectId === target.projectId);
    if (!project?.serviceGeneration || project.state !== "ready") {
      this.#publishReads({
        ...this.#reads,
        session: { state: "unavailable", error: "Project Core unavailable" },
      });
      throw new Error("Project Core unavailable");
    }
    const context = { projectId: target.projectId, serviceGeneration: project.serviceGeneration };
    try {
      const value = await transport.request(
        "session.open",
        { threadId: target.threadId, view: "conversation" } satisfies ConversationOpenParams,
        context,
      );
      if (selection !== this.#selection || transport !== this.#transport) {
        if (identity(value))
          void transport
            .request("subscription.close", { subscriptionId: value.subscriptionId }, context)
            .catch(() => {});
        return;
      }
      if (
        !identity(value) ||
        value.sequence !== 0 ||
        value.projectId !== target.projectId ||
        value.threadId !== target.threadId ||
        value.serviceGeneration !== context.serviceGeneration ||
        value.view !== "conversation" ||
        !record(value.snapshot) ||
        this.#state.connection !== "ready" ||
        value.connectionId !== this.#state.identity.connectionId ||
        value.gatewayGeneration !== this.#state.identity.gatewayGeneration
      )
        throw new Error("Invalid conversation baseline");
      const session: SessionRead = {
        ...value,
        ...context,
        threadId: target.threadId,
        view: "conversation",
        snapshot: value.snapshot,
      };
      this.#publishReads({ ...this.#reads, session: { state: "fresh", value: session } });
      this.#pruneSessionCache();
    } catch (error) {
      if (selection === this.#selection)
        this.#publishReads({
          ...this.#reads,
          session: stale(
            this.#reads.session,
            error instanceof Error ? error.message : "Conversation unavailable",
          ),
        });
      throw error;
    }
  }
  async history(options: {
    view: "own" | "inherited" | "reference";
    cursor?: string;
    maxBytes?: number;
  }) {
    const state = this.#reads.session,
      transport = this.#transport,
      selection = this.#selection;
    if (state.state !== "fresh" || !transport) throw new Error("Conversation unavailable");
    const owner = state.value;
    const result = await transport.request(
      "session.history",
      {
        threadId: owner.threadId,
        subscriptionId: owner.subscriptionId,
        ...options,
      } satisfies ConversationHistoryParams,
      owner,
    );
    if (selection !== this.#selection || transport !== this.#transport)
      throw new Error("History read cancelled");
    if (
      !identity(result) ||
      [
        "connectionId",
        "gatewayGeneration",
        "subscriptionId",
        "projectId",
        "serviceGeneration",
        "threadId",
      ].some((key) => result[key] !== owner[key as keyof SessionRead]) ||
      !record(result.page) ||
      result.view !== "conversation" ||
      result.sequence < owner.sequence
    )
      throw new Error("History identity changed");
    return result.page;
  }
  media(source: MediaSource, signal?: AbortSignal): Promise<MediaBytes> {
    if (!/^areal:\/\/blob\/[a-f0-9]{64}$/.test(source.uri))
      return Promise.reject(new Error("Conversation media unavailable"));
    const selection = this.#selection;
    const request = this.#mediaQueue.then(() => {
      if (signal?.aborted || selection !== this.#selection)
        throw new DOMException("Media read cancelled", "AbortError");
      return this.#readMedia(source, signal);
    });
    this.#mediaQueue = request.then(
      () => {},
      () => {},
    );
    return request;
  }
  async #readMedia(source: MediaSource, signal?: AbortSignal): Promise<MediaBytes> {
    const state = this.#reads.session,
      transport = this.#transport,
      selection = this.#selection;
    if (state.state !== "fresh" || !transport) throw new Error("Conversation unavailable");
    const owner = state.value,
      parts: Uint8Array[] = [];
    let offset = 0,
      totalBytes: number | undefined,
      mime: string | undefined;
    const current = () => {
      if (signal?.aborted || selection !== this.#selection || transport !== this.#transport)
        throw new DOMException("Media read cancelled", "AbortError");
    };
    do {
      current();
      const value = await transport.request(
        "artifact.read",
        {
          view: "conversation",
          threadId: owner.threadId,
          subscriptionId: owner.subscriptionId,
          serviceGeneration: owner.serviceGeneration,
          ...source,
          offset,
          length: 65536,
        } satisfies ConversationMediaParams,
        owner,
      );
      current();
      if (
        !identity(value) ||
        [
          "connectionId",
          "gatewayGeneration",
          "subscriptionId",
          "projectId",
          "serviceGeneration",
          "threadId",
        ].some((key) => value[key] !== owner[key as keyof SessionRead]) ||
        value.view !== "conversation" ||
        value.sequence < owner.sequence ||
        value.sourceThreadId !== (source.sourceThreadId ?? owner.threadId) ||
        value.turnId !== source.turnId ||
        value.itemId !== source.itemId ||
        value.uri !== source.uri ||
        value.offset !== offset ||
        !Number.isSafeInteger(value.totalBytes) ||
        Number(value.totalBytes) < 0 ||
        Number(value.totalBytes) > 16 * 1024 * 1024 ||
        typeof value.mimeType !== "string" ||
        !value.mimeType ||
        value.mimeType.length > 256 ||
        /[\r\n\0]/.test(value.mimeType) ||
        (value.raster !== undefined &&
          (!record(value.raster) ||
            value.raster.mime !== value.mimeType ||
            !Number.isSafeInteger(value.raster.width) ||
            Number(value.raster.width) <= 0 ||
            !Number.isSafeInteger(value.raster.height) ||
            Number(value.raster.height) <= 0)) ||
        typeof value.base64 !== "string" ||
        value.base64.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
      )
        throw new Error("Invalid conversation media chunk");
      if (totalBytes !== undefined && (value.totalBytes !== totalBytes || value.mimeType !== mime))
        throw new Error("Media identity changed");
      totalBytes = Number(value.totalBytes);
      mime = String(value.mimeType);
      const bytes = Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0));
      if (
        (!bytes.length && totalBytes !== 0) ||
        bytes.length > 65536 ||
        offset + bytes.length > totalBytes ||
        value.nextOffset !== (offset + bytes.length === totalBytes ? null : offset + bytes.length)
      )
        throw new Error("Invalid conversation media range");
      parts.push(bytes);
      offset += bytes.length;
    } while (offset < totalBytes);
    const bytes = new Uint8Array(totalBytes);
    let position = 0;
    for (const part of parts) {
      bytes.set(part, position);
      position += part.length;
    }
    return { mime, bytes };
  }
  #onEvent(event: unknown) {
    if (!identity(event)) return;
    const shell = this.#reads.shell;
    if (
      (event.event === "shell.updated" || event.event === "shell.invalidated") &&
      shell.state === "fresh"
    ) {
      const current = shell.value;
      if (
        ["connectionId", "gatewayGeneration", "subscriptionId"].some(
          (key) => event[key] !== current[key as keyof ShellRead],
        ) ||
        event.sequence <= current.sequence
      )
        return;
      if (event.sequence !== current.sequence + 1 || event.event === "shell.invalidated") {
        void this.#subscribeShell().catch(() => this.retry());
        return;
      }
      try {
        this.#acceptShell({
          ...current,
          sequence: event.sequence,
          snapshot: applyShellDelta(current.snapshot, event.delta),
        });
      } catch {
        void this.#subscribeShell().catch(() => this.retry());
      }
      return;
    }
    const session = this.#reads.session;
    if (session.state !== "fresh" || !String(event.event).startsWith("session.")) return;
    const current = session.value;
    if (
      [
        "connectionId",
        "gatewayGeneration",
        "subscriptionId",
        "projectId",
        "serviceGeneration",
      ].some((key) => event[key] !== current[key as keyof SessionRead]) ||
      event.sequence <= current.sequence
    )
      return;
    if (
      event.sequence !== current.sequence + 1 ||
      event.threadId !== current.threadId ||
      event.view !== "conversation" ||
      event.event === "session.invalidated"
    ) {
      this.#publishReads({ ...this.#reads, session: stale(session) });
      void this.#openSession().catch(() => {});
      return;
    }
    try {
      this.#publishReads({
        ...this.#reads,
        session: {
          state: "fresh",
          value: {
            ...current,
            sequence: event.sequence,
            snapshot: applyConversationPatch(current.snapshot, event.patch),
          },
        },
      });
    } catch {
      this.#publishReads({ ...this.#reads, session: stale(session) });
      void this.#openSession().catch(() => {});
    }
  }
  close() {
    this.#closed = true;
    ++this.#epoch;
    ++this.#selection;
    ++this.#shellEpoch;
    clearTimeout(this.#timer);
    clearTimeout(this.#cacheTimer);
    this.#sessionCache.clear();
    this.#abort?.abort();
    this.#transport?.close();
    this.#transport = undefined;
    this.options.events?.removeEventListener("online", this.#wake);
    this.options.events?.removeEventListener("focus", this.#wake);
    this.options.events?.removeEventListener("pageshow", this.#restore);
    this.#listeners.clear();
    this.#readListeners.clear();
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
export { createNoiseReadTransport } from "./noise.js";
