import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import type { Action, Data } from "./services.js";
import { TaskRunConversations } from "./TaskRunConversations.js";
import { useI18n } from "./i18n/IntlProvider.js";

export function taskFrequency(seconds?: number) {
  if (!seconds) return "仅一次";
  for (const [size, unit] of [[604800,"周"], [86400,"天"], [3600,"小时"], [60,"分钟"]] as const) {
    if (seconds % size === 0) return `每 ${seconds / size} ${unit}`;
  }
  return `每 ${seconds} 秒`;
}
export function triggerExplanation(decision?: Data) {
  if (decision?.outcome?.kind === "missedWindow") return `已超过允许的延迟，跳过 ${decision.dueCount} 次计划执行。`;
  if (decision?.outcome?.kind === "skippedOverlap") return `前次运行未结束，跳过 ${decision.dueCount} 次计划执行。`;
  if (decision?.outcome?.kind === "admitted" && decision.dueCount > 1) return `已将 ${decision.dueCount} 次待执行计划合并为一次，保留最早计划时间。`;
  return decision?.outcome?.kind === "admitted" ? "已按计划受理本次执行。" : "";
}
function SchedulePreview({ value }: { value?: Data }) {
  const { t } = useI18n();
  if (!value) return null;
  const policy = value.schedule.misfire;
  return <section aria-label={t("operations.schedulePreview")} className="task-plan-summary">
    <p>{t("operations.upcoming")}{value.timeZone}</p>
    <ol>{value.occurrences.map((item: Data) => <li key={item.at}><time dateTime={item.localTime}>{item.localTime.slice(0,16).replace("T"," ")}</time></li>)}</ol>
    <p>{policy.kind === "skip" ? policy.maxLatenessSeconds === 300 ? t("operations.skipFiveMinutes") : t("operations.lateSeconds", { seconds: policy.maxLatenessSeconds }) : t("operations.coalesceMissed")}</p>
    {value.warnings.map((warning: string) => <p key={warning}>{({missingMonthDaySkipped:"不存在的日期已跳过。",dstGapSkipped:"夏令时跳过的当地时间不会执行。",dstFoldEarlier:"重复的当地时间仅在较早时刻执行一次。"} as Record<string,string>)[warning] ?? warning}</p>)}
  </section>;
}
export type TaskConversationRenderer = (project: Data, thread: Data, beforeTurns?: ReactNode, options?: {
  afterTurns?: ReactNode; embedded?: boolean; readOnly?: boolean;
}) => ReactNode;
type DraftLocation = { kind: "project"; projectId: string; cwd?: string } | { kind: "independent"; cwd?: string };
type SavedDraft = { draftId: string; location: DraftLocation; ownerId?: string; threadId?: string; pending?: "start" | "confirm"; failedTurn?: string; text?: string; modelNotice?: "model-unavailable" | "effort-unsupported" };
type DraftAdmission = Pick<SavedDraft, "ownerId" | "location" | "threadId" | "pending" | "modelNotice">;
const starts = new Map<string, Promise<DraftAdmission>>();
function retainedDraft(storageKey: string, fallback: SavedDraft): SavedDraft {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (value?.draftId === fallback.draftId) return value;
  } catch {}
  return fallback;
}
function mergeDraft(storageKey: string, fallback: SavedDraft, patch: Partial<SavedDraft>) {
  const next = { ...retainedDraft(storageKey, fallback), ...patch };
  localStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}

