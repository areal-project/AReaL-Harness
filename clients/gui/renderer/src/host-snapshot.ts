import type {
  HostClient,
  HostClientOptions,
  SessionRead,
  ShellRead,
  ShellProject,
  NavigationSummary,
  WorktreeDisplay,
  JsonObject,
} from "@areal/client";
import { mergeHistory, historyGaps } from "@areal/workbench/history-projection";
import type { ReadingAnchor } from "./readingViews.js";
import type { PlatformServices, Snapshot } from "./services.js";
import type { Observation, HistoryPage, HistoryEntry, PageRecord } from "./host-services.js";

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
export function settleHostCommand(
  result: import("@areal/client").HostCommandResult,
  operation?: import("./recoveryPresentation.js").RecoveryOperation,
) {
  if (result.admissionState === "accepted" || result.admissionState === "pending") return;
  const rejected = result.admissionState === "rejected";
  const outcome = rejected
    ? { kind: "rejected" }
    : operation
      ? { kind: "unconfirmed", operation }
      : undefined;
  throw Object.assign(
    new Error(rejected ? "Host 拒绝了该操作" : "操作结果尚未确认。正在核对原请求，不会自动重发。"),
    {
      commandId: result.commandId,
      requestId: result.commandId,
      submissionUnknown: !rejected,
      outcome,
    },
  );
}
export function admitHostCommand(
  result: import("@areal/client").HostCommandResult,
  operation?: import("./recoveryPresentation.js").RecoveryOperation,
): JsonObject {
  if (result.admissionState === "accepted") return result;
  settleHostCommand(
    result.admissionState === "pending" ? { ...result, admissionState: "unknown" } : result,
    operation,
  );
  throw new Error("Invalid Host admission result");
}
export function hostCommandOutcome(result: unknown, requestId: string): JsonObject {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(result)) throw new Error("Invalid Host command result");
  if (result.commandId !== requestId) throw new Error("Host command identity changed");
  if (
    typeof result.admissionState !== "string" ||
    !["accepted", "rejected", "pending", "unknown", "notFound"].includes(result.admissionState)
  )
    throw new Error("Invalid Host admission state");
  const accepted = result.admissionState === "accepted";
  const rejected = result.admissionState === "rejected";
  const threadId =
    typeof result.threadId === "string"
      ? result.threadId
      : object(result.target) && typeof result.target.threadId === "string"
        ? result.target.threadId
        : undefined;
  const method =
    result.method === "session.send"
      ? "turn/start"
      : result.method === "session.control" &&
          object(result.target) &&
          result.target.operation === "steer"
        ? "turn/steer"
        : undefined;
  return {
    admissionState: result.admissionState,
    ...(accepted || rejected ? { accepted, status: accepted ? "completed" : "failed" } : {}),
    ...(threadId ? { threadId } : {}),
    ...(typeof result.turnId === "string" ? { turnId: result.turnId } : {}),
    ...(method && threadId
      ? {
          operation: {
            method,
            requestId,
            target: { kind: "thread", threadId },
          },
        }
      : {}),
  };
}
export function windowIdentity(observation: Observation) {
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
  executionHostState?: ShellProject["state"];
  executionError: null;
  worktree?: WorktreeDisplay;
};
export type ReadProject = Record<string, unknown> & {
  id: string;
  hostProjectId: string;
  logicalProjectId?: string;
  root: string;
  projectless: boolean;
  models: readonly unknown[];
  profiles: readonly unknown[];
  configurations: Record<string, unknown>;
  core: ExecutionView["executionCore"] & Record<string, unknown>;
  state: {
    connected: boolean;
    hostState?: ShellProject["state"];
    error: null;
    threads: Record<string, Observation["thread"] & ExecutionView>;
    queues: Record<string, unknown>;
    interactions: Record<string, unknown>;
    tasks?: Record<string, unknown>;
  };
  summaries: (NavigationSummary & ExecutionView)[];
  summariesLoaded: boolean;
  summariesFreshness: "fresh" | "cached" | "unknown";
};

export function configurationIdentity(configuration: unknown) {
  const value = configuration as { revision?: unknown; defaultModelRevision?: unknown } | null;
  return JSON.stringify([value?.revision ?? null, value?.defaultModelRevision ?? null]);
}

