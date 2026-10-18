import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import type { Action, Data } from "./services.js";

const statuses = { pending: "待开始", inProgress: "进行中", completed: "已完成", cancelled: "已取消" };
type Step = { id: string; text: string; status: keyof typeof statuses };
type Plan = { revision: number; steps: Step[] };
type Draft = { base: Plan; steps: Step[] };
const empty: Plan = { revision: 0, steps: [] };
const same = (a: Step[], b: Step[]) => JSON.stringify(a) === JSON.stringify(b);
function load(key: string, plan: Plan): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    const valid = (steps: unknown): steps is Step[] => Array.isArray(steps) && steps.length <= 64 && steps.every(s => s && typeof s.id === "string" && typeof s.text === "string" && Object.hasOwn(statuses, s.status));
    if (Number.isSafeInteger(value?.base?.revision) && valid(value.base.steps) && valid(value.steps)) return value;
  } catch { /* A malformed UI draft is not authoritative. */ }
  return { base: plan, steps: plan.steps };
}

export function PlanPane({ project, thread, action }: { project: Data; thread: Data; action: Action }) {
  const plan: Plan = thread.desktop?.plan ?? empty;
  const key = `areal-gui:plan-draft:${project.id}:${thread.id}`;
  const [draft, setDraft] = useState(() => load(key, plan));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const saving = useRef(false);
  const dirty = !same(draft.steps, draft.base.steps);
  const conflict = draft.base.revision !== plan.revision;
  const disabled = busy || loading || !project.state?.connected || thread.desktop?.archived || project.pending?.some((p: Data) => p.params?.threadId === thread.id);
  useEffect(() => {
    let live = true;
    void action("manage", { projectId: project.id, threadId: thread.id, operation: "plan" })
      .catch(cause => { if (live) setError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [action, project.id, thread.id]);
  useEffect(() => {
    // A newer model event can arrive before the save response. Once clean,
    // adopt the latest projection even when only our draft base changed.
    if (!dirty && plan.revision > draft.base.revision) { setDraft({ base: plan, steps: plan.steps }); localStorage.removeItem(key); }
  }, [plan.revision, draft.base.revision, dirty]);
  const change = (steps: Step[]) => {
    const next = { base: draft.base, steps };
    setDraft(next); localStorage.setItem(key, JSON.stringify(next)); setError("");
  };
  const restore = () => { setDraft({ base: plan, steps: plan.steps }); localStorage.removeItem(key); setError(""); };
  const move = (index: number, delta: number) => {
    const steps = [...draft.steps]; [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]]; change(steps);
  };
  const save = async () => {
    if (saving.current || disabled || conflict || !dirty) return;
    if (draft.steps.some(s => !s.text.trim() || new TextEncoder().encode(s.text).length > 1024)) { setError("每个步骤需要文字，且不能超过 1024 字节。"); return; }
    saving.current = true; setBusy(true); setError("");
    try {
      const result: Plan = await action("manage", { projectId: project.id, threadId: thread.id, operation: "planUpdate", expectedRevision: draft.base.revision, steps: draft.steps });
      setDraft({ base: result, steps: result.steps }); localStorage.removeItem(key);
    } catch (cause) { setError(`保存未确认，草稿已保留。${(cause as Error).message}`); }
    finally { saving.current = false; setBusy(false); }
  };
  return <section className="flex h-full min-h-0 flex-col text-ui-base" aria-label="执行计划">
    <div className="panel-toolbar flex shrink-0 items-center justify-between">
      <span className="text-foreground-subtle" role="status">{loading ? "读取中…" : busy ? "保存中…" : dirty ? "未保存的修改" : `${plan.steps.filter(s => s.status === "completed").length} / ${plan.steps.length} 已完成`}</span>
      <div className="flex gap-1"><Button size="icon-sm" variant="ghost" aria-label="还原计划" disabled={busy || loading || (!dirty && !conflict)} onClick={restore}><RotateCcw /></Button><Button size="sm" disabled={disabled || conflict || !dirty} onClick={() => void save()}>保存计划</Button></div>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {conflict && dirty && <p role="alert">计划已更新。草稿已保留，请核对后还原计划，再编辑最新版本。</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!draft.steps.length && !loading && <p className="text-foreground-subtle">暂无执行计划。添加步骤，或等待助手制定计划。</p>}
      {draft.steps.map((step, index) => <div key={step.id} className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1"><label htmlFor={`plan-${step.id}`} className="flex-1 text-foreground-subtle">步骤 {index + 1}</label>
          <Select value={step.status} disabled={disabled} onValueChange={value => { if (value) change(draft.steps.map(s => s.id === step.id ? { ...s, status: value as Step["status"] } : s)); }}>
            <SelectTrigger size="sm" variant="ghost" aria-label={`步骤 ${index + 1} 状态`}><SelectValue>{statuses[step.status]}</SelectValue></SelectTrigger>
            <SelectContent>{Object.entries(statuses).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="icon-sm" variant="ghost" aria-label={`上移步骤 ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={`下移步骤 ${index + 1}`} disabled={disabled || index === draft.steps.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={`移除步骤 ${index + 1}`} disabled={disabled} onClick={() => change(draft.steps.filter(s => s.id !== step.id))}><Trash2 /></Button>
        </div>
        <Textarea id={`plan-${step.id}`} aria-label={`步骤 ${index + 1}`} value={step.text} disabled={disabled} onChange={event => change(draft.steps.map(s => s.id === step.id ? { ...s, text: event.target.value } : s))} />
      </div>)}
      <Button className="self-start" variant="ghost" size="sm" disabled={disabled || draft.steps.length >= 64} onClick={() => change([...draft.steps, { id: crypto.randomUUID(), text: "", status: "pending" }])}><Plus />添加步骤</Button>
    </div>
  </section>;
}
