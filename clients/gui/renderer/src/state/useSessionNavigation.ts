import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  recoveryMessage,
  sameRecoveryOwner,
  type RecoveryFailure,
  type RecoveryOwner,
} from "../recoveryPresentation.js";
import { useCloudEnvironment } from "../cloudEnvironment.js";
import { call, type Action, type PlatformServices, type Snapshot } from "../services.js";
import { conversationCatalog } from "./conversationCatalog.js";
type InitialLocation =
  | { kind: "automatic" | "projectless" }
  | { kind: "project"; projectId: string; threadId: string };
type RestorationOwner = RecoveryOwner;
type RestorationState = RestorationOwner & {
  pending: boolean;
  error: string;
  failureId?: string;
  failure?: RecoveryFailure;
};
type RestorationAttempt = RestorationOwner & {
  operation: "connect" | "open";
  pending: boolean;
  promise: Promise<void>;
};

export function useSessionNavigation(
  services: PlatformServices,
  onError: (message: string) => void,
) {
  const resourceBrowsing = useRef(false);
  const [snapshot, updateSnapshot] = useState<Snapshot>({
    projects: [],
    connection: { state: "connecting" },
  });
  const [restoration, setRestoration] = useState<RestorationState>();
  const restorationAttempt = useRef<RestorationAttempt | undefined>(undefined);
  const [selectedProject, setSelectedProject] = useState<string>();
  // 初始 IPC 读回可能晚于订阅事件；只接受本 GUI 连接中更新的投影。
  const setSnapshot = useCallback(
    (next: Snapshot) =>
      updateSnapshot((previous) =>
        next.revision !== undefined &&
        previous.revision !== undefined &&
        next.revision < previous.revision
          ? previous
          : next,
      ),
    [],
  );
  const [initialLocation] = useState<InitialLocation>(() => {
    const saved = localStorage.getItem("areal-gui:project");
    return saved === null
      ? { kind: "automatic" }
      : saved === ""
        ? { kind: "projectless" }
        : {
            kind: "project",
            projectId: saved,
            threadId: localStorage.getItem(`areal-gui:thread:${saved}`) ?? "",
          };
  });
  const [projectId, setProjectId] = useState(
    initialLocation.kind === "project" ? initialLocation.projectId : "",
  );
  const [noProject, setNoProject] = useState(initialLocation.kind === "projectless");
  const [threadId, setThreadId] = useState(
    initialLocation.kind === "project" ? initialLocation.threadId : "",
  );
  // Window-local locations, never Core execution or a persisted recovery log.
  const [workspaceHistory, setWorkspaceHistory] = useState<{
    entries: { projectId: string; threadId: string }[];
    index: number;
  }>({ entries: [], index: -1 });
  const library = useMemo(
    () => snapshot.library ?? { projects: {}, threads: {}, projectOrder: [], settings: {} },
    [snapshot.library],
  );
  const projects = useMemo(
    () =>
      snapshot.projects
        .filter((p) => !library.projects?.[p.id]?.hidden)
        .sort((a, b) => {
          const order = library.projectOrder ?? [];
          const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
          return rank(a.id) - rank(b.id);
        }),
    [snapshot.projects, library],
  );
  const summaries = useMemo(() => conversationCatalog(projects, library), [projects, library]);
  // Sidebar visibility must not change the owner of an explicitly opened resource.
  const logicalProject = noProject
    ? undefined
    : (snapshot.projects.find((p) => p.id === projectId) ??
      (snapshot.connection?.state === "ready" ? projects.find((p) => !p.projectless) : undefined));
  const executionThread = logicalProject?.state?.threads[threadId];
  const project =
    logicalProject && executionThread?.worktree?.directory
      ? {
          ...logicalProject,
          logicalRoot: logicalProject.root,
          root: executionThread.worktree.directory,
          core: { ...logicalProject.core, ...executionThread.executionCore },
          state: {
            ...logicalProject.state,
            connected: executionThread.executionConnected ?? logicalProject.state?.connected,
          },
          error: executionThread.executionError ?? logicalProject.error,
        }
      : logicalProject;
  const thread = project?.state?.threads[threadId];
  const restorationOwner: RestorationOwner = {
    projectId: project?.id ?? "",
    threadId,
    connectionGeneration: project?.core?.connectionGeneration ?? 0,
  };
  const selectedRestoration = useRef(restorationOwner);
  selectedRestoration.current = restorationOwner;
  const selectionReady = selectedProject === (project?.id ?? "");
  // Resource pages own their loading, validation and recovery feedback.
  const resourceAction: Action = useCallback<Action>(
    (name, params) => {
      return call(
        services,
        name,
        name === "workspace" &&
          threadId &&
          "projectId" in params &&
          params.projectId === project?.id &&
          !("threadId" in params && params.threadId) &&
          "operation" in params &&
          typeof params.operation === "string" &&
          !params.operation.startsWith("worktree")
          ? { ...params, threadId }
          : params,
      );
    },
    [services, project?.id, threadId],
  );
  const { environment, ready: environmentReady } = useCloudEnvironment(
    project ?? { id: "projectless" },
    resourceAction,
  );
  useEffect(() => {
    if (
      resourceBrowsing.current ||
      !project?.id ||
      threadId ||
      !environmentReady ||
      environment !== "local" ||
      snapshot.connection?.state !== "ready"
    )
      return;
    void resourceAction("connect", { projectId: project.id }).catch(() => {});
  }, [
    project?.id,
    threadId,
    environmentReady,
    environment,
    snapshot.connection?.state,
    resourceAction,
  ]);
  const restorationProjects = useRef(snapshot.projects);
  restorationProjects.current = snapshot.projects;
  const contextualFileOpen = useMemo<PlatformServices["fileOpen"]>(
    () =>
      services.fileOpen
        ? (request) => {
            return services.fileOpen!(
              "projectId" in request && request.projectId === project?.id && threadId
                ? { ...request, threadId }
                : request,
            );
          }
        : undefined,
    [services.fileOpen, project?.id, threadId],
  );
  const recordWorkspaceLocation = useCallback(
    (next: { projectId: string; threadId: string }, replace = false) => {
      setWorkspaceHistory((history) => {
        const current =
          history.entries[history.index] ??
          (project
            ? { projectId: project.id, threadId }
            : noProject
              ? { projectId: "", threadId: "" }
              : next);
        const same = current.projectId === next.projectId && current.threadId === next.threadId;
        if (same && history.entries.length) return history;
        const entries = history.entries.length
          ? history.entries.slice(0, history.index + 1)
          : [current];
        if (replace || same) entries[entries.length - 1] = next;
        else entries.push(next);
        return { entries, index: entries.length - 1 };
      });
    },
    [project?.id, threadId, noProject],
  );
  const restoreConversation = useCallback(
    (
      owner: RestorationOwner,
      operation: "connect" | "open",
      options: { connectService?: boolean; resumeScheduling?: boolean } = {},
    ) => {
      const previous = restorationAttempt.current;
      if (
        sameRecoveryOwner(previous, owner) &&
        previous?.operation === operation &&
        previous.pending
      )
        return previous.promise;
      const attempt: RestorationAttempt = {
        ...owner,
        operation,
        pending: true,
        promise: Promise.resolve(),
      };
      restorationAttempt.current = attempt;
      setRestoration((previous) =>
        sameRecoveryOwner(previous, owner) && previous
          ? { ...previous, pending: true }
          : { ...owner, pending: true, error: "" },
      );
      const current = () =>
        restorationAttempt.current === attempt &&
        sameRecoveryOwner(selectedRestoration.current, owner);
      attempt.promise = (async () => {
        try {
          if (options.connectService) {
            await resourceAction("connectService", {});
            if (!current()) return;
          }
          const target = restorationProjects.current.find((item) => item.id === owner.projectId);
          const cloud =
            target?.state?.threads?.[owner.threadId]?.cloud ||
            (!owner.threadId &&
              localStorage.getItem(`areal-draft-environment:${owner.projectId}`) === "cloud");
          if (operation === "connect" && !cloud)
            await resourceAction("connect", {
              projectId: owner.projectId,
              ...(owner.threadId ? { threadId: owner.threadId } : {}),
              ...(options.resumeScheduling ? { resumeScheduling: true } : {}),
            });
          else if (owner.threadId) {
            await resourceAction("open", { projectId: owner.projectId, threadId: owner.threadId });
            if (!current()) return;
            void resourceAction("library", {
              operation: "readThread",
              projectId: owner.projectId,
              threadId: owner.threadId,
              read: true,
            }).catch(() => {});
          }
          if (current()) setRestoration({ ...owner, pending: false, error: "" });
        } catch (cause) {
          if (current()) {
            const failure = cause as RecoveryFailure;
            setRestoration({
              ...owner,
              pending: false,
              error: recoveryMessage(failure, "view"),
              failure,
              failureId: crypto.randomUUID(),
            });
          }
        } finally {
          attempt.pending = false;
        }
      })();
      return attempt.promise;
    },
    [resourceAction],
  );
  const subscribe = () => {
    const unsubscribe = services.onState(setSnapshot);
    void services
      .snapshot()
      .then(setSnapshot)
      .catch((e) => {
        onError(e.message);
        updateSnapshot((previous) =>
          previous.connection?.state === "ready"
            ? previous
            : { ...previous, connection: { state: "unavailable", message: e.message } },
        );
      });
    return unsubscribe;
  };
  const synchronizeSelection = () => {
    if (snapshot.connection?.state !== "ready" || selectionReady) return;
    setSelectedProject(project?.id ?? "");
    if (!project?.id) {
      setProjectId("");
      setThreadId("");
      localStorage.setItem("areal-gui:project", "");
      return;
    }
    setProjectId(project.id);
    localStorage.setItem("areal-gui:project", project.id);
    const remembered = localStorage.getItem(`areal-gui:thread:${project.id}`);
    setThreadId(remembered ?? "");
  };
  const synchronizeRestoration = () => {
    if (
      resourceBrowsing.current ||
      !selectionReady ||
      !project?.id ||
      snapshot.connection?.state !== "ready"
    )
      return;
    const previous = restorationAttempt.current;
    const owner = {
      projectId: project.id,
      threadId,
      connectionGeneration: project.core?.connectionGeneration ?? 0,
    };
    if (!project.state?.connected && sameRecoveryOwner(previous, owner)) return;
    if (project.observationErrors?.[threadId]?.connectionGeneration === owner.connectionGeneration)
      return;
    void restoreConversation(owner, project.state?.connected ? "open" : "connect");
  };
  const retryRestoration = async () => {
    if (!project) return;
    await restoreConversation(restorationOwner, project.state?.connected ? "open" : "connect", {
      connectService: snapshot.connection?.state !== "ready",
      resumeScheduling: true,
    });
  };
  const selectConversation = async (pid: string, id: string) => {
    setNoProject(false);
    setProjectId(pid);
    setThreadId(id);
    localStorage.setItem(`areal-gui:thread:${pid}`, id);
    const target = snapshot.projects.find((item) => item.id === pid);
    const owner = {
      projectId: pid,
      threadId: id,
      connectionGeneration: target?.core?.connectionGeneration ?? 0,
    };
    selectedRestoration.current = owner;
    await restoreConversation(owner, target?.state?.connected ? "open" : "connect");
  };
  const selectDraft = (pid: string | undefined) => {
    if (pid) localStorage.removeItem(`areal-gui:thread:${pid}`);
    setNoProject(!pid);
    setProjectId(pid ?? "");
    setThreadId("");
    if (!pid) localStorage.setItem("areal-gui:project", "");
  };
  return {
    resourceBrowsing,
    snapshot,
    library,
    projects,
    summaries,
    project,
    thread,
    projectId,
    threadId,
    noProject,
    initialLocation,
    workspaceHistory,
    restoration,
    restorationOwner,
    selectionReady,
    resourceAction,
    contextualFileOpen,
    setSnapshot,
    subscribe,
    restoreConversation,
    synchronizeSelection,
    synchronizeRestoration,
    retryRestoration,
    recordWorkspaceLocation,
    selectConversation,
    selectDraft,
    dispose: () => {
      restorationAttempt.current = undefined;
    },
    pendingRestoration: () =>
      restorationAttempt.current?.pending ? restorationAttempt.current.promise : undefined,
    selectProject(pid: string) {
      setNoProject(false);
      setProjectId(pid);
    },
    beginChosenProject(pid: string) {
      setNoProject(false);
      setProjectId(pid);
      setThreadId("");
    },
    traverse(index: number) {
      setWorkspaceHistory((history) => ({ ...history, index }));
    },
  };
}
