import {
  createHostSnapshotProjector,
  windowIdentity,
  hostCommandOutcome,
  settleHostCommand as settled,
  admitHostCommand as admitted,
  type ReadProject,
  type ReadingWindow,
} from "./host-snapshot.js";
export type { ReadingTarget, ReadingWindow } from "./host-snapshot.js";
import { cacheHistoryPages, pinnedPage, retainTarget, encodedBytes } from "./host-history-cache.js";
import {
  HostClient,
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
import {
  createWorkbenchRoutes,
  hostDesktopCommand,
  hostPlatformCapabilities,
} from "./host-workbench.js";
import { createHostPages } from "./host-pages.js";
import {
  chooseHostProject,
  refreshInspections,
  refreshModelCatalogs,
} from "./host-auxiliary-reads.js";
import type { PlatformServices, PlatformReadServices, Snapshot } from "./services.js";

export type Observation = ReturnType<typeof readObservationResult>;
export type HostHistoryPage = ReturnType<typeof readInheritedHistoryPage>;
export type HistoryEntry = ReturnType<typeof readHistoryEntry>;
export type HistoryPage = ReturnType<typeof readHistoryPage> & { pageId: string; cursor: string };
export type PageRecord = { id: string; cursor: string; items: ReturnType<typeof pageTopology> };

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
  const pages = domains.has("pages") ? createHostPages(client) : undefined;
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let legacy: Snapshot | undefined;
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
    const projection = projectSnapshot(
      shell,
      shellState.state === "fresh",
      currentSession,
      observation,
      { legacy, readingWindow, observation, session, historyVersion, commandOutcomes },
    );
    snapshot = projection.snapshot;
    librarySourceId = projection.sourceId;
    for (const listener of listeners) listener(snapshot);
    if ((!desktop || legacy) && options.writes && client.writable("project.models"))
      refreshModelCatalogs(
        client,
        shell?.snapshot.projects ?? [],
        (id) => !!legacy?.projects.some((value) => value.id === (ids.get(id) ?? id)),
        catalogs,
        publish,
      );
    if (!desktop && librarySourceId && client.writable("desktop.command"))
      refreshInspections(
        client,
        librarySourceId,
        snapshot.projects as ReadProject[],
        inspections,
        publish,
      );
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
      pages?.dispose();
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
  function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function jsonObject(value: Record<string, unknown>): JsonObject {
    // 桌面契约已经验证请求；JSON 往返仅移除 UI 可选字段中的 undefined。
    return JSON.parse(JSON.stringify(value));
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
      const project = snapshot.projects.find((value) => value.id === params.projectId) as
        | ReadProject
        | undefined;
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
        try {
          await client.refreshShell();
        } catch (error) {
          throw Object.assign(new Error("创建已受理，目录尚未同步，请核对原请求。"), {
            cause: error,
            requestId: commandId,
            submissionUnknown: true,
          });
        }
        return {
          routed: true,
          value: { threadId: result.threadId, requestId: result.nativeRequestId ?? commandId },
        };
      }
      if (
        project &&
        name === "reconcile" &&
        typeof params.requestId === "string" &&
        client.writable("command.read")
      ) {
        const connection = client.snapshot();
        if (connection.connection !== "ready") throw new Error("Host unavailable");
        const owner =
          commandOwners.get(JSON.stringify([connection.identity.hostId, params.requestId])) ??
          (session && threadTargets.get(`${project.id}:${session.threadId}`) === session.projectId
            ? session.projectId
            : project.hostProjectId);
        const result = await client.commandStatus(owner, params.requestId);
        if (client.snapshot() !== connection) throw new Error("Host command read cancelled");
        const outcome = hostCommandOutcome(result, params.requestId);
        const key = JSON.stringify([connection.identity.hostId, owner]);
        commandOutcomes.set(key, { ...commandOutcomes.get(key), [params.requestId]: outcome });
        publish();
        return {
          routed: true,
          value: {
            outcomes: { [params.requestId]: outcome },
          },
        };
      }
      const target = hostTarget(params);
      if (!target) return undefined;
      try {
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
            ...(params.expectedTurnId ? { expectedTurnId: params.expectedTurnId } : {}),
          });
          const commandId =
            typeof params.requestId === "string" ? params.requestId : crypto.randomUUID();
          const owner = client.snapshot();
          if (owner.connection !== "ready") throw new Error("Host unavailable");
          const command = await client.command(
            name === "send" ? "session.send" : "session.control",
            target.hostProjectId,
            name === "send"
              ? {
                  threadId: target.threadId,
                  expectedConfigRevision: Number(config.revision),
                  ...input,
                  enqueue: params.enqueue === true,
                }
              : {
                  threadId: target.threadId,
                  operation: "steer",
                  expectedRevision: Number(config.revision),
                  values: input,
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
              ...(typeof result.turnId === "string" ? { turnId: result.turnId } : {}),
            },
          };
        }
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
  const workbench = createWorkbenchRoutes(
    client,
    desktop,
    domains,
    options.events,
    globalThis.document,
    () => librarySourceId,
  );
  const unavailable = async () => {
    throw new Error("此功能需要桌面应用");
  };
  return {
    ...(desktop ?? {
      chooseProject: () => chooseHostProject(client, librarySourceId),
      command: hostDesktopCommand(
        client,
        () => librarySourceId,
        (next) => {
          snapshot = next as unknown as Snapshot;
          publish();
        },
      ),
      theme: async () => ({
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        id: "system",
      }),
      onTheme: () => () => {},
      preview: unavailable,
    }),
    get capabilities() {
      return hostPlatformCapabilities(client, desktop, domains, librarySourceId, options.writes);
    },
    reads,
    ...(options.writes && { writes }),
    ...(workbench && { workbench }),
    ...(pages && { mcpApp: pages.mcpApp, onMcpAppEvent: pages.onMcpAppEvent }),
    snapshot: async () => snapshot,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
