import { useMemo, useState, type ReactNode } from "react";
import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import { ApplicationRail } from "../app-shell/ApplicationNavigation.js";
import { WorkbenchShell, WorkspaceHeader } from "../app-shell/WorkbenchShell.js";
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
  action,
  children,
}: {
  collapsed: string[];
  search?: string;
  rail?: boolean;
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
  const currentTitle = [...nav.projects.flatMap((project) => project.threads), ...nav.chats].find(
    (thread) => thread.id === current.threadId,
  )?.title;
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
          title: thread.title,
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
  }, [nav]);
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
      activeId="home"
      items={[
        {
          id: "home",
          label: t("common.navigation.home"),
          icon: <Home active />,
          onSelect: () => {},
        },
        {
          id: "tasks",
          label: t("operations.schedules.title"),
          icon: <ScheduledIcon />,
          onSelect: () => {},
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
        >
          <Settings />
        </Button>
      }
    />
  );
  return (
    <WorkbenchShell data-spec-fixture data-view="workspace" style={{ height: "100dvh" }}>
      <ConversationNavigation
        services={{}}
        setError={() => {}}
        snapshot={{ library } as never}
        projects={projects}
        summaries={summaries}
        projectId={current.projectId}
        threadId={current.threadId}
        taskCenterOpen={false}
        pluginsOpen={false}
        sidebar={sidebar}
        visible
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
        action={action}
        requestNavigation={((run: () => void) => run()) as never}
        choose={async () => {}}
        newTask={() => {}}
        open={async (projectId, threadId) => setCurrent({ projectId, threadId })}
        onOpenProjectTasks={() => {}}
        closePanels={() => {}}
      />
      <main className="work-area">
        <div className="work-surface">
          <WorkspaceHeader>
            {!sidebar && workspaceNavigation}
            <div className="header-context">
              <ProjectFolderIcon />
              <strong className="header-task">{currentTitle}</strong>
            </div>
            <div className="header-tools">
              <Button
                unstyled
                className="icon-button"
                aria-label={t("common.navigation.expandPanel")}
              >
                <SidePanelIcon />
              </Button>
            </div>
          </WorkspaceHeader>
          {children}
        </div>
      </main>
    </WorkbenchShell>
  );
}
