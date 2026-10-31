import { useEffect, useMemo, useRef, useState } from "react";
import { ScheduledWorkspace } from "@areal/ui/experimental";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { MoreOptionsIcon, ScheduledIcon } from "./interfaceIcons.js";
import { useI18n, type Translate } from "./i18n/IntlProvider.js";
import {
  describeSchedule,
  scheduledTaskName,
  scheduledTaskState,
  scheduledTaskStateLabel,
  scheduledTaskSummary,
} from "./scheduleText.js";
import type { Action, Data } from "./services.js";
import { createScheduleEditorLoader, type ScheduleEditorState } from "./schedule-editor-loader.js";

// 定时任务页与会话共用同一处实验组件入口，毕业前只在这里登记一次。
export { ScheduledWorkspace };

export const settledRun = (run: Data) =>
  ["completed", "failed", "cancelled", "skipped"].includes(run.status) &&
  !(run.workers ?? []).some((worker: Data) => !worker.settled);
export const taskDeletionPending = (task: Data) =>
  task.deletedAt != null &&
  (task.hasUnsettledWork ?? (task.runs ?? []).some((run: Data) => !settledRun(run)));
export const activeScheduledTask = (task: Data) =>
  task.mode === "scheduled" && (task.deletedAt == null || taskDeletionPending(task));
export const scheduledTaskStatus = (task: Data, t: Translate) =>
  t(
    task.deletedAt != null
      ? taskDeletionPending(task)
        ? "operations.schedules.deleting"
        : "operations.schedules.deleted"
      : task.cancelled
        ? "operations.schedules.cancelled"
        : task.paused
          ? "operations.schedules.paused"
          : "operations.schedules.enabled",
  );
const changed = (projectId: string) =>
  window.dispatchEvent(new CustomEvent("areal-scheduled-tasks-changed", { detail: projectId }));
type ControlOperation =
  | "taskPause"
  | "taskResume"
  | "taskRunNow"
  | "taskDelete"
  | "taskStopRun"
  | "taskResumeRun";
