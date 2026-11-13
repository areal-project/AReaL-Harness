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
  const markForegroundCompletionRead = () => {
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
    void action("library", {
      operation: "readThread",
      projectId: project.id,
      threadId,
      read: true,
      completionId: selectedCompletion,
    }).catch(() => {});
  };
  return {
    cancelDisabledPredictions,
    markForegroundCompletionRead,
    readTurnReview,
    selectedCompletion,
    completionInterruptPending,
  };
}
