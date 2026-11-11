import { useReadOnly, useConversationSubmitReadOnly } from "./PlatformReadContext.js";
import { snapShotCommandEntries } from "./snapshots/shortcut.js";
import { useSnapShotCapture } from "./snapshots/captureContext.js";
import { useSnapShotDraft } from "./snapshots/activeDraft.js";
import { consumeSnapShotFiles } from "./snapshots/drafts.js";
import { submitMessage } from "./ComposerSubmission.js";
export { submitMessage } from "./ComposerSubmission.js";
import {
  composerUploadOwner,
  composerUploads,
  forgetComposerUploads,
} from "./ComposerUploadState.js";
import { uploadComposerFiles } from "./ComposerUploads.js";
export { uploadComposerFiles } from "./ComposerUploads.js";

import { requestTurnStart, cancelTurnStart, readingViews } from "./readingViews.js";
import { acceptPendingMessage, setPendingMessage, usePendingMessage } from "./pendingMessage.js";
import { Input } from "@areal/ui";
import { ComposerActionButton } from "@areal/ui/experimental";
import { parseMentionMarkdown } from "./mentions/mentionMarkdown.js";
import { stopConversationTurn, releaseSettledStops } from "./conversationStop.js";
import { ConversationSelectionReferences } from "./ConversationSelectionReferences.js";
import {
  conversationSelectionScope,
  useConversationSelections,
  consumeConversationSelections,
} from "./conversationSelectionReference.js";
import { parseSideSlashCommand } from "./sideSlashCommand.js";
import { composerDraftStorage, flushComposerDrafts } from "./composerDraftStorage.js";
import { composerPending } from "./composerPending.js";
import { useComposerWorkspaceFiles } from "./lib/workspaceFileComposer.js";
import { stripGenUiModelContext } from "@areal/gen-ui/contract";
import { UiMessageError, useI18n } from "./i18n/IntlProvider.js";
import { errorText, presentError, rawText, type PresentedError } from "./errors/errorCopy.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { useAutoReconcile } from "./errors/autoReconcile.js";
import { wasReported } from "./errors/reported.js";
import { useToolInspection } from "./UnknownToolInspection.js";
import { useComposerPrediction } from "./useComposerPrediction.js";
import { ContextMeter } from "./ContextMeter.js";
import { isOrdinaryConversation, interruptedConversationTurn } from "./ordinaryConversation.js";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { McpComposerAttachments, useMcpDraft } from "./McpComposerAttachments.js";
import { clearMcpDraft } from "./mcp-app-draft.js";
import {
  setApplicationPreferences,
  useApplicationPreferences,
} from "./settings/applicationPreferences.js";
import { shouldSteer } from "./settings/applicationSettings.js";

