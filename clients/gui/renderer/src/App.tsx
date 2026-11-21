import { AppProviders, WorkbenchProviders } from "./app-shell/WorkbenchProviders.js";
import React, { useEffect, useSyncExternalStore } from "react";
import { WorkSurface, WorkbenchShell } from "./app-shell/WorkbenchShell.js";
import { BackendStatusNotice } from "./BackendStatusNotice.js";
import { sending, subscribeSending } from "./Composer.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { Inbox } from "./Inbox.js";
import { recoverySettings } from "./recoveryPresentation.js";
import { type Data, type PlatformServices } from "./services.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { settingsNavigationGroups } from "./settings/settingsNavigation.js";
import { labsAvailable } from "./settings/labsFeatures.js";
import { SettingsNavigation } from "./settings/SettingsWorkspace.js";
import { useGuardedQuit } from "./settings/UnsavedChanges.js";
import { useTrajectoryPolling } from "./settings/useTrajectoryPolling.js";
import { useNavigationWorkspace } from "./state/navigationWorkspace.js";
import { projectExecutionBlocked } from "./state/projectExecution.js";
import { useTaskWorkspace } from "./state/taskWorkspace.js";
import { useBackendRecovery } from "./state/useBackendRecovery.js";
import { useComposerWorkspace } from "./state/useComposerWorkspace.js";
import { useConversationFork } from "./state/useConversationFork.js";
import { useConversationObservation } from "./state/useConversationObservation.js";
import { usePanelNavigation } from "./state/usePanelNavigation.js";
import { useRecoveryNotices } from "./state/useRecoveryNotices.js";
import { useSessionNavigation } from "./state/useSessionNavigation.js";
import { useSideConversations } from "./state/useSideConversations.js";
import { useStartupPresentation } from "./state/useStartupPresentation.js";
import { useStartupRecovery } from "./state/useStartupRecovery.js";
import { useWorkbenchAppearance } from "./state/useWorkbenchAppearance.js";
import { useWorkbenchNavigation } from "./state/useWorkbenchNavigation.js";
import { useWorkbenchSurfaces } from "./state/useWorkbenchSurfaces.js";
import { useWorkspaceAnnotation } from "./state/useWorkspaceAnnotation.js";
import { useWorkspaceDocuments } from "./state/useWorkspaceDocuments.js";
import { useWorkspacePanels } from "./state/useWorkspacePanels.js";
import { useWorkspacePreview } from "./state/useWorkspacePreview.js";
import { terminalOwner, useTerminalWorkspace } from "./terminal/terminalWorkspace.js";
import { ToastHost } from "./ToastHost.js";
import { UpdateIndicator } from "./UpdateIndicator.js";
import { UpgradeGuide } from "./views/UpgradeGuide.js";
import { useConversationEscape } from "./useConversationEscape.js";
import { ConversationNavigation } from "./views/ConversationNavigation.js";
import { ConversationWorkspace } from "./views/ConversationWorkspace.js";
import { RecoveryNotices } from "./views/RecoveryNotices.js";
import { StartupScreen } from "./views/StartupScreen.js";
import { TaskWorkspace } from "./views/TaskWorkspace.js";
import {
  ConversationHeader,
  WorkbenchRail,
  WorkspaceNavigation,
  WorkspaceTaskActions,
} from "./views/WorkbenchChrome.js";
import { WorkbenchPlugins } from "./views/WorkbenchPlugins.js";
import { WorkbenchSettings } from "./views/LazyWorkbenchSettings.js";
import { LazyBotsWorkspace } from "./bots/LazyBotsWorkspace.js";
import { WorkspacePanelContent } from "./views/LazyWorkspacePanelContent.js";
import { WorkspacePanels } from "./views/WorkspacePanels.js";
import { WorkspaceFileTree } from "./workspace-file-tree/WorkspaceFileTree.js";
import { usePendingMessage } from "./pendingMessage.js";
export function App({ services }: { services: PlatformServices }) {
  // prettier-ignore
  return <AppProviders services={services}><AppContent services={services} /></AppProviders>;
}
function AppContent({ services }: { services: PlatformServices }) {
  const { t } = useI18n();
  const [upgradeAvailable, setUpgradeAvailable] = React.useState(false);
  const [upgradeOpenRequest, setUpgradeOpenRequest] = React.useState(0);
  const requestNavigation = useGuardedQuit(services);
  const { terminalLocation, nextPromptSuggestions } = useApplicationPreferences();
  const session = useSessionNavigation(services, (message) => setError(message));
  const {
    snapshot,
    library,
    projects,
    summaries,
    project,
    thread,
    projectId,
    threadId,
    workspaceHistory,
    restoration,
    restorationOwner,
    prewarmReady,
    selectionReady,
    resourceAction,
    restoreConversation,
    retryRestoration,
  } = session;
  useEffect(
    () => () => {
      session.dispose();
    },
    [],
  );
  const workspacePanels = useWorkspacePanels();
  const { panel, panelTabs, previewFileTab, workspaceView, filesOpen, revealedFile, fileLocation } =
    workspacePanels.view;
  const annotation = useWorkspaceAnnotation(`${project?.id ?? ""}:${threadId}`, workspacePanels);
  const { annotationTarget, annotationVisible } = annotation;
  const documents = useWorkspaceDocuments(project, workspacePanels, () => rememberPanelTrigger());
  const { requestReview: setReviewRequest, openFile } = documents;
  const botDrafts = React.useRef(new Map<string, string>());
  const contextReturn = React.useRef<(() => void) | null>(null);
  useEffect(() => {
    workspacePanels.retainSelectedTab(panel);
  }, [panel]);
  const taskWorkspace = useTaskWorkspace();
  const tasks = taskWorkspace.workspace;
  const taskSurface = taskWorkspace.surface;
  const taskCenterOpen = taskSurface !== null;
  const surfaces = useWorkbenchSurfaces(
    projectId,
    threadId,
    taskCenterOpen,
    requestNavigation,
    tasks,
    (pid, tid) => open(pid, tid),
  );
  session.resourceBrowsing.current = surfaces.pluginCenterActive;
  const {
    settingsTab,
    settingsOpen,
    pluginsOpen,
    botsOpen,
    setSettingsTab,
    setSettingsOpen,
    trajectoryAttention,
    onTrajectoryStatus,
  } = surfaces;
  const navigationWorkspace = useNavigationWorkspace();
  const navigation = navigationWorkspace.workspace;
  useEffect(surfaces.restoreSettingsFocus, [settingsOpen]);
  const fork = useConversationFork(
    project,
    thread,
    resourceAction,
    (pid, tid) => open(pid, tid),
    (message) => setError(message),
  );
  useEffect(() => session.subscribe(), [services]);
  const recovery = useRecoveryNotices(services, snapshot, restorationOwner);
  const { setError, action } = recovery;
  const appearance = useWorkbenchAppearance(services, setError);
  const {
    dark,
    themeReady,
    sidebar,
    setSidebar,
    sidebarWidth,
    setSidebarWidth,
    collapsedProjects,
    setCollapsedProjects,
    toggleSidebarGroup,
  } = appearance;
  const startup = useStartupRecovery(session, themeReady, t);
  const {
    viewFailure,
    restorationError,
    viewRefreshing,
    restorationFailed,
    startupLifecycle,
    startupLifecycleBlocked,
    startupReady,
    projectFailureReady,
  } = startup;
  const { shellReady, initialReleased, startupDelayed } = useStartupPresentation(
    services,
    { themeReady, startupReady, restorationFailed, projectFailureReady },
    restoration,
    restorationOwner,
  );
  const preview = useWorkspacePreview(services, session, workspacePanels, setError);
  const { previewOwner, browserWorkspace, rememberPanelTrigger, openBrowser, onLink } = preview;
  useEffect(preview.subscribeReveals, [services]);
  const terminalState = useTerminalWorkspace(terminalOwner(project?.id ?? "", threadId));
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  useEffect(() => {
    contextReturn.current = null;
  }, [panelOwner]);
  React.useLayoutEffect(annotation.reconcileTarget, [annotationTarget, panelOwner, panel]);
  useEffect(annotation.subscribeDraft, [annotationTarget, panelOwner]);
  React.useLayoutEffect(() => {
    workspacePanels.commitOwner(panelOwner, terminalState.ids);
  }, [
    panelOwner,
    panel,
    panelTabs,
    previewFileTab,
    filesOpen,
    revealedFile,
    fileLocation,
    terminalState.ids,
  ]);
  useEffect(() => {
    workspacePanels.reconcileBrowser(panelOwner, browserWorkspace);
  }, [browserWorkspace.workspace, panelOwner]);
  useEffect(() => {
    workspacePanels.reconcileTerminals(terminalState.ids);
  }, [terminalState.ids]);
  const observation = useConversationObservation(
    session,
    action,
    nextPromptSuggestions,
    initialReleased,
    settingsOpen,
    taskCenterOpen,
  );
  useEffect(observation.cancelDisabledPredictions, [
    nextPromptSuggestions,
    snapshot.projects,
    action,
  ]);
  const side = useSideConversations(
    project,
    thread,
    threadId,
    snapshot,
    resourceAction,
    workspacePanels,
    annotationVisible,
    viewRefreshing,
    rememberPanelTrigger,
    setError,
  );
  const { sideChats } = side;
  const mainPane = React.useRef<HTMLElement>(null);
  useConversationEscape({
    pane: mainPane,
    project,
    thread,
    action,
    onError: setError,
    enabled:
      !session.readOnly &&
      initialReleased &&
      !settingsOpen &&
      !taskCenterOpen &&
      !pluginsOpen &&
      !botsOpen &&
      workspaceView !== "panel" &&
      !!project?.state?.connected &&
      !projectExecutionBlocked(snapshot.lifecycle, project?.id ?? ""),
    outsideFallback: !annotationVisible && (!panel || workspaceView === "conversation"),
  });
  useEffect(side.reconcileClosedTabs, [snapshot.projects, sideChats.tabs]);
  // 状态只更新设置入口，不阻塞启动、不反复弹窗，也不进入聊天错误栏。
  useTrajectoryPolling(resourceAction, {
    connected: !session.readOnly && snapshot.connection?.state === "ready",
    intervalMs: 15000,
    onResult: onTrajectoryStatus,
    onError: () => onTrajectoryStatus(null),
  });
  const { readTurnReview, selectedCompletion, completionInterruptPending } = observation;
  useEffect(observation.markForegroundCompletionRead, [
    initialReleased,
    project?.id,
    project?.state?.connected,
    threadId,
    thread?.id,
    selectedCompletion,
    completionInterruptPending,
    settingsOpen,
    taskCenterOpen,
    action,
  ]);
  const reconnectService = async () => {
    const pendingRestoration = session.pendingRestoration();
    if (!initialReleased && pendingRestoration) {
      await pendingRestoration;
      return;
    }
    if (project) {
      await restoreConversation(restorationOwner, project.state?.connected ? "open" : "connect", {
        connectService: true,
        resumeScheduling: true,
      });
    } else await resourceAction("connectService", {});
  };
  const backend = useBackendRecovery(snapshot, resourceAction, reconnectService, () => {
    setSettingsTab("diagnostics");
    setSettingsOpen(true);
  });
  const { backendActionPending, backendActionError, runBackendAction, quitStartup } = backend;
  const navigationCommands = useWorkbenchNavigation(
    services,
    session,
    surfaces,
    tasks,
    workspacePanels,
    navigation,
    initialReleased,
    taskCenterOpen,
    requestNavigation,
    setSidebar,
    setError,
  );
  const { choose, open, newTask, traverseWorkspaceHistory } = navigationCommands;
  useEffect(surfaces.restorePluginFocus, [
    pluginsOpen,
    botsOpen,
    settingsOpen,
    taskCenterOpen,
    projectId,
    threadId,
    thread,
  ]);
  const composerWorkspace = useComposerWorkspace(project);

  useEffect(navigationCommands.subscribeNotifications, [
    services,
    open,
    requestNavigation,
    projectId,
    initialReleased,
  ]);
  useEffect(session.synchronizeSelection, [
    project?.id,
    selectionReady,
    snapshot.connection?.state,
  ]);
  useEffect(session.synchronizeRestoration, [
    surfaces.pluginCenterActive,
    selectionReady,
    project?.id,
    threadId,
    project?.state?.connected,
    project?.core?.connectionGeneration,
    restorationOwner.hostGeneration,
    restorationOwner.connectionId,
    prewarmReady,
    snapshot.connection?.state,
    restoreConversation,
  ]);
  useEffect(navigationCommands.subscribeShortcuts, [
    initialReleased,
    project?.id,
    snapshot.projects,
    workspaceHistory,
    settingsOpen,
    taskCenterOpen,
  ]);
  const panelNavigation = usePanelNavigation(
    session,
    workspacePanels,
    preview,
    side,
    surfaces,
    navigation,
    initialReleased,
    terminalLocation,
    contextReturn,
  );
  const { setTerminalOpen, showFiles, openTerminal, hidePanel, showPanel } = panelNavigation;
  useEffect(panelNavigation.subscribeNarrowLayout, [panel, workspaceView]);
  useEffect(panelNavigation.subscribeShortcuts, [
    initialReleased,
    project?.id,
    settingsOpen,
    threadId,
    terminalLocation,
    openBrowser,
  ]);
  const conversationReferences = summaries
    .filter((row) => row.owner.id === project?.id && row.summary.id !== thread?.id && !row.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.summary.id.localeCompare(b.summary.id))
    .map((row) => ({ threadId: row.summary.id, title: row.title, updatedAt: row.updatedAt }));
  const pending = project?.pending?.some((p: Data) => p.params?.threadId === threadId);
  const currentTitle = threadId
    ? (summaries.find((r) => r.owner.id === project?.id && r.summary.id === threadId)?.title ??
      t("startup.loadingConversation"))
    : "新对话";
  const workspaceFileTree =
    filesOpen && project ? (
      <WorkspaceFileTree
        key={`${project.id}:${project.root}`}
        projectId={project.id}
        root={project.root}
        action={action}
        onClose={workspacePanels.closeFiles}
        onOpen={openFile}
        location={fileLocation}
        activePath={panel.startsWith("file:") ? panel.slice(5) : revealedFile}
      />
    ) : undefined;
  const panelBody = (panelName = panel) => (
    <WorkspacePanelContent
      panel={panelName}
      session={session}
      services={services}
      action={action}
      workspacePanels={workspacePanels}
      preview={preview}
      panelNavigation={panelNavigation}
      navigationCommands={navigationCommands}
      documents={documents}
      dark={dark}
      setError={setError}
      workspaceFileTree={workspaceFileTree}
      pending={pending}
      admitting={admitting}
      currentTitle={currentTitle}
    />
  );
  const admitting = useSyncExternalStore(subscribeSending, () =>
    sending.has(`areal-gui:draft:${project?.id}:${threadId || "new"}`),
  );
  const pendingMessage = usePendingMessage(`areal-gui:draft:${project?.id}:${threadId}`);
  const empty =
    !(thread && (admitting || pendingMessage)) &&
    thread?.conversation?.kind !== "fork" &&
    !thread?.turns?.some((turn: Data) => turn.items?.length || turn.status === "inProgress");
  const taskActions = (
    <WorkspaceTaskActions session={session} workspacePanels={workspacePanels} services={services} />
  );
  const pluginCenterActive = surfaces.pluginCenterActive;
  const applicationRail = (
    <WorkbenchRail
      session={session}
      surfaces={surfaces}
      tasks={tasks}
      taskSurface={taskSurface}
      services={services}
      requestNavigation={requestNavigation}
      setSidebar={setSidebar}
      showPanel={showPanel}
    />
  );
  const workspaceNavigation = (
    <WorkspaceNavigation
      workspaceHistory={workspaceHistory}
      taskCenterOpen={taskCenterOpen}
      sidebar={sidebar}
      setSidebar={setSidebar}
      traverseWorkspaceHistory={traverseWorkspaceHistory}
    />
  );
  const openModelSettings = () => {
    setSettingsTab("模型服务");
    setSettingsOpen(true);
  };
  const settingsPage = (
    <WorkbenchSettings
      session={session}
      surfaces={surfaces}
      tasks={tasks}
      workspacePanels={workspacePanels}
      navigationCommands={navigationCommands}
      services={services}
      action={action}
      appearance={appearance}
      backend={backend}
      reconnectService={reconnectService}
      initialReleased={initialReleased}
      panelBody={panelBody}
    />
  );
  return (
    <WorkbenchProviders
      bridge={services.snapShots}
      settings={library.settings}
      ready={startupReady && snapshot.connection?.state === "ready"}
      openSettings={panelNavigation.openSettings}
    >
      <WorkbenchShell
        data-view={
          settingsOpen
            ? "settings"
            : pluginsOpen
              ? "plugins"
              : botsOpen
                ? "bots"
                : taskCenterOpen
                  ? "tasks"
                  : "workspace"
        }
        data-testid="areal-workbench"
        data-project-id={project?.id ?? projectId}
        data-thread-id={threadId}
        data-startup-ready={startupReady}
        data-shell-ready={shellReady}
      >
        <UpgradeGuide
          services={services}
          ready={snapshot.connection?.state === "ready"}
          onAvailable={setUpgradeAvailable}
          openRequest={upgradeOpenRequest}
          onModels={openModelSettings}
        />
        <ToastHost />
        {!session.readOnly && (
          <BackendStatusNotice
            summary={snapshot.serviceSummary}
            connection={snapshot.connection}
            update={snapshot.backendUpdate}
            lifecycle={snapshot.lifecycle}
            currentCommands={
              snapshot.desktopCapabilities?.currentCommands ??
              project?.desktopCapabilities?.currentCommands
            }
            pending={backendActionPending}
            error={backendActionError}
            onAction={(kind) => void runBackendAction(kind)}
          />
        )}
        {!initialReleased && !projectFailureReady ? (
          <StartupScreen
            services={services}
            state={{
              connection: snapshot.connection,
              lifecycle: startupLifecycle,
              lifecycleBlocked: startupLifecycleBlocked,
              delayed: startupDelayed,
              restoration: {
                failed: restorationFailed,
                refreshing: viewRefreshing,
                error: restorationError,
                failure: viewFailure,
              },
              backend: { pending: backendActionPending, error: backendActionError },
            }}
            settingsPage={settingsOpen ? settingsPage : undefined}
            onCloseSettings={() => setSettingsOpen(false)}
            onRetry={() => void retryRestoration()}
            onBackendAction={(kind) => void runBackendAction(kind)}
            onSettings={() => {
              const failed =
                restorationFailed ||
                snapshot.connection?.state === "unavailable" ||
                !!startupLifecycle?.error;
              setSettingsTab(
                (viewFailure && recoverySettings(viewFailure)) || (failed ? "diagnostics" : "常规"),
              );
              setSettingsOpen(true);
            }}
            onQuit={() => void quitStartup()}
          />
        ) : (
          <>
            {!sidebar && !settingsOpen && !botsOpen && (
              <div className="areal-update-floating">
                <UpdateIndicator services={services} />
              </div>
            )}
            {settingsOpen && (
              <SettingsNavigation
                width={sidebarWidth}
                rail={applicationRail}
                activeId={["Skills", "MCP"].includes(settingsTab) ? "插件" : settingsTab}
                onSelect={setSettingsTab}
                onBack={() => setSettingsOpen(false)}
                groups={settingsNavigationGroups
                  .map((group) => ({
                    ...group,
                    label: t(group.label),
                    items: group.items
                      .filter((item) =>
                        item.id === "Labs"
                          ? labsAvailable
                          : services.capabilities?.settings === undefined ||
                            services.capabilities.settings.includes(item.id),
                      )
                      .map((item) => ({
                        ...item,
                        keywords: "keywords" in item ? t(item.keywords) : undefined,
                        label: t(
                          item.id === "数据飞轮" && trajectoryAttention
                            ? "settings.trajectory.attentionTitle"
                            : item.label,
                        ),
                      })),
                  }))
                  .filter((group) => group.items.length > 0)}
              />
            )}
            <ConversationNavigation
              services={services}
              setError={setError}
              snapshot={snapshot}
              projects={projects}
              summaries={summaries}
              projectId={project?.id}
              threadId={threadId}
              taskCenterOpen={taskCenterOpen}
              pluginsOpen={pluginsOpen}
              sidebar={sidebar}
              visible={!settingsOpen && !botsOpen}
              appearance={{
                sidebarWidth,
                setSidebarWidth,
                collapsedProjects,
                setCollapsedProjects,
                toggleSidebarGroup,
              }}
              workspaceNavigation={workspaceNavigation}
              applicationRail={applicationRail}
              navigation={navigation}
              action={action}
              requestNavigation={requestNavigation}
              choose={choose}
              newTask={newTask}
              onUpgradeHistory={
                upgradeAvailable ? () => setUpgradeOpenRequest((value) => value + 1) : undefined
              }
              open={open}
              closePanels={() => workspacePanels.selectPanel("")}
              onOpenProjectTasks={(pid) => {
                surfaces.leaveSettings();
                surfaces.leaveBots();
                tasks.openCatalog(pid);
              }}
            />
            {botsOpen ? (
              <LazyBotsWorkspace
                service={services.bots}
                drafts={botDrafts.current}
                chrome={workspaceNavigation}
                rail={applicationRail}
                sidebarWidth={sidebarWidth}
                onSidebarWidthChange={setSidebarWidth}
                active={botsOpen}
                onOpenModelServices={openModelSettings}
              />
            ) : (
              <main
                className={`work-area ${settingsOpen ? "settings-open" : ""}`}
                data-workspace-view={
                  !annotationVisible &&
                  panel &&
                  !pluginsOpen &&
                  !settingsOpen &&
                  !taskCenterOpen &&
                  workspaceView !== "split"
                    ? workspaceView
                    : undefined
                }
              >
                <WorkSurface
                  panelOpen={Boolean(
                    (annotationVisible || (panel && project)) &&
                    !pluginsOpen &&
                    !settingsOpen &&
                    !taskCenterOpen,
                  )}
                  split={
                    workspaceView === "split" && !pluginsOpen && !settingsOpen && !taskCenterOpen
                  }
                >
                  {!taskCenterOpen && (
                    <ConversationHeader
                      session={session}
                      surfaces={surfaces}
                      workspacePanels={workspacePanels}
                      documents={documents}
                      tasks={tasks}
                      sidebar={sidebar}
                      empty={empty}
                      currentTitle={currentTitle}
                      mainPane={mainPane}
                      contextReturn={contextReturn}
                      onLink={onLink}
                      showPanel={showPanel}
                      hidePanel={hidePanel}
                      rememberPanelTrigger={rememberPanelTrigger}
                      workspaceNavigation={workspaceNavigation}
                      taskActions={taskActions}
                    />
                  )}
                  <RecoveryNotices
                    recovery={recovery}
                    startup={startup}
                    session={session}
                    surfaces={surfaces}
                  />
                  {
                    <WorkbenchPlugins
                      session={session}
                      surfaces={surfaces}
                      navigationCommands={navigationCommands}
                    />
                  }
                  {pluginCenterActive ? null : settingsOpen ? (
                    settingsPage
                  ) : taskSurface === "inbox" ? (
                    <Inbox
                      projects={snapshot.projects}
                      connected={snapshot.connection?.state === "ready"}
                      action={resourceAction}
                      onClose={() => tasks.close()}
                    />
                  ) : taskCenterOpen ? (
                    <TaskWorkspace
                      fileOpen={services.fileOpen}
                      workspace={tasks}
                      snapshot={snapshot}
                      action={resourceAction}
                      dark={dark}
                      sidebar={sidebar}
                      onShowSidebar={() => setSidebar(true)}
                      onOpenThread={open}
                      onNewTask={newTask}
                      onPanel={showPanel}
                      onFile={openFile}
                      onLink={onLink}
                      onReview={(pid, tid, turnId) => {
                        setReviewRequest({ owner: `${pid}:${tid}`, turnId });
                        workspacePanels.selectPanel("改动");
                      }}
                    />
                  ) : (
                    <ConversationWorkspace
                      session={session}
                      services={services}
                      action={action}
                      dark={dark}
                      empty={empty}
                      admitting={admitting}
                      mainPane={mainPane}
                      workspacePanels={workspacePanels}
                      side={side}
                      fork={fork}
                      preview={preview}
                      documents={documents}
                      panelNavigation={panelNavigation}
                      composerWorkspace={composerWorkspace}
                      annotation={annotation}
                      surfaces={surfaces}
                      tasks={tasks}
                      startup={startup}
                      navigationCommands={navigationCommands}
                      conversationReferences={conversationReferences}
                      readTurnReview={readTurnReview}
                      pending={pending}
                      setError={setError}
                    />
                  )}
                </WorkSurface>
                <WorkspacePanels
                  session={session}
                  workspacePanels={workspacePanels}
                  side={side}
                  documents={documents}
                  annotation={annotation}
                  surfaces={surfaces}
                  browserWorkspace={browserWorkspace}
                  taskCenterOpen={taskCenterOpen}
                  services={services}
                  dark={dark}
                  empty={empty}
                  currentTitle={currentTitle}
                  sidebar={sidebar}
                  setSidebar={setSidebar}
                  taskActions={taskActions}
                  workspaceFileTree={workspaceFileTree}
                  panelBody={panelBody}
                  hidePanel={hidePanel}
                  showFiles={showFiles}
                  openTerminal={openTerminal}
                  openBrowser={openBrowser}
                  setTerminalOpen={setTerminalOpen}
                  previewOwner={previewOwner}
                  setError={setError}
                />
              </main>
            )}
            {fork.dialog}
          </>
        )}
      </WorkbenchShell>
    </WorkbenchProviders>
  );
}
