import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";
import { FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import type { FsInfo, FsObservation, FsTarget, FsWriteIntent } from "@deepseek-ai/dsh-fs";

export const PROTOCOL_VERSION = 1;
const MAX_FRAME = 128 * 1024;
const MAX_FILE = 32 * 1024;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };

/** Registry-ready output of DSH defineTool(). Only text rendering is supported. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: RecordValue;
  output: {
    schema: RecordValue;
    render(args: RecordValue, value: Json): { type: string; text?: string }[];
  };
  execute(args: RecordValue, context: { signal: AbortSignal }): Promise<Json>;
}

/** A selected DSH module. Unsupported Context services fail at registration/use. */
export interface PluginModule {
  name?: string;
  inject?: readonly string[];
  apply(context: never, config: never): void | Promise<void>;
}

export interface PluginOptions {
  plugin: PluginModule;
  config?: unknown;
  /** Explicit model-facing command subset, also enforced at execution. */
  commands?: Readonly<Record<string, readonly string[]>>;
  input?: Readable;
  output?: Writable;
}

interface Call {
  id: string;
  threadId: string;
  abort: AbortController;
  snapshots: Map<string, { text: string; hash: string }>;
  observed: Map<string, FsObservation>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected object");
  return value as Record<string, unknown>;
}
function deny(service: string): never {
  throw new Error(`Unsupported plugin capability: ${service}`);
}
function frozenServices<T extends object>(value: T): T {
  return new Proxy(Object.freeze(value), {
    get(target, key, receiver) {
      if (key === "then") return undefined;
      if (!Object.hasOwn(target, key)) return deny(String(key));
      return Reflect.get(target, key, receiver);
    },
    set() {
      return deny("service replacement");
    },
    defineProperty() {
      return deny("service replacement");
    },
    deleteProperty() {
      return deny("service replacement");
    },
  });
}