/** 会话卡片、右侧面板和定时任务页共用的任务控制：同一时间只发一个写入，失败后重读任务。 */
export function useScheduledTaskControl(
  task: Data,
  project: Data,
  action: Action,
  onChanged?: (task: Data) => void,
  disabled = false,
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  const pending = (project.pending ?? []).some(
    (entry: Data) => entry.params?.taskId === task.id && entry.method?.startsWith("areal/task/"),
  );
  const blocked = disabled || busy || pending || !project.state?.connected;
  const run = task.activeRun ?? (task.runs ?? []).find((run: Data) => !settledRun(run));
  const control = async (operation: ControlOperation, runId?: string) => {
    if (blocked || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const base = { projectId: project.id, taskId: task.id, expectedRevision: task.revision };
      const result = await action(
        "manage",
        operation === "taskStopRun" || operation === "taskResumeRun"
          ? { ...base, operation, expectedRunId: runId ?? run?.id }
          : { ...base, operation },
      );
      if (result && "id" in result && result.id === task.id) onChanged?.(result);
      changed(project.id);
    } catch (cause) {
      setError((cause as Error).message);
      await action("manage", { projectId: project.id, operation: "task", taskId: task.id })
        .then((value) => onChanged?.(value))
        .catch(() => {});
      changed(project.id);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const reconcile = () => {
    setBusy(true);
    void action("reconcile", { projectId: project.id })
      .then(() => changed(project.id))
      .catch((cause) => setError(cause.message))
      .finally(() => setBusy(false));
  };
  return { control, reconcile, busy, error, pending, blocked, run };
}
/** “⋯”菜单：暂停/开启、立即运行、停止本次、编辑、打开、删除（菜单内二次确认）。 */
export function ScheduledTaskMenu({
  task,
  project,
  action,
  disabled = false,
  onChanged,
  onOpen,
  onEdit,
}: {
  task: Data;
  project: Data;
  action: Action;
  disabled?: boolean;
  onChanged?: (task: Data) => void;
  onOpen?: () => void;
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  const { control, reconcile, busy, error, pending, blocked, run } = useScheduledTaskControl(
    task,
    project,
    action,
    onChanged,
    disabled,
  );
  const [confirming, setConfirming] = useState(false);
  const state = scheduledTaskState(task, project, t);
  const live = task.deletedAt == null;
  return (
    <>
      <DropdownMenu onOpenChange={(open) => !open && setConfirming(false)}>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("operations.schedules.more")}
              data-scheduled-task-menu={task.id}
            />
          }
        >
          <MoreOptionsIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {live && (
            <DropdownMenuItem
              disabled={blocked || task.cancelled}
              onClick={() => void control(task.paused ? "taskResume" : "taskPause")}
            >
              {task.paused ? t("operations.schedules.enable") : t("operations.schedules.pause")}
            </DropdownMenuItem>
          )}
          {live && (
            <DropdownMenuItem
              disabled={blocked || task.cancelled || !!run}
              onClick={() => void control("taskRunNow")}
            >
              {t("operations.runNow")}
            </DropdownMenuItem>
          )}
          {live && state.kind === "attention" && state.retryRunId && (
            <DropdownMenuItem
              disabled={blocked}
              onClick={() => void control("taskResumeRun", state.retryRunId)}
            >
              {t("operations.schedules.retryRun")}
            </DropdownMenuItem>
          )}
          {live && run && (
            <DropdownMenuItem
              disabled={blocked || (run.reasonPreview ?? run.reason) === "stopRequested"}
              onClick={() => void control("taskStopRun")}
            >
              {t("operations.schedules.stopRun")}
            </DropdownMenuItem>
          )}
          {live && onEdit && (
            <DropdownMenuItem disabled={blocked || task.cancelled} onClick={onEdit}>
              {t("operations.schedules.edit")}
            </DropdownMenuItem>
          )}
          {onOpen && (
            <DropdownMenuItem onClick={onOpen}>
              {t("operations.schedules.openInCenter")}
            </DropdownMenuItem>
          )}
          {pending && (
            <DropdownMenuItem disabled={busy || !project.state?.connected} onClick={reconcile}>
              {t("operations.schedules.check")}
            </DropdownMenuItem>
          )}
          {live && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={blocked}
                closeOnClick={confirming}
                onClick={() => (confirming ? void control("taskDelete") : setConfirming(true))}
              >
                {confirming
                  ? t("operations.schedules.deleteConfirm")
                  : t("operations.schedules.deleteAsk")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending && (
        <span className="sr-only" role="status">
          {t("operations.schedules.unknown")}
        </span>
      )}
      {error && (
        <p role="alert" className="scheduled-task-error">
          {error}
        </p>
      )}
    </>
  );
}
/** 一行任务：会话卡片（card）或右侧面板（compact）。 */
export function ScheduledTaskRow({
  task,
  project,
  action,
  variant,
  disabled,
  onChanged,
  onOpen,
  ...props
}: {
  task: Data;
  project: Data;
  action: Action;
  variant: "card" | "compact";
  disabled?: boolean;
  onChanged?: (task: Data) => void;
  onOpen?: (task: Data) => void;
} & Record<`data-${string}`, string | undefined>) {
  const { t } = useI18n();
  type Editor = (typeof import("./ScheduledTaskEditDialog.js"))["ScheduledTaskEditDialog"];
  const [{ editor: Editor, loading: editorLoading, error: editorError, editing }, setEditorState] =
    useState<ScheduleEditorState<Editor>>({
      editor: null,
      loading: false,
      error: "",
      editing: false,
    });
  const loader = useMemo(
    () =>
      createScheduleEditorLoader(
        async () => (await import("./ScheduledTaskEditDialog.js")).ScheduledTaskEditDialog,
        setEditorState,
      ),
    [],
  );
  useEffect(() => {
    loader.reset();
    return loader.invalidate;
  }, [task.id, project.id, loader]);
  const state = scheduledTaskState(task, project, t);
  const name = scheduledTaskName(task);
  const summary =
    state.kind === "attention"
      ? state.reason
      : state.kind === "deleted" || state.kind === "finished"
        ? describeSchedule(task, t)
        : scheduledTaskSummary(task, t);
  return (
    <>
      <ScheduledWorkspace.TaskRow
        {...props}
        data-task-id={task.id}
        variant={variant}
        icon={<ScheduledIcon size={16} />}
        title={name}
        summary={summary}
        state={state.kind}
        stateLabel={scheduledTaskStateLabel(state, t)}
        onOpen={onOpen ? () => onOpen(task) : undefined}
        openLabel={
          onOpen
            ? t("operations.schedules.openLabel", {
                title: task.objectivePreview ?? task.objective,
              })
            : undefined
        }
        actions={
          <ScheduledTaskMenu
            task={task}
            project={project}
            action={action}
            disabled={disabled}
            onChanged={onChanged}
            onOpen={onOpen ? () => onOpen(task) : undefined}
            onEdit={() => void loader.open()}
          />
        }
      />
      {editorLoading && <p role="status">{t("common.loading")}</p>}
      {editorError && (
        <p role="alert" className="scheduled-task-error">
          {editorError}
        </p>
      )}
      {editing && Editor && (
        <Editor
          task={task}
          project={project}
          action={action}
          onClose={() => setEditorState((state) => ({ ...state, editing: false }))}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
export function ThreadScheduledTasks({
  project,
  thread,
  action,
  onAdd,
  onOpen,
}: {
  project: Data;
  thread: Data;
  action: Action;
  onAdd?: () => void;
  onOpen?: (task: Data) => void;
}) {
  const { t } = useI18n();
  const [read, setRead] = useState<{
    tasks: Data[];
    status: "pending" | "ready" | "error";
    error?: string;
  }>({ tasks: [], status: "pending" });
  const [retry, setRetry] = useState(0);
  const latest = useRef(action);
  latest.current = action;
  // 只在连接变化或控制后重读；任务变化通过 project.state.tasks 推送合并，不随目录版本整页重读。
  useEffect(() => {
    if (!project.state?.connected) return;
    let live = true,
      reading = false;
    const refresh = async () => {
      if (!live || reading) return;
      reading = true;
      try {
        const result = await latest.current("tasks", {
          operation: "observe",
          projectId: project.id,
          sourceThreadId: thread.id,
          limit: 1024,
        });
        if (result.errors?.length)
          throw new Error(result.errors.map((item: Data) => item.message).join("\n"));
        if (live) setRead({ tasks: result.data, status: "ready" });
      } catch (cause) {
        if (live)
          setRead((previous) => ({
            ...previous,
            status: previous.status === "ready" ? "ready" : "error",
            error: (cause as Error).message,
          }));
      } finally {
        reading = false;
      }
    };
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail === project.id) void refresh();
    };
    void refresh();
    window.addEventListener("areal-scheduled-tasks-changed", listener);
    return () => {
      live = false;
      window.removeEventListener("areal-scheduled-tasks-changed", listener);
    };
  }, [project.id, thread.id, project.state?.connected, project.core?.connectionGeneration, retry]);
  const tasks = new Map(read.tasks.map((task) => [task.id, task]));
  for (const task of Object.values<Data>(project.state?.tasks ?? {})) {
    if (task.sourceThreadId !== thread.id || task.mode !== "scheduled") continue;
    const previous = tasks.get(task.id);
    if (!previous || task.revision >= previous.revision) tasks.set(task.id, task);
  }
  const visible = [...tasks.values()].filter(activeScheduledTask);
  return (
    <section className="task-resources-section" aria-label={t("operations.schedules.threadLabel")}>
      <h3 className="task-resources-heading">
        <span>{t("operations.schedules.title")}</span>
        {onAdd && (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            {t("operations.schedules.add")}
          </Button>
        )}
      </h3>
      {!project.state?.connected && <p role="status">{t("operations.schedules.unavailable")}</p>}
      {project.state?.connected && read.status === "pending" && !visible.length && (
        <p role="status">{t("operations.schedules.loading")}</p>
      )}
      {read.status === "error" && (
        <div>
          <p role="alert">{read.error}</p>
          <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            {t("operations.schedules.retry")}
          </Button>
        </div>
      )}
      {read.status === "ready" && !visible.length && (
        <p className="task-resource-note">{t("operations.schedules.empty")}</p>
      )}
      {visible.map((task) => (
        <ScheduledTaskRow
          key={task.id}
          task={task}
          project={project}
          action={action}
          variant="compact"
          disabled={read.status !== "ready"}
          onOpen={onOpen}
          onChanged={(value) =>
            setRead((previous) => ({
              ...previous,
              tasks: previous.tasks.map((row) => (row.id === value.id ? value : row)),
            }))
          }
        />
      ))}
    </section>
  );
}
type SavedSchedule = { task: Data; receipt: { requestId: string; method: string } };
export function savedSchedule(item: Data): SavedSchedule | undefined {
  if (
    item.type !== "dynamicToolCall" ||
    item.status !== "completed" ||
    item.success !== true ||
    !["scheduled_task_create", "scheduled_task_update", "scheduled_task_control"].includes(
      item.tool,
    )
  )
    return;
  for (const content of item.contentItems ?? []) {
    if (content.type !== "inputText" || typeof content.text !== "string") continue;
    try {
      const value = JSON.parse(content.text);
      if (
        !value.error &&
        value.task?.mode === "scheduled" &&
        typeof value.task.id === "string" &&
        typeof value.task.objective === "string" &&
        typeof value.receipt?.requestId === "string" &&
        /^areal\/task\/(create|update|pause|resume|runNow|delete|stopRun)$/.test(
          value.receipt.method,
        )
      )
        return value;
    } catch {}
  }
}
/** 同一会话里同一任务的最新一次保存记录：只有它显示为可操作的卡片。 */
export function latestScheduleItems(turns: Data[]) {
  const latest = new Map<string, string>();
  for (const turn of turns)
    for (const item of turn.items ?? []) {
      const saved = savedSchedule(item);
      if (saved) latest.set(saved.task.id, item.id);
    }
  return new Set(latest.values());
}
export function ScheduledTaskCards({
  items,
  project,
  action,
  latest,
  onOpen,
}: {
  items: Data[];
  project: Data;
  action: Action;
  latest?: Set<string>;
  onOpen?: (task: Data) => void;
}) {
  return (
    <>
      {items.flatMap((item) => {
        const saved = savedSchedule(item);
        if (!saved) return [];
        return [
          !latest || latest.has(item.id) ? (
            <ScheduledTaskCard
              key={item.id}
              saved={saved}
              project={project}
              action={action}
              onOpen={onOpen}
            />
          ) : (
            <ScheduledTaskRecord key={item.id} saved={saved} />
          ),
        ];
      })}
    </>
  );
}
const savedAction = (method: string, t: Translate) =>
  t(
    method === "areal/task/create"
      ? "operations.schedules.created"
      : method === "areal/task/update"
        ? "operations.schedules.updated"
        : "operations.schedules.controlled",
  );
/** 较早的保存记录退化成一行文字，避免同一任务出现多张可操作卡片。 */
function ScheduledTaskRecord({ saved }: { saved: SavedSchedule }) {
  const { t } = useI18n();
  return (
    <p
      className="scheduled-task-record"
      data-testid="scheduled-task-record"
      data-task-id={saved.task.id}
      data-receipt-id={saved.receipt.requestId}
    >
      {savedAction(saved.receipt.method, t)} · {scheduledTaskName(saved.task)} ·{" "}
      {describeSchedule(saved.task, t)}
    </p>
  );
}
function ScheduledTaskCard({
  saved,
  project,
  action,
  onOpen,
}: {
  saved: SavedSchedule;
  project: Data;
  action: Action;
  onOpen?: (task: Data) => void;
}) {
  const { t } = useI18n();
  const [read, setRead] = useState<{ task?: Data; status: "pending" | "ready" | "error" }>({
    status: "pending",
  });
  const [retry, setRetry] = useState(0);
  const latest = useRef(action);
  latest.current = action;
  // 只在打开、重连和控制后读取一次；之后跟随 project.state.tasks 的推送，不再定时轮询。
  useEffect(() => {
    if (!project.state?.connected) return;
    let live = true;
    const refresh = () =>
      latest
        .current("manage", { projectId: project.id, operation: "task", taskId: saved.task.id })
        .then((task) => {
          if (task.id !== saved.task.id || task.mode !== "scheduled")
            throw new Error("任务身份不匹配");
          if (live) setRead({ task, status: "ready" });
        })
        .catch(() => {
          if (live) setRead((previous) => ({ ...previous, status: "error" }));
        });
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail === project.id) void refresh();
    };
    void refresh();
    window.addEventListener("areal-scheduled-tasks-changed", listener);
    return () => {
      live = false;
      window.removeEventListener("areal-scheduled-tasks-changed", listener);
    };
  }, [
    project.id,
    project.state?.connected,
    project.core?.connectionGeneration,
    saved.task.id,
    saved.receipt.requestId,
    retry,
  ]);
  const pushed = project.state?.tasks?.[saved.task.id];
  const task =
    pushed && read.task && pushed.revision > read.task.revision ? pushed : (read.task ?? pushed);
  const ready = !!project.state?.connected && read.status === "ready" && !!task;
  return (
    <div
      className="scheduled-task-message-card"
      data-testid="scheduled-task-card"
      data-task-id={saved.task.id}
      data-receipt-id={saved.receipt.requestId}
    >
      {ready ? (
        <ScheduledTaskRow
          task={task}
          project={project}
          action={action}
          variant="card"
          onOpen={onOpen}
          onChanged={(value) => setRead({ task: value, status: "ready" })}
        />
      ) : (
        <ScheduledWorkspace.TaskRow
          variant="card"
          icon={<ScheduledIcon size={16} />}
          title={scheduledTaskName(saved.task)}
          summary={describeSchedule(saved.task, t)}
          state="paused"
          stateLabel={
            read.status === "pending" && project.state?.connected
              ? t("operations.schedules.reading")
              : t("operations.schedules.unavailable")
          }
          actions={
            (!project.state?.connected || read.status === "error") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!project.state?.connected}
                onClick={() => setRetry((value) => value + 1)}
              >
                {t("operations.schedules.retryStatus")}
              </Button>
            )
          }
        />
      )}
    </div>
  );
}
