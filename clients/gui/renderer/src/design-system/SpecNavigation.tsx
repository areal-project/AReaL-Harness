import { useMemo, useState, type ReactNode } from "react";
import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import { ApplicationRail } from "../app-shell/ApplicationNavigation.js";
import { SidePane } from "../app-shell/SidePane.js";
import { GitPane } from "../GitPane.js";
import { TaskCenter } from "../TaskCenter.js";
import { WorkSurface, WorkbenchShell, WorkspaceHeader } from "../app-shell/WorkbenchShell.js";
import { ProjectFolderIcon, SidePanelIcon } from "../homeChromeIcons.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { Home, ScheduledIcon, Settings } from "../interfaceIcons.js";
import type { Action, Data } from "../services.js";
import { SettingsPluginIcon } from "../settings/settingsNavIcons.js";
import { conversationCatalog } from "../state/conversationCatalog.js";
import { createNavigationWorkspace } from "../state/navigationWorkspace.js";
import { ConversationNavigation } from "../views/ConversationNavigation.js";
import { WorkspaceNavigation } from "../views/WorkbenchChrome.js";
import { Button } from "../components/ui/button.js";
import { SpecSettingsPage } from "./SpecSettings.js";
import { SettingsNavigation } from "../settings/SettingsWorkspace.js";
import { settingsNavigationGroups } from "../settings/settingsNavigation.js";
import { UnsavedChangesProvider } from "../settings/UnsavedChanges.js";

// 侧栏示例：把 fixture.navigation 翻译成侧栏读取的项目、摘要与资料库形状。
type Navigation = typeof fixture.navigation;
type FixtureThread = Navigation["projects"][number]["threads"][number] & {
  running?: boolean;
  attention?: boolean;
  unread?: boolean;
};
const BASE = 1793692800;

function owner(id: string, name: string, threads: FixtureThread[], projectless = false): Data {
  return {
    id,
    root: `/${name}`,
    name,
    projectless,
    pending: [],
    summariesLoaded: true,
    summaries: threads.map((thread) => ({
      id: thread.id,
      name: thread.title,
      updatedAt: BASE + thread.updatedAt * 60,
    })),
    state: {
      connected: true,
      threads: Object.fromEntries(
        threads
          .filter((thread) => thread.running)
          .map((thread) => [thread.id, { id: thread.id, turns: [{ status: "inProgress" }] }]),
      ),
      interactions: Object.fromEntries(
        threads
          .filter((thread) => thread.attention)
          .map((thread) => [thread.id, { data: [{ status: "pending" }] }]),
      ),
      tasks: {},
    },
  };
}

