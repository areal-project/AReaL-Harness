import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import { X, Plus, Search, ListFilter, MoreHorizontal, ArrowRight, CalendarClock, GitPullRequest, FileSearch, ListChecks, Newspaper, BookOpen, Activity } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem } from "./components/ui/dropdown-menu.js";
import { SidebarToggleIcon } from "./homeChromeIcons.js";
import { TaskDraft, taskFrequency } from "./TaskDraft.js";
import "./TaskCenter.css";
import { ScheduledTaskIntro, ScheduledTaskEditor } from "./ScheduledTask.js";
import type { Action, Data } from "./services.js";
import { GoalUsageSummary } from "./GoalUsage.js";
import { goalBudgetMessage } from "./conversationPresentation.js";

const statusLabels: Record<string, string> = { queued: "已受理，等待开始", running: "运行中", waitingForInput: "等待回答", waitingForAgents: "等待 worker", paused: "已暂停", blocked: "受阻", completed: "已完成", failed: "失败", cancelled: "已取消" };
const modeLabels: Record<string, string> = { foreground: "前台任务", background: "后台任务", scheduled: "定时任务" };
const interactionLabels: Record<string, string> = { asynchronous: "异步提问", headless: "无人值守", interactive: "当前对话" };
const terminal = (run?: Data) => !!run && ["completed", "failed", "cancelled"].includes(run.status);
const finished = (task: Data) => terminal(task.runs?.at(-1)) && task.nextRunAt == null;
// Task flags acknowledge durable control intent. Run and worker facts describe
// whether execution has actually stopped; a receipt alone cannot settle it.
const stopping = (task: Data) => (task.paused || task.cancelled) && task.runs.some((run: Data) =>
  run.workers?.some((worker: Data) => !worker.settled) || !terminal(run) && (task.cancelled || run.status !== "paused"));
const date = (seconds: number | null) => seconds == null ? "—" : new Date(seconds * 1000).toLocaleString();
// Shutdown can retain a paused flag on finished tasks. Preserve the outcome;
// a recurring schedule with another run still has a meaningful paused state.
const taskStatus = (task: Data) => stopping(task) ? task.cancelled ? "正在取消，等待执行结算" : "正在暂停，等待执行结算" : task.cancelled ? "已取消" : finished(task) ? statusLabels[task.runs.at(-1).status] : task.paused ? "已暂停" : statusLabels[task.runs?.at(-1)?.status] ?? "等待计划时间";
const runReasons: Record<string, string> = {
  usageUnknown: "用量尚未确认，运行已受阻。",
  goalBudget: "已达到运行预算，请在执行会话中调整目标后恢复。",
  // Core 打开持久化任务时，把未结束 Run 记为 serverRestarted。这是重启事实，不能把内部代码直接给用户。
  serverRestarted: "Core 重启后这次运行已暂停。需要明确恢复后才会继续。",
};
const scheduledTokenLimit = (task: Data, reason: string) => task.mode === "scheduled" && reason === "GOAL_TOKEN_BUDGET";
const runReason = (reason: string, task: Data) => scheduledTokenLimit(task, reason)
  ? "周期任务剩余 Token 预算不足。单次运行不能突破任务总预算；如需更多额度，请创建新的周期任务。"
  : goalBudgetMessage(reason) ?? runReasons[reason] ?? reason;
type Props = { projects: Data[]; connected: boolean; initialProjectId?: string; currentThread?: { projectId: string; threadId: string }; action: Action; onOpenThread: (projectId: string, id: string) => void };
const taskKey = (task: Data) => `${task.projectId}:${task.id}`;
const projectLabel = (project: Data) => project.name ?? project.root?.split(/[\\/]/).pop() ?? "项目";

