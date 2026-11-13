import type { ConversationOpenParams } from "./protocol.js";
import { record } from "./bootstrap.js";
import {
  applyConversationPatch,
  identity,
  stale,
  type Fresh,
  type JsonObject,
  type SessionRead,
  type ShellProject,
} from "./read-state.js";
import type { ReadConnectionIdentity, ReadTransport } from "./index.js";

/** 选中会话之外的附加观察，例如侧边讨论；键为 `${projectId}:${threadId}`。 */
export type WatchedSessions = ReadonlyMap<string, Fresh<SessionRead>>;
type Target = { projectId: string; threadId: string };
type Watched = { target: Target; refs: number; read: Fresh<SessionRead>; generation: number };
type Owner = {
  transport(): ReadTransport | undefined;
  connection(): ReadConnectionIdentity | undefined;
  project(projectId: string): ShellProject | undefined;
  changed(): void;
};

/** 同一会话多次观察只开一个订阅；连接或项目代次变化后重开，序号断档或失效时重读基线。 */
export class WatchedSessionSet {
  #entries = new Map<string, Watched>();
  view: WatchedSessions = new Map();
  constructor(private readonly owner: Owner) {}

  watch(target: Target) {
    const key = `${target.projectId}:${target.threadId}`;
    const existing = this.#entries.get(key);
    if (existing) existing.refs++;
    else {
      this.#entries.set(key, { target, refs: 1, read: { state: "loading" }, generation: 0 });
      this.#publish();
      void this.#open(key).catch(() => {});
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = this.#entries.get(key);
      if (!entry || --entry.refs > 0) return;
      this.#entries.delete(key);
      entry.generation++;
      const value = entry.read.state === "fresh" ? entry.read.value : undefined;
      const transport = this.owner.transport();
      if (value && transport)
        void transport
          .request(
            "subscription.close",
            { subscriptionId: value.subscriptionId },
            { projectId: value.projectId, serviceGeneration: value.serviceGeneration },
          )
          .catch(() => {});
      this.#publish();
    };
  }

  markStale() {
    if (!this.#entries.size) return;
    for (const entry of this.#entries.values()) entry.read = stale(entry.read);
    this.#publish();
  }

  reopen(changed?: (projectId: string) => boolean) {
    if (!this.#entries.size) return;
    for (const [key, entry] of this.#entries) {
      if (changed && !changed(entry.target.projectId)) continue;
      if (entry.read.state === "fresh") entry.read = stale(entry.read);
      void this.#open(key).catch(() => {});
    }
    this.#publish();
  }

  clear() {
    this.#entries.clear();
  }

  /** 属于某个附加观察的事件在这里消费，返回 true；其余交回选中会话处理。 */
  accept(event: JsonObject & { subscriptionId: string; sequence: number }) {
    for (const [key, entry] of this.#entries) {
      if (entry.read.state !== "fresh") continue;
      const current = entry.read.value;
      const fields = [
        "connectionId",
        "gatewayGeneration",
        "subscriptionId",
        "projectId",
        "serviceGeneration",
      ] as const;
      if (fields.some((field) => event[field] !== current[field])) continue;
      if (event.sequence <= current.sequence) return true;
      if (
        event.sequence !== current.sequence + 1 ||
        event.threadId !== current.threadId ||
        event.event === "session.invalidated"
      ) {
        this.#reload(key, entry);
        return true;
      }
      try {
        this.#set(key, entry, {
          state: "fresh",
          value: {
            ...current,
            sequence: event.sequence,
            snapshot: applyConversationPatch(current.snapshot, event.patch),
          },
        });
      } catch {
        this.#reload(key, entry);
      }
      return true;
    }
    return false;
  }

  #publish() {
    this.view = new Map([...this.#entries].map(([key, entry]) => [key, entry.read]));
    this.owner.changed();
  }
  #set(key: string, entry: Watched, read: Fresh<SessionRead>) {
    if (this.#entries.get(key) !== entry) return;
    entry.read = read;
    this.#publish();
  }
  #reload(key: string, entry: Watched) {
    this.#set(key, entry, stale(entry.read));
    void this.#open(key).catch(() => {});
  }

  async #open(key: string): Promise<void> {
    const entry = this.#entries.get(key);
    if (!entry) return;
    const generation = ++entry.generation;
    const transport = this.owner.transport();
    const connection = this.owner.connection();
    if (!transport || !connection) return;
    const project = this.owner.project(entry.target.projectId);
    if (!project?.serviceGeneration || project.state !== "ready") {
      this.#set(key, entry, stale(entry.read, "Project Core unavailable"));
      return;
    }
    const context = {
      projectId: entry.target.projectId,
      serviceGeneration: project.serviceGeneration,
    };
    const current = () =>
      this.#entries.get(key) === entry &&
      entry.generation === generation &&
      transport === this.owner.transport();
    try {
      const value = await transport.request(
        "session.watch",
        { threadId: entry.target.threadId, view: "conversation" } satisfies ConversationOpenParams,
        context,
      );
      if (!current()) {
        if (identity(value))
          void transport
            .request("subscription.close", { subscriptionId: value.subscriptionId }, context)
            .catch(() => {});
        return;
      }
      const live = this.owner.connection();
      if (
        !identity(value) ||
        value.sequence !== 0 ||
        value.projectId !== entry.target.projectId ||
        value.threadId !== entry.target.threadId ||
        value.serviceGeneration !== context.serviceGeneration ||
        value.view !== "conversation" ||
        !record(value.snapshot) ||
        value.connectionId !== live?.connectionId ||
        value.gatewayGeneration !== live?.gatewayGeneration
      )
        throw new Error("Invalid conversation baseline");
      this.#set(key, entry, {
        state: "fresh",
        value: {
          ...value,
          ...context,
          threadId: entry.target.threadId,
          view: "conversation",
          snapshot: value.snapshot,
        },
      });
    } catch (error) {
      if (current())
        this.#set(
          key,
          entry,
          stale(entry.read, error instanceof Error ? error.message : "Conversation unavailable"),
        );
      throw error;
    }
  }
}
