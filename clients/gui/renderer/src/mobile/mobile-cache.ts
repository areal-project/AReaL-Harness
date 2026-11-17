import { readShell, type SessionRead, type ShellRead } from "@areal/client";

export const MAX_CACHED_SESSIONS_PER_HOST = 24;
export const MAX_CACHED_BYTES_PER_HOST = 8 * 1024 * 1024;
const DB_NAME = "areal-mobile-cache-v1";
const DB_VERSION = 1;
const META_STORE = "meta";
const SESSION_STORE = "sessions";

export type HostCacheMeta = {
  hostId: string;
  grantRevision: number;
  shell?: ShellRead;
  shellUpdatedAt?: number;
  /** null 表示默认缓存全部已授权项目；数组表示用户在手机端勾选要保留离线缓存的项目子集。 */
  cachedProjectIds: string[] | null;
  selectedProjectId?: string;
  selectedThreads: Record<string, string>;
};

export type CachedSessionEntry = {
  key: string;
  hostId: string;
  projectId: string;
  threadId: string;
  serviceGeneration: string;
  session: SessionRead;
  bytes: number;
  updatedAt: number;
  lastAccessedAt: number;
};

export type ProjectCacheStats = {
  count: number;
  bytes: number;
  updatedAt: number;
};

export type MobileHostCacheView = {
  meta: HostCacheMeta | null;
  statsByProject: Record<string, ProjectCacheStats>;
  cachedThreadIdsByProject: Record<string, string[]>;
};

type CacheBackend = {
  getMeta(hostId: string): Promise<HostCacheMeta | undefined>;
  putMeta(meta: HostCacheMeta): Promise<void>;
  deleteMeta(hostId: string): Promise<void>;
  listSessions(hostId: string): Promise<CachedSessionEntry[]>;
  getSession(key: string): Promise<CachedSessionEntry | undefined>;
  putSession(entry: CachedSessionEntry): Promise<void>;
  deleteSessions(keys: string[]): Promise<void>;
};

function sessionKey(hostId: string, projectId: string, threadId: string) {
  return `${hostId}\n${projectId}\n${threadId}`;
}

function estimateBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function validMeta(value: unknown): HostCacheMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.hostId !== "string" || !record.hostId) return undefined;
  if (typeof record.grantRevision !== "number" || !Number.isSafeInteger(record.grantRevision))
    return undefined;
  let shell: ShellRead | undefined;
  if (record.shell !== undefined) {
    try {
      const candidate = record.shell as ShellRead;
      shell = { ...candidate, snapshot: readShell(candidate.snapshot) };
    } catch {
      shell = undefined;
    }
  }
  const cachedProjectIds = Array.isArray(record.cachedProjectIds)
    ? record.cachedProjectIds.filter((id): id is string => typeof id === "string" && !!id)
    : null;
  const selectedThreads =
    record.selectedThreads &&
    typeof record.selectedThreads === "object" &&
    !Array.isArray(record.selectedThreads)
      ? Object.fromEntries(
          Object.entries(record.selectedThreads as Record<string, unknown>).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string" && !!entry[1],
          ),
        )
      : {};
  return {
    hostId: record.hostId,
    grantRevision: record.grantRevision,
    ...(shell ? { shell } : {}),
    ...(typeof record.shellUpdatedAt === "number" ? { shellUpdatedAt: record.shellUpdatedAt } : {}),
    cachedProjectIds,
    ...(typeof record.selectedProjectId === "string" && record.selectedProjectId
      ? { selectedProjectId: record.selectedProjectId }
      : {}),
    selectedThreads,
  };
}

function validSession(value: unknown): CachedSessionEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    typeof record.hostId !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.threadId !== "string" ||
    typeof record.serviceGeneration !== "string" ||
    !record.session ||
    typeof record.session !== "object" ||
    typeof record.bytes !== "number" ||
    typeof record.updatedAt !== "number" ||
    typeof record.lastAccessedAt !== "number"
  )
    return undefined;
  return record as CachedSessionEntry;
}

