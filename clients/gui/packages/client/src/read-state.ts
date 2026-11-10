import { record } from "./bootstrap.js";

import type {
  ShellSubscriptionResult,
  ConversationOpenResult,
  ConversationMediaParams,
  ShellProject,
  ShellView,
  SourceNavigation,
  NavigationMetadata,
  NavigationSummary,
  WorktreeDisplay,
  NavigationPreferences,
} from "./protocol.js";
export type {
  ShellProject,
  ShellView,
  SourceNavigation,
  NavigationMetadata,
  NavigationSummary,
  WorktreeDisplay,
  NavigationPreferences,
} from "./protocol.js";
export type JsonObject = import("./protocol.js").NativeCoreObject;
export type SubscriptionIdentity = Pick<
  ShellSubscriptionResult,
  "connectionId" | "gatewayGeneration" | "subscriptionId" | "sequence"
>;
export type ShellRead = ShellSubscriptionResult;
export type SessionRead = ConversationOpenResult;
export type Fresh<T> =
  | { state: "loading" | "unavailable"; previous?: T; error?: string }
  | { state: "stale"; value: T; error?: string }
  | { state: "fresh"; value: T };
export type ReadSnapshot = { shell: Fresh<ShellRead>; session: Fresh<SessionRead> };
export const SESSION_READ_CACHE_MS = 3 * 60 * 1000;
export const SESSION_READ_CACHE_LIMIT = 8;
export function sessionReadKey(
  host: { hostId: string; hostGeneration: string },
  session: Pick<SessionRead, "projectId" | "serviceGeneration" | "threadId"> &
    Partial<Pick<SessionRead, "access">>,
): string {
  return JSON.stringify([
    host.hostId,
    host.hostGeneration,
    session.projectId,
    session.serviceGeneration,
    session.threadId,
    session.access?.kind === "persisted" ? session.access.snapshotId : null,
  ]);
}
export function previous<T>(state: Fresh<T>): T | undefined {
  return "value" in state ? state.value : state.previous;
}
export function stale<T>(state: Fresh<T>, error?: string): Fresh<T> {
  const value = previous(state);
  return value ? { state: "stale", value, error } : { state: "unavailable", error };
}
export function identity(value: unknown): value is SubscriptionIdentity & JsonObject {
  return (
    record(value) &&
    [value.connectionId, value.gatewayGeneration, value.subscriptionId].every(
      (v) => typeof v === "string" && !!v,
    ) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0
  );
}
function keyed<T>(old: T[], upsert: T[], remove: string[], key: (value: T) => string) {
  const changes = new Map(upsert.map((v) => [key(v), v]));
  const removed = new Set(remove);
  const result = old
    .filter((v) => !removed.has(key(v)))
    .map((v) => {
      const replacement = changes.get(key(v));
      changes.delete(key(v));
      return replacement ?? v;
    });
  return [...result, ...changes.values()];
}
export function applyShellDelta(current: ShellView, delta: unknown): ShellView {
  if (
    !record(delta) ||
    !record(delta.projects) ||
    !record(delta.navigation) ||
    !Array.isArray(delta.projects.upsert) ||
    !Array.isArray(delta.projects.remove) ||
    !Array.isArray(delta.navigation.upsert) ||
    !Array.isArray(delta.navigation.remove)
  )
    throw new Error("Invalid shell delta");
  const patch = readShell({ projects: delta.projects.upsert, navigation: delta.navigation.upsert });
  if (
    !delta.projects.remove.every((v) => typeof v === "string") ||
    !delta.navigation.remove.every((v) => typeof v === "string")
  )
    throw new Error("Invalid shell removal");
  return {
    projects: keyed(current.projects, patch.projects, delta.projects.remove, (v) => v.projectId),
    navigation: keyed(
      current.navigation,
      patch.navigation,
      delta.navigation.remove,
      (v) => v.sourceId,
    ),
  };
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function metadata(value: unknown): value is NavigationMetadata {
  return (
    record(value) &&
    ["name", "title", "sectionId", "completionId", "scheduledCompletionId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["pinned", "unread", "hidden"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.threadOrder === undefined || strings(value.threadOrder))
  );
}
function metadataMap(value: unknown): value is Record<string, NavigationMetadata> {
  return record(value) && Object.values(value).every(metadata);
}
function summary(value: unknown): value is NavigationSummary {
  return (
    record(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    ["parentThreadId", "name", "preview"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["createdAt", "updatedAt"].every(
      (key) =>
        value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key])),
    ) &&
    (value.conversation === undefined ||
      (record(value.conversation) && typeof value.conversation.kind === "string")) &&
    record(value.desktop) &&
    typeof value.desktop.archived === "boolean"
  );
}
function worktree(value: unknown): value is WorktreeDisplay {
  return (
    record(value) &&
    ["state", "directory", "checkoutRoot", "branch", "base", "sourceRoot", "requestId"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.automatic === "boolean"
  );
}
function shellProject(p: unknown): p is ShellProject {
  return (
    record(p) &&
    typeof p.projectId === "string" &&
    typeof p.workspace === "string" &&
    typeof p.state === "string" &&
    typeof p.projectless === "boolean" &&
    (p.serviceGeneration === undefined || typeof p.serviceGeneration === "string") &&
    (p.logicalProjectId === undefined || typeof p.logicalProjectId === "string") &&
    (p.worktree === undefined || worktree(p.worktree)) &&
    (p.alias === undefined ||
      (record(p.alias) &&
        typeof p.alias.sourceId === "string" &&
        typeof p.alias.projectId === "string")) &&
    record(p.summaries) &&
    ["fresh", "cached", "unknown"].includes(String(p.summaries.state)) &&
    Array.isArray(p.summaries.items) &&
    p.summaries.items.every(summary) &&
    record(p.attention) &&
    (p.attention.state === "unknown" ||
      (p.attention.state === "fresh" &&
        Number.isSafeInteger(p.attention.count) &&
        Number(p.attention.count) >= 0))
  );
}
function preferences(value: unknown): value is NavigationPreferences {
  return (
    record(value) &&
    ["sidebarSort", "sidebarSortChats", "sidebarSortProjects", "sidebarSortPinned"].every(
      (key) =>
        value[key] === undefined ||
        ["manual", "priority", "updated_at"].includes(String(value[key])),
    ) &&
    ["showPinned", "showCompleted"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    )
  );
}
function navigation(n: unknown): n is SourceNavigation {
  return (
    record(n) &&
    typeof n.sourceId === "string" &&
    ["available", "unknown"].includes(String(n.state)) &&
    Array.isArray(n.bindings) &&
    n.bindings.every(
      (b) =>
        record(b) &&
        typeof b.projectId === "string" &&
        typeof b.alias === "string" &&
        typeof b.projectless === "boolean" &&
        (b.logicalProjectId === undefined || typeof b.logicalProjectId === "string"),
    ) &&
    preferences(n.preferences) &&
    metadataMap(n.projects) &&
    metadataMap(n.threads) &&
    strings(n.projectOrder) &&
    Array.isArray(n.sections) &&
    n.sections.every(
      (section) =>
        record(section) && typeof section.id === "string" && typeof section.title === "string",
    ) &&
    strings(n.sidebarThreadOrder) &&
    Number.isSafeInteger(n.sidebarRevision)
  );
}
export function readShell(value: unknown): ShellView {
  if (
    !record(value) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.navigation) ||
    !value.projects.every(shellProject) ||
    !value.navigation.every(navigation)
  )
    throw new Error("Invalid shell snapshot");
  if (
    new Set(value.projects.map((p) => p.projectId)).size !== value.projects.length ||
    new Set(value.navigation.map((n) => n.sourceId)).size !== value.navigation.length
  )
    throw new Error("Duplicate shell identity");
  return { projects: value.projects, navigation: value.navigation };
}
function ordered(values: JsonObject[], order: unknown): JsonObject[] {
  if (order === undefined) return values;
  if (
    !Array.isArray(order) ||
    !order.every((v) => typeof v === "string") ||
    new Set(order).size !== order.length
  )
    throw new Error("Invalid conversation order");
  const byId = new Map(values.map((v) => [v.id, v]));
  return order.map((id) => {
    const value = byId.get(id);
    if (!value) throw new Error("Missing conversation entry");
    return value;
  });
}
function nodes(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || !value.every((v) => record(v) && typeof v.id === "string"))
    throw new Error("Invalid conversation entries");
  if (new Set(value.map((node) => node.id)).size !== value.length)
    throw new Error("Duplicate conversation identity");
  return value;
}
export function applyConversationPatch(snapshot: JsonObject, patch: unknown): JsonObject {
  if (!record(snapshot.thread) || !record(patch) || !Array.isArray(patch.turns))
    throw new Error("Invalid conversation patch");
  const oldTurns = nodes(snapshot.thread.turns);
  const turns = new Map(oldTurns.map((v) => [v.id, v]));
  for (const turn of patch.turns) {
    if (!record(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items))
      throw new Error("Invalid turn patch");
    if (turn.head !== undefined && (!record(turn.head) || turn.head.id !== turn.id))
      throw new Error("Invalid turn head");
    const old = turns.get(turn.id);
    if (!old && (!record(turn.head) || !Array.isArray(turn.order)))
      throw new Error("Incomplete new turn");
    const items = new Map(nodes(old?.items ?? []).map((v) => [v.id, v]));
    for (const item of turn.items) {
      if (
        !record(item) ||
        typeof item.id !== "string" ||
        !record(item.value) ||
        item.value.id !== item.id
      )
        throw new Error("Invalid item patch");
      items.set(item.id, item.value);
    }
    const next = {
      ...(record(turn.head) ? turn.head : old),
      id: turn.id,
      items: ordered([...items.values()], turn.order),
    };
    turns.set(turn.id, next);
  }
  if (
    patch.head !== undefined &&
    (!record(patch.head) ||
      !record(patch.head.thread) ||
      patch.head.thread.id !== snapshot.thread.id)
  )
    throw new Error("Invalid conversation head");
  const head = record(patch.head) ? patch.head : snapshot;
  const threadHead = record(head.thread) ? head.thread : snapshot.thread;
  return { ...head, thread: { ...threadHead, turns: ordered([...turns.values()], patch.order) } };
}

export type MediaSource = Pick<
  ConversationMediaParams,
  "sourceThreadId" | "turnId" | "itemId" | "uri"
>;
export type MediaBytes = { mime: string; bytes: Uint8Array };
