import { useI18n } from "./i18n/IntlProvider.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer, sending } from "./Composer.js";
import { Messages } from "./Messages.js";
import { useConversationEscape } from "./useConversationEscape.js";
import { registerTransientComposer, composerDraftStorage } from "./composerDraftStorage.js";
import { addConversationSelection, conversationSelectionScope, selectionLimitMessage } from "./conversationSelectionReference.js";
import { useMcpAppsWorkspace, McpMentionsPicker } from "./McpAppsWorkspace.js";
import { mcpAppEntrypoints, toolTitle } from "./settings/McpAppsSettings.js";
import { McpAppIcon } from "./McpAppIcon.js";
import { useBrowserWorkspace, browserPageId, browserTabId } from "./app-shell/useBrowserWorkspace.js";
import { Preview } from "./Preview.js";
import { GitPane } from "./GitPane.js";
import { WorkspaceFilePane, confirmCloseFiles } from "./WorkspaceFilePane.js";
import { WorkspaceFileTree } from "./workspace-file-tree/WorkspaceFileTree.js";
import { AgentConversationPane } from "./AgentConversationPane.js";
import { McpSettings, TaskSkillsSettings } from "./settings/ResourceSettings.js";
import { ContextPane } from "./ContextPane.js";
import { ProcessesPane } from "./ProcessesPane.js";
import { PlanPane } from "./PlanPane.js";
import { SavedPermissionsPane } from "./SavedPermissionsPane.js";
import { ImageAnnotationPane } from "./ImageAnnotationViews.js";
import { setImageAnnotationEditing, type ImageAnnotationTarget } from "./imageAnnotations.js";
import { Button } from "./components/ui/button.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { call, type Action, type Data, type PlatformServices } from "./services.js";
import type { SideChatTab, SideResourceBinding } from "./useSideChatTabs.js";
import "./SideChat.css";

