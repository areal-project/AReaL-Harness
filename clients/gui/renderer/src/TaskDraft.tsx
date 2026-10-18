import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./components/ui/dropdown-menu.js";
import { Switch } from "./components/ui/switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import type { Action, Data } from "./services.js";

type SavedDraft = { mode?: "scheduled" | "foreground" | "background"; interactionMode?: "interactive" | "asynchronous" | "headless"; conversation?: boolean; scopeProjectId?: string; ownerId?: string; lastSavedTurn?: string; repeat?: string; time?: string; interval?: string; model?: string; effort?: string; draftId: string; text: string; threadId?: string; autoTurnId?: string; pending?: "start" | "send" | "confirm" | "create" };
type Proposal = { objective: string; mode: "scheduled" | "background"; interactionMode: string;
  schedule?: { at: number; intervalSeconds?: number }; tokenBudget?: number; maxTurns?: number; maxActiveSeconds?: number };
type DraftView = { threadId: string; turnId: string | null; digest: string | null; running: boolean;
  proposal: Proposal | null; messages: { id: string; role: string; text: string }[]; error: string; timeZone: string; task?: Data };
export function taskFrequency(seconds?: number) {
  if (!seconds) return "仅一次";
  for (const [size, unit] of [[604800,"周"], [86400,"天"], [3600,"小时"], [60,"分钟"]] as const) {
    if (seconds % size === 0) return `每 ${seconds / size} ${unit}`;
  }
  return `每 ${seconds} 秒`;
}
export function TaskDraftMessages({ messages }: { messages: { id: string; role: string; text: string }[] }) {
  return <>{messages.map(message => {
    const [description, selection] = message.text.split("\n\n用户在定时任务控件中选择：");
    return <div key={message.id} className={`task-management-message ${message.role}`}>
      <p>{message.role === "user" ? description : message.text}</p>
      {message.role === "user" && selection && <small>{selection.split("。按此设置安排")[0]}</small>}
    </div>;
  })}</>;
}
export function TaskDraft({ project: suppliedProject, projects = [], initialProjectId, currentThread, task, action, disabled, onCreated, onClose, onConversationChange, initialText = "" }: {
  currentThread?: { projectId: string; threadId: string }; initialText?: string; project?: Data; projects?: Data[]; initialProjectId?: string; task?: Data;
  action: Action; disabled: boolean; onCreated: (task: Data, projectId: string) => void; onClose: () => void; onConversationChange?: (open: boolean) => void;
}) {
  const storageKey = task ? `areal-gui:task-edit:${suppliedProject!.id}:${task.id}` : `areal-gui:task-draft:${initialProjectId ?? "global"}`;
  const [saved, setSaved] = useState<SavedDraft>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (value && typeof value.draftId === "string" && typeof value.text === "string") return {scopeProjectId:initialProjectId,...value};
      const legacy = !task && initialProjectId ? JSON.parse(localStorage.getItem(`areal-gui:task-create:${initialProjectId}`) ?? "null") : null;
      if (legacy?.objective) return { draftId: crypto.randomUUID(), scopeProjectId:initialProjectId, text: [legacy.objective,
        legacy.at ? `首次时间：${legacy.at}` : "", legacy.interval ? `重复间隔：${legacy.interval} 秒` : "",
        ...([['tokenBudget','Token 预算'],['maxTurns','最大轮次'],['maxActiveSeconds','最长活动秒数']] as const)
          .flatMap(([field,label]) => legacy[field] ? [`${label}：${legacy[field]}`] : []),
      ].filter(Boolean).join("\n") };
    } catch { /* 本机草稿不是 Core 的执行事实。 */ }
    return { draftId: crypto.randomUUID(), text: initialText, scopeProjectId: initialProjectId };
  });
  const mode = saved.mode ?? "scheduled";
  const direct = !task && mode !== "scheduled";
  const conversation = !task && !direct && !!(saved.conversation || saved.threadId || saved.pending);
  useEffect(() => {
    onConversationChange?.(conversation);
    return () => onConversationChange?.(false);
  }, [conversation, onConversationChange]);
  const ownerId = task ? suppliedProject!.id : saved.ownerId ?? saved.scopeProjectId;
  const project = task ? suppliedProject : projects.find(p => p.id === ownerId);
  const models: Data[] = project?.models ?? projects.find(p => p.models?.length)?.models ?? [];
  const [advanced, setAdvanced] = useState(false), [discarding, setDiscarding] = useState(false);
  const current = useRef(saved); current.current = saved;
  const [view, setView] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const alive = useRef(true), locked = useRef(false), reading = useRef(false), generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const persist = (next: SavedDraft) => { current.current = next; localStorage.setItem(storageKey, JSON.stringify(next)); if (alive.current) setSaved(next); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    const id = current.current.threadId;
    if (!id || reading.current || locked.current) return;
    reading.current = true; const stamp = generation.current;
    try {
      const projectId = task ? suppliedProject!.id : current.current.ownerId ?? current.current.scopeProjectId;
      if (!projectId) return;
      const result: DraftView = await action("manage", { projectId, operation: "taskDraftRead", threadId: id });
      if (!alive.current || stamp !== generation.current) return;
      setView(result); setReadError("");
      if (result.task) {
        if (task) {
          if (current.current.lastSavedTurn !== result.turnId) {
            persist({...current.current,text:"",pending:undefined,autoTurnId:undefined,lastSavedTurn:result.turnId!});
            onCreated(result.task, projectId);
          }
        } else { localStorage.removeItem(storageKey); onCreated(result.task, projectId); }
      }
    } catch (cause) { if (alive.current && stamp === generation.current) setReadError((cause as Error).message); }
    finally { reading.current = false; }
  }, [action, suppliedProject?.id, task?.id, storageKey, onCreated]);
  useEffect(() => {
    if (!saved.threadId || !ownerId) return;
    void refresh(); const timer = window.setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [saved.threadId, ownerId, refresh]);
  useEffect(() => { scroll.current?.scrollTo({top: scroll.current.scrollHeight, behavior:"smooth"}); }, [view?.turnId, view?.running, view?.messages.length]);
  const blocked = disabled || busy || view?.running || !!saved.pending || !!readError || !!task?.cancelled;
  const createDirect = async () => {
    if (locked.current || blocked || !current.current.text.trim() || mode === "foreground" && !currentThread) return;
    locked.current = true; setBusy(true); setError("");
    try {
      let projectId = mode === "foreground" ? currentThread!.projectId : ownerId;
      if (!projectId) {
        const prepared = await action("projectless", {operation:"prepare",requestId:current.current.draftId});
        projectId = prepared.projectId;
      }
      persist({...current.current,ownerId:projectId,pending:"create"});
      const created = await action("manage", {projectId,operation:"taskCreate",requestId:current.current.draftId,
        mode,objective:current.current.text.trim(),interactionMode:current.current.interactionMode ?? (mode === "foreground" ? "interactive" : "asynchronous"),
        ...(mode === "foreground" ? {threadId:currentThread!.threadId} : {})});
      localStorage.removeItem(storageKey);
      if (alive.current) onCreated(created,projectId);
    } catch (cause) {
      const failure = cause as Error & {submissionUnknown?: boolean};
      if (!failure.submissionUnknown) persist({...current.current,pending:undefined});
      if (alive.current) setError(failure.message);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const send = async () => {
    if (locked.current || blocked || !current.current.text.trim()) return;
    locked.current = true; generation.current++; setBusy(true); setError("");
    const description = current.current.text;
    if (!task) persist({...current.current,conversation:true});
    const repeat = current.current.repeat ?? "每天", time = current.current.time ?? "09:00";
    const schedule = repeat === "仅一次" ? `仅一次，在 ${time} 当地时间执行，不重复` : repeat === "间隔" ? `每 ${current.current.interval ?? "30"} 分钟，从现在起一个间隔后首次执行` : `每天 ${time}`;
    const message = task ? description : `${description}\n\n用户在定时任务控件中选择：${schedule}。按此设置安排；如果说明中的时间与控件冲突，请先询问。`, zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      let projectId = ownerId;
      if (!projectId) {
        const prepared = await action("projectless", {operation:"prepare",requestId:current.current.draftId});
        projectId = prepared.projectId;
        persist({...current.current,ownerId:projectId});
      }
      if (!current.current.threadId) {
        persist({...current.current,pending:"start"});
        const started = await action("manage", {projectId,operation:"taskDraftStart",draftId:current.current.draftId,timeZone:zone,...(task ? {taskId:task.id} : {})});
        persist({...current.current,threadId:started.threadId,pending:undefined});
      }
      persist({...current.current,pending:"send"});
      const sent = await action("manage", {projectId,operation:"taskDraftSend",threadId:current.current.threadId,text:message,timeZone:zone,...(!task ? {model:current.current.model ? models.find((m: Data) => `${m.providerId}/${m.modelId}` === current.current.model) : null,effort:current.current.effort} : {})});
      persist({...current.current,pending:undefined,autoTurnId:sent.turnId,...(!task ? {text:""} : {})});
      if (alive.current) setView(previous => ({threadId:current.current.threadId!,turnId:sent.turnId ?? null,
        timeZone:zone,messages:[...(previous?.messages ?? []),{id:`${sent.turnId}:user`,role:"user",text:description}],error:"",running:true,proposal:null,digest:null}));
    } catch (cause) {
      const failure = cause as Error & {submissionUnknown?: boolean};
      if (!failure.submissionUnknown) persist({...current.current,pending:undefined});
      if (alive.current) setError(failure.message);
    } finally {
      locked.current = false;
      if (alive.current) { setBusy(false); void refresh(); input.current?.focus(); }
    }
  };
  const confirm = async () => {
    if (locked.current || blocked || !view?.proposal) return;
    locked.current = true; generation.current++; setBusy(true); setError("");
    persist({...current.current,pending:"confirm"});
    try {
      const updated = await action("manage", {projectId:ownerId,operation:"taskDraftConfirm",threadId:view.threadId,turnId:view.turnId,digest:view.digest});
      if (task) {
        persist({...current.current,text:"",pending:undefined,autoTurnId:undefined,lastSavedTurn:view.turnId!});
        if (alive.current) setView({...view,task:updated});
      } else { localStorage.removeItem(storageKey); localStorage.removeItem(`areal-gui:task-create:${ownerId}`); }
      if (alive.current) onCreated(updated,ownerId!);
    } catch (cause) {
      const failure = cause as Error & {submissionUnknown?: boolean};
      if (!failure.submissionUnknown) persist({...current.current,pending:undefined,autoTurnId:undefined});
      if (alive.current) setError(failure.message);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    if (!view || view.running || !saved.autoTurnId || saved.autoTurnId !== view.turnId || blocked) return;
    if (view.proposal && !view.error) void confirm();
    else persist({...current.current,autoTurnId:undefined});
  });
  const working = busy || !!view?.running || (!!saved.autoTurnId && !!view?.proposal && !saved.pending && !error && !readError && !disabled);
  const close = () => {
    if (working) return;
    if (saved.text || saved.threadId || saved.repeat || saved.time || saved.model || saved.effort) setDiscarding(true);
    else onClose();
  };
  const change = (next: Partial<SavedDraft>) => persist({...current.current,...next});
  const menu = (label: string, value: string, options: {label: string; value: string; disabled?: boolean}[], select: (value: string) => void) => <DropdownMenu>
    <DropdownMenuTrigger className="task-setting-value" aria-label={label} disabled={!!blocked || working}>{value}<ChevronDown size={14}/></DropdownMenuTrigger>
    <DropdownMenuContent className="task-setting-menu" align="end">{options.map(option => <DropdownMenuItem key={option.value} disabled={option.disabled} title={option.disabled ? "当前 Core 暂不支持" : undefined} onClick={() => select(option.value)}>{option.label}</DropdownMenuItem>)}</DropdownMenuContent>
  </DropdownMenu>;
  const feedback = <>
    {working && <p role="status">Agent 正在{task ? "整理修改" : "安排任务"}…</p>}
    {(error || readError || view?.error) && <p role="alert" className="task-draft-error">{error || readError || view?.error}</p>}
    {saved.pending && !busy && <p role="alert" className="task-draft-error">提交结果尚未确认，请先核对任务列表；不会自动重复提交。</p>}
  </>;
  const interaction = <section className="task-management" aria-label={task ? "管理任务" : "创建任务对话"}>
    <div ref={scroll} className="task-management-history" aria-live="polite" data-draft-turn-id={view?.turnId ?? ""} aria-busy={!!view?.running}>
      {!view?.messages.length && <p className="text-foreground-subtle">{task ? "可以修改这条任务的时间、内容，或暂停、恢复任务。" : "正在根据你的说明安排任务。需要补充的信息会在这里询问。"}</p>}
      <TaskDraftMessages messages={view?.messages ?? []}/>
      {view?.task && !error && !readError && <p role="status">已保存修改</p>}
      {feedback}
    </div>
    <div className="task-management-composer"><Textarea ref={input} aria-label={task ? "修改任务安排" : "补充任务安排"} placeholder={task ? "例如：改到每天中午12点" : "补充任务内容或执行时间…"} value={saved.text} maxLength={3600} disabled={!!blocked || working} onChange={e => change({text:e.target.value})}/>
      <Button disabled={!!blocked || working || !saved.text.trim()} onClick={() => void send()}>{task ? "保存修改" : "发送"}</Button></div>
  </section>;
  if (task) return interaction;
  return <>{conversation ? <main className="task-conversation" aria-label="新建定时任务">
    <header><h2>新建定时任务</h2><Button size="icon-sm" variant="ghost" aria-label="关闭创建对话" disabled={working} onClick={close}><X size={16}/></Button></header>
    <div className="task-plan-summary"><span>{saved.scopeProjectId ? project?.name ?? project?.root?.split(/[\\/]/).pop() ?? "所选项目" : "独立任务"} · 本机执行</span></div>
    {interaction}
  </main> : <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className={`task-draft-dialog ${direct ? "" : "scheduled-draft-dialog"}`} overlayClassName="task-draft-overlay" showCloseButton={false}>
      <header className="task-draft-header"><DialogTitle>{direct ? "创建执行任务" : "设置定时任务"}</DialogTitle><button aria-label="关闭" disabled={working} onClick={close}><X size={18} /></button></header>
      <div className="task-draft-body">
        <Textarea ref={input} autoFocus className="task-description" aria-label="描述任务安排" placeholder="说明…" value={saved.text}
          onKeyDown={e => { if (!direct && (e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.closest("[role=dialog]")?.querySelector<HTMLButtonElement>(".task-draft-footer button:last-child")?.click(); } }} disabled={!!blocked || working} maxLength={3600} onChange={e => change({text:e.target.value})} />
        <div className="task-schedule-fields">
          {direct && <>
          <div className="task-setting-row"><span>执行方式</span><Select value={mode} disabled={!!blocked || working || !!saved.threadId} onValueChange={value => { if (value) change({mode:value as SavedDraft["mode"],interactionMode:value === "foreground" ? "interactive" : "asynchronous",ownerId:undefined}); }}>
            <SelectTrigger aria-label="任务执行方式"><SelectValue>{{scheduled:"定时安排",foreground:"当前会话前台执行",background:"独立后台执行"}[mode]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="scheduled">定时安排</SelectItem><SelectItem value="foreground" disabled={!currentThread}>当前会话前台执行</SelectItem><SelectItem value="background">独立后台执行</SelectItem></SelectContent>
          </Select></div>
          </>}
          {direct && <div className="task-setting-row"><span>交互方式</span><Select value={saved.interactionMode ?? (mode === "foreground" ? "interactive" : "asynchronous")} disabled={!!blocked || working} onValueChange={value => change({interactionMode:value as SavedDraft["interactionMode"]})}>
            <SelectTrigger aria-label="任务交互方式"><SelectValue>{{interactive:"当前对话",asynchronous:"异步提问",headless:"无人值守"}[saved.interactionMode ?? (mode === "foreground" ? "interactive" : "asynchronous")]}</SelectValue></SelectTrigger><SelectContent>{mode === "foreground" && <SelectItem value="interactive">当前对话</SelectItem>}<SelectItem value="asynchronous">异步提问</SelectItem><SelectItem value="headless">无人值守</SelectItem></SelectContent>
          </Select></div>}
          {mode === "foreground" ? <p>在当前会话开展工作；会话繁忙时先受理，再等待开始。</p> : <>

          {direct && <>
          <div className="task-setting-row"><span>归属</span><Select value={saved.scopeProjectId ?? "independent"} disabled={!!blocked || working || !!saved.threadId} onValueChange={value => change({scopeProjectId:value === "independent" ? undefined : value!,ownerId:undefined,model:undefined})}>
            <SelectTrigger aria-label="任务归属" className="task-scope-select"><SelectValue>{saved.scopeProjectId ? projects.find(p => p.id === saved.scopeProjectId)?.name ?? projects.find(p => p.id === saved.scopeProjectId)?.root?.split(/[\\/]/).pop() ?? "所选项目" : "独立任务"}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="independent">独立任务</SelectItem>{projects.filter(p => !p.projectless).map(p => <SelectItem key={p.id} value={p.id}>{p.name ?? p.root?.split(/[\\/]/).pop()}</SelectItem>)}</SelectContent>
          </Select></div>          </>}
          </>}
          {!direct && <><div className="task-setting-row"><span>重复</span>{menu("重复", saved.repeat ?? "每天", ["仅一次","间隔","每天","工作日","每周","自定义"].map(value => ({value,label:value,disabled:!["仅一次","间隔","每天"].includes(value)})), repeat => change({repeat,...(repeat === "仅一次" ? {time:""} : saved.repeat === "仅一次" ? {time:"09:00"} : {})}))}</div>
          {(saved.repeat ?? "每天") === "仅一次" ? <label className="task-setting-row"><span>当地日期与时间</span><input aria-label="一次性执行时间" type="datetime-local" step="1" value={saved.time ?? ""} onChange={e => change({time:e.target.value})} disabled={!!blocked || working}/></label> :
          (saved.repeat ?? "每天") === "间隔" ? <label className="task-setting-row"><span>心跳间隔（分钟）</span><input aria-label="心跳间隔（分钟）" type="number" min="1" max="525600" value={saved.interval ?? "30"} onChange={e => change({interval:e.target.value})} disabled={!!blocked || working}/></label> :
          <div className="task-setting-row"><span>时间</span><div className="task-time-value"><span>{Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Shanghai" ? "中国时间" : Intl.DateTimeFormat().resolvedOptions().timeZone}</span><input aria-label="时间" value={saved.time ?? "09:00"} onChange={e => change({time:e.target.value})} disabled={!!blocked || working}/>{menu("选择时间","",Array.from({length:96},(_,i) => {const value=`${String(Math.floor(i/4)).padStart(2,"0")}:${String(i%4*15).padStart(2,"0")}`;return {value,label:value};}),time => change({time}))}</div></div>}
          </>}
        </div>
        {direct && <><p className="text-foreground-subtle">{saved.interactionMode === "headless" ? "不等待人工回答，也不会自动批准工具。" : saved.interactionMode === "interactive" ? "在当前对话中处理问题与审批。" : "问题进入任务频道；需要人工批准的工具会拒绝。"}任务受理后在此电脑执行；只关闭窗口不取消任务。</p>{feedback}</>}
        {!direct && <><button className="task-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>高级<ChevronDown size={14} className={advanced ? "rotate-180" : ""}/></button>
        {advanced && <div className="task-advanced-fields">
          <div className="task-setting-row"><span>归属</span><Select value={saved.scopeProjectId ?? "independent"} disabled={!!blocked || working || !!saved.threadId} onValueChange={value => change({scopeProjectId:value === "independent" ? undefined : value!,ownerId:undefined,model:undefined})}>
            <SelectTrigger aria-label="任务归属" className="task-scope-select"><SelectValue>{saved.scopeProjectId ? projects.find(p => p.id === saved.scopeProjectId)?.name ?? projects.find(p => p.id === saved.scopeProjectId)?.root?.split(/[\\/]/).pop() ?? "所选项目" : "独立任务"}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="independent">独立任务</SelectItem>{projects.filter(p => !p.projectless).map(p => <SelectItem key={p.id} value={p.id}>{p.name ?? p.root?.split(/[\\/]/).pop()}</SelectItem>)}</SelectContent>
          </Select></div>
          <div className="task-setting-row"><span>执行方式</span><Select value={mode} disabled={!!blocked || working || !!saved.threadId} onValueChange={value => { if (value) change({mode:value as SavedDraft["mode"],interactionMode:value === "foreground" ? "interactive" : "asynchronous",ownerId:undefined}); }}>
            <SelectTrigger aria-label="任务执行方式"><SelectValue>{{scheduled:"定时安排",foreground:"当前会话前台执行",background:"独立后台执行"}[mode]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="scheduled">定时安排</SelectItem><SelectItem value="foreground" disabled={!currentThread}>当前会话前台执行</SelectItem><SelectItem value="background">独立后台执行</SelectItem></SelectContent>
          </Select></div>

          <div className="task-setting-row" title="任务由此电脑后台运行，暂不支持云端执行"><span>在此电脑上运行</span><Switch aria-label="在此电脑上运行" checked disabled /></div>
          <div className="task-setting-row" title="当前 Core 周期任务复用执行会话"><span>每次运行时都开启新聊天</span><Switch aria-label="每次运行时都开启新聊天" checked={false} disabled /></div>
          <div className="task-setting-row"><span>模型</span>{menu("模型",models.find((m: Data) => `${m.providerId}/${m.modelId}` === saved.model)?.displayName ?? "默认模型",[{value:"",label:"默认模型"},...models.filter((m: Data) => m.available !== false).map((m: Data) => ({value:`${m.providerId}/${m.modelId}`,label:m.displayName ?? m.modelId}))],model => change({model}))}</div>
          <div className="task-setting-row"><span>强度</span>{menu("强度",({low:"轻度",medium:"中",high:"高",xhigh:"极高"} as Record<string,string>)[saved.effort ?? ""] ?? "默认",[{value:"",label:"默认"},{value:"low",label:"轻度"},{value:"medium",label:"中"},{value:"high",label:"高"},{value:"xhigh",label:"极高"},{value:"ultra",label:"Ultra",disabled:true}],effort => change({effort}))}</div>
        </div>}</>}
      </div>
      <footer className="task-draft-footer"><Button variant="secondary" disabled={working} onClick={close}>取消</Button><Button disabled={!!blocked || working || !saved.text.trim() || (direct ? mode === "foreground" && !currentThread : (saved.repeat ?? "每天") === "仅一次" ? !saved.time || !(new Date(saved.time).getTime() > Date.now()) : (saved.repeat ?? "每天") === "间隔" ? !Number.isInteger(Number(saved.interval ?? 30)) || Number(saved.interval ?? 30) < 1 : !/^([01]\d|2[0-3]):[0-5]\d$/.test(saved.time ?? "09:00"))} onClick={() => void (direct ? createDirect() : send())}>创建</Button></footer>
    </DialogContent>
  </Dialog>}
  <Dialog open={discarding} onOpenChange={setDiscarding}><DialogContent className="task-discard-dialog" showCloseButton={false}><DialogTitle>放弃更改？</DialogTitle><DialogDescription>您的更改将不会保存</DialogDescription><footer className="task-draft-footer"><Button variant="secondary" onClick={() => setDiscarding(false)}>继续编辑</Button><Button onClick={() => {if (!saved.pending) localStorage.removeItem(storageKey); onClose();}}>放弃更改</Button></footer></DialogContent></Dialog></>;
}
