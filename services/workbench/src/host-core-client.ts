import { parseCoreCapabilities } from "@areal/runtime-client/capabilities";
import type { CoreClient } from "@areal/runtime-client/core";
import { CoreRpcError, requestFailure, requestIdentity, UNSENT } from "@areal/runtime-client/errors";

type Fields = Record<string, unknown>;
type Call = (method: string, params: unknown) => Promise<unknown>;
type ServerRequest = NonNullable<ConstructorParameters<typeof CoreClient>[0]["onServerRequest"]>;
type ObservationFence = { events: Fields[]; bytes: number };
type Lease = {
  lease: string;
  coreInstanceId: string;
  coreGeneration: string;
  connectionId: string;
  capabilities: unknown;
};
const record = (value: unknown): value is Fields =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 页面宿主只保留可重建投影；Core 连接、初始化和请求由 Host 拥有。 */
export class HostCoreClient {
  ready = false;
  closed = false;
  closeFailure: CoreRpcError | null = null;
  capabilities?: CoreClient["capabilities"];
  private lease?: Lease;
  private listeners = new Set<(method: string, params: unknown) => void>();
  private closeListeners = new Set<(error: CoreRpcError) => void>();
  private callbacks = new Map<string, AbortController>();
  private observations = new Map<string, Set<ObservationFence>>();

  constructor(
    private options: {
      host: Call;
      sourceId: string;
      projectId: string;
      cloud?: { baseURL: string; token: string };
      scope?: "terminal" | "observer";
      onServerRequest?: ServerRequest;
    },
  ) {}

  async connect() {
    if (this.closed || this.lease) throw new Error("Host Core projection already attached");
    const value = await this.options.host(
      this.options.cloud ? "cloud.attach" : "core.attach",
      this.options.cloud
        ? { sourceId: this.options.sourceId, ...this.options.cloud }
        : { ...this.scope(), ...(this.options.scope ? { scope: this.options.scope } : {}) },
    );
    if (
      !record(value) ||
      !["lease", "coreInstanceId", "coreGeneration", "connectionId"].every(
        (key) => typeof value[key] === "string" && (value[key] as string).length > 0,
      )
    )
      throw new Error("Invalid Host Core attachment");
    if (this.options.cloud) {
      if (typeof value.projectId !== "string") throw new Error("Invalid Cloud Core attachment");
      this.options.projectId = value.projectId;
    }
    this.lease = value as Lease;
    this.capabilities = parseCoreCapabilities(value.capabilities);
    if (this.closed) {
      void this.options.host("core.detach", this.scope()).catch(() => {});
      throw new Error("Host Core projection closed during attachment");
    }
    this.ready = true;
    return this.capabilities;
  }

  owns(lease: unknown) {
    return this.ready && !this.closed && this.lease?.lease === lease;
  }
  identity() {
    return this.lease
      ? {
          coreInstanceId: this.lease.coreInstanceId,
          coreGeneration: this.lease.coreGeneration,
          connectionId: this.lease.connectionId,
        }
      : null;
  }

  private scope() {
    return {
      sourceId: this.options.sourceId,
      projectId: this.options.projectId,
      ...(this.lease ? { lease: this.lease.lease } : {}),
    };
  }

