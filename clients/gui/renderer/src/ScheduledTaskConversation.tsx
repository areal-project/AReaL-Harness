import { TitleTooltip } from "@areal/ui";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { ScheduledWorkspace } from "./ScheduledTasks.js";
import {
  scheduledTaskConversation,
  scheduledTaskName,
  scheduledTaskState,
  scheduledTaskStateLabel,
  scheduledTaskSummary,
} from "./scheduleText.js";
import type { TaskConversationRenderer } from "./TaskDraft.js";
import { TaskRunConversations } from "./TaskRunConversations.js";
import type { Action, Data } from "./services.js";

export function ScheduledTaskConversation({
  task,
  project,
  action,
  disabled,
  history,
  onClose,
  onOpenThread,
  onReveal,
  renderConversation,
  renderResources,
}: {
  task: Data;
  project: Data;
  action: Action;
  disabled: boolean;
  history: ReactNode;
  onClose: () => void;
  onOpenThread: (projectId: string, threadId: string) => void;
  onReveal?: (projectId: string, path: string) => void;
  renderConversation: TaskConversationRenderer;
  renderResources: (project: Data, thread: Data) => ReactNode;
}) {
  const { t } = useI18n();
  const [read, setRead] = useState<{ status: "pending" | "ready" | "error"; error?: string }>({
    status: "pending",
  });
  const [retry, setRetry] = useState(0);
  const state = scheduledTaskState(task, project, t);
  // 运行接在这段对话里时，详情就是这段对话；旧的“每次新开”任务列出各次运行的对话。
  const bound = scheduledTaskConversation(task);
  const target: string | undefined = bound ?? task.sourceThreadId ?? task.threadId ?? undefined;
  useEffect(() => {
    if (!project.state?.connected || !target) return;
    let live = true;
    setRead({ status: "pending" });
    void action("open", { projectId: project.id, threadId: target })
      .then(() => {
        if (live) setRead({ status: "ready" });
      })
      .catch((cause) => {
        if (live) setRead({ status: "error", error: cause.message });
      });
    return () => {
      live = false;
    };
  }, [
    action,
    project.id,
    project.state?.connected,
    project.core?.connectionGeneration,
    target,
    retry,
  ]);
  const thread = target ? project.state?.threads?.[target] : undefined;
  const folder =
    !task.sourceThreadId && thread?.cwd && project.root && thread.cwd.startsWith(project.root)
      ? thread.cwd.slice(project.root.length + 1) || "."
      : undefined;
  return (
    <main
      className="task-conversation"
      aria-label={t("operations.schedules.conversation")}
      data-task-id={task.id}
    >
      <header className="scheduled-task-header">
        <TitleTooltip title={task.objective}>
          <h2>{scheduledTaskName(task)}</h2>
        </TitleTooltip>
        <ScheduledWorkspace.Status state={state.kind} label={scheduledTaskStateLabel(state, t)} />
        <TitleTooltip title={project.root}>
          <span className="scheduled-task-header-summary">
            {state.kind === "attention" ? state.reason : scheduledTaskSummary(task, t)}
          </span>
        </TitleTooltip>
        {task.sourceThreadId && (
          <Button
            size="sm"
            variant="ghost"
            disabled={read.status !== "ready" || !thread}
            onClick={() => onOpenThread(project.id, task.sourceThreadId)}
          >
            {t("operations.schedules.openSource")}
          </Button>
        )}
        {folder && onReveal && (
          <Button size="sm" variant="ghost" onClick={() => onReveal(project.id, folder)}>
            {t("operations.schedules.revealFolder")}
          </Button>
        )}
        {thread && renderResources(project, thread)}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("operations.schedules.closeDetails")}
        </Button>
      </header>
      {target && read.status === "error" && (
        <p role="alert" className="task-plan-note">
          {t("operations.schedules.sourceUnavailable")}
          {read.error}
          <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            {t("operations.schedules.retrySource")}
          </Button>
        </p>
      )}
      {bound && read.status === "pending" && (
        <p role="status" className="task-plan-note">
          {t("operations.schedules.readingSource")}
        </p>
      )}
      {bound && thread && read.status === "ready" && (
        <div className="task-conversation-body">
          <section className="task-chat-pane">
            {renderConversation(project, thread, undefined, {
              readOnly: !!thread.desktop?.archived,
            })}
          </section>
        </div>
      )}
      {bound && !thread && read.status !== "pending" && (
        <div className="task-plan-note">
          <p>{t("operations.schedules.sourceMissing")}</p>
          {history}
        </div>
      )}
      {!bound && (
        <div className="task-conversation-body">
          <section className="task-chat-pane">
            {history}
            <TaskRunConversations
              project={project}
              task={task}
              action={action}
              disabled={disabled}
              renderConversation={renderConversation}
            />
          </section>
        </div>
      )}
    </main>
  );
}
