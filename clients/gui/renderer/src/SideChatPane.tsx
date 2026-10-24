import { useComposerPrediction } from "./useComposerPrediction.js";
import { ContextMeter } from "./ContextMeter.js";
import { useI18n } from "./i18n/IntlProvider.js";
import "./SideChat.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Messages } from "./Messages.js";
import { useComposerPlugins, revalidateComposerPlugins, composerPluginIntent } from "./ComposerPlugins.js";
import { ConversationComposer } from "./ConversationComposer.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { SideChatIcon, MoreOptionsIcon, CloseIcon, StopIcon } from "./interfaceIcons.js";
import { AddPanelIcon } from "./app-shell/panelIcons.js";
import { Feedback } from "./components/ui/feedback.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { RelatedSideChats } from "./RelatedSideChats.js";
import { SideDraftWorkspace } from "./side-draft-owner.js";
import { insertSideAnswer, makeBringBackPreview, sideSourceAdvanced } from "./side-bring-back.js";
import { sideStartConfiguration } from "./side-model-intent.js";
import { createSideRestore, type SideRestoreState } from "./side-restore.js";
import type { Action, Data } from "./services.js";

// 编辑器按服务、来源和具体草稿或 Side 隔离；切换目标会卸载旧编辑器。
export function SideChatPane({ project, source, executionBlocked, action, dark, onReturn, onPanel }: {
  project: Data; source: Data; executionBlocked: boolean; action: Action; dark: boolean; onReturn: () => void; onPanel: (name: string) => void;
}) {
  const workspace = useMemo(() => new SideDraftWorkspace(localStorage, {
    instanceId: project.core?.instanceId ?? "unknown", projectId: project.id, sourceThreadId: source.id, randomId: () => crypto.randomUUID(),
  }), [project.core?.instanceId, project.id, source.id]);
  const [selected, setSelected] = useState(() => workspace.current());
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const choose = (next: { kind: string; id: string }) => { setSelected(next); setRelatedOpen(false); setContextOpen(false); };
  useEffect(() => { choose(workspace.current()); }, [workspace]);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string }>).detail;
      if (detail?.owner?.startsWith(workspace.prefix + ":")) choose(workspace.current());
    };
    window.addEventListener("areal-side-draft", receive);
    window.addEventListener("areal-side-selection", receive);
    return () => { window.removeEventListener("areal-side-draft", receive); window.removeEventListener("areal-side-selection", receive); };
  }, [workspace]);
  return <section className="side-chat-pane" aria-label="旁路讨论">
    <div className="side-chat-toolbar">
      <span className="side-chat-heading"><SideChatIcon />侧边聊天</span>
      <Button type="button" variant="ghost" size="icon" aria-label="新讨论" title="新讨论" onClick={() => choose(workspace.newDraft())}><AddPanelIcon /></Button>
      <Popover open={relatedOpen} onOpenChange={setRelatedOpen}>
        <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="相关侧边讨论" title="相关讨论"><MoreOptionsIcon /></Button>} />
        <PopoverContent align="end" className="side-chat-related">
          <button type="button" aria-pressed={contextOpen} onClick={() => { setContextOpen(open => !open); setRelatedOpen(false); }}>上下文与文件访问</button>
          <RelatedSideChats project={project} sourceId={source.id} selectedId={selected.kind === "side" ? selected.id : ""} action={action} showNew={false}
            onSelect={id => choose(id ? workspace.selectSide(id) : workspace.newDraft())} />
          {workspace.availableDrafts().filter(draft => draft.id !== selected.id).map(draft => <button type="button" key={draft.id}
            onClick={() => choose(workspace.selectDraft(draft.id))}>{localStorage.getItem(workspace.pendingKey(draft)) ? "待核对的讨论" : "未发送的草稿"}</button>)}
        </PopoverContent>
      </Popover>
      <Button type="button" variant="ghost" size="icon" aria-label="返回主会话" title="关闭侧边聊天" onClick={onReturn}><CloseIcon /></Button>
    </div>
    <SideChatEditor key={`${workspace.owner(selected)}:${project.core?.connectionGeneration ?? 0}`} project={project} source={source}
      executionBlocked={executionBlocked} action={action} dark={dark} workspace={workspace} selected={selected} onSelected={choose} onPanel={onPanel} contextOpen={contextOpen} />
  </section>;
}