  async request<Result = unknown>(
    method: string,
    params: object = {},
    options: {
      decode?: (value: unknown) => Result;
      onResult?: (value: Result) => void;
      timeoutMs?: number;
      maxResponseBytes?: number;
      hostMethod?: "execution.submit";
      remember?: boolean;
    } = {},
  ): Promise<Result> {
    const request = requestIdentity(method, params, this.capabilities);
    if (!this.ready || this.closed)
      throw requestFailure("Host Core projection is disconnected", request, "DISCONNECTED", UNSENT);
    const maximum = options.maxResponseBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 * 1024)
      throw new RangeError("Invalid Core response byte budget");
    const lease = this.lease;
    const thread =
      record(params) &&
      typeof params.threadId === "string" &&
      options.onResult &&
      ["areal/thread/observe", "thread/resume", "thread/read"].includes(method)
        ? params.threadId
        : null;
    const fence: ObservationFence | null = thread ? { events: [], bytes: 0 } : null;
    if (thread && fence) {
      const pending = this.observations.get(thread) ?? new Set<ObservationFence>();
      pending.add(fence);
      this.observations.set(thread, pending);
    }
    try {
      const value = await this.options.host(options.hostMethod ?? "core.request", {
        ...this.scope(),
        method,
        params,
        ...(options.hostMethod ? { remember: options.remember === true } : {}),
      });
      if (this.closed || this.lease !== lease)
        throw Object.assign(new Error("Host Core attachment changed; outcome unknown"), {
          code: "STALE_CONNECTION",
        });
      if (!record(value)) throw new Error("Invalid Host Core response");
      if (record(value.error))
        throw requestFailure(
          String(value.error.message ?? "Core request failed"),
          request,
          typeof value.error.code === "number" ? value.error.code : "RESPONSE_INVALID",
          {
            data: record(value.error.data) ? value.error.data : undefined,
            received: true,
          },
        );
      if (!Object.hasOwn(value, "result")) throw new Error("Missing Host Core response");
      if (Buffer.byteLength(JSON.stringify(value.result)) > maximum)
        throw Object.assign(new Error("Core response exceeds the requested byte budget"), {
          code: "RESPONSE_TOO_LARGE",
        });
      if (fence && (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0)) {
        this.close();
        throw new Error("Missing Core observation barrier");
      }
      const result = options.decode ? options.decode(value.result) : (value.result as Result);
      options.onResult?.(result);
      if (fence)
        for (const event of fence.events)
          if (Number(event.sequence) > Number(value.sequence)) this.publish(event);
      return result;
    } catch (error) {
      // 确定拒绝没有安装新快照，增量仍属于原投影；预算不足的读取可以继续按原规则处理。
      if (fence && !this.closed) for (const event of fence.events) this.publish(event);
      if (error instanceof CoreRpcError || error instanceof RangeError) throw error;
      throw requestFailure(
        error instanceof Error ? error.message : "Host Core response unavailable",
        request,
        record(error) && (typeof error.code === "string" || typeof error.code === "number")
          ? error.code
          : "DISCONNECTED",
        { cause: error },
      );
    } finally {
      if (thread && fence) {
        const pending = this.observations.get(thread);
        pending?.delete(fence);
        if (!pending?.size) this.observations.delete(thread);
      }
    }
  }

  submit(method: string, params: object, remember: boolean) {
    return this.request(method, params, { hostMethod: "execution.submit", remember });
  }
  async reconcile(method: string, params: object): Promise<Fields> {
    const request = requestIdentity(method, params, this.capabilities);
    if (!this.ready || this.closed)
      throw requestFailure("Host Core projection is disconnected", request, "DISCONNECTED");
    const lease = this.lease;
    const result = await this.options.host("execution.reconcile", {
      ...this.scope(),
      method,
      params,
    });
    if (this.closed || this.lease !== lease)
      throw requestFailure("Host Core attachment changed", request, "STALE_CONNECTION");
    if (!record(result) || typeof result.confirmed !== "boolean")
      throw new Error("Invalid Host submission reconciliation");
    return result;
  }

  async blob(params: Fields): Promise<Fields> {
    if (!this.ready || this.closed) throw new Error("Host Core projection is disconnected");
    const value = await this.options.host("core.blob", { ...this.scope(), ...params });
    if (!record(value)) throw new Error("Invalid Host blob response");
    return value;
  }
  async media(params: Fields): Promise<Fields> {
    const result = await this.options.host("core.media", { ...this.scope(), ...params });
    if (!record(result)) throw new Error("Invalid Host media result");
    return result;
  }
  async admit(name: string, request: Fields) {
    if (!this.ready || this.closed) throw new Error("Host Core projection is disconnected");
    const projected = Object.fromEntries(
      [
        "operation",
        "threadId",
        "parentThreadId",
        "sourceThreadId",
        "taskId",
        "expectedTurnId",
        "mode",
      ]
        .filter((key) => request[key] !== undefined)
        .map((key) => [key, request[key]]),
    );
    const result = await this.options.host("execution.admit", {
      ...this.scope(),
      name,
      request: projected,
    });
    if (!record(result) || result.admitted !== true)
      throw new Error("Invalid Host workspace admission");
  }

  async dismiss(requestId: string) {
    if (!this.ready || this.closed) throw new Error("Host Core projection is disconnected");
    return this.options.host("execution.dismiss", { ...this.scope(), requestId });
  }

  onNotification(listener: (method: string, params: unknown) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onClose(listener: (error: CoreRpcError) => void) {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  private publish(frame: Fields) {
    if (typeof frame.method === "string")
      for (const listener of this.listeners) listener(frame.method, frame.params);
  }
  event(frame: Fields) {
    if (
      !this.ready ||
      this.closed ||
      frame.lease !== this.lease?.lease ||
      typeof frame.method !== "string"
    )
      return;
    if (frame.method === "host/connectionClosed") {
      this.close(false);
      return;
    }
    if (frame.method === "areal/tool/cancelled" && record(frame.params))
      this.callbacks.get(String(frame.params.requestId))?.abort();
    const params = record(frame.params) ? frame.params : {};
    const thread =
      typeof params.threadId === "string"
        ? params.threadId
        : record(params.thread) && typeof params.thread.id === "string"
          ? params.thread.id
          : null;
    const pending = thread ? this.observations.get(thread) : null;
    if (pending?.size) {
      if (!Number.isSafeInteger(frame.sequence) || Number(frame.sequence) < 0) {
        this.close();
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      for (const fence of pending) {
        if (fence.events.length >= 128 || fence.bytes + bytes > 8 * 1024 * 1024) {
          this.close();
          return;
        }
        fence.events.push(frame);
        fence.bytes += bytes;
      }
      return;
    }
    this.publish(frame);
  }
  async callback(frame: Fields) {
    if (
      !this.ready ||
      this.closed ||
      frame.lease !== this.lease?.lease ||
      typeof frame.method !== "string" ||
      !this.options.onServerRequest
    )
      throw new Error("Desktop tool host attachment changed");
    const controller = new AbortController();
    const lease = this.lease;
    const id = String(frame.requestId ?? "");
    if (!id || this.callbacks.has(id)) throw new Error("Duplicate Core tool request identity");
    this.callbacks.set(id, controller);
    try {
      const result = await this.options.onServerRequest(frame.method, frame.params, {
        requestId: id,
        signal: controller.signal,
      });
      if (this.closed || this.lease !== lease) throw new Error("Desktop tool owner changed");
      return result;
    } finally {
      if (this.callbacks.get(id) === controller) this.callbacks.delete(id);
    }
  }
  close(detach = true) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const controller of this.callbacks.values()) controller.abort();
    this.callbacks.clear();
    if (detach && this.lease) void this.options.host("core.detach", this.scope()).catch(() => {});
    const failure = new CoreRpcError("Host Core attachment closed", { code: "DISCONNECTED" });
    for (const listener of this.closeListeners) listener(failure);
    this.listeners.clear();
    this.closeListeners.clear();
    this.observations.clear();
  }
}
