import { RsiGoal, type RsiState } from "./RsiGoal.js";
import { useEffect, useRef, useState } from "react";
import { Maximize2, PauseCircle, PlayCircle, RotateCcw, Target, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { goalBudgetMessage } from "./conversationPresentation.js";
import { GoalUsageSummary, type GoalUsage } from "./GoalUsage.js";

export const goalControlError = (cause: unknown) => {
  const message = (cause as Error).message;
  if (message.includes("unknown field `inferLimits`")) return "当前 Core 版本不支持从目标描述读取停止条件。请更新 Core 并重启后台后重试，目标草稿已保留。";
  if (message.includes("prompt limits cannot replace a recurring Task budget")) return "周期任务总 Token 预算由任务保留，不能通过修改目标文本解除。目标草稿已保留。";
  return message.includes("TASK_TOKEN_BUDGET") ? "当前运行的 Token 预算不能超过周期任务的剩余额度。" : message;
};
import type { Action, Data } from "./services.js";
import "./Goal.css";

type GoalStatus = "active" | "paused" | "blocked" | "completed" | "budgetLimited" | "failed";
type Goal = {
  workflow?: string; rsi?: RsiState;
  id: string; objective: string; status: GoalStatus; reason: string | null;
  tokenBudget: number | null; maxTurns: number | null; maxActiveSeconds: number | null;
  settling: boolean; waitingForInput: boolean; waitingForAgents: boolean; waitingForCapacity: boolean;
  usage: GoalUsage;
  limitsPending?: boolean;
  report?: { summary: string; evidence: string[]; remaining: string[]; blocker?: string | null } | null;
};
type GoalState = { revision: number; eventSequence: number; goal: Goal | null };
type Props = { project: Data; thread: Data; action: Action };
const labels: Record<GoalStatus, string> = { active: "进行中的目标", paused: "已暂停的目标", blocked: "目标受阻", completed: "目标已完成", budgetLimited: "目标已达到预算", failed: "目标失败" };
const reasons: Record<string, string> = { user: "已由你暂停", interrupted: "运行已中断", usageUnknown: "存在未确认的用量，请核对后恢复", progressUnreported: "连续运行未报告进度，目标已暂停", goalBudget: "已达到目标预算，请调整停止条件后恢复" };
const stateOf = (thread: Data): GoalState => thread.goals ?? { revision: 0, eventSequence: 0, goal: null };
const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
const pendingGoal = (project: Data, thread: Data) => project.pending?.some((entry: Data) => entry.params?.threadId === thread.id);

export function GoalCard({ project, thread, action, onEdit }: Props & { onEdit: () => void }) {
  const { goal, revision } = stateOf(thread);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false);
  useEffect(() => {
    if (!goal || goal.rsi || (goal.status !== "active" && !goal.settling)) return;
    let cancelled = false, reading = false;
    const refresh = async () => {
      if (cancelled || reading) return;
      reading = true;
      try { await action("manage", { projectId: project.id, threadId: thread.id, operation: "goal" }); }
      catch { /* Connection errors belong to the existing reconnect UI. */ }
      finally { reading = false; }
    };
    // Usage changes between lifecycle events; read Core while work is active.
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [action, project.id, thread.id, goal?.status, goal?.settling]);
  if (!goal) return null;
  if (goal.rsi) return <RsiGoal project={project} thread={thread} action={action} />;
  const disabled = busy || pendingGoal(project, thread) || !project.state?.connected || thread.desktop?.archived;
  const control = async (operation: string) => {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); setError("");
    try { await action("manage", { projectId: project.id, threadId: thread.id, operation, goalId: goal.id, expectedRevision: revision }); }
    catch (cause) { setError(goalControlError(cause)); }
    finally { locked.current = false; setBusy(false); }
  };
  return <section className="goal-dock" data-testid="goal-card" aria-label="当前目标">
    <div className="goal-strip">
      <button type="button" className="goal-summary" onClick={onEdit}>
        <Target size={14} aria-hidden="true" />
        <span className="goal-status">{labels[goal.status]}</span>
        <span className="goal-objective">{goal.objective}</span>
        <span className="goal-elapsed">{duration(goal.usage.timeUsedSeconds)}</span>
      </button>
      <ControlHintTooltip title={goal.status === "active" || goal.settling ? "暂停目标后可清除" : "清除目标"}>
        <Button variant="ghost" size="icon-sm" aria-label="清除目标" disabled={disabled || goal.status === "active" || goal.settling} onClick={() => void control("goalClear")}><Trash2 /></Button>
      </ControlHintTooltip>
      {goal.status !== "completed" && <ControlHintTooltip title={goal.status === "active" ? "暂停目标" : "恢复目标"}>
        <Button variant="ghost" size="icon-sm" aria-label={goal.status === "active" ? "暂停目标" : "恢复目标"} disabled={disabled || goal.settling} onClick={() => void control(goal.status === "active" ? "goalPause" : "goalResume")}>
          {goal.status === "active" ? <PauseCircle /> : <PlayCircle />}
        </Button>
      </ControlHintTooltip>}
      <ControlHintTooltip title="编辑目标"><Button variant="ghost" size="icon-sm" aria-label="编辑目标" onClick={onEdit}><Maximize2 /></Button></ControlHintTooltip>
    </div>
    {(goal.reason || goal.settling || goal.waitingForInput || goal.waitingForAgents || goal.waitingForCapacity) && <p className="goal-detail" role="status">{goal.settling ? "正在等待运行结束…" : goal.waitingForInput ? "等待回答" : goal.waitingForAgents ? "等待子任务" : goal.waitingForCapacity ? "等待可用执行容量" : goalBudgetMessage(goal.reason) ?? reasons[goal.reason ?? ""] ?? goal.reason}</p>}
    {error && <p className="goal-detail text-destructive" role="alert">{error}</p>}
  </section>;
}

