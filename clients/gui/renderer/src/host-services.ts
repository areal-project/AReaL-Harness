import { refreshTaskDirectory, type TaskDirectoryState } from "./host-task-directory.js";
import {
  createHostSnapshotProjector,
  shellSnapshot,
  type ShellSnapshot,
  hostCommandOutcome,
  closedSidePublisher,
  settleHostCommand as settled,
  admitHostCommand as admitted,
  type ReadProject,
  type ReadingWindow,
} from "./host-snapshot.js";
export type { ReadingTarget, ReadingWindow } from "./host-snapshot.js";
import {
  cacheHistoryPages,
  pinnedPage,
  retainTarget,
  encodedBytes,
  refreshReadingWindow,
} from "./host-history-cache.js";
import {
  HostClient,
  sessionLoadTiming,
  sessionReadKey,
  SESSION_READ_CACHE_MS,
  SESSION_READ_CACHE_LIMIT,
  type HostClientOptions,
  type SessionRead,
  type JsonObject,
} from "@areal/client";
import {
  readObservationResult,
  readHistoryPage,
  readHistoryFragmentPage,
  readHistoryEntry,
  readInheritedHistoryPage,
} from "@areal/workbench/desktop-contract/conversation-history";
import { pageTopology } from "@areal/workbench/history-projection";
import { hostCommandError, isFileOpenTargets } from "./desktop-response.js";
import {
  createWorkbenchRoutes,
  hostDesktopCommand,
  jsonObject,
  object,
  openInBrowser,
  outcomeUnknown,
  hostPlatformCapabilities,
  desktopWindowCommand,
} from "./host-workbench.js";
import { createHostBots } from "./host-bots.js";
import { createWatchedHistory } from "./host-watched-history.js";
import {
  chooseHostProject,
  refreshInspections,
  reviewToken,
  refreshModelCatalogs,
} from "./host-auxiliary-reads.js";
import type { PlatformServices, PlatformReadServices, Snapshot } from "./services.js";
import { markRendererStartup } from "./state/startupTiming.js";

export { readObservationResult };
export type Observation = ReturnType<typeof readObservationResult>;
export type HostHistoryPage = ReturnType<typeof readInheritedHistoryPage>;
export type HistoryEntry = ReturnType<typeof readHistoryEntry>;
export type HistoryPage = ReturnType<typeof readHistoryPage> & { pageId: string; cursor: string };

function taskDraftTimeZone(configuration: unknown) {
  if (!object(configuration) || !object(configuration.options)) return;
  const instructions = configuration.options.appendInstructions;
  if (typeof instructions !== "string") return;
  const [kind, zone] = instructions.split("\n", 2);
  if (kind === "AREAL_TASK_DRAFT_V1" && zone?.startsWith("Time zone: "))
    return zone.slice("Time zone: ".length);
}
export type PageRecord = { id: string; cursor: string; items: ReturnType<typeof pageTopology> };

const serviceDisposers = new WeakMap<PlatformServices, () => void>();
export function disposeHostReadServices(services: PlatformServices | undefined) {
  if (services) serviceDisposers.get(services)?.();
}