const pendingReplyPrefix = "areal-gui:channel-pending:";
const channelStatus: Record<string, string> = { pending: "待回答", answered: "已回答", expired: "已过期", cancelled: "已取消", published: "已发布" };
const channelKind: Record<string, string> = { question: "问题", reply: "回答", report: "运行报告", workerReport: "worker 报告" };
// Settlement is the Core pair status/settled. A failed worker stays failed;
// pause or cancel while unsettled is still settling, not success.
function workerSettlement(task: Data, worker: Data) {
  if (!worker.settled && (task.paused || task.cancelled)) return "结算中";
  if (!worker.settled) return "等待";
  if (worker.status === "failed") return "失败";
  if (worker.status === "cancelled") return "已取消";
  if (worker.status === "completed") return "成功";
  return String(worker.status ?? "");
}
function WorkerParticipant({ task, run, worker, messages, project, onOpenThread }: { task: Data; run: Data; worker: Data; messages: Data[]; project: Data; onOpenThread: (projectId: string, id: string) => void }) {
  const report = messages.filter(message => message.kind === "workerReport" && message.runId === run.id && message.author === worker.threadId).reduce<Data | undefined>((best, item) => !best || item.sequence > best.sequence ? item : best, undefined);
  return <section aria-label={`worker ${worker.threadId}`} data-worker-thread={worker.threadId} data-worker-turn={worker.turnId} className="grid gap-2 border-t border-border pt-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-medium">worker</h5><span role="status" className="text-foreground-subtle">{workerSettlement(task, worker)}</span></div>
    <p className="break-all text-foreground-subtle">{worker.threadId}</p>
    <p className="break-all text-foreground-subtle">{worker.turnId}</p>
    <Button className="justify-self-start" size="sm" variant="ghost" disabled={!project.state?.connected} onClick={() => onOpenThread(project.id, worker.threadId)}>打开 worker 会话</Button>
    <div className="grid gap-1"><p className="text-foreground-subtle">工作记录</p>{report?.text ? <p className="whitespace-pre-wrap break-words">{report.text}</p> : <p className="text-foreground-subtle">工作记录尚未发布</p>}</div>
  </section>;
}

function ChannelRecord({ message, task, projectId, action, disabled, onReplied }: { message: Data; task: Data; projectId: string; action: Action; disabled: boolean; onReplied: () => void }) {
  if (message.kind === "question" && message.status === "pending") {
    return <ChannelQuestion row={{ taskId: task.id, objective: task.objective, message }} projectId={projectId} action={action} disabled={disabled} showTitle={false} onReplied={onReplied} />;
  }
  return <article data-channel-message-id={message.id} data-question-id={message.kind === "question" ? message.id : undefined} className="grid gap-1 border-t border-border pt-2">
    <p className="text-foreground-subtle">{channelKind[message.kind] ?? message.kind} · {channelStatus[message.status] ?? message.status}</p>
    {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
    {message.questions?.map((question: Data) => <p key={question.id}>{question.title}{message.answers?.[question.id] && `：${message.answers[question.id]}`}</p>)}
    {message.kind === "reply" && Object.entries(message.answers ?? {}).map(([id, answer]) => <p key={id}>{String(answer)}</p>)}
  </article>;
}

// Pending markers describe a GUI submission, not a Core execution fact. Only
// registered projects may contribute retained drafts to the global Inbox.
export function pendingChannelQuestions(projects: Data[]): Data[] {
  const allowed = new Set(projects.map(project => project.id));
  const rows: Data[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(pendingReplyPrefix)) continue;
    try {
      const { row } = JSON.parse(localStorage.getItem(key) ?? "null");
      if (allowed.has(row?.projectId) && typeof row.taskId === "string" && typeof row.message?.id === "string" && typeof row.message.runId === "string" && Array.isArray(row.message.questions)) rows.push(row);
    } catch { /* An unreadable draft cannot become an execution record. */ }
  }
  return rows;
}

