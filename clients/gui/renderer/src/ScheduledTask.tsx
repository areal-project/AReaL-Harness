import { useEffect, useRef, useState } from "react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog.js";
import { Textarea } from "./components/ui/textarea.js";
import { TaskDraft, TaskDraftMessages, taskFrequency } from "./TaskDraft.js";
import type { Action, Data } from "./services.js";

export function ScheduledTaskIntro({ task, project, action, disabled, controlDisabled, status, onEdit, onControl }: {
  task: Data; project: Data; action: Action; disabled: boolean; controlDisabled: boolean; status: string; onEdit: () => void; onControl: () => void;
}) {
  const [history, setHistory] = useState<Data | null>(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setHistory(null); setError("");
    void action("manage", { projectId: project.id, operation: "taskDraftHistory", taskId: task.id })
      .then(value => { if (active) setHistory(value); }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [action, project.id, task.id, retry]);
  const zone = history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { timeZone: zone });
  return <div className="scheduled-task-intro">
    {history && <TaskDraftMessages messages={history.messages}/>}
    {error && <p role="alert">创建记录读取失败：{error} <button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {!history && !error && <p className="text-foreground-subtle">正在读取创建记录…</p>}
    <section data-scheduled-task-card={task.id} className="scheduled-task-card" aria-label="定时任务安排">
      <div className="scheduled-card-heading"><CalendarClock size={20}/><strong>{task.objective}</strong><span>{status}</span></div>
      <p>{taskFrequency(task.schedule?.intervalSeconds)} · {task.schedule && when(task.schedule.at)} · {zone}</p>
      <p>{task.paused ? "已暂停后续调度" : task.cancelled ? "已取消后续调度" : task.nextRunAt != null ? `下次执行：${when(task.nextRunAt)}` : "没有后续安排"}</p>
      <footer><span>{task.scope === "independent" ? "独立任务" : task.projectName} · 本机执行</span><Button size="sm" variant="ghost" disabled={disabled || task.cancelled} onClick={onEdit}>任务设置</Button><Button size="sm" variant="ghost" disabled={controlDisabled} onClick={onControl}>{task.paused ? "恢复" : "暂停"}</Button></footer>
    </section>
  </div>;
}

// Capture the opened revision: concurrent changes must reject this edit, never
// silently overwrite a schedule that changed while the dialog was open.
export function ScheduledTaskEditor({ task, project, action, disabled, onSaved, onClose }: {
  task: Data; project: Data; action: Action; disabled: boolean; onSaved: () => void; onClose: () => void;
}) {
  const [original] = useState(task);
  const [objective, setObjective] = useState(task.objective as string);
  const initialDate = new Date(original.schedule.at * 1000);
  const initialTime = `${String(initialDate.getHours()).padStart(2,"0")}:${String(initialDate.getMinutes()).padStart(2,"0")}`;
  const initialRepeat = original.schedule.intervalSeconds === 86400 ? "daily" : "current";
  const [repeat, setRepeat] = useState(initialRepeat), [time, setTime] = useState(initialTime), [interval, setInterval] = useState("30");
  const [natural, setNatural] = useState(false), [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const scheduleChanged = repeat !== initialRepeat || repeat === "daily" && time !== initialTime;
  const dirty = objective !== original.objective || scheduleChanged;
  const valid = objective.trim() && (repeat !== "daily" || /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    && (repeat !== "interval" || Number.isInteger(Number(interval)) && Number(interval) >= 1 && Number(interval) <= 525600);
  const close = () => { if (!busy) { if (dirty && !natural && !unknown) setDiscard(true); else onClose(); } };
  const save = async () => {
    if (locked.current || disabled || unknown || !valid || !dirty) return;
    locked.current = true; setBusy(true); setError("");
    let schedule;
    if (scheduleChanged && repeat !== "current") {
      const next = new Date();
      if (repeat === "daily") {
        const [hours, minutes] = time.split(":").map(Number); next.setHours(hours, minutes, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        schedule = { at: Math.floor(next.getTime()/1000), intervalSeconds: 86400 };
      } else schedule = { at: Math.floor(Date.now()/1000) + Number(interval)*60, intervalSeconds: Number(interval)*60 };
    }
    try {
      await action("manage", { projectId: project.id, operation: "taskUpdate", taskId: original.id,
        expectedRevision: original.revision, objective: objective.trim(), ...(schedule ? { schedule } : {}) });
      if (alive.current) { onSaved(); onClose(); }
    } catch (cause) {
      if (alive.current) { setError((cause as Error).message); setUnknown(!!(cause as Error & {submissionUnknown?: boolean}).submissionUnknown); }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <><Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="task-draft-dialog scheduled-draft-dialog" overlayClassName="task-draft-overlay" showCloseButton={false}>
    <header className="task-draft-header"><DialogTitle>编辑定时任务</DialogTitle><button aria-label="关闭任务设置" disabled={busy} onClick={close}><X size={18}/></button></header>
    {natural ? <TaskDraft project={project} task={task} action={action} disabled={disabled} onCreated={onSaved} onClose={onClose}/> : <>
      <div className="task-draft-body"><Textarea className="task-description" aria-label="描述任务安排" maxLength={3600} value={objective} disabled={busy || unknown} onChange={e => setObjective(e.target.value)}/>
        <div className="task-schedule-fields"><label className="task-setting-row"><span>重复</span><select aria-label="重复" value={repeat} disabled={busy || unknown} onChange={e => setRepeat(e.target.value)}><option value="current">保持当前计划（{taskFrequency(original.schedule.intervalSeconds)}）</option><option value="daily">每天</option><option value="interval">间隔</option></select></label>
          {repeat === "daily" && <label className="task-setting-row"><span>时间</span><div className="task-time-value"><span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span><input aria-label="时间" value={time} disabled={busy || unknown} onChange={e => setTime(e.target.value)}/></div></label>}
          {repeat === "interval" && <label className="task-setting-row"><span>间隔（分钟）</span><input aria-label="间隔（分钟）" type="number" min="1" max="525600" value={interval} disabled={busy || unknown} onChange={e => setInterval(e.target.value)}/></label>}
        </div>
        <button className="task-advanced-toggle" disabled={busy || unknown || dirty} onClick={() => setNatural(true)}>用对话修改</button>
        {error && <p role="alert" className="task-draft-error">{error}</p>}{unknown && <p role="alert">提交结果尚未确认，请关闭设置后核对任务；不会重复提交。</p>}
      </div><footer className="task-draft-footer"><Button variant="secondary" disabled={busy} onClick={close}>取消</Button><Button disabled={disabled || busy || unknown || !valid || !dirty} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button></footer>
    </>}
  </DialogContent></Dialog><Dialog open={discard} onOpenChange={setDiscard}><DialogContent className="task-discard-dialog" showCloseButton={false}><DialogTitle>放弃更改？</DialogTitle><DialogDescription>您的更改将不会保存</DialogDescription><footer className="task-draft-footer"><Button variant="secondary" onClick={() => setDiscard(false)}>继续编辑</Button><Button onClick={onClose}>放弃更改</Button></footer></DialogContent></Dialog></>;
}