export function createHostReadServices(
  desktop: PlatformServices | undefined,
  options: Omit<HostClientOptions, "writes"> & {
    preferredSourceId?: string;
  },
): PlatformServices {
  const client = new HostClient({ ...options, writes: true });
  const hostBots = createHostBots(client);
  let desktopSnapshot: Snapshot | undefined;
  let verifiedDesktopHost: Snapshot["verifiedDesktopHost"];
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let shellExtras: ShellSnapshot | undefined;
  const {
    watchedThreads,
    resolveWatched,
    reservedBytes,
    watch,
    current: watchedCurrent,
    find: findWatched,
  } = createWatchedHistory(client, readObservationResult);
  let librarySourceId: string | undefined;
  let snapshot: Snapshot = { projects: [], connection: { state: "connecting" } };
  let session: SessionRead | undefined;
  let observation: Observation | undefined;
  let readingWindow: ReadingWindow | undefined;
  const windows = new Map<string, ReadingWindow>();
  let cacheTimer: ReturnType<typeof setTimeout> | undefined;
  let historyVersion = 0;
  const ids = new Map<string, string>();
  const threadTargets = new Map<string, string>();
  const creationTargets = new Map<string, string>();
  const catalogs = new Map<string, { identity: string; value?: Record<string, unknown> }>();
  const inspections = new Map<string, { identity: string; value?: Record<string, unknown> }>();
  const commandOutcomes = new Map<string, Record<string, JsonObject>>();
  const commandOwners = new Map<string, string>();
  const taskState: TaskDirectoryState = { tasks: new Map(), reads: new Map() };
  const projectSnapshot = createHostSnapshotProjector(
    client,
    desktop,
    options,
    ids,
    threadTargets,
    creationTargets,
    catalogs,
    inspections,
  );
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
    const owner =
      generation === undefined || readingWindow?.viewGeneration === generation
        ? readingWindow
        : findWatched(generation);
    if (!owner || !windowCurrent(owner)) throw new Error("Conversation unavailable");
    return owner;
  }
  function windowCurrent(owner: ReadingWindow) {
    return readingWindow === owner
      ? client.readsSnapshot().session.state === "fresh"
      : watchedCurrent(owner);
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
    const target = owner === readingWindow ? undefined : owner.session;
    const page = readHistoryPage(
      await client.history({ view: "own", cursor, maxBytes: 131072 }, target),
    );
    if (!windowCurrent(owner) || owner.session.subscriptionId !== subscription)
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
        readingWindow = refreshReadingWindow(cached, currentSession, nextObservation);
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
    const projection = projectSnapshot(
      shell,
      shellState.state === "fresh",
      currentSession,
      observation,
      {
        shellExtras,
        desktopSnapshot,
        watched: watchedThreads(historyVersion),
        tasks: taskState.tasks,
        readingWindow,
        session,
        historyVersion,
        commandOutcomes,
      },
    );
    snapshot = projection.snapshot;
    if (projection.snapshot.connection?.state === "ready") markRendererStartup("shell_fresh");
    if (currentSession) sessionLoadTiming(currentSession.threadId)?.mark("projection");
    librarySourceId = projection.sourceId;
    for (const listener of listeners) listener(snapshot);
    // 延后目录、任务和环境巡检等次级刷新，让主线程和 Host 连接先完成首屏与会话恢复。
    setTimeout(() => {
      if (client.writable("project.models")) {
        markRendererStartup("aux_refresh_start");
        refreshModelCatalogs(
          client,
          shell?.snapshot.projects ?? [],
          catalogs,
          publish,
          snapshot.providerRevision,
        );
      }
      if (librarySourceId && client.writable("tasks.read"))
        refreshTaskDirectory(client, shell?.snapshot.projects ?? [], ids, taskState, publish);
      if (librarySourceId && client.writable("desktop.command"))
        refreshInspections(client, snapshot.projects as ReadProject[], inspections, publish);
    }, 0);
  }
  async function history(
    options: Parameters<PlatformReadServices["history"]>[0],
    target?: Parameters<PlatformReadServices["history"]>[1],
  ) {
    const { watchedTarget } = resolveWatched(target, session, ids, threadTargets);
    return readInheritedHistoryPage(await client.history(options, watchedTarget));
  }
  const reads: PlatformReadServices = {
    status: client.snapshot,
    canPrewarm: () => {
      const connection = client.snapshot();
      return (
        connection.connection === "ready" &&
        verifiedDesktopHost?.hostId === connection.identity.hostId &&
        verifiedDesktopHost?.generation === connection.identity.hostGeneration
      );
    },
    subscribe: client.subscribe,
    refreshProjects: () => client.refreshShell(),
    watch: (target) => watch(target, ids, threadTargets),
    async selectSession(target) {
      if (!target) return client.selectSession(null);
      const canonical =
        threadTargets.get(`${target.projectId}:${target.threadId}`) ??
        [...ids].find(([, alias]) => alias === target.projectId)?.[0] ??
        target.projectId;
      const shellState = client.readsSnapshot().shell;
      const shell = "value" in shellState ? shellState.value : shellState.previous;
      const execution = shell?.snapshot.projects.find((project) => project.projectId === canonical);
      if (
        execution?.summaries.items.some(
          (summary) => summary.id === target.threadId && summary.cloud,
        ) &&
        execution.state !== "ready"
      ) {
        const activated = await client.query("project.activate", canonical, {});
        if (!object(activated) || activated.state !== "ready")
          throw new Error("Cloud 连接尚未恢复");
        await client.refreshShell();
      }
      await client.selectSession({ ...target, projectId: canonical });
    },
    history,
    async media(source, signal, target) {
      const { watchedTarget } = resolveWatched(target, session, ids, threadTargets);
      return client.media(source, signal, watchedTarget);
    },
    async loadOlder(pageId, generation) {
      const owner = requireWindow(generation);
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
          if (windowCurrent(owner)) {
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
      const owner =
        [...windows.values()].find((value) => value.viewGeneration === generation) ??
        findWatched(generation);
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
        windowCurrent(owner) &&
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
    async loadItem(itemId, target) {
      const { watchedTarget, owner, watchedObservation, auxiliary } = resolveWatched(
        target,
        session,
        ids,
        threadTargets,
      );
      const reading = auxiliary ?? requireWindow();
      const olderEntry = [...reading.pages, ...reading.stalePages]
        .flatMap((page) => page.data)
        .find((entry) => entry.item.id === itemId);
      const observed = watchedObservation ?? observation;
      const liveTurn = observed?.thread.turns.find((turn) =>
        turn.items.some((value) => value.id === itemId),
      );
      const item = liveTurn?.items.find((value) => value.id === itemId) ?? olderEntry?.item;
      const sourceThreadId = liveTurn ? observed?.thread.id : olderEntry?.sourceThreadId;
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
      const reserved = reservedBytes(windows);
      if (reserved + item.totalBytes > 128 * 1024 * 1024)
        throw new Error("History items exceed display budget");
      reading.loading.set(itemId, item.totalBytes);
      try {
        let cursor: string | undefined = item.cursor,
          text = "",
          offset = 0;
        while (cursor) {
          const page = readHistoryFragmentPage(
            watchedTarget
              ? await client.history({ view: "own", cursor, maxBytes: 131072 }, watchedTarget)
              : await history({ view: "own", cursor, maxBytes: 131072 }),
          );
          if (!windowCurrent(reading) || owner?.subscriptionId !== reading.session.subscriptionId)
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
    const status = client.snapshot();
    if (status.connection === "ready") markRendererStartup("host_client_ready");
    else publish();
  });
  if (desktop) {
    // 外壳只提供窗口、电源、菜单栏、生命周期和代理设置；项目、会话、任务与其余设置都从 Host 读。
    const accept = (value: Snapshot) => {
      desktopSnapshot = value;
      verifiedDesktopHost = value.verifiedDesktopHost;
      shellExtras = shellSnapshot(value);
      publish();
    };
    desktop.onState(accept);
    void desktop
      .snapshot()
      .then(accept)
      .catch(() => {});
  }
  client.retry();
  const dispose = () => {
    clearTimeout(cacheTimer);
    windows.clear();
    hostBots.dispose();
    client.close();
  };
  if (typeof window !== "undefined")
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return;
      dispose();
    });
  // A2：停止与审批/回答在写开关下走 Host 回执；Host 明确不接管的会话退回桌面原路径。
  const HOST_DECLINED = new Set(["TASK_CONTROL_REQUIRED"]);
  function shouldActivatePersisted(name: string, params: Record<string, unknown>) {
    if (["send", "configure", "media", "fork", "editMessage", "steer", "continue"].includes(name))
      return true;
    if (name !== "side") return false;
    return (
      params.operation === undefined || ["create", "recover"].includes(String(params.operation))
    );
  }
  function executionProjectId(project: ReadProject, threadId?: string) {
    return threadId
      ? (threadTargets.get(`${project.id}:${threadId}`) ?? project.hostProjectId)
      : project.hostProjectId;
  }
  function hostTarget(params: Record<string, unknown>) {
    const projectId = params.projectId;
    const threadId = params.threadId;
    if (typeof projectId !== "string" || typeof threadId !== "string") return undefined;
    const project = snapshot.projects.find((value) => value.id === projectId) as
      | ReadProject
      | undefined;
    const hostProjectId = project ? executionProjectId(project, threadId) : undefined;
    return project && hostProjectId ? { project, hostProjectId, threadId } : undefined;
  }
  async function activateProject(
    projectId: string,
    intent: "connect" | "submit",
    resume?: { projectId: string; threadId?: string },
  ) {
    const activation = resume
      ? await client.workbench("desktop.command", {
          sourceId: librarySourceId ?? "",
          command: "connect",
          request: { ...resume, resumeScheduling: true },
        })
      : await client.query("project.activate", projectId, {});
    if (!object(activation) || activation.projectId !== projectId)
      throw new Error("Invalid project activation response");
    if (activation.state !== "ready")
      throw Object.assign(
        new Error(
          activation.reason === "explicitlyStopped"
            ? "项目已停止，请先恢复项目。"
            : intent === "submit"
              ? "项目启动尚未完成，消息尚未提交，草稿已保留。"
              : "项目仍在启动中，请稍后重试。",
        ),
        {
          code: activation.state === "pending" ? "ACTIVATION_PENDING" : "ACTIVATION_BLOCKED",
          activationState: activation.state,
          activationReason: activation.reason,
          activationId: activation.activationId,
        },
      );
    return activation;
  }
  const writes: NonNullable<PlatformServices["writes"]> = {
    async route(name, params) {
      if (name === "open") {
        const target = hostTarget(params);
        if (!target) throw new Error("Conversation unavailable");
        const selected = client.readsSnapshot().session;
        if (
          selected.state === "fresh" &&
          selected.value.projectId === target.hostProjectId &&
          selected.value.threadId === target.threadId &&
          target.project.state.threads[target.threadId]
        )
          return { routed: true, snapshot };
        const value = await client.captureWatchedSession(
          { projectId: target.hostProjectId, threadId: target.threadId },
          () => {
            const current = hostTarget(params);
            if (
              current?.hostProjectId !== target.hostProjectId ||
              !current.project.state.threads[target.threadId]
            )
              throw new Error("Conversation owner changed");
            return snapshot;
          },
        );
        return { routed: true, snapshot: value };
      }
      if (name === "list") {
        const original = client.snapshot();
        if (original.connection !== "ready") throw new Error("Project list unavailable");
        await client.refreshShell();
        if (client.snapshot() !== original || client.readsSnapshot().shell.state !== "fresh")
          throw new Error("Project list unavailable");
        return { routed: true, snapshot };
      }
      if (client.snapshot().connection !== "ready") return undefined;
      const project = snapshot.projects.find((value) => value.id === params.projectId) as
        | ReadProject
        | undefined;
      if (project && name === "connect") {
        const original = client.snapshot();
        if (original.connection !== "ready") throw new Error("Host unavailable");
        const activationProjectId = executionProjectId(
          project,
          typeof params.threadId === "string" ? params.threadId : undefined,
        );
        const activation = await activateProject(
          activationProjectId,
          "connect",
          params.resumeScheduling === true
            ? {
                projectId: project.id,
                ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
              }
            : undefined,
        );
        await client.refreshShell();
        const current = client.snapshot();
        const shell = client.readsSnapshot().shell;
        if (
          current.connection !== "ready" ||
          current.identity.connectionId !== original.identity.connectionId ||
          shell.state !== "fresh" ||
          shell.value.snapshot.projects.find((value) => value.projectId === activationProjectId)
            ?.serviceGeneration !== activation.serviceGeneration
        )
          throw Object.assign(new Error("Original project activation changed"), {
            code: "RESYNC_REQUIRED",
          });
        return { routed: true };
      }
      if (project && name === "create" && client.writable("session.create")) {
        const { projectId: _projectId, ...input } = params;
        const commandId =
          typeof params.requestId === "string" ? params.requestId : crypto.randomUUID();
        const result = admitted(
          await client.command(
            "session.create",
            project.hostProjectId,
            jsonObject(input),
            commandId,
          ),
        );
        if (typeof result.threadId !== "string")
          throw Object.assign(new Error("创建结果尚未确认，草稿已保留。"), {
            requestId: commandId,
            submissionUnknown: true,
          });
        const receipt =
          object(result.receipt) && object(result.receipt.result)
            ? result.receipt.result
            : undefined;
        const execution =
          typeof receipt?.executionProjectId === "string"
            ? receipt.executionProjectId
            : project.hostProjectId;
        creationTargets.set(`${project.id}:${result.threadId}`, execution);
        threadTargets.set(`${project.id}:${result.threadId}`, execution);
        const refresh = client.refreshShell().catch(() => {
          // 目录读取失败不改变已确认的原创建结果。
        });
        // 新工作树要先获得执行项目的代际；源目录已就绪，首条消息可以继续提交。
        if (execution !== project.hostProjectId) await refresh;
        return {
          routed: true,
          value: { threadId: result.threadId, requestId: result.nativeRequestId ?? commandId },
        };
      }
      if (
        project &&
        name === "reconcile" &&
        typeof params.requestId === "string" &&
        params.executionProjectId === undefined &&
        client.writable("command.read")
      ) {
        const connection = client.snapshot();
        if (connection.connection !== "ready") throw new Error("Host unavailable");
        const requestId = params.requestId;
        const gatewayOwner = commandOwners.get(
          JSON.stringify([connection.identity.hostId, requestId]),
        );
        const owner =
          gatewayOwner ??
          (session && threadTargets.get(`${project.id}:${session.threadId}`) === session.projectId
            ? session.projectId
            : project.hostProjectId);
        const result = await client.commandStatus(owner, requestId);
        if (client.snapshot() !== connection) throw new Error("Host command read cancelled");
        let outcome = hostCommandOutcome(result, requestId);
        const draftThreads = Object.entries(project.configurations)
          .filter(([, configuration]) => taskDraftTimeZone(configuration))
          .map(([id]) => id);
        if (
          outcome.admissionState === "notFound" &&
          draftThreads.length &&
          client.writable("tasks.read")
        ) {
          const draft = await client.workbench("tasks.read", {
            operation: "receipt",
            projectId: project.id,
            requestId,
          });
          if (client.snapshot() !== connection) throw new Error("Host command read cancelled");
          if (
            object(draft) &&
            draft.requestId === requestId &&
            draft.submissionUnknown === false &&
            object(draft.receipt) &&
            typeof draft.receipt.threadId === "string" &&
            draftThreads.includes(draft.receipt.threadId) &&
            typeof draft.receipt.turnId === "string"
          ) {
            outcome = hostCommandOutcome(
              {
                ...draft.receipt,
                method: "session.send",
                commandId: requestId,
                admissionState: "accepted",
              },
              requestId,
            );
          }
        }
        if (
          outcome.admissionState === "notFound" &&
          !gatewayOwner &&
          client.writable("desktop.command")
        ) {
          // 配置等原生提交由 Host 工作台日志保存，按同一编号核对原回执。
          const native = await client.workbench("desktop.command", {
            command: "reconcile",
            request: { projectId: project.id, requestId },
          });
          if (client.snapshot() !== connection) throw new Error("Host command read cancelled");
          const original =
            object(native) && object(native.outcomes) ? native.outcomes[requestId] : undefined;
          if (
            object(original) &&
            object(original.operation) &&
            original.operation.requestId === requestId
          )
            outcome = jsonObject(original);
        }
        const key = JSON.stringify([connection.identity.hostId, owner]);
        commandOutcomes.set(key, { ...commandOutcomes.get(key), [requestId]: outcome });
        publish();
        return {
          routed: true,
          value: {
            outcomes: { [requestId]: outcome },
          },
        };
      }
      const persistedThreadId =
        typeof params.threadId === "string"
          ? params.threadId
          : typeof params.sourceThreadId === "string"
            ? params.sourceThreadId
            : undefined;
      if (
        project &&
        persistedThreadId !== undefined &&
        (project.state.threads[persistedThreadId]?.persistedHistory === true ||
          (!project.state.connected &&
            (project.state.hostState === "stopped" || project.state.hostState === "stopping"))) &&
        shouldActivatePersisted(name, params)
      ) {
        const original = readingWindow?.session;
        const connection = client.snapshot();
        const requireOriginal = () => {
          const selected = client.readsSnapshot().sessionTarget;
          const current = client.snapshot();
          if (
            !original ||
            connection.connection !== "ready" ||
            current.connection !== "ready" ||
            current.identity.connectionId !== connection.identity.connectionId ||
            selected?.projectId !== original.projectId ||
            selected?.threadId !== persistedThreadId
          )
            throw Object.assign(new Error("会话已切换，输入已保留。"), {
              code: "STALE_CONNECTION",
            });
        };
        // 历史读取不等原生连接；恢复执行前须让 Main 完成工具 owner 握手。
        if (desktop) {
          await new Promise<void>((resolve, reject) => {
            let unsubscribe = () => {};
            let finished = false;
            const finish = (error?: unknown) => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              unsubscribe();
              if (error) reject(error);
              else resolve();
            };
            const timer = setTimeout(
              () =>
                finish(
                  Object.assign(new Error("桌面工具连接尚未就绪，输入已保留。"), {
                    code: "DESKTOP_UNAVAILABLE",
                  }),
                ),
              15_000,
            );
            const check = (value: Snapshot) => {
              if (finished) return;
              try {
                requireOriginal();
                if (
                  value.connection?.state === "ready" &&
                  connection.connection === "ready" &&
                  value.verifiedDesktopHost?.hostId === connection.identity.hostId &&
                  value.verifiedDesktopHost?.generation === connection.identity.hostGeneration
                )
                  finish();
                else if (value.connection?.state === "unavailable")
                  finish(
                    Object.assign(new Error("桌面工具连接不可用，输入已保留。"), {
                      code: "DESKTOP_UNAVAILABLE",
                    }),
                  );
              } catch (error) {
                finish(error);
              }
            };
            unsubscribe = desktop.onState(check);
            void desktop.snapshot().then(check, finish);
          });
          requireOriginal();
        }
        const activationProjectId = executionProjectId(project, persistedThreadId);
        const activation = await activateProject(activationProjectId, "submit");
        requireOriginal();
        await client.refreshShell();
        requireOriginal();
        const refreshedShell = client.readsSnapshot().shell;
        if (
          refreshedShell.state !== "fresh" ||
          refreshedShell.value.snapshot.projects.find(
            (value) => value.projectId === activationProjectId,
          )?.serviceGeneration !== activation.serviceGeneration
        )
          throw Object.assign(new Error("Original project activation changed"), {
            code: "RESYNC_REQUIRED",
          });
        await reads.selectSession({ projectId: project.id, threadId: persistedThreadId });
        requireOriginal();
      }
      const target = hostTarget(params);
      if (!target) return undefined;
      try {
        if (name === "media" && params.operation === "read" && typeof params.uri === "string") {
          return {
            routed: true,
            value: await client.attachment(target.hostProjectId, target.threadId, params.uri),
          };
        }
        if (
          name === "media" &&
          params.operation === "upload" &&
          client.writable("attachment.upload") &&
          params.bytes instanceof Uint8Array &&
          typeof params.mime === "string"
        ) {
          return {
            routed: true,
            value: await client.upload(
              target.hostProjectId,
              target.threadId,
              params.bytes,
              params.mime,
            ),
          };
        }
        if (
          (name === "send" && client.writable("session.send")) ||
          (name === "steer" && client.writable("session.control"))
        ) {
          let thread: ReadProject["state"]["threads"][string] | undefined =
            target.project.state.threads[target.threadId];
          if (!thread) {
            await reads.selectSession({ projectId: target.project.id, threadId: target.threadId });
            thread = (
              snapshot.projects.find((value) => value.id === target.project.id) as
                | ReadProject
                | undefined
            )?.state.threads[target.threadId];
          }
          const config = thread?.desktop?.configuration;
          if (!object(config) || !Number.isSafeInteger(config.revision))
            throw new Error("会话配置尚未加载，请刷新后再提交。");
          const input = jsonObject({
            text: params.text ?? "",
            ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
            ...(params.conversationQuotes !== undefined
              ? { conversationQuotes: params.conversationQuotes }
              : {}),
            ...(params.mcpContent !== undefined ? { mcpContent: params.mcpContent } : {}),
            ...(params.contextParts !== undefined ? { contextParts: params.contextParts } : {}),
            ...(name === "send" && params.command !== undefined ? { command: params.command } : {}),
          });
          const commandId =
            typeof params.requestId === "string" ? params.requestId : crypto.randomUUID();
          const owner = client.snapshot();
          if (owner.connection !== "ready") throw new Error("Host unavailable");
          const timeZone = taskDraftTimeZone(config);
          if (name === "send" && timeZone) {
            if (params.command !== undefined) throw new Error("定时任务配置草稿不支持插件命令");
            if (!client.writable("desktop.command")) throw new Error("Host unavailable");
            const operation = {
              method: "turn/start",
              requestId: commandId,
              target: { kind: "thread", threadId: target.threadId },
            } as const;
            let result;
            try {
              result = await client.workbench("desktop.command", {
                command: "manage",
                request: {
                  ...input,
                  operation: "taskDraftSend",
                  projectId: target.project.id,
                  threadId: target.threadId,
                  timeZone,
                  requestId: commandId,
                },
              });
            } catch (error) {
              if (!outcomeUnknown(error)) throw error;
              return {
                routed: true,
                value: admitted(
                  { admissionState: "unknown", commandId, transportError: "" },
                  operation,
                ),
              };
            }
            if (
              !object(result) ||
              result.threadId !== target.threadId ||
              typeof result.turnId !== "string"
            )
              return {
                routed: true,
                value: admitted(
                  { admissionState: "unknown", commandId, transportError: "" },
                  operation,
                ),
              };
            return { routed: true, value: result };
          }
          const command = await client.command(
            name === "send" ? "session.send" : "session.control",
            target.hostProjectId,
            name === "send"
              ? {
                  threadId: target.threadId,
                  expectedConfigRevision: Number(config.revision),
                  ...input,
                }
              : {
                  threadId: target.threadId,
                  operation: "steer",
                  expectedRevision: Number(config.revision),
                  values: {
                    ...input,
                    ...(params.expectedTurnId ? { expectedTurnId: params.expectedTurnId } : {}),
                  },
                },
            commandId,
          );
          if (command.admissionState === "unknown" || command.admissionState === "pending") {
            commandOwners.set(
              JSON.stringify([owner.identity.hostId, commandId]),
              target.hostProjectId,
            );
          }
          const result = admitted(command, {
            method: name === "send" ? "turn/start" : "turn/steer",
            requestId: commandId,
            target: { kind: "thread", threadId: target.threadId },
          });
          if (name === "steer") return { routed: true };
          return {
            routed: true,
            value: {
              threadId: target.threadId,
              ...(typeof result.turnId === "string" ? { turnId: result.turnId } : { queued: true }),
            },
          };
        }
        if (name === "stop" && client.writable("turn.stop") && typeof params.turnId === "string") {
          const commandId =
            typeof params.requestId === "string" ? params.requestId : crypto.randomUUID();
          const owner = client.snapshot();
          if (owner.connection !== "ready") throw new Error("Host unavailable");
          const result = await client.command(
            "turn.stop",
            target.hostProjectId,
            {
              threadId: target.threadId,
              expectedTurnId: params.turnId,
            },
            commandId,
          );
          if (result.admissionState === "unknown" || result.admissionState === "pending") {
            commandOwners.set(
              JSON.stringify([owner.identity.hostId, commandId]),
              target.hostProjectId,
            );
          }
          admitted(result, {
            method: "turn/interrupt",
            requestId: commandId,
            target: { kind: "thread", threadId: target.threadId },
          });
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
              : await reviewToken(client, target.hostProjectId, ids).then((review) =>
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
          name !== "stop" &&
          !(name === "send" && params.command !== undefined) &&
          HOST_DECLINED.has(String((error as { code?: unknown }).code))
        )
          return undefined;
        throw error;
      }
      return undefined;
    },
  };
  const workbench = createWorkbenchRoutes(
    client,
    desktop,
    options.events,
    globalThis.document,
    () => librarySourceId,
  );
  const unavailable = () => Promise.reject(new Error("此功能需要桌面应用"));
  const hostCommand = hostDesktopCommand(client, hostCommandError, (next) => {
    snapshot = next as unknown as Snapshot;
    publish();
  });
  const openExternal = desktop?.openExternal ?? openInBrowser;
  const command = desktopWindowCommand(
    client,
    desktop,
    hostCommand,
    () => librarySourceId,
    closedSidePublisher(client, commandOutcomes, hostTarget, publish),
  ) as PlatformServices["command"];
  const nativeFileOpen = desktop?.fileOpen;
  let selectedThemeId = "system";
  const resolveBrowserTheme = (id = selectedThemeId) => {
    const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = id === "data-dense" ? true : id === "soft-glass" ? false : prefersDark;
    return {
      dark,
      id: id === "system" ? (dark ? "data-dense" : "soft-glass") : id,
    };
  };
  const result: PlatformServices = {
    ...(desktop ?? {
      chooseProject: () => chooseHostProject(client),
      theme: async (id) => {
        selectedThemeId = id || "system";
        return resolveBrowserTheme(selectedThemeId);
      },
      onTheme: (listener) => {
        const media = matchMedia("(prefers-color-scheme: dark)");
        const handleChange = () => {
          if (selectedThemeId === "system") listener(resolveBrowserTheme("system"));
        };
        media.addEventListener?.("change", handleChange);
        return () => media.removeEventListener?.("change", handleChange);
      },
      preview: unavailable,
    }),
    ...(nativeFileOpen && {
      async fileOpen(request) {
        if (request.operation !== "setDefault") return nativeFileOpen(request);
        const catalog = await nativeFileOpen({ operation: "targets" });
        if (!isFileOpenTargets(catalog)) throw new Error("所选打开应用不可用，请重新选择");
        const target = catalog.targets.find(({ id }) => id === request.target);
        if (!target) throw new Error("所选打开应用不可用，请重新选择");
        await workbench.call("library", {
          operation: "settings",
          key: "fileOpenTarget",
          value: request.target,
        });
        return { ...catalog, preferred: target.id, preferredLabel: target.label };
      },
    }),
    command,
    openExternal,
    get capabilities() {
      return hostPlatformCapabilities(client, desktop, librarySourceId);
    },
    reads,
    writes,
    workbench,
    bots: hostBots.bots,
    snapshot: async () => snapshot,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  serviceDisposers.set(result, dispose);
  return result;
}