function createMemoryBackend(): CacheBackend {
  const metas = new Map<string, HostCacheMeta>();
  const sessions = new Map<string, CachedSessionEntry>();
  return {
    async getMeta(hostId) {
      return metas.get(hostId);
    },
    async putMeta(meta) {
      metas.set(meta.hostId, meta);
    },
    async deleteMeta(hostId) {
      metas.delete(hostId);
    },
    async listSessions(hostId) {
      return [...sessions.values()].filter((entry) => entry.hostId === hostId);
    },
    async getSession(key) {
      return sessions.get(key);
    },
    async putSession(entry) {
      sessions.set(entry.key, entry);
    },
    async deleteSessions(keys) {
      for (const key of keys) sessions.delete(key);
    },
  };
}

function createIndexedDBBackend(factory: IDBFactory): CacheBackend {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "hostId" });
        }
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          const store = db.createObjectStore(SESSION_STORE, { keyPath: "key" });
          store.createIndex("hostId", "hostId", { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = undefined;
        reject(request.error ?? new Error("IndexedDB open failed"));
      };
    });
    return opening;
  };
  const run = <T>(
    storeName: string,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T> | void,
  ) =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          let result: T | undefined;
          const req = action(store);
          if (req) {
            req.onsuccess = () => {
              result = req.result;
            };
          }
          tx.oncomplete = () => resolve(result as T);
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        }),
    );
  return {
    async getMeta(hostId) {
      return validMeta(await run<unknown>(META_STORE, "readonly", (s) => s.get(hostId)));
    },
    async putMeta(meta) {
      await run(META_STORE, "readwrite", (s) => s.put(meta));
    },
    async deleteMeta(hostId) {
      await run(META_STORE, "readwrite", (s) => s.delete(hostId));
    },
    async listSessions(hostId) {
      const rows = await run<unknown[]>(SESSION_STORE, "readonly", (s) =>
        s.index("hostId").getAll(hostId),
      );
      return (rows ?? []).flatMap((row) => {
        const parsed = validSession(row);
        return parsed ? [parsed] : [];
      });
    },
    async getSession(key) {
      return validSession(await run<unknown>(SESSION_STORE, "readonly", (s) => s.get(key)));
    },
    async putSession(entry) {
      await run(SESSION_STORE, "readwrite", (s) => s.put(entry));
    },
    async deleteSessions(keys) {
      if (!keys.length) return;
      await run(SESSION_STORE, "readwrite", (s) => {
        for (const key of keys) s.delete(key);
      });
    },
  };
}

