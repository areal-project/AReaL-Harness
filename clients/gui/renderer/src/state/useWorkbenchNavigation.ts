import { useCallback } from "react";
import { type PlatformServices } from "../services.js";
import type { ResourceDraftSeed } from "../settings/PluginSkillsPage.js";
import { useGuardedNavigation } from "../settings/UnsavedChanges.js";
import { useNavigationWorkspace } from "../state/navigationWorkspace.js";
import { prepareResourceDraft } from "../state/resourceDraft.js";
import { useTaskWorkspace } from "../state/taskWorkspace.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";
import { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
export function useWorkbenchNavigation(
  services: PlatformServices,
  session: ReturnType<typeof useSessionNavigation>,
  surfaces: ReturnType<typeof useWorkbenchSurfaces>,
  tasks: ReturnType<typeof useTaskWorkspace>["workspace"],
  workspacePanels: ReturnType<typeof useWorkspacePanels>,
  navigation: ReturnType<typeof useNavigationWorkspace>["workspace"],
  initialReleased: boolean,
  taskCenterOpen: boolean,
  requestNavigation: ReturnType<typeof useGuardedNavigation>,
  setSidebar: (show: boolean) => void,
  setError: (message: string) => void,
) {
  const {
    resourceAction,
    project,
    snapshot,
    setSnapshot,
    recordWorkspaceLocation,
    restoreConversation,
    workspaceHistory,
  } = session;
  const { settingsOpen } = surfaces;
  const choose = async () => {
    if (!initialReleased || services.capabilities?.mutations === false) return;
    try {
      const id = await services.chooseProject();
      if (id) {
        workspacePanels.selectPanel("");
        recordWorkspaceLocation({
          projectId: id,
          threadId:
            id === project?.id ? "" : (localStorage.getItem(`areal-gui:thread:${id}`) ?? ""),
        });
        session.beginChosenProject(id);
        if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
        setSnapshot(await services.snapshot());
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = useCallback(
    async (pid: string, id: string, navigation: "push" | "replace" | "restore" = "push") => {
      if (!initialReleased) return;
      if (navigation !== "restore")
        recordWorkspaceLocation({ projectId: pid, threadId: id }, navigation === "replace");
      surfaces.leavePlugins();
      tasks.close();
      if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
      await session.selectConversation(pid, id);
    },
    [initialReleased, snapshot.projects, restoreConversation, recordWorkspaceLocation],
  );
  const newTask = (pid = project?.id, record = true) => {
    if (
      !initialReleased ||
      (services.capabilities?.conversationCreate ?? services.capabilities?.mutations) === false
    )
      return;
    if (!pid || snapshot.projects.find((p) => p.id === pid)?.projectless) {
      leaveProject(record);
      return;
    }
    requestNavigation(() => {
      if (record) recordWorkspaceLocation({ projectId: pid, threadId: "" });
      surfaces.leavePlugins();
      tasks.close();
      session.selectDraft(pid);
      workspacePanels.selectPanel("");
      surfaces.leaveSettings();
      if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
    });
  };
  const leaveProject = (record = true) => {
    if (!initialReleased) return;
    requestNavigation(() => {
      if (record) recordWorkspaceLocation({ projectId: "", threadId: "" });
      surfaces.leavePlugins();
      tasks.close();
      surfaces.leaveSettings();
      session.selectDraft(undefined);
      workspacePanels.selectPanel("");
    });
  };
  const traverseWorkspaceHistory = (delta: -1 | 1) => {
    if (!initialReleased || settingsOpen || taskCenterOpen) return;
    const index = workspaceHistory.index + delta;
    const next = workspaceHistory.entries[index];
    if (!next) return;
    requestNavigation(() => {
      // A removed project/task is not reconstructed or executed by GUI history.
      const owner = snapshot.projects.find((p) => p.id === next.projectId);
      if (next.projectId && (!owner || (next.threadId && !owner.state?.threads[next.threadId]))) {
        setError("该导航位置的项目或任务已不可用。");
        return;
      }
      session.traverse(index);
      if (next.threadId) void open(next.projectId, next.threadId, "restore");
      else if (next.projectId) newTask(next.projectId, false);
      else leaveProject(false);
    });
  };
  const startResourceDraft = async (seed: ResourceDraftSeed) => {
    if (!initialReleased || services.capabilities?.mutations === false) return;
    const { owner, key } = await prepareResourceDraft(
      seed,
      project,
      snapshot,
      services,
      resourceAction,
      setSnapshot,
    );
    requestNavigation(() => {
      surfaces.leavePlugins();
      surfaces.leaveSettings();
      tasks.close();
      workspacePanels.selectPanel("");
      session.selectDraft(owner?.id);
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    });
  };
  const subscribeShortcuts = () => {
    const listener = (e: KeyboardEvent) => {
      if (!initialReleased) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        ["[", "]"].includes(e.key) &&
        !e.isComposing &&
        !document.querySelector('[data-slot="dialog-content"]')
      ) {
        e.preventDefault();
        traverseWorkspaceHistory(e.key === "[" ? -1 : 1);
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "n" &&
        !e.isComposing &&
        !document.querySelector('[data-slot="dialog-content"]')
      ) {
        e.preventDefault();
        void newTask();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  };
  const subscribeNotifications = () => {
    if (!initialReleased) return;
    return services.onNotificationOpen?.((target) =>
      requestNavigation(() => {
        surfaces.leaveSettings();
        navigation.hideSearch();
        if (target.taskId !== undefined) {
          tasks.openTarget({
            projectId: target.projectId,
            taskId: target.taskId,
            runId: target.runId,
            questionId: target.questionId,
            eventId: crypto.randomUUID(),
          });
        } else void open(target.projectId, target.threadId);
      }),
    );
  };
  return {
    choose,
    open,
    newTask,
    leaveProject,
    traverseWorkspaceHistory,
    startResourceDraft,
    subscribeShortcuts,
    subscribeNotifications,
  };
}
