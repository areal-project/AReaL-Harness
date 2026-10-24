import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { scheduleZone } from "./TaskRunConversations.js";
import { useI18n, type Translate } from "./i18n/IntlProvider.js";
import type { Action, Data } from "./services.js";

export const settledRun = (run: Data) => ["completed", "failed", "cancelled", "skipped"].includes(run.status) && !(run.workers ?? []).some((worker: Data) => !worker.settled);
export const taskDeletionPending = (task: Data) => task.deletedAt != null && (task.runs ?? []).some((run: Data) => !settledRun(run));
export const activeScheduledTask = (task: Data) => task.mode === "scheduled" && (task.deletedAt == null || taskDeletionPending(task));
export const scheduledTaskStatus = (task: Data, t: Translate) => t(task.deletedAt != null ? taskDeletionPending(task) ? "operations.schedules.deleting" : "operations.schedules.deleted" : task.cancelled ? "operations.schedules.cancelled" : task.paused ? "operations.schedules.paused" : "operations.schedules.enabled");
export function scheduleTime(seconds: number | null | undefined, zone?: string) {
  if (seconds == null) return "";
  try { return new Date(seconds * 1000).toLocaleString(undefined, zone ? { timeZone: zone } : undefined); }
  catch { return new Date(seconds * 1000).toLocaleString(undefined, { timeZone: "UTC" }); }
}
export function scheduleDescription(task: Data, t: Translate) {
  const rule = task.scheduleV2?.rule;
  if (!rule || rule.kind === "interval") {
    const seconds = rule?.intervalSeconds ?? task.schedule?.intervalSeconds;
    return seconds ? t("operations.schedules.everySeconds", { seconds }) : t("operations.schedules.once", { time: scheduleTime(task.schedule?.at, scheduleZone(task)) });
  }
  if (rule.kind === "once") return t("operations.schedules.once", { time: scheduleTime(rule.at, scheduleZone(task)) });
  const units = { daily: t("operations.schedules.dayUnit"), weekly: t("operations.schedules.weekUnit"), monthly: t("operations.schedules.monthUnit") };
  const weekdays = ["", t("operations.schedules.monday"), t("operations.schedules.tuesday"), t("operations.schedules.wednesday"), t("operations.schedules.thursday"), t("operations.schedules.friday"), t("operations.schedules.saturday"), t("operations.schedules.sunday")];
  const days = rule.frequency === "weekly" ? (rule.weekdays ?? []).map((day: number) => weekdays[day]).join(", ") : rule.frequency === "monthly" ? (rule.monthDays ?? []).map((day: number | string) => day === "last" ? t("operations.schedules.lastDay") : t("operations.schedules.monthDay", { day })).join(", ") : "";
  return t("operations.schedules.calendar", { interval: rule.interval ?? 1, unit: units[rule.frequency as keyof typeof units] ?? rule.frequency, days, time: rule.localTime });
}
export function ScheduledTaskSummary({ task, project }: { task: Data; project: Data }) {
  const { t } = useI18n();
  const run = task.runs?.at(-1);
  return <div className="scheduled-task-summary">
    <p role="status" className="scheduled-task-status" data-enabled={!task.paused && !task.cancelled && task.deletedAt == null}>{scheduledTaskStatus(task, t)}</p>
    <p>{scheduleDescription(task, t)}{scheduleZone(task) ? ` · ${scheduleZone(task)}` : ""}</p>
    <p>{t("operations.schedules.next", { time: scheduleTime(task.nextRunAt, scheduleZone(task)) || t("operations.schedules.none") })}</p>
    <p className="text-foreground-subtle">{project.projectless ? t("operations.schedules.independent") : project.name ?? project.root?.split(/[\\/]/).pop()} · {t("operations.schedules.defaultModel")}</p>
    {run && ["blocked", "failed", "paused", "waitingForInput"].includes(run.status) && <p>{t("operations.schedules.latestRun", { status: ({ blocked: t("operations.schedules.blocked"), failed: t("operations.schedules.failed"), paused: t("operations.schedules.paused"), waitingForInput: t("operations.schedules.waiting") } as Record<string, string>)[run.status] })}</p>}
  </div>;
}
const changed = (projectId: string) => window.dispatchEvent(new CustomEvent("areal-scheduled-tasks-changed", { detail: projectId }));
export function ScheduledTaskControls({ task, project, action, disabled = false, onChanged }: { task: Data; project: Data; action: Action; disabled?: boolean; onChanged?: (task: Data) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false);
  const pending = (project.pending ?? []).some((entry: Data) => entry.params?.taskId === task.id && entry.method?.startsWith("areal/task/"));
  const blocked = disabled || busy || pending || !project.state?.connected;
  const run = (task.runs ?? []).find((run: Data) => !settledRun(run));
  const control = async (operation: string) => {
    if (blocked || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const result = await action("manage", { projectId: project.id, operation, taskId: task.id, expectedRevision: task.revision, ...(operation === "taskStopRun" ? { expectedRunId: run?.id } : {}) });
      if (result?.id === task.id) onChanged?.(result);
      changed(project.id);
    } catch (cause) {
      setError((cause as Error).message);
      await action("manage", { projectId: project.id, operation: "task", taskId: task.id }).then(value => onChanged?.(value)).catch(() => {});
      changed(project.id);
    } finally { locked.current = false; setBusy(false); }
  };
  return <div className="scheduled-task-actions">
    {task.deletedAt == null && <>
      <Button size="sm" variant="ghost" disabled={blocked || task.cancelled} onClick={() => void control(task.paused ? "taskResume" : "taskPause")}>{task.paused ? t("operations.schedules.enable") : t("operations.schedules.pause")}</Button>
      <Button size="sm" variant="ghost" disabled={blocked || task.cancelled || !!run} onClick={() => void control("taskRunNow")}>{t("operations.runNow")}</Button>
      <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void control("taskDelete")}>{t("operations.schedules.delete")}</Button>
    </>}
    {run && task.deletedAt == null && <Button size="sm" variant="ghost" disabled={blocked || run.reason === "stopRequested"} onClick={() => void control("taskStopRun")}>{t("operations.schedules.stopRun")}</Button>}
    {pending && <><p role="alert">{t("operations.schedules.unknown")}</p><Button size="sm" variant="ghost" disabled={busy || !project.state?.connected} onClick={() => { setBusy(true); void action("reconcile", { projectId: project.id }).then(() => { changed(project.id); }).catch(cause => setError(cause.message)).finally(() => setBusy(false)); }}>{t("operations.schedules.check")}</Button></>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function ThreadScheduledTasks({ project, thread, action, onAdd, onOpen }: { project: Data; thread: Data; action: Action; onAdd?: () => void; onOpen?: (task: Data) => void }) {
  const { t } = useI18n();
  const [read, setRead] = useState<{ tasks: Data[]; status: "pending" | "ready" | "error"; error?: string }>({ tasks: [], status: "pending" });
  const [retry, setRetry] = useState(0);
  const latest = useRef(action); latest.current = action;
  useEffect(() => {
    if (!project.state?.connected) return;
    let live = true, reading = false;
    const refresh = async () => {
      if (!live || reading) return;
      reading = true;
      try {
        const result = await latest.current("tasks", { operation: "list", projectId: project.id, sourceThreadId: thread.id, limit: 1024 });
        if (result.errors?.length) throw new Error(result.errors.map((item: Data) => item.message).join("\n"));
        if (live) setRead({ tasks: result.data, status: "ready" });
      } catch (cause) { if (live) setRead(previous => ({ ...previous, status: "error", error: (cause as Error).message })); }
      finally { reading = false; }
    };
    const listener = (event: Event) => { if ((event as CustomEvent).detail === project.id) void refresh(); };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    window.addEventListener("areal-scheduled-tasks-changed", listener);
    return () => { live = false; clearInterval(timer); window.removeEventListener("areal-scheduled-tasks-changed", listener); };
  }, [project.id, thread.id, project.state?.connected, project.core?.connectionGeneration, retry]);
  const tasks = new Map(read.tasks.map(task => [task.id, task]));
  for (const task of Object.values<Data>(project.state?.tasks ?? {})) {
    if (task.sourceThreadId === thread.id && (!tasks.has(task.id) || task.revision >= tasks.get(task.id)!.revision)) tasks.set(task.id, task);
  }
  const visible = [...tasks.values()].filter(activeScheduledTask);
  return <section className="task-resources-section" aria-label={t("operations.schedules.threadLabel")}>
    <h3 className="task-resources-heading"><span>{t("operations.schedules.title")}</span>{onAdd && <Button size="sm" variant="ghost" onClick={onAdd}>{t("operations.schedules.add")}</Button>}</h3>
    {!project.state?.connected && <p role="status">{t("operations.schedules.unavailable")}</p>}
    {project.state?.connected && read.status === "pending" && <p role="status">{t("operations.schedules.loading")}</p>}
    {read.status === "error" && <div><p role="alert">{read.error}</p><Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>{t("operations.schedules.retry")}</Button></div>}
    {read.status === "ready" && !visible.length && <p className="task-resource-note">{t("operations.schedules.empty")}</p>}
    {visible.map(task => <article key={task.id} data-task-id={task.id} className="scheduled-task-resource">
      <Button variant="ghost" className="task-resource-row" onClick={() => onOpen?.(task)} disabled={!onOpen}><span className="task-resource-label">{task.objective}</span></Button>
      <ScheduledTaskSummary task={task} project={project} />
      <ScheduledTaskControls task={task} project={project} action={action} disabled={read.status !== "ready"} onChanged={value => setRead(previous => ({ ...previous, tasks: previous.tasks.map(row => row.id === value.id ? value : row) }))} />
    </article>)}
  </section>;
}
type SavedSchedule = { task: Data; receipt: { requestId: string; method: string } };
function savedSchedule(item: Data): SavedSchedule | undefined {
  if (item.type !== "dynamicToolCall" || item.status !== "completed" || item.success !== true || !["scheduled_task_create", "scheduled_task_update", "scheduled_task_control"].includes(item.tool)) return;
  for (const content of item.contentItems ?? []) {
    if (content.type !== "inputText" || typeof content.text !== "string") continue;
    try {
      const value = JSON.parse(content.text);
      if (!value.error && value.task?.mode === "scheduled" && typeof value.task.id === "string" && typeof value.task.objective === "string"
        && typeof value.receipt?.requestId === "string" && /^areal\/task\/(create|update|pause|resume|runNow|delete|stopRun)$/.test(value.receipt.method)) return value;
    } catch {}
  }
}
export function ScheduledTaskCards({ items, project, action }: { items: Data[]; project: Data; action: Action }) {
  return <>{items.flatMap(item => { const saved = savedSchedule(item); return saved ? [<ScheduledTaskCard key={item.id} saved={saved} project={project} action={action} />] : []; })}</>;
}
function ScheduledTaskCard({ saved, project, action }: { saved: SavedSchedule; project: Data; action: Action }) {
  const { t } = useI18n();
  const [read, setRead] = useState<{ task?: Data; status: "pending" | "ready" | "error" }>({ status: "pending" });
  const [retry, setRetry] = useState(0);
  const latest = useRef(action); latest.current = action;
  useEffect(() => {
    if (!project.state?.connected) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const task = await latest.current("manage", { projectId: project.id, operation: "task", taskId: saved.task.id });
        if (task.id !== saved.task.id || task.mode !== "scheduled") throw new Error("任务身份不匹配");
        if (!live) return;
        setRead({ task, status: "ready" });
        if (activeScheduledTask(task)) timer = setTimeout(refresh, 3000);
      } catch { if (live) setRead(previous => ({ ...previous, status: "error" })); }
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [project.id, project.state?.connected, project.core?.connectionGeneration, saved.task.id, saved.receipt.requestId, retry]);
  const live = project.state?.tasks?.[saved.task.id];
  const task = live && read.task && live.revision > read.task.revision ? live : read.task;
  const status = project.state?.connected && read.status === "ready" && task ? scheduledTaskStatus(task, t) : t("operations.schedules.unavailable");
  const historical = t(saved.receipt.method === "areal/task/create" ? "operations.schedules.created" : saved.receipt.method === "areal/task/update" ? "operations.schedules.updated" : "operations.schedules.controlled");
  return <article className="scheduled-task-message-card" data-testid="scheduled-task-card" data-task-id={saved.task.id} data-receipt-id={saved.receipt.requestId}>
    <p className="text-foreground-subtle">{historical}</p><h3>{saved.task.objective}</h3>
    <p>{scheduleDescription(saved.task, t)}</p>
    <p role="status">{t("operations.schedules.current", { status: read.status === "pending" && project.state?.connected ? t("operations.schedules.reading") : status })}</p>
    {task && read.status === "ready" && project.state?.connected && <ScheduledTaskSummary task={task} project={project} />}
    {(!project.state?.connected || read.status === "error") && <Button size="sm" variant="ghost" disabled={!project.state?.connected} onClick={() => setRetry(value => value + 1)}>{t("operations.schedules.retryStatus")}</Button>}
  </article>;
}