export function SpecNavigation({
  collapsed,
  search,
  rail = false,
  settings,
  panel: initialPanel,
  surface: initialSurface,
  action,
  children,
}: {
  collapsed: string[];
  search?: string;
  rail?: boolean;
  settings?: string;
  panel?: { tabs: string[]; active: string; view?: "split" | "panel" | "conversation" };
  surface?: "tasks";
  action: Action;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const nav = fixture.navigation;
  const [navigation] = useState(() => {
    const workspace = createNavigationWorkspace();
    if (search !== undefined) {
      workspace.openSearch();
      workspace.search(search);
    }
    return workspace;
  });
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(collapsed.map((id) => [id, true])),
  );
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [sidebar, setSidebar] = useState(!rail);
  const [current, setCurrent] = useState(() => {
    const thread = nav.projects
      .flatMap((project) => project.threads.map((thread) => ({ project: project.id, thread })))
      .find(({ thread }) => "current" in thread && thread.current);
    return { projectId: thread?.project ?? "", threadId: thread?.thread.id ?? "" };
  });
  const [settingsTab, setSettingsTab] = useState(settings);
  const [surface, setSurface] = useState(initialSurface);
  const [panelTabs, setPanelTabs] = useState(initialPanel?.tabs ?? []);
  const [panel, setPanel] = useState(initialPanel?.active ?? "");
  const [workspaceView, setWorkspaceView] = useState<"split" | "panel" | "conversation">(
    initialPanel?.view ?? "split",
  );
  const [reviewFiles, setReviewFiles] = useState(false);
  const [lastPanel, setLastPanel] = useState(initialPanel?.active ?? "");
  const selectPanel = (name: string) => {
    setPanel(name);
    if (name) setLastPanel(name);
    if (name && name !== "功能")
      setPanelTabs((tabs) => (tabs.includes(name) ? tabs : [...tabs, name]));
  };
  const hidePanel = () => {
    setWorkspaceView("split");
    setPanel("");
  };
  const panelOpen = Boolean(panel) && !settingsTab;
  const [titles, setTitles] = useState<Record<string, string>>({});
  const currentTitle =
    titles[current.threadId] ??
    [...nav.projects.flatMap((project) => project.threads), ...nav.chats].find(
      (thread) => thread.id === current.threadId,
    )?.title;
  const navigationAction = (async (name: string, request: Data) => {
    if (name === "library" && request.operation === "renameThread") {
      setTitles((value) => ({ ...value, [request.threadId]: request.title }));
      return {};
    }
    return (action as (name: string, request: Data) => Promise<Data>)(name, request);
  }) as Action;
  const { projects, library } = useMemo(() => {
    const projects = [
      ...nav.projects.map((project) => owner(project.id, project.name, project.threads)),
      owner("spec-chats", "", nav.chats, true),
    ];
    const pinned = new Set(nav.pinned.map((entry) => `${entry.project}:${entry.thread}`));
    const threads = Object.fromEntries(
      [
        ...nav.projects.flatMap((project) =>
          project.threads.map((thread) => [project.id, thread as FixtureThread] as const),
        ),
        ...nav.chats.map((thread) => ["spec-chats", thread as FixtureThread] as const),
      ].map(([projectId, thread]) => [
        `${projectId}:${thread.id}`,
        {
          title: titles[thread.id] ?? thread.title,
          pinned: pinned.has(`${projectId}:${thread.id}`),
          unread: !!thread.unread,
        },
      ]),
    );
    const library = {
      settings: {},
      projects: Object.fromEntries(nav.projects.map((p) => [p.id, { title: p.name }])),
      threads,
    };
    return { projects, library };
  }, [nav, titles]);
  const summaries = conversationCatalog(projects, library);
  const workspaceNavigation = (
    <WorkspaceNavigation
      workspaceHistory={{ index: 0, entries: [{}] } as never}
      taskCenterOpen={false}
      sidebar={sidebar}
      setSidebar={setSidebar}
      traverseWorkspaceHistory={() => {}}
    />
  );
  const applicationRail = (
    <ApplicationRail
      activeId={settingsTab ? "settings" : (surface ?? "home")}
      items={[
        {
          id: "home",
          label: t("common.navigation.home"),
          icon: <Home active={!settingsTab && !surface} />,
          onSelect: () => {
            setSettingsTab(undefined);
            setSurface(undefined);
          },
        },
        {
          id: "tasks",
          label: t("operations.schedules.title"),
          icon: <ScheduledIcon />,
          onSelect: () => {
            setSettingsTab(undefined);
            setSurface("tasks");
          },
        },
        {
          id: "plugins",
          label: t("settings.plugins.title"),
          icon: <SettingsPluginIcon />,
          onSelect: () => {},
        },
      ]}
      footer={
        <Button
          variant="ghost"
          size="icon"
          className="application-rail-button relative"
          aria-label={t("settings.title")}
          title={t("settings.title")}
          aria-current={settingsTab ? "page" : undefined}
          onClick={() => setSettingsTab("常规")}
        >
          <Settings />
        </Button>
      }
    />
  );
  return (
    <UnsavedChangesProvider>
      <WorkbenchShell data-spec-fixture data-view="workspace" style={{ height: "100dvh" }}>
        {settingsTab && (
          <SettingsNavigation
            width={sidebarWidth}
            rail={applicationRail}
            activeId={settingsTab}
            onSelect={setSettingsTab}
            onBack={() => setSettingsTab(undefined)}
            groups={settingsNavigationGroups.map((group) => ({
              ...group,
              label: t(group.label),
              items: group.items.map((item) => ({
                ...item,
                keywords: "keywords" in item ? t(item.keywords) : undefined,
                label: t(item.label),
              })),
            }))}
          />
        )}
        <ConversationNavigation
          services={{}}
          setError={() => {}}
          snapshot={{ library } as never}
          projects={projects}
          summaries={summaries}
          projectId={current.projectId}
          threadId={current.threadId}
          taskCenterOpen={surface === "tasks"}
          pluginsOpen={false}
          sidebar={sidebar}
          visible={!settingsTab}
          appearance={{
            sidebarWidth,
            setSidebarWidth,
            collapsedProjects,
            setCollapsedProjects,
            toggleSidebarGroup: (id) =>
              setCollapsedProjects((value) => ({ ...value, [id]: !value[id] })),
          }}
          workspaceNavigation={workspaceNavigation}
          applicationRail={applicationRail}
          navigation={navigation}
          action={navigationAction}
          requestNavigation={((run: () => void) => run()) as never}
          choose={async () => {}}
          newTask={() => {}}
          open={async (projectId, threadId) => setCurrent({ projectId, threadId })}
          onOpenProjectTasks={() => {}}
          closePanels={() => {}}
        />
        <main
          className={`work-area ${settingsTab ? "settings-open" : ""}`}
          data-workspace-view={panelOpen && workspaceView !== "split" ? workspaceView : undefined}
        >
          <WorkSurface panelOpen={panelOpen} split={workspaceView === "split"} reducedMotion>
            {surface === "tasks" && !settingsTab ? (
              <TaskCenter
                projects={fixture.tasks.projects.map((project) => ({
                  ...project,
                  state: { connected: true, threads: {} },
                  core: { connectionGeneration: 1 },
                  pending: [],
                  outcomes: {},
                  desktopCapabilities: { currentCommands: true },
                }))}
                connected
                action={action}
                onOpenThread={() => {}}
                onOpenModelSettings={() => {}}
                renderConversation={() => null}
                renderResources={() => null}
              />
            ) : settingsTab ? (
              <>
                <WorkspaceHeader>{null}</WorkspaceHeader>
                <SpecSettingsPage tab={settingsTab} />
              </>
            ) : (
              <>
                <WorkspaceHeader>
                  {!sidebar && workspaceNavigation}
                  <div className="header-context">
                    <ProjectFolderIcon />
                    <strong className="header-task">{currentTitle}</strong>
                  </div>
                  <div className="header-tools">
                    <Button
                      unstyled
                      className={`icon-button ${panel ? "active" : ""}`}
                      aria-label={t("common.navigation.expandPanel")}
                      aria-pressed={Boolean(panel)}
                      onClick={() =>
                        panel
                          ? hidePanel()
                          : selectPanel(
                              lastPanel === "功能" || panelTabs.includes(lastPanel)
                                ? lastPanel
                                : (panelTabs.at(-1) ?? "功能"),
                            )
                      }
                    >
                      <SidePanelIcon />
                    </Button>
                  </div>
                </WorkspaceHeader>
                {children}
              </>
            )}
          </WorkSurface>
          {!settingsTab && (
            <SidePane
              workspaceKey="spec"
              ownerTaskId={current.threadId}
              active={panel}
              names={panelTabs}
              workspaceView={{
                mode: workspaceView,
                title: currentTitle ?? "",
                onChange: (mode) => setWorkspaceView(mode),
              }}
              dirtyFiles={{}}
              canClose={() => true}
              onSelect={selectPanel}
              onChange={setPanelTabs}
              onHide={hidePanel}
              render={(name) =>
                name === "改动" ? (
                  <GitPane
                    projectId="spec-project"
                    root={`/${fixture.project.name}`}
                    threadId="spec-thread"
                    turnId="turn-0"
                    action={action}
                    onReveal={() => {}}
                    onFile={() => {}}
                    filesOpen={reviewFiles}
                    onToggleFiles={() => setReviewFiles((open) => !open)}
                  />
                ) : null
              }
            />
          )}
        </main>
      </WorkbenchShell>
    </UnsavedChangesProvider>
  );
}
