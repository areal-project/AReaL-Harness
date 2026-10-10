import { profileKey } from "./ProfileDetails.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import { permissionOptions, planModeOptions, type PermissionMode } from "./permissions.js";
import { ComposerPlanMode } from "./ComposerPlanMode.js";
import { FileTree, AttachmentIcon, GoalIcon, PlanModeIcon as Lightbulb } from "./interfaceIcons.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import { ComposerAttachment, composerPaste } from "./ComposerAttachments.js";
import { useComposerSkills, transferComposerSkills, clearComposerSkills } from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { ComposerMcp } from "./ComposerMcp.js";
import { Button } from "./components/ui/button.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Action, Data } from "./services.js";
import { attachedReviewComments, detachReviewComments, reviewCommentKey, transferNewReviewComments, useReviewComments } from "./reviewComments.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
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
  action,
  readAction = action,
  onOpen,
  onPanel,
  draftKey,
  prepareProject,
}: {
  project: Data;
  action: Action;
  readAction?: Action;
  onOpen: (pid: string, tid: string) => Promise<void>;
  onPanel: (panel: string) => void;
  draftKey?: string;
  prepareProject?: () => Promise<Data>;
}) {
  const prefs = useApplicationPreferences();
  const key = draftKey ?? `areal-gui:draft:${project.id}:new`;
  const reviewKey = reviewCommentKey(project.id, "new");
  const reviewDraft = useReviewComments(reviewKey);
  const comments = attachedReviewComments(reviewDraft.draft);
  const api = useRef<LexicalChatInputHandle | null>(null);
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
      api.current?.setText(draft); setText(draft); api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  const [files, setFiles] = useState<File[]>(() => attachmentDrafts.get(key) ?? []);
  const [permission, setPermission] = useState<PermissionMode>(() => localStorage.getItem(`${key}:permission`) === "ask" ? "ask" : "auto");
  const [plan, setPlan] = useState(() => localStorage.getItem(`${key}:plan`) === "true");
  const [profileSelection, setProfileSelection] = useState(() => localStorage.getItem(`${key}:profile`) ?? "");
  const chosenProfile = profileSelection
    ? project.profiles.find((p: Data) => profileKey(p) === profileSelection)
    : project.profiles.find((p: Data) => p.id === "areal-standard") ?? project.profiles[0];
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [goalMode, setGoalMode] = useState(() => localStorage.getItem(`${key}:goal`) === "true");
  const changeGoalMode = (enabled: boolean) => { setGoalMode(enabled); localStorage.setItem(`${key}:goal`, String(enabled)); api.current?.focus(); };
  const [efforts, setEfforts] = useState<Record<string, string>>(() => JSON.parse(localStorage.getItem(`${key}:efforts`) ?? "{}"));
  const unavailableProfile = !!profileSelection && !chosenProfile;
  const setPlanMode = (enabled: boolean) => { setPlan(enabled); localStorage.setItem(`${key}:plan`, String(enabled)); };
  const [model, setModel] = useState(
    () => localStorage.getItem(`areal-gui:model:${project.id}`) ?? "",
  );
  const selectedModel = project.models.find(
    (m: Data) => `${m.providerId}/${m.modelId}` === model,
  );
  const hasDefaultModel = project.models.some((m: Data) => !m.providerId);
  const effectiveModel = !model && chosenProfile?.model ? "" : selectedModel
    ? model
    : hasDefaultModel
      ? ""
      : (() => {
          const m = project.models.find((m: Data) => m.providerId && m.available !== false);
          return m ? `${m.providerId}/${m.modelId}` : "";
        })();
  const currentModel = project.models.find((item: Data) => effectiveModel ? `${item.providerId}/${item.modelId}` === effectiveModel : chosenProfile?.model ? item.providerId === chosenProfile.model.providerId && item.modelId === chosenProfile.model.modelId : !item.providerId);
  const effort = efforts[effectiveModel] ?? "";
  const [unknown, setUnknown] = useState(() => localStorage.getItem(`${key}:pending-create`));
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const modelSelectionDisabled =
    busy ||
    !project.state?.connected ||
    !!project.pending.length ||
    !!unknown || !!reviewDraft.error || unavailableProfile;
  const disabled = modelSelectionDisabled || currentModel?.available === false ||
    (!hasDefaultModel && !effectiveModel && !chosenProfile?.model);
  const skills = useComposerSkills({ project, profile: chosenProfile, draftKey: key, action: readAction, disabled });
  useEffect(() => {
    attachmentDrafts.set(key, files);
  }, [key, files]);
  const clear = () => {
    detachReviewComments(reviewKey);
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}:permission`);
    localStorage.removeItem(`${key}:plan`);
    attachmentDrafts.delete(key);
    skills.clear();
    changeGoalMode(false);
    api.current?.clear();
    setText("");
    setFiles([]);
  };
  useEffect(() => {
    if (!unknown || project.pending.length) return;
    const outcome = project.outcomes?.[unknown];
    if (!outcome?.threadId || outcome.accepted !== true) return;
    try { transferNewReviewComments(project.id, outcome.threadId); }
    catch (cause) { setDraftError((cause as Error).message); return; }
    // A recovered creation opens the preserved draft; it never sends it automatically.
    stageThreadDraft(
      project.id,
      outcome.threadId,
      localStorage.getItem(key) ?? "",
      attachmentDrafts.get(key) ?? [],
    );
    transferComposerSkills(key, `areal-gui:draft:${project.id}:${outcome.threadId}`);
    if (goalMode) localStorage.setItem(`areal-gui:draft:${project.id}:${outcome.threadId}:goal`, "true");
    localStorage.removeItem(`${key}:pending-create`);
    setUnknown(null);
    clear();
    void onOpen(project.id, outcome.threadId);
  }, [unknown, project.pending.length, project.outcomes]);
  const submit = async (value: string) => {
    if (disabled || sending.has(key) || (!value.trim() && !files.length && !comments.length && !skills.selected.length) || (goalMode && !value.trim())) return;
    markSending(key, true);
    setDraftError("");
    let targetKey: string | undefined;
    let creationAttempted = false;
    try {
      const owner = prepareProject ? await prepareProject() : project;
      const profile = profileSelection
        ? owner.profiles.find((p: Data) => profileKey(p) === profileSelection)
        : owner.profiles.find((p: Data) => p.id === "areal-standard") ?? owner.profiles[0];
      if (profileSelection && !profile) throw new Error("当前任务配置不可用，输入已保留。");
      const chosenModel = !effectiveModel && profile?.model ? undefined : owner.models.find(
        (m: Data) => `${m.providerId}/${m.modelId}` === effectiveModel,
      ) ?? (!owner.models.some((m: Data) => !m.providerId) ? owner.models.find((m: Data) => m.available !== false) : undefined);
      creationAttempted = true;
      const result = await action("create", {
        projectId: owner.id,
        ...(effort ? { parameters: { reasoningEffort: effort } } : {}),
        ...(profile
          ? { profile: { id: profile.id, revision: profile.revision } }
          : {}),
        ...(chosenModel
          ? { model: { providerId: chosenModel.providerId, modelId: chosenModel.modelId } }
          : {}),
      });
      targetKey = stageThreadDraft(owner.id, result.threadId, value, files);
      transferNewReviewComments(owner.id, result.threadId);
      transferComposerSkills(key, targetKey);
      if (goalMode) localStorage.setItem(`${targetKey}:goal`, "true");
      markSending(targetKey, true);
      clear();
      // Show the accepted task immediately, including while the first model request waits.
      if (mounted.current) void onOpen(owner.id, result.threadId);
      // Configure before the first turn; on failure the accepted task keeps its draft for explicit retry.
      if (!profile?.readOnly && (permission !== "auto" || plan)) {
        await action("configure", { projectId: owner.id, threadId: result.threadId, options: planModeOptions(plan, permissionOptions(permission)) });
      }
      if (goalMode) {
        const latest = await action("manage", { projectId: owner.id, threadId: result.threadId, operation: "goal" });
        await action("manage", { projectId: owner.id, threadId: result.threadId, operation: "goalCreate", objective: value, expectedRevision: latest.revision ?? 0, inferLimits: true });
        localStorage.removeItem(`${targetKey}:goal`);
        // 目标只消费正文；技能、文件和评论仍保留在已创建聊天中。
      } else {
        await submitMessage(action, owner.id, result.threadId, value, files, { skillAction: readAction });
        attachmentDrafts.delete(targetKey);
        clearComposerSkills(targetKey);
      }
      localStorage.removeItem(targetKey);
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: targetKey }));
    } catch (e) {
      setDraftError((e as Error).message);
      if (targetKey) attachmentErrors.set(targetKey, (e as Error).message);
      const error = e as Error & { submissionUnknown?: boolean; requestId?: string };
      if (creationAttempted && error.submissionUnknown && error.requestId) {
        if (targetKey) {
          localStorage.setItem(`${targetKey}:pending`, error.requestId);
          if (goalMode) localStorage.setItem(`${targetKey}:pending-goal`, error.requestId);
        }
        else {
          localStorage.setItem(`${key}:pending-create`, error.requestId);
          setUnknown(error.requestId);
        }
      }
      // action reports the error. Known-created tasks keep text and files for explicit retry.
    } finally {
      if (targetKey) markSending(targetKey, false);
      markSending(key, false);
    }
  };
  return (
    <div className="composer-dock" data-v4-composer-dock="true">
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
      {unknown && (
        <div role="status" className="notice">
          任务创建结果待确认，草稿已保留，不会重复创建。
          <button
            onClick={() => void action("reconcile", { projectId: project.id }).catch(() => {})}
          >
            刷新受理状态
          </button>
        </div>
      )}
      {unavailableProfile && <div role="alert" className="notice">
        当前任务配置不可用，输入已保留。
        <button onClick={() => { setProfileSelection(""); localStorage.removeItem(`${key}:profile`); }}>恢复默认配置</button>
      </div>}
      {project.root && !project.state?.connected && <p role="alert" className="notice">连接不可用，输入已保留。{project.error || project.state?.error}</p>}
      {draftError && <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">{draftError}</p>}
      {reviewDraft.error && <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">{reviewDraft.error}</p>}
      <div className="composer-input-stack">
      <div ref={setMenuAnchor} className="composer-menu-anchor" />
      <ChatPromptEditor
        triggerPanelContainer={menuAnchor}
        shellClassName="@container/composer"
        workspacePath={project.root}
        taskId={null}
        initialValue={text}
        inputApiRef={api}
        inputTestId="chat-input"
        submitTestId="chat-send-button"
        placeholder={goalMode ? "描述目标，明确可衡量的结果" : plan ? "描述任务，生成计划…" : "随心输入"}
        disabled={disabled}
        submitDisabled={disabled || (goalMode ? !text.trim() : !text.trim() && !files.length && !comments.length && !skills.selected.length)}
        submitting={busy}
        submitLabel={goalMode ? "开始目标" : "发送"}
        enterSubmits={prefs.sendShortcut === "enter"}
        enableMentionPanel={false}
        composerCatalog={{ ...skills.catalog, entries: [
          { value: "upload", label: "上传文件", description: "添加图片、文档或其他文件", group: "功能", icon: <AttachmentIcon />, run: () => upload.current?.click() },
          ...(project.id !== "projectless" ? [{ value: "mcp", label: "MCP", description: "查看服务器与连接状态", group: "功能" as const, icon: <ComposerMcpIcon />, run: () => setMcpOpen(true) }] : []),
          ...(project.root ? [{ value: "files", label: "工作区文件", description: "引用当前项目中的文件", group: "功能" as const, icon: <FileTree />, run: () => onPanel("文件") }] : []),
          { value: "plan", label: "计划模式", description: plan ? "关闭计划模式" : "先规划，再开始执行", group: "功能", icon: <Lightbulb />, disabled: chosenProfile?.readOnly === true, run: () => setPlanMode(!plan) },
          { value: "goal", label: "设置目标", description: goalMode ? "关闭目标模式" : "设置持续目标与停止条件", group: "功能", icon: <GoalIcon />, run: () => changeGoalMode(!goalMode) },
          ...skills.catalog.entries,
        ] }}
        onChange={(value) => {
          setText(value);
          localStorage.setItem(key, value);
        }}
        onSubmit={(value) => {
          void submit(value);
          return false;
        }}
        onPaste={event => composerPaste(event, pasted => setFiles(current => [...current, ...pasted]))}
        topContent={
          <>{skills.tags}<ReviewCommentAttachment comments={comments} disabled={disabled} onRemove={() => detachReviewComments(reviewKey)} />
          {files.length ? (
            <div className="composer-attachments" data-testid="composer-attachments">
              {files.map((file, i) => <ComposerAttachment disabled={disabled} key={`${file.name}-${file.lastModified}-${i}`} file={file}
                onRemove={() => setFiles((current) => current.filter((_, at) => at !== i))}
                onExpand={content => { api.current?.appendText(`${text.trim() ? "\n\n" : ""}${content}`); setFiles(current => current.filter(item => item !== file)); }} />)}
            </div>
          ) : null}</>
        }
        leadingActions={
          <><ComposerPermissionMenu value={chosenProfile?.readOnly ? "readOnly" : permission} disabled={disabled}
            lockedReadOnly={chosenProfile?.readOnly === true}
            onChange={value => { setPermission(value); localStorage.setItem(`${key}:permission`, value); }} onClose={() => api.current?.focus()} />
          {goalMode && <Button type="button" variant="ghost" disabled={disabled} aria-label="退出目标模式" onClick={() => changeGoalMode(false)}><GoalIcon size={16} />目标</Button>}
          {plan && <ComposerPlanMode disabled={disabled || chosenProfile?.readOnly === true} onExit={() => setPlanMode(false)} />}</>
        }
        betweenCancelAndSubmitAction={<ComposerModelMenu
          value={effectiveModel} disabled={modelSelectionDisabled}
          effort={effort} onEffortChange={value => { const next = { ...efforts, [effectiveModel]: value }; setEfforts(next); localStorage.setItem(`${key}:efforts`, JSON.stringify(next)); }}
          options={[
            ...(chosenProfile?.model ? [{ value: "", label: `预设模型：${chosenProfile.model.modelId}`, efforts: currentModel?.reasoningEffortOptions, unavailableReason: currentModel?.available === false ? composerModelOption(currentModel).unavailableReason : undefined }] : hasDefaultModel ? [{ value: "", label: "默认模型", efforts: currentModel?.reasoningEffortOptions }] : []),
            ...project.models.filter((model: Data) => model.providerId)
              .map(composerModelOption),
          ]}
          onChange={value => { setModel(value); localStorage.setItem(`areal-gui:model:${project.id}`, value); }}
          onClose={() => api.current?.focus()}
          onConfigure={() => onPanel("设置")}
        />}
      />
      </div>
      <ComposerMcp projectId={project.id} action={readAction} open={mcpOpen} anchor={menuAnchor} onClose={() => { setMcpOpen(false); api.current?.focus(); }} />
    </div>
  );
}
