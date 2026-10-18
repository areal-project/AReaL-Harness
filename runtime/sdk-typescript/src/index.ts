import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type {
  ConnectionInfo,
  CreateScope,
  FileCommand,
  FileRequest,
  FileResult,
  OperationInfo,
  OutputPage,
  OutputStream,
  ProcessInfo,
  ProcessInput,
  ResizeProcess,
  CloseStdin,
  ProcessRef,
  ReadOutput,
  RuntimeErrorData,
  ScopeInfo,
  StartProcess,
} from "./types.js";
export type * from "./types.js";

export const VERSION = "areal.runtime.v0";
const MAX_FRAME = 128 * 1024;
const MAX_PENDING = 128;
const DEFAULT_TIMEOUT = 90000;
const MAX_TIMEOUT = 2147483647;
const EXECUTION = new Set(["process.start", "process.wait", "fs.execute"]);
const CONTROL = new Set([
  "connection.open",
  "connection.close",
  "scope.get",
  "scope.revoke",
  "owner.revoke",
  "process.terminate",
]);
export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorData["code"],
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
export class OutputGapError extends Error {
  constructor(readonly page: OutputPage) {
    super("Runtime output contains a gap or truncation");
    this.name = "OutputGapError";
  }
}
export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  removeAbort(): void;
};
const unavailable = (message: string) => new RuntimeError("UNAVAILABLE", message);