/** Serve one trusted plugin over Core-owned pipes. Never receives a Runtime client. */
export async function servePlugin(options: PluginOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const tools = new Map<string, ToolDefinition>();
  const definitions: RecordValue[] = [];
  const observations = new Map<string, Map<string, FsObservation>>();
  const targets = new WeakMap<FsTarget, string>();
  const pending = new Map<
    number,
    { resolve(value: RecordValue): void; reject(error: Error): void }
  >();
  const calls = new AsyncLocalStorage<Call>();
  let active: Call | undefined;
  let registering = true;
  let nextRequest = 0;
  let writes = Promise.resolve();
  function send(value: unknown): Promise<void> {
    const line = Buffer.from(JSON.stringify(value) + "\n");
    if (line.length > MAX_FRAME) throw new Error("plugin frame exceeds 128 KiB");
    writes = writes.then(
      () =>
        new Promise<void>((resolve, reject) =>
          output.write(line, (error) => (error ? reject(error) : resolve())),
        ),
    );
    return writes;
  }
  function call(): Call {
    const current = calls.getStore();
    if (!current || current !== active || current.abort.signal.aborted)
      throw new Error("no active plugin call");
    return current;
  }
  function pathOf(target: FsTarget): string {
    const path = targets.get(target);
    if (!path) throw new Error("file target must come from ctx.fs.resolve");
    return path;
  }
  async function file(command: RecordValue): Promise<RecordValue> {
    const current = call();
    if (pending.size >= 16) throw new Error("plugin file concurrency exceeds 16");
    const requestId = ++nextRequest;
    const promise = new Promise<RecordValue>((resolve, reject) =>
      pending.set(requestId, { resolve, reject }),
    );
    await send({ type: "file", callId: current.id, requestId, command });
    return promise;
  }
  async function snapshot(target: FsTarget): Promise<{ text: string; hash: string }> {
    const current = call();
    const path = pathOf(target);
    const existing = current.snapshots.get(path);
    if (existing) return existing;
    const value = await file({ kind: "read", path, offset: 0, maxBytes: MAX_FILE });
    if (!value.eof || typeof value.size !== "number" || value.size > MAX_FILE)
      throw new FsError("plugin files are limited to 32 KiB", "FS_NOT_REGULAR_FILE");
    const bytes = Buffer.from(String(value.dataBase64), "base64");
    const result = {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      hash: String(value.sha256),
    };
    current.snapshots.set(path, result);
    return result;
  }
  const fs = frozenServices({
    sandboxMode: "workspace-write",
    async resolve(path: string): Promise<FsTarget> {
      call();
      if (
        path !== "/repo" &&
        (!path.startsWith("/repo/") ||
          path
            .slice(6)
            .split("/")
            .some((p) => !p || p === "." || p === ".."))
      )
        throw new FsError("path must be within /repo", "FS_SANDBOX_DENIED");
      if (path.includes("\\") || path.includes("\0") || path.length > 1024)
        throw new FsError("invalid plugin path", "FS_SANDBOX_DENIED");
      const uri = "workspace://repo" + path.slice(5);
      const target = Object.freeze({ targetKey: FsTargetKey(randomUUID()), displayPath: path });
      targets.set(target, uri);
      return target;
    },
    async stat(target: FsTarget): Promise<FsInfo | undefined> {
      try {
        const info = await file({ kind: "stat", path: pathOf(target) });
        if (info.kind !== "file")
          throw new FsError("only regular UTF-8 files are supported", "FS_NOT_REGULAR_FILE");
        const value = await snapshot(target);
        return {
          type: "file",
          version: FsVersion(value.hash),
          size: Buffer.byteLength(value.text),
        };
      } catch (error) {
        if (error instanceof FsError && error.code === "FS_NOT_FOUND") return undefined;
        throw error;
      }
    },
    async readText(target: FsTarget): Promise<string> {
      return (await snapshot(target)).text;
    },
    async writeText(target: FsTarget, text: string, intent?: FsWriteIntent) {
      const current = call();
      const path = pathOf(target);
      if (Buffer.byteLength(text) > MAX_FILE) throw new Error("plugin files are limited to 32 KiB");
      if (!intent) throw new Error("unconditional file writes are not supported");
      const before = current.snapshots.get(path)?.text ?? null;
      const expected: RecordValue =
        intent.kind === "createIfAbsent"
          ? { kind: "absent" }
          : { kind: "sha256", value: intent.version };
      const value = await file({
        kind: "write",
        path,
        dataBase64: Buffer.from(text).toString("base64"),
        expected,
      });
      current.snapshots.set(path, { text, hash: String(value.sha256) });
      return {
        operation: intent.kind === "createIfAbsent" ? "create" : "update",
        version: FsVersion(String(value.sha256)),
        before,
        after: text,
      };
    },
  });
  const service = frozenServices({
    register(definition: ToolDefinition): () => void {
      if (!registering || tools.size >= 32 || tools.has(definition.name))
        throw new Error("tool registration is closed, duplicated or exceeds 32");
      if (
        typeof definition.execute !== "function" ||
        typeof definition.output?.render !== "function"
      )
        throw new Error("tool execution and text rendering are required");
      const schema = structuredClone(definition.parameters);
      const commands = options.commands?.[definition.name];
      if (commands) {
        const command = record(record(schema.properties).command);
        if (
          !commands.length ||
          !Array.isArray(command.enum) ||
          commands.some((c) => !(command.enum as unknown[]).includes(c))
        )
          throw new Error("invalid command subset");
        command.enum = [...commands];
        command.description = `Allowed commands: ${commands.join(", ")}.`;
      }
      tools.set(definition.name, definition);
      definitions.push({
        name: definition.name,
        description: definition.description,
        inputSchema: schema,
        outputSchema: definition.output.schema,
      });
      return () => {
        if (!registering) deny("dynamic tool removal");
        tools.delete(definition.name);
        const index = definitions.findIndex((item) => item.name === definition.name);
        if (index !== -1) definitions.splice(index, 1);
      };
    },
  });
  const sandboxPolicy = frozenServices({
    resolve: () => Object.freeze({ mode: "workspace-write" }),
  });
  if (
    !Array.isArray(options.plugin.inject) ||
    options.plugin.inject.some((name) => !["tools", "fs", "sandboxPolicy"].includes(name))
  )
    deny("declared service dependencies");
  const services: Record<string, unknown> = { tools: service };
  if (options.plugin.inject.includes("fs")) {
    services.fs = fs;
    services.sandboxPolicy = sandboxPolicy;
  } else if (options.plugin.inject.includes("sandboxPolicy"))
    services.sandboxPolicy = sandboxPolicy;
  const context = frozenServices({
    ...services,
    get(name: string): unknown {
      if (!Object.hasOwn(services, name)) return deny(name);
      return services[name];
    },
    emit(event: string, target: FsTarget, observation: FsObservation): void {
      if (event !== "fs/observed") deny(event);
      const current = call();
      const path = pathOf(target);
      if (
        observation.kind === "present" &&
        current.snapshots.get(path)?.hash !== observation.version
      )
        throw new Error("observation does not match the read snapshot");
      current.observed.set(path, observation);
    },
    async waterfall(event: string, target: FsTarget): Promise<FsWriteIntent> {
      if (event !== "fs/edit-intent" && event !== "fs/write-intent") deny(event);
      const observed = observations.get(call().threadId)?.get(pathOf(target));
      if (event === "fs/write-intent" && observed?.kind === "absent")
        return { kind: "createIfAbsent" };
      if (observed?.kind !== "present")
        throw new FsError("Read the file before editing it.", "FS_NOT_OBSERVED");
      return { kind: "replaceIfVersion", version: observed.version };
    },
  });
  await options.plugin.apply(context as never, (options.config ?? {}) as never);
  registering = false;
  if (!tools.size) throw new Error("plugin registered no tools");
  await send({ protocolVersion: PROTOCOL_VERSION, tools: definitions });

  async function invoke(message: Record<string, unknown>): Promise<void> {
    if (active) throw new Error("concurrent Host calls are not supported");
    const params = record(message.params);
    if (typeof message.callId !== "string" || typeof params.threadId !== "string")
      throw new Error("invalid call identity");
    const current: Call = {
      id: message.callId,
      threadId: params.threadId,
      abort: new AbortController(),
      snapshots: new Map(),
      observed: new Map(),
    };
    active = current;
    await calls.run(current, async () => {
      let response: unknown;
      try {
        const toolName = String(params.tool);
        const tool = tools.get(toolName);
        if (!tool) throw new Error("unknown tool");
        const args = record(params.arguments) as RecordValue;
        const commands = options.commands?.[toolName];
        if (commands && !commands.includes(String(args.command)))
          throw new Error("unsupported tool command");
        const value = await tool.execute(args, Object.freeze({ signal: current.abort.signal }));
        const rendered = tool.output.render(args, value);
        if (rendered.some((part) => part.type !== "text" || typeof part.text !== "string"))
          throw new Error("only text tool results are supported");
        response = {
          success: true,
          structuredContent: value,
          contentItems: rendered.map((part) => ({ type: "inputText", text: part.text })),
        };
        // 为 128 KiB 传输帧中的调用标识和协议封套保留空间。
        if (Buffer.byteLength(JSON.stringify(response)) > 96 * 1024)
          throw new Error("plugin result exceeds 96 KiB");
        const saved = observations.get(current.threadId) ?? new Map<string, FsObservation>();
        for (const [path, value] of current.observed) {
          if (saved.size >= 128) saved.delete(saved.keys().next().value!);
          saved.set(path, value);
        }
        if (observations.size >= 512) observations.delete(observations.keys().next().value!);
        observations.set(current.threadId, saved);
      } catch (error) {
        const text = String(error).slice(0, 1024);
        response = { success: false, contentItems: [{ type: "inputText", text }] };
      }
      if (pending.size) throw new Error("plugin returned with pending file requests");
      active = undefined;
      await send({ type: "result", callId: current.id, response });
    });
  }
  let buffer = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > MAX_FRAME) throw new Error("Core frame exceeds 128 KiB");
        const message = record(JSON.parse(buffer.subarray(0, end).toString("utf8")));
        buffer = buffer.subarray(end + 1);
        if (message.type === "fileResult") {
          if (!active || message.callId !== active.id || typeof message.requestId !== "number")
            throw new Error("stale file reply");
          const waiter = pending.get(message.requestId);
          if (!waiter) throw new Error("unknown file reply");
          pending.delete(message.requestId);
          if (message.error) {
            const error = record(message.error);
            const codes = {
              NOT_FOUND: "FS_NOT_FOUND",
              CONFLICT: "FS_STALE_VERSION",
              PERMISSION_DENIED: "FS_SANDBOX_DENIED",
            } as const;
            waiter.reject(
              new FsError(
                String(error.message),
                codes[error.code as keyof typeof codes] ?? "FS_NOT_REGULAR_FILE",
              ),
            );
          } else waiter.resolve(record(message.result) as RecordValue);
        } else if (message.type === "call") {
          if (active) throw new Error("Core must serialize calls per Host");
          void invoke(message).catch((error) => {
            input.destroy(error as Error);
          });
        } else throw new Error("unknown Core message");
      }
      if (buffer.length > MAX_FRAME) throw new Error("Core frame exceeds 128 KiB");
    }
    if (buffer.length) throw new Error("truncated Core frame");
  } finally {
    active?.abort.abort();
    for (const waiter of pending.values()) waiter.reject(new Error("Core disconnected"));
    pending.clear();
  }
}
