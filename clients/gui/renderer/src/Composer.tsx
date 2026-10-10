import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { shouldSteer } from "./settings/applicationSettings.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import { canExecutePlan, permissionMode, permissionOptions, planModeOptions } from "./permissions.js";
import { ComposerPlanMode } from "./ComposerPlanMode.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { Button } from "./components/ui/button.js";
import { ComposerQueue } from "./ComposerQueue.js";
import { useComposerQueueEdit } from "./useComposerQueueEdit.js";
import { ComposerQueueAttachment } from "./ComposerQueueAttachment.js";
import { AskUserQuestion } from "./AskUserQuestion.js";
import { ApprovalRequest } from "./ApprovalRequest.js";
import { GoalCard, goalControlError } from "./Goal.js";
import { goalContinuationLabel } from "./conversationPresentation.js";
import { GoalIcon as Target, PlanModeIcon as Lightbulb } from "./interfaceIcons.js";
import { FileTree, ArchiveChatIcon, SendMessageIcon, StopIcon } from "./interfaceIcons.js";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import { ComposerAttachment, composerPaste } from "./ComposerAttachments.js";
import { useComposerSkills, composerSkillContent, readComposerSkills } from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { ComposerMcp } from "./ComposerMcp.js";
import { AttachmentIcon } from "./interfaceIcons.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
import { attachedReviewComments, consumeReviewComments, detachReviewComments, recordUnknownReviewSubmission, reconcileReviewSubmission, readReviewComments, reviewCommentKey, reviewCommentText, useReviewComments } from "./reviewComments.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Data, Action } from "./services.js";
// Draft attachments and in-flight UI admission survive task navigation. These are
// unsent client inputs only; Core remains authoritative for acceptance/outcomes.
export const attachmentDrafts = new Map<string, File[]>();
export const attachmentErrors = new Map<string, string>();
export const sending = new Set<string>();
const sendListeners = new Set<() => void>();
export const subscribeSending = (listener: () => void) => {
  sendListeners.add(listener);
  return () => {
    sendListeners.delete(listener);
  };
};
export const markSending = (key: string, active: boolean) => {
  if (active) sending.add(key);
  else sending.delete(key);
  sendListeners.forEach((listener) => listener());
};
export function Composer({
  project,
  thread,
  action,
  readAction = action,
  onPanel,
  onNew,
  onOpenTask,
}: {
  project: Data;
  thread: Data;
  action: Action;
  readAction?: Action;
  onPanel: (name: string) => void;
  onNew: () => void;
  onOpenTask?: (target: { projectId: string; taskId: string; runId: string }) => void;
}) {
  const prefs = useApplicationPreferences();
  const key = `areal-gui:draft:${project.id}:${thread.id}`;
  const reviewKey = reviewCommentKey(project.id, thread.id);
  const reviewDraft = useReviewComments(reviewKey);
  const comments = attachedReviewComments(reviewDraft.draft);
  const api = useRef<LexicalChatInputHandle | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  const [goalMode, setGoalMode] = useState(() => localStorage.getItem(`${key}:goal`) === "true");
  const [goalError, setGoalError] = useState("");
  const creatingGoal = goalMode && !thread.goals?.goal;
  const changeGoalMode = (enabled: boolean) => {
    setGoalMode(enabled); setGoalError("");
    if (enabled) localStorage.setItem(`${key}:goal`, "true");
    else localStorage.removeItem(`${key}:goal`);
    api.current?.focus();
  };
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const [files, setFiles] = useState<File[]>(() => attachmentDrafts.get(key) ?? []);
  const [admissionError, setAdmissionError] = useState(() => attachmentErrors.get(key) ?? "");
  useEffect(() => {
    attachmentDrafts.set(key, files);
  }, [key, files]);
  useEffect(() => {
    if (admissionError) attachmentErrors.set(key, admissionError);
    else attachmentErrors.delete(key);
  }, [key, admissionError]);
  const [unknown, setUnknown] = useState<string | null>(() =>
    localStorage.getItem(`${key}:pending`),
  );
  const [deliveryError, setDeliveryError] = useState("");
  const [returnError, setReturnError] = useState("");
  const [returning, setReturning] = useState(false);
  const running = thread.turns?.find((t: Data) => t.status === "inProgress");
  const pending = project.pending.some((p: Data) => p.params?.threadId === thread.id);
  const archived = thread.desktop?.archived;
  const questions = (project.state?.interactions?.[thread.id]?.data ?? [])
    .filter((item: Data) => item.status === "pending" && item.kind !== "approval" && !archived);
  const hadQuestion = useRef(false);
  useEffect(() => {
    if (hadQuestion.current && !questions.length) api.current?.focus();
    hadQuestion.current = questions.length > 0;
  }, [questions.length]);
  const baseDisabled = !project.state?.connected || archived || busy || pending || !!unknown || !!reviewDraft.error;
  const queueEditor = useComposerQueueEdit({ project, threadId: thread.id, draftKey: key, action, readAction, api, draftFiles: attachmentDrafts,
    setText, setFiles, setGoalMode, inFlight: busy, setInFlight: active => markSending(key, active), uploadFiles: selected => uploadComposerFiles(action, project.id, thread.id, selected) });
  const disabled = baseDisabled || queueEditor.busy || queueEditor.locked;
  const stop = () => { void action("stop", { projectId: project.id, threadId: thread.id }).catch(() => {}); };
  const config = project.configurations?.[thread.id];
  const [mcpOpen, setMcpOpen] = useState(false);

  const skills = useComposerSkills({ project, threadId: thread.id, draftKey: key, action: readAction, disabled });
  const planActive = permissionMode(config ?? {}) === "plan";
  const executionPermission = planActive ? permissionMode({ ...config, readOnly: false, options: planModeOptions(false, config?.options) }) : permissionMode(config ?? {});
  const planReady = canExecutePlan(config ?? {}, thread, project.state?.queues?.[thread.id]);
  const clear = () => {
    api.current?.clear();
    setText("");
    setFiles([]);
    skills.clear();
    attachmentDrafts.delete(key);
    setAdmissionError("");
    localStorage.removeItem(key);
  };
  useEffect(() => { setGoalError(""); }, [key]);
  useEffect(() => {
    setUnknown(localStorage.getItem(`${key}:pending`));
    setGoalMode(localStorage.getItem(`${key}:goal`) === "true");
    if (!busy) {
      const draft = localStorage.getItem(key) ?? "";
      if (api.current && api.current.getMarkdown() !== draft) api.current.setText(draft);
      setText(draft);
      setFiles(attachmentDrafts.get(key) ?? []);
      setAdmissionError(attachmentErrors.get(key) ?? "");
    }
  }, [key, busy]);
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key || sending.has(key)) return;
      const draft = localStorage.getItem(key) ?? "";
      api.current?.setText(draft); setText(draft); api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  useEffect(() => {
    if (!unknown || pending) return;
    const outcome = project.outcomes?.[unknown];
    if (!outcome) return;
    localStorage.removeItem(`${key}:pending`);
    setUnknown(null);
    reconcileReviewSubmission(reviewKey, unknown, outcome.accepted !== false);
    const wasGoal = localStorage.getItem(`${key}:pending-goal`) === unknown;
    localStorage.removeItem(`${key}:pending-goal`);
    if (outcome.accepted === false) setDeliveryError(outcome.message || "原轮次已结束，内容已保留，请检查后发送。");
    else if (wasGoal) {
      api.current?.clear(); setText(""); localStorage.removeItem(key); changeGoalMode(false);
    } else clear();
  }, [unknown, pending, project.outcomes]);
  useEffect(() => {
    if (thread.goals?.goal && goalMode) changeGoalMode(false);
  }, [thread.goals?.goal?.id]);
  const submit = async (value: string, invert = false, approvePlan = false) => {
    if (queueEditor.edit) { await queueEditor.save(); return; }
    if (disabled || sending.has(key) || (!value.trim() && !files.length && !comments.length && !skills.selected.length)) return;
    if (approvePlan && (!planReady || text.trim() || files.length || comments.length)) return;
    if (creatingGoal && (running || thread.parentThreadId || !value.trim())) return;
    setAdmissionError("");
    markSending(key, true);
    setGoalError("");
    setDeliveryError("");
    try {
      if (creatingGoal) {
        await action("manage", { projectId: project.id, threadId: thread.id, operation: "goalCreate",
          expectedRevision: thread.goals?.revision ?? 0, objective: value, inferLimits: true });
        // Goal consumes only its objective; attachments and comments remain unsent.
        api.current?.clear(); setText(""); localStorage.removeItem(key);
        changeGoalMode(false);
        return;
      }
      if (approvePlan) await action("configure", { projectId: project.id, threadId: thread.id, expectedRevision: config?.revision, options: permissionOptions("auto", config?.options) });
      await submitMessage(action, project.id, thread.id, value, files, {
        steer: !!running && shouldSteer(prefs.followUp, invert),
        expectedTurnId: running?.id,
        enqueue: !!running,
        skillAction: readAction,
      });
      clear();
    } catch (e) {
      const error = e as Error & {
        submissionUnknown?: boolean;
        requestId?: string;
      };
      if (creatingGoal) setGoalError(goalControlError(error));
      else if (!(error.submissionUnknown && error.requestId)) {
        // 附件失败留在所属 Composer，切换任务后仍能看到；没有附件的未受理发送/steer 单独显示投递原因。
        if (files.length > 0) setAdmissionError(error.message);
        else if (!error.submissionUnknown) setDeliveryError(error.message || "发送未受理，输入已保留。");
        else setAdmissionError(error.message);
      }
      if (error.submissionUnknown && error.requestId) {
        if (creatingGoal) localStorage.setItem(`${key}:pending-goal`, error.requestId);
        setUnknown(error.requestId);
        localStorage.setItem(`${key}:pending`, error.requestId);
      }
    } finally {
      markSending(key, false);
    }
  };
  const configure = async (values: Data) => {
    if (queueEditor.edit) return;
    if (disabled || running || sending.has(key)) return;
    markSending(key, true);
    try {
      await action("configure", { projectId: project.id, threadId: thread.id, expectedRevision: config?.revision, ...values });
    } catch (cause) { setAdmissionError((cause as Error).message); } finally { markSending(key, false); }
  };
  const catalogActions: ComposerCatalogEntry[] = [
    { value: "upload", label: "上传文件", description: "添加图片、文档或其他文件", icon: <AttachmentIcon />, group: "功能", run: () => upload.current?.click() },
    { value: "mcp", label: "MCP", description: "查看服务器与连接状态", icon: <ComposerMcpIcon />, group: "功能", run: () => setMcpOpen(true) },
    { value: "files", label: "工作区文件", description: "引用当前项目中的文件", icon: <FileTree />, group: "功能", run: () => onPanel("文件") },
    { value: "plan", label: "计划模式", description: planActive ? "关闭计划模式" : "先规划，再开始执行", icon: <Lightbulb />, group: "功能", disabled: disabled || !!running || !config || config.profile?.readOnly === true, run: () => { void configure({ options: planModeOptions(!planActive, config?.options) }); } },
    ...(!thread.goals?.goal ? [{ value: "goal", label: "设置目标", description: creatingGoal ? "关闭目标模式" : "设置持续目标与停止条件", icon: <Target />, group: "功能" as const, disabled: disabled || !!running || !!thread.parentThreadId, run: () => changeGoalMode(!goalMode) }] : []),
    { value: "compact", label: "压缩", description: "压缩当前上下文", icon: <ArchiveChatIcon />, group: "功能", disabled: !!running, run: () => { void action("manage", { projectId: project.id, threadId: thread.id, operation: "contextCompact" }).catch(() => {}); } },
  ];
  // TaskRun owns this worker's lifetime; its history is readable, but it is
  // not an independent conversation that can accept another user turn.
  const returnToRun = async () => {
    if (returning) return;
    setReturning(true); setReturnError("");
    try {
      const listed = await action("tasks", { operation: "list", limit: 1024 });
      const task = (listed.data ?? []).find((row: Data) => row.projectId === project.id && row.runs?.some((run: Data) => run.workers?.some((worker: Data) => worker.threadId === thread.id)));
      const run = task?.runs?.find((item: Data) => item.workers?.some((worker: Data) => worker.threadId === thread.id));
      if (!task || !run || !onOpenTask) throw new Error("找不到此 worker 所属的原运行。");
      onOpenTask({ projectId: project.id, taskId: task.id, runId: run.id });
    } catch (cause) { setReturnError((cause as Error).message); }
    finally { setReturning(false); }
  };
  if (thread.source === "nativeTaskAgent" && thread.goalOwner) return <div className="composer-dock" data-v4-composer-dock="true"><p role="status" className="px-3 pt-3 text-ui-sm text-foreground-subtle">此 worker 由原 TaskRun 管理。打开历史不会重新执行已结束的工作。</p>{returnError && <p role="alert" className="px-3 text-ui-sm">{returnError}</p>}<div className="px-3 py-3"><Button size="sm" variant="outline" disabled={returning} onClick={() => void returnToRun()}>{returning ? "正在返回…" : "返回原运行"}</Button></div></div>;
  return (
    <div className="composer-dock" data-v4-composer-dock="true">
      <GoalCard project={project} thread={thread} action={action} onEdit={() => onPanel("编辑目标")} />
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const selectedFiles = Array.from(e.currentTarget.files ?? []);
          setFiles((f) => [...f, ...selectedFiles]);
          e.currentTarget.value = "";
        }}
      />
      {deliveryError && <p role="alert" className="notice">{deliveryError}</p>}
      {unknown && (
        <div role="status" className="notice">
          提交结果尚未确认。草稿已保留，等待 Core 对账；不会自动重发。
          <button
            onClick={() => void action("reconcile", { projectId: project.id }).catch(() => {})}
          >
            刷新受理状态
          </button>
        </div>
      )}
      {planReady && !queueEditor.edit && <section className="flex items-center justify-between gap-3 px-3 py-2 text-ui-sm" aria-label="计划确认">
        <span className="text-foreground-subtle">计划已完成。批准后将以自动编辑模式执行。</span>
        <Button size="sm" disabled={disabled || !!text.trim() || !!files.length || !!comments.length} onClick={() => void submit("按上方已确认的计划执行。", false, true)}>批准并执行</Button>
      </section>}
      <div className="composer-input-stack">
      <div ref={setMenuAnchor} className="composer-menu-anchor" />
      <ComposerQueue
        key={key}
        project={project}
        thread={thread}
        action={action}
        disabled={baseDisabled || queueEditor.busy}
        editingId={queueEditor.edit?.id}
        onEdit={item => void queueEditor.begin(item)}
      />
      {/* Pending decisions stay reachable outside the scrolling transcript. */}
      {(project.state?.interactions?.[thread.id]?.data ?? [])
        .filter((item: Data) => item.status === "pending" && item.kind === "approval" && !archived)
        .map((item: Data) => <ApprovalRequest key={item.requestId} item={item} projectId={project.id} action={action} />)}
      {questions.map((item: Data) => <AskUserQuestion key={item.requestId} item={item} projectId={project.id} action={action}
        onStop={running ? stop : undefined} stopDisabled={!project.state?.connected || pending} />)}
      {goalError && <p role="alert" className="notice text-destructive">{goalError}</p>}
      {admissionError && <p role="alert" className="notice text-destructive">{admissionError}</p>}
      {reviewDraft.error && <p role="alert" className="notice">{reviewDraft.error}</p>}
      {thread.desktop?.workflowRun && <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-ui-sm text-foreground-subtle">
        <Button type="button" size="sm" variant="ghost" onClick={() => {
          const storageKey = `areal-gui:workgroup:${project.id}`;
          localStorage.setItem(storageKey, thread.desktop.workflowRun.workgroupId);
          document.dispatchEvent(new CustomEvent("areal:workgroup-operation", { detail: storageKey }));
          onPanel("工作组");
        }}>查看关联工作流结果</Button>
      </div>}
      <ChatPromptEditor
        triggerPanelContainer={menuAnchor}
        className={questions.length && !queueEditor.edit ? "hidden" : undefined}
        shellClassName="@container/composer"
        workspacePath={project.root}
        taskId={thread.id}
        initialValue={text}
        inputApiRef={api}
        inputTestId="chat-input"
        submitTestId="chat-send-button"
        placeholder={archived ? "已归档任务只读" : creatingGoal ? "描述目标，明确可衡量的结果" : planActive ? "描述任务，生成计划…" : "随心输入"}
        disabled={disabled}
        submitDisabled={disabled || (queueEditor.edit ? queueEditor.saveDisabled || (!text.trim() && !files.length && !queueEditor.edit.attachments.length) : creatingGoal ? !text.trim() || !!running : !text.trim() && !files.length && !comments.length && !skills.selected.length)}
        submitting={busy}
        submitLabel={queueEditor.edit ? "保存排队消息" : creatingGoal ? "开始目标" : "发送"}
        enterSubmits={prefs.sendShortcut === "enter"}
        enableMentionPanel={false}
        composerCatalog={{ ...skills.catalog, entries: [...catalogActions, ...skills.catalog.entries].map(entry => ({ ...entry, disabled: entry.disabled || (!!queueEditor.edit && !["upload", "files", "mcp"].includes(entry.value)) })) }}
        onChange={(value) => {
          setText(value);
          localStorage.setItem(key, value);
        }}
        onSubmit={(value) => {
          void submit(value);
          return false;
        }}
        onModifiedSubmit={prefs.sendShortcut === "enter" ? (value) => {
          void submit(value, !!running);
          return false;
        } : undefined}
        onPaste={event => composerPaste(event, pasted => setFiles(current => [...current, ...pasted]))}
        topContent={
          <>{queueEditor.edit && <div className="composer-queue-edit-banner" aria-label="编辑排队消息">
            <span>{queueEditor.edit.phase === "opening" ? "等待确认暂停队列" : "编辑排队消息"}</span>
            <Button type="button" size="sm" variant="ghost" disabled={queueEditor.busy || !!queueEditor.edit.unknown || pending} onClick={() => void queueEditor.cancel()}>取消</Button>
            <Button type="button" size="sm" disabled={queueEditor.saveDisabled || (!text.trim() && !files.length && !queueEditor.edit.attachments.length)} onClick={() => void queueEditor.save()}>保存</Button>
          </div>}
          {queueEditor.feedback && <p role="alert" className="composer-queue-feedback">{queueEditor.feedback}</p>}
          {queueEditor.edit?.unknown && <Button type="button" size="sm" disabled={queueEditor.busy || !project.state?.connected} onClick={() => void queueEditor.reconcile()}>核对编辑操作</Button>}
          {!queueEditor.edit && <>{skills.tags}<ReviewCommentAttachment comments={comments} disabled={disabled} onRemove={() => detachReviewComments(reviewKey)} /></>}
          {!!queueEditor.edit?.attachments.length && <div className="composer-attachments">
            {queueEditor.edit.attachments.map((part, index) => <ComposerQueueAttachment key={`${index}:${part.url}`} part={part} projectId={project.id} threadId={thread.id} action={readAction} disabled={disabled}
              onRemove={() => queueEditor.removeAttachment(index)} />)}
          </div>}
          {files.length ? (
            <div className="composer-attachments" data-testid="composer-attachments">
              {files.map((file, i) => <ComposerAttachment disabled={disabled} key={`${file.name}-${file.lastModified}-${i}`} file={file}
                onRemove={() => setFiles((current) => current.filter((_, at) => at !== i))}
                onExpand={content => { api.current?.appendText(`${text.trim() ? "\n\n" : ""}${content}`); setFiles(current => current.filter(item => item !== file)); }} />)}
            </div>
          ) : null}</>
        }
        promptHistory={(thread.turns ?? []).flatMap((t: Data) =>
          (t.items ?? [])
            .filter((i: Data) => i.type === "userMessage" && !(goalContinuationLabel(t) && i.id === t.items.find((entry: Data) => entry.type === "userMessage")?.id))
            .map((i: Data) =>
              (i.content ?? [])
                .filter((p: Data) => p.type === "text")
                .map((p: Data) => p.text)
                .join("\n"),
            ),
        )}
        leadingActions={
          <><ComposerPermissionMenu value={executionPermission}
            disabled={disabled || !!queueEditor.edit || !!running || !config} lockedReadOnly={config?.profile?.readOnly === true}
            onClose={() => api.current?.focus()}
            onChange={mode => configure({ options: planModeOptions(planActive, permissionOptions(mode, config?.options)) })} />
          {planActive && <ComposerPlanMode disabled={disabled || !!queueEditor.edit || !!running || config?.profile?.readOnly === true}
            onExit={() => { void configure({ options: planModeOptions(false, config?.options) }); }} />}
          {creatingGoal && <div className="flex shrink-0 items-center gap-1">
            <span className="h-4 border-l border-border" aria-hidden="true" />
            <ControlHintTooltip title="退出目标模式">
              <Button type="button" variant="ghost" className="gap-1 rounded-full px-2 text-ui-caption text-foreground-subtle"
                aria-label="退出目标模式" disabled={disabled || !!queueEditor.edit} onClick={() => changeGoalMode(false)}>
                <Target className="size-4" /><span>目标</span>
              </Button>
            </ControlHintTooltip>
          </div>}</>
        }
        onCancel={queueEditor.edit ? () => void queueEditor.cancel() : running ? stop : undefined}
        submitControl={queueEditor.edit ? <Button type="button" size="icon-md" aria-label="保存排队消息" data-testid="chat-send-button" disabled={disabled || queueEditor.saveDisabled || (!text.trim() && !files.length && !queueEditor.edit.attachments.length)}
          className="composer-primary-action" onClick={() => void queueEditor.save()}><SendMessageIcon className="size-5" /></Button> : running && !text.trim() && !files.length && !comments.length && !skills.selected.length ? (
          <ControlHintTooltip title="停止" shortcut="Esc">
            <Button type="button" variant="secondary" size="icon-md" className="composer-primary-action composer-stop-action" aria-label="停止"
              onClick={() => { stop(); api.current?.focus(); }}>
              <StopIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        ) : running ? (
          <ControlHintTooltip title="发送" shortcut={prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"}>
            <Button type="button" size="icon-md" aria-label="发送" data-testid="chat-send-button"
              disabled={disabled || (!text.trim() && !files.length && !comments.length && !skills.selected.length)}
              className="composer-primary-action bg-foreground text-background hover:bg-foreground/90 disabled:bg-secondary disabled:text-foreground-subtlest disabled:opacity-100"
              onClick={event => void submit(api.current?.getMarkdown() ?? text, event.metaKey || event.ctrlKey)}>
              <SendMessageIcon className="size-5" />
            </Button>
          </ControlHintTooltip>
        ) : undefined}
        betweenCancelAndSubmitAction={<ComposerModelMenu
          value={config?.model ? `${config.model.providerId}/${config.model.modelId}` : ""}
          disabled={disabled || !!queueEditor.edit || !!running}
          effort={config?.parameters?.reasoningEffort ?? ""}
          onEffortChange={value => { void configure({ parameters: { ...config?.parameters, reasoningEffort: value } }); }}
          options={[...(project.models.some((model: Data) => !model.providerId) ? [{ value: "", label: "默认模型", efforts: project.models.find((model: Data) => !model.providerId)?.reasoningEffortOptions }] : []), ...project.models
            .filter((model: Data) => model.providerId)
            .map(composerModelOption)]}
          onChange={value => {
            if (!value) { void configure({ model: null }); return; }
            const model = project.models.find((item: Data) => `${item.providerId}/${item.modelId}` === value);
            if (model) void configure({ model: { providerId: model.providerId, modelId: model.modelId } });
          }}
          onClose={() => api.current?.focus()}
          onConfigure={() => onPanel("设置")}
        />}
      />
      </div>
      <ComposerMcp projectId={project.id} action={readAction} open={mcpOpen} anchor={menuAnchor} onClose={() => { setMcpOpen(false); api.current?.focus(); }} />
      <div className="composer-caption sr-only">
        {prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"} 发送 · Shift+Enter 换行 · / 命令
      </div>
    </div>
  );
}

