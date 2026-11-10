import { createHostReadServices } from "./host-services.js";
import type { HostClientOptions } from "@areal/client";
import type { PlatformServices, Snapshot } from "./services.js";

/** 默认桌面只在迁移拒绝后附加历史视图，不改变桌面项目与执行状态的来源。 */
export function createDesktopHistoryRecoveryServices(
  desktop: PlatformServices,
  options: HostClientOptions,
): PlatformServices {
  type Target = { projectId: string; threadId: string };
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let legacy: Snapshot | undefined;
  let projected: Snapshot | undefined;
  let recovery: PlatformServices | undefined;
  let active: Target | undefined;
  let epoch = 0;
  let cancelWaiting: (() => void) | undefined;
  function currentSnapshot(): Snapshot {
    const source = legacy ?? { projects: [] };
    if (!active) return source;
    const target = active;
    const observed = projected?.projects.find((project) => project.id === target.projectId);
    const thread = observed?.state?.threads?.[target.threadId];
    if (!thread?.persistedHistory) return source;
    return {
      ...source,
      projects: source.projects.map((project) =>
        project.id !== target.projectId
          ? project
          : {
              ...project,
              state: {
                ...project.state,
                threads: { ...project.state?.threads, [target.threadId]: thread },
              },
            },
      ),
    };
  }
  function publish() {
    const snapshot = currentSnapshot();
    for (const listener of listeners) listener(snapshot);
  }
  desktop.onState((snapshot) => {
    legacy = snapshot;
    publish();
  });
  function ensureRecovery(): PlatformServices {
    if (recovery) return recovery;
    recovery = createHostReadServices(desktop, { ...options, writes: false, domains: new Set() });
    recovery.onState((snapshot) => {
      projected = snapshot;
      if (
        active &&
        snapshot.projects.find((project) => project.id === active?.projectId)?.state?.connected
      ) {
        // 后台重新就绪不把恢复视图静默升级为可执行会话。
        void recoverPersistedHistory(null).catch(() => {});
      } else if (active) publish();
    });
    return recovery;
  }
  async function recoverPersistedHistory(target: Target | null) {
    const attempt = ++epoch;
    cancelWaiting?.();
    active = undefined;
    publish();
    if (!target) {
      await recovery?.reads?.selectSession(null);
      return;
    }
    const services = ensureRecovery();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => finish(new Error("History recovery cancelled"));
      const finish = (error?: Error) => {
        unsubscribe();
        if (cancelWaiting === cancel) cancelWaiting = undefined;
        if (error) reject(error);
        else resolve();
      };
      const accept = (snapshot: Snapshot) => {
        if (attempt !== epoch) return finish(new Error("History recovery cancelled"));
        if (snapshot.connection?.state === "ready") {
          const state = services.reads!.status();
          finish(
            state.connection === "ready" && state.identity.persistedHistory === true
              ? undefined
              : new Error("Persisted history unavailable"),
          );
        } else if (services.reads!.status().connection === "offline")
          finish(new Error("Host unavailable"));
      };
      const unsubscribe = services.onState(accept);
      cancelWaiting = cancel;
      void services.snapshot().then(accept, finish);
    });
    if (attempt !== epoch) throw new Error("History recovery cancelled");
    try {
      await services.reads!.selectSession({ ...target, persisted: true });
      if (attempt !== epoch) throw new Error("History recovery cancelled");
      const next = await services.snapshot();
      if (attempt !== epoch) throw new Error("History recovery cancelled");
      const thread = next.projects.find((project) => project.id === target.projectId)?.state
        ?.threads?.[target.threadId];
      if (!thread?.persistedHistory) throw new Error("Persisted history unavailable");
      projected = next;
      active = target;
      publish();
    } catch (error) {
      if (attempt === epoch) await services.reads!.selectSession(null).catch(() => {});
      throw error;
    }
  }
  return {
    ...desktop,
    get reads() {
      return active ? recovery?.reads : undefined;
    },
    recoverPersistedHistory,
    snapshot: async () => {
      legacy ??= await desktop.snapshot();
      return currentSnapshot();
    },
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
