import type { Action, Data } from "./services.js";

const stops = new Map<string, { requestId: string; promise: Promise<void> }>();
const ownerKey = (projectId: string, threadId: string) => `${projectId}:${threadId}:`;
export function releaseSettledStops(projectId: string, thread: Data) {
  const prefix = ownerKey(projectId, thread.id);
  const active = new Set((thread.turns ?? []).filter((turn: Data) => turn.status === "inProgress").map((turn: Data) => `${prefix}${turn.id}`));
  for (const key of stops.keys()) if (key.startsWith(prefix) && !active.has(key)) stops.delete(key);
}
export function stopConversationTurn(action: Action, project: Data, thread: Data): Promise<void> {
  const turn = thread.turns?.find((item: Data) => item.status === "inProgress");
  if (!turn) return Promise.resolve();
  const key = `${ownerKey(project.id, thread.id)}${turn.id}`;
  const existing = stops.get(key);
  if (existing) return existing.promise;
  if (project.pending?.some((entry: Data) => entry.params?.threadId === thread.id && entry.params?.turnId === turn.id
    && /interrupt|stop/i.test(entry.method ?? entry.operation?.method ?? ""))) return Promise.resolve();
  const requestId = crypto.randomUUID();
  const promise = action("stop", { projectId: project.id, threadId: thread.id, turnId: turn.id, requestId }).then(() => {}).catch(cause => {
    if (cause.outcome?.kind === "rejected" || cause.outcome?.kind === "noMutation") stops.delete(key);
    throw cause;
  });
  stops.set(key, { requestId, promise });
  return promise;
}