/** Task management owns admission/recovery only. Messages and Composer belong to the normal conversation. */
export function TaskDraft({ projects, initialProjectId, task, action, disabled, onCreated, onClose, onOpenModelSettings, initialText = "", renderConversation, renderResources }: {
  projects: Data[]; initialProjectId?: string; task?: Data; action: Action; disabled: boolean;
  onCreated: (task: Data, projectId: string) => void; onClose: () => void; onOpenModelSettings: () => void; initialText?: string;
  renderConversation: TaskConversationRenderer; renderResources?: (project: Data, thread: Data) => ReactNode;
}) {
  const { t } = useI18n();
  const prefs = useApplicationPreferences();
  const storageKey = task ? `areal-gui:task-edit:${initialProjectId}:${task.id}` : `areal-gui:task-draft:${initialProjectId ?? "global"}`;
  const [saved, setSaved] = useState<SavedDraft>(() => {
    const locationFor = (projectId?: string): DraftLocation => {
      const owner = projects.find(project => project.id === projectId);
      return projectId && !owner?.projectless ? { kind: "project", projectId, cwd: owner?.root } : { kind: "independent", cwd: owner?.root };
    };
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (typeof value?.draftId === "string") {
        const admitted = value.ownerId || value.threadId || value.pending || starts.has(value.draftId);
        const next = { ...value, location: task || admitted ? value.location ?? locationFor(value.ownerId ?? initialProjectId) : { kind: "independent" } };
        if (!task && !admitted) localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      }
    } catch { /* Local drafts are not execution facts. */ }
    const value: SavedDraft = { draftId: crypto.randomUUID(), location: task ? locationFor(initialProjectId) : { kind: "independent" }, ownerId: task ? initialProjectId : undefined, text: initialText };
    localStorage.setItem(storageKey, JSON.stringify(value));
    return value;
  });
  const current = useRef(saved); current.current = saved;
  const inputApi = useRef<LexicalChatInputHandle | null>(null);
  const preparingElement = useRef<HTMLDivElement>(null);
  const focusAfterHandoff = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const deferredView = useRef<{ result: Data; projectId: string } | undefined>(undefined);
  const [view, setView] = useState<Data>();
  const currentView = useRef(view); currentView.current = view;
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [restoredConnection, setRestoredConnection] = useState<string>();
  const [opening, setOpening] = useState(false), [saving, setSaving] = useState(false);
  const [startRequested, setStartRequested] = useState(true);
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ onCreated }); callbacks.current = { onCreated };
  const notified = useRef("");
  const project = projects.find(p => p.id === saved.ownerId);
  const connectionKey = project?.state?.connected && saved.threadId
    ? `${project.id}:${saved.threadId}:${project.core?.connectionGeneration ?? 0}` : undefined;
  const persist = (patch: Partial<SavedDraft>) => {
    const next = mergeDraft(storageKey, current.current, patch);
    current.current = next; setSaved(next);
  };
  const showView = (result: Data, projectId: string) => {
    if (!task && !currentView.current?.thread && result.thread && current.current.text !== undefined) {
      if (composing.current) { deferredView.current = { result, projectId }; return; }
      const latest = retainedDraft(storageKey, current.current);
      const text = latest.text ?? "";
      const inputKey = `areal-gui:draft:${projectId}:${result.thread.id}`;
      const retained = localStorage.getItem(inputKey);
      if (retained == null) localStorage.setItem(inputKey, text);
      if (preparingElement.current?.contains(document.activeElement)) focusAfterHandoff.current = inputKey;
      persist({ text: retained == null || retained === text || !text ? undefined : text });
    }
    deferredView.current = undefined;
    currentView.current = result; setView(result);
  };
  useEffect(() => {
    const key = focusAfterHandoff.current;
    if (!view?.thread || !key) return;
    focusAfterHandoff.current = undefined;
    const frame = requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key })));
    return () => cancelAnimationFrame(frame);
  }, [view?.thread?.id]);
  useEffect(() => {
    if (!startRequested || disabled || saved.threadId || saved.pending) return;
    const retained = retainedDraft(storageKey, current.current);
    if (retained?.threadId || retained?.pending) {
      current.current = retained; setSaved(retained); setOpening(false); setStartRequested(false); return;
    }
    let live = true;
    setOpening(true); setError("");
    const draft = current.current;
    let start = starts.get(draft.draftId);
    if (!start) {
      start = (async () => {
        let prepared = retainedDraft(storageKey, draft);
        if (!draft.ownerId && draft.location.kind === "project") {
          const location = draft.location;
          prepared = mergeDraft(storageKey, draft, { ownerId: location.projectId,
            location: { ...location, cwd: location.cwd ?? projects.find(project => project.id === location.projectId)?.root } });
        } else if (!draft.ownerId) {
          const result = await action("projectless", { operation: "prepare", requestId: draft.draftId,
            ...(draft.location.cwd ? { directory: draft.location.cwd } : {}) });
          prepared = mergeDraft(storageKey, draft, { ownerId: result.projectId,
            location: { ...draft.location, cwd: result.cwd ?? draft.location.cwd } });
        }
        const projectId = prepared.ownerId!;
        let result;
        try { result = await action("manage", { projectId, operation: "taskDraftStart", draftId: draft.draftId,
          timeZone: task?.scheduleV2?.rule?.timeZone ?? task?.schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(prepared.location.cwd ? { cwd: prepared.location.cwd } : {}), ...(task ? { taskId: task.id } : {}) }); }
        catch (cause) {
          if ((cause as Error & { submissionUnknown?: boolean }).submissionUnknown) mergeDraft(storageKey, draft, { pending: "start" });
          throw cause;
        }
        const next: DraftAdmission = { ownerId: projectId, location: prepared.location,
          threadId: result.threadId, pending: undefined, modelNotice: result.modelNotice };
        mergeDraft(storageKey, draft, next);
        return next;
      })();
      starts.set(draft.draftId, start);
    }
    void start.then(result => { if (live) persist(result); })
      .catch(cause => {
        starts.delete(draft.draftId);
        if (live) { setError(cause.message); const latest = retainedDraft(storageKey, current.current); current.current = latest; setSaved(latest); setStartRequested(false); }
      }).finally(() => { starts.delete(draft.draftId); if (live) setOpening(false); });
    return () => { live = false; };
  }, [action, disabled, saved.threadId, saved.pending, startRequested, retry]);
  useEffect(() => {
    if (!saved.threadId || !project?.state?.connected) return;
    let live = true, reading = false, restored = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        if (!restored) {
          await action("open", { projectId: project.id, threadId: saved.threadId });
          if (!live) return;
          restored = true; setRestoredConnection(connectionKey);
        }
        let result = await action("manage", { projectId: project.id, operation: "taskDraftRead", threadId: saved.threadId });
        if (!live) return;
        setReadError(""); showView(result, project.id);
        if (result.thread?.cwd && current.current.location.cwd !== result.thread.cwd) persist({ location: { ...current.current.location, cwd: result.thread.cwd } });
        if (current.current.failedTurn && current.current.failedTurn !== result.turnId) setError("");
        // Read-only recovery never replays an unknown or failed save.
        if (result.proposal && !result.running && !result.error && !current.current.pending && current.current.failedTurn !== result.turnId && !disabled) {
          setSaving(true); persist({ pending: "confirm" });
          try {
            await action("manage", { projectId: project.id, operation: "taskDraftConfirm", threadId: saved.threadId,
              turnId: result.turnId, digest: result.digest });
            const next = await action("manage", { projectId: project.id, operation: "taskDraftRead", threadId: saved.threadId });
            if (!live) return;
            result = next; persist({ pending: undefined, failedTurn: undefined }); setError(""); showView(result, project.id);
          } catch (cause) {
            if (!live) return;
            const failure = cause as Error & { submissionUnknown?: boolean };
            persist({ pending: failure.submissionUnknown ? "confirm" : undefined, failedTurn: result.turnId }); setError(failure.message);
          } finally { if (live) setSaving(false); }
        }
        if (result.task) {
          setSaving(false);
          if (current.current.pending === "confirm") persist({ pending: undefined });
          const stamp = `${result.task.id}:${result.task.revision}`;
          if (notified.current !== stamp) {
            notified.current = stamp;
            if (!task) localStorage.removeItem(storageKey);
            callbacks.current.onCreated(result.task, project.id);
          }
        }
      } catch (cause) { if (live) setReadError((cause as Error).message); }
      finally { reading = false; }
    };
    void read(); const timer = window.setInterval(() => void read(), 1000);
    return () => { live = false; clearInterval(timer); };
  }, [action, saved.threadId, project?.id, project?.state?.connected, connectionKey, disabled, retry]);
  const thread = view?.thread;
  const preparingInput = !task && !thread && saved.text !== undefined;
  const credentialUnavailable = !saved.threadId && !saved.pending && /^(?:MODEL_)?CREDENTIAL_UNAVAILABLE(?::|$)/.test(error);
  const empty = thread && !thread.turns?.length;
  const welcome = <div className="task-create-welcome"><CalendarClock size={36}/><h2>让 Agent 定时帮你完成任务</h2><p>告诉我需要做什么、什么时候执行。</p><div className="task-examples">{[
    ["行业动态日报", "每天上午 9 点，整理 AI 行业动态并附上原始来源。"],
    ["跟踪产品更新", "每周一上午 9 点，汇总我指定产品的新变化并附上来源。"],
  ].map(([title, text]) => <button key={title} onClick={() => {
    if (project && thread) {
      const key = `areal-gui:draft:${project.id}:${thread.id}`;
      localStorage.setItem(key, text); window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    } else { persist({ text }); inputApi.current?.setText(text); inputApi.current?.focus(); }
  }}><h3>{title}</h3><p>{text}</p></button>)}</div></div>;
  // Keep all message/history/attachment rendering in the existing components.
  const owner = project && { ...project, state: { ...project.state, connected: project.state?.connected && restoredConnection === connectionKey && !disabled && !saving && !task?.cancelled && !readError && !current.current.pending } };
  return <main className="task-conversation" aria-label={task ? "定时任务会话" : "新建定时任务"}>
    <header><h2>{task?.objective ?? "新建任务"}</h2>{task && project && thread && renderResources?.(project, thread)}
      <Button size="icon-sm" variant="ghost" aria-label={task ? "关闭任务详情" : "关闭创建对话"} onClick={onClose}><X size={16}/></Button></header>
    {(error || readError || view?.error) && <p role="alert" className="task-plan-note task-draft-error">{credentialUnavailable ? <>模型凭据不可用。请在模型设置中补充 API Key 并保存，或选择可用的新会话默认模型。完成后重试，或从“定时任务”重新打开“新建任务”。<Button variant="ghost" onClick={onOpenModelSettings}>打开模型设置</Button></> : error || readError || view?.error}</p>}
    {saved.modelNotice && <p role="status" className="task-plan-note">{saved.modelNotice === "model-unavailable" ? t("chat.composer.previousModelUnavailable") : t("chat.composer.previousEffortUnsupported")}</p>}
    {saved.pending && <p role="status" className="task-plan-note">{saving ? "正在保存任务安排…" : "提交结果尚未确认，请核对当前任务；不会自动重复提交。"}{!saving && <Button variant="ghost" disabled={!project?.state?.connected} onClick={() => {void action("reconcile", {projectId: project!.id}).then(result => {if (saved.pending === "start" && result.outcomes?.[saved.draftId]?.accepted) {persist({pending:undefined});setStartRequested(true);setRetry(n => n + 1);}}).catch(cause => setError(cause.message));}}>核对受理状态</Button>}</p>}
    {!thread && !preparingInput && <div className="task-conversation-pending">
      <div role="status">{opening || startRequested && !disabled && !saved.threadId && !saved.pending ? "正在打开会话…" : task || saved.threadId || saved.pending ? "正在读取会话…" : error ? "会话打开失败，请重试。" : "等待连接后台…"}{!saved.pending && !opening && (error || saved.threadId) && <Button variant="ghost" disabled={disabled} onClick={() => {setStartRequested(true);setRetry(n => n + 1);}}>{saved.threadId ? "重新读取" : "重试"}</Button>}</div>
    </div>}
    {preparingInput && <div className="task-conversation-body"><section className="task-chat-pane">
      <div className="flex-1 overflow-auto">{welcome}{!opening && (!startRequested || disabled || saved.pending) && <p role="status" className="task-plan-note">输入已保留，会话就绪后即可发送。{!saved.pending && (error || saved.threadId) && <Button variant="ghost" disabled={disabled} onClick={() => { setStartRequested(true); setRetry(n => n + 1); }}>重试</Button>}</p>}</div>
      <div ref={preparingElement} className="composer-dock" data-v4-composer-dock="true"
        onCompositionStartCapture={() => { composing.current = true; }}
        onCompositionEnd={() => {
          queueMicrotask(function handoffCommittedComposition() { composing.current = false; const pending = deferredView.current; if (pending) showView(pending.result, pending.projectId); });
        }}>
        <ChatPromptEditor shellClassName="@container/composer" workspacePath="" taskId={null}
          inputApiRef={inputApi} initialValue={saved.text} inputTestId="chat-input" submitTestId="chat-send-button"
          placeholder="描述任务和执行时间" disabled={false} submitDisabled submitLabel="发送"
          enterSubmits={prefs.sendShortcut === "enter"} enableMentionPanel={false}
          onChange={text => persist({ text })} onSubmit={() => false} />
      </div>
    </section></div>}
    {!task && project && thread && saved.text !== undefined && <p role="status" className="task-plan-note">会话中已有另一份草稿，准备期间的输入已另行保留。<Button variant="ghost" onClick={() => {
      const key = `areal-gui:draft:${project.id}:${thread.id}`;
      localStorage.setItem(key, retainedDraft(storageKey, current.current).text ?? ""); persist({ text: undefined });
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    }}>用保留输入替换会话草稿</Button></p>}
    {owner && thread && <div className="task-conversation-body"><section className="task-chat-pane">{renderConversation(owner, thread, empty ? welcome : undefined, { afterTurns: <><SchedulePreview value={view?.preview} />{task?.lastTriggerDecision && <p role="status" className="task-plan-note">{triggerExplanation(task.lastTriggerDecision)}</p>}{task && project && <TaskRunConversations project={project} task={task} action={action} disabled={disabled} renderConversation={renderConversation} />}</> })}</section>
    </div>}
  </main>;
}
