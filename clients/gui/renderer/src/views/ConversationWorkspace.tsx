import React from "react";
import { ComposerSurface } from "../prompt-editor/ComposerSurface.js";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { CloudComposer } from "../CloudComposer.js";
import { useCloudEnvironment } from "../cloudEnvironment.js";
import { FeedbackNotice } from "../FeedbackNotice.js";
import { Composer } from "../Composer.js";
import { ComposerWorkspaceContext } from "../ComposerWorkspaceContext.js";
import { ConversationDraftEmptyState } from "../ConversationDraftEmptyState.js";
import { DraftComposer } from "../DraftComposer.js";
import { LeaveProjectIcon, NewProjectIcon, ProjectFolderIcon } from "../homeChromeIcons.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { DismissIcon } from "../interfaceIcons.js";
import { McpMentionsPicker, useMcpAppsWorkspace } from "../McpAppsWorkspace.js";
import { Messages } from "../Messages.js";
import { ProjectlessDraft } from "../ProjectlessDraft.js";
import { isIndependentCreation } from "../recoveryPresentation.js";
import { type Action, type Data, type PlatformServices } from "../services.js";
import { projectExecutionBlocked } from "../state/projectExecution.js";
import { useTaskWorkspace } from "../state/taskWorkspace.js";
import type { useComposerWorkspace } from "../state/useComposerWorkspace.js";
import type { useConversationFork } from "../state/useConversationFork.js";
import type { usePanelNavigation } from "../state/usePanelNavigation.js";
import type { useSessionNavigation } from "../state/useSessionNavigation.js";
import type { useSideConversations } from "../state/useSideConversations.js";
import type { useStartupRecovery } from "../state/useStartupRecovery.js";
import type { useWorkbenchNavigation } from "../state/useWorkbenchNavigation.js";
import { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
import type { useWorkspaceAnnotation } from "../state/useWorkspaceAnnotation.js";
import type { useWorkspaceDocuments } from "../state/useWorkspaceDocuments.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
import type { useWorkspacePreview } from "../state/useWorkspacePreview.js";
import { WorktreeStarter } from "../WorktreeStarter.js";

import { createContext, useContext } from "react";

type ConversationWorkspaceProps = {
  session: ReturnType<typeof useSessionNavigation>;
  services: PlatformServices;
  action: Action;
  dark: boolean;
  empty: boolean;
  admitting: boolean;
  mainPane: React.RefObject<HTMLElement | null>;
  workspacePanels: ReturnType<typeof useWorkspacePanels>;
  mcpWorkspace: ReturnType<typeof useMcpAppsWorkspace>;
  side: ReturnType<typeof useSideConversations>;
  fork: ReturnType<typeof useConversationFork>;
  preview: ReturnType<typeof useWorkspacePreview>;
  documents: ReturnType<typeof useWorkspaceDocuments>;
  panelNavigation: ReturnType<typeof usePanelNavigation>;
  composerWorkspace: ReturnType<typeof useComposerWorkspace>;
  annotation: ReturnType<typeof useWorkspaceAnnotation>;
  surfaces: ReturnType<typeof useWorkbenchSurfaces>;
  tasks: ReturnType<typeof useTaskWorkspace>["workspace"];
  startup: ReturnType<typeof useStartupRecovery>;
  navigationCommands: ReturnType<typeof useWorkbenchNavigation>;
  setError: (message: string) => void;
  conversationReferences: React.ComponentProps<typeof Composer>["conversationReferences"];
  readTurnReview: NonNullable<React.ComponentProps<typeof Messages>["readTurnReview"]>;
  pending: boolean | undefined;
};
const ConversationContext = createContext<ConversationWorkspaceProps | null>(null);
function useConversationContext() {
  const context = useContext(ConversationContext);
  if (!context) throw new Error("Conversation context is missing");
  return context;
}
const TerminalPane = React.lazy(async () => {
  const { TerminalPane } = await import("../terminal/TerminalPane.js");
  return { default: TerminalPane };
});
export function ConversationWorkspace(props: ConversationWorkspaceProps) {
  return (
    <ConversationContext.Provider value={props}>
      <ConversationContent />
    </ConversationContext.Provider>
  );
}
function ConversationContent() {
  const {
    session,
    action,
    empty,
    admitting,
    mainPane,
    workspacePanels,
    preview,
    panelNavigation,
    startup,
    pending,
    setError,
  } = useConversationContext();
  const { project, thread, threadId, retryRestoration } = session;

  const { onLink } = preview;

  const { terminalOpen, setTerminalOpen } = panelNavigation;

  const { restorationFailed } = startup;

  const { t } = useI18n();
  return (
    <div className="workspace-content">
      <div className="conversation-column">
        <section
          ref={mainPane}
          className={`conversation-pane ${empty ? "draft-pane" : ""}`}
          data-testid="chat-view"
        >
          {thread && project ? (
            <ActiveConversation />
          ) : threadId ? (
            <div className="conversation-loading" role="status" aria-busy={!restorationFailed}>
              <div className="settings-empty conversation-loading-body">
                <p>
                  {restorationFailed
                    ? t("common.conversation.unavailable")
                    : t(
                        project?.state?.connected
                          ? "startup.readingConversation"
                          : "startup.connectingProject",
                      )}
                </p>
                {restorationFailed && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void retryRestoration()}
                  >
                    {t("recovery.retryView")}
                  </Button>
                )}
              </div>
              <div className="composer-dock" aria-hidden="true">
                <ComposerSurface
                  editor={<div className="conversation-loading-editor" />}
                  toolbar={<div className="composer-toolbar" />}
                />
              </div>
            </div>
          ) : (
            <DraftConversation />
          )}
        </section>
        {terminalOpen && thread && project && (
          <section className="bottom-terminal">
            <div className="panel-header">
              <strong>{t("terminal.title")}</strong>
              <Button
                unstyled
                className="icon-button"
                aria-label={t("common.navigation.closePanel")}
                onClick={() => setTerminalOpen(false)}
              >
                <DismissIcon size={16} />
              </Button>
            </div>
            <React.Suspense
              fallback={
                <p role="status" className="p-3 text-ui-base text-foreground-subtle">
                  {t("common.loading")}
                </p>
              }
            >
              <TerminalPane
                key={`${project.id}:${threadId}`}
                project={project}
                thread={thread}
                action={action}
                onClosed={workspacePanels.removeTerminalTab}
                canStart={!admitting && !pending && !!project.state?.connected}
                onError={setError}
                onLink={onLink}
              />
            </React.Suspense>
          </section>
        )}
      </div>
    </div>
  );
}
function ActiveConversation() {
  const {
    session,
    action,
    dark,
    empty,
    workspacePanels,
    mcpWorkspace,
    side,
    fork,
    preview,
    documents,
    panelNavigation,
    composerWorkspace,
    annotation,
    surfaces,
    tasks,
    startup,
    navigationCommands,
    conversationReferences,
    readTurnReview,
    setError,
  } = useConversationContext();
  const { project, thread, threadId, library, snapshot, resourceAction } = session;
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  const { workspaceView } = workspacePanels.view;
  const {
    sideChats,
    canStageSelection,
    canCreateSide,
    addSelectionToChat,
    openSideSelection,
    newSide,
    createSide,
  } = side;
  const { forkFromTurn } = fork;
  const { onLink, rememberPanelTrigger } = preview;
  const { openFile, requestReview: setReviewRequest } = documents;
  const { showPanel } = panelNavigation;
  const { mcpMentionsOpen, setMcpMentionsOpen, appEntries } = composerWorkspace;
  const { openImageAnnotation } = annotation;
  const { viewRefreshing } = startup;
  const { newTask } = navigationCommands;

  const { t } = useI18n();
  const pendingSide =
    project && thread ? sideChats.pendingCreation(project.id, thread.id) : undefined;
  if (!project || !thread) return null;
  return (
    <>
      {empty ? (
        <div className="draft-greeting">
          <ConversationDraftEmptyState
            projectName={
              project
                ? library.projects?.[project.id]?.title ||
                  (project.projectless
                    ? thread?.title || t("operations.schedules.newTitle")
                    : project.root.split("/").pop())
                : undefined
            }
          />
        </div>
      ) : (
        <Messages
          project={
            thread.cloud
              ? {
                  ...project,
                  cloud: true,
                  state: { ...project.state, connected: thread.cloud.connected },
                }
              : project
          }
          thread={thread}
          action={action}
          decisionShown
          onOpenResult={mcpWorkspace.openResult}
          resultStates={mcpWorkspace.resultStates}
          onFork={thread.cloud ? undefined : forkFromTurn}
          onAddSelection={!thread.cloud && canStageSelection ? addSelectionToChat : undefined}
          onSideSelection={
            !thread.cloud && canStageSelection && canCreateSide ? openSideSelection : undefined
          }
          dark={dark}
          onLink={onLink}
          onFile={thread.cloud ? () => setError(t("cloud.remoteFile")) : openFile}
          onReview={(turnId) => {
            rememberPanelTrigger();
            setReviewRequest({ owner: panelOwner, turnId });
            workspacePanels.selectPanel("改动");
            workspacePanels.exposePanel();
          }}
          readTurnReview={readTurnReview}
          onAgent={(id) => showPanel(`agent:${id}`)}
        />
      )}
      <div className={empty ? "draft-composer" : "active-composer"}>
        {empty && (
          <div className="composer-project-bar">
            <div className="composer-project-leading">
              <div className="composer-project">
                <ProjectFolderIcon />
                <span>
                  {library.projects?.[project.id]?.title ||
                    (project.projectless
                      ? thread?.title || t("operations.schedules.newTitle")
                      : project.root.split("/").pop())}
                </span>
              </div>
              <ComposerWorkspaceContext
                project={project}
                threadId={thread?.id}
                cloud={!!thread.cloud}
                action={resourceAction}
                backendReady={snapshot.connection?.state === "ready"}
              />
            </div>
          </div>
        )}
        {pendingSide && (
          <FeedbackNotice
            tone="warning"
            requestId={pendingSide.requestId}
            message={t("chat.side.createUnconfirmed")}
            actions={
              <Button variant="ghost" size="sm" onClick={newSide}>
                {t("chat.side.inspectCreation")}
              </Button>
            }
          />
        )}
        {!thread.cloud && mcpWorkspace.contexts}
        {!thread.cloud && mcpWorkspace.formsView}
        {!thread.cloud && mcpMentionsOpen && (
          <McpMentionsPicker
            servers={mcpWorkspace.servers}
            projectId={project.id}
            threadId={thread.id}
            action={resourceAction}
            onClose={() => setMcpMentionsOpen(false)}
          />
        )}
        {thread.cloud ? (
          <CloudComposer
            key={`${project.id}:${thread.id}`}
            project={project}
            thread={thread}
            action={resourceAction}
          />
        ) : (
          <Composer
            surfaceLayout={workspaceView === "panel" ? "compact" : "default"}
            onAnnotate={openImageAnnotation}
            key={`${project.id}:${thread.id}`}
            onMcpMention={() => setMcpMentionsOpen(true)}
            appEntries={appEntries}
            conversationReferences={conversationReferences}
            project={project}
            thread={thread}
            executionBlocked={
              snapshot.connection?.state !== "ready" ||
              viewRefreshing ||
              projectExecutionBlocked(snapshot.lifecycle, project.id)
            }
            action={action}
            readAction={resourceAction}
            onPanel={showPanel}
            onSide={
              canCreateSide
                ? async (text) => {
                    await createSide(text);
                  }
                : undefined
            }
            onNew={() => void newTask()}
            onOpenTask={(target) => {
              surfaces.leaveSettings();
              tasks.openTarget({ ...target, eventId: crypto.randomUUID() });
            }}
          />
        )}
      </div>
    </>
  );
}
function DraftConversation() {
  const {
    session,
    services,
    action,
    admitting,
    workspacePanels,
    panelNavigation,
    composerWorkspace,
    annotation,
    surfaces,
    navigationCommands,
    conversationReferences,
  } = useConversationContext();
  const { project, thread, projects, library, snapshot, resourceAction } = session;
  const { environment } = useCloudEnvironment(project ?? { id: "projectless" }, resourceAction);
  const { workspaceView } = workspacePanels.view;

  const { showPanel } = panelNavigation;
  const { appEntries, worktreeSelection, changeWorktreeSelection } = composerWorkspace;
  const { openImageAnnotation } = annotation;

  const { newTask, choose, leaveProject, open } = navigationCommands;
  const { setWorktreeSettingsTarget, setSettingsTab, setSettingsOpen } = surfaces;
  const { t } = useI18n();
  return (
    <>
      <div className="draft-greeting">
        <ConversationDraftEmptyState
          projectName={
            project
              ? library.projects?.[project.id]?.title ||
                (project.projectless
                  ? thread?.title || t("operations.schedules.newTitle")
                  : project.root.split("/").pop())
              : undefined
          }
        />
      </div>
      <div className="draft-composer">
        <div className="composer-project-bar">
          <div className="composer-project-leading">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    unstyled
                    className="composer-project"
                    aria-label={
                      project
                        ? t("common.conversation.newInProject", {
                            project:
                              library.projects?.[project.id]?.title ||
                              (project.projectless
                                ? thread?.title || t("operations.schedules.newTitle")
                                : project.root.split("/").pop()),
                          })
                        : t("common.conversation.projectless")
                    }
                  >
                    {project ? <ProjectFolderIcon /> : <LeaveProjectIcon />}
                    <span>
                      {project
                        ? library.projects?.[project.id]?.title ||
                          (project.projectless
                            ? thread?.title || t("operations.schedules.newTitle")
                            : project.root.split("/").pop())
                        : t("common.conversation.projectless")}
                    </span>
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="project-picker-menu">
                {projects
                  .filter((p) => !p.projectless)
                  .map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => newTask(p.id)}>
                      <ProjectFolderIcon />
                      {library.projects?.[p.id]?.title || p.root.split("/").pop()}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuItem onClick={() => void choose()}>
                  <NewProjectIcon />
                  {t("chat.newProject")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => leaveProject()}>
                  <LeaveProjectIcon />
                  {t("common.conversation.projectless")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {project && (
              <ComposerWorkspaceContext
                project={project}
                showBranch={false}
                selectable
                action={resourceAction}
                backendReady={snapshot.connection?.state === "ready"}
              />
            )}
          </div>
          {project && environment !== "cloud" && (
            <WorktreeStarter
              key={project.id}
              project={project}
              action={resourceAction}
              value={worktreeSelection}
              onChange={(value) => changeWorktreeSelection(project.id, value)}
              onConfigureEnvironments={() => {
                setWorktreeSettingsTarget({
                  projectId: project.id,
                  tab: "environments",
                });
                setSettingsTab("Worktrees");
                setSettingsOpen(true);
              }}
              disabled={
                admitting ||
                project.pending?.some((entry: Data) => !isIndependentCreation(entry, []))
              }
            />
          )}
        </div>
        {project ? (
          environment === "cloud" ? (
            <CloudComposer
              project={project}
              action={resourceAction}
              onOpen={(pid, id) => open(pid, id, "replace")}
            />
          ) : (
            <DraftComposer
              worktree={worktreeSelection}
              onWorktreeCreated={() => changeWorktreeSelection(project.id, undefined)}
              appEntries={appEntries}
              conversationReferences={conversationReferences}
              surfaceLayout={workspaceView === "panel" ? "compact" : "default"}
              onAnnotate={openImageAnnotation}
              key={project.id}
              project={project}
              backendReady={snapshot.connection?.state === "ready"}
              action={action}
              readAction={resourceAction}
              onOpen={(pid, id) => open(pid, id, "replace")}
              onPanel={showPanel}
            />
          )
        ) : (
          <ProjectlessDraft
            onAnnotate={openImageAnnotation}
            snapshot={snapshot}
            services={services}
            action={action}
            readAction={resourceAction}
            onPanel={showPanel}
            onOpen={(pid, id) => open(pid, id, "replace")}
          />
        )}
      </div>
    </>
  );
}
