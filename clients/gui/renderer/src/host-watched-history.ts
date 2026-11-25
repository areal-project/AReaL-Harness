import type { HostClient, SessionRead } from "@areal/client";
import { projectReadingWindow, type ReadingWindow } from "./host-snapshot.js";
import { refreshReadingWindow } from "./host-history-cache.js";
import type { Observation } from "./host-services.js";

export function createWatchedHistory(
  client: HostClient,
  readObservationResult: (value: unknown) => Observation,
) {
  const windows = new Map<string, ReadingWindow>();
  const projected = new WeakMap<
    ReadingWindow,
    { version: number; session: SessionRead; freshness: string; thread: Observation["thread"] }
  >();
  function watchedThreads(version: number) {
    const snapshots = client.watchedSnapshot();
    for (const key of windows.keys()) if (!snapshots.has(key)) windows.delete(key);
    const threads = new Map<string, Observation["thread"][]>();
    for (const [key, read] of snapshots) {
      const session = "value" in read ? read.value : read.previous;
      if (!session) continue;
      let window = windows.get(key);
      if (window?.session !== session) {
        try {
          window = refreshReadingWindow(window, session, readObservationResult(session.snapshot));
          windows.set(key, window);
        } catch {
          windows.delete(key);
          continue;
        }
      }
      let cached = projected.get(window);
      if (
        cached?.session !== session ||
        cached.version !== version ||
        cached.freshness !== read.state
      ) {
        cached = {
          session,
          version,
          freshness: read.state,
          thread: projectReadingWindow(window.observation.thread, window, read.state),
        };
        projected.set(window, cached);
      }
      const values = threads.get(session.projectId) ?? [];
      values.push(cached.thread);
      threads.set(session.projectId, values);
    }
    return threads;
  }
  function current(owner: ReadingWindow) {
    const key = `${owner.session.projectId}:${owner.session.threadId}`;
    const current = client.watchedSnapshot().get(key);
    return (
      windows.get(key) === owner &&
      current?.state === "fresh" &&
      current.value.subscriptionId === owner.session.subscriptionId
    );
  }
  function find(generation: string) {
    return [...windows.values()].find((owner) => owner.viewGeneration === generation);
  }
  function watch(
    target: { projectId: string; threadId: string },
    ids: Map<string, string>,
    threadTargets: Map<string, string>,
  ) {
    const projectId =
      threadTargets.get(`${target.projectId}:${target.threadId}`) ??
      [...ids].find(([, alias]) => alias === target.projectId)?.[0] ??
      target.projectId;
    const key = `${projectId}:${target.threadId}`;
    const release = client.watchSession({ projectId, threadId: target.threadId });
    return () => {
      release();
      if (!client.watchedSnapshot().has(key)) windows.delete(key);
    };
  }
  function resolveWatched(
    target: { projectId: string; threadId: string } | undefined,
    session: SessionRead | undefined,
    ids: Map<string, string>,
    threadTargets: Map<string, string>,
  ) {
    const projectId =
      target &&
      (threadTargets.get(`${target.projectId}:${target.threadId}`) ??
        [...ids].find(([, alias]) => alias === target.projectId)?.[0] ??
        target.projectId);
    const watchedTarget =
      target &&
      projectId &&
      (session?.projectId !== projectId || session.threadId !== target.threadId)
        ? { projectId, threadId: target.threadId }
        : undefined;
    const key = watchedTarget ? `${watchedTarget.projectId}:${watchedTarget.threadId}` : undefined;
    const watched = key ? client.watchedSnapshot().get(key) : undefined;
    if (key && watched?.state !== "fresh") throw new Error("Conversation unavailable");
    const owner = watched?.state === "fresh" ? watched.value : session;
    const auxiliary = key ? windows.get(key) : undefined;
    if (key && (!auxiliary || auxiliary.session.subscriptionId !== owner?.subscriptionId))
      throw new Error("Conversation unavailable");
    return { watchedTarget, owner, watchedObservation: auxiliary?.observation, auxiliary };
  }
  function reservedBytes(foreground: Map<string, ReadingWindow>) {
    return [...foreground.values(), ...windows.values()].reduce(
      (sum, value) =>
        sum +
        [...value.items.values()].reduce((n, item) => n + item.bytes, 0) +
        [...value.loading.values()].reduce((n, bytes) => n + bytes, 0),
      0,
    );
  }
  return { watchedThreads, resolveWatched, reservedBytes, watch, current, find };
}