import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import {
  canExecutePlan,
  permissionMode,
  permissionOptions,
  planModeOptions,
} from "./permissions.js";
import { ComposerGoalMode, ComposerPlanMode } from "./ComposerPlanMode.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { Button } from "./components/ui/button.js";
import { ComposerQueue } from "./ComposerQueue.js";
import { useComposerQueueEdit } from "./useComposerQueueEdit.js";
import { useComposerConfiguration } from "./useComposerConfiguration.js";
import { ComposerQueueAttachment } from "./ComposerQueueAttachment.js";
import { AskUserQuestion } from "./AskUserQuestion.js";
import { ApprovalRequest } from "./ApprovalRequest.js";
import { GoalCard, goalControlError } from "./Goal.js";
import { goalContinuationLabel } from "./conversationPresentation.js";
import {
  ArchiveChatIcon,
  SendMessageIcon,
  StopIcon,
  ContinueExecutionIcon,
  SideChatIcon,
} from "./interfaceIcons.js";
import { ConversationComposer } from "./ConversationComposer.js";
import {
  ComposerFileList,
  composerInput,
  composerPaste,
  isComposerFile,
  hasMissingComposerFiles,
  type ComposerDraftAttachment,
} from "./ComposerAttachments.js";
import { useComposerPlugins } from "./ComposerPlugins.js";
import { useComposerSkills } from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { composerFeatureEntries } from "./composerFeatures.js";
import { ComposerMcp } from "./ComposerMcp.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import {
  conversationReferenceEntries,
  type ConversationReference,
} from "./ConversationReferences.js";
import {
  imageAnnotationBlocked,
  useImageAnnotationRevision,
  type ImageAnnotationTarget,
} from "./imageAnnotations.js";
import { BrowserAnnotationAttachments } from "./BrowserAnnotationAttachments.js";
import { browserAnnotation, useBrowserAnnotationEditing } from "./browserAnnotations.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
import {
  attachedReviewComments,
  detachReviewComments,
  reconcileReviewSubmission,
  reviewCommentKey,
  useReviewComments,
} from "./reviewComments.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Data, Action } from "./services.js";
import {
  recoveredOutcome,
  recoveryMessage,
  isTechnicalErrorMessage,
  type RecoveryFailure,
  type RecoveryOperation,
} from "./recoveryPresentation.js";
// Draft attachments and in-flight UI admission survive task navigation. These are
// unsent client inputs only; Core remains authoritative for acceptance/outcomes.
import { attachmentDrafts, sending } from "./composerDraftAttachments.js";
export { attachmentDrafts, sending } from "./composerDraftAttachments.js";
export const attachmentErrors = new Map<string, string>();
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
  window.dispatchEvent(new Event("areal-snapshot-drain"));
};
export function Composer({
  project,
  thread,
  executionBlocked,
  action,
  readAction = action,
  onPanel,
  onOpenTask,
  onSide,
  onMcpMention,
  appEntries = [],
  conversationReferences = [],
  onAnnotate,
  surfaceLayout = "default",
  surfacePlacement,
  inputTestId = "chat-input",
  submitTestId = "chat-send-button",
}: {
  surfaceLayout?: "default" | "compact";
  surfacePlacement?: "thread" | "home";
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
  const readOnly = useReadOnly();
  const conversationSubmitReadOnly = useConversationSubmitReadOnly();
  const workspaceFiles = useComposerWorkspaceFiles(readAction, project, thread.id);
  const { t } = useI18n();
  const referenceEntries = conversationReferenceEntries(
    conversationReferences,
    t("chat.composer.conversationReference"),
  );
  const prefs = useApplicationPreferences();
  const key = `areal-gui:draft:${project.id}:${thread.id}`;
  useEffect(() => flushComposerDrafts, [key]);
  useSnapShotDraft(key);
  const snapshotCapture = useSnapShotCapture();
  const uploadOwner = composerUploadOwner(project, thread.id);
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
  const [goalMode, setGoalMode] = useState(
    () => composerDraftStorage.getItem(`${key}:goal`) === "true",
  );
  const [goalError, setGoalError] = useState("");
  const isSide = thread.conversation?.kind === "side";
  const creatingGoal = !isSide && goalMode && !thread.goals?.goal;
  const changeGoalMode = (enabled: boolean) => {
    setGoalMode(enabled);
    setGoalError("");
    if (enabled) composerDraftStorage.setItem(`${key}:goal`, "true");
    else composerDraftStorage.removeItem(`${key}:goal`);
    api.current?.focus();
  };
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const configuration = useComposerConfiguration(project, thread.id, busy);
  const { configuring, pending } = composerPending(
    project.pending,
    thread.id,
    configuration.requestId ?? null,
  );
  const pendingMessage = usePendingMessage(key);
  const awaitingProjection = pendingMessage?.accepted === true;
  const outgoing = busy ? pendingMessage : undefined;
  useEffect(() => {
    // 待提交预览只清空现有编辑器，保留 Enter 发送时的焦点与选区所有权。
    if (outgoing) api.current?.clear();
  }, [outgoing]);
  const [files, setFiles] = useState<ComposerDraftAttachment[]>(
    () => attachmentDrafts.get(key) ?? [],
  );
  const input = composerInput(text, files);
  useImageAnnotationRevision();
  const imageEditing = imageAnnotationBlocked(key, input.files);
  const annotationEditing = useBrowserAnnotationEditing(key) || imageEditing;
  const invalidAnnotation = input.files.some(
    (file) => browserAnnotation(file)?.comment.trim() === "",
  );
  const [admissionError, setAdmissionError] = useState(() => attachmentErrors.get(key) ?? "");
  const [admissionAttempt, setAdmissionAttempt] = useState(0);
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
  const [deliveryNotice, setDeliveryNotice] = useState<Pick<
    PresentedError,
    "message" | "detail"
  > | null>(null);
  // 已有专门说明的失败（待确认、需要设置等）用 recoveryMessage，原始文字只进详情。
  const showDeliveryNotice = (cause: unknown) => {
    if (wasReported(cause)) return;
    setDeliveryNotice({
      message: recoveryMessage(cause as RecoveryFailure, "operation", t),
      detail: presentError(t, cause).detail,
    });
  };
  const inspection = useToolInspection(project, thread, action, () => api.current?.focus());
  // 附件失败以“文件名: 原因”标出是哪个附件；原因同样取自错误文案表。
  const admissionText = (cause: unknown) => {
    const message = rawText(cause) ?? "";
    const file = input.files.find((file) => message.startsWith(`${file.name}:`));
    return file
      ? `${file.name}: ${errorText(t, cause)}`
      : recoveryMessage(cause as RecoveryFailure, "operation", t);
  };
  const [returnNotice, setReturnNotice] = useState<PresentedError | null>(null);
  const [returning, setReturning] = useState(false);
  const running = thread.turns?.find((t: Data) => t.status === "inProgress");
  useEffect(() => {
    releaseSettledStops(project.id, thread);
  }, [project.id, thread]);
  const archived = thread.desktop?.archived;
  const questions = (project.state?.interactions?.[thread.id]?.data ?? []).filter(
    (item: Data) => item.status === "pending" && item.kind !== "approval" && !archived,
  );
  const approvals = (project.state?.interactions?.[thread.id]?.data ?? []).filter(
    (item: Data) => item.status === "pending" && item.kind === "approval" && !archived,
  );
  const hadQuestion = useRef(false);
  useEffect(() => {
    if (hadQuestion.current && !questions.length) api.current?.focus();
    hadQuestion.current = questions.length > 0;
  }, [questions.length]);
  const baseDisabled =
    !project.state?.connected ||
    !!project.observationErrors?.[thread.id] ||
    archived ||
    (busy && !configuring) ||
    pending ||
    !!unknown ||
    !!reviewDraft.error;
  const queueEditor = useComposerQueueEdit({
    project,
    threadId: thread.id,
    draftKey: key,
    action,
    readAction,
    api,
    draftFiles: attachmentDrafts,
    setText,
    setFiles,
    setGoalMode,
    annotationBlocked: annotationEditing || invalidAnnotation,
    inFlight: busy,
    setInFlight: (active) => markSending(key, active),
    uploadFiles: (selected) =>
      uploadComposerFiles(action, project.id, thread.id, selected, undefined, uploadOwner),
  });
  // 配置写入仍占用提交锁，但不把草稿编辑和模型浮层切成消息发送态。
  const editorDisabled = baseDisabled || (queueEditor.busy && !configuring) || queueEditor.locked;
  const disabled = editorDisabled || executionBlocked || configuring;
  const compatibilityDescription = useId();
  const desktopUnsupported =
    conversationSubmitReadOnly ||
    (!readOnly && project.desktopCapabilities?.currentCommands === false);
  const stop = () => {
    if (executionBlocked) return;
    if (running)
      void stopConversationTurn(action, project, thread).catch((cause: unknown) => {
        if (!wasReported(cause)) setDeliveryNotice(presentError(t, cause));
      });
  };
  const saveQueueEdit = async () => {
    if (disabled || workspaceReferencePending || sending.has(key)) return;
    await queueEditor.save();
  };
  const config = project.configurations?.[thread.id];
  const [mcpOpen, setMcpOpen] = useState(false);

  const skills = useComposerSkills({
    project,
    threadId: thread.id,
    draftKey: key,
    action: readAction,
    disabled: editorDisabled,
  });
  const pluginContext = {
    kind: "mainThread" as const,
    projectId: project.id,
    threadId: thread.id,
    coreInstanceId: project.core?.instanceId,
    connectionGeneration: project.core?.connectionGeneration,
    configurationRevision: config?.revision,
  };
  const plugins = useComposerPlugins({
    project,
    context: pluginContext,
    draftKey: key,
    text: input.text,
    action: readAction,
    onMcpMention,
  });
  const taskManagement =
    config?.options?.appendInstructions?.startsWith("AREAL_TASK_DRAFT_V1\n") === true;
  const ordinary = isOrdinaryConversation(thread, config);
  const sideContextCount =
    comments.length +
    skills.selected.length +
    mcpDraft.length +
    references.length +
    parseMentionMarkdown(input.text).filter(
      (part) => part.type !== "text" && part.type !== "command",
    ).length;
  const interrupted =
    ordinary && project.core?.features?.ordinaryTurnSubmit === true
      ? interruptedConversationTurn(thread)
      : undefined;
  const emptyDraft =
    !input.text.trim() &&
    !input.files.length &&
    !comments.length &&
    !skills.selected.length &&
    !mcpDraft.length &&
    !references.length;
  const nextPrompt = useComposerPrediction({
    project,
    thread,
    action,
    enabled: prefs.nextPromptSuggestions,
    eligible:
      (ordinary || thread.conversation?.policy?.kind === "sideExecutableV2") &&
      !disabled &&
      !running &&
      !questions.length &&
      !approvals.length &&
      !creatingGoal &&
      !queueEditor.edit,
  });
  const predictionVisible =
    !input.files.length &&
    !comments.length &&
    !skills.selected.length &&
    !mcpDraft.length &&
    !references.length &&
    !annotationEditing &&
    !mcpOpen;
  const canContinue =
    !readOnly && !!interrupted && emptyDraft && !creatingGoal && !queueEditor.edit;
  const planActive = permissionMode(config ?? {}) === "plan";
  const executionPermission = planActive
    ? permissionMode({
        ...config,
        readOnly: false,
        options: planModeOptions(false, config?.options),
      })
    : permissionMode(config ?? {});
  const planReady = canExecutePlan(config ?? {}, thread, project.state?.queues?.[thread.id]);
  const clearText = () => {
    api.current?.clear();
    setText("");
    const remaining = files.filter((file) => !("kind" in file && file.kind === "pasted-text"));
    setFiles(remaining);
    attachmentDrafts.set(key, remaining);
    composerDraftStorage.removeItem(key);
  };
  const clear = () => {
    api.current?.clear();
    setText("");
    const remaining = (attachmentDrafts.get(key) ?? []).filter((file) => !files.includes(file));
    setFiles(remaining);
    // 后续消费操作会同步通知草稿监听器，先完成存储结算以免读回已发送内容。
    if (remaining.length) attachmentDrafts.set(key, remaining);
    else attachmentDrafts.delete(key);
    composerDraftStorage.removeItem(key);
    forgetComposerUploads(uploadOwner, files.filter(isComposerFile));
    skills.clear();
    plugins.clear();
    clearMcpDraft(key);
    consumeConversationSelections(selectionScope, references);
    void consumeSnapShotFiles(files.filter(isComposerFile));
    setAdmissionError("");
  };
  useEffect(() => {
    setGoalError("");
  }, [key]);
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
      api.current?.setText(draft);
      setText(draft);
      setFiles(attachmentDrafts.get(key) ?? []);
      api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  useEffect(() => {
    if (!unknown) return;
    const pendingOperation = project.pending.find(
      (entry: Data) => entry.params?.requestId === unknown,
    )?.operation;
    if (pendingOperation)
      composerDraftStorage.setItem(`${key}:pending-operation`, JSON.stringify(pendingOperation));
    if (pending) return;
    let operation: RecoveryOperation | undefined;
    try {
      operation =
        JSON.parse(composerDraftStorage.getItem(`${key}:pending-operation`) ?? "null") ?? undefined;
    } catch {}
    operation ??= project.outcomes?.[unknown]?.operation;
    const outcome = recoveredOutcome(project, unknown, thread.id, operation);
    if (!outcome) return;
    const turnStart = readingViews.get(
      JSON.stringify([project.id, thread.id, false]),
    )?.pendingTurnStart;
    if (outcome.accepted === false && turnStart?.requestId === unknown) cancelTurnStart(turnStart);
    composerDraftStorage.removeItem(`${key}:pending`);
    composerDraftStorage.removeItem(`${key}:pending-operation`);
    window.dispatchEvent(new Event("areal-snapshot-drain"));
    setUnknown(null);
    reconcileReviewSubmission(reviewKey, unknown, outcome.accepted !== false);
    const wasGoal = composerDraftStorage.getItem(`${key}:pending-goal`) === unknown;
    composerDraftStorage.removeItem(`${key}:pending-goal`);
    const wasContinue = composerDraftStorage.getItem(`${key}:pending-continue`) === unknown;
    composerDraftStorage.removeItem(`${key}:pending-continue`);
    const wasConfigure = composerDraftStorage.getItem(`${key}:pending-configure`) === unknown;
    composerDraftStorage.removeItem(`${key}:pending-configure`);
    if (outcome.status === "failed")
      setDeliveryNotice({ message: t("errors.turnFailed"), detail: outcome.message || undefined });
    else if (outcome.accepted === false)
      setDeliveryNotice({
        message: t("errors.turnRejected"),
        detail: outcome.message || undefined,
      });
    else if (wasContinue || wasConfigure) setDeliveryNotice(null);
    else if (wasGoal) {
      clearText();
      changeGoalMode(false);
    } else clear();
  }, [unknown, pending, project.outcomes]);
  useAutoReconcile(
    unknown,
    project.state?.connected === true,
    async () => {
      await readAction("reconcile", { projectId: project.id, requestId: unknown ?? undefined }).catch(() => {});
      await readAction("reconcile", { projectId: project.id }).catch(() => {});
    },
    () => {
      // 查不出来就到此为止：输入保留、解锁，只提示一次，由人看过对话后决定要不要再发。
      const turnStart = readingViews.get(
        JSON.stringify([project.id, thread.id, false]),
      )?.pendingTurnStart;
      if (turnStart?.requestId === unknown) cancelTurnStart(turnStart);
      for (const suffix of ["pending", "pending-operation", "pending-goal", "pending-continue", "pending-configure"])
        composerDraftStorage.removeItem(`${key}:${suffix}`);
      window.dispatchEvent(new Event("areal-snapshot-drain"));
      setUnknown(null);
      setDeliveryNotice({ message: t("recovery.sendUnresolved") });
    },
  );
  useEffect(() => {
    if (thread.goals?.goal && goalMode) changeGoalMode(false);
  }, [thread.goals?.goal?.id]);
  const submit = async (value: string, invert = false, approvePlan = false) => {
    if (
      workspaceReferencePending ||
      (readOnly && (creatingGoal || approvePlan || queueEditor.edit))
    )
      return;
    if (desktopUnsupported && !creatingGoal && !queueEditor.edit) return;
    const submittedInput = composerInput(value, files);
    if (
      disabled ||
      awaitingProjection ||
      annotationEditing ||
      invalidAnnotation ||
      sending.has(key)
    )
      return;
    if (hasMissingComposerFiles(files)) {
      setAdmissionError(t("chat.composer.missingAttachmentsBlockSend"));
      return;
    }
    if (queueEditor.edit) {
      await saveQueueEdit();
      return;
    }
    if (
      !submittedInput.text.trim() &&
      !submittedInput.files.length &&
      !comments.length &&
      !skills.selected.length &&
      !mcpDraft.length &&
      !references.length
    )
      return;
    if (approvePlan && (!planReady || input.text.trim() || input.files.length || comments.length))
      return;
    if (creatingGoal && (running || thread.parentThreadId || !submittedInput.text.trim())) return;
    if (!running && inspection.request()) return;
    setAdmissionError("");
    markSending(key, true);
    setGoalError("");
    setDeliveryNotice(null);
    let configurationRequestId: string | undefined;
    let sendStarted = false;
    const sideCommand = parseSideSlashCommand(
      submittedInput.text,
      submittedInput.files,
      sideContextCount,
      !!onSide &&
        !isSide &&
        !creatingGoal &&
        !taskManagement &&
        !matchMedia("(max-width: 640px)").matches,
      appEntries.map((entry) => entry.value),
    );
    const steer = !taskManagement && !!running && shouldSteer(prefs.followUp, invert);
    const enqueue = !taskManagement && !!running && !steer;
    const turnStart =
      !sideCommand && !creatingGoal && !steer && !enqueue
        ? requestTurnStart(project.id, thread.id, thread.turns?.at(-1)?.id)
        : undefined;
    if (!sideCommand && !creatingGoal && !enqueue)
      setPendingMessage(key, {
        text: submittedInput.text,
        files: submittedInput.files,
        previousUserIds: (thread.turns ?? []).flatMap((turn: Data) =>
          (turn.items ?? [])
            .filter((item: Data) => item.type === "userMessage")
            .map((item: Data) => item.id),
        ),
      });
    try {
      if (sideCommand && onSide) {
        await onSide(sideCommand.text);
        if (api.current?.getMarkdown() === value) clearText();
        return;
      }
      if (creatingGoal) {
        await action("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "goalCreate",
          expectedRevision: thread.goals?.revision ?? 0,
          objective: submittedInput.text,
          inferLimits: true,
        });
        clearText();
        changeGoalMode(false);
        return;
      }
      if (approvePlan) {
        configurationRequestId = crypto.randomUUID();
        await action("configure", {
          projectId: project.id,
          threadId: thread.id,
          requestId: configurationRequestId,
          expectedRevision: config?.revision,
          options: planModeOptions(false, config?.options),
        });
        configurationRequestId = undefined;
      }
      const sent = await submitMessage(action, project.id, thread.id, value, files, {
        onSendStart: () => {
          sendStarted = true;
        },
        uploadOwner,
        steer,
        expectedTurnId: running?.id,
        enqueue,
        skillAction: readAction,
        pluginContext,
        pluginMessages: {
          unavailable: t("chat.composer.pluginReferenceUnavailable"),
          intent: (name: string) => t("chat.composer.pluginReferenceIntent", { name }),
        },
      });
      clear();
      if (sent?.queued) {
        setPendingMessage(key);
        cancelTurnStart(turnStart);
      } else acceptPendingMessage(key);
    } catch (e) {
      setPendingMessage(key);
      const error = e as Error & {
        submissionUnknown?: boolean;
        requestId?: string;
      };
      if (!sendStarted || !error.submissionUnknown) cancelTurnStart(turnStart);
      else if (turnStart) turnStart.requestId = error.requestId;
      if (creatingGoal) setGoalError(goalControlError(error));
      else if (!(error.submissionUnknown && error.requestId)) {
        if (files.length > 0) {
          setAdmissionAttempt((attempt) => attempt + 1);
          setAdmissionError(admissionText(error));
        } else if (!error.submissionUnknown) showDeliveryNotice(error);
        else setAdmissionError(recoveryMessage(error, "operation", t));
      }
      if (error.submissionUnknown && error.requestId) {
        const failure = error as RecoveryFailure;
        if (failure.outcome && "operation" in failure.outcome)
          composerDraftStorage.setItem(
            `${key}:pending-operation`,
            JSON.stringify(failure.outcome.operation),
          );
        if (configurationRequestId)
          composerDraftStorage.setItem(`${key}:pending-configure`, error.requestId);
        if (creatingGoal) composerDraftStorage.setItem(`${key}:pending-goal`, error.requestId);
        setUnknown(error.requestId);
        composerDraftStorage.setItem(`${key}:pending`, error.requestId);
      }
    } finally {
      markSending(key, false);
    }
  };
  const continueExecution = async () => {
    if (desktopUnsupported || !canContinue || disabled || sending.has(key)) return;
    if (inspection.request()) return;
    markSending(key, true);
    setDeliveryNotice(null);
    try {
      await action("continue", {
        projectId: project.id,
        threadId: thread.id,
        expectedTurnId: interrupted.id,
        expectedConfigRevision: config?.revision,
      });
    } catch (cause) {
      const error = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (!error.submissionUnknown) showDeliveryNotice(error);
      if (error.submissionUnknown && error.requestId) {
        composerDraftStorage.setItem(`${key}:pending`, error.requestId);
        composerDraftStorage.setItem(`${key}:pending-continue`, error.requestId);
        setUnknown(error.requestId);
      }
    } finally {
      markSending(key, false);
    }
  };
  const configure = async (values: Data) => {
    if (readOnly || queueEditor.edit || disabled || running || sending.has(key) || !config) return;
    const requestId = configuration.begin(config.revision);
    markSending(key, true);
    try {
      await action("configure", {
        projectId: project.id,
        threadId: thread.id,
        requestId,
        expectedRevision: config?.revision,
        ...values,
      });
    } catch (cause) {
      configuration.clear();
      const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (failure.submissionUnknown) {
        const originalId = failure.requestId ?? requestId;
        setUnknown(originalId);
        composerDraftStorage.setItem(`${key}:pending`, originalId);
        composerDraftStorage.setItem(`${key}:pending-configure`, originalId);
        const outcome = (failure as RecoveryFailure).outcome;
        if (outcome && "operation" in outcome)
          composerDraftStorage.setItem(
            `${key}:pending-operation`,
            JSON.stringify(outcome.operation),
          );
      } else setAdmissionError(recoveryMessage(failure, "operation", t));
    } finally {
      markSending(key, false);
    }
  };
  const catalogActions: ComposerCatalogEntry[] = [
    ...(!readOnly &&
    onSide &&
    !input.files.length &&
    !sideContextCount &&
    !isSide &&
    !taskManagement &&
    !matchMedia("(max-width: 640px)").matches
      ? // /btw 是 /side 的别名，菜单只列一项，输入 /btw 仍可搜到并照常解析。
        ["side"]
          .filter(
            () => !appEntries.some((entry) => ["side", "btw"].includes(entry.value.toLowerCase())),
          )
          .map((name) => ({
            value: name,
            label: `/${name}`,
            keywords: ["btw", t("chat.side.title"), t("chat.side.btw")],
            description: t("chat.side.newDescription"),
            icon: <SideChatIcon />,
            group: "commands" as const,
            preserveInputUntilAccepted: true,
            disabled: disabled || !!queueEditor.edit,
            run: async () => {
              try {
                await onSide("");
              } catch (cause) {
                showDeliveryNotice(cause);
                throw cause;
              }
            },
          }))
      : []),
    ...(onMcpMention
      ? [
          {
            value: "app-mention",
            label: "@ 应用引用",
            description: "搜索应用中的文件、工单或其他资源",
            icon: <ComposerMcpIcon />,
            group: "功能" as const,
            run: onMcpMention,
          },
        ]
      : []),
    ...snapShotCommandEntries(snapshotCapture, t, (message) =>
      setDeliveryNotice(message ? { message } : null),
    ),
    ...composerFeatureEntries(t, {
      upload: { run: () => upload.current?.click() },
      mcp: { run: () => setMcpOpen(true) },
      files: { run: () => onPanel("文件") },
      plan: {
        active: planActive,
        disabled:
          disabled || taskManagement || !!running || !config || config.profile?.readOnly === true,
        run: () => {
          void configure({ options: planModeOptions(!planActive, config?.options) });
        },
      },
      goal:
        !readOnly && !isSide && !thread.goals?.goal
          ? {
              active: creatingGoal,
              disabled: disabled || taskManagement || !!running || !!thread.parentThreadId,
              run: () => changeGoalMode(!goalMode),
            }
          : undefined,
    }),
    {
      value: "compact",
      label: "压缩",
      description: "压缩当前上下文",
      icon: <ArchiveChatIcon />,
      group: "功能",
      disabled: !!running,
      run: () => {
        void action("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "contextCompact",
        }).catch(() => {});
      },
    },
  ];
  // TaskRun owns this worker's lifetime; its history is readable, but it is
  // not an independent conversation that can accept another user turn.
  const returnToRun = async () => {
    if (returning) return;
    setReturning(true);
    setReturnNotice(null);
    try {
      const listed = await action("tasks", {
        operation: "observe",
        projectId: project.id,
        limit: 1024,
      });
      if (listed.errors.length) throw listed.errors[0];
      const candidates = [...listed.data].sort(
        (a, b) =>
          Number(
            b.threadId === thread.goalOwner.threadId ||
              b.latestRun?.threadId === thread.goalOwner.threadId ||
              b.activeRun?.threadId === thread.goalOwner.threadId,
          ) -
          Number(
            a.threadId === thread.goalOwner.threadId ||
              a.latestRun?.threadId === thread.goalOwner.threadId ||
              a.activeRun?.threadId === thread.goalOwner.threadId,
          ),
      );
      for (const summary of candidates) {
        const task = await action("manage", {
          projectId: project.id,
          operation: "task",
          taskId: summary.id,
        });
        const run = task.runs.find((run) =>
          run.workers?.some((worker) => worker.threadId === thread.id),
        );
        if (!run || !onOpenTask) continue;
        onOpenTask({ projectId: project.id, taskId: task.id, runId: run.id });
        return;
      }
      throw new UiMessageError({ id: "errors.workerRunMissing" });
    } catch (cause) {
      setReturnNotice(presentError(t, cause));
    } finally {
      setReturning(false);
    }
  };
  if (thread.source === "nativeTaskAgent" && thread.goalOwner)
    return (
      <div className="composer-dock" data-v4-composer-dock="true">
        <p role="status" className="px-3 pt-3 text-ui-sm text-foreground-subtle">
          此 worker 由原 TaskRun 管理。打开历史不会重新执行已结束的工作。
        </p>
        {returnNotice && (
          <FeedbackNotice
            tone="error"
            message={returnNotice.message}
            detail={returnNotice.detail}
            onDismiss={() => setReturnNotice(null)}
          />
        )}
        <div className="px-3 py-3">
          <Button
            size="sm"
            variant="outline"
            disabled={returning}
            onClick={() => void returnToRun()}
          >
            {returning ? "正在返回…" : "返回原运行"}
          </Button>
        </div>
      </div>
    );
  const failedAttachment = input.files.find((file) => admissionError.startsWith(`${file.name}:`));
  const unknownAttachment =
    failedAttachment &&
    composerUploads(uploadOwner).states.get(failedAttachment)?.state === "unknown";
  const technicalAdmissionError = isTechnicalErrorMessage(admissionError);
  return (
    <div className="composer-dock" data-v4-composer-dock="true">
      {desktopUnsupported && (
        <span id={compatibilityDescription} className="sr-only">
          {t("backend.updateRequired")}
        </span>
      )}
      {!isSide && (
        <GoalCard
          project={project}
          thread={thread}
          action={action}
          onEdit={() => onPanel("编辑目标")}
        />
      )}
      <Input
        unstyled
        data-slot={undefined}
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
      {deliveryNotice && (
        <FeedbackNotice
          transient
          tone="error"
          message={deliveryNotice.message}
          detail={deliveryNotice.detail}
          onDismiss={() => setDeliveryNotice(null)}
        />
      )}
      {inspection.notice}
      {!readOnly && planReady && !queueEditor.edit && (
        <section
          className="flex items-center justify-between gap-3 px-3 py-2 text-ui-sm"
          aria-label="计划确认"
        >
          <span className="text-foreground-subtle">计划已完成。批准后将以自动编辑模式执行。</span>
          <Button
            size="sm"
            disabled={
              disabled ||
              desktopUnsupported ||
              !!input.text.trim() ||
              !!input.files.length ||
              !!comments.length
            }
            aria-describedby={desktopUnsupported ? compatibilityDescription : undefined}
            title={desktopUnsupported ? t("backend.updateRequired") : undefined}
            onClick={() => void submit("按上方已确认的计划执行。", false, true)}
          >
            批准并执行
          </Button>
        </section>
      )}
      <div className="composer-input-stack">
        <div ref={setMenuAnchor} className="composer-menu-anchor" />
        {/* 待决定事项在队列与输入框之上；队列仍贴着输入框，不会盖住决定卡。 */}
        {approvals.map((item: Data) => (
          <ApprovalRequest
            key={item.requestId}
            item={item}
            projectId={project.id}
            action={action}
          />
        ))}
        {questions.map((item: Data) => (
          <AskUserQuestion
            key={item.requestId}
            item={item}
            projectId={project.id}
            action={action}
          />
        ))}
        <ComposerQueue
          key={key}
          project={project}
          thread={thread}
          action={action}
          disabled={readOnly || baseDisabled || queueEditor.busy || executionBlocked}
          editingId={queueEditor.edit?.id}
          onEdit={(item) => {
            if (!readOnly && !disabled) void queueEditor.begin(item);
          }}
        />
        {goalError && (
          <FeedbackNotice tone="error" message={goalError} onDismiss={() => setGoalError("")} />
        )}
        {admissionError && (
          <FeedbackNotice
            id={`composer-admission:${key}:${admissionAttempt}`}
            tone="error"
            message={
              unknownAttachment
                ? `${failedAttachment.name}: ${t("chat.composer.attachmentUnknown")}`
                : technicalAdmissionError
                  ? `${failedAttachment ? `${failedAttachment.name}: ` : ""}${t("recovery.operationFailed")}`
                  : admissionError
            }
            detail={technicalAdmissionError || unknownAttachment ? admissionError : undefined}
            onDismiss={() => setAdmissionError("")}
          />
        )}
        {reviewDraft.error && <FeedbackNotice tone="error" message={reviewDraft.error} />}
        {thread.desktop?.workflowRun && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-ui-sm text-foreground-subtle">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                const storageKey = `areal-gui:workgroup:${project.id}`;
                composerDraftStorage.setItem(storageKey, thread.desktop.workflowRun.workgroupId);
                document.dispatchEvent(
                  new CustomEvent("areal:workgroup-operation", {
                    detail: storageKey,
                  }),
                );
                onPanel("工作组");
              }}
            >
              查看关联工作流结果
            </Button>
          </div>
        )}
        <ConversationComposer
          nextPrompt={predictionVisible ? nextPrompt : undefined}
          surfaceLayout={
            !queueEditor.edit && (approvals.length || questions.length) ? "decision" : surfaceLayout
          }
          surfacePlacement={surfacePlacement}
          project={project}
          contextControl={
            !readOnly && (
              <ContextMeter
                key={`${project.id}:${thread.id}`}
                project={project}
                thread={thread}
                action={readAction}
                anchor={menuAnchor}
              />
            )
          }
          modelConfig={config}
          modelDisabled={
            readOnly ||
            editorDisabled ||
            executionBlocked ||
            !!queueEditor.edit ||
            !!running ||
            !config
          }
          modelPending={configuring}
          onConfigureModel={configure}
          triggerPanelContainer={menuAnchor}
          className={
            !queueEditor.edit
              ? approvals.length || questions.length
                ? "interaction-composer-compact"
                : undefined
              : undefined
          }
          shellClassName="@container/composer"
          workspacePath={project.root}
          referenceScope={
            queueEditor.edit ? `${queueEditor.edit.id}:${queueEditor.edit.phase}` : "draft"
          }
          enableWorkspaceFileDrop={!!project.root && !editorDisabled}
          enableExternalFileDrop={!editorDisabled}
          validateWorkspaceFile={workspaceFiles?.validate}
          resolveWorkspaceDirectory={workspaceFiles?.directory}
          onFileDrop={(files) => setFiles((current) => [...current, ...files])}
          onWorkspaceReferencePendingChange={setWorkspaceReferencePending}
          taskId={thread.id}
          initialValue={outgoing ? "" : text}
          inputApiRef={api}
          inputTestId={inputTestId}
          submitTestId={submitTestId}
          hasDraftContent={
            !outgoing &&
            (!!files.length ||
              !!comments.length ||
              !!skills.selected.length ||
              !!mcpDraft.length ||
              !!references.length ||
              !!queueEditor.edit?.attachments.length)
          }
          placeholder={
            archived
              ? "已归档任务只读"
              : creatingGoal
                ? "描述目标，明确可衡量的结果"
                : planActive
                  ? "描述任务，生成计划…"
                  : approvals.length || questions.length
                    ? t("chat.composer.approvalPlaceholder")
                    : t("chat.composer.placeholder")
          }
          disabled={editorDisabled}
          submitDisabled={
            workspaceReferencePending ||
            disabled ||
            awaitingProjection ||
            (desktopUnsupported && !queueEditor.edit && !creatingGoal) ||
            (readOnly && creatingGoal) ||
            (taskManagement && !!running) ||
            annotationEditing ||
            invalidAnnotation ||
            (queueEditor.edit
              ? queueEditor.saveDisabled ||
                (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length)
              : creatingGoal
                ? !input.text.trim() || !!running
                : !canContinue && emptyDraft)
          }
          submitDisabledReason={
            desktopUnsupported && !queueEditor.edit && !creatingGoal
              ? t("backend.updateRequired")
              : undefined
          }
          submitting={busy && !configuring}
          submitLabel={inspection.submitLabel(!!queueEditor.edit, creatingGoal, canContinue)}
          enterSubmits={prefs.sendShortcut === "enter"}
          enableMentionPanel={false}
          workspaceFiles={workspaceFiles}
          pluginMentionCatalog={{
            ...plugins.catalog,
            entries: [...(queueEditor.edit ? [] : plugins.catalog.entries), ...referenceEntries],
            searchLabel: t("chat.composer.searchReferences"),
            label: t("chat.composer.references"),
            appGroupLabel: plugins.catalog.label,
          }}
          composerCatalog={{
            ...skills.catalog,
            entries: [
              ...catalogActions.filter((entry) => !readOnly || entry.value !== "plan"),
              ...referenceEntries,
              ...appEntries,
              ...skills.catalog.entries,
            ].map((entry) => ({
              ...entry,
              disabled:
                entry.disabled ||
                (!!queueEditor.edit &&
                  entry.group !== "会话" &&
                  !["upload", "files", "mcp"].includes(entry.value)),
            })),
          }}
          onChange={(value) => {
            if (outgoing) return;
            setText(value);
            composerDraftStorage.scheduleItem(key, value);
            composerDraftStorage.scheduleItem(
              `${key}:version`,
              String(Number(composerDraftStorage.getItem(`${key}:version`) ?? 0) + 1),
            );
          }}
          allowSubmitWhenEmpty={canContinue || !!references.length}
          onSubmit={(value) => {
            if (canContinue) void continueExecution();
            else void submit(value);
            return false;
          }}
          onModifiedSubmit={
            prefs.sendShortcut === "enter"
              ? (value) => {
                  if (canContinue) void continueExecution();
                  else void submit(value, !!running);
                  return false;
                }
              : undefined
          }
          onPaste={(event) =>
            composerPaste(event, (pasted) => setFiles((current) => [...current, ...pasted]))
          }
          topContent={
            <div hidden={!!outgoing}>
              {queueEditor.edit && (
                <div className="composer-queue-edit-banner" aria-label="编辑排队消息">
                  <span>
                    {queueEditor.edit.phase === "opening" ? "等待确认暂停队列" : "编辑排队消息"}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={
                      queueEditor.busy || !!queueEditor.edit.unknown || pending || executionBlocked
                    }
                    onClick={() => {
                      if (!executionBlocked) void queueEditor.cancel();
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      workspaceReferencePending ||
                      disabled ||
                      queueEditor.saveDisabled ||
                      (!input.text.trim() &&
                        !input.files.length &&
                        !queueEditor.edit.attachments.length)
                    }
                    onClick={() => void saveQueueEdit()}
                  >
                    保存
                  </Button>
                </div>
              )}
              {queueEditor.feedback && (
                <FeedbackNotice transient tone="error" message={queueEditor.feedback} />
              )}
              {!queueEditor.edit && (
                <ConversationSelectionReferences
                  references={references}
                  disabled={editorDisabled}
                  onRemove={(id) =>
                    consumeConversationSelections(
                      selectionScope,
                      references.filter((reference) => reference.id === id),
                    )
                  }
                />
              )}
              {!queueEditor.edit && skills.tags}
              <BrowserAnnotationAttachments
                files={files}
                disabled={editorDisabled}
                onChange={setFiles}
              />
              <div className="composer-attachment-row">
                {!!queueEditor.edit?.attachments.length && (
                  <div className="composer-attachments">
                    {queueEditor.edit.attachments.map((part, index) => (
                      <ComposerQueueAttachment
                        key={`${index}:${part.url}`}
                        part={part}
                        projectId={project.id}
                        threadId={thread.id}
                        action={readAction}
                        disabled={editorDisabled}
                        onRemove={() => queueEditor.removeAttachment(index)}
                      />
                    ))}
                  </div>
                )}
                <ComposerFileList
                  files={files}
                  onChange={setFiles}
                  disabled={editorDisabled}
                  editor={api}
                  include={(file) => !isComposerFile(file) || !browserAnnotation(file)}
                  uploadOwner={uploadOwner}
                  onForget={(file) => forgetComposerUploads(uploadOwner, [file])}
                  onRetry={async (file) => {
                    setAdmissionError("");
                    try {
                      await uploadComposerFiles(
                        action,
                        project.id,
                        thread.id,
                        [file],
                        undefined,
                        uploadOwner,
                      );
                    } catch (cause) {
                      setAdmissionAttempt((attempt) => attempt + 1);
                      setAdmissionError(admissionText(cause));
                    }
                  }}
                  onAnnotate={
                    onAnnotate &&
                    ((file) =>
                      onAnnotate({ draftKey: key, file, returnFocus: () => api.current?.focus() }))
                  }
                />
                {!queueEditor.edit && (
                  <ReviewCommentAttachment
                    comments={comments}
                    disabled={editorDisabled}
                    onRemove={() => detachReviewComments(reviewKey)}
                  />
                )}
                {!queueEditor.edit && (
                  <McpComposerAttachments
                    draftKey={key}
                    entries={mcpDraft}
                    disabled={editorDisabled}
                  />
                )}
              </div>
            </div>
          }
          promptHistory={(thread.turns ?? []).flatMap((t: Data) =>
            (t.items ?? [])
              .filter(
                (i: Data) =>
                  i.type === "userMessage" &&
                  !t.continuedFromTurnId &&
                  !(
                    goalContinuationLabel(t) &&
                    i.id === t.items.find((entry: Data) => entry.type === "userMessage")?.id
                  ),
              )
              .map((i: Data) =>
                stripGenUiModelContext(
                  (i.content ?? [])
                    .filter((p: Data) => p.type === "text")
                    .map((p: Data) => p.text)
                    .join("\n"),
                ),
              ),
          )}
          leadingActions={
            <>
              {!readOnly && (
                <ComposerPermissionMenu
                  value={executionPermission}
                  configuration={config}
                  permissionsSupported={project.core?.features?.permissionPresets === true}
                  fullAccessAvailable={project.core?.features?.permissionFullAccess === true}
                  disabled={disabled || !!queueEditor.edit || !!running || !config}
                  lockedReadOnly={taskManagement || executionPermission === "readOnly"}
                  onClose={() => api.current?.focus()}
                  onChange={(mode) => {
                    setApplicationPreferences({ defaultPermissionPreset: mode });
                    void configure({
                      options: planModeOptions(
                        planActive,
                        permissionOptions(mode, config?.options),
                      ),
                    });
                  }}
                />
              )}
              {planActive && (
                <ComposerPlanMode
                  disabled={
                    readOnly ||
                    disabled ||
                    !!queueEditor.edit ||
                    !!running ||
                    config?.profile?.readOnly === true
                  }
                  onExit={() => {
                    void configure({
                      options: planModeOptions(false, config?.options),
                    });
                  }}
                />
              )}
              {creatingGoal && (
                <ComposerGoalMode
                  disabled={disabled || !!queueEditor.edit}
                  onExit={() => changeGoalMode(false)}
                />
              )}
            </>
          }
          onCancel={
            queueEditor.edit
              ? () => {
                  if (!executionBlocked) void queueEditor.cancel();
                }
              : running
                ? stop
                : undefined
          }
          submitControl={
            queueEditor.edit ? (
              <Button
                type="button"
                size="icon"
                aria-label="保存排队消息"
                data-testid={submitTestId}
                disabled={
                  workspaceReferencePending ||
                  disabled ||
                  queueEditor.saveDisabled ||
                  (!input.text.trim() &&
                    !input.files.length &&
                    !queueEditor.edit.attachments.length)
                }
                className="composer-primary-action"
                onClick={() => void saveQueueEdit()}
              >
                <SendMessageIcon className="size-5" />
              </Button>
            ) : running &&
              !input.text.trim() &&
              !input.files.length &&
              !comments.length &&
              !skills.selected.length &&
              !mcpDraft.length &&
              !references.length ? (
              <ControlHintTooltip title={ordinary ? "暂停执行" : "停止"} shortcut="Esc">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="composer-primary-action composer-stop-action"
                  aria-label={ordinary ? "暂停执行" : "停止"}
                  disabled={executionBlocked}
                  onClick={() => {
                    stop();
                    api.current?.focus();
                  }}
                >
                  <StopIcon className="size-4" />
                </Button>
              </ControlHintTooltip>
            ) : running ? (
              <ControlHintTooltip
                title={desktopUnsupported ? t("backend.updateRequired") : "发送"}
                shortcut={prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"}
              >
                <ComposerActionButton
                  type="button"
                  size="icon"
                  aria-label="发送"
                  data-testid={submitTestId}
                  aria-describedby={desktopUnsupported ? compatibilityDescription : undefined}
                  disabled={
                    disabled ||
                    awaitingProjection ||
                    desktopUnsupported ||
                    taskManagement ||
                    (readOnly && creatingGoal) ||
                    (!input.text.trim() &&
                      !input.files.length &&
                      !comments.length &&
                      !skills.selected.length &&
                      !mcpDraft.length &&
                      !references.length)
                  }
                  onClick={(event) =>
                    void submit(api.current?.getMarkdown() ?? text, event.metaKey || event.ctrlKey)
                  }
                >
                  <SendMessageIcon className="size-5" />
                </ComposerActionButton>
              </ControlHintTooltip>
            ) : canContinue ? (
              <ControlHintTooltip
                title={desktopUnsupported ? t("backend.updateRequired") : "继续执行"}
              >
                <ComposerActionButton
                  type="button"
                  size="icon"
                  aria-label="继续执行"
                  data-testid="chat-continue-button"
                  aria-describedby={desktopUnsupported ? compatibilityDescription : undefined}
                  disabled={disabled || desktopUnsupported}
                  className="composer-primary-action"
                  onClick={() => void continueExecution()}
                >
                  <ContinueExecutionIcon className="size-5" />
                </ComposerActionButton>
              </ControlHintTooltip>
            ) : undefined
          }
        />
      </div>
      <ComposerMcp
        projectId={project.id}
        action={readAction}
        open={mcpOpen}
        anchor={menuAnchor}
        onClose={() => {
          setMcpOpen(false);
          api.current?.focus();
        }}
      />
      <div className="composer-caption sr-only">
        {prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"} 发送 · Shift+Enter 换行 · / 命令
      </div>
    </div>
  );
}

export function stageThreadDraft(
  projectId: string,
  threadId: string,
  text: string,
  files: ComposerDraftAttachment[],
) {
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  composerDraftStorage.setItem(key, text);
  attachmentDrafts.set(key, files);
  return key;
}
