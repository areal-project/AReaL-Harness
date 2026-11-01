import React from "react";
import { Route } from "lucide-react";
import { ApplicationRail } from "../app-shell/ApplicationNavigation.js";
import { WorkspaceHeader } from "../app-shell/WorkbenchShell.js";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { stageComposerDraft } from "../composerDraftStorage.js";
import { ProjectFolderIcon, SidePanelIcon, SidebarToggleIcon } from "../homeChromeIcons.js";
import { useI18n } from "../i18n/IntlProvider.js";
import {
  Home,
  MoreOptionsIcon,
  NavigationBackIcon,
  NavigationForwardIcon,
  ScheduledIcon,
  Settings,
} from "../interfaceIcons.js";
import { type PlatformServices } from "../services.js";
import { SettingsPluginIcon } from "../settings/settingsNavIcons.js";
import { useGuardedNavigation } from "../settings/UnsavedChanges.js";
import { useTaskWorkspace } from "../state/taskWorkspace.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";
import { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
import { useWorkspaceDocuments } from "../state/useWorkspaceDocuments.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
import { UpdateIndicator } from "../UpdateIndicator.js";
import { TaskResourcesPopover } from "../views/TaskResourcesPopover.js";
import { WorktreeActions } from "../WorktreeStatus.js";
type Session = ReturnType<typeof useSessionNavigation>;
type Surfaces = ReturnType<typeof useWorkbenchSurfaces>;
type Panels = ReturnType<typeof useWorkspacePanels>;
type Tasks = ReturnType<typeof useTaskWorkspace>["workspace"];
export function WorkbenchRail({
  session,
  surfaces,
  tasks,
  taskSurface,
  services,
  requestNavigation,
  setSidebar,
  showPanel,
}: {
  session: Session;
  surfaces: Surfaces;
  tasks: Tasks;
  taskSurface: ReturnType<typeof useTaskWorkspace>["surface"];
  services: PlatformServices;
  requestNavigation: ReturnType<typeof useGuardedNavigation>;
  setSidebar: (show: boolean) => void;
  showPanel: (name: string) => void;
}) {
  const { t } = useI18n();
  const { project, threadId, recordWorkspaceLocation } = session;
  const { settingsOpen, pluginsOpen, trajectoryAttention, rememberPluginTask } = surfaces;
  const taskCenterOpen = taskSurface !== null;
  return (
    <ApplicationRail
      activeId={settingsOpen ? "settings" : pluginsOpen ? "plugins" : (taskSurface ?? "home")}
      items={[
        {
          id: "home",
          label: t("common.navigation.home"),
          icon: <Home active={!pluginsOpen && !settingsOpen && !taskCenterOpen} />,
          onSelect: () =>
            requestNavigation(() => {
              if (taskCenterOpen)
                recordWorkspaceLocation({ projectId: project?.id ?? "", threadId });
              surfaces.leavePlugins();
              tasks.close();
              surfaces.leaveSettings();
            }),
        },
        // 暂时隐藏 Inbox 入口（恢复时同时把 InboxIcon 加回 import）
        // { id: "inbox", label: "Inbox", icon: <InboxIcon />, onSelect: () => requestNavigation(() => { surfaces.leaveSettings(); setTaskSurface("inbox"); if (matchMedia("(max-width: 640px)").matches) setSidebar(false); }) },
        {
          id: "tasks",
          label: t("operations.schedules.title"),
          icon: <ScheduledIcon />,
          onSelect: () =>
            requestNavigation(() => {
              surfaces.leavePlugins();
              surfaces.leaveSettings();
              tasks.openCatalog();
              if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
            }),
        },
        {
          id: "plugins",
          label: t("settings.plugins.title"),
          icon: <SettingsPluginIcon />,
          onSelect: () =>
            requestNavigation(() => {
              rememberPluginTask();
              surfaces.leaveSettings();
              tasks.close();
              surfaces.openMarketplace();
            }),
        },
      ]}
      footer={
        <>
          <UpdateIndicator services={services} />
          <Button
            variant="ghost"
            size="icon"
            className="application-rail-button relative"
            aria-label={t("settings.title")}
            title={t(trajectoryAttention ? "settings.attention" : "settings.title")}
            aria-current={settingsOpen ? "page" : undefined}
            onClick={() => showPanel("设置")}
          >
            <Settings />
            {trajectoryAttention && (
              <span
                aria-label={t("settings.trajectory.attention")}
                className="absolute top-1 right-1 size-2 rounded-full bg-[var(--color-settings-attention-indicator)]"
              />
            )}
          </Button>
        </>
      }
    />
  );
}
export function WorkspaceNavigation({
  workspaceHistory,
  taskCenterOpen,
  sidebar,
  setSidebar,
  traverseWorkspaceHistory,
}: {
  workspaceHistory: Session["workspaceHistory"];
  taskCenterOpen: boolean;
  sidebar: boolean;
  setSidebar: (show: boolean) => void;
  traverseWorkspaceHistory: (delta: -1 | 1) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="workspace-navigation">
      <Button
        unstyled
        className="icon-button"
        aria-label={t("common.navigation.back")}
        title={t("common.navigation.backShortcut")}
        disabled={taskCenterOpen || workspaceHistory.index <= 0}
        onClick={() => traverseWorkspaceHistory(-1)}
      >
        <NavigationBackIcon size={16} />
      </Button>
      <Button
        unstyled
        className="icon-button"
        aria-label={t("common.navigation.forward")}
        title={t("common.navigation.forwardShortcut")}
        disabled={taskCenterOpen || workspaceHistory.index >= workspaceHistory.entries.length - 1}
        onClick={() => traverseWorkspaceHistory(1)}
      >
        <NavigationForwardIcon size={16} />
      </Button>
      <Button
        unstyled
        className="icon-button"
        aria-label={
          sidebar ? t("common.navigation.collapseSidebar") : t("common.navigation.expandSidebar")
        }
        aria-expanded={sidebar}
        aria-controls="areal-sidebar"
        onClick={() => setSidebar(!sidebar)}
      >
        <SidebarToggleIcon />
      </Button>
    </div>
  );
}
export function WorkspaceTaskActions({
  session,
  workspacePanels,
}: {
  session: Session;
  workspacePanels: Panels;
}) {
  const { t } = useI18n();
  const { project, thread } = session;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            unstyled
            aria-label={t("common.navigation.taskActions")}
            className="icon-button"
            disabled={!project}
          >
            <MoreOptionsIcon size={16} />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {thread && project && (
          <DropdownMenuItem
            onClick={() => {
              workspacePanels.selectPanel("调用轨迹");
              workspacePanels.exposePanel();
            }}
          >
            <Route size={16} aria-hidden="true" />
            {t("common.navigation.viewTrajectory")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function ConversationHeader({
  session,
  surfaces,
  workspacePanels,
  documents,
  tasks,
  sidebar,
  empty,
  currentTitle,
  mainPane,
  contextReturn,
  onLink,
  showPanel,
  hidePanel,
  rememberPanelTrigger,
  workspaceNavigation,
  taskActions,
}: {
  session: Session;
  surfaces: Surfaces;
  workspacePanels: Panels;
  documents: ReturnType<typeof useWorkspaceDocuments>;
  tasks: Tasks;
  sidebar: boolean;
  empty: boolean;
  currentTitle: string;
  mainPane: React.RefObject<HTMLElement | null>;
  contextReturn: React.RefObject<(() => void) | null>;
  onLink: (url: string) => void;
  showPanel: (name: string) => void;
  hidePanel: () => void;
  rememberPanelTrigger: () => void;
  workspaceNavigation: React.ReactNode;
  taskActions: React.ReactNode;
}) {
  const { t } = useI18n();
  const { project, thread, threadId, resourceAction } = session;
  const { pluginsOpen, settingsOpen } = surfaces;
  const taskCenterOpen = false;
  const { panel } = workspacePanels.view;
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  const { requestReview: setReviewRequest, openFile } = documents;
  return (
    <WorkspaceHeader>
      {!sidebar && !settingsOpen && workspaceNavigation}
      {!pluginsOpen && !settingsOpen && !taskCenterOpen && (!empty || (!thread && !!threadId)) && (
        <div className="header-context">
          <ProjectFolderIcon />
          <strong className="header-task">{currentTitle}</strong>
        </div>
      )}
      <div className="header-tools">
        {!pluginsOpen && !settingsOpen && !taskCenterOpen && (
          <>
            {thread && project && !empty && (
              <TaskResourcesPopover
                fileOpen={session.contextualFileOpen}
                key={panelOwner}
                onLink={onLink}
                onAddSource={() =>
                  mainPane.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click()
                }
                onReadAgents={(restore) => {
                  contextReturn.current = restore;
                  showPanel("子代理");
                }}
                project={project}
                thread={thread}
                action={resourceAction}
                onAddSchedule={() => {
                  stageComposerDraft(
                    {
                      kind: "thread",
                      projectId: project.id,
                      threadId: thread.id,
                    },
                    t("operations.schedules.creationIntent"),
                    true,
                  );
                }}
                onOpenSchedule={(task) => {
                  tasks.revealResource({
                    projectId: project.id,
                    taskId: task.id,
                  });
                }}
                onPanel={(name) => {
                  if (name === "改动") setReviewRequest({ owner: panelOwner, scope: "unstaged" });
                  showPanel(name);
                }}
                onAgent={(id) => showPanel(`agent:${id}`)}
                onFile={openFile}
              />
            )}
            <Button
              unstyled
              className={`icon-button ${panel ? "active" : ""}`}
              aria-label={t("common.navigation.expandPanel")}
              aria-pressed={Boolean(panel)}
              disabled={!project}
              onClick={() => {
                if (panel) {
                  hidePanel();
                  return;
                }
                rememberPanelTrigger();
                workspacePanels.restoreLastPanel(panelOwner);
              }}
            >
              <SidePanelIcon />
            </Button>
            {thread?.worktree && project && (
              <WorktreeActions
                key={`${project.id}:${thread.id}`}
                projectId={project.id}
                threadId={thread.id}
                worktree={thread.worktree}
                action={resourceAction}
              />
            )}
            {taskActions}
          </>
        )}
      </div>
    </WorkspaceHeader>
  );
}
