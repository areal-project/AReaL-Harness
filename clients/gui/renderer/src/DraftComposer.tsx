import type { DraftComposerProps } from "./draftComposerTypes.js";
import { PendingMessageView } from "./UserMessageBody.js";
import { setPendingMessage, usePendingMessage } from "./pendingMessage.js";
import { Input } from "@areal/ui";
import { useComposerWorkspaceFiles } from "./lib/workspaceFileComposer.js";
import { imageAnnotationBlocked, useImageAnnotationRevision } from "./imageAnnotations.js";
import { resolveDraftProfile } from "./ProfileDetails.js";
import { draftModelSelection, modelValue } from "./lib/draftModelSelection.js";
import {
  setApplicationPreferences,
  useApplicationPreferences,
} from "./settings/applicationPreferences.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import { permissionOptions, planModeOptions, type PermissionPreset } from "./permissions.js";
import { ComposerPlanMode } from "./ComposerPlanMode.js";
import { FileTree, AttachmentIcon, GoalIcon, PlanModeIcon as Lightbulb } from "./interfaceIcons.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import {
  ComposerAttachment,
  composerInput,
  composerPaste,
  isComposerFile,
  type ComposerDraftAttachment,
} from "./ComposerAttachments.js";
import {
  useComposerPlugins,
  revalidateComposerPlugins,
  clearComposerPlugins,
  transferComposerPlugins,
} from "./ComposerPlugins.js";
import {
  useComposerSkills,
  transferComposerSkills,
  clearComposerSkills,
  readComposerSkills,
} from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { ComposerMcp } from "./ComposerMcp.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { CircleAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./components/ui/dropdown-menu.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { Button } from "./components/ui/button.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Data } from "./services.js";
import { conversationReferenceEntries } from "./ConversationReferences.js";
import {
  isIndependentCreation,
  isTechnicalErrorMessage,
  recoveredOutcome,
  recoveryMessage,
  type RecoveryFailure,
} from "./recoveryPresentation.js";
import {
  attachedReviewComments,
  detachReviewComments,
  reviewCommentKey,
  transferNewReviewComments,
  useReviewComments,
} from "./reviewComments.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
import { WorktreeStatus } from "./WorktreeStatus.js";
import {
  attachmentDrafts,
  attachmentErrors,
  sending,
  subscribeSending,
  markSending,
  stageThreadDraft,
  submitMessage,
} from "./Composer.js";

