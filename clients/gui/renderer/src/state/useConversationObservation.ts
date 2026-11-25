import { useCallback, useRef } from "react";
import type { Action, Data } from "../services.js";
import type { useSessionNavigation } from "./useSessionNavigation.js";
export function useConversationObservation(
  session: ReturnType<typeof useSessionNavigation>,
  action: Action,
  nextPromptSuggestions: boolean,
  initialReleased: boolean,
  settingsOpen: boolean,
  taskCenterOpen: boolean,
) {
  const { project, thread, threadId, snapshot, library, resourceAction } = session;
  const cancelledPredictions = useRef(new Set<string>());
  const cancelDisabledPredictions = () => {
    if (session.readOnly) return;
    if (nextPromptSuggestions) {
      cancelledPredictions.current.clear();
      return;
    }
    const pending = new Set<string>();
    for (const project of snapshot.projects) {
      if (!project.state?.connected || !project.core?.features?.promptPrediction) continue;
      for (const thread of Object.values(project.state.threads ?? {}) as Data[]) {
        const slot = thread.desktop?.promptPrediction;
        if (slot?.status !== "pending") continue;
        const key = `${project.core?.instanceId}:${project.id}:${thread.id}:${slot.sourceTurnId}`;
        pending.add(key);
        if (cancelledPredictions.current.has(key)) continue;
        cancelledPredictions.current.add(key);
        void action("prediction", {
          projectId: project.id,
          threadId: thread.id,
          sourceTurnId: slot.sourceTurnId,
          operation: "cancel",
        }).catch(() => {});
      }
    }
    for (const key of cancelledPredictions.current)
      if (!pending.has(key)) cancelledPredictions.current.delete(key);
  };
  const readTurnReview = useCallback(
    (turnId: string, itemId?: string) =>
      resourceAction("workspace", {
        projectId: project?.id,
        threadId,
        turnId,
        itemId,
        operation: "turnReview",
      }),
    [resourceAction, project?.id, threadId],
  );
  const selectedCompletion = library.threads?.[`${project?.id}:${threadId}`]?.completionId;
  const completionInterruptPending =
    snapshot.lifecycle?.operations.some(
      (operation) =>
        operation.kind === "interruptTurn" &&
        operation.threadId === threadId &&
        operation.turnId === selectedCompletion &&
        operation.phase !== "completed" &&
        operation.phase !== "blocked" &&
        operation.targets.some(
          (target) =>
            target.projectId === project?.id &&
            target.phase !== "completed" &&
            target.phase !== "blocked",
        ),
    ) ?? false;
  const lastMarkedCompletion = useRef<string | undefined>(undefined);
  const markForegroundCompletionRead = () => {
    const activeKey =
      project?.id && threadId && selectedCompletion
        ? `${project.id}:${threadId}:${selectedCompletion}`
        : undefined;
    if (!activeKey || lastMarkedCompletion.current !== activeKey) {
      lastMarkedCompletion.current = undefined;
    }
    // A new completion visible in the foreground is read. A manual unread mark
    // does not change completionId, so it survives until the user opens it again.
    if (
      session.readOnly ||
      !initialReleased ||
      !project?.id ||
      !project.state?.connected ||
      !threadId ||
      thread?.id !== threadId ||
      !selectedCompletion ||
      completionInterruptPending ||
      settingsOpen ||
      taskCenterOpen ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    if (lastMarkedCompletion.current === activeKey) return;
    const targetProjectId = project.id;
    const targetThreadId = threadId;
    const targetCompletionId = selectedCompletion;
    const timer = setTimeout(() => {
      lastMarkedCompletion.current = activeKey;
      // 静默后台已读上报走 resourceAction，避免网络/队列抖动时弹出操作失败横幅。
      void resourceAction("library", {
        operation: "readThread",
        projectId: targetProjectId,
        threadId: targetThreadId,
        read: true,
        completionId: targetCompletionId,
      }).catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  };
  return {
    cancelDisabledPredictions,
    markForegroundCompletionRead,
    readTurnReview,
    selectedCompletion,
    completionInterruptPending,
  };
}
