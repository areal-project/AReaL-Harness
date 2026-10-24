import { ComposerActionButton } from "@areal/ui/wip";
import { parseMentionMarkdown } from "./mentions/mentionMarkdown.js";
import { stopConversationTurn, releaseSettledStops } from "./conversationStop.js";
import { ConversationSelectionReferences } from "./ConversationSelectionReferences.js";
import { conversationSelectionScope, useConversationSelections, readConversationSelections, consumeConversationSelections } from "./conversationSelectionReference.js";
import { parseSideSlashCommand } from "./sideSlashCommand.js";
import { composerDraftStorage } from "./composerDraftStorage.js";
import { validateWorkspaceFileReference } from "./lib/workspaceFileComposer.js";
import { stripGenUiModelContext } from "@areal/gen-ui/contract";
import { useI18n } from "./i18n/IntlProvider.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { CircleAlert } from "lucide-react";
import { useComposerPrediction } from "./useComposerPrediction.js";
import { ContextMeter } from "./ContextMeter.js";
import { isOrdinaryConversation, interruptedConversationTurn } from "./ordinaryConversation.js";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { McpComposerAttachments, useMcpDraft } from "./McpComposerAttachments.js";
import { readMcpDraft, consumeMcpDraft, clearMcpDraft } from "./mcp-app-draft.js";
import { setApplicationPreferences, useApplicationPreferences } from "./settings/applicationPreferences.js";
import { shouldSteer } from "./settings/applicationSettings.js";

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
import { FileTree, ArchiveChatIcon, SendMessageIcon, StopIcon, ContinueExecutionIcon, SideChatIcon } from "./interfaceIcons.js";
import { ConversationComposer } from "./ConversationComposer.js";
import { ComposerAttachment, composerInput, composerPaste, isComposerFile, type ComposerDraftAttachment } from "./ComposerAttachments.js";
import { useComposerPlugins, revalidateComposerPlugins, mergeComposerPluginSkills, composerPluginIntent } from "./ComposerPlugins.js";
import { useComposerSkills, composerSkillContent, readComposerSkills } from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { ComposerMcp } from "./ComposerMcp.js";
import { AttachmentIcon } from "./interfaceIcons.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { conversationReferenceEntries, type ConversationReference } from "./ConversationReferences.js";
import { imageAnnotationBlocked, snapshotImageAnnotations, serializeImageAnnotations, useImageAnnotationRevision, type ImageAnnotationTarget } from "./imageAnnotations.js";
import { BrowserAnnotationAttachments } from "./BrowserAnnotationAttachments.js";
import { browserAnnotation, browserAnnotationText, useBrowserAnnotationEditing } from "./browserAnnotations.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
import { attachedReviewComments, consumeReviewComments, detachReviewComments, recordUnknownReviewSubmission, reconcileReviewSubmission, readReviewComments, reviewCommentKey, reviewCommentText, useReviewComments } from "./reviewComments.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Data, Action } from "./services.js";
import { recoveredOutcome, recoveryMessage, type RecoveryFailure, type RecoveryOperation } from "./recoveryPresentation.js";
// Draft attachments and in-flight UI admission survive task navigation. These are
// unsent client inputs only; Core remains authoritative for acceptance/outcomes.
export const attachmentDrafts = new Map<string, ComposerDraftAttachment[]>();
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
  executionBlocked,
  action,
  readAction = action,
  onPanel,
  onNew,
  onOpenTask,
  onSide,
  onMcpMention,
  appEntries = [],
  conversationReferences = [],
  onAnnotate,
  surfaceLayout = "default",
  inputTestId = "chat-input",
  submitTestId = "chat-send-button",
}: {
  surfaceLayout?: "default" | "compact";
  inputTestId?: string;
  submitTestId?: string;
  project: Data;
  thread: Data;
  executionBlocked: boolean;
  action: Action;
  readAction?: Action;
  onPanel: (name: string) => void;
  onNew: () => void;
  onOpenTask?: (target: { projectId: string; taskId: string; runId: string }) => void;
  onSide?: (draft: string) => Promise<void>;
  onMcpMention?: () => void;
  appEntries?: readonly ComposerCatalogEntry[];
  conversationReferences?: readonly ConversationReference[];
  onAnnotate?: (target: ImageAnnotationTarget) => void;
}) {
  const { t } = useI18n();
  const referenceEntries = conversationReferenceEntries(conversationReferences, t("chat.composer.conversationReference"));
  const prefs = useApplicationPreferences();
  const key = `areal-gui:draft:${project.id}:${thread.id}`;
  const selectionScope = conversationSelectionScope(project.id, thread.id);
  const references = useConversationSelections(selectionScope);
  const mcpDraft = useMcpDraft(key);
  const reviewKey = reviewCommentKey(project.id, thread.id);
  const reviewDraft = useReviewComments(reviewKey);
  const comments = attachedReviewComments(reviewDraft.draft);
  const api = useRef<LexicalChatInputHandle | null>(null);
  const [workspaceReferencePending, setWorkspaceReferencePending] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [text, setText] = useState(() => composerDraftStorage.getItem(key) ?? "");
  const [goalMode, setGoalMode] = useState(() => composerDraftStorage.getItem(`${key}:goal`) === "true");
  const [goalError, setGoalError] = useState("");
  const isSide = thread.conversation?.kind === "side";
  const creatingGoal = !isSide && goalMode && !thread.goals?.goal;
  const changeGoalMode = (enabled: boolean) => {
    setGoalMode(enabled); setGoalError("");
    if (enabled) composerDraftStorage.setItem(`${key}:goal`, "true");
    else composerDraftStorage.removeItem(`${key}:goal`);
    api.current?.focus();
  };
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const [configurationRequestId, setConfigurationRequestId] = useState<string | null>(null);
  const configuring = configurationRequestId !== null;
  const [files, setFiles] = useState<ComposerDraftAttachment[]>(() => attachmentDrafts.get(key) ?? []);
  const input = composerInput(text, files);
  useImageAnnotationRevision();
  const imageEditing = imageAnnotationBlocked(key, input.files);
  const annotationEditing = useBrowserAnnotationEditing(key) || imageEditing;
  const invalidAnnotation = input.files.some(file => browserAnnotation(file)?.comment.trim() === "");
  const [admissionError, setAdmissionError] = useState(() => attachmentErrors.get(key) ?? "");
  useEffect(() => {
    attachmentDrafts.set(key, files);
    window.dispatchEvent(new CustomEvent("areal-attachments-change", { detail: key }));
  }, [key, files]);
  useEffect(() => {
    if (admissionError) attachmentErrors.set(key, admissionError);
    else attachmentErrors.delete(key);
  }, [key, admissionError]);
  const [unknown, setUnknown] = useState<string | null>(() =>
    composerDraftStorage.getItem(`${key}:pending`),
  );
  const [deliveryError, setDeliveryError] = useState("");
  const [returnError, setReturnError] = useState("");
  const [returning, setReturning] = useState(false);
  const running = thread.turns?.find((t: Data) => t.status === "inProgress");
  useEffect(() => { releaseSettledStops(project.id, thread); }, [project.id, thread]);
  const pending = project.pending.some((p: Data) => p.params?.threadId === thread.id && p.params?.requestId !== configurationRequestId);
  const archived = thread.desktop?.archived;
  const questions = (project.state?.interactions?.[thread.id]?.data ?? [])
    .filter((item: Data) => item.status === "pending" && item.kind !== "approval" && !archived);
  const approvals = (project.state?.interactions?.[thread.id]?.data ?? [])
    .filter((item: Data) => item.status === "pending" && item.kind === "approval" && !archived);
  const hadQuestion = useRef(false);
  useEffect(() => {
    if (hadQuestion.current && !questions.length) api.current?.focus();
    hadQuestion.current = questions.length > 0;
  }, [questions.length]);
  const baseDisabled = !project.state?.connected || !!project.observationErrors?.[thread.id] || archived || (busy && !configuring) || pending || !!unknown || !!reviewDraft.error;
  const queueEditor = useComposerQueueEdit({ project, threadId: thread.id, draftKey: key, action, readAction, api, draftFiles: attachmentDrafts,
    setText, setFiles, setGoalMode, annotationBlocked: annotationEditing || invalidAnnotation, inFlight: busy, setInFlight: active => markSending(key, active), uploadFiles: selected => uploadComposerFiles(action, project.id, thread.id, selected) });
  // 配置写入仍占用提交锁，但不把草稿编辑和模型浮层切成消息发送态。
  const editorDisabled = baseDisabled || (queueEditor.busy && !configuring) || queueEditor.locked;
  const disabled = editorDisabled || executionBlocked || configuring;
  const compatibilityDescription = useId();
  const desktopUnsupported = project.desktopCapabilities?.currentCommands === false;
  const stop = () => {
    if (executionBlocked) return;
    if (running) void stopConversationTurn(action, project, thread)
      .catch((cause: Error) => setDeliveryError(cause.message));
  };
  const saveQueueEdit = async () => {
    if (disabled || workspaceReferencePending || sending.has(key)) return;
    await queueEditor.save();
  };
  const config = project.configurations?.[thread.id];
  const configuredModel = config?.model && project.models.find((item: Data) => item.providerId === config.model.providerId && item.modelId === config.model.modelId);
  const modelUnavailable = configuredModel?.available === false || config?.model?.providerId === "areal_openai" && !configuredModel;
  const [mcpOpen, setMcpOpen] = useState(false);

  const skills = useComposerSkills({ project, threadId: thread.id, draftKey: key, action: readAction, disabled: editorDisabled });
  const pluginContext = { kind: "mainThread" as const, projectId: project.id, threadId: thread.id,
    coreInstanceId: project.core?.instanceId, connectionGeneration: project.core?.connectionGeneration, configurationRevision: config?.revision };
  const plugins = useComposerPlugins({ project, context: pluginContext, draftKey: key, text: input.text, action: readAction, onMcpMention });
  const taskManagement = config?.options?.appendInstructions?.startsWith("AREAL_TASK_DRAFT_V1\n") === true;
  const ordinary = isOrdinaryConversation(thread, config);
  const sideContextCount = comments.length + skills.selected.length + mcpDraft.length + references.length
    + parseMentionMarkdown(input.text).filter(part => part.type !== "text" && part.type !== "command").length;
  const interrupted = ordinary && project.core?.features?.ordinaryTurnSubmit === true ? interruptedConversationTurn(thread) : undefined;
  const emptyDraft = !input.text.trim() && !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length && !references.length;
  const nextPrompt = useComposerPrediction({ project, thread, action, enabled: prefs.nextPromptSuggestions,
    eligible: (ordinary || thread.conversation?.policy?.kind === "sideExecutableV2") && !disabled && !running && !questions.length && !approvals.length && !creatingGoal && !queueEditor.edit,
  });
  const predictionVisible = !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length && !references.length && !annotationEditing && !mcpOpen;
  const canContinue = !!interrupted && emptyDraft && !creatingGoal && !queueEditor.edit;
  const planActive = permissionMode(config ?? {}) === "plan";
  const executionPermission = planActive ? permissionMode({ ...config, readOnly: false, options: planModeOptions(false, config?.options) }) : permissionMode(config ?? {});
  const planReady = canExecutePlan(config ?? {}, thread, project.state?.queues?.[thread.id]);
  const clearText = () => {
    api.current?.clear();
    setText("");
    const remaining = files.filter(isComposerFile);
    setFiles(remaining);
    attachmentDrafts.set(key, remaining);
    composerDraftStorage.removeItem(key);
  };
  const clear = () => {
    api.current?.clear();
    setText("");
    setFiles([]);
    skills.clear();
    plugins.clear();
    clearMcpDraft(key);
    consumeConversationSelections(selectionScope, references);
    attachmentDrafts.delete(key);
    setAdmissionError("");
    composerDraftStorage.removeItem(key);
  };
  useEffect(() => { setGoalError(""); }, [key]);
  useEffect(() => {
    setUnknown(composerDraftStorage.getItem(`${key}:pending`));
    setGoalMode(composerDraftStorage.getItem(`${key}:goal`) === "true");
    if (!busy) {
      const draft = composerDraftStorage.getItem(key) ?? "";
      if (api.current && api.current.getMarkdown() !== draft) api.current.setText(draft);
      setText(draft);
      setFiles(attachmentDrafts.get(key) ?? []);
      setAdmissionError(attachmentErrors.get(key) ?? "");
    }
  }, [key, busy]);
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key || sending.has(key)) return;
      const draft = composerDraftStorage.getItem(key) ?? "";
      api.current?.setText(draft); setText(draft); setFiles(attachmentDrafts.get(key) ?? []); api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  useEffect(() => {
    if (!unknown) return;
    const pendingOperation = project.pending.find((entry: Data) => entry.params?.requestId === unknown)?.operation;
    if (pendingOperation) composerDraftStorage.setItem(`${key}:pending-operation`, JSON.stringify(pendingOperation));
    if (pending) return;
    let operation: RecoveryOperation | undefined;
    try { operation = JSON.parse(composerDraftStorage.getItem(`${key}:pending-operation`) ?? "null") ?? undefined; } catch {}
    const outcome = recoveredOutcome(project, unknown, thread.id, operation);
    if (!outcome) return;
    composerDraftStorage.removeItem(`${key}:pending`);
    composerDraftStorage.removeItem(`${key}:pending-operation`);
    setUnknown(null);
    reconcileReviewSubmission(reviewKey, unknown, outcome.accepted !== false);
    const wasGoal = composerDraftStorage.getItem(`${key}:pending-goal`) === unknown;
    composerDraftStorage.removeItem(`${key}:pending-goal`);
    const wasContinue = composerDraftStorage.getItem(`${key}:pending-continue`) === unknown;
    composerDraftStorage.removeItem(`${key}:pending-continue`);
    const wasConfigure = composerDraftStorage.getItem(`${key}:pending-configure`) === unknown;
    composerDraftStorage.removeItem(`${key}:pending-configure`);
    if (outcome.status === "failed") setDeliveryError(outcome.message || "消息已受理，但执行失败，请检查对话结果。");
    else if (outcome.accepted === false) setDeliveryError(outcome.message || "原轮次已结束，内容已保留，请检查后发送。");
    else if (wasContinue || wasConfigure) setDeliveryError("");
    else if (wasGoal) {
      clearText(); changeGoalMode(false);
    } else clear();
  }, [unknown, pending, project.outcomes]);
  useEffect(() => {
    if (thread.goals?.goal && goalMode) changeGoalMode(false);
  }, [thread.goals?.goal?.id]);
  const submit = async (value: string, invert = false, approvePlan = false) => {
    if (workspaceReferencePending) return;
    if (desktopUnsupported && !creatingGoal && !queueEditor.edit) return;
    const submittedInput = composerInput(value, files);
    if (disabled || annotationEditing || invalidAnnotation || sending.has(key)) return;
    if (queueEditor.edit) { await saveQueueEdit(); return; }
    if (modelUnavailable && !creatingGoal) return;
    if (!submittedInput.text.trim() && !submittedInput.files.length && !comments.length && !skills.selected.length && !mcpDraft.length && !references.length) return;
    if (approvePlan && (!planReady || input.text.trim() || input.files.length || comments.length)) return;
    if (creatingGoal && (running || thread.parentThreadId || !submittedInput.text.trim())) return;
    setAdmissionError("");
    markSending(key, true);
    setGoalError("");
    setDeliveryError("");
    let configurationRequestId: string | undefined;
    const sideCommand = parseSideSlashCommand(submittedInput.text, submittedInput.files,
      sideContextCount,
      !!onSide && !isSide && !creatingGoal && !taskManagement && !matchMedia("(max-width: 640px)").matches,
      appEntries.map(entry => entry.value));
    try {
      if (sideCommand && onSide) {
        await onSide(sideCommand.text);
        if (api.current?.getMarkdown() === value) clearText();
        return;
      }
      if (creatingGoal) {
        await action("manage", { projectId: project.id, threadId: thread.id, operation: "goalCreate",
          expectedRevision: thread.goals?.revision ?? 0, objective: submittedInput.text, inferLimits: true });
        clearText();
        changeGoalMode(false);
        return;
      }
      if (approvePlan) {
        configurationRequestId = crypto.randomUUID();
        await action("configure", { projectId: project.id, threadId: thread.id, requestId: configurationRequestId, expectedRevision: config?.revision, options: planModeOptions(false, config?.options) });
        configurationRequestId = undefined;
      }
      await submitMessage(action, project.id, thread.id, value, files, {
        steer: !taskManagement && !!running && shouldSteer(prefs.followUp, invert),
        expectedTurnId: running?.id,
        enqueue: !taskManagement && !!running,
        skillAction: readAction,
        pluginContext, pluginMessages: { unavailable: t("chat.composer.pluginReferenceUnavailable"), intent: (name: string) => t("chat.composer.pluginReferenceIntent", { name }) },
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
        else if (!error.submissionUnknown) setDeliveryError(recoveryMessage(error));
        else setAdmissionError(error.message);
      }
      if (error.submissionUnknown && error.requestId) {
        const failure = error as RecoveryFailure;
        if (failure.outcome && "operation" in failure.outcome) composerDraftStorage.setItem(`${key}:pending-operation`, JSON.stringify(failure.outcome.operation));
        if (configurationRequestId) composerDraftStorage.setItem(`${key}:pending-configure`, error.requestId);
        if (creatingGoal) composerDraftStorage.setItem(`${key}:pending-goal`, error.requestId);
        setUnknown(error.requestId);
        composerDraftStorage.setItem(`${key}:pending`, error.requestId);
      }
    } finally {
      markSending(key, false);
    }
  };
  const continueExecution = async () => {
    if (desktopUnsupported || !canContinue || disabled || modelUnavailable || sending.has(key)) return;
    markSending(key, true); setDeliveryError("");
    try {
      await action("continue", { projectId: project.id, threadId: thread.id, expectedTurnId: interrupted.id, expectedConfigRevision: config?.revision });
    } catch (cause) {
      const error = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (!error.submissionUnknown) setDeliveryError(recoveryMessage(error));
      if (error.submissionUnknown && error.requestId) {
        composerDraftStorage.setItem(`${key}:pending`, error.requestId);
        composerDraftStorage.setItem(`${key}:pending-continue`, error.requestId);
        setUnknown(error.requestId);
      }
    } finally { markSending(key, false); }
  };
  const configure = async (values: Data) => {
    if (queueEditor.edit) return;
    if (disabled || running || sending.has(key)) return;
    const requestId = crypto.randomUUID();
    setConfigurationRequestId(requestId);
    markSending(key, true);
    try {
      await action("configure", { projectId: project.id, threadId: thread.id, requestId, expectedRevision: config?.revision, ...values });
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (failure.submissionUnknown) {
        const originalId = failure.requestId ?? requestId;
        setUnknown(originalId);
        composerDraftStorage.setItem(`${key}:pending`, originalId);
        composerDraftStorage.setItem(`${key}:pending-configure`, originalId);
        const outcome = (failure as RecoveryFailure).outcome;
        if (outcome && "operation" in outcome) composerDraftStorage.setItem(`${key}:pending-operation`, JSON.stringify(outcome.operation));
      } else setAdmissionError(recoveryMessage(failure));
    } finally { setConfigurationRequestId(null); markSending(key, false); }
  };
  const catalogActions: ComposerCatalogEntry[] = [
    ...(onSide && !input.files.length && !sideContextCount && !isSide && !taskManagement && !matchMedia("(max-width: 640px)").matches ? ["side", "btw"].filter(name => !appEntries.some(entry => entry.value.toLowerCase() === name)).map(name => ({
      value: name, label: `/${name}`, keywords: [t(name === "side" ? "chat.side.title" : "chat.side.btw")], description: t("chat.side.newDescription"), icon: <SideChatIcon />, group: "commands" as const,
      preserveInputUntilAccepted: true,
      disabled: disabled || !!queueEditor.edit,
      run: async () => { try { await onSide(""); } catch (cause) { setDeliveryError(recoveryMessage(cause as Error)); throw cause; } },
    })) : []),
    ...(onMcpMention ? [{value:"app-mention",label:"@ 应用引用",description:"搜索应用中的文件、工单或其他资源",icon:<ComposerMcpIcon/>,group:"功能" as const,run:onMcpMention}] : []),
    { value: "upload", label: "上传文件", description: "添加图片、文档或其他文件", icon: <AttachmentIcon />, group: "功能", run: () => upload.current?.click() },
    { value: "mcp", label: "MCP", description: "查看服务器与连接状态", icon: <ComposerMcpIcon />, group: "功能", run: () => setMcpOpen(true) },
    { value: "files", label: t("chat.composer.workspaceFiles"), description: t("chat.composer.workspaceFilesDescription"), icon: <FileTree />, group: "功能", run: () => onPanel("文件") },
    { value: "plan", label: "计划模式", description: planActive ? "关闭计划模式" : "先规划，再开始执行", icon: <Lightbulb />, group: "功能", disabled: disabled || taskManagement || !!running || !config || config.profile?.readOnly === true, run: () => { void configure({ options: planModeOptions(!planActive, config?.options) }); } },
    ...(!isSide && !thread.goals?.goal ? [{ value: "goal", label: "设置目标", description: creatingGoal ? "关闭目标模式" : "设置持续目标与停止条件", icon: <Target />, group: "功能" as const, disabled: disabled || taskManagement || !!running || !!thread.parentThreadId, run: () => changeGoalMode(!goalMode) }] : []),
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
      {desktopUnsupported && <span id={compatibilityDescription} className="sr-only">{t("backend.updateRequired")}</span>}
      {!isSide && <GoalCard project={project} thread={thread} action={action} onEdit={() => onPanel("编辑目标")} />}
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
      {deliveryError && <FeedbackNotice tone="error" message={deliveryError} onDismiss={() => setDeliveryError("")} />}
      {unknown && <FeedbackNotice tone="warning" requestId={unknown} message={t("recovery.sendUnconfirmed")} actions={<Button variant="ghost" size="sm" onClick={() => void readAction("reconcile", { projectId: project.id }).catch(() => {})}>{t("recovery.checkOriginal")}</Button>} />}
      {planReady && !queueEditor.edit && <section className="flex items-center justify-between gap-3 px-3 py-2 text-ui-sm" aria-label="计划确认">
        <span className="text-foreground-subtle">计划已完成。批准后将以自动编辑模式执行。</span>
        <Button size="sm" disabled={disabled || modelUnavailable || desktopUnsupported || !!input.text.trim() || !!input.files.length || !!comments.length} aria-describedby={desktopUnsupported ? compatibilityDescription : undefined} title={desktopUnsupported ? t("backend.updateRequired") : undefined} onClick={() => void submit("按上方已确认的计划执行。", false, true)}>批准并执行</Button>
      </section>}
      <div className="composer-input-stack">
      <div ref={setMenuAnchor} className="composer-menu-anchor" />
      <ComposerQueue
        key={key}
        project={project}
        thread={thread}
        action={action}
        disabled={baseDisabled || queueEditor.busy || executionBlocked}
        editingId={queueEditor.edit?.id}
        onEdit={item => { if (!disabled) void queueEditor.begin(item); }}
      />
      {/* Pending decisions stay reachable outside the scrolling transcript. */}
      {approvals.map((item: Data) => <ApprovalRequest key={item.requestId} item={item} projectId={project.id} action={action} />)}
      {questions.map((item: Data) => <AskUserQuestion key={item.requestId} item={item} projectId={project.id} action={action} />)}
      {goalError && <p role="alert" className="notice text-destructive">{goalError}</p>}
      {admissionError && <p role="alert" className="notice text-destructive">{admissionError}</p>}
      {reviewDraft.error && <p role="alert" className="notice">{reviewDraft.error}</p>}
      {thread.desktop?.workflowRun && <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-ui-sm text-foreground-subtle">
        <Button type="button" size="sm" variant="ghost" onClick={() => {
          const storageKey = `areal-gui:workgroup:${project.id}`;
          composerDraftStorage.setItem(storageKey, thread.desktop.workflowRun.workgroupId);
          document.dispatchEvent(new CustomEvent("areal:workgroup-operation", { detail: storageKey }));
          onPanel("工作组");
        }}>查看关联工作流结果</Button>
      </div>}
      <ConversationComposer
        nextPrompt={predictionVisible ? nextPrompt : undefined}
        surfaceLayout={surfaceLayout}
        project={project}
        contextControl={<ContextMeter key={`${project.id}:${thread.id}`} project={project} thread={thread} action={readAction} anchor={menuAnchor} />}
        modelConfig={config}
        modelDisabled={editorDisabled || executionBlocked || !!queueEditor.edit || !!running || !config}
        modelPending={configuring}
        onConfigureModel={configure}
        triggerPanelContainer={menuAnchor}
        className={!queueEditor.edit ? approvals.length ? "hidden" : questions.length ? "interaction-composer-compact" : undefined : undefined}
        shellClassName="@container/composer"
        workspacePath={project.root}
        referenceScope={queueEditor.edit ? `${queueEditor.edit.id}:${queueEditor.edit.phase}` : "draft"}
        enableWorkspaceFileDrop={!!project.root && !editorDisabled}
        enableExternalFileDrop={!editorDisabled}
        validateWorkspaceFile={payload => validateWorkspaceFileReference(readAction, project.id, project.root, payload)}
        onFileDrop={files => setFiles(current => [...current, ...files])}
        onWorkspaceReferencePendingChange={setWorkspaceReferencePending}
        taskId={thread.id}
        initialValue={text}
        inputApiRef={api}
        inputTestId={inputTestId}
        submitTestId={submitTestId}
        placeholder={archived ? "已归档任务只读" : creatingGoal ? "描述目标，明确可衡量的结果" : planActive ? "描述任务，生成计划…" : "随心输入"}
        disabled={editorDisabled}
        submitDisabled={workspaceReferencePending || disabled || (modelUnavailable && !queueEditor.edit && !creatingGoal) || (desktopUnsupported && !queueEditor.edit && !creatingGoal) || (taskManagement && !!running) || annotationEditing || invalidAnnotation || (queueEditor.edit ? queueEditor.saveDisabled || (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length) : creatingGoal ? !input.text.trim() || !!running : !canContinue && emptyDraft)}
        submitDisabledReason={desktopUnsupported && !queueEditor.edit && !creatingGoal ? t("backend.updateRequired") : modelUnavailable && !queueEditor.edit && !creatingGoal ? t("chat.composer.previousModelUnavailable") : undefined}
        submitting={busy && !configuring}
        submitLabel={queueEditor.edit ? "保存排队消息" : creatingGoal ? "开始目标" : canContinue ? "继续执行" : "发送"}
        enterSubmits={prefs.sendShortcut === "enter"}
        enableMentionPanel={false}
        pluginMentionCatalog={{ ...plugins.catalog, entries: [...(queueEditor.edit ? [] : plugins.catalog.entries), ...referenceEntries],
          searchLabel: t("chat.composer.searchReferences"), label: t("chat.composer.references"), appGroupLabel: plugins.catalog.label }}
        composerCatalog={{ ...skills.catalog, entries: [...catalogActions, ...referenceEntries, ...appEntries, ...skills.catalog.entries].map(entry => ({ ...entry, disabled: entry.disabled || (!!queueEditor.edit && entry.group !== "会话" && !["upload", "files", "mcp"].includes(entry.value)) })) }}
        onChange={(value) => {
          setText(value);
          composerDraftStorage.setItem(key, value);
          composerDraftStorage.setItem(`${key}:version`, String(Number(composerDraftStorage.getItem(`${key}:version`) ?? 0) + 1));
        }}
        allowSubmitWhenEmpty={canContinue || !!references.length}
        onSubmit={(value) => {
          if (canContinue) void continueExecution();
          else void submit(value);
          return false;
        }}
        onModifiedSubmit={prefs.sendShortcut === "enter" ? (value) => {
          if (canContinue) void continueExecution();
          else void submit(value, !!running);
          return false;
        } : undefined}
        onPaste={event => composerPaste(event, pasted => setFiles(current => [...current, ...pasted]))}
        topContent={
          <>{queueEditor.edit && <div className="composer-queue-edit-banner" aria-label="编辑排队消息">
            <span>{queueEditor.edit.phase === "opening" ? "等待确认暂停队列" : "编辑排队消息"}</span>
            <Button type="button" size="sm" variant="ghost" disabled={queueEditor.busy || !!queueEditor.edit.unknown || pending || executionBlocked} onClick={() => { if (!executionBlocked) void queueEditor.cancel(); }}>取消</Button>
            <Button type="button" size="sm" disabled={workspaceReferencePending || disabled || queueEditor.saveDisabled || (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length)} onClick={() => void saveQueueEdit()}>保存</Button>
          </div>}
          {queueEditor.feedback && <p role="alert" className="composer-queue-feedback">{queueEditor.feedback}</p>}
          {queueEditor.edit?.unknown && <Button type="button" size="sm" disabled={queueEditor.busy || !project.state?.connected} onClick={() => void queueEditor.reconcile()}>核对编辑操作</Button>}
          {!queueEditor.edit && <ConversationSelectionReferences references={references} disabled={editorDisabled}
            onRemove={id => consumeConversationSelections(selectionScope, references.filter(reference => reference.id === id))} />}
          {!queueEditor.edit && skills.tags}
          <BrowserAnnotationAttachments files={files} disabled={editorDisabled} onChange={setFiles} />
          <div className="composer-attachment-row">
          {!!queueEditor.edit?.attachments.length && <div className="composer-attachments">
            {queueEditor.edit.attachments.map((part, index) => <ComposerQueueAttachment key={`${index}:${part.url}`} part={part} projectId={project.id} threadId={thread.id} action={readAction} disabled={editorDisabled}
              onRemove={() => queueEditor.removeAttachment(index)} />)}
          </div>}
          {files.some(file => !isComposerFile(file) || !browserAnnotation(file)) ? (
            <div className="composer-attachments" data-testid="composer-attachments">
              {files.filter(file => !isComposerFile(file) || !browserAnnotation(file)).map((file, i) => <ComposerAttachment disabled={editorDisabled} key={isComposerFile(file) ? `${file.name}-${file.lastModified}-${i}` : `pasted-text-${i}`} file={file}
                onAnnotate={onAnnotate ? file => onAnnotate({ draftKey: key, file, returnFocus: () => api.current?.focus() }) : undefined}
                onRemove={() => setFiles((current) => current.filter(item => item !== file))}
                onExpand={content => { api.current?.appendText(`${text.length ? "\n\n" : ""}${content}`); setFiles(current => current.filter(item => item !== file)); }} />)}
            </div>
          ) : null}
          {!queueEditor.edit && <ReviewCommentAttachment comments={comments} disabled={editorDisabled} onRemove={() => detachReviewComments(reviewKey)} />}
          {!queueEditor.edit && <McpComposerAttachments draftKey={key} entries={mcpDraft} disabled={editorDisabled} />}
          </div></>
        }
        promptHistory={(thread.turns ?? []).flatMap((t: Data) =>
          (t.items ?? [])
            .filter((i: Data) => i.type === "userMessage" && !t.continuedFromTurnId && !(goalContinuationLabel(t) && i.id === t.items.find((entry: Data) => entry.type === "userMessage")?.id))
            .map((i: Data) =>
              stripGenUiModelContext((i.content ?? [])
                .filter((p: Data) => p.type === "text")
                .map((p: Data) => p.text)
                .join("\n")),
            ),
        )}
        leadingActions={
          <>{unknown && <Button type="button" variant="ghost" size="icon-sm" aria-label={t("recovery.pendingAction")} title={t("recovery.checkOriginal")} onClick={() => void readAction("reconcile", { projectId: project.id }).catch(() => {})}><CircleAlert size={16} /></Button>}<ComposerPermissionMenu value={executionPermission}
            configuration={config}
            permissionsSupported={project.core?.features?.permissionPresets === true}
            fullAccessAvailable={project.core?.features?.permissionFullAccess === true}
            disabled={disabled || !!queueEditor.edit || !!running || !config} lockedReadOnly={taskManagement || executionPermission === "readOnly"}
            onClose={() => api.current?.focus()}
            onChange={mode => { setApplicationPreferences({ defaultPermissionPreset: mode }); void configure({ options: planModeOptions(planActive, permissionOptions(mode, config?.options)) }); }} />
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
        onCancel={queueEditor.edit ? () => { if (!executionBlocked) void queueEditor.cancel(); } : running ? stop : undefined}
        submitControl={queueEditor.edit ? <Button type="button" size="icon" aria-label="保存排队消息" data-testid={submitTestId} disabled={workspaceReferencePending || disabled || queueEditor.saveDisabled || (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length)}
          className="composer-primary-action" onClick={() => void saveQueueEdit()}><SendMessageIcon className="size-5" /></Button> : running && !input.text.trim() && !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length && !references.length ? (
          <ControlHintTooltip title={ordinary ? "暂停执行" : "停止"} shortcut="Esc">
            <Button type="button" variant="secondary" size="icon" className="composer-primary-action composer-stop-action" aria-label={ordinary ? "暂停执行" : "停止"} disabled={executionBlocked}
              onClick={() => { stop(); api.current?.focus(); }}>
              <StopIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        ) : running ? (
          <ControlHintTooltip title={desktopUnsupported ? t("backend.updateRequired") : "发送"} shortcut={prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"}>
            <ComposerActionButton type="button" size="icon" aria-label="发送" data-testid={submitTestId}
              aria-describedby={desktopUnsupported ? compatibilityDescription : undefined} title={desktopUnsupported ? t("backend.updateRequired") : undefined}
              disabled={disabled || modelUnavailable || desktopUnsupported || taskManagement || (!input.text.trim() && !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length && !references.length)}
              onClick={event => void submit(api.current?.getMarkdown() ?? text, event.metaKey || event.ctrlKey)}>
              <SendMessageIcon className="size-5" />
            </ComposerActionButton>
          </ControlHintTooltip>
        ) : canContinue ? (
          <ControlHintTooltip title={desktopUnsupported ? t("backend.updateRequired") : "继续执行"}>
            <ComposerActionButton type="button" size="icon" aria-label="继续执行" data-testid="chat-continue-button"
              aria-describedby={desktopUnsupported ? compatibilityDescription : undefined} title={desktopUnsupported ? t("backend.updateRequired") : undefined}
              disabled={disabled || modelUnavailable || desktopUnsupported} className="composer-primary-action" onClick={() => void continueExecution()}>
              <ContinueExecutionIcon className="size-5" />
            </ComposerActionButton>
          </ControlHintTooltip>
        ) : undefined}

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
  files: ComposerDraftAttachment[],
  options: Data = {},
) {
  const reviewKey = reviewCommentKey(projectId, threadId);
  const comments = options.appMessage ? [] : attachedReviewComments(readReviewComments(reviewKey));
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  const selectionScope = conversationSelectionScope(projectId, threadId);
  const capturedReferences = options.appMessage ? [] : readConversationSelections(selectionScope);
  const capturedMcp = options.appMessage ? [] : readMcpDraft(key);
  const blocks = options.appMessage ? options.mcpContent ?? [] : capturedMcp.map((entry: Data) => entry.block);
  const imageBlocks = blocks.filter((block: Data) => block.type === "image");
  const imageFiles = imageBlocks.map((block: Data) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) || typeof block.data !== "string" || block.data.length > 12 * 1024 * 1024) throw new Error("应用图片类型或大小不受支持。");
    const bytes = Uint8Array.from(atob(block.data), character => character.charCodeAt(0));
    return new File([bytes], typeof block._meta?.["openai/title"] === "string" ? block._meta["openai/title"] : "应用图片", {type:block.mimeType});
  });
  const input = composerInput(text, files);
  const imageSnapshot = snapshotImageAnnotations(input.files);
  const plugins = options.appMessage ? [] : await revalidateComposerPlugins(options.skillAction ?? action,
    options.pluginContext ?? { kind: "mainThread", projectId, threadId }, key, input.text,
    options.pluginMessages?.unavailable ?? "chat.composer.pluginReferenceUnavailable");
  const pluginIntent = composerPluginIntent(plugins, options.pluginMessages?.intent ?? ((name: string) => `Use the selected plugin ${name} for this request.`));
  const skillContent = options.appMessage ? "" : await composerSkillContent(options.skillAction ?? action, projectId, threadId,
    mergeComposerPluginSkills(readComposerSkills(key), plugins));
  const attachments: Data[] = await uploadComposerFiles(action, projectId, threadId, [...input.files, ...imageFiles]);
  imageBlocks.forEach((block: Data, index: number) => { if (block._meta) attachments[input.files.length + index]._meta = block._meta; });
  const annotationFeedback = input.files.flatMap((file, index) => {
    const note = browserAnnotation(file);
    return note ? [browserAnnotationText(note, attachments[index].url)] : [];
  }).join("\n\n");
  const feedback = [annotationFeedback, serializeImageAnnotations(imageSnapshot, attachments), comments.map(reviewCommentText).join("\n\n"), pluginIntent, skillContent].filter(Boolean).join("\n\n");
  try {
    await action(options.steer ? "steer" : "send", {
        projectId,
        threadId,
        text: feedback ? (input.text ? `${input.text}\n\n${feedback}` : feedback) : input.text,
        attachments,
        ...(capturedReferences.length ? { conversationQuotes: capturedReferences.map(({ text }) => ({ text })) } : {}),
        ...(blocks.some((block: Data) => block.type !== "image") ? {mcpContent: blocks.filter((block: Data) => block.type !== "image")} : {}),
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
  if (!options.appMessage) { consumeMcpDraft(key, capturedMcp); consumeConversationSelections(selectionScope, capturedReferences); }
}
export function stageThreadDraft(projectId: string, threadId: string, text: string, files: ComposerDraftAttachment[]) {
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  composerDraftStorage.setItem(key, text);
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
      type: media.mimeType.startsWith("image/")
        ? "image"
        : media.mimeType.startsWith("audio/")
          ? "audio"
          : "file",
      url: media.uri,
      name: file.name,
      mimeType: media.mimeType,
    });
  }
  return attachments;
}