function SideChatEditor({ project, source, executionBlocked, action, dark, workspace, selected, onSelected, onPanel, contextOpen }: {
  project: Data; source: Data; executionBlocked: boolean; action: Action; dark: boolean; workspace: SideDraftWorkspace;
  selected: { kind: string; id: string }; onSelected: (next: { kind: string; id: string }) => void; onPanel: (name: string) => void; contextOpen: boolean;
}) {
  const prefs = useApplicationPreferences();
  const { t } = useI18n();
  const api = useRef<LexicalChatInputHandle | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const owner = workspace.owner(selected);
  const draftKey = workspace.draftKey(selected);
  const pendingKey = workspace.pendingKey(selected);
  const selectionKey = `${owner}:selection`;
  const anchorKey = `${owner}:anchor`;
  const previewKey = `${owner}:selection-preview`;
  const workspaceAccessKey = `${owner}:workspace-access`;
  const sideId = selected.kind === "side" ? selected.id : "";
  const generation = project.core?.connectionGeneration ?? 0;
  const configKey = `${owner}:configuration`;
  const [draftConfig, setDraftConfig] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(configKey) ?? "null"); } catch { return null; } });
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const pluginContext = { projectId: project.id, coreInstanceId: project.core?.instanceId,
    connectionGeneration: project.core?.connectionGeneration, sourceThreadId: source.id,
    ...(sideId ? { kind: "sideThread" as const, threadId: sideId } : { kind: "sideDraft" as const, draftId: selected.id }) };
  const plugins = useComposerPlugins({ project, context: pluginContext, draftKey, text, action });
  const workspaceReadAvailable = project.core?.features?.sideWorkspaceRead === true;
  const [workspaceAccess, setWorkspaceAccess] = useState<"none" | "readOnly">(() => {
    const saved = localStorage.getItem(workspaceAccessKey);
    if (saved !== null) return saved === "readOnly" ? "readOnly" : "none";
    return workspaceReadAvailable ? "readOnly" : "none";
  });
  useEffect(() => {
    if (!sideId) localStorage.setItem(workspaceAccessKey, workspaceAccess);
  }, [sideId, workspaceAccessKey, workspaceAccess]);
  const [pendingId, setPendingId] = useState(() => localStorage.getItem(pendingKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => localStorage.getItem(`${owner}:error`) ?? "");
  const [restoreState, setRestoreState] = useState<SideRestoreState>("idle");
  const restore = useMemo(() => createSideRestore(), [owner, generation]);
  const loading = restoreState === "loading";
  useEffect(() => () => restore.dispose(), [restore]);
  const [selection, setSelection] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(selectionKey) ?? "null"); } catch { return null; } });
  const [anchor, setAnchor] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(anchorKey) ?? "null"); } catch { return null; } });
  const [selectionPreview, setSelectionPreview] = useState(() => localStorage.getItem(previewKey) ?? "");
  const [evidence, setEvidence] = useState<Data[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [bringPreview, updateBringPreview] = useState<ReturnType<typeof makeBringBackPreview> | null>(() => workspace.bringBack(selected));
  const setBringPreview = (preview: ReturnType<typeof makeBringBackPreview> | null) => {
    workspace.saveBringBack(selected, preview); updateBringPreview(preview);
  };
  useEffect(() => { localStorage.setItem(`${owner}:error`, error); }, [owner, error]);
  const [bringResult, setBringResult] = useState("");
  const mounted = useRef(true);
  const side = sideId ? project.state?.threads?.[sideId] : undefined;
  const validSide = side?.conversation?.kind === "side" && side.conversation.policy?.kind === "sideReadOnlyV1" && side.conversation.origin?.sourceThreadId === source.id;
  const active = validSide && side.turns?.some((turn: Data) => turn.status === "inProgress");
  const unsettled = !!sideId && project.pending?.some((request: Data) => request.params?.threadId === sideId);
  const config = validSide ? project.configurations?.[sideId] : draftConfig ?? {};
  const configuredModel = config?.model && project.models.find((item: Data) => item.providerId === config.model.providerId && item.modelId === config.model.modelId);
  const modelUnavailable = configuredModel?.available === false || config?.model?.providerId === "areal_openai" && !configuredModel;
  const sourceStatus = !project.state?.connected || !validSide ? "来源当前状态未知" :
    sideSourceAdvanced(source, side) ? "来源已推进；此讨论仍依据创建时快照" :
    !Number.isFinite(source.updatedAt) || !Number.isFinite(side.createdAt) ? "来源当前状态未知" : "依据创建时快照";
  const prepareBringBack = (answer: string, whole: boolean) => {
    const selectedText = window.getSelection()?.toString().trim() ?? "";
    const selectionNode = window.getSelection()?.anchorNode;
    const pane = document.querySelector<HTMLElement>(`[data-side-owner="${CSS.escape(owner)}"]`)?.closest(".side-chat-pane");
    const withinPane = !!selectionNode && !!pane?.contains(selectionNode);
    const text = whole ? answer : withinPane && selectedText && answer.includes(selectedText) ? selectedText : "";
    if (!text) { setBringResult("请先选中这条回复中的文字，或明确选择整条回复。"); return; }
    setBringPreview(makeBringBackPreview({ storage: localStorage, owner: {
      instanceId: project.core?.instanceId ?? "unknown", projectId: project.id, sourceThreadId: source.id,
      sideThreadId: sideId, paneOwner: owner,
    }, source, side, answer: text, insertionId: crypto.randomUUID() }));
    setBringResult("");
  };
  const confirmBringBack = () => {
    if (!bringPreview) return;
    const result = insertSideAnswer({ storage: localStorage, preview: bringPreview,
      current: { owner: { instanceId: project.core?.instanceId ?? "unknown", projectId: project.id,
        sourceThreadId: source.id, sideThreadId: sideId, paneOwner: workspace.owner(workspace.current()) },
      source, side, connected: !!project.state?.connected },
      dispatch: (key: string) => { window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key })); } });
    if (result.status === "inserted") { setBringResult(result.changed ? "已追加到更新后的主会话草稿；请检查再发送。" : "已插入主会话草稿；请检查再发送。"); setBringPreview(null); }
    else if (result.status === "duplicate") setBringResult("这次内容已插入过主会话草稿。");
    else setBringResult("来源或目标已变化，未写入草稿。可复制预览文字。");
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string; text: string }>).detail;
      if (detail?.owner !== owner) return;
      const next = localStorage.getItem(draftKey) ?? detail.text;
      setText(next);
      api.current?.setText(next); api.current?.focus();
    };
    window.addEventListener("areal-side-draft", refresh);
    return () => window.removeEventListener("areal-side-draft", refresh);
  }, [owner, draftKey]);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string }>).detail;
      if (detail?.owner !== owner) return;
      try { setSelection(JSON.parse(localStorage.getItem(selectionKey) ?? "null")); } catch { setSelection(null); }
      try { setAnchor(JSON.parse(localStorage.getItem(anchorKey) ?? "null")); } catch { setAnchor(null); }
      setSelectionPreview(localStorage.getItem(previewKey) ?? "");
      const next = localStorage.getItem(draftKey) ?? "";
      setText(next); api.current?.setText(next); api.current?.focus();
      setEvidence([]); setEvidenceCursor(null); setEvidenceOpen(false);
    };
    window.addEventListener("areal-side-selection", receive);
    return () => window.removeEventListener("areal-side-selection", receive);
  }, [owner, selectionKey, anchorKey, previewKey, draftKey]);
  const loadEvidence = async (cursor?: string) => {
    if (!validSide || evidenceBusy) return;
    setEvidenceBusy(true); setError("");
    try {
      const page = await action("side", { projectId: project.id, operation: "context", threadId: sideId, cursor, maxBytes: 4096 });
      if (!mounted.current || page.snapshotId !== side.conversation.referenceSnapshot?.snapshotId) return;
      setEvidence(rows => cursor ? [...rows, ...(page.evidence ?? [])] : page.evidence ?? []);
      setEvidenceCursor(page.nextCursor ?? null); setEvidenceOpen(true);
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { if (mounted.current) setEvidenceBusy(false); }
  };
  useEffect(() => {
    if (!sideId || validSide || side || restoreState !== "idle" || !project.state?.connected) return;
    void restore.load(() => action("open", { projectId: project.id, threadId: sideId }), (state, message) => {
      if (!mounted.current) return;
      setRestoreState(state);
      if (message) setError(message);
    });
  }, [sideId, validSide, side, restoreState, restore, project.id, project.state?.connected, action]);
  const recover = useCallback(async () => {
    if (!pendingId || busy) return;
    const token = workspace.capture(generation);
    setBusy(true); setError("");
    try {
      const result = await action("side", { projectId: project.id, operation: "recover", requestId: pendingId });
      if (!mounted.current || !workspace.isCurrent(token, generation)) return;
      if (!result.confirmed) { setError("首问结果仍待核对；不会自动重复提交。"); return; }
      workspace.acceptCreated(token, result.threadId, generation);
      localStorage.removeItem(selectionKey); localStorage.removeItem(anchorKey); localStorage.removeItem(previewKey); localStorage.removeItem(workspaceAccessKey); localStorage.removeItem(configKey);
      setSelection(null); setAnchor(null); setSelectionPreview("");
      onSelected({ kind: "side", id: result.threadId });
    } catch (cause) { if (mounted.current && workspace.isCurrent(token, generation)) setError((cause as Error).message); }
    finally { if (mounted.current && workspace.isCurrent(token, generation)) setBusy(false); }
  }, [pendingId, busy, action, project.id, pendingKey, draftKey, selectionKey, anchorKey, previewKey, workspaceAccessKey, workspace, generation, onSelected]);
  useEffect(() => { if (pendingId && project.state?.connected) void recover(); }, [project.state?.connected]);
  const submit = async (value = api.current?.getMarkdown() ?? text) => {
    let question = value.trim() || (!sideId && selection ? (selectionPreview || selection.text || "") : "");
    if (executionBlocked || modelUnavailable || !question || busy || pendingId || unsettled || active || !project.state?.connected || sideId && (!validSide || side.desktop?.archived)) return;
    const token = workspace.capture(generation);
    setBusy(true); setError("");
    try {
      const references = await revalidateComposerPlugins(action, pluginContext, draftKey, value, t("chat.composer.pluginReferenceUnavailable"));
      const intent = composerPluginIntent(references, name => t("chat.composer.pluginReferenceIntent", { name }));
      if (intent) question += `\n\n${intent}`;
      if (sideId) {
        await action("side", { projectId: project.id, operation: "send", threadId: sideId, text: question });
      } else {
        const requestId = crypto.randomUUID();
        localStorage.setItem(pendingKey, requestId); setPendingId(requestId);
        const result = await action("side", { projectId: project.id, operation: "start", sourceThreadId: source.id, workspaceAccess, text: question, requestId, selection, anchor, ...sideStartConfiguration(draftConfig) });
        if (!mounted.current || !workspace.isCurrent(token, generation)) return;
        workspace.acceptCreated(token, result.threadId, generation);
        localStorage.removeItem(workspaceAccessKey); localStorage.removeItem(configKey);
        onSelected({ kind: "side", id: result.threadId });
      }
      if (!mounted.current || !workspace.isCurrent(token, generation)) return;
      plugins.clear();
      workspace.clearAfterSend(token, generation); localStorage.removeItem(selectionKey); localStorage.removeItem(anchorKey); localStorage.removeItem(previewKey);
      setSelection(null); setAnchor(null); setSelectionPreview(""); setText(""); api.current?.clear();
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (!mounted.current || !workspace.isCurrent(token, generation)) return;
      if (!failure.submissionUnknown && !sideId) { localStorage.removeItem(pendingKey); setPendingId(""); }
      setError(failure.message);
    } finally { if (mounted.current && workspace.isCurrent(token, generation)) setBusy(false); }
  };
  const submitGenUi = async (question: string) => {
    if (executionBlocked || modelUnavailable || busy || pendingId || unsettled || active || !project.state?.connected || !sideId || !validSide || side.desktop?.archived) throw Error("Side conversation is not available");
    const token = workspace.capture(generation);
    setBusy(true); setError("");
    try {
      if (!mounted.current || !workspace.isCurrent(token, generation)) throw Error("Side conversation changed");
      await action("side", { projectId: project.id, operation: "send", threadId: sideId, text: question });
    } finally { if (mounted.current && workspace.isCurrent(token, generation)) setBusy(false); }
  };
  const configure = async (values: Data) => {
    if (busy || pendingId || unsettled || active || !project.state?.connected || sideId && (!validSide || side.desktop?.archived)) return;
    if (!sideId) {
      const next = { ...draftConfig, parameters: Object.hasOwn(values, "model") ? values.model === undefined ? undefined : {} : draftConfig?.parameters, ...values };
      localStorage.setItem(configKey, JSON.stringify(next)); setDraftConfig(next); return;
    }
    if (executionBlocked) return;
    const token = workspace.capture(generation);
    setBusy(true); setError("");
    try { await action("configure", { projectId: project.id, threadId: sideId, expectedRevision: config?.revision, ...values }); }
    catch (cause) { if (mounted.current && workspace.isCurrent(token, generation)) setError((cause as Error).message); }
    finally { if (mounted.current && workspace.isCurrent(token, generation)) setBusy(false); }
  };
  useEffect(() => { api.current?.focus(); }, []);
  const stop = () => {
    if (executionBlocked) return;
    const turn = side?.turns?.find((item: Data) => item.status === "inProgress");
    if (validSide && turn) void action("stop", { projectId: project.id, threadId: sideId, turnId: turn.id, requestId: crypto.randomUUID() }).catch((cause: Error) => setError(cause.message));
  };
  const editorDisabled = !project.state?.connected || busy || !!pendingId || unsettled || !!sideId && (!validSide || side.desktop?.archived);
  const disabled = editorDisabled || executionBlocked;
  const nextPrompt = useComposerPrediction({ project, thread: validSide ? side : undefined, action, enabled: prefs.nextPromptSuggestions,
    eligible: !!validSide && !disabled && !active && !selection && !bringPreview && !loading,
  });
  return <>
    <div className="side-chat-information" hidden={!contextOpen}>
      {validSide && <p role="status">{sourceStatus}{active && <> · {side.desktop?.sideCapacityStatus === "waiting" ? "等待模型容量" : "正在生成"}</>}</p>}
      <details className="side-chat-context" open><summary>会话上下文与文件访问</summary><p className="text-foreground-subtle">来源：{source.preview || source.id}。{validSide ? sourceStatus : anchor?.kind === "turn" ? `首问锚定轮次 ${anchor.turnId} 之后的持久证据` : "首问发送时冻结最新持久观察"}。{validSide && side.conversation.policy?.workspaceAccess === "readOnly" ? "可只读查询当前工作区；文件内容可能与历史锚点不同。" : "仅会话证据"}；不会执行来源任务。</p>
      {!sideId && <label>文件访问范围 <select value={workspaceAccess} onChange={event => {
        const value = event.target.value;
        if (value !== "none" && value !== "readOnly") return;
        localStorage.setItem(workspaceAccessKey, value); setWorkspaceAccess(value);
      }} disabled={busy || !!pendingId}>
        {(workspaceReadAvailable || workspaceAccess === "readOnly") && <option value="readOnly" disabled={!workspaceReadAvailable}>{workspaceReadAvailable ? "只读当前工作区" : "只读当前工作区（当前不可用）"}</option>}
        <option value="none">仅会话证据</option>
      </select></label>}
      {!sideId && !workspaceReadAvailable && <p className="text-foreground-subtle">当前 Core 未提供经过验证的工作区只读能力；可使用仅会话证据。</p>}
      {validSide && <p className="text-foreground-subtle">冻结锚点：{side.conversation.origin?.boundary} · {side.conversation.origin?.sourceTurnId || "空历史"}</p>}
      {validSide && side.conversation.selection && <blockquote className="notice">{side.conversation.selection.verified ? "已验证来源片段" : "用户引文，来源未确认"}：{side.conversation.selection.text}</blockquote>}
      {validSide && <div className="utility-actions"><button type="button" onClick={() => void loadEvidence()} disabled={evidenceBusy}>查看冻结证据</button></div>}
      {validSide && evidenceOpen && <section aria-label="冻结证据" className="side-evidence">
        <p>快照 {side.conversation.referenceSnapshot?.snapshotId}；仅显示已加载的证据。</p>
        {evidence.map((row, index) => <article key={`${row.evidenceRef}:${row.range?.startUtf8 ?? 0}:${index}`}>
          <small>轮次 {row.sourceTurnId} · 项 {row.sourceItemId} · {row.sourceTurnStatus}</small>
          <pre>{row.text}</pre>
          {row.range && row.range.endUtf8 < row.range.totalBytes && <small>片段 {row.range.startUtf8}–{row.range.endUtf8} / {row.range.totalBytes} 字节</small>}
          <button type="button" onClick={() => document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(row.sourceTurnId)}"]`)?.scrollIntoView({ block: "center" })}>在来源定位</button>
        </article>)}
        {evidenceCursor && <button type="button" disabled={evidenceBusy} onClick={() => void loadEvidence(evidenceCursor)}>继续加载证据</button>}
      </section>}
      {sideId && !validSide && <p role="status">{side ? "旁路归属与当前来源不一致。" : loading ? "正在恢复旁路讨论…" : "正在核对旁路归属…"}</p>}
      {validSide && side.desktop?.archived && <p role="status">这段讨论已归档；请在相关讨论中显式恢复后继续。</p>}
      </details>
    </div>
    <div className="side-chat-transcript">
      {!sideId && <div className="side-chat-empty"><SideChatIcon size={30} /><h2>侧边聊天</h2><p>岔开一个问题，主聊天留在原处。</p><small>讨论会保留，可从相关讨论中恢复。</small></div>}
      {validSide && <Messages onGenUiFollowUp={submitGenUi} key={`${owner}:${sideId}`} project={project} thread={side} action={action} dark={dark} reserveResponseSpace={false}
        onLink={() => setError("旁路不提供链接预览；可复制链接后从主会话打开。")}
        onFile={() => setError(side.conversation.policy?.workspaceAccess === "readOnly" ? "旁路模型可只读查询当前工作区；请在问题中指定文件路径。" : "此旁路仅能读取冻结会话证据。")}
        onReview={() => {}} readTurnReview={async () => ({})} responseActions={answer => <><Button type="button" variant="ghost" size="sm" className="side-bring-action" onClick={() => prepareBringBack(answer.text, true)}>带回整条回复</Button><Button type="button" variant="ghost" size="sm" className="side-bring-action" onClick={() => prepareBringBack(answer.text, false)}>带回选中文字</Button></>} />}
    </div>
    <div className="side-chat-feedback">
      {bringPreview && <section aria-label="带回预览" className="side-evidence">
        <p>来源 Side：{side?.preview || sideId}；{sourceStatus}。请核对或编辑将插入的文字。</p>
        {bringPreview.stale && <p role="status">来源在旁路创建后已推进；以下文字仍依据旧快照。</p>}
        <textarea aria-label="编辑带回文字" value={bringPreview.text} onChange={event => setBringPreview({ ...bringPreview, text: event.target.value })} />
        <div className="utility-actions">
          <button type="button" onClick={confirmBringBack}>确认插入主草稿</button>
          <button type="button" onClick={() => {
            if (!navigator.clipboard?.writeText) { setBringResult("无法自动复制，请手动选择预览文字。"); return; }
            void navigator.clipboard.writeText(bringPreview.text).then(() => setBringResult("已复制带回文字。"), () => setBringResult("复制失败，请手动选择预览文字。"));
          }}>复制文字</button>
          <button type="button" onClick={() => { setBringPreview(null); setBringResult(""); }}>取消</button>
        </div>
      </section>}
      <Feedback message={bringResult} />
      <Feedback error={error} />
      {restoreState === "error" && <button type="button" disabled={!project.state?.connected} onClick={() => { if (restore.retry()) { setError(""); setRestoreState("idle"); } }}>重试恢复旁路</button>}
      {unsettled && !active && <p role="status">提交结果尚未确认；不会自动重发。<button type="button" onClick={() => { void action("reconcile", { projectId: project.id }).catch((cause: Error) => setError(cause.message)); }}>核对受理状态</button></p>}
      {pendingId && <button type="button" onClick={() => void recover()} disabled={busy}>核对首问结果</button>}
    </div>
    <div className="composer-dock side-chat-composer" data-side-owner={owner}>
      <div className="composer-input-stack">
      <div ref={setMenuAnchor} className="composer-menu-anchor" />
      <ConversationComposer nextPrompt={nextPrompt} project={project} contextControl={<ContextMeter key={`${project.id}:${sideId ?? "draft"}`} project={project} thread={validSide ? side : undefined} action={action} />} modelConfig={config} fallbackModelConfig={!sideId ? project.configurations?.[source.id] : undefined} modelDisabled={editorDisabled || !!active || !!sideId && (executionBlocked || !config)}
        onConfigureModel={values => { void configure(values); }}
        workspacePath={project.root} taskId={sideId || null} triggerPanelContainer={menuAnchor}
        inputApiRef={api} inputTestId="side-chat-input" submitTestId="side-chat-send" initialValue={text}
        topContent={selection && !sideId ? <section data-testid="side-selection-quote" aria-label={t("chat.selection.quote")}
          className="flex items-start gap-inline rounded-inset border border-border bg-background p-2 text-ui-sm">
          <div className="min-w-0 flex-1">
            <p className="text-foreground-subtle">{t(selection.kind === "itemRange" ? "chat.selection.persisted" : "chat.selection.unverified")}</p>
            <blockquote className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{selectionPreview || selection.text}</blockquote>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("chat.selection.remove")} disabled={editorDisabled} onClick={() => {
            localStorage.removeItem(selectionKey); localStorage.removeItem(previewKey); localStorage.removeItem(anchorKey);
            setSelection(null); setSelectionPreview(""); setAnchor(null); api.current?.focus();
          }}><CloseIcon /></Button>
        </section> : undefined}
        pluginMentionCatalog={plugins.catalog}
        composerCatalog={{ entries: [], refresh: () => {} }}
        placeholder="随心输入" disabled={editorDisabled} submitDisabled={disabled || modelUnavailable || !!active || (!text.trim() && !selection)}
        submitDisabledReason={modelUnavailable ? t("chat.composer.previousModelUnavailable") : undefined}
        allowSubmitWhenEmpty={!!selection && !sideId}
        submitting={busy} submitLabel="发送" enterSubmits={prefs.sendShortcut === "enter"} enableMentionPanel={false}
        onChange={value => { setText(value); localStorage.setItem(draftKey, value); }}
        onSubmit={value => { void submit(value); return false; }} onCancel={active ? stop : undefined}
        promptHistory={(side?.turns ?? []).flatMap((turn: Data) => (turn.items ?? []).filter((item: Data) => item.type === "userMessage").map((item: Data) => (item.content ?? []).filter((part: Data) => part.type === "text").map((part: Data) => part.text).join("\n")))}
        submitControl={active && !text.trim() ? <Button type="button" variant="secondary" size="icon" className="composer-primary-action composer-stop-action" aria-label="停止旁路" disabled={executionBlocked} onClick={stop}><StopIcon className="size-4" /></Button> : undefined}
      />
      </div>
    </div>
  </>;
}