export function DraftComposer({
  project,
  backendReady = false,
  action,
  readAction,
  onOpen,
  onPanel,
  appEntries = [],
  conversationReferences = [],
  draftKey,
  prepareProject,
  preparationStatus,
  modelCatalogReady = false,
  onAnnotate,
  surfaceLayout = "default",
  worktree,
  onWorktreeCreated,
}: DraftComposerProps) {
  const workspaceFiles = useComposerWorkspaceFiles(readAction, project, draftKey ?? "new");
  const { t } = useI18n();
  const referenceEntries = conversationReferenceEntries(
    conversationReferences,
    t("chat.composer.conversationReference"),
  );
  const prefs = useApplicationPreferences();
  const defaultPermissionPreset = useRef(prefs.defaultPermissionPreset);
  defaultPermissionPreset.current = prefs.defaultPermissionPreset;
  const key = draftKey ?? `areal-gui:draft:${project.id}:new`;
  const reviewKey = reviewCommentKey(project.id, "new");
  const reviewDraft = useReviewComments(reviewKey);
  const comments = attachedReviewComments(reviewDraft.draft);
  const api = useRef<LexicalChatInputHandle | null>(null);
  const [workspaceReferencePending, setWorkspaceReferencePending] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  const [draftError, setDraftError] = useState("");
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key || sending.has(key)) return;
      const draft = localStorage.getItem(key) ?? "";
      setProfileSelection(localStorage.getItem(`${key}:profile`) ?? "");
      api.current?.setText(draft);
      setText(draft);
      setFiles(attachmentDrafts.get(key) ?? []);
      api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  const [files, setFiles] = useState<ComposerDraftAttachment[]>(
    () => attachmentDrafts.get(key) ?? [],
  );
  const input = composerInput(text, files);
  useImageAnnotationRevision();
  const annotationBlocked = imageAnnotationBlocked(key, input.files);
  const [permission, setPermission] = useState<PermissionPreset>(() => {
    const saved = localStorage.getItem(`${key}:permission`);
    return saved === "ask" || saved === "autoReview" || saved === "fullAccess"
      ? saved
      : prefs.defaultPermissionPreset;
  });
  const [plan, setPlan] = useState(() => localStorage.getItem(`${key}:plan`) === "true");
  const [profileSelection, setProfileSelection] = useState(
    () => localStorage.getItem(`${key}:profile`) ?? "",
  );
  const chosenProfile = resolveDraftProfile(project, profileSelection);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [goalMode, setGoalMode] = useState(() => localStorage.getItem(`${key}:goal`) === "true");
  const changeGoalMode = (enabled: boolean) => {
    setGoalMode(enabled);
    localStorage.setItem(`${key}:goal`, String(enabled));
    api.current?.focus();
  };
  const [efforts, setEfforts] = useState<Record<string, string>>(() =>
    localStorage.getItem(`${key}:model`) !== null
      ? JSON.parse(localStorage.getItem(`${key}:efforts`) ?? "{}")
      : {},
  );
  const [requestedServiceTier, setRequestedServiceTier] = useState<"fast" | "default" | undefined>(
    () => {
      const saved = localStorage.getItem(`${key}:service-tier`);
      return saved === "fast" || saved === "default" ? saved : undefined;
    },
  );
  const unavailableProfile = !!(profileSelection || project.defaultProfile) && !chosenProfile;
  const setPlanMode = (enabled: boolean) => {
    setPlan(enabled);
    localStorage.setItem(`${key}:plan`, String(enabled));
  };
  const [model, setModel] = useState<string | null>(() => localStorage.getItem(`${key}:model`));
  const { effectiveModel, currentModel, effort, serviceTier, notice } = draftModelSelection(
    project,
    chosenProfile,
    model,
    efforts,
    requestedServiceTier,
  );
  const preferenceNotice = notice ? t("chat.composer.previousEffortUnsupported") : "";
  const [unknown, setUnknown] = useState(() => localStorage.getItem(`${key}:pending-create`));
  const [checkingCreation, setCheckingCreation] = useState(false);
  const [creationChecked, setCreationChecked] = useState(false);
  const acceptedRecovery = useRef<string | null>(null);
  const [activeCreation, setActiveCreation] = useState<{
    requestId: string;
    text: string;
    worktree: boolean;
  }>();
  const stoppedCreation = useRef(new Set<string>());
  const [cancellingCreation, setCancellingCreation] = useState(false);
  const [sourceRetry, setSourceRetry] = useState<string>();
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const outgoing = usePendingMessage(key);
  const editLocked = busy || !!unknown || !!reviewDraft.error;
  const executionReady = backendReady && !!project.state?.connected;
  const modelReady = executionReady || (backendReady && !!prepareProject && modelCatalogReady);
  const modelSelectionDisabled = editLocked || !modelReady || unavailableProfile;
  const blockingPending = project.pending.filter(
    (entry: Data) => !isIndependentCreation(entry, [unknown, activeCreation?.requestId]),
  );
  const submitDisabled = modelSelectionDisabled || !!blockingPending.length || !effectiveModel;
  const desktopUnsupported = project.desktopCapabilities?.currentCommands === false;
  const skills = useComposerSkills({
    project: executionReady
      ? project
      : { ...project, state: { ...project.state, connected: false } },
    profile: chosenProfile,
    draftKey: key,
    action: readAction,
    disabled: editLocked || !executionReady,
  });
  const pluginContext = {
    kind: "mainDraft" as const,
    projectId: project.id,
    coreInstanceId: project.core?.instanceId,
    connectionGeneration: project.core?.connectionGeneration,
    ...(chosenProfile
      ? { profile: { id: chosenProfile.id, revision: chosenProfile.revision } }
      : {}),
  };
  const plugins = useComposerPlugins({
    project,
    context: pluginContext,
    draftKey: key,
    text: input.text,
    action: readAction,
  });
  const finishRecoveredCreation = (id: string) => {
    if (acceptedRecovery.current === unknown) return;
    transferNewReviewComments(project.id, id);
    acceptedRecovery.current = unknown;
    stageThreadDraft(
      project.id,
      id,
      localStorage.getItem(key) ?? "",
      attachmentDrafts.get(key) ?? [],
    );
    transferComposerSkills(key, `areal-gui:draft:${project.id}:${id}`);
    transferComposerPlugins(key, `areal-gui:draft:${project.id}:${id}`);
    if (goalMode) localStorage.setItem(`areal-gui:draft:${project.id}:${id}:goal`, "true");
    localStorage.removeItem(`${key}:pending-create`);
    localStorage.removeItem(`${key}:pending-create-request`);
    onWorktreeCreated?.();
    setUnknown(null);
    clear();
    void onOpen(project.id, id);
  };
  const checkCreation = async () => {
    if (!unknown || checkingCreation) return;
    const requestId = unknown;
    setCheckingCreation(true);
    setDraftError("");
    try {
      const frozen = JSON.parse(localStorage.getItem(`${key}:pending-create-request`) ?? "null");
      if (frozen && (frozen.requestId !== requestId || frozen.projectId !== project.id))
        throw new Error(t("worktree.recoveryMismatch"));
      const result = await readAction("reconcile", { projectId: project.id, requestId });
      if (!mounted.current || localStorage.getItem(`${key}:pending-create`) !== requestId) return;
      const outcome = recoveredOutcome({ ...project, outcomes: result.outcomes }, requestId, "");
      const creationOutcome =
        outcome && (!outcome.operation || outcome.operation.method === "areal/thread/start")
          ? outcome
          : undefined;
      if (creationOutcome?.status === "failed" || creationOutcome?.accepted === false) {
        localStorage.removeItem(`${key}:pending-create`);
        localStorage.removeItem(`${key}:pending-create-request`);
        setUnknown(null);
        setDraftError(
          creationOutcome.admissionState === "notAdmitted"
            ? t("recovery.creationNotAdmitted")
            : creationOutcome.message || "创建对话未完成，草稿已保留，请检查后重试。",
        );
        return;
      }
      const worktreeRecord = await readAction("workspace", {
        projectId: project.id,
        operation: "worktreeRead",
        requestId,
      });
      if (!mounted.current || localStorage.getItem(`${key}:pending-create`) !== requestId) return;
      if (worktreeRecord.state === "ready" && worktreeRecord.threadId) {
        finishRecoveredCreation(worktreeRecord.threadId);
        return;
      }
      if (
        worktreeRecord.state === "missing" &&
        creationOutcome?.accepted === true &&
        creationOutcome.threadId
      ) {
        finishRecoveredCreation(creationOutcome.threadId);
        return;
      }
      setCreationChecked(true);
      setDraftError(t("worktree.unknown"));
    } catch (cause) {
      if (!mounted.current || localStorage.getItem(`${key}:pending-create`) !== requestId) return;
      const failure = cause as RecoveryFailure;
      setDraftError(recoveryMessage(failure));
      if (failure.submissionUnknown === true) setCreationChecked(true);
    } finally {
      setCheckingCreation(false);
    }
  };
  const leaveCreationForInspection = () => {
    if (
      !unknown ||
      checkingCreation ||
      !creationChecked ||
      !window.confirm(t("worktree.leavePendingConfirm"))
    )
      return;
    localStorage.setItem(
      `${key}:retained-create:${unknown}`,
      JSON.stringify({
        requestId: unknown,
        request: localStorage.getItem(`${key}:pending-create-request`),
      }),
    );
    localStorage.removeItem(`${key}:pending-create`);
    localStorage.removeItem(`${key}:pending-create-request`);
    setUnknown(null);
    setActiveCreation(undefined);
    setCreationChecked(false);
    setDraftError("");
    onWorktreeCreated?.();
  };
  useEffect(() => {
    attachmentDrafts.set(key, files);
    window.dispatchEvent(new CustomEvent("areal-attachments-change", { detail: key }));
  }, [key, files]);
  const clear = () => {
    detachReviewComments(reviewKey);
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}:permission`);
    localStorage.removeItem(`${key}:plan`);
    localStorage.removeItem(`${key}:model`);
    localStorage.removeItem(`${key}:efforts`);
    localStorage.removeItem(`${key}:service-tier`);
    localStorage.removeItem(`${key}:profile`);
    setModel(null);
    setEfforts({});
    setRequestedServiceTier(undefined);
    setPermission(defaultPermissionPreset.current);
    setPlan(false);
    setProfileSelection("");
    attachmentDrafts.delete(key);
    skills.clear();
    plugins.clear();
    changeGoalMode(false);
    api.current?.clear();
    setText("");
    setFiles([]);
  };
  useEffect(() => {
    if (!unknown || stoppedCreation.current.has(unknown)) return;
    const outcome = recoveredOutcome(project, unknown, "");
    if (!outcome || (outcome.operation && outcome.operation.method !== "areal/thread/start"))
      return;
    if (outcome.status === "failed" || outcome.accepted === false) {
      localStorage.removeItem(`${key}:pending-create`);
      localStorage.removeItem(`${key}:pending-create-request`);
      setUnknown(null);
      setDraftError(
        outcome.admissionState === "notAdmitted"
          ? t("recovery.creationNotAdmitted")
          : outcome.message || "创建对话未完成，草稿已保留，请检查后重试。",
      );
      return;
    }
    if (!outcome.threadId || outcome.accepted !== true) return;
    const worktreeRecord = project.worktreeOperations?.findLast(
      (item: Data) => item.requestId === unknown,
    );
    if (worktreeRecord && worktreeRecord.state !== "ready") return;
    try {
      finishRecoveredCreation(outcome.threadId);
    } catch (cause) {
      setDraftError((cause as Error).message);
      return;
    }
  }, [unknown, project.pending.length, project.outcomes, project.worktreeOperations]);
  const submit = async (value: string, selection = worktree) => {
    if (workspaceReferencePending) return;
    const submittedInput = composerInput(value, files);
    if (
      (desktopUnsupported && !goalMode) ||
      submitDisabled ||
      annotationBlocked ||
      sending.has(key) ||
      (!submittedInput.text.trim() &&
        !submittedInput.files.length &&
        !comments.length &&
        !skills.selected.length) ||
      (goalMode && !submittedInput.text.trim())
    )
      return;
    markSending(key, true);
    if (!goalMode && selection?.mode !== "worktree")
      setPendingMessage(key, {
        text: submittedInput.text,
        files: submittedInput.files,
        previousUserIds: [],
        starting: true,
      });
    setDraftError("");
    let targetKey: string | undefined;
    let creationAttempted = false;
    const creationRequestId = crypto.randomUUID();
    try {
      const owner = prepareProject ? await prepareProject() : project;
      if (owner.desktopCapabilities?.currentCommands === false && !goalMode)
        throw new Error("更新后台后可发送消息，草稿已保留。");
      const profile = resolveDraftProfile(owner, profileSelection);
      if ((profileSelection || owner.defaultProfile) && !profile)
        throw new Error("当前任务配置不可用，输入已保留。");
      const separator = effectiveModel.indexOf("/");
      const chosenModel = owner.models.find((item: Data) => modelValue(item) === effectiveModel) ??
        currentModel ?? {
          providerId: effectiveModel.slice(0, separator) || null,
          modelId: effectiveModel.slice(separator + 1),
        };
      await revalidateComposerPlugins(
        readAction,
        {
          kind: "mainDraft",
          projectId: owner.id,
          coreInstanceId: owner.core?.instanceId,
          connectionGeneration: owner.core?.connectionGeneration,
          ...(profile ? { profile: { id: profile.id, revision: profile.revision } } : {}),
        },
        key,
        submittedInput.text,
        t("chat.composer.pluginReferenceUnavailable"),
      );
      const selectedSkills = readComposerSkills(key);
      if (selectedSkills.length) {
        if (!profile) throw new Error("当前任务配置不可用，技能草稿已保留。");
        const available = await readAction("manage", {
          projectId: owner.id,
          operation: "skills",
          agentProfile: { id: profile.id, revision: profile.revision },
        });
        if (
          selectedSkills.some(
            (skill) =>
              !(available.data ?? []).some(
                (item: Data) =>
                  item.available && item.id === skill.id && item.revision === skill.revision,
              ),
          )
        )
          throw new Error("当前任务配置未提供所选 Skill 的确切版本，草稿已保留。");
      }
      const parameters = { ...chosenModel.parameters };
      delete parameters.reasoningEffort;
      if (effort) parameters.reasoningEffort = effort;
      if (requestedServiceTier) parameters.serviceTier = requestedServiceTier;
      if (chosenModel.capabilities?.reasoning === false) delete parameters.reasoningSummary;
      creationAttempted = true;
      const creationRequest = {
        projectId: owner.id,
        requestId: creationRequestId,
        parameters,
        options: planModeOptions(plan, permissionOptions(permission)),
        ...(profileSelection && profile
          ? { profile: { id: profile.id, revision: profile.revision } }
          : {}),
        ...(chosenModel.providerId
          ? { model: { providerId: chosenModel.providerId, modelId: chosenModel.modelId } }
          : {}),
        ...(selection ? { worktree: { ...selection } } : {}),
      };
      localStorage.setItem(`${key}:pending-create-request`, JSON.stringify(creationRequest));
      setActiveCreation({
        requestId: creationRequestId,
        text: value,
        worktree: selection?.mode === "worktree",
      });
      const result = await readAction("create", creationRequest);
      if (stoppedCreation.current.has(creationRequestId)) return;
      localStorage.removeItem(`${key}:pending-create-request`);
      onWorktreeCreated?.();
      targetKey = stageThreadDraft(owner.id, result.threadId, value, files);
      transferNewReviewComments(owner.id, result.threadId);
      transferComposerSkills(key, targetKey);
      transferComposerPlugins(key, targetKey);
      if (goalMode) localStorage.setItem(`${targetKey}:goal`, "true");
      markSending(targetKey, true);
      if (!goalMode)
        setPendingMessage(targetKey, {
          text: submittedInput.text,
          files: submittedInput.files,
          previousUserIds: [],
        });
      clear();
      // Show the accepted task immediately, including while the first model request waits.
      if (mounted.current) void onOpen(owner.id, result.threadId);
      if (goalMode) {
        const latest = await action("manage", {
          projectId: owner.id,
          threadId: result.threadId,
          operation: "goal",
        });
        await action("manage", {
          projectId: owner.id,
          threadId: result.threadId,
          operation: "goalCreate",
          objective: submittedInput.text,
          expectedRevision: latest.revision ?? 0,
          inferLimits: true,
        });
        localStorage.removeItem(`${targetKey}:goal`);
        attachmentDrafts.set(targetKey, submittedInput.files);
      } else {
        await submitMessage(action, owner.id, result.threadId, value, files, {
          skillAction: readAction,
          pluginContext: {
            kind: "mainThread",
            projectId: owner.id,
            threadId: result.threadId,
            coreInstanceId: owner.core?.instanceId,
            connectionGeneration: owner.core?.connectionGeneration,
          },
          pluginMessages: {
            unavailable: t("chat.composer.pluginReferenceUnavailable"),
            intent: (name: string) => t("chat.composer.pluginReferenceIntent", { name }),
          },
        });
        attachmentDrafts.delete(targetKey);
        clearComposerSkills(targetKey);
        clearComposerPlugins(targetKey);
      }
      localStorage.removeItem(targetKey);
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: targetKey }));
    } catch (e) {
      const failure = e as RecoveryFailure;
      if (stoppedCreation.current.has(creationRequestId)) return;
      if (!failure.submissionUnknown) {
        localStorage.removeItem(`${key}:pending-create-request`);
        setDraftError(recoveryMessage(failure));
        if (targetKey) attachmentErrors.set(targetKey, recoveryMessage(failure));
      }
      const requestId = failure.requestId ?? (!targetKey ? creationRequestId : undefined);
      if (creationAttempted && failure.submissionUnknown && requestId) {
        if (targetKey) {
          localStorage.setItem(`${targetKey}:pending`, requestId);
          if (failure.outcome && "operation" in failure.outcome)
            localStorage.setItem(
              `${targetKey}:pending-operation`,
              JSON.stringify(failure.outcome.operation),
            );
          if (goalMode) localStorage.setItem(`${targetKey}:pending-goal`, requestId);
        } else {
          localStorage.setItem(`${key}:pending-create`, requestId);
          setUnknown(requestId);
        }
      }
    } finally {
      setPendingMessage(key);
      if (targetKey) {
        setPendingMessage(targetKey);
        markSending(targetKey, false);
      }
      markSending(key, false);
      if (targetKey)
        setActiveCreation((previous) =>
          previous?.requestId === creationRequestId ? undefined : previous,
        );
    }
  };
  const cancelCreation = async (useSource: boolean) => {
    if (!activeCreation || cancellingCreation) return;
    const current = activeCreation;
    stoppedCreation.current.add(current.requestId);
    localStorage.setItem(`${key}:pending-create`, current.requestId);
    setCancellingCreation(true);
    setDraftError("");
    try {
      const result = await readAction("workspace", {
        projectId: project.id,
        operation: "worktreeCancel",
        requestId: current.requestId,
      });
      const record = result;
      if (record.state !== "cancelled") {
        localStorage.setItem(`${key}:pending-create`, current.requestId);
        setUnknown(current.requestId);
        setDraftError(t("worktree.cancelTooLate"));
        return;
      }
      localStorage.removeItem(`${key}:pending-create`);
      localStorage.removeItem(`${key}:pending-create-request`);
      setUnknown(null);
      setDraftError(t("worktree.cancelled"));
      if (useSource) setSourceRetry(current.text);
    } catch (cause) {
      localStorage.setItem(`${key}:pending-create`, current.requestId);
      setUnknown(current.requestId);
      setDraftError(recoveryMessage(cause as RecoveryFailure));
    } finally {
      setCancellingCreation(false);
    }
  };
  useEffect(() => {
    if (sourceRetry === undefined || busy || cancellingCreation) return;
    const value = sourceRetry;
    setSourceRetry(undefined);
    void submit(value, {
      sourceRoot: project.logicalRoot ?? project.root,
      ref: "HEAD",
      worktreeRoot: "",
      branch: "",
      branchPrefix: "areal",
      mode: "source",
    });
  }, [sourceRetry, busy, cancellingCreation]);
  const creationStatus =
    activeCreation &&
    project.worktreeOperations?.findLast(
      (item: Data) => item.requestId === activeCreation.requestId,
    );
  return (
    <div className="composer-dock" data-v4-composer-dock="true">
      {outgoing && (
        <div className="draft-message-preview">
          <PendingMessageView message={outgoing} fileReferenceRoot={project.root} />
        </div>
      )}
      {activeCreation?.worktree && (busy || creationStatus) && (
        <div className="worktree-creation-preview min-w-0" data-testid="worktree-creation-progress">
          <div className="user-message">
            <div className="user-message-content">
              <div className="user-bubble">{activeCreation.text}</div>
            </div>
          </div>
          <WorktreeStatus
            current={{
              ...(creationStatus ?? { requestId: activeCreation.requestId, state: "creating" }),
              ...(cancellingCreation ? { state: "cancelling" } : {}),
            }}
            controls={
              busy ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancellingCreation}
                    onClick={() => void cancelCreation(true)}
                  >
                    {t("worktree.useOriginal")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancellingCreation}
                    onClick={() => void cancelCreation(false)}
                  >
                    {t("worktree.cancelCreation")}
                  </Button>
                </>
              ) : undefined
            }
          />
        </div>
      )}
      <Input
        unstyled
        data-slot={undefined}
        ref={upload}
        type="file"
        multiple
        hidden
        disabled={editLocked}
        onChange={(e) => {
          const selectedFiles = Array.from(e.currentTarget.files ?? []);
          if (!editLocked) setFiles((f) => [...f, ...selectedFiles]);
          e.currentTarget.value = "";
        }}
      />
      {unknown && (
        <FeedbackNotice
          tone="warning"
          message={t("recovery.createUnconfirmed")}
          requestId={unknown}
          detail={t("recovery.requestId", { id: unknown })}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={checkingCreation}
                onClick={() => void checkCreation()}
              >
                {t("recovery.checkOriginal")}
              </Button>
              {creationChecked && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={checkingCreation}
                  onClick={leaveCreationForInspection}
                >
                  {t("worktree.leavePending")}
                </Button>
              )}
            </>
          }
        />
      )}
      {backendReady && project.state?.connected && unavailableProfile && (
        <FeedbackNotice
          tone="warning"
          message={t("recovery.profileUnavailable")}
          actions={
            <>
              {profileSelection && resolveDraftProfile(project) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setProfileSelection("");
                    localStorage.removeItem(`${key}:profile`);
                  }}
                >
                  {t("recovery.resetProfile")}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => onPanel("会话配置")}>
                {t("recovery.checkSessionSettings")}
              </Button>
            </>
          }
        />
      )}
      {draftError && (
        <FeedbackNotice
          tone="error"
          message={isTechnicalErrorMessage(draftError) ? t("recovery.operationFailed") : draftError}
          detail={isTechnicalErrorMessage(draftError) ? draftError : undefined}
        />
      )}
      {reviewDraft.error && (
        <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">
          {reviewDraft.error}
        </p>
      )}
      <div className="composer-input-stack">
        <div ref={setMenuAnchor} className="composer-menu-anchor" />
        <ChatPromptEditor
          key={outgoing || (activeCreation?.worktree && busy) ? "waiting" : "draft"}
          surfaceLayout={surfaceLayout}
          triggerPanelContainer={menuAnchor}
          shellClassName="@container/composer"
          workspacePath={project.root}
          enableWorkspaceFileDrop={!!project.root && !editLocked}
          enableExternalFileDrop={!editLocked}
          validateWorkspaceFile={workspaceFiles?.validate}
          onFileDrop={(files) => setFiles((current) => [...current, ...files])}
          onWorkspaceReferencePendingChange={setWorkspaceReferencePending}
          taskId={null}
          initialValue={outgoing || (activeCreation?.worktree && busy) ? "" : text}
          inputApiRef={api}
          inputTestId="chat-input"
          submitTestId="chat-send-button"
          placeholder={
            activeCreation?.worktree && busy
              ? t("worktree.waitSetup")
              : goalMode
                ? "描述目标，明确可衡量的结果"
                : plan
                  ? "描述任务，生成计划…"
                  : "随心输入"
          }
          disabled={editLocked}
          submitDisabled={
            workspaceReferencePending ||
            submitDisabled ||
            annotationBlocked ||
            (desktopUnsupported && !goalMode) ||
            (goalMode
              ? !input.text.trim()
              : !input.text.trim() &&
                !input.files.length &&
                !comments.length &&
                !skills.selected.length)
          }
          submitDisabledReason={
            desktopUnsupported && !goalMode ? t("backend.updateRequired") : undefined
          }
          submitting={busy}
          submitLabel={goalMode ? "开始目标" : "发送"}
          enterSubmits={prefs.sendShortcut === "enter"}
          enableMentionPanel={false}
          workspaceFiles={workspaceFiles}
          pluginMentionCatalog={{
            ...plugins.catalog,
            entries: [...plugins.catalog.entries, ...referenceEntries],
            searchLabel: t("chat.composer.searchReferences"),
            label: t("chat.composer.references"),
            appGroupLabel: plugins.catalog.label,
          }}
          composerCatalog={{
            ...skills.catalog,
            loading: executionReady && skills.catalog.loading,
            error: executionReady ? skills.catalog.error : undefined,
            refresh: () => {
              if (executionReady && !editLocked) skills.catalog.refresh();
            },
            entries: [
              {
                value: "upload",
                label: "上传文件",
                description: "添加图片、文档或其他文件",
                group: "功能",
                icon: <AttachmentIcon />,
                disabled: editLocked,
                run: () => {
                  if (!editLocked) upload.current?.click();
                },
              },
              ...(project.id !== "projectless"
                ? [
                    {
                      value: "mcp",
                      label: "MCP",
                      description: "查看服务器与连接状态",
                      group: "功能" as const,
                      icon: <ComposerMcpIcon />,
                      disabled: !executionReady,
                      run: () => {
                        if (executionReady) setMcpOpen(true);
                      },
                    },
                  ]
                : []),
              ...(project.root
                ? [
                    {
                      value: "files",
                      label: t("chat.composer.workspaceFiles"),
                      description: t("chat.composer.workspaceFilesDescription"),
                      group: "功能" as const,
                      icon: <FileTree />,
                      disabled: !executionReady,
                      run: () => {
                        if (executionReady) onPanel("文件");
                      },
                    },
                  ]
                : []),
              {
                value: "plan",
                label: "计划模式",
                description: plan ? "关闭计划模式" : "先规划，再开始执行",
                group: "功能",
                icon: <Lightbulb />,
                disabled: editLocked || chosenProfile?.readOnly === true,
                run: () => {
                  if (!editLocked) setPlanMode(!plan);
                },
              },
              {
                value: "goal",
                label: "设置目标",
                description: goalMode ? "关闭目标模式" : "设置持续目标与停止条件",
                group: "功能",
                icon: <GoalIcon />,
                disabled: editLocked,
                run: () => {
                  if (!editLocked) changeGoalMode(!goalMode);
                },
              },
              ...referenceEntries,
              ...appEntries.map((entry) => ({
                ...entry,
                disabled: entry.disabled || !executionReady,
              })),
              ...skills.catalog.entries.map((entry) => ({
                ...entry,
                disabled: entry.disabled || !executionReady,
              })),
            ],
          }}
          onChange={(value) => {
            if (outgoing || (activeCreation?.worktree && busy)) return;
            setText(value);
            localStorage.setItem(key, value);
          }}
          onSubmit={(value) => {
            void submit(value);
            return false;
          }}
          onPaste={(event) => {
            if (!editLocked)
              composerPaste(event, (pasted) => setFiles((current) => [...current, ...pasted]));
          }}
          topContent={
            <div hidden={!!outgoing}>
              {skills.tags}
              <div className="composer-attachment-row">
                {files.length ? (
                  <div className="composer-attachments" data-testid="composer-attachments">
                    {files.map((file, i) => (
                      <ComposerAttachment
                        disabled={editLocked}
                        key={
                          isComposerFile(file)
                            ? `${file.name}-${file.lastModified}-${i}`
                            : `pasted-text-${i}`
                        }
                        file={file}
                        onAnnotate={
                          onAnnotate
                            ? (file) => {
                                if (!editLocked)
                                  onAnnotate({
                                    draftKey: key,
                                    file,
                                    returnFocus: () => api.current?.focus(),
                                  });
                              }
                            : undefined
                        }
                        onRemove={() => {
                          if (!editLocked)
                            setFiles((current) => current.filter((_, at) => at !== i));
                        }}
                        onExpand={(content) => {
                          if (editLocked) return;
                          api.current?.appendText(`${text.length ? "\n\n" : ""}${content}`);
                          setFiles((current) => current.filter((item) => item !== file));
                        }}
                      />
                    ))}
                  </div>
                ) : null}
                <ReviewCommentAttachment
                  comments={comments}
                  disabled={editLocked}
                  onRemove={() => detachReviewComments(reviewKey)}
                />
              </div>
            </div>
          }
          leadingActions={
            <>
              {unknown && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("recovery.pendingAction")}
                        title={t("recovery.checkOriginal")}
                      >
                        <CircleAlert size={16} />
                      </Button>
                    }
                  />
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      disabled={checkingCreation}
                      onClick={() => void checkCreation()}
                    >
                      {t("recovery.checkOriginal")}
                    </DropdownMenuItem>
                    {creationChecked && (
                      <DropdownMenuItem
                        disabled={checkingCreation}
                        onClick={leaveCreationForInspection}
                      >
                        {t("worktree.leavePending")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {!executionReady && preparationStatus}
              {executionReady && (
                <ComposerPermissionMenu
                  value={chosenProfile?.readOnly ? "readOnly" : permission}
                  disabled={submitDisabled}
                  permissionsSupported={project.core?.features?.permissionPresets === true}
                  fullAccessAvailable={project.core?.features?.permissionFullAccess === true}
                  lockedReadOnly={chosenProfile?.readOnly === true}
                  onChange={(value) => {
                    setPermission(value);
                    localStorage.setItem(`${key}:permission`, value);
                    setApplicationPreferences({ defaultPermissionPreset: value });
                  }}
                  onClose={() => api.current?.focus()}
                />
              )}
              {goalMode && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={editLocked}
                  aria-label="退出目标模式"
                  onClick={() => changeGoalMode(false)}
                >
                  <GoalIcon size={16} />
                  目标
                </Button>
              )}
              {plan && (
                <ComposerPlanMode
                  disabled={editLocked || chosenProfile?.readOnly === true}
                  onExit={() => setPlanMode(false)}
                />
              )}
            </>
          }
          betweenCancelAndSubmitAction={
            modelReady && (
              <ComposerModelMenu
                value={effectiveModel}
                disabled={modelSelectionDisabled}
                effort={effort}
                serviceTier={serviceTier}
                onServiceTierChange={(value) => {
                  setRequestedServiceTier(value);
                  localStorage.setItem(`${key}:service-tier`, value);
                }}
                onEffortChange={(value) => {
                  setModel(effectiveModel);
                  localStorage.setItem(`${key}:model`, effectiveModel);
                  const next = { ...efforts, [effectiveModel]: value };
                  setEfforts(next);
                  localStorage.setItem(`${key}:efforts`, JSON.stringify(next));
                }}
                options={[
                  ...project.models
                    .filter(
                      (item: Data) =>
                        modelValue(item) === effectiveModel ||
                        item.providerId ||
                        !project.models.some(
                          (candidate: Data) => candidate.providerId && candidate.isDefault,
                        ),
                    )
                    .map((item: Parameters<typeof composerModelOption>[0]) => ({
                      ...composerModelOption(item),
                      value: modelValue(item),
                    })),
                  ...(!currentModel && effectiveModel
                    ? [
                        {
                          value: effectiveModel,
                          label: effectiveModel.slice(effectiveModel.indexOf("/") + 1),
                          providerId: effectiveModel.slice(0, effectiveModel.indexOf("/")),
                          historical: true,
                        },
                      ]
                    : []),
                ]}
                onChange={(value) => {
                  setModel(value);
                  localStorage.setItem(`${key}:model`, value);
                }}
                onClose={() => api.current?.focus()}
              />
            )
          }
        />
      </div>
      {modelReady && preferenceNotice && (
        <p className="composer-preference-notice" role="status">
          {preferenceNotice}
        </p>
      )}
      <ComposerMcp
        projectId={project.id}
        action={readAction}
        open={executionReady && mcpOpen}
        anchor={menuAnchor}
        onClose={() => {
          setMcpOpen(false);
          api.current?.focus();
        }}
      />
    </div>
  );
}