export function createHostSnapshotProjector(
  client: HostClient,
  desktop: PlatformServices | undefined,
  options: HostClientOptions & { preferredSourceId?: string },
  ids: Map<string, string>,
  threadTargets: Map<string, string>,
  creationTargets: Map<string, string>,
  catalogs: Map<string, { identity: string; value?: Record<string, unknown> }>,
  inspections: Map<string, { identity: string; value?: Record<string, unknown> }> = new Map(),
) {
  let revision = 0;
  const projectViews = new Map<
    string,
    {
      source: ShellProject;
      auxiliary: unknown;
      bound: boolean;
      session?: SessionRead;
      historyVersion: number;
      fresh: boolean;
      sessionFreshness?: string;
      outcomes?: Record<string, JsonObject>;
      value: ReadProject;
    }
  >();
  const logicalViews = new Map<string, { owners: ReadProject[]; value: ReadProject }>();
  function projectSnapshot(
    shell: ShellRead | undefined,
    fresh: boolean,
    currentSession: SessionRead | undefined,
    native: Observation | undefined,
    {
      legacy,
      readingWindow,
      observation,
      session,
      historyVersion,
      commandOutcomes,
    }: {
      legacy?: Snapshot;
      readingWindow?: ReadingWindow;
      observation?: Observation;
      session?: SessionRead;
      historyVersion: number;
      commandOutcomes: ReadonlyMap<string, Record<string, JsonObject>>;
    },
  ): { snapshot: Snapshot; sourceId?: string } {
    ids.clear();
    threadTargets.clear();
    for (const [target, execution] of creationTargets) threadTargets.set(target, execution);
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
    const sourceId = navigation?.sourceId;
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
      const desktopProject = legacy?.projects.find((value) => value.id === id);
      const auxiliary = desktopProject ?? catalogs.get(project.projectId)?.value;
      const bound = !!navigation?.bindings.some(
        (binding) => binding.projectId === project.projectId && binding.alias === id,
      );
      const selectedSession =
        currentSession?.projectId === project.projectId &&
        currentSession.serviceGeneration === project.serviceGeneration
          ? currentSession
          : undefined;
      const cached = projectViews.get(project.projectId);
      const outcomes =
        connection.connection === "ready"
          ? commandOutcomes.get(JSON.stringify([connection.identity.hostId, project.projectId]))
          : undefined;
      const displayVersion = selectedSession ? historyVersion : 0;
      const sessionFreshness = selectedSession ? client.readsSnapshot().session.state : undefined;
      if (
        cached &&
        cached.source === project &&
        cached.auxiliary === auxiliary &&
        cached.bound === bound &&
        cached.session === selectedSession &&
        cached.historyVersion === displayVersion &&
        cached.fresh === fresh &&
        cached.sessionFreshness === sessionFreshness &&
        cached.outcomes === outcomes &&
        cached.value.id === id
      ) {
        for (const summary of cached.value.summaries)
          threadTargets.set(
            `${canonical(project.logicalProjectId ?? project.projectId)}:${summary.id}`,
            project.projectId,
          );
        for (const id of Object.keys(cached.value.state.threads))
          threadTargets.set(
            `${canonical(project.logicalProjectId ?? project.projectId)}:${id}`,
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
        executionHostState: fresh ? project.state : undefined,
        executionError: null,
        ...(project.worktree ? { worktree: project.worktree } : {}),
      };
      const logicalId = canonical(project.logicalProjectId ?? project.projectId);
      const summaries = project.summaries.items.map((summary) => {
        threadTargets.set(`${logicalId}:${summary.id}`, project.projectId);
        return { ...summary, ...execution };
      });
      const desktop = thread?.desktop;
      const trustedDesktop =
        fresh &&
        project.state === "ready" &&
        desktopProject?.state?.connected &&
        project.serviceGeneration &&
        desktopProject.core?.serviceGeneration === project.serviceGeneration &&
        bound;
      const runThreadIds = new Set(
        trustedDesktop
          ? Object.entries(desktopProject.state.tasks ?? {}).flatMap(
              ([id, task]: [string, unknown]) => {
                if (
                  !task ||
                  typeof task !== "object" ||
                  !("id" in task) ||
                  task.id !== id ||
                  !("mode" in task) ||
                  task.mode !== "scheduled" ||
                  !("runs" in task) ||
                  !Array.isArray(task.runs)
                )
                  return [];
                return task.runs.flatMap((run: unknown) =>
                  run &&
                  typeof run === "object" &&
                  "id" in run &&
                  typeof run.id === "string" &&
                  run.id.length > 0 &&
                  "threadId" in run &&
                  typeof run.threadId === "string" &&
                  run.threadId.length > 0
                    ? [run.threadId]
                    : [],
                );
              },
            )
          : [],
      );
      const auxiliaryThreads = trustedDesktop
        ? Object.entries(
            (desktopProject.state.threads ?? {}) as Record<string, Observation["thread"]>,
          ).filter(
            ([key, value]) =>
              value?.id === key &&
              key !== thread?.id &&
              Array.isArray(value.turns) &&
              (runThreadIds.has(key) ||
                (value.conversation?.kind === "side" &&
                  value.conversation.policy?.kind === "sideExecutableV2" &&
                  typeof (value.conversation.origin as { sourceThreadId?: unknown } | undefined)
                    ?.sourceThreadId === "string")),
          )
        : [];
      for (const [threadId] of auxiliaryThreads)
        threadTargets.set(`${logicalId}:${threadId}`, project.projectId);
      const value: ReadProject = {
        ...auxiliary,
        models: Array.isArray(auxiliary?.models) ? auxiliary.models : [],
        profiles: Array.isArray(auxiliary?.profiles) ? auxiliary.profiles : [],
        id,
        hostProjectId: project.projectId,
        root: project.workspace,
        projectless: project.projectless,
        logicalProjectId: project.logicalProjectId
          ? canonical(project.logicalProjectId)
          : undefined,
        core: {
          ...auxiliary?.core,
          // 网页没有桌面后台的项目快照，权限能力随 project.models 一起从 Host 来。
          ...(auxiliary?.features ? { features: auxiliary.features } : {}),
          serviceGeneration: project.serviceGeneration ?? null,
          connectionGeneration: project.serviceGeneration ?? "",
          instanceId: project.serviceGeneration ?? "",
        },
        state: {
          ...(trustedDesktop ? { tasks: desktopProject.state.tasks } : {}),
          connected: fresh && project.state === "ready",
          hostState: fresh ? project.state : undefined,
          error: null,
          threads: {
            ...Object.fromEntries(
              auxiliaryThreads.map(([key, side]) => [key, { ...side, ...execution }]),
            ),
            ...(thread ? { [thread.id]: { ...thread, ...execution } } : {}),
          },
          queues: {
            ...Object.fromEntries(
              auxiliaryThreads
                .filter(([, side]) => side.desktop?.queue)
                .map(([key, side]) => [key, side.desktop!.queue]),
            ),
            ...(thread && desktop?.queue ? { [thread.id]: desktop.queue } : {}),
          },
          interactions: {
            ...Object.fromEntries(
              auxiliaryThreads
                .filter(([, side]) => side.desktop?.interactions)
                .map(([key, side]) => [
                  key,
                  {
                    revision: side.desktop!.interactionRevision ?? 0,
                    data: side.desktop!.interactions,
                  },
                ]),
            ),
            ...(thread && desktop?.interactions
              ? {
                  [thread.id]: {
                    revision: desktop.interactionRevision ?? 0,
                    data: desktop.interactions,
                  },
                }
              : {}),
          },
        },
        configurations: {
          ...Object.fromEntries(
            auxiliaryThreads
              .filter(([, side]) => side.desktop?.configuration)
              .map(([key, side]) => [key, side.desktop!.configuration]),
          ),
          ...(thread && desktop?.configuration
            ? {
                [thread.id]: {
                  ...desktop.configuration,
                  // 会话配置不带解析后的模型名；网页经后台 inspect 补上，与桌面一致。
                  ...(inspections.get(`${id}:${thread.id}`)?.identity ===
                  configurationIdentity(desktop.configuration)
                    ? inspections.get(`${id}:${thread.id}`)?.value
                    : {}),
                },
              }
            : {}),
        },
        summaries,
        summariesLoaded: project.summaries.state === "fresh",
        summariesFreshness: project.summaries.state,
        pending: auxiliary?.pending ?? [],
        outcomes: outcomes ? { ...auxiliary?.outcomes, ...outcomes } : (auxiliary?.outcomes ?? {}),
        error: null,
        observationErrors: {},
        attention: project.attention,
      };
      projectViews.set(project.projectId, {
        source: project,
        auxiliary,
        bound,
        session: selectedSession,
        historyVersion: displayVersion,
        fresh,
        sessionFreshness,
        outcomes,
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
          configurations: Object.fromEntries(
            owners.flatMap((owner) => Object.entries(owner.configurations)),
          ),
          outcomes: Object.assign({}, ...owners.map((owner) => owner.outcomes)),
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
      sourceId,
      snapshot: {
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
      },
    };
  }
  return projectSnapshot;
}
