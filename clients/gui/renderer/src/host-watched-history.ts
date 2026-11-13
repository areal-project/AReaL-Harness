import type { HostClient, SessionRead } from "@areal/client";
import { createWatchedThreads, type ReadingWindow } from "./host-snapshot.js";
import type { Observation } from "./host-services.js";

export function createWatchedHistory(
  client: HostClient,
  readObservationResult: (value: unknown) => Observation,
) {
  const readWatchedThreads = createWatchedThreads(
    () => client.watchedSnapshot().values(),
    (value) => readObservationResult(value).thread,
  );
  const watchedBodies = new Map<
    string,
    {
      subscriptionId: string;
      items: ReadingWindow["items"];
      loading: Map<string, number>;
    }
  >();
  function watchedThreads() {
    const threads = readWatchedThreads();
    for (const [projectId, values] of threads) {
      threads.set(
        projectId,
        values.map((thread) => {
          const key = `${projectId}:${thread.id}`;
          const read = client.watchedSnapshot().get(key);
          const bodies = watchedBodies.get(key);
          if (
            read?.state !== "fresh" ||
            !bodies ||
            bodies.subscriptionId !== read.value.subscriptionId
          ) {
            watchedBodies.delete(key);
            return thread;
          }
          return {
            ...thread,
            turns: thread.turns.map((turn) => ({
              ...turn,
              items: turn.items.map((item) => {
                const body = bodies.items.get(item.id);
                return item.type === "historyDeferred" && body && body.version === item.version
                  ? body.entry.item
                  : item;
              }),
            })),
          };
        }),
      );
    }
    return threads;
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
      if (!client.watchedSnapshot().has(key)) watchedBodies.delete(key);
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
    const watchedObservation =
      watched?.state === "fresh" ? readObservationResult(watched.value.snapshot) : undefined;
    let auxiliary = key ? watchedBodies.get(key) : undefined;
    if (key && owner && (!auxiliary || auxiliary.subscriptionId !== owner.subscriptionId)) {
      auxiliary = { subscriptionId: owner.subscriptionId, items: new Map(), loading: new Map() };
      watchedBodies.set(key, auxiliary);
    }
    return { watchedTarget, owner, watchedObservation, auxiliary };
  }
  function reservedBytes(windows: Map<string, ReadingWindow>) {
    return [...windows.values(), ...watchedBodies.values()].reduce(
      (sum, value) =>
        sum +
        [...value.items.values()].reduce((n, item) => n + item.bytes, 0) +
        [...value.loading.values()].reduce((n, bytes) => n + bytes, 0),
      0,
    );
  }
  return { watchedThreads, resolveWatched, reservedBytes, watch };
}
