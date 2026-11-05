import { cacheHistoryPages, pinnedPage, retainTarget, encodedBytes } from "./host-history-cache.js";
import {
  HostClient,
  sessionReadKey,
  SESSION_READ_CACHE_MS,
  SESSION_READ_CACHE_LIMIT,
  type HostClientOptions,
  type SessionRead,
  type ShellRead,
  type ShellProject,
  type NavigationSummary,
  type WorktreeDisplay,
} from "@areal/client";
import {
  readObservationResult,
  readHistoryPage,
  readHistoryFragmentPage,
  readHistoryEntry,
  readInheritedHistoryPage,
} from "@areal/workbench/desktop-contract/conversation-history";
import { mergeHistory, historyGaps, pageTopology } from "@areal/workbench/history-projection";
import type { ReadingAnchor } from "./readingViews.js";
import { createWorkbenchRoutes } from "./host-workbench.js";
import type { PlatformServices, PlatformReadServices, Snapshot } from "./services.js";

type Observation = ReturnType<typeof readObservationResult>;
export type HostHistoryPage = ReturnType<typeof readInheritedHistoryPage>;
type HistoryEntry = ReturnType<typeof readHistoryEntry>;
export type HistoryPage = ReturnType<typeof readHistoryPage> & { pageId: string; cursor: string };
type PageRecord = { id: string; cursor: string; items: ReturnType<typeof pageTopology> };
export type ReadingTarget = {
  revision: number;
  anchor: Pick<ReadingAnchor, "turnId" | "itemId"> | null;
};
export type ReadingWindow = {
  session: SessionRead;
  observation: Observation;
  identity: string;
  viewGeneration: string;
  pages: HistoryPage[];
  stalePages: HistoryPage[];
  pageRecords: PageRecord[];
  targets: Map<string, ReadingTarget>;
  items: Map<string, { entry: HistoryEntry; version: string; bytes: number }>;
  loading: Map<string, number>;
  olderRead?: Promise<void>;
  nextCursor?: string;
  complete: boolean;
  expires?: number;
  baselineFirstItemId?: string;
};
function windowIdentity(observation: Observation) {
  return JSON.stringify([
    observation.history,
    observation.thread.turns.flatMap((turn) => turn.items)[0]?.id,
  ]);
}
type ExecutionView = {
  executionProjectId: string;
  executionRoot: string;
  executionCore: { connectionGeneration: string; instanceId: string };
  executionConnected: boolean;
  executionError: null;
  worktree?: WorktreeDisplay;
};
type ReadProject = Record<string, unknown> & {
  id: string;
  hostProjectId: string;
  logicalProjectId?: string;
  root: string;
  projectless: boolean;
  core: ExecutionView["executionCore"] & Record<string, unknown>;
  state: {
    connected: boolean;
    error: null;
    threads: Record<string, Observation["thread"] & ExecutionView>;
    queues: Record<string, unknown>;
    interactions: Record<string, unknown>;
  };
  summaries: (NavigationSummary & ExecutionView)[];
  summariesLoaded: boolean;
  summariesFreshness: "fresh" | "cached" | "unknown";
};