type Draft = { objective: string };
const draftOf = (goal: Goal | null): Draft => ({ objective: goal?.objective ?? "" });
const isDraft = (value: unknown): value is Draft => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).objective === "string";
function loadDraft(key: string, goal: Goal | null): { base: Draft; draft: Draft } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (isDraft(saved?.base) && isDraft(saved?.draft)) return { base: { objective: saved.base.objective }, draft: { objective: saved.draft.objective } };
  } catch { /* Ignore a malformed local draft. */ }
  const current = draftOf(goal);
  return { base: current, draft: current };
}
export function GoalEditor({ project, thread, action }: Props) {
  const { goal, revision } = stateOf(thread);
  const draftKey = `areal-gui:goal-draft:${project.id}:${thread.id}:${goal?.id ?? "new"}`;
  const [initial] = useState(() => loadDraft(draftKey, goal));
  const [base, setBase] = useState(initial.base);
  const [draft, setDraft] = useState(initial.draft);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const current = draftOf(goal);
  const conflict = JSON.stringify(current) !== JSON.stringify(base);
  useEffect(() => {
    if (!dirty) { setBase(draftOf(goal)); setDraft(draftOf(goal)); }
  }, [goal?.objective, goal?.tokenBudget, goal?.maxTurns, goal?.maxActiveSeconds]);
  const change = (key: keyof Draft, value: string) => {
    const next = { ...draft, [key]: value }; setDraft(next); localStorage.setItem(draftKey, JSON.stringify({ base, draft: next }));
  };
  const restore = () => { setBase(current); setDraft(current); localStorage.removeItem(draftKey); setError(""); };
  const active = goal?.status === "active" || goal?.settling || thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const save = async () => {
    if (saving.current || active || conflict || !draft.objective.trim()) return;
    setError("");
    saving.current = true; setBusy(true);
    try {
      const result: GoalState = await action("manage", { projectId: project.id, threadId: thread.id, operation: goal ? "goalUpdate" : "goalCreate", expectedRevision: revision, ...(goal ? { goalId: goal.id } : {}), objective: draft.objective, inferLimits: true });
      localStorage.removeItem(draftKey); setBase(draftOf(result.goal)); setDraft(draftOf(result.goal));
    } catch (cause) { setError(goalControlError(cause)); }
    finally { saving.current = false; setBusy(false); }
  };
  if (goal?.rsi) return <RsiGoal project={project} thread={thread} action={action} />;
  return <section className="goal-editor" aria-label={goal ? "编辑目标" : "设置目标"}>
    <textarea aria-label="目标" value={draft.objective} maxLength={4000} placeholder="描述你希望完成的目标" disabled={busy || goal?.status === "completed"} onChange={event => change("objective", event.target.value)} />
    {goal && <p className="goal-editor-notice">{goal.usage.tokensUsed.toLocaleString()} Token 已使用 · {goal.usage.turnsStarted} 轮 · {duration(goal.usage.timeUsedSeconds)}</p>}
    {goal && <>
      <GoalUsageSummary usage={goal.usage} label="目标用量" />
      <p className="goal-editor-notice">{goal.limitsPending ? "停止条件等待 Core 确认" : `当前停止条件：Token ${goal.tokenBudget ?? "未设置"} · 轮次 ${goal.maxTurns ?? "未设置"} · 活动时间 ${goal.maxActiveSeconds == null ? "未设置" : `${goal.maxActiveSeconds} 秒`}`}</p>
      {goal.report && <details className="goal-editor-report" open><summary>目标进展</summary><p>{goal.report.summary}</p>{goal.report.blocker && <p role="status">受阻原因：{goal.report.blocker}</p>}{goal.report.evidence.length > 0 && <><p>确认依据</p><ul>{goal.report.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></>}{goal.report.remaining.length > 0 && <><p>剩余工作</p><ul>{goal.report.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</details>}
    </>}
    {goal && (!goal.usage.accountingComplete || goal.usage.unknownRequests > 0) && <p className="goal-editor-notice" role="status">用量尚未结算完整，剩余额度不能作为最终消费结果。</p>}
    {active && <p className="goal-editor-notice">暂停目标并等待当前运行结束后，可以保存修改。草稿会保留。</p>}
    {conflict && dirty && <p role="alert">目标已在其他位置修改。草稿已保留，请核对后还原到最新目标再编辑。</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <footer><span>{busy ? "保存中…" : dirty ? "未保存的修改" : goal ? "已保存" : "设置后开始执行"}</span><Button variant="ghost" size="icon-sm" aria-label="还原" disabled={busy || (!dirty && !conflict)} onClick={restore}><RotateCcw /></Button><Button size="sm" disabled={busy || active || pendingGoal(project, thread) || !project.state?.connected || thread.desktop?.archived || goal?.status === "completed" || conflict || !draft.objective.trim() || (!!goal && !dirty)} onClick={() => void save()}>{goal ? "保存" : "开始目标"}</Button></footer>
  </section>;
}