/** Exclusive trusted streams only. Aborting a waiter never revokes a Runtime operation. */
export class RuntimeClient {
  #pending = new Map<number, Pending>();
  #next = 0;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #info: ConnectionInfo | undefined;
  #closing: Promise<void> | undefined;
  private constructor(
    private read: Readable,
    private write: Writable,
  ) {
    read.on("data", this.#onData);
    read.on("end", this.#onEnd);
    read.on("error", this.#onError);
    read.on("close", this.#onEnd);
    write.on("error", this.#onError);
    write.on("close", this.#onEnd);
  }
  static async connect(
    read: Readable,
    write: Writable,
    options: WaitOptions = {},
  ): Promise<RuntimeClient> {
    const client = new RuntimeClient(read, write);
    try {
      const info = await client.#rpc<ConnectionInfo>(
        "connection.open",
        { protocolVersion: VERSION },
        options,
      );
      if (
        info.protocolVersion !== VERSION ||
        typeof info.runtimeEpoch !== "string" ||
        typeof info.rootScopeId !== "string" ||
        !Array.isArray(info.capabilities?.methods)
      )
        throw unavailable("invalid Runtime handshake");
      client.#info = info;
      return client;
    } catch (error) {
      client.disconnect();
      throw error;
    }
  }
  get info(): ConnectionInfo {
    if (!this.#info) throw unavailable("Runtime is not initialized");
    return this.#info;
  }
  operationId(): string {
    return `${this.info.runtimeEpoch}:op:${randomUUID()}`;
  }
  supports(method: string): boolean {
    return this.info.capabilities.methods.includes(method);
  }

  #onError = (error: Error) =>
    this.#fail(unavailable(`Runtime transport failed: ${error.message}; outcome may be UNKNOWN`));
  #onEnd = () =>
    this.#fail(unavailable("Runtime transport closed; outcome may be UNKNOWN; do not replay"));
  #onData = (data: Buffer | string) => {
    try {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start),
          end = newline === -1 ? chunk.length : newline;
        if (this.#buffer.length + end - start > MAX_FRAME)
          throw unavailable("Runtime frame exceeds 128 KiB");
        this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(start, end)]);
        if (newline === -1) break;
        const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer));
        this.#buffer = Buffer.alloc(0);
        start = end + 1;
        if (!Number.isSafeInteger(message.id) || "result" in message === "error" in message)
          throw unavailable("invalid Runtime response");
        const pending = this.#pending.get(message.id);
        if (!pending) throw unavailable("unknown Runtime response ID");
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.removeAbort();
        if ("error" in message) {
          if (
            typeof message.error?.code !== "string" ||
            typeof message.error?.message !== "string"
          ) {
            pending.reject(unavailable("invalid Runtime error"));
            throw unavailable("invalid Runtime error");
          }
          pending.reject(
            new RuntimeError(message.error.code, message.error.message, message.error.details),
          );
        } else pending.resolve(message.result);
      }
    } catch (error) {
      this.#fail(
        error instanceof RuntimeError ? error : unavailable("invalid Runtime response encoding"),
      );
    }
  };
  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort();
      pending.reject(error);
    }
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
    this.read.off("data", this.#onData);
    this.read.off("end", this.#onEnd);
    this.read.off("close", this.#onEnd);
    this.write.off("close", this.#onEnd);
    // Keep error listeners until stream destruction completes; late errors must not become uncaught exceptions.
    this.read.destroy();
    this.write.destroy();
  }
  disconnect(): void {
    this.#fail(unavailable("Runtime client disconnected without cleanup confirmation"));
  }
  #rpc<T>(method: string, params: unknown, options: WaitOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(unavailable("Runtime client is closed"));
    if (options.signal?.aborted)
      return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.#info && !this.supports(method))
      return Promise.reject(
        new RuntimeError("UNSUPPORTED", `Runtime does not advertise ${method}`),
      );
    if (this.#pending.size >= (CONTROL.has(method) ? MAX_PENDING : MAX_PENDING - 16))
      return Promise.reject(new RuntimeError("RESOURCE_EXHAUSTED", "Runtime RPC capacity reached"));
    const limits = this.#info?.capabilities.processLimits;
    const wall =
      limits && typeof limits === "object" && !Array.isArray(limits)
        ? limits.wallTimeMs
        : undefined;
    const defaultTimeout =
      EXECUTION.has(method) && typeof wall === "number" && Number.isSafeInteger(wall) && wall > 0
        ? Math.min(MAX_TIMEOUT, wall + DEFAULT_TIMEOUT)
        : DEFAULT_TIMEOUT;
    const timeout = options.timeoutMs ?? defaultTimeout;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT)
      return Promise.reject(new RuntimeError("INVALID_ARGUMENT", "invalid RPC timeout"));
    const id = ++this.#next;
    let frame: string;
    try {
      frame = JSON.stringify({ id, method, params }) + "\n";
    } catch {
      return Promise.reject(
        new RuntimeError("INVALID_ARGUMENT", "arguments must be JSON serializable"),
      );
    }
    if (Buffer.byteLength(frame) - 1 > MAX_FRAME)
      return Promise.reject(new RuntimeError("INVALID_ARGUMENT", "request exceeds 128 KiB"));
    if (this.write.writableLength + Buffer.byteLength(frame) > MAX_FRAME * MAX_PENDING)
      return Promise.reject(new RuntimeError("RESOURCE_EXHAUSTED", "Runtime write queue is full"));
    if (options.signal?.aborted)
      return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      // The pending entry survives abort until the original reply or transport timeout.
      const abort = () =>
        reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(
        () =>
          this.#fail(
            unavailable(
              "Runtime response deadline exceeded; outcome may be UNKNOWN; do not replay",
            ),
          ),
        timeout,
      );
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        removeAbort: () => options.signal?.removeEventListener("abort", abort),
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write.write(frame, (error) => {
          if (error) this.#onError(error);
        });
      } catch (error) {
        this.#onError(error as Error);
      }
    });
  }
  readonly scopes = {
    create: (request: CreateScope, options?: WaitOptions) =>
      this.#rpc<ScopeInfo>("scope.create", request, options),
    get: (scopeId: string, options?: WaitOptions) =>
      this.#rpc<ScopeInfo>("scope.get", { scopeId }, options),
    revoke: (scopeId: string, options?: WaitOptions) =>
      this.#rpc<ScopeInfo>("scope.revoke", { scopeId }, options),
    waitClosed: (scopeId: string, options?: WaitOptions) =>
      this.#rpc<ScopeInfo>("scope.waitClosed", { scopeId }, options),
  };
  readonly owners = {
    revoke: (pluginInstanceId: string, options?: WaitOptions) =>
      this.#rpc<{ pluginInstanceId: string; scopeIds: string[] }>(
        "owner.revoke",
        { pluginInstanceId },
        options,
      ),
  };
  readonly processes = {
    start: (request: StartProcess, options?: WaitOptions) =>
      this.#rpc<ProcessRef>("process.start", request, options),
    get: (processId: string, options?: WaitOptions) =>
      this.#rpc<ProcessInfo>("process.get", { processId }, options),
    terminate: (processId: string, options?: WaitOptions) =>
      this.#rpc<{ accepted: boolean }>("process.terminate", { processId }, options),
    wait: (processId: string, options?: WaitOptions) =>
      this.#rpc<ProcessInfo>("process.wait", { processId }, options),
    resize: (request: ResizeProcess, options?: WaitOptions) =>
      this.#rpc<{ accepted: boolean }>("process.resize", request, options),
    closeStdin: (request: CloseStdin, options?: WaitOptions) =>
      this.#rpc<{ accepted: boolean }>("process.closeStdin", request, options),
    write: (request: ProcessInput, options?: WaitOptions) =>
      this.#rpc<{ accepted: boolean }>("process.write", request, options),
  };
  readonly operations = {
    get: (operationId: string, options?: WaitOptions) =>
      this.#rpc<OperationInfo>("operation.get", { operationId }, options),
  };
  readonly files = {
    execute: <C extends FileCommand>(request: FileRequest<C>, options?: WaitOptions) =>
      this.#rpc<FileResult<C>>("fs.execute", request, options),
  };
  output(request: ReadOutput, options?: WaitOptions): Promise<OutputPage> {
    return this.#rpc("output.read", request, options);
  }
  async *pages(request: ReadOutput, options?: WaitOptions): AsyncGenerator<OutputPage> {
    let after = request.after;
    for (;;) {
      const page = await this.output(
        { ...request, after: after ?? null, waitMs: request.waitMs ?? 1000 },
        options,
      );
      yield page;
      after = page.nextCursor;
      if (page.closed) return;
    }
  }
  async *bytes(
    request: ReadOutput,
    options?: WaitOptions,
  ): AsyncGenerator<{
    stream: OutputStream;
    bytes: Uint8Array;
    cursor: string;
  }> {
    for await (const page of this.pages(request, options)) {
      if (page.gap || page.truncated) throw new OutputGapError(page);
      for (const chunk of page.chunks)
        yield {
          stream: chunk.stream,
          bytes: decodeBase64(chunk.dataBase64),
          cursor: chunk.cursor,
        };
    }
  }
  async *text(
    request: ReadOutput,
    options?: WaitOptions,
  ): AsyncGenerator<{ stream: OutputStream; text: string }> {
    const decoders = {
      stdout: new TextDecoder(),
      stderr: new TextDecoder(),
      pty: new TextDecoder(),
    };
    for await (const chunk of this.bytes(request, options)) {
      const text = decoders[chunk.stream].decode(chunk.bytes, { stream: true });
      if (text) yield { stream: chunk.stream, text };
    }
    for (const stream of ["stdout", "stderr", "pty"] as const) {
      const text = decoders[stream].decode();
      if (text) yield { stream, text };
    }
  }
  close(): Promise<void> {
    return (this.#closing ??= this.#rpc<{ closed: boolean }>(
      "connection.close",
      {},
      { timeoutMs: 15000 },
    ).then((result) => {
      if (result?.closed !== true) {
        const error = unavailable("invalid Runtime cleanup acknowledgement");
        this.#fail(error);
        throw error;
      }
      this.#fail(unavailable("Runtime closed with cleanup acknowledgement"));
    }));
  }
}

export function decodeBase64(encoded: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw unavailable("invalid base64 output");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw unavailable("noncanonical base64 output");
  return bytes;
}
