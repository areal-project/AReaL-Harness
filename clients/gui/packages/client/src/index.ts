import type {
  HostStatus,
  LoopbackMethodMap,
  ConversationOpenParams,
  ConversationHistoryParams,
  ConversationMediaParams,
} from "./protocol.js";
import { record } from "./bootstrap.js";
import { connectWebSocket } from "./websocket.js";
import { WatchedSessionSet } from "./watched-sessions.js";
import { joinChunks, mediaChunk } from "./media.js";
export type { WatchedSessions } from "./watched-sessions.js";
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
  persistedHistory?: boolean;
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
export type ReadContext = import("./protocol.js").ReadContext;
export interface ReadTransport {
  write?(
    method: string,
    params: JsonObject,
    context: HostCommandContext | null,
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
export class HostClient {
  #state: HostReadState = { connection: "offline", freshness: "unavailable" };
  #reads: ReadSnapshot = { shell: { state: "loading" }, session: { state: "unavailable" } };
  #listeners = new Set<() => void>();
  #readListeners = new Set<() => void>();
  #pageListeners = new Set<(event: unknown) => void>();
  #epoch = 0;
  #selection = 0;
  #shellEpoch = 0;
  #closed = false;
  #transport?: ReadTransport;
  #abort?: AbortController;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #target?: { projectId: string; threadId: string; persisted?: boolean };
  #opening?: { key: string; selection: number; promise: Promise<void> };
  #sessionCache = new Map<string, { value: SessionRead; expires: number }>();
  #watched = new WatchedSessionSet({
    transport: () => this.#transport,
    connection: () => (this.#state.connection === "ready" ? this.#state.identity : undefined),
    project: (id) =>
      previous(this.#reads.shell)?.snapshot.projects.find((value) => value.projectId === id),
    changed: () => {
      for (const listener of this.#readListeners) listener();
    },
  });
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
  watchedSnapshot = () => this.#watched.view;
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
  subscribePageEvents = (listener: (event: unknown) => void) => {
    this.#pageListeners.add(listener);
    return () => {
      this.#pageListeners.delete(listener);
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
  /** 在选中会话之外再观察一个会话（如侧边讨论）；返回的函数结束观察。 */
  watchSession(target: { projectId: string; threadId: string }) {
    return this.#watched.watch(target);
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
    if (
      session.state !== "fresh" ||
      session.value.access?.kind === "persisted" ||
      this.#state.connection !== "ready"
    )
      return;
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
    this.#watched.markStale();
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
      if (current()) this.#watched.reopen();
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
  #connectWebSocket(current: () => boolean, signal: AbortSignal) {
    return connectWebSocket(
      this.options,
      current,
      signal,
      (event) => this.#onEvent(event),
      () => this.retry(),
    );
  }
  async #subscribeShell(refresh = false) {
    const transport = this.#transport;
    if (!transport) return;
    const epoch = ++this.#shellEpoch;
    const old = previous(this.#reads.shell);
    // 同一连接上的主动重读保留原目录直到新基线到达；标成过期会让界面把项目当成断开并卸下正在提交的输入框。
    if (!refresh || !old) this.#publishReads({ ...this.#reads, shell: stale(this.#reads.shell) });
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
    const find = (shell: ShellRead | undefined, id: string | undefined) =>
      shell?.snapshot.projects.find((project) => project.projectId === id);
    const selected = (shell?: ShellRead) => find(shell, this.#target?.projectId);
    const old = previous(this.#reads.shell);
    const before = selected(old),
      after = selected(value);
    this.#publishReads({ ...this.#reads, shell: { state: "fresh", value } });
    this.#watched.reopen((id) => {
      const a = find(old, id),
        b = find(value, id);
      return a?.serviceGeneration !== b?.serviceGeneration || a?.state !== b?.state;
    });
    if (
      !this.#target ||
      (before?.serviceGeneration === after?.serviceGeneration && before?.state === after?.state)
    )
      return;
    if (this.#target.persisted && after?.state === "ready") this.#target.persisted = false;
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
  /** 跨项目的工作台方法（由 Host 转给工作台服务），不带项目上下文；写方法使用原 commandId 查询回执。 */
  async workbench(method: string, params: JsonObject = {}, commandId?: string) {
    const transport = this.#transport;
    if (!transport?.write || !this.writable(method)) throw new Error("Host writes unavailable");
    return transport.write(method, params, null, commandId);
  }
  commandStatus(projectId: string, commandId: string) {
    return this.query("command.read", projectId, { commandId });
  }
  /** 创建回执之后重读目录，使新执行项目与会话立即进入同一投影。 */
  refreshShell() {
    return this.#subscribeShell(true);
  }
  async selectSession(target: { projectId: string; threadId: string; persisted?: boolean } | null) {
    if (
      target &&
      target.projectId === this.#target?.projectId &&
      target.threadId === this.#target.threadId &&
      target.persisted === this.#target.persisted
    ) {
      const session = this.#reads.session;
      if (
        session.state === "fresh" &&
        this.#state.connection === "ready" &&
        session.value.connectionId === this.#state.identity.connectionId
      )
        return;
      return this.#openSession();
    }
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
      target &&
      !target.persisted &&
      project?.serviceGeneration &&
      this.#state.connection === "ready"
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
    const project = previous(this.#reads.shell)?.snapshot.projects.find(
      (value) => value.projectId === this.#target?.projectId,
    );
    const key = JSON.stringify([this.#epoch, this.#target, project?.serviceGeneration]);
    if (this.#opening?.key === key && this.#opening.selection === this.#selection)
      return this.#opening.promise;
    // UI 选中与连接恢复可能同时到达；同一连接、项目代次和会话只有一个订阅负责人。
    const promise = this.#readSession();
    const opening = { key, selection: this.#selection, promise };
    this.#opening = opening;
    try {
      await opening.promise;
    } finally {
      if (this.#opening === opening) this.#opening = undefined;
    }
  }
  async #readSession() {
    const transport = this.#transport,
      target = this.#target,
      selection = ++this.#selection;
    if (!transport || !target) return;
    const shell = previous(this.#reads.shell);
    const project = shell?.snapshot.projects.find((p) => p.projectId === target.projectId);
    const persisted =
      target.persisted === true &&
      this.#state.connection === "ready" &&
      this.#state.identity.persistedHistory === true;
    if (!project || (!persisted && (!project.serviceGeneration || project.state !== "ready"))) {
      this.#publishReads({
        ...this.#reads,
        session: { state: "unavailable", error: "Project Core unavailable" },
      });
      throw new Error("Project Core unavailable");
    }
    const context = {
      projectId: target.projectId,
      ...(project.serviceGeneration ? { serviceGeneration: project.serviceGeneration } : {}),
    };
    try {
      const value = await transport.request(
        persisted ? "session.openPersisted" : "session.open",
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
        typeof value.serviceGeneration !== "string" ||
        !value.serviceGeneration ||
        (context.serviceGeneration !== undefined &&
          value.serviceGeneration !== context.serviceGeneration) ||
        (persisted &&
          (!record(value.access) ||
            value.access.kind !== "persisted" ||
            value.access.readOnly !== true ||
            typeof value.access.snapshotId !== "string")) ||
        (!persisted && value.access !== undefined) ||
        value.view !== "conversation" ||
        !record(value.snapshot) ||
        this.#state.connection !== "ready" ||
        value.connectionId !== this.#state.identity.connectionId ||
        value.gatewayGeneration !== this.#state.identity.gatewayGeneration
      )
        throw new Error("Invalid conversation baseline");
      const session: SessionRead = {
        ...value,
        projectId: target.projectId,
        serviceGeneration: value.serviceGeneration as string,
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
  async history(
    options: {
      view: "own" | "inherited" | "reference";
      cursor?: string;
      maxBytes?: number;
    },
    target?: { projectId: string; threadId: string },
  ) {
    const state = target
        ? this.#watched.view.get(`${target.projectId}:${target.threadId}`)
        : this.#reads.session,
      transport = this.#transport,
      selection = this.#selection;
    if (state?.state !== "fresh" || !transport) throw new Error("Conversation unavailable");
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
    const current = target
      ? this.#watched.view.get(`${target.projectId}:${target.threadId}`)
      : this.#reads.session;
    if (
      transport !== this.#transport ||
      (!target && selection !== this.#selection) ||
      current?.state !== "fresh" ||
      current.value.subscriptionId !== owner.subscriptionId
    )
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
      const chunk = mediaChunk(value, owner, source, offset, totalBytes, mime);
      ({ totalBytes, mime } = chunk);
      parts.push(chunk.bytes);
      offset += chunk.bytes.length;
    } while (offset < totalBytes);
    return { mime: mime!, bytes: joinChunks(parts, totalBytes!) };
  }
  #onEvent(event: unknown) {
    if (record(event) && event.event === "pages.event") {
      const state = this.#state;
      if (
        this.#closed ||
        state.connection !== "ready" ||
        event.connectionId !== state.identity.connectionId ||
        event.gatewayGeneration !== state.identity.gatewayGeneration ||
        typeof event.token !== "string" ||
        !event.token ||
        !record(event.notification)
      )
        return;
      const pageEvent = {
        event: "pages.event",
        connectionId: state.identity.connectionId,
        gatewayGeneration: state.identity.gatewayGeneration,
        token: event.token,
        notification: event.notification,
      };
      for (const listener of this.#pageListeners) listener(pageEvent);
      return;
    }
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
    if (String(event.event).startsWith("session.") && this.#watched.accept(event)) return;
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
    this.#watched.clear();
    this.#abort?.abort();
    this.#transport?.close();
    this.#transport = undefined;
    this.options.events?.removeEventListener("online", this.#wake);
    this.options.events?.removeEventListener("focus", this.#wake);
    this.options.events?.removeEventListener("pageshow", this.#restore);
    this.#listeners.clear();
    this.#readListeners.clear();
    this.#pageListeners.clear();
  }
}
export { createNoiseReadTransport, remoteCapabilities, remoteReadConnection } from "./noise.js";