export function ChannelQuestion({ row, projectId, action, disabled, onReplied, showTitle = true, freshness }: { freshness?: "live" | "cached"; row: Data; projectId: string; action: Action; disabled: boolean; onReplied: () => void; showTitle?: boolean }) {
  const message = row.message;
  const owner = `${projectId}:${row.taskId}:${message.runId}:${message.id}`;
  const key = `areal-gui:channel-reply:${owner}`, pendingKey = `${pendingReplyPrefix}${owner}`;
  // Existing channel drafts predate the explicit Run segment. The question ID
  // already identifies that original Run; consume the old draft on first edit.
  const legacyKey = `areal-gui:channel-reply:${projectId}:${row.taskId}:${message.id}`;
  const [answers, setAnswers] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(key) ?? localStorage.getItem(legacyKey) ?? "{}"); } catch { return {}; } });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [submitted, setSubmitted] = useState(false);
  const [unknown, setUnknown] = useState(() => localStorage.getItem(pendingKey) !== null);
  const locked = useRef(false);
  const inactive = message.status !== "pending";
  const expired = message.expiresAt != null && message.expiresAt * 1000 <= Date.now();
  const change = (id: string, text: string) => { const next = { ...answers, [id]: text }; setAnswers(next); localStorage.setItem(key, JSON.stringify(next)); localStorage.removeItem(legacyKey); };
  const confirmed = () => { localStorage.removeItem(key); localStorage.removeItem(legacyKey); localStorage.removeItem(pendingKey); setUnknown(false); setSubmitted(true); onReplied(); };
  const submit = async () => {
    if (locked.current || submitted || unknown || disabled || expired || inactive) return;
    locked.current = true; setBusy(true); setError("");
    try {
      localStorage.setItem(pendingKey, JSON.stringify({ row: { ...row, projectId }, answers }));
      const result = await action("manage", { projectId, operation: "taskReply", taskId: row.taskId, runId: message.runId, questionId: message.id, answers });
      if (result?.accepted !== true || result.taskId !== row.taskId || result.runId !== message.runId || result.questionId !== message.id) throw Object.assign(new Error("回答回执与原任务运行不符，请核对原频道。"), { submissionUnknown: true });
      confirmed();
    } catch (cause) {
      if ((cause as Error & { submissionUnknown?: boolean }).submissionUnknown) setUnknown(true);
      else localStorage.removeItem(pendingKey);
      setError((cause as Error).message); onReplied();
    } finally { locked.current = false; setBusy(false); }
  };
  const reconcile = async () => {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
      if (!pending) throw new Error("待核对记录已变化，请刷新 Inbox。");
      let afterSequence = 0; const messages: Data[] = [];
      for (;;) {
        const page = await action("manage", { projectId, operation: "taskChannel", taskId: row.taskId, afterSequence, limit: 100 });
        messages.push(...page.data);
        if (!page.hasMore) break;
        if (page.nextSequence <= afterSequence) throw new Error("频道读取未前进，请刷新后重试");
        afterSequence = page.nextSequence;
      }
      const question = messages.find(item => item.id === message.id && item.runId === message.runId && item.kind === "question");
      const matches = (value: Data) => value && Object.keys(value).length === Object.keys(pending.answers).length && Object.entries(pending.answers).every(([id, answer]) => value[id] === answer);
      const reply = messages.find(item => item.kind === "reply" && item.runId === message.runId && item.inReplyTo === message.id && matches(item.answers));
      if (question?.status === "answered" && matches(question.answers) && reply) confirmed();
      else setError("原频道尚未确认这份回答。已保留输入，不会自动重发。");
    } catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  return <article data-question-id={message.id} data-channel-message-id={message.id} className="grid gap-2 rounded-control border border-border p-3">
    {showTitle && <h3 className="font-medium">{row.objective}</h3>}{row.projectName && <p className="text-foreground-subtle">{row.projectName}</p>}<p className="text-foreground-subtle">{message.required ? "需要回答" : "可补充回答"} · {message.expiresAt ? `截止 ${date(message.expiresAt)}` : "无截止时间"}</p>
    {freshness && <p className="text-foreground-subtle">{freshness === "live" ? "实时问题" : "缓存问题，尚未重新确认"}</p>}
    {(inactive || expired) && <p>{expired && message.status === "pending" ? "已过期" : ({ answered: "已回答", cancelled: "已取消", expired: "已过期" } as Record<string, string>)[message.status] ?? "问题已结束"}</p>}
    {message.status === "answered" && message.answers && <p>已接受的回答：{Object.values(message.answers).join("；")}</p>}
    {message.questions.map((q: Data) => <label key={q.id} className="grid gap-1">{q.title}{q.allowFreeText ? <Textarea aria-label={q.title} value={answers[q.id] ?? ""} disabled={busy || submitted || unknown || disabled || expired || inactive} onChange={e => change(q.id, e.target.value)} placeholder={q.options?.join(" / ")} /> : <Select value={answers[q.id] ?? ""} disabled={busy || submitted || unknown || disabled || expired || inactive} onValueChange={v => { if (v) change(q.id, v); }}><SelectTrigger aria-label={q.title}><SelectValue placeholder="请选择" /></SelectTrigger><SelectContent>{q.options.map((v: string) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select>}</label>)}
    {unknown && <p role="alert">回答提交结果尚未确认，不会重复发送。</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex gap-2"><Button size="sm" disabled={busy || submitted || unknown || disabled || expired || inactive || message.questions.some((q: Data) => !answers[q.id]?.trim() || new TextEncoder().encode(answers[q.id]).length > 4096)} onClick={() => void submit()}>{submitted ? "已提交" : busy ? "提交中…" : "提交回答"}</Button>
      {unknown && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void reconcile()}>核对回答</Button>}
    </div>
  </article>;
}

export function TaskCenter({ projects, connected, initialProjectId, currentThread, action, onOpenThread, navigation, target, renderConversation }: Props & { navigation: ReactNode; renderConversation: (project: Data, thread: Data, beforeTurns?: ReactNode) => ReactNode; target?: { projectId: string; taskId: string; runId?: string; questionId?: string } }) {
  const layout = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!layout.current) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 760));
    observer.observe(layout.current); return () => observer.disconnect();
  }, []);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(!!target);
  const [searching, setSearching] = useState(false), [search, setSearch] = useState("");
  const [mode, setMode] = useState("all");
  const [filters, setFilters] = useState(["已开启","已暂停","已完成"]);
  const [draftConversation, setDraftConversation] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState<string>();
  const [initialText, setInitialText] = useState("");
  const [rows, setRows] = useState<Data[]>([]), [messages, setMessages] = useState<Data[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [scope, setScope] = useState(initialProjectId ?? "all");
  const [failedProjects, setFailedProjects] = useState<string[]>([]);
  const [selected, setSelected] = useState(() => sessionStorage.getItem("areal-gui:selected-global-task") ?? ""), [creating, setCreating] = useState(false), [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [selected]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [viewId] = useState(() => {
    const key = "areal-gui:global-task-view";
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, id); return id;
  });
  useEffect(() => {
    if (!target) return;
    setCreating(false); setScope("all"); setSelected(`${target.projectId}:${target.taskId}`); setDetailsOpen(true);
  }, [target]);
  useEffect(() => { setScope(initialProjectId ?? "all"); }, [initialProjectId]);
  const focusedTarget = useRef<typeof target>(undefined);
  const sequence = useRef(0), reading = useRef(false), mutation = useRef(false);
  const pages = useRef(1);
  const [readError, setReadError] = useState("");
  const [controlView, setControlView] = useState<Data | null>(null);
  const [channelError, setChannelError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const listed = rows.map(row => {
    const live = projects.find(p => p.id === row.projectId)?.state?.tasks?.[row.id];
    return live && live.revision >= row.revision ? {...row,...live} : row;
  });
  const listedTask: Data | undefined = listed.find(t => taskKey(t) === selected);
  // The control receipt is the Core response for this pause or cancel. Keep it
  // visible until the following read returns, including when a newer snapshot
  // has already settled the same workers.
  const task = controlView && taskKey(controlView) === selected ? controlView : listedTask;
  const project = projects.find(p => p.id === task?.projectId);
  const pending = project?.pending?.filter((p: Data) => p.method.startsWith("areal/task/") || p.method === "areal/channel/reply") ?? [];
  const disabled = !fresh || !connected || !project?.state?.connected || busy || pending.length > 0 || failedProjects.includes(project.id);
  const conversationId = task?.runs?.at(-1)?.threadId ?? task?.threadId;
  useEffect(() => { sessionStorage.setItem("areal-gui:selected-global-task", selected); }, [selected]);
  useEffect(() => {
    if (task?.mode === "scheduled" && conversationId && project?.state?.connected) void action("open",{projectId:project.id,threadId:conversationId}).catch(cause => setError(cause.message));
  }, [action,project?.id,project?.state?.connected,conversationId,task?.mode]);
  const selection = useRef({ selected, projects });
  selection.current = { selected, projects };
  const channelEpoch = useRef(0);
  const loadedChannelOwner = useRef("");
  // 失败或迟到的读取不能替换已经显示的频道记录。
  // 只有这次分页完整结束、且该任务仍是当前选择时，才用新结果替换。
  const readChannel = useCallback(async (projectId: string, taskId: string) => {
    const epoch = ++channelEpoch.current;
    const owner = `${projectId}:${taskId}`;
    try {
      let afterSequence = 0;
      const byId = new Map<string, Data>();
      for (;;) {
        const page = await action("manage", { projectId, operation: "taskChannel", taskId, afterSequence, limit: 100 });
        if (epoch !== channelEpoch.current || selection.current.selected !== owner) return;
        for (const message of page.data) {
          const previous = byId.get(message.id);
          if (!previous || previous.sequence < message.sequence) byId.set(message.id, message);
        }
        if (!page.hasMore) break;
        if (page.nextSequence <= afterSequence) throw new Error("频道读取未前进，请刷新后重试");
        afterSequence = page.nextSequence;
      }
      if (epoch !== channelEpoch.current || selection.current.selected !== owner) return;
      setMessages([...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence));
      setChannelError("");
    } catch (cause) {
      if (epoch !== channelEpoch.current || selection.current.selected !== owner) return;
      setChannelError((cause as Error).message);
    }
  }, [action]);
  const refresh = useCallback(async (more = false) => {
    if (reading.current || !connected) return;
    if (more) pages.current++;
    reading.current = true; setLoading(true); const id = ++sequence.current;
    try {
      const result = await action("tasks", { operation:"list", limit:Math.min(1024,30*pages.current) });
      if (id !== sequence.current) return;
      const current = selection.current;
      if (current.selected && !result.data.some((row: Data) => taskKey(row) === current.selected)) {
        const owner = current.projects.find(p => current.selected.startsWith(`${p.id}:`));
        if (owner && !result.errors.some((error: Data) => error.projectId === owner.id)) {
          const taskId = current.selected.slice(owner.id.length + 1);
          const selectedTask = await action("manage", { projectId:owner.id, operation:"task", taskId });
          result.data.push({ ...selectedTask, projectId:owner.id, projectName:projectLabel(owner), scope:owner.projectless ? "independent" : "project" });
        }
      }
      if (id !== sequence.current) return;
      const failed = result.errors.map((error: Data) => error.projectId);
      setRows(previous => [...result.data,...previous.filter(row => failed.includes(row.projectId))]);
      setFailedProjects(failed); setHasMore(result.hasMore); setFresh(true);
      setReadError(result.errors.map((error: Data) => `${error.projectName}：${error.message}`).join("\n")); setLoaded(true);
    } catch (cause) { if (id === sequence.current) { setReadError((cause as Error).message); setFresh(false); } }
    finally { reading.current = false; setLoading(false); }
  }, [action, connected]);
  const projectIds = projects.map(project => project.id).join(":");
  useEffect(() => { setFresh(false); void refresh(); const timer = window.setInterval(() => { if (!mutation.current) void refresh(); }, 3000); return () => { sequence.current++; clearInterval(timer); }; }, [refresh, projectIds]);
  useEffect(() => {
    if (!task || !project?.state?.connected) return;
    let live = true;
    void action("manage", { projectId: project.id, operation: "taskWatch", taskId: task.id, viewId }).catch(cause => { if (live) setError(cause.message); });
    return () => { live = false; void action("manage", { projectId: project.id, operation: "taskUnwatch", viewId }).catch(() => {}); };
  }, [action, project?.id, project?.state?.connected, task?.id, viewId]);
  useLayoutEffect(() => {
    const owner = task && project ? `${project.id}:${task.id}` : "";
    if (loadedChannelOwner.current === owner) return;
    loadedChannelOwner.current = owner;
    channelEpoch.current++;
    setMessages([]);
    setChannelError("");
  }, [project?.id, task?.id]);
  useEffect(() => {
    if (!task || !project?.state?.connected) return;
    void readChannel(project.id, task.id);
    return () => { channelEpoch.current++; };
  }, [project?.id, project?.state?.connected, readChannel, task?.channelSequence, task?.id]);
  useEffect(() => {
    if (!target || focusedTarget.current === target || selected !== `${target.projectId}:${target.taskId}`) return;
    const attribute = target.questionId ? "data-question-id" : "data-run-id";
    const id = target.questionId ?? target.runId;
    const element = [...layout.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []].find(e => e.getAttribute(attribute) === id);
    if (!element) return;
    focusedTarget.current = target;
    element.scrollIntoView({ block: "nearest" });
    element.querySelector<HTMLElement>('textarea, button, [role="combobox"]')?.focus({ preventScroll: true });
  }, [target, selected, messages, task]);
  const control = async (operation: string) => {
    if (!task || !project || disabled || mutation.current) return;
    mutation.current = true; setBusy(true); setError("");
    try {
      const receipt = await action("manage", { projectId: project.id, operation, taskId: task.id, expectedRevision: task.revision });
      if (receipt?.id) {
        const view = { ...task, ...receipt, projectId: project.id, projectName: task.projectName, scope: task.scope };
        flushSync(() => { setControlView(view); });
        // A following read can settle in the same turn. Leave the receipt on
        // screen for one frame so that pause/cancel settling is visible.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      setCancelling(false); await refresh(); setControlView(null);
    }
    catch (cause) { setControlView(null); setError((cause as Error).message); await action("manage", { projectId: project.id, operation: "task", taskId: task.id }).catch(() => {}); }
    finally { mutation.current = false; setBusy(false); }
  };
  const beginCreate = (text = "") => {
    if (creating) return;
    setInitialText(text); setDraftProjectId(!["all","independent"].includes(scope) ? scope : undefined); setCreating(true);
  };
  const complete = task && finished(task);
  const scheduleInterval = task?.schedule?.intervalSeconds;
  const latestRun = task?.runs?.at(-1);
  // 过期且没有未结束 Run 时，恢复才会按锚点合并。已有未结束 Run 则只跳过后续触发。
  const overdueMerge = !!task?.paused && !task.cancelled && scheduleInterval && task.nextRunAt != null && task.nextRunAt * 1000 <= Date.now() && (!latestRun || terminal(latestRun));
  const mergedSpan = !!scheduleInterval && latestRun && task.nextRunAt != null && task.nextRunAt >= latestRun.scheduledAt + scheduleInterval * 2;
  const creatingInline = creating && draftConversation;
  const detailOpen = creatingInline || !!task && !!project;
  const createdTask = useCallback((created: Data, projectId: string) => { setCreating(false); setSelected(`${projectId}:${created.id}`);  void refresh(); }, [refresh]);
  const updatedTask = useCallback(() => { void refresh(); }, [refresh]);
  const closeDetails = () => { setCreating(false); setSelected(""); requestAnimationFrame(() => layout.current?.querySelector<HTMLButtonElement>('[aria-label="新建自动化"]')?.focus()); };
  const visibleRows = listed.filter(row => (mode === "all" || row.mode === mode) && (scope === "all" || scope === "independent" && row.scope === "independent" || row.projectId === scope) && row.objective.toLowerCase().includes(search.toLowerCase()) && filters.includes(row.cancelled || finished(row) ? "已完成" : row.paused ? "已暂停" : "已开启"));
  return <section ref={layout} aria-label="自动化中心" className={`task-center text-ui-base ${detailOpen ? "has-detail" : ""} ${narrow ? "is-narrow" : ""}`}>
    <div className="task-center-toolbar">{navigation}<button className="icon-button" aria-label="前进" disabled><ArrowRight size={16}/></button><button className="icon-button" aria-label="切换任务侧栏" aria-expanded={!navCollapsed} onClick={() => setNavCollapsed(!navCollapsed)}><SidebarToggleIcon/></button></div>
    <div className="task-center-body">
    <div data-testid="task-center-list" className="task-center-list" hidden={navCollapsed || (narrow && detailOpen)}>
      <header className="task-list-heading"><h1>执行任务</h1><button aria-label="搜索执行任务" onClick={() => setSearching(!searching)}><Search size={16}/></button></header>
      {searching && <input autoFocus className="task-search" aria-label="搜索执行任务" placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => {if(e.key === "Escape") {setSearching(false);setSearch("");}}}/>}
      <button className="task-new" aria-label="新建自动化" disabled={!connected} onClick={() => beginCreate()}><Plus size={18}/>新建任务</button>
      <Select value={scope} onValueChange={value => value && setScope(value)}><SelectTrigger aria-label="筛选任务归属" className="task-scope-filter"><SelectValue>{scope === "all" ? "全部任务" : scope === "independent" ? "独立任务" : projectLabel(projects.find(p => p.id === scope) ?? {})}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all">全部任务</SelectItem><SelectItem value="independent">独立任务</SelectItem>{projects.filter(p => !p.projectless).map(p => <SelectItem key={p.id} value={p.id}>{projectLabel(p)}</SelectItem>)}</SelectContent></Select>
      <Select value={mode} onValueChange={value => value && setMode(value)}><SelectTrigger aria-label="筛选任务类型" className="task-scope-filter"><SelectValue>{mode === "all" ? "全部类型" : modeLabels[mode]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all">全部类型</SelectItem>{Object.entries(modeLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
      <div className="task-list-subheading"><span>任务目录</span><DropdownMenu><DropdownMenuTrigger aria-label="筛选任务"><ListFilter size={16}/></DropdownMenuTrigger><DropdownMenuContent align="end">{["已开启","已暂停","已完成"].map(label => <DropdownMenuCheckboxItem key={label} checked={filters.includes(label)} onCheckedChange={checked => setFilters(values => checked ? [...values,label] : values.filter(v => v !== label))}>{label}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu></div>
      <div className="task-list-scroll">
        {pending.length > 0 && <p role="alert">提交结果尚未确认，请核对任务列表。</p>}
        {error && <p role="alert">{error}</p>}
        {readError && <p role="alert">{readError}</p>}
        {(!connected || loaded && !fresh) && <p role="status">尚未确认最新状态，当前显示上次读取的任务。请连接后台后重试。</p>}
        {!loaded && !readError && <p>正在读取任务…</p>}
        <div className="task-list-rows">{visibleRows.map(row => <button key={`${row.projectId}:${row.id}`} type="button" aria-label={`${row.mode === "scheduled" ? "打开自动化" : "打开执行任务"} ${row.objective}`} aria-pressed={`${row.projectId}:${row.id}` === selected} disabled={!connected || !fresh || failedProjects.includes(row.projectId)} className={`task-list-row ${`${row.projectId}:${row.id}` === selected ? "bg-selected" : ""}`} onClick={() => {setCreating(false);setSelected(`${row.projectId}:${row.id}`);setError("");}}><span>{row.objective}</span><small>{row.scope === "independent" ? "独立任务" : row.projectName} · {modeLabels[row.mode]}</small><small>{row.paused || row.cancelled || finished(row) ? taskStatus(row) : row.nextRunAt != null ? date(row.nextRunAt) : taskStatus(row)}</small>{failedProjects.includes(row.projectId) && <small>读取失败 · 上次读取</small>}</button>)}</div>
        {loaded && fresh && !readError && !visibleRows.length && <p>{hasMore ? "已加载任务中没有匹配项，可展开显示更多。" : "没有符合筛选条件的执行任务。"}</p>}
        {hasMore && <Button variant="ghost" disabled={!connected || loading} onClick={() => void refresh(true)}>展开显示</Button>}
      </div>
    </div>
    {creating && <TaskDraft currentThread={currentThread} onConversationChange={setDraftConversation} projects={projects} initialProjectId={draftProjectId} action={action} initialText={initialText} disabled={!connected} onClose={() => setCreating(false)} onCreated={createdTask} />}
    {!detailOpen && <main className="task-welcome"><div className="task-welcome-intro"><span className="task-clock"><CalendarClock size={44}/></span><h2>安排任务</h2><p>AReaL 可以帮你处理持续性任务，让你无需亲力亲为。</p></div><div className="task-examples">{([
      [GitPullRequest,"检查项目进展","检查项目最近的提交与 PR，整理进展和待处理事项。"],
      [ListChecks,"每日构建巡检","检查项目构建和测试结果，总结失败原因。"],
      [Newspaper,"跟踪行业动态","整理最近的 AI 行业动态，附上原始来源。"],
      [FileSearch,"整理研究线索","回顾研究资料，整理关键发现和待验证的问题。"],
      [BookOpen,"每周知识回顾","回顾本周项目记录，总结结论与下一步。"],
      [Activity,"检查项目风险","检查项目中的阻塞、依赖与风险，列出需要关注的变化。"],
    ] as const).map(([Icon,title,description]) => <button key={title} onClick={() => beginCreate(description)} disabled={!connected}><span><Icon size={24}/></span><div><h3>{title}</h3><p>{description}</p></div></button>)}</div></main>}

    {task && project && !creatingInline && <main className="task-conversation"><header><h2>{task.objective}</h2>{task.mode === "scheduled" && <DropdownMenu><DropdownMenuTrigger aria-label="任务更多操作"><MoreHorizontal size={18}/></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={disabled || task.cancelled || complete || stopping(task)} onClick={() => void control(task.paused ? "taskResume" : "taskPause")}>{task.paused ? "恢复" : "暂停"}</DropdownMenuItem>{<DropdownMenuItem disabled={disabled || task.cancelled} onClick={() => setEditing(true)}>编辑</DropdownMenuItem>}{["立即运行","分享","删除"].map(label => <DropdownMenuItem key={label} disabled title="当前 Core 暂不支持">{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}<Button size="icon-sm" variant="ghost" aria-label="关闭任务详情" onClick={closeDetails}><X size={16}/></Button></header>
      {task.mode !== "scheduled" && <div className="task-plan-summary"><span>{task.scope === "independent" ? "独立任务" : task.projectName} · {modeLabels[task.mode]} · {taskStatus(task)}</span></div>}
      {overdueMerge && <p className="task-plan-note text-foreground-subtle">计划已过期。恢复后，错过的周期会合并为一次运行，不会逐次补跑。</p>}
      {mergedSpan && <p className="task-plan-note text-foreground-subtle">错过的周期已合并为这一次运行。运行尚未结束时，后续触发不会重叠启动。</p>}
      {task.mode === "scheduled" ? conversationId && project.state?.threads?.[conversationId] ? renderConversation(project, project.state.threads[conversationId],
        <ScheduledTaskIntro key={selected} task={task} project={project} action={action} disabled={disabled} controlDisabled={disabled || task.cancelled || !!complete || stopping(task)} status={task.paused || task.cancelled || complete || stopping(task) ? taskStatus(task) : "已开启"} onEdit={() => setEditing(true)} onControl={() => void control(task.paused ? "taskResume" : "taskPause")}/>) : <div className="task-conversation-pending">正在加载对话…</div> : <div className="p-4"><p>{interactionLabels[task.interactionMode]}</p>{conversationId ? <Button disabled={disabled} onClick={() => onOpenThread(project.id, conversationId)}>打开原会话</Button> : <p>已受理，尚未建立执行会话。</p>}</div>}
      <details className="task-run-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>运行详情</summary>
    <aside aria-label="自动化详情" className="task-detail">
      <>
        {task && <div className="task-detail-scroll grid content-start gap-3">
          <h3 className="whitespace-pre-wrap break-words font-medium">{task.objective}</h3><p>{taskStatus(task)} · {interactionLabels[task.interactionMode]}</p>
          <div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" disabled={disabled || task.cancelled || complete || stopping(task)} onClick={() => void control(task.paused ? "taskResume" : "taskPause")}>{task.paused ? "恢复" : "暂停"}{task.mode === "scheduled" ? "自动化" : "任务"}</Button><Button size="sm" variant="ghost" disabled={disabled || task.cancelled} onClick={() => setCancelling(true)}>取消{task.mode === "scheduled" ? "自动化" : "任务"}</Button><Button size="sm" variant="outline" disabled={!connected || !project.state?.connected} onClick={() => void readChannel(project.id, task.id)}>刷新频道</Button></div>
          {channelError && <p role="alert">{channelError}</p>}
          {task.schedule && <p className="text-foreground-subtle">首次：{date(task.schedule.at)} · {taskFrequency(task.schedule.intervalSeconds)}<br />下次：{date(task.nextRunAt)}</p>}
          <p className="text-foreground-subtle">Token 预算：{task.tokenBudget ?? "未设置"} · 轮次上限：{task.maxTurns == null ? "部署默认" : `${task.maxTurns} 轮`} · 活动时间上限：{task.maxActiveSeconds == null ? "部署默认" : `${task.maxActiveSeconds} 秒`}</p>
          <h4 className="font-medium">运行历史</h4>{!task.runs.length && <p className="text-foreground-subtle">尚未运行</p>}
          {[...task.runs].reverse().map((run: Data) => <article key={run.id} data-run-id={run.id} className="grid gap-1 rounded-control border border-border p-2"><div className="flex flex-wrap justify-between gap-1"><span>{statusLabels[run.status] ?? run.status}</span><span className="text-foreground-subtle">{date(run.scheduledAt)}</span></div><p className="break-words text-foreground-subtle">运行原因：{run.reason ? <span>{runReason(run.reason, task)}</span> : "—"}</p>{goalBudgetMessage(run.reason) && !scheduledTokenLimit(task, run.reason) && <p className="text-foreground-subtle">打开执行会话，在“编辑目标”中调整预算后恢复。</p>}<p className="text-foreground-subtle">{run.usage.tokensUsed.toLocaleString()} Token · {run.usage.turnsStarted} 轮 · {run.usage.timeUsedSeconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} 秒{!run.usage.accountingComplete && " · 用量尚未结算完整"}</p><GoalUsageSummary usage={run.usage} label="运行用量" />{run.threadId && <Button className="justify-self-start" size="sm" variant="ghost" onClick={() => onOpenThread(project.id, run.threadId)}>打开执行会话</Button>}{messages.filter(message => message.runId === run.id).map(message => <ChannelRecord key={message.id} message={message} task={task} projectId={project.id} action={action} disabled={disabled || !!channelError} onReplied={() => void refresh()} />)}{run.workers?.map((worker: Data) => <WorkerParticipant key={`${worker.threadId}:${worker.turnId}`} task={task} run={run} worker={worker} messages={messages} project={project} onOpenThread={onOpenThread} />)}</article>)}
          {messages.filter(message => !task.runs.some((run: Data) => run.id === message.runId)).map(message => <ChannelRecord key={message.id} message={message} task={task} projectId={project.id} action={action} disabled={disabled || !!channelError} onReplied={() => void refresh()} />)}
        </div>}
      </>
    </aside></details></main>}
    </div>
    {editing && task && project && <ScheduledTaskEditor key={selected} task={task} project={project} action={action} disabled={disabled} onSaved={updatedTask} onClose={() => setEditing(false)}/>}
    <Dialog open={cancelling} onOpenChange={open => { if (!busy) setCancelling(open); }}><DialogContent className="max-w-md" showCloseButton={!busy}><DialogHeader><DialogTitle>取消{task?.mode === "scheduled" ? "自动化" : "任务"}？</DialogTitle><DialogDescription>停止后续调度并请求停止当前运行。历史记录保留，已经执行的操作不会撤回。</DialogDescription></DialogHeader>{error && <p role="alert">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setCancelling(false)}>返回</Button><Button variant="destructive" disabled={disabled} onClick={() => void control("taskCancel")}>确认取消</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