export class MobileCacheStore {
  private readonly backend: CacheBackend;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(factory?: IDBFactory | null) {
    const idb = factory === undefined ? globalThis.indexedDB : factory;
    this.backend = idb ? createIndexedDBBackend(idb) : createMemoryBackend();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private authorizedIds(meta: HostCacheMeta | undefined): Set<string> | null {
    if (!meta?.shell) return null;
    return new Set(meta.shell.snapshot.projects.map((p) => p.projectId));
  }

  private isProjectEnabled(meta: HostCacheMeta, projectId: string): boolean {
    const authorized = this.authorizedIds(meta);
    if (authorized && !authorized.has(projectId)) return false;
    return meta.cachedProjectIds === null || meta.cachedProjectIds.includes(projectId);
  }

  async loadView(hostId: string): Promise<MobileHostCacheView> {
    return this.serial(async () => {
      const meta = (await this.backend.getMeta(hostId)) ?? null;
      const sessions = await this.backend.listSessions(hostId);
      const statsByProject: Record<string, ProjectCacheStats> = {};
      const cachedThreadIdsByProject: Record<string, string[]> = {};
      for (const entry of sessions) {
        const current = statsByProject[entry.projectId];
        statsByProject[entry.projectId] = {
          count: (current?.count ?? 0) + 1,
          bytes: (current?.bytes ?? 0) + entry.bytes,
          updatedAt: Math.max(current?.updatedAt ?? 0, entry.updatedAt),
        };
        (cachedThreadIdsByProject[entry.projectId] ??= []).push(entry.threadId);
      }
      return { meta, statsByProject, cachedThreadIdsByProject };
    });
  }

  async loadShell(hostId: string): Promise<ShellRead | undefined> {
    return this.serial(async () => {
      const meta = await this.backend.getMeta(hostId);
      return meta?.shell;
    });
  }

  async saveShell(hostId: string, grantRevision: number, shell: ShellRead): Promise<void> {
    await this.serial(async () => {
      const validated: ShellRead = { ...shell, snapshot: readShell(shell.snapshot) };
      const existing = await this.backend.getMeta(hostId);
      const authorized = new Set(validated.snapshot.projects.map((p) => p.projectId));
      const cachedProjectIds =
        existing?.cachedProjectIds == null
          ? null
          : existing.cachedProjectIds.filter((id) => authorized.has(id));
      const selectedProjectId =
        existing?.selectedProjectId && authorized.has(existing.selectedProjectId)
          ? existing.selectedProjectId
          : validated.snapshot.projects.find((p) => !p.projectless)?.projectId;
      const selectedThreads = Object.fromEntries(
        Object.entries(existing?.selectedThreads ?? {}).filter(([pid]) => authorized.has(pid)),
      );
      const next: HostCacheMeta = {
        hostId,
        grantRevision,
        shell: validated,
        shellUpdatedAt: Date.now(),
        cachedProjectIds,
        ...(selectedProjectId ? { selectedProjectId } : {}),
        selectedThreads,
      };
      await this.backend.putMeta(next);
      // 授权缩窄或关闭缓存的项目，立即清理不再允许或未勾选的会话正文缓存。
      const sessions = await this.backend.listSessions(hostId);
      const staleKeys = sessions
        .filter((entry) => !this.isProjectEnabled(next, entry.projectId))
        .map((entry) => entry.key);
      await this.backend.deleteSessions(staleKeys);
    });
    this.notify();
  }

  async syncGrantRevision(hostId: string, grantRevision: number): Promise<void> {
    await this.serial(async () => {
      const existing = await this.backend.getMeta(hostId);
      if (!existing) {
        await this.backend.putMeta({
          hostId,
          grantRevision,
          cachedProjectIds: null,
          selectedThreads: {},
        });
        return;
      }
      if (existing.grantRevision !== grantRevision) {
        await this.backend.putMeta({ ...existing, grantRevision });
      }
    });
    this.notify();
  }

  async setCachedProjects(hostId: string, projectIds: string[] | null): Promise<void> {
    await this.serial(async () => {
      const existing = await this.backend.getMeta(hostId);
      if (!existing) return;
      const authorized = this.authorizedIds(existing);
      const filtered =
        projectIds === null
          ? null
          : [...new Set(projectIds)].filter((id) => !authorized || authorized.has(id));
      const next: HostCacheMeta = { ...existing, cachedProjectIds: filtered };
      await this.backend.putMeta(next);
      const sessions = await this.backend.listSessions(hostId);
      const removed = sessions
        .filter((entry) => !this.isProjectEnabled(next, entry.projectId))
        .map((entry) => entry.key);
      await this.backend.deleteSessions(removed);
    });
    this.notify();
  }

  async toggleProjectCache(hostId: string, projectId: string, enabled: boolean): Promise<void> {
    await this.serial(async () => {
      const existing = await this.backend.getMeta(hostId);
      if (!existing) return;
      const authorized = existing.shell?.snapshot.projects.map((p) => p.projectId) ?? [];
      const base = existing.cachedProjectIds ?? authorized;
      const nextIds = enabled
        ? [...new Set([...base, projectId])]
        : base.filter((id) => id !== projectId);
      const next: HostCacheMeta = { ...existing, cachedProjectIds: nextIds };
      await this.backend.putMeta(next);
      if (!enabled) {
        const sessions = await this.backend.listSessions(hostId);
        const removed = sessions
          .filter((entry) => entry.projectId === projectId)
          .map((entry) => entry.key);
        await this.backend.deleteSessions(removed);
      }
    });
    this.notify();
  }

  async setSelection(hostId: string, projectId: string, threadId?: string): Promise<void> {
    await this.serial(async () => {
      const existing = await this.backend.getMeta(hostId);
      const next: HostCacheMeta = existing
        ? {
            ...existing,
            selectedProjectId: projectId,
            selectedThreads:
              threadId !== undefined
                ? { ...existing.selectedThreads, [projectId]: threadId }
                : existing.selectedThreads,
          }
        : {
            hostId,
            grantRevision: 0,
            cachedProjectIds: null,
            selectedProjectId: projectId,
            selectedThreads: threadId ? { [projectId]: threadId } : {},
          };
      await this.backend.putMeta(next);
    });
    this.notify();
  }

  async loadSession(
    hostId: string,
    projectId: string,
    threadId: string,
  ): Promise<SessionRead | undefined> {
    return this.serial(async () => {
      const meta = await this.backend.getMeta(hostId);
      if (!meta || !this.isProjectEnabled(meta, projectId)) return undefined;
      const key = sessionKey(hostId, projectId, threadId);
      const entry = await this.backend.getSession(key);
      if (!entry) return undefined;
      const now = Date.now();
      await this.backend.putSession({ ...entry, lastAccessedAt: now });
      return entry.session;
    });
  }

  async saveSession(hostId: string, session: SessionRead): Promise<void> {
    let saved = false;
    await this.serial(async () => {
      const meta = await this.backend.getMeta(hostId);
      if (!meta || !this.isProjectEnabled(meta, session.projectId)) return;
      const bytes = estimateBytes(session);
      if (bytes <= 0 || bytes > MAX_CACHED_BYTES_PER_HOST) return;
      const now = Date.now();
      const key = sessionKey(hostId, session.projectId, session.threadId);
      await this.backend.putSession({
        key,
        hostId,
        projectId: session.projectId,
        threadId: session.threadId,
        serviceGeneration: session.serviceGeneration,
        session,
        bytes,
        updatedAt: now,
        lastAccessedAt: now,
      });
      saved = true;
      const all = (await this.backend.listSessions(hostId)).sort(
        (a, b) => a.lastAccessedAt - b.lastAccessedAt,
      );
      let totalBytes = all.reduce((sum, item) => sum + item.bytes, 0);
      let count = all.length;
      const evict: string[] = [];
      for (const item of all) {
        if (count <= MAX_CACHED_SESSIONS_PER_HOST && totalBytes <= MAX_CACHED_BYTES_PER_HOST) break;
        if (item.key === key) continue;
        evict.push(item.key);
        count--;
        totalBytes -= item.bytes;
      }
      await this.backend.deleteSessions(evict);
    });
    if (saved) this.notify();
  }

  async clearProjectSessions(hostId: string, projectId: string): Promise<void> {
    await this.serial(async () => {
      const sessions = await this.backend.listSessions(hostId);
      const keys = sessions.filter((e) => e.projectId === projectId).map((e) => e.key);
      await this.backend.deleteSessions(keys);
    });
    this.notify();
  }

  async clearHostSessions(hostId: string): Promise<void> {
    await this.serial(async () => {
      const sessions = await this.backend.listSessions(hostId);
      await this.backend.deleteSessions(sessions.map((e) => e.key));
    });
    this.notify();
  }

  async clearHost(hostId: string): Promise<void> {
    await this.serial(async () => {
      const sessions = await this.backend.listSessions(hostId);
      await this.backend.deleteSessions(sessions.map((e) => e.key));
      await this.backend.deleteMeta(hostId);
    });
    this.notify();
  }
}

export function applyNavigationSelection(projectId: string | undefined, threadId?: string) {
  if (typeof localStorage === "undefined") return;
  if (!projectId) {
    localStorage.setItem("areal-gui:project", "");
    return;
  }
  localStorage.setItem("areal-gui:project", projectId);
  if (threadId !== undefined) {
    if (threadId) localStorage.setItem(`areal-gui:thread:${projectId}`, threadId);
    else localStorage.removeItem(`areal-gui:thread:${projectId}`);
  }
}