// Both the first message and later turns use the same attachment and admission path.
export async function submitMessage(
  action: Action,
  projectId: string,
  threadId: string,
  text: string,
  files: File[],
  options: Data = {},
) {
  const reviewKey = reviewCommentKey(projectId, threadId);
  const comments = attachedReviewComments(readReviewComments(reviewKey));
  const skillContent = await composerSkillContent(options.skillAction ?? action, projectId, threadId, readComposerSkills(`areal-gui:draft:${projectId}:${threadId}`));
  const feedback = [comments.map(reviewCommentText).join("\n\n"), skillContent].filter(Boolean).join("\n\n");
  const attachments = await uploadComposerFiles(action, projectId, threadId, files);
  try {
    await action(options.steer ? "steer" : "send", {
        projectId,
        threadId,
        text: feedback ? (text ? `${text}\n\n${feedback}` : feedback) : text,
        attachments,
        expectedTurnId: options.expectedTurnId,
        enqueue: options.enqueue === true,
      });
  } catch (cause) {
    const error = cause as Error & { submissionUnknown?: boolean; requestId?: string };
    if (error.submissionUnknown && error.requestId && comments.length) {
      try { recordUnknownReviewSubmission(reviewKey, error.requestId, comments); }
      catch { error.message += " 评论提交记录无法保存，原评论已保留。"; }
    }
    throw cause;
  }
  // Only explicit acceptance consumes the captured records. Unknown submissions
  // retain their exact IDs until the existing Core receipt is reconciled.
  consumeReviewComments(reviewKey, comments);
}
export function stageThreadDraft(projectId: string, threadId: string, text: string, files: File[]) {
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  localStorage.setItem(key, text);
  attachmentDrafts.set(key, files);
  return key;
}

// 发送和队列更新共用上传边界，编辑中现存 Core 引用不经过此函数。
export async function uploadComposerFiles(action: Action, projectId: string, threadId: string, files: File[]) {
  const attachments = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`无法读取附件 ${file.name}：${reason}`);
    }
    const media = await action("media", {
      projectId,
      threadId,
      operation: "upload",
      mime: file.type || "application/octet-stream",
      bytes,
    });
    attachments.push({
      type: file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("audio/")
          ? "audio"
          : "file",
      url: media.uri,
      name: file.name,
      mimeType: media.mimeType,
    });
  }
  return attachments;
}