export function ExecutableSideChatPane({ tab, project, projects, services, dark, active, resource, executionBlocked, onNew, onOpenResource, onRemoveResource, onBackToChat, onBinding, onInspectClose }: {
  tab: SideChatTab; project: Data; projects: Data[]; services: PlatformServices; dark: boolean;
  active: boolean; resource: string; executionBlocked: boolean; onNew: () => void; onOpenResource: (resource: string) => void; onRemoveResource: (resource: string) => void; onBackToChat: () => void; onBinding: (binding: SideResourceBinding | null) => void; onInspectClose: () => void;
}) {
  const { t } = useI18n();
  const action: Action = useCallback((name: import("./services.js").CommandName, params: Data = {}) => call(services, name,
    name === "workspace" && params.projectId === project.id && !params.threadId
      ? { ...params, threadId: tab.childId } : params), [services, project.id, tab.childId]);
  const fileOpen = useMemo<PlatformServices["fileOpen"]>(() => services.fileOpen ? request =>
    services.fileOpen!("projectId" in request && request.projectId === project.id
      ? { ...request, threadId: tab.childId } : request) : undefined, [services.fileOpen, project.id, tab.childId]);
  registerTransientComposer(project.id, tab.childId);
  const pane = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const setResource = (name: string) => name ? onOpenResource(name) : onBackToChat();
  const onFile = (path: string) => onOpenResource(`file:${path.startsWith(project.root + "/") ? path.slice(project.root.length + 1) : path}`);
  const [mentions, setMentions] = useState(false);
  const [review, setReview] = useState<{ threadId: string; turnId: string }>();
  const [annotation, setAnnotation] = useState<ImageAnnotationTarget | null>(null);
  const thread = project.state?.threads?.[tab.childId];
  const owned = thread?.conversation?.kind === "side" && thread.conversation.policy?.kind === "sideExecutableV2"
    && thread.conversation.origin?.sourceThreadId === tab.parentId;
  useEffect(() => {
    let current = true;
    if (!project.state?.connected) return;
    void action("open", { projectId: project.id, threadId: tab.childId }).catch(cause => {
      if (!current) return;
      setError(cause.message);
    });
    return () => { current = false; };
  }, [action, project.id, tab.childId, project.state?.connected]);
  useConversationEscape({ pane, project, thread, action, enabled: active && owned && !executionBlocked && !tab.closeRequestId, onError: setError });
  const browser = useBrowserWorkspace(services, project.id, tab.childId, browserPageId(resource));
  const openBrowser = useCallback(async (url?: string) => {
    let state = await browser.request("state");
    if (!state.workspace?.selectedPageId) state = await browser.request("newPage");
    const pageId = state.browser?.pageId ?? state.workspace?.selectedPageId;
    if (!pageId) return;
    if (url) await browser.request("navigate", { pageId, url });
    await browser.request("selectPage", { pageId });
    setResource(browserTabId(pageId));
  }, [browser.request]);
  const onLink = useCallback((url: string) => {
    void services.preview({ operation: "openLink", projectId: project.id, threadId: tab.childId, url }).then(result => {
      if (result.destination === "internal") return openBrowser(result.url);
    }).catch(cause => setError(cause.message));
  }, [services, project.id, tab.childId, openBrowser]);
  useEffect(() => services.onPreviewEvent?.(event => {
    if (event.kind === "reveal" && event.projectId === project.id && event.threadId === tab.childId && active)
      setResource(browserTabId(event.pageId));
  }), [services, project.id, tab.childId, active]);
  const apps = useMcpAppsWorkspace({ services, project, projects, threadId: tab.childId, action, deepLinksEnabled: false,
    activeTab: active ? resource : "",
    onOpenThread: async (projectId, threadId) => { if (projectId === project.id && threadId !== tab.childId) setResource(`agent:${threadId}`); },
    onReveal: (name, owner) => { if (owner.projectId === project.id && owner.threadId === tab.childId && active) setResource(name); },
    onRemoveTab: onRemoveResource, onError: setError });
  const bindingCallback = useRef(onBinding); bindingCallback.current = onBinding;
  const binding = useRef<SideResourceBinding>({ close: async () => {} });
  binding.current = { close: async name => {
    if (name.startsWith("mcp-app:")) await apps.close(name);
    else if (name.startsWith("browser:")) await browser.request("release", { pageId: browserPageId(name), userIntent: true });
    else if (name.startsWith("file:") && !confirmCloseFiles(project.id, [name.slice(5)], project.root)) throw new Error(t("chat.side.fileUnsaved"));
  } };
  useEffect(() => { bindingCallback.current({ close: name => binding.current.close(name) }); return () => bindingCallback.current(null); }, []);
  const appEntries: ComposerCatalogEntry[] = mcpAppEntrypoints(apps.servers, "thread").map(({ server, tool }) => ({
    value: `app:${server.serverId}:${tool.name}`, label: toolTitle(tool), description: t("chat.side.openApp"), group: "应用",
    icon: <McpAppIcon icon={tool.icons?.[0] ?? server.icons?.[0]} size={16} loadMetadataImage={apps.loadMetadataImage} />,
    disabled: executionBlocked || !!tab.closeRequestId,
    run: () => { void apps.openApp(server, tool, { kind: "thread" }).catch(cause => setError(cause.message)); },
  }));
  const readTurnReview = useCallback((turnId: string, itemId?: string) => action("workspace", {
    operation: "turnReview", projectId: project.id, threadId: tab.childId, turnId, itemId,
  }), [action, project.id, tab.childId]);
  const openReview = (threadId: string, turnId: string) => { setReview({ threadId, turnId }); setResource("改动"); };
  const onReview = (turnId: string) => openReview(tab.childId, turnId);
  useEffect(() => {
    if (!annotation) return;
    setImageAnnotationEditing(annotation.draftKey, true);
    return () => setImageAnnotationEditing(annotation.draftKey, false);
  }, [annotation]);
  const renderResource = () => {
    if (annotation) return <ImageAnnotationPane file={annotation.file} onDone={() => { const focus = annotation.returnFocus; setAnnotation(null); requestAnimationFrame(focus); }} />;
    if (resource.startsWith("mcp-app:")) return apps.render(resource);
    if (resource.startsWith("browser:")) return <Preview services={services} projectId={project.id} threadId={tab.childId}
      pageId={browserPageId(resource)!} state={browser.state} requestPage={browser.request} thread={thread} action={action}
      onReview={onReview} onError={setError} onTool={itemId => { setResource(""); requestAnimationFrame(() => pane.current?.querySelector(`[data-tool-id="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: "center" })); }} />;
    if (resource === "改动") return <GitPane projectId={project.id} threadId={review?.threadId ?? tab.childId} root={project.root} action={action}
      turnId={thread?.turns?.findLast((turn: Data) => turn.status !== "inProgress")?.id}
      reviewRequest={review ? { turnId: review.turnId } : undefined}
      onReveal={onFile} onFile={onFile} fileOpen={fileOpen} commentsDisabled={executionBlocked || !!tab.closeRequestId || !!review && review.threadId !== tab.childId} />;
    if (resource.startsWith("file:")) return <WorkspaceFilePane projectId={project.id} root={project.root} path={resource.slice(5)} action={action}
      onDirty={() => {}} onLink={onLink} fileOpen={fileOpen} filesOpen={false} onToggleFiles={() => setResource("文件")} />;
    if (resource === "文件") return <WorkspaceFileTree projectId={project.id} root={project.root} action={action} onClose={() => setResource("")} onOpen={onFile} activePath="" />;
    if (resource.startsWith("agent:")) { const childId = resource.slice(6); return <AgentConversationPane project={project}
      parentId={project.state?.threads?.[childId]?.parentThreadId ?? tab.childId} childId={childId} action={action} dark={dark}
      onLink={onLink} onFile={onFile} onReview={openReview} onAgent={id => setResource(`agent:${id}`)} />; }
    const props = { project, thread, action };
    if (resource === "MCP") return <McpSettings {...props} />;
    if (resource === "Skills") return <TaskSkillsSettings {...props} />;
    if (resource === "上下文") return <ContextPane {...props} />;
    if (resource === "进程") return <ProcessesPane {...props} onOpenService={url => { void openBrowser(url).catch(cause => setError(cause.message)); }} />;
    if (resource === "执行计划") return <PlanPane {...props} />;
    if (resource === "已保存授权") return <SavedPermissionsPane {...props} />;
    return null;
  };
  return <section ref={pane} className="side-chat-pane" data-testid="side-chat-pane" data-thread-id={tab.childId} aria-label={t("chat.side.numbered", { ordinal: tab.ordinal })}>
    {(resource || annotation) && <div className="side-chat-toolbar"><Button size="sm" variant="ghost" onClick={() => { onBackToChat(); setAnnotation(null); }}>{t("chat.side.back")}</Button></div>}
    {error && <p role="alert" className="notice">{error}</p>}
    {tab.closeRequestId && <p role="status" className="notice">{tab.closeError || t("chat.side.closing")}<Button variant="ghost" size="sm" onClick={onInspectClose}>{t("chat.side.inspectClose")}</Button></p>}
    {resource || annotation ? <div className="side-chat-resource">{renderResource()}</div> : owned ? <>
      <div className="side-chat-transcript"><Messages project={project} thread={thread} action={action} dark={dark}
        onLink={onLink} onFile={onFile} onReview={onReview} readTurnReview={readTurnReview} onAgent={id => setResource(`agent:${id}`)}
        onOpenResult={apps.openResult} resultStates={apps.resultStates}
        onAddSelection={reference => {
          const key = `areal-gui:draft:${project.id}:${tab.childId}`;
          if (sending.has(key) || composerDraftStorage.getItem(`${key}:pending`) || composerDraftStorage.getItem(`${key}:queue-edit`)) return;
          const result = addConversationSelection(conversationSelectionScope(project.id, tab.childId), reference); if (!result.ok) setError(selectionLimitMessage(t, result.reason)); }} /></div>
      {apps.contexts}{apps.formsView}
      {mentions && <McpMentionsPicker servers={apps.servers} projectId={project.id} threadId={tab.childId} action={action} onClose={() => setMentions(false)} />}
      <Composer inputTestId="side-chat-input" submitTestId="side-chat-send" project={project} thread={thread} executionBlocked={executionBlocked || !!tab.closeRequestId} action={action} readAction={action}
        onPanel={name => name === "预览" ? void openBrowser().catch(cause => setError(cause.message)) : setResource(name)} onNew={onNew}
        onAnnotate={setAnnotation} onMcpMention={() => setMentions(true)} appEntries={appEntries} />
    </> : <p className="notice" role="status">{t("chat.side.reading")}</p>}
    {apps.pages}
  </section>;
}