export function createHostReadServices(
  desktop: PlatformServices | undefined,
  options: HostClientOptions & {
    preferredSourceId?: string;
    domains?: Set<string>;
  },
): PlatformServices {
  const domains = options.domains ?? new Set<string>();
  // 领域切换也要用 gui-write-v1 连接；停止、审批等写仍只看 writes 开关。
  const client = new HostClient({ ...options, writes: options.writes || domains.size > 0 });
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let revision = 0;
  let legacy: Snapshot | undefined;
  let snapshot: Snapshot = { projects: [], connection: { state: "connecting" } };
  let session: SessionRead | undefined;
  let observation: Observation | undefined;
  let readingWindow: ReadingWindow | undefined;
  const windows = new Map<string, ReadingWindow>();
  let cacheTimer: ReturnType<typeof setTimeout> | undefined;
  let historyVersion = 0;
  const projectViews = new Map<
    string,
    {
      source: ShellProject;
      auxiliary: unknown;
      session?: SessionRead;
      historyVersion: number;
      fresh: boolean;
      sessionFreshness?: string;
      value: ReadProject;
    }
  >();
  const logicalViews = new Map<string, { owners: ReadProject[]; value: ReadProject }>();
  const ids = new Map<string, string>();
  const threadTargets = new Map<string, string>();
  function pruneWindows() {
    clearTimeout(cacheTimer);
    for (const [key, value] of windows)
      if (value !== readingWindow && value.expires !== undefined && value.expires <= Date.now())
        windows.delete(key);
    while (windows.size > SESSION_READ_CACHE_LIMIT) {
      const victim = [...windows].find(([, value]) => value !== readingWindow);
      if (!victim) break;
      windows.delete(victim[0]);
    }
    const expires = Math.min(
      ...[...windows.values()].flatMap((value) =>
        value.expires === undefined ? [] : [value.expires],
      ),
    );
    if (Number.isFinite(expires))
      cacheTimer = setTimeout(pruneWindows, Math.max(0, expires - Date.now()));
  }
  function requireWindow(generation?: string) {
    if (
      !readingWindow ||
      (generation !== undefined && readingWindow.viewGeneration !== generation) ||
      client.readsSnapshot().session.state !== "fresh"
    )
      throw new Error("Conversation unavailable");
    return readingWindow;
  }
  function pruneStalePages(owner: ReadingWindow) {
    const pages = owner.stalePages.filter((page) => pinnedPage(owner, page));
    if (pages.length === owner.stalePages.length) return;
    owner.stalePages = pages;
    ++historyVersion;
    publish();
  }
  async function readOwnPage(owner: ReadingWindow, cursor: string): Promise<HistoryPage> {
    const subscription = owner.session.subscriptionId;
    const page = readHistoryPage(await history({ view: "own", cursor, maxBytes: 131072 }));
    if (readingWindow !== owner || owner.session.subscriptionId !== subscription)
      throw new Error("History read cancelled");
    if (page.snapshotId !== owner.observation.history?.snapshotId)
      throw new Error("History snapshot changed");
    if (page.nextCursor === cursor && !page.complete)
      throw new Error("History cursor did not advance");
    return {
      ...page,
      cursor,
      pageId:
        owner.pageRecords.find((record) => record.cursor === cursor)?.id ?? crypto.randomUUID(),
    };
  }
  function cachePages(
    owner: ReadingWindow,
    input: HistoryPage[],
    startCursor?: string,
    scanned = input,
  ) {
    if (!cacheHistoryPages(owner, input, startCursor, scanned)) return false;
    ++historyVersion;
    publish();
    return true;
  }
  function publish() {
    const reads = client.readsSnapshot();
    const shellState = reads.shell;
    const shell = "value" in shellState ? shellState.value : shellState.previous;
    const currentSession = "value" in reads.session ? reads.session.value : reads.session.previous;
    if (currentSession && currentSession !== session) {
      let nextObservation: Observation;
      try {
        nextObservation = readObservationResult(currentSession.snapshot);
      } catch {
        snapshot = {
          ...snapshot,
          connection: { state: "unavailable", message: "Host conversation read unavailable" },
        };
        for (const listener of listeners) listener(snapshot);
        return;
      }
      const connection = client.snapshot();
      if (connection.connection === "ready") {
        pruneWindows();
        const key = sessionReadKey(connection.identity, currentSession);
        const cached = windows.get(key);
        if (readingWindow && readingWindow !== cached)
          readingWindow.expires = Date.now() + SESSION_READ_CACHE_MS;
        const identity = windowIdentity(nextObservation);
        if (cached?.identity === identity) {
          readingWindow = cached;
          if (readingWindow.session.subscriptionId !== currentSession.subscriptionId)
            readingWindow.viewGeneration = crypto.randomUUID();
          readingWindow.session = currentSession;
          readingWindow.observation = nextObservation;
          readingWindow.expires = undefined;
        } else {
          readingWindow = {
            session: currentSession,
            observation: nextObservation,
            identity,
            viewGeneration: crypto.randomUUID(),
            pages: [],
            stalePages: cached
              ? [
                  ...cached.stalePages,
                  ...[...cached.pages].sort(
                    (a, b) =>
                      cached.pageRecords.findIndex((record) => record.id === b.pageId) -
                      cached.pageRecords.findIndex((record) => record.id === a.pageId),
                  ),
                ].filter((page) => pinnedPage(cached, page))
              : [],
            pageRecords: [],
            targets: new Map(cached?.targets),
            items: new Map(),
            loading: new Map(),
            nextCursor: nextObservation.history?.nextCursor ?? undefined,
            complete: nextObservation.history?.complete ?? true,
            baselineFirstItemId: nextObservation.thread.turns.flatMap((turn) => turn.items)[0]?.id,
          };
        }
        windows.delete(key);
        windows.set(key, readingWindow);
        pruneWindows();
      }
      observation = nextObservation;
      session = currentSession;
    } else if (!currentSession && readingWindow) {
      readingWindow.expires = Date.now() + SESSION_READ_CACHE_MS;
      readingWindow = undefined;
      session = undefined;
      observation = undefined;
      pruneWindows();
    }
    snapshot = projectSnapshot(shell, shellState.state === "fresh", currentSession, observation);
    for (const listener of listeners) listener(snapshot);
  }
  function projectSnapshot(
    shell: ShellRead | undefined,
    fresh: boolean,
    currentSession: SessionRead | undefined,
    native: Observation | undefined,
  ): Snapshot {
    ids.clear();
    threadTargets.clear();
    const connection = client.snapshot();
    const preferredSourceId =
      options.preferredSourceId ??
      (connection.connection === "ready" ? connection.identity.preferredSourceId : undefined);
    const sources = shell?.snapshot.navigation ?? [];
    const navigation = preferredSourceId
      ? sources.find((source) => source.sourceId === preferredSourceId)
      : sources.length === 1
        ? sources[0]
        : undefined;
    for (const project of shell?.snapshot.projects ?? [])
      ids.set(
        project.projectId,
        navigation?.bindings.find((b) => b.projectId === project.projectId)?.alias ??
          (sources.length === 1 ? project.alias?.projectId : undefined) ??
          project.projectId,
      );
    const canonical = (id: string) => ids.get(id) ?? id;
    const rows = (shell?.snapshot.projects ?? []).map((project) => {
      const id = canonical(project.projectId);
      const auxiliary = legacy?.projects.find((value) => value.id === id);
      const selectedSession =
        currentSession?.projectId === project.projectId &&
        currentSession.serviceGeneration === project.serviceGeneration
          ? currentSession
          : undefined;
      const cached = projectViews.get(project.projectId);
      const displayVersion = selectedSession ? historyVersion : 0;
      const sessionFreshness = selectedSession ? client.readsSnapshot().session.state : undefined;
      if (
        cached &&
        cached.source === project &&
        cached.auxiliary === auxiliary &&
        cached.session === selectedSession &&
        cached.historyVersion === displayVersion &&
        cached.fresh === fresh &&
        cached.sessionFreshness === sessionFreshness &&
        cached.value.id === id
      ) {
        for (const summary of cached.value.summaries)
          threadTargets.set(
            `${canonical(project.logicalProjectId ?? project.projectId)}:${summary.id}`,
            project.projectId,
          );
        return cached.value;
      }
      let thread = selectedSession ? native?.thread : undefined;
      if (thread && session && readingWindow) {
        const pages = [...readingWindow.pages].sort(
          (a, b) =>
            readingWindow!.pageRecords.findIndex((record) => record.id === b.pageId) -
            readingWindow!.pageRecords.findIndex((record) => record.id === a.pageId),
        );
        const gaps = historyGaps(readingWindow);
        const entries = [...readingWindow.stalePages, ...pages].flatMap((page) => page.data);
        const sources = new Map(entries.map((entry) => [entry.sourceItemId, entry]));
        const merged = mergeHistory(thread, entries);
        thread = {
          ...merged,
          turns: merged.turns.map((turn) => ({
            ...turn,
            items: turn.items.map((item) => {
              const source = sources.get(item.id);
              const expanded = readingWindow!.items.get(item.id);
              const value =
                item.type === "historyDeferred" && expanded && expanded.version === item.version
                  ? expanded.entry.item
                  : item;
              return source
                ? {
                    ...value,
                    historySource: {
                      threadId: source.sourceThreadId,
                      turnId: source.sourceTurnId,
                      itemId: source.sourceItemId,
                    },
                  }
                : value;
            }),
          })),
          displayHistory: {
            supported: observation?.history !== undefined,
            viewGeneration: readingWindow.viewGeneration,
            revision: session.sequence,
            complete: readingWindow.complete && !gaps.some((gap) => gap.atTop),
            gaps,
            omitted: readingWindow.pageRecords.length > readingWindow.pages.length,
            pageTopology: readingWindow.pageRecords
              .filter((record) => record.items.length)
              .map(({ id, items }) => ({ id, items })),
            restoringItems: readingWindow.stalePages.flatMap((page) =>
              page.data.map((entry) => entry.sourceItemId),
            ),
            baselineFirstItemId: readingWindow.baselineFirstItemId,
            freshness: sessionFreshness,
            loadingOlder: !!readingWindow.olderRead,
          },
        };
      }
      const executionCore = {
        connectionGeneration: project.serviceGeneration ?? "",
        instanceId: project.serviceGeneration ?? "",
      };
      const execution = {
        executionProjectId: id,
        executionRoot: project.workspace,
        executionCore,
        executionConnected: fresh && project.state === "ready",
        executionError: null,
        ...(project.worktree ? { worktree: project.worktree } : {}),
      };
      const logicalId = canonical(project.logicalProjectId ?? project.projectId);
      const summaries = project.summaries.items.map((summary) => {
        threadTargets.set(`${logicalId}:${summary.id}`, project.projectId);
        return { ...summary, ...execution };
      });
      const desktop = thread?.desktop;
      const value: ReadProject = {
        ...auxiliary,
        id,
        hostProjectId: project.projectId,
        root: project.workspace,
        projectless: project.projectless,
        logicalProjectId: project.logicalProjectId
          ? canonical(project.logicalProjectId)
          : undefined,
        core: {
          ...auxiliary?.core,
          connectionGeneration: project.serviceGeneration ?? "",
          instanceId: project.serviceGeneration ?? "",
        },
        state: {
          connected: fresh && project.state === "ready",
          error: null,
          threads: thread ? { [thread.id]: { ...thread, ...execution } } : {},
          queues: thread && desktop?.queue ? { [thread.id]: desktop.queue } : {},
          interactions:
            thread && desktop?.interactions
              ? {
                  [thread.id]: {
                    revision: desktop.interactionRevision ?? 0,
                    data: desktop.interactions,
                  },
                }
              : {},
        },
        summaries,
        summariesLoaded: project.summaries.state === "fresh",
        summariesFreshness: project.summaries.state,
        pending: auxiliary?.pending ?? [],
        outcomes: auxiliary?.outcomes ?? [],
        error: null,
        observationErrors: {},
        attention: project.attention,
      };
      projectViews.set(project.projectId, {
        source: project,
        auxiliary,
        session: selectedSession,
        historyVersion: displayVersion,
        fresh,
        sessionFreshness,
        value,
      });
      return value;
    });
    const liveProjects = new Set(rows.map((row) => row.hostProjectId));
    for (const key of projectViews.keys()) if (!liveProjects.has(key)) projectViews.delete(key);
    const rowIds = new Set(rows.map((row) => row.id));
    const projects = rows
      .filter((row) => !row.logicalProjectId || !rowIds.has(row.logicalProjectId))
      .map((logical) => {
        const owners = rows.filter(
          (row) => row.id === logical.id || row.logicalProjectId === logical.id,
        );
        if (owners.length === 1) return logical;
        const cached = logicalViews.get(logical.id);
        if (
          cached &&
          cached.owners.length === owners.length &&
          owners.every((owner, index) => owner === cached.owners[index])
        )
          return cached.value;
        const value: ReadProject = {
          ...logical,
          summaries: owners.flatMap((owner) => owner.summaries),
          summariesLoaded: owners.every((owner) => owner.summariesLoaded),
          state: {
            ...logical.state,
            threads: Object.fromEntries(
              owners.flatMap((owner) => Object.entries(owner.state.threads)),
            ),
            queues: Object.fromEntries(
              owners.flatMap((owner) => Object.entries(owner.state.queues)),
            ),
            interactions: Object.fromEntries(
              owners.flatMap((owner) => Object.entries(owner.state.interactions)),
            ),
          },
        };
        logicalViews.set(logical.id, { owners, value });
        return value;
      });
    const logicalIds = new Set(projects.map((project) => project.id));
    for (const key of logicalViews.keys()) if (!logicalIds.has(key)) logicalViews.delete(key);
    const navigationProjects = { ...navigation?.projects };
    const projectedNavigation: Record<
      string,
      import("@areal/client").NavigationMetadata & {
        navigationSummaries?: (typeof rows)[number]["summaries"];
      }
    > = navigationProjects;
    for (const project of projects)
      if (!project.summariesLoaded)
        projectedNavigation[project.id] = {
          ...projectedNavigation[project.id],
          navigationSummaries: project.summaries,
        };
    const navigationSettings: Record<string, unknown> = { ...legacy?.library?.settings };
    for (const key of [
      "sidebarSort",
      "sidebarSortChats",
      "sidebarSortProjects",
      "sidebarSortPinned",
      "showPinned",
      "showCompleted",
    ] as const) {
      delete navigationSettings[key];
      const value = navigation?.preferences[key];
      if (value !== undefined) navigationSettings[key] = value;
    }
    return {
      ...legacy,
      projects,
      revision: ++revision,
      connection: {
        state: fresh
          ? "ready"
          : client.snapshot().connection === "connecting"
            ? "connecting"
            : "unavailable",
      },
      desktopCapabilities: { currentCommands: desktop !== undefined },
      library: {
        projects: projectedNavigation,
        threads: navigation?.threads ?? {},
        projectOrder: navigation?.projectOrder ?? [],
        sections: navigation?.sections ?? [],
        sidebarThreadOrder: navigation?.sidebarThreadOrder ?? [],
        sidebarRevision: navigation?.sidebarRevision ?? 0,
        settings: navigationSettings,
      },
    };
  }
  async function history(options: Parameters<PlatformReadServices["history"]>[0]) {
    return readInheritedHistoryPage(await client.history(options));
  }
  const reads: PlatformReadServices = {
    status: client.snapshot,
    subscribe: client.subscribe,
    async selectSession(target) {
      if (!target) return client.selectSession(null);
      const canonical =
        threadTargets.get(`${target.projectId}:${target.threadId}`) ??
        [...ids].find(([, alias]) => alias === target.projectId)?.[0] ??
        target.projectId;
      await client.selectSession({ ...target, projectId: canonical });
    },
    history,
    media: (source, signal) => client.media(source, signal),
    async loadOlder(pageId) {
      const owner = requireWindow();
      if (owner.olderRead) return owner.olderRead;
      const oldest = Math.max(
        -1,
        ...owner.pages.map((page) =>
          owner.pageRecords.findIndex((record) => record.id === page.pageId),
        ),
      );
      const revisit = pageId
        ? owner.pageRecords.find((record) => record.id === pageId)
        : owner.pageRecords[oldest + 1];
      if (pageId && !revisit) throw new Error("History gap changed");
      const cursor = revisit?.cursor ?? owner.nextCursor;
      if (!cursor) return;
      const read = Promise.resolve().then(async () => {
        try {
          const page = await readOwnPage(owner, cursor);
          if (!cachePages(owner, [page], cursor))
            throw new Error("History pages pinned by other reading views");
        } finally {
          owner.olderRead = undefined;
          if (readingWindow === owner) {
            ++historyVersion;
            publish();
          }
        }
      });
      owner.olderRead = read;
      ++historyVersion;
      publish();
      return read;
    },
    async acquire(_viewId, generation) {
      requireWindow(generation);
    },
    async release(viewId, generation) {
      const owner = [...windows.values()].find((value) => value.viewGeneration === generation);
      if (!owner) return;
      owner.targets.delete(viewId);
      pruneStalePages(owner);
    },
    async retain(viewId, revision, anchor, generation) {
      const owner = requireWindow(generation);
      retainTarget(owner, viewId, revision, anchor);
      pruneStalePages(owner);
    },
    async ensureAnchor(viewId, revision, anchor, generation) {
      const owner = requireWindow(generation);
      const intent = retainTarget(owner, viewId, revision, anchor);
      if (!intent) return "cancelled";
      const subscription = owner.session.subscriptionId;
      const current = () =>
        readingWindow === owner &&
        owner.session.subscriptionId === subscription &&
        owner.targets.get(viewId) === intent;
      const matches = (entry: HistoryEntry) =>
        entry.sourceTurnId === anchor.turnId && entry.sourceItemId === anchor.itemId;
      try {
        const shown =
          owner.observation.thread.turns
            .find((turn) => turn.id === anchor.turnId)
            ?.items.find((item) => item.id === anchor.itemId) ??
          owner.pages.flatMap((page) => page.data).find(matches)?.item;
        if (shown)
          return shown.type === "historyDeferred" && !owner.items.has(shown.id)
            ? "limited"
            : "ready";
        const known = owner.pageRecords.find((record) =>
          record.items.some(
            (item) => item.turnId === anchor.turnId && item.itemId === anchor.itemId,
          ),
        );
        let cursor =
          known?.cursor ??
          owner.pageRecords.find((record) => !record.items.length)?.cursor ??
          owner.nextCursor;
        const start = cursor;
        const nearby: HistoryPage[] = [];
        const scanned: HistoryPage[] = [];
        let bytes = 0;
        for (let reads = 0; cursor && reads < 32; ++reads) {
          const page = await readOwnPage(owner, cursor);
          if (!current()) return "cancelled";
          bytes += encodedBytes(page);
          if (bytes > 8 * 1024 * 1024) return "limited";
          nearby.push(page);
          scanned.push(page);
          if (nearby.length > 2) nearby.shift();
          const found = page.data.find(matches);
          if (found) {
            if (found.item.type === "historyDeferred") return "limited";
            return cachePages(owner, nearby, start, scanned) ? "ready" : "limited";
          }
          cursor = page.nextCursor ?? undefined;
          if (page.complete) break;
        }
        if (!cursor) {
          owner.stalePages = owner.stalePages
            .map((page) => ({ ...page, data: page.data.filter((entry) => !matches(entry)) }))
            .filter((page) => page.data.length);
          ++historyVersion;
          publish();
        }
        return cursor ? "limited" : "missing";
      } catch {
        return current() ? "limited" : "cancelled";
      }
    },
    async loadItem(itemId) {
      const reading = requireWindow();
      const owner = session;
      const olderEntry = [...reading.pages, ...reading.stalePages]
        .flatMap((page) => page.data)
        .find((entry) => entry.item.id === itemId);
      const liveTurn = observation?.thread.turns.find((turn) =>
        turn.items.some((value) => value.id === itemId),
      );
      const item = liveTurn?.items.find((value) => value.id === itemId) ?? olderEntry?.item;
      const sourceThreadId = liveTurn ? observation?.thread.id : olderEntry?.sourceThreadId;
      const sourceTurnId = liveTurn?.id ?? olderEntry?.sourceTurnId;
      if (
        !item ||
        item.type !== "historyDeferred" ||
        typeof item.cursor !== "string" ||
        typeof item.version !== "string" ||
        typeof item.totalBytes !== "number"
      )
        throw new Error("History item unavailable");
      if (item.totalBytes > 4 * 1024 * 1024) throw new Error("History item exceeds display budget");
      if (reading.loading.has(itemId)) throw new Error("History item is already loading");
      const reserved = [...windows.values()].reduce(
        (sum, value) =>
          sum +
          [...value.items.values()].reduce((n, item) => n + item.bytes, 0) +
          [...value.loading.values()].reduce((n, bytes) => n + bytes, 0),
        0,
      );
      if (reserved + item.totalBytes > 128 * 1024 * 1024)
        throw new Error("History items exceed display budget");
      reading.loading.set(itemId, item.totalBytes);
      try {
        let cursor: string | undefined = item.cursor,
          text = "",
          offset = 0;
        while (cursor) {
          const page = readHistoryFragmentPage(
            await history({ view: "own", cursor, maxBytes: 131072 }),
          );
          if (readingWindow !== reading || owner?.subscriptionId !== session?.subscriptionId)
            throw new Error("History read cancelled");
          for (const entry of page.data) {
            const fragment = entry.fragment;
            if (
              entry.sourceThreadId !== sourceThreadId ||
              entry.sourceTurnId !== sourceTurnId ||
              entry.sourceItemId !== itemId ||
              fragment.offsetUtf8 !== offset ||
              fragment.version !== item.version ||
              fragment.totalBytes !== item.totalBytes
            )
              throw new Error("History fragment identity changed");
            text += fragment.text;
            offset += new TextEncoder().encode(fragment.text).length;
            if (offset !== fragment.nextOffsetUtf8 || offset > fragment.totalBytes)
              throw new Error("Invalid history fragment length");
          }
          if (page.complete) {
            if (offset !== item.totalBytes) throw new Error("Incomplete history item");
            break;
          }
          if (!page.nextCursor || page.nextCursor === cursor)
            throw new Error("History fragment cursor did not advance");
          cursor = page.nextCursor;
        }
        const entry = readHistoryEntry(JSON.parse(text));
        if (
          entry.sourceThreadId !== sourceThreadId ||
          entry.sourceTurnId !== sourceTurnId ||
          entry.sourceItemId !== itemId ||
          entry.item.id !== itemId
        )
          throw new Error("History item identity changed");
        ++historyVersion;
        reading.items.set(itemId, {
          entry: {
            ...entry,
            item: {
              ...entry.item,
              historySource: {
                threadId: entry.sourceThreadId,
                turnId: entry.sourceTurnId,
                itemId: entry.sourceItemId,
              },
            },
          },
          version: item.version,
          bytes: item.totalBytes,
        });
        publish();
      } finally {
        reading.loading.delete(itemId);
      }
    },
  };
  client.subscribeReads(() => {
    try {
      publish();
    } catch {
      snapshot = {
        ...snapshot,
        connection: { state: "unavailable", message: "Host conversation read unavailable" },
      };
      for (const listener of listeners) listener(snapshot);
    }
  });
  client.subscribe(() => {
    if (client.snapshot().connection !== "ready") publish();
  });
  if (desktop) {
    desktop.onState((value) => {
      legacy = value;
      publish();
    });
    void desktop
      .snapshot()
      .then((value) => {
        legacy = value;
        publish();
      })
      .catch(() => {});
  }
  client.retry();
  if (typeof window !== "undefined")
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return;
      clearTimeout(cacheTimer);
      windows.clear();
      client.close();
    });
  // A2：停止与审批/回答在写开关下走 Host 回执；Host 明确不接管的会话退回桌面原路径。
  const HOST_DECLINED = new Set(["TASK_CONTROL_REQUIRED"]);
  function hostTarget(params: Record<string, unknown>) {
    const projectId = params.projectId;
    const threadId = params.threadId;
    if (typeof projectId !== "string" || typeof threadId !== "string") return undefined;
    const project = snapshot.projects.find((value) => value.id === projectId) as
      | ReadProject
      | undefined;
    const hostProjectId = threadTargets.get(`${projectId}:${threadId}`) ?? project?.hostProjectId;
    return project && hostProjectId ? { project, hostProjectId, threadId } : undefined;
  }
  function settled(result: import("@areal/client").HostCommandResult) {
    if (result.admissionState === "accepted" || result.admissionState === "pending") return;
    const outcome = result.admissionState === "rejected" ? { kind: "rejected" } : undefined;
    throw Object.assign(
      new Error(outcome ? "Host 拒绝了该操作" : "操作结果尚未确认。正在核对原请求，不会自动重发。"),
      { commandId: result.commandId, submissionUnknown: !outcome, outcome },
    );
  }
  async function reviewToken(hostProjectId: string, target: Record<string, string>) {
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const value = (await client.query("attention.read", hostProjectId, {
        ...target,
        ...(cursor && { cursor }),
      })) as Record<string, unknown>;
      if (typeof value.reviewToken === "string") return value;
      if (typeof value.nextCursor !== "string") break;
      cursor = value.nextCursor;
    }
    throw new Error("审批详情未读完");
  }
  const writes: NonNullable<PlatformServices["writes"]> = {
    async route(name, params) {
      if (!options.writes || client.snapshot().connection !== "ready") return undefined;
      const target = hostTarget(params);
      if (!target) return undefined;
      try {
        if (name === "stop" && client.writable("turn.stop") && typeof params.turnId === "string") {
          settled(
            await client.command("turn.stop", target.hostProjectId, {
              threadId: target.threadId,
              expectedTurnId: params.turnId,
            }),
          );
          return { routed: true };
        }
        if (
          name === "respond" &&
          client.writable("interaction.respond") &&
          client.writable("attention.read") &&
          typeof params.requestId === "string"
        ) {
          const interactions = target.project.state.interactions[target.threadId] as
            | { data?: Array<Record<string, unknown>> }
            | undefined;
          const item = interactions?.data?.find(
            (entry) => entry.requestId === params.requestId && entry.status === "pending",
          );
          if (typeof item?.turnId !== "string") return undefined;
          const ids = {
            threadId: target.threadId,
            turnId: item.turnId,
            interactionId: params.requestId,
          };
          const answer =
            params.decision === "deny"
              ? { decision: "deny", argumentsDigest: item.argumentsDigest }
              : await reviewToken(target.hostProjectId, ids).then((review) =>
                  params.answers
                    ? { answers: params.answers, reviewToken: review.reviewToken }
                    : {
                        decision: params.decision,
                        argumentsDigest: review.argumentsDigest,
                        reviewToken: review.reviewToken,
                      },
                );
          settled(
            await client.command("interaction.respond", target.hostProjectId, {
              ...ids,
              ...answer,
            } as Parameters<typeof client.command>[2]),
          );
          return { routed: true };
        }
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          HOST_DECLINED.has(String((error as { code?: unknown }).code))
        )
          return undefined;
        throw error;
      }
      return undefined;
    },
  };
  const workbench =
    desktop && createWorkbenchRoutes(client, desktop, domains, options.events, globalThis.document);
  const unavailable = async () => {
    throw new Error("This capability requires the desktop application");
  };
  return {
    ...(desktop ?? {
      chooseProject: unavailable,
      command: unavailable,
      theme: async () => ({
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        id: "system",
      }),
      onTheme: () => () => {},
      preview: unavailable,
    }),
    capabilities: { mutations: desktop !== undefined, native: desktop !== undefined },
    reads,
    ...(options.writes && { writes }),
    ...(workbench && { workbench }),
    snapshot: async () => snapshot,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
