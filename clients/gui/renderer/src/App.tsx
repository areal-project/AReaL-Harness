import { WorkspaceFileTree } from "./workspace-file-tree/WorkspaceFileTree.js";
import { WorkspaceFilePane, confirmCloseFiles } from "./WorkspaceFilePane.js";
import { GitPane } from "./GitPane.js";
import { PluginsSettings } from "./settings/PluginsSettings.js";
import { UsageDashboard } from "./settings/UsageDashboard.js";
import { Home, Settings, TerminalSquare, Browser, FileTree, ScheduledIcon as CalendarClock, NavigationBackIcon as ArrowLeft, NavigationForwardIcon as ArrowRight, SearchIcon as Search, MoreOptionsIcon as MoreHorizontal } from "./interfaceIcons.js";
import { ReviewPanelIcon } from "./app-shell/panelIcons.js";
import { ModelTrajectoryPane } from "./ModelTrajectoryPane.js";
import { useAppearance, useApplicationPreferences } from "./settings/applicationPreferences.js";
import { ConversationStatusCard } from "./ConversationStatusCard.js";
import { SidePane } from "./app-shell/SidePane.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { ApplicationRail, SidebarSectionToggle, SidebarWorkspaceHeader } from "./app-shell/ApplicationNavigation.js";
import { NavigationSidebar, WorkbenchShell, WorkspaceHeader, WorkSurface } from "./app-shell/WorkbenchShell.js";
import { SettingsNavigation, SettingsPage, type SettingsNavigationGroup } from "./settings/SettingsWorkspace.js";
import {
  SettingsAppearanceIcon,
  SettingsBrowserIcon,
  SettingsConfigurationIcon,
  SettingsGeneralIcon,
  SettingsHooksIcon,
  SettingsPluginIcon,
  SettingsUsageIcon,
} from "./settings/settingsNavIcons.js";
import { Cpu, Server, Smartphone, Inbox as InboxIcon } from "lucide-react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DismissIcon as X } from "./interfaceIcons.js";
import { BottomPanelIcon, LeaveProjectIcon, NewProjectIcon, ProjectFolderIcon, ProjectNewChatIcon, ProjectOpenFolderIcon, SidePanelIcon, SidebarToggleIcon, TaskSummaryIcon } from "./homeChromeIcons.js";
import { UpdateIndicator } from "./UpdateIndicator.js";
import { call, type PlatformServices, type Snapshot, type Data, type Action } from "./services.js";
import { MemoTaskItem } from "./TaskListItem.js";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SidebarDragSurface, useSidebarDrag, type SidebarDragSource } from "./sidebarDrag.js";
import { Messages } from "./Messages.js";
import { ConversationDraftEmptyState } from "./ConversationDraftEmptyState.js";
import { NewTaskButtonGroup } from "./NewTaskButtonGroup.js";
import { Composer, sending, subscribeSending } from "./Composer.js";
import { DraftComposer } from "./DraftComposer.js";
import { ProjectlessDraft } from "./ProjectlessDraft.js";
import { WorktreeStarter } from "./WorktreeStarter.js";
import { ComposerWorkspaceContext } from "./ComposerWorkspaceContext.js";
import { Queue } from "./Queue.js";
import { Preview } from "./Preview.js";
import { TerminalPane } from "./terminal/TerminalPane.js";
import { addTerminal, closeTerminal, ensureTerminal, isTerminalTab, selectTerminal, terminalOwner, terminalTitle, useTerminalWorkspace } from "./terminal/terminalWorkspace.js";
import { GoalEditor } from "./Goal.js";
import { PlanPane } from "./PlanPane.js";
import { ContextPane } from "./ContextPane.js";
import { SavedPermissionsPane } from "./SavedPermissionsPane.js";
import { Inbox } from "./Inbox.js";
import { TaskCenter } from "./TaskCenter.js";
import { ProcessesPane } from "./ProcessesPane.js";
import { createCorePanels } from "./CorePanels.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./components/ui/dropdown-menu.js";
import { UnsavedChangesProvider, useGuardedNavigation } from "./settings/UnsavedChanges.js";
import { ModelSettings } from "./settings/ModelSettings.js";
import {
  McpSettings,
  SessionSettings,
  TaskSkillsSettings,
} from "./settings/ResourceSettings.js";
import {
  AppearanceSettings,
  GeneralSettings,
} from "./settings/DisplaySettings.js";
import { BrowserSettings } from "./settings/BrowserSettings.js";
import { HooksSettings } from "./settings/HooksSettings.js";
import { AgentConversationPane } from "./AgentConversationPane.js";
import { agentName } from "./AgentIdentity.js";
import { AgentsPane } from "./AgentsPane.js";
import { WorkgroupsPane } from "./WorkgroupsPane.js";
import { ServiceStatusSettings } from "./settings/ServiceStatusSettings.js";
import { CoreCapabilitiesSettings } from "./settings/CoreCapabilitiesSettings.js";
import { MobileSettings } from "./settings/MobileSettings.js";
const settingsLabel = (name: string) =>
  ({
    模型服务: "模型设置",
    MCP: "MCP 服务器",
    Skills: "技能",
    用量: "使用情况",
  })[name] ?? name;
const settingsNavigationGroups: SettingsNavigationGroup[] = [
  { id: "personal", label: "个人", items: [
    { id: "常规", label: "常规", icon: <SettingsGeneralIcon /> },
    { id: "外观", label: "外观", icon: <SettingsAppearanceIcon /> },
    { id: "用量", label: "使用情况", icon: <SettingsUsageIcon /> },
  ] },
  { id: "integrations", label: "集成", items: [
    { id: "插件", label: "插件", icon: <SettingsPluginIcon /> },
    { id: "浏览器", label: "浏览器", icon: <SettingsBrowserIcon /> },
  ] },
  { id: "coding", label: "编码", items: [
    { id: "钩子", label: "钩子", icon: <SettingsHooksIcon /> },
    { id: "模型服务", label: "模型设置", icon: <Cpu strokeWidth={1.5} /> },
    { id: "会话配置", label: "会话配置", icon: <SettingsConfigurationIcon /> },
    { id: "后台服务", label: "后台服务", icon: <Server strokeWidth={1.5} /> },
    { id: "手机连接", label: "手机连接", icon: <Smartphone strokeWidth={1.5} /> },
  ] },
];
const panels = createCorePanels(React);
// Launcher, tabs and this menu share sampled native panel artwork. Host-only
// entries keep their labels until their reference role is actually observed.
const panelList = [
  ["文件", <FileTree />],
  ["改动", <ReviewPanelIcon />],
  ["终端", <TerminalSquare size={16} />],
  ["进程", null],
  ["预览", <Browser size={16} />],
  ["子任务", null],
  ["工作组", null],
  ["队列", null],
  ["执行计划", null],
  ["上下文", null],
  ["已保存授权", null],
  ["Skills", null],
  ["MCP", null],
  ["用量", <SettingsUsageIcon />],
  ["设置", <Settings size={16} />],
] as const;
function Usage({ thread }: { thread: Data }) {
  const turns = thread.turns ?? [];
  const known = turns.filter((t: Data) => t.usage);
  const sum = (key: string) => known.every((t: Data) => typeof t.usage[key] === "number")
    ? known.reduce((n: number, t: Data) => n + t.usage[key], 0) : null;
  return (
    <div className="utility-content">
      <h2>实际用量</h2>
      <p className="text-foreground-subtle">
        Core 已确认的当前任务用量；未报告轮次的消费未知，以下数字不代表最终总消费。
      </p>
      <div className="usage-grid">
        {[
          ["输入 Token", sum("inputTokens")],
          ["缓存输入", sum("cachedInputTokens")],
          ["输出 Token", sum("outputTokens")],
        ].map(([label, value]) => (
          <article key={label}>
            <small>{label}</small>
            <strong>{!known.length ? "—" : value == null ? "未知" : Number(value).toLocaleString()}</strong>
          </article>
        ))}
      </div>
      <p>
        {known.length} / {turns.length} 轮有用量记录
      </p>
      {known.length < turns.length && <p role="status">还有 {turns.length - known.length} 轮消费未知；未计入已确认用量。</p>}
      {turns.map((t: Data, i: number) => (
        <div className="utility-actions" key={t.id}>
          <span>
            第 {i + 1} 轮 · {t.status}
          </span>
          <span>
            {t.usage ? `${t.usage.inputTokens ?? "未知"} 输入 / ${t.usage.outputTokens ?? "未知"} 输出` : "用量未知"}
          </span>
        </div>
      ))}
    </div>
  );
}

// 浮层只负责资源导航；子任务对话仍由已有侧栏标签持有。
function TaskResourcesPopover({ project, thread, action, selectedAgent, onPanel, onAgent, onFile }: {
  project: Data; thread: Data; action: Action; selectedAgent?: string;
  onPanel: (name: string) => void; onAgent: (id: string) => void; onFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = <T,>(callback: (value: T) => void) => (value: T) => { setOpen(false); callback(value); };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button className={`icon-button ${open ? "active" : ""}`} aria-label="任务资源" />}><TaskSummaryIcon /></PopoverTrigger>
    <PopoverContent align="end" sideOffset={8} className="task-resources-popup" aria-label="任务资源面板">
      <ConversationStatusCard project={project} thread={thread} action={action} selectedAgent={selectedAgent}
        onPanel={navigate(onPanel)} onAgent={navigate(onAgent)} onFile={navigate(onFile)} />
    </PopoverContent>
  </Popover>;
}
export function App({ services }: { services: PlatformServices }) {
  return <UnsavedChangesProvider><AppContent services={services} /></UnsavedChangesProvider>;
}
function AppContent({ services }: { services: PlatformServices }) {
  const requestNavigation = useGuardedNavigation();
  const { terminalLocation, showBottomPanelControl } = useApplicationPreferences();
  const [snapshot, updateSnapshot] = useState<Snapshot>({ projects: [], connection: { state: "connecting" } });
  const [themeReady, setThemeReady] = useState(false);
  const [restoration, setRestoration] = useState<{ projectId: string; pending: boolean; failed: boolean }>();
  // 初始 IPC 读回可能晚于订阅事件；只接受本 GUI 连接中更新的投影。
  const setSnapshot = useCallback((next: Snapshot) => updateSnapshot(previous =>
    next.revision !== undefined && previous.revision !== undefined && next.revision < previous.revision ? previous : next
  ), []);
  const [projectId, setProjectId] = useState(() => localStorage.getItem("areal-gui:project") ?? "");
  // 缺省键仍落到第一个项目；显式空字符串表示用户选了「不在项目中工作」。
  const [noProject, setNoProject] = useState(() => localStorage.getItem("areal-gui:project") === "");
  const [threadId, setThreadId] = useState("");
  // Window-local locations, never Core execution or a persisted recovery log.
  const [workspaceHistory, setWorkspaceHistory] = useState<{ entries: { projectId: string; threadId: string }[]; index: number }>({ entries: [], index: -1 });
  const [panel, setPanel] = useState("");
  const [reviewRequest, setReviewRequest] = useState<{ owner: string; threadId?: string } & ({ turnId: string; scope?: never } | { scope: "unstaged"; turnId?: never })>();
  const [panelTabs, setPanelTabs] = useState<string[]>([]);
  const [previewFileTab, setPreviewFileTab] = useState<string | undefined>();
  const [workspaceView, setWorkspaceView] = useState<"split" | "panel" | "conversation">("split");
  const [filesOpen, setFilesOpen] = useState(false);
  const [revealedFile, setRevealedFile] = useState("");
  const panelViews = React.useRef(new Map<string, { panel: string; lastPanel?: string; tabs: string[]; previewFileTab?: string; filesOpen: boolean; revealedFile: string }>());
  const activePanelOwner = React.useRef("");
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (panel && panel !== "功能")
      setPanelTabs((tabs) => (tabs.includes(panel) ? tabs : [...tabs, panel]));
  }, [panel]);
  const [settingsTab, updateSettingsTab] = useState("常规");
  const setSettingsTab = (next: string) => { if (next !== settingsTab) requestNavigation(() => updateSettingsTab(next)); };
  const [taskSurface, setTaskSurface] = useState<"tasks" | "inbox" | null>(null);
  const taskCenterOpen = taskSurface !== null;
  const setTaskCenterOpen = (open: boolean) => setTaskSurface(open ? "tasks" : null);
  const [taskScope, setTaskScope] = useState<string>();
  const [taskNotification, setTaskNotification] = useState<{ projectId: string; taskId: string; runId?: string; questionId?: string } | undefined>();
  const [settingsOpen, updateSettingsOpen] = useState(false);
  const setSettingsOpen = (open: boolean) => { if (open) { setTaskCenterOpen(false); updateSettingsOpen(true); } else requestNavigation(() => updateSettingsOpen(false)); };
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [uiFontSize, setUiFontSize] = useState(
    () => Number(localStorage.getItem("areal-gui:font-size")) || 14,
  );
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`);
    localStorage.setItem("areal-gui:font-size", String(uiFontSize));
  }, [uiFontSize]);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(false);
  useAppearance(dark);
  const [theme, setTheme] = useState(() => localStorage.getItem("areal-gui:theme") ?? "system");
  const [sidebar, setSidebar] = useState(() => !matchMedia("(max-width: 640px)").matches);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("areal-gui:sidebar-width"));
    return Number.isFinite(saved) && saved >= 240 && saved <= 520 ? saved : 320;
  });
  useEffect(() => { localStorage.setItem("areal-gui:sidebar-width", String(sidebarWidth)); }, [sidebarWidth]);
  const previousSidebar = React.useRef(sidebar);
  const previousSettingsOpen = React.useRef(settingsOpen);
  useEffect(() => {
    if (previousSettingsOpen.current === settingsOpen) return;
    previousSettingsOpen.current = settingsOpen;
    const frame = requestAnimationFrame(() => {
      const selector = settingsOpen
        ? '[aria-label="设置导航"] [aria-current="page"]'
        : '[aria-label="设置"], [aria-label="展开侧栏"]';
      document.querySelector<HTMLButtonElement>(selector)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsOpen]);
  useEffect(() => {
    if (previousSidebar.current === sidebar) return;
    previousSidebar.current = sidebar;
    document.querySelector<HTMLButtonElement>(`[aria-label="${sidebar ? "收起侧栏" : "展开侧栏"}"]`)?.focus();
  }, [sidebar]);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("areal-gui:collapsed-sidebar") ?? "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>
        : {};
    } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem("areal-gui:collapsed-sidebar", JSON.stringify(collapsedProjects)); }, [collapsedProjects]);
  const toggleSidebarGroup = (id: string) => setCollapsedProjects(current => ({ ...current, [id]: !current[id] }));
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({});
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewSource, setPreviewSource] = useState("");
  const [previewRequest, setPreviewRequest] = useState(0);
  const [rename, setRename] = useState<Data | null>(null);
  const [renameText, setRenameText] = useState("");
  useEffect(() => {
    const unsubscribe = services.onState(setSnapshot);
    void services
      .snapshot()
      .then(setSnapshot)
      .catch((e) => {
        setError(e.message);
        updateSnapshot(previous => previous.connection?.state === "ready" ? previous
          : { ...previous, connection: { state: "unavailable", message: e.message } });
      });
    const off = services.onTheme((t) => {
      setDark(t.dark);
      document.documentElement.classList.toggle("platform-mac-desktop", t.platform === "darwin");
      document.documentElement.classList.toggle("dark", t.dark);
      document.documentElement.classList.toggle("theme-areal-light", !t.dark);
      document.documentElement.classList.toggle("theme-areal-dark", t.dark);
      document.documentElement.style.colorScheme = t.dark ? "dark" : "light";
    });
    return () => {
      unsubscribe();
      off();
    };
  }, [services]);
  useEffect(() => {
    localStorage.setItem("areal-gui:theme", theme);
    void services
      .theme(theme)
      .then((t) => {
        setDark(t.dark);
        document.documentElement.classList.toggle("platform-mac-desktop", t.platform === "darwin");
        document.documentElement.classList.toggle("dark", t.dark);
        document.documentElement.classList.toggle("theme-areal-light", !t.dark);
        document.documentElement.classList.toggle("theme-areal-dark", t.dark);
        document.documentElement.style.colorScheme = t.dark ? "dark" : "light";
      })
      .catch((e) => setError(e.message))
      .finally(() => setThemeReady(true));
  }, [theme, services]);
  useEffect(() => {
    const onToast = (event: Event) => setError((event as CustomEvent).detail);
    document.addEventListener("areal:toast", onToast);
    return () => document.removeEventListener("areal:toast", onToast);
  }, []);
  const library = snapshot.library ?? {
    projects: {},
    threads: {},
    projectOrder: [],
    settings: {},
  };
  const projects = snapshot.projects
    .filter((p) => !library.projects?.[p.id]?.hidden)
    .sort((a, b) => {
      const order = library.projectOrder ?? [];
      const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
      return rank(a.id) - rank(b.id);
    });
  // Sidebar visibility must not change the owner of an explicitly opened resource.
  const project = noProject ? undefined : snapshot.projects.find((p) => p.id === projectId) ?? projects.find(p => !p.projectless);
  const thread = project?.state?.threads[threadId];
  const recordWorkspaceLocation = useCallback((next: { projectId: string; threadId: string }, replace = false) => {
    setWorkspaceHistory(history => {
      const current = history.entries[history.index] ?? (project ? { projectId: project.id, threadId } : noProject ? { projectId: "", threadId: "" } : next);
      const same = current.projectId === next.projectId && current.threadId === next.threadId;
      if (same && history.entries.length) return history;
      const entries = history.entries.length ? history.entries.slice(0, history.index + 1) : [current];
      if (replace || same) entries[entries.length - 1] = next;
      else entries.push(next);
      return { entries, index: entries.length - 1 };
    });
  }, [project?.id, threadId, noProject]);
  const previewOwner = React.useRef("");
  previewOwner.current = `${project?.id ?? ""}:${threadId}`;
  const terminalState = useTerminalWorkspace(terminalOwner(project?.id ?? "", threadId));
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  React.useLayoutEffect(() => {
    if (activePanelOwner.current !== panelOwner) {
      activePanelOwner.current = panelOwner;
      setWorkspaceView("split");
      const remembered = panelViews.current.get(panelOwner);
      // Only the terminal owner can supply live IDs; the view cache owns no PTY.
      setPanelTabs([...(remembered?.tabs.filter(id => id !== "任务资源" && !isTerminalTab(id)) ?? []), ...terminalState.ids]);
      setPanel(remembered && remembered.panel !== "任务资源" && (!isTerminalTab(remembered.panel) || terminalState.ids.includes(remembered.panel)) ? remembered.panel : "");
      setFilesOpen(remembered?.filesOpen ?? false);
      setRevealedFile(remembered?.revealedFile ?? "");
      setPreviewFileTab(remembered?.previewFileTab);
      setPreviewUrl("");
      return;
    }
    panelViews.current.set(panelOwner, { panel, lastPanel: panel || panelViews.current.get(panelOwner)?.lastPanel, tabs: panelTabs, previewFileTab, filesOpen, revealedFile });
  }, [panelOwner, panel, panelTabs, previewFileTab, filesOpen, revealedFile, terminalState.ids]);
  useEffect(() => {
    setPanelTabs(tabs => [...tabs.filter(id => !isTerminalTab(id) || terminalState.ids.includes(id)), ...terminalState.ids.filter(id => !tabs.includes(id))]);
  }, [terminalState.ids]);
  const action: Action = useCallback(
    async (name, params = {}) => {
      // 新投递清除上一操作的界面提示；本次失败仍由下方 catch 显示。
      if (name === "send" || name === "steer") setError("");
      try {
        return await call(services, name, params);
      } catch (e) {
        const err = e as Error;
        // Attachment upload, read and release stay on the owning composer,
        // message or upload dialog. A global banner would follow a task switch.
        if (!["providers", "chatgpt"].includes(name) && !(name === "respond" && params.answers)
          && name !== "media"
          && !(name === "manage" && params.operation === "goalCreate")) setError(err.message);
        throw e;
      }
    },
    [services],
  );
  // Resource pages own their loading, validation and recovery feedback.
  const resourceAction: Action = useCallback(
    (name, params = {}) => call(services, name, params),
    [services],
  );
  const readTurnReview = useCallback((turnId: string, itemId?: string) => resourceAction("workspace", {
    projectId: project?.id, threadId, turnId, itemId, operation: "turnReview",
  }), [resourceAction, project?.id, threadId]);
  const selectedCompletion = library.threads?.[`${project?.id}:${threadId}`]?.completionId;
  useEffect(() => {
    // A new completion visible in the foreground is read. A manual unread mark
    // does not change completionId, so it survives until the user opens it again.
    if (!project?.id || !project.state?.connected || !threadId || thread?.id !== threadId || !selectedCompletion || settingsOpen || taskCenterOpen || !document.hasFocus() || document.visibilityState !== "visible") return;
    void action("library", { operation: "readThread", projectId: project.id, threadId, read: true, completionId: selectedCompletion }).catch(() => {});
  }, [project?.id, project?.state?.connected, threadId, thread?.id, selectedCompletion, settingsOpen, taskCenterOpen, action]);
  const reconnectService = async () => {
    await resourceAction("connectService");
    if (project) {
      await resourceAction("connect", { projectId: project.id });
      if (threadId) await resourceAction("open", { projectId: project.id, threadId });
    }
  };
  const choose = async () => {
    setPanel("");
    try {
      const id = await services.chooseProject();
      if (id) {
        recordWorkspaceLocation({ projectId: id, threadId: id === project?.id ? "" : localStorage.getItem(`areal-gui:thread:${id}`) ?? "" });
        setNoProject(false);
        setProjectId(id);
        setThreadId("");
        if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
        setSnapshot(await services.snapshot());
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = useCallback(
    async (pid: string, id: string, navigation: "push" | "replace" | "restore" = "push") => {
      if (navigation !== "restore") recordWorkspaceLocation({ projectId: pid, threadId: id }, navigation === "replace");
      setTaskCenterOpen(false);
      setNoProject(false);
      setProjectId(pid);
      setThreadId(id);
      if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
      localStorage.setItem(`areal-gui:thread:${pid}`, id);
      try {
        await action("open", { projectId: pid, threadId: id });
        await action("library", { operation: "readThread", projectId: pid, threadId: id, read: true });
      } catch {}
    },
    [action, recordWorkspaceLocation],
  );
  useEffect(() => services.onNotificationOpen?.(target => requestNavigation(() => {
    updateSettingsOpen(false);
    setSearchOpen(false);
    if (target.taskId !== undefined) {
      setTaskScope(undefined);
      setTaskNotification({ projectId: target.projectId, taskId: target.taskId, runId: target.runId, questionId: target.questionId });
      setTaskCenterOpen(true);
    } else void open(target.projectId, target.threadId);
  })), [services, open, requestNavigation, projectId]);
  useEffect(() => {
    if (!project?.id || snapshot.connection?.state !== "ready") return;
    let active = true;
    setRestoration({ projectId: project.id, pending: true, failed: false });
    setProjectId(project.id);
    localStorage.setItem("areal-gui:project", project.id);
    const remembered = localStorage.getItem(`areal-gui:thread:${project.id}`);
    setThreadId(remembered ?? "");
    void action("connect", { projectId: project.id })
      .then(() => {
        if (active && remembered && localStorage.getItem(`areal-gui:thread:${project.id}`) === remembered)
          return action("open", {
            projectId: project.id,
            threadId: remembered,
          });
      })
      .then(() => { if (active) setRestoration({ projectId: project.id, pending: false, failed: false }); })
      .catch(() => { if (active) setRestoration({ projectId: project.id, pending: false, failed: true }); });
    return () => { active = false; };
  }, [project?.id, snapshot.connection?.state, action]);
  const startupReady = themeReady && snapshot.connection?.state !== "connecting" && (
    snapshot.connection?.state === "unavailable" || !project || (
      restoration && restoration.projectId === project.id && !restoration.pending && (!threadId || !!thread || restoration.failed)
    )
  );
  const presented = React.useRef(false);
  useEffect(() => {
    if (!startupReady || presented.current || !services.presentReady) return;
    let active = true, frame = 0;
    // Wait for layout/fonts and a painted frame, not just receipt of a snapshot.
    void document.fonts.ready.then(() => {
      if (!active) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!active) return;
          presented.current = true;
          void services.presentReady!().catch(() => {});
        });
      });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [startupReady, services]);
  const retryRestoration = async () => {
    if (!project) return;
    const pid = project.id;
    setError("");
    setRestoration({ projectId: pid, pending: true, failed: false });
    let failed = false;
    try { await reconnectService(); }
    catch (cause) { failed = true; setError((cause as Error).message); }
    finally { setRestoration(current => current?.projectId === pid ? { projectId: pid, pending: false, failed } : current); }
  };
  const newTask = (pid = project?.id, record = true) => {
    if (!pid || snapshot.projects.find(p => p.id === pid)?.projectless) { leaveProject(record); return; }
    requestNavigation(() => {
      if (record) recordWorkspaceLocation({ projectId: pid, threadId: "" });
      setTaskCenterOpen(false);
      localStorage.removeItem(`areal-gui:thread:${pid}`);
      setNoProject(false);
      setProjectId(pid);
      setThreadId("");
      setPanel("");
      updateSettingsOpen(false);
      if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
    });
  };
  const leaveProject = (record = true) => {
    requestNavigation(() => {
      if (record) recordWorkspaceLocation({ projectId: "", threadId: "" });
      setTaskCenterOpen(false); updateSettingsOpen(false);
      setNoProject(true);
      setProjectId("");
      setThreadId("");
      setPanel("");
      localStorage.setItem("areal-gui:project", "");
    });
  };
  const traverseWorkspaceHistory = (delta: -1 | 1) => {
    if (settingsOpen || taskCenterOpen) return;
    const index = workspaceHistory.index + delta;
    const next = workspaceHistory.entries[index];
    if (!next) return;
    requestNavigation(() => {
      // A removed project/task is not reconstructed or executed by GUI history.
      const owner = snapshot.projects.find(p => p.id === next.projectId);
      if (next.projectId && (!owner || (next.threadId && !owner.state?.threads[next.threadId]))) {
        setError("该导航位置的项目或任务已不可用。");
        return;
      }
      setWorkspaceHistory(history => ({ ...history, index }));
      if (next.threadId) void open(next.projectId, next.threadId, "restore");
      else if (next.projectId) newTask(next.projectId, false);
      else leaveProject(false);
    });
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && ["[", "]"].includes(e.key) && !e.isComposing && !document.querySelector('[data-slot="dialog-content"]')) {
        e.preventDefault();
        traverseWorkspaceHistory(e.key === "[" ? -1 : 1);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.isComposing && !document.querySelector('[data-slot="dialog-content"]')) {
        e.preventDefault();
        void newTask();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [project?.id, snapshot.projects, workspaceHistory, settingsOpen, taskCenterOpen]);
  const onLink = useCallback((url: string) => {
    if (!project) return;
    const owner = `${project.id}:${threadId}`;
    void services.preview({ operation: 'openLink', projectId: project.id, threadId, url }).then(result => {
      if (previewOwner.current !== owner || result.destination !== 'internal') return;
      setWorkspaceView(mode => mode === "split" ? mode : "panel");
      setPreviewUrl(result.url); setPreviewSource(owner); setPreviewRequest(value => value + 1); setPanel("预览");
    }).catch(cause => { if (previewOwner.current === owner) setError(cause.message); });
  }, [services, project?.id, threadId]);
  const openFile = (path: string) => {
    setWorkspaceView(mode => mode === "split" ? mode : "panel");
    const relative =
      project && path.startsWith(project.root + "/") ? path.slice(project.root.length + 1) : path;
    const next = `file:${relative}`;
    if (!panelTabs.includes(next)) {
      // A temporary view owns one clean document slot. Edited documents retain
      // their existing revision/draft owner and can never be replaced by browsing.
      const replace = previewFileTab && project &&
        !dirtyFiles[`${project.id}:${previewFileTab.slice(5)}`] &&
        confirmCloseFiles(project.id, [previewFileTab.slice(5)]);
      setPanelTabs(tabs => replace && tabs.includes(previewFileTab)
        ? tabs.map(id => id === previewFileTab ? next : id)
        : [...tabs, next]);
      setPreviewFileTab(next);
    }
    setPanel(next);
    setRevealedFile(relative);
  };
  const showFiles = () => {
    setWorkspaceView(mode => mode === "split" ? mode : "panel");
    setFilesOpen(true);
    setPanel("文件");
  };
  const openTerminal = (create = false) => {
    if (!project || !threadId) return;
    setWorkspaceView(mode => mode === "split" ? mode : "panel");
    const owner = terminalOwner(project.id, threadId);
    // Explicit side-pane creation keeps its destination; the shortcut follows
    // the preference while reusing the current owner's existing PTY.
    if (!create && terminalLocation === "bottom") {
      ensureTerminal(owner);
      setPanel(current => isTerminalTab(current) || current === "终端" ? "功能" : current);
      setTerminalOpen(true);
      return;
    }
    setTerminalOpen(false);
    setPanel(create ? addTerminal(owner) : ensureTerminal(owner));
  };
  const showPanel = (name: string) => {
    setWorkspaceView(mode => mode === "split" ? mode : "panel");
    if (["编辑目标", "执行计划", "上下文", "已保存授权", "进程"].includes(name)) {
      setPanel(name);
      return;
    }
    if (name === "文件") {
      showFiles();
      return;
    }
    if (name === "Skills" && thread) {
      setPanel("Skills");
      return;
    }
    if (["设置", "Skills", "MCP"].includes(name)) {
      setSettingsTab(name === "设置" ? "模型服务" : name);
      setSettingsOpen(true);
      return;
    }
    if (name === "终端") {
      if (isTerminalTab(panel) || panel === "终端") setPanel("功能");
      setTerminalOpen((value) => !value);
      return;
    }
    setPanel((p) => (p === name ? "" : name));
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        if (!settingsOpen && !document.querySelector('[data-slot="dialog-content"]')) showPanel("设置");
        return;
      }
      if (project?.id && !settingsOpen && !event.altKey) {
        const key = event.key.toLowerCase();
        const panelShortcut = event.ctrlKey && event.shiftKey && key === "g" ? "改动"
          : event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "Backquote" && threadId ? "终端"
          : (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "t" ? "预览"
          : (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "p" ? "文件"
          : "";
        if (panelShortcut) {
          event.preventDefault();
          if (panelShortcut === "终端") { openTerminal(); return; }
          setWorkspaceView(mode => mode === "split" ? mode : "panel");
          if (panelShortcut === "文件") {
            setFilesOpen(true);
            setPanel("文件");
          } else setPanel(panelShortcut);
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
      if (event.key === "Escape" && !document.querySelector('[data-slot="dialog-content"], [data-slot="select-content"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="context-menu-content"]')) {
        setSearchOpen(false);
        setSearch("");
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [project?.id, settingsOpen, threadId, terminalLocation]);
  const title = (owner: Data, summary: Data) =>
    library.threads?.[`${owner.id}:${summary.id}`]?.title ||
    owner.state?.threads[summary.id]?.turns
      ?.flatMap((t: Data) => t.items ?? [])
      .find((i: Data) => i.type === "userMessage")
      ?.content?.find((p: Data) => p.type === "text")?.text ||
    summary.preview ||
    summary.name ||
    "新对话";
  const summaries = projects.flatMap((owner) => {
    const scheduledThreads = new Set((Object.values(owner.state?.tasks ?? {}) as Data[]).filter(task => task.mode === "scheduled")
      .flatMap(task => [task.threadId, ...task.runs.map((run: Data) => run.threadId)].filter(Boolean)));
    const cached = library.projects?.[owner.id]?.navigationSummaries;
    const knownIds = Object.keys(library.threads ?? {}).filter(key => key.startsWith(`${owner.id}:`));
    const navigation = owner.summariesLoaded === false
      ? Array.isArray(cached) ? cached : knownIds.map(key => ({ id: key.slice(owner.id.length + 1), preview: "未加载的任务" }))
      : owner.summaries ?? [];
    const map = new Map<string, Data>(navigation.map((s: Data) => [s.id, s]));
    for (const t of Object.values(owner.state?.threads ?? {}) as Data[])
      if (!map.has(t.id)) map.set(t.id, t);
    return [...map.values()].filter(summary => !scheduledThreads.has(summary.id)).map((summary) => {
      const t = owner.state?.threads[summary.id];
      return {
        owner,
        summary,
        title: title(owner, summary),
        activityRank: (() => {
          const order = library.projects?.[owner.id]?.threadOrder ?? [];
          const rank = order.indexOf(summary.id);
          return rank < 0 ? order.length : rank;
        })(),
        updatedAt: Math.max(summary.updatedAt ?? summary.createdAt ?? 0, t?.updatedAt ?? t?.createdAt ?? 0),
        archived: t?.desktop?.archived || summary.desktop?.archived,
        pinned: !!library.threads?.[`${owner.id}:${summary.id}`]?.pinned,
        unread: !!library.threads?.[`${owner.id}:${summary.id}`]?.unread,
        sectionId: library.threads?.[`${owner.id}:${summary.id}`]?.sectionId,
        statePending: owner.summariesLoaded === false || owner.state?.connected === false,
        running: owner.state?.connected && t?.turns?.some((t: Data) => t.status === "inProgress"),
        attention: owner.state?.connected && owner.state?.interactions[summary.id]?.data?.some(
          (i: Data) => i.status === "pending",
        ),
      };
    });
  });
  const startRename = (values: Data, current: string) => {
    setPanel("");
    setRename(values);
    setRenameText(current);
  };
  const sections: { id: string; title: string }[] = library.sections ?? [];
  const sidebarKey = (row: Data) => `${row.owner.id}:${row.summary.id}`;
  const sidebarGroup = (row: Data) => row.pinned ? "pinned" : row.sectionId ?? (row.owner.projectless ? "chats" : row.owner.id);
  const sortMode = (area: "Chats" | "Projects" | "Pinned") => library.settings?.[`sidebarSort${area}`] ?? library.settings?.sidebarSort ?? "updated_at";
  const rowSortMode = (row: Data) => sortMode(row.pinned ? "Pinned" : row.sectionId || row.owner.projectless ? "Chats" : "Projects");
  const compareActivity = (a: Data, b: Data) => b.updatedAt - a.updatedAt || a.activityRank - b.activityRank || (b.summary.createdAt ?? 0) - (a.summary.createdAt ?? 0) || a.summary.id.localeCompare(b.summary.id);
  const sortRows = (rows: Data[], mode: string) => [...rows].sort((a, b) => {
    if (mode === "manual") {
      const order: string[] = library.sidebarThreadOrder ?? [];
      const rank = (row: Data) => { const index = order.indexOf(sidebarKey(row)); return index < 0 ? order.length : index; };
      const difference = rank(a) - rank(b);
      if (difference) return difference;
    }
    if (mode === "priority") {
      const priority = (row: Data) => row.attention ? 3 : row.unread ? 2 : row.running ? 1 : 0;
      const difference = priority(b) - priority(a);
      if (difference) return difference;
    }
    return compareActivity(a, b);
  });
  const organize = (request: Data) => void action("library", request).catch(() => {});
  const sidebarDrag = useSidebarDrag(request => action("library", request), library.sidebarRevision ?? 0);
  const taskPlacement = (row: Data) => row.pinned ? { type: "pinned" } : row.sectionId ? { type: "section", id: row.sectionId } : row.owner.projectless ? { type: "chats" } : { type: "project", id: row.owner.id };
  const projectPlacement = (id: string) => library.projects?.[id]?.pinned ? { type: "pinned" } : library.projects?.[id]?.sectionId ? { type: "section", id: library.projects[id].sectionId } : { type: "projects" };
  const placementKey = (target: Data) => target.id ? `${target.type}:${target.id}` : target.type;
  const dropRequest = (source: SidebarDragSource, target: Data, edge: "before" | "after", anchor: string | null = null) => {
    if (source.type === "section") return target.type === "section" && source.id !== target.id
      ? { operation: "dropSidebar", source, target, edge } : null;
    if (source.type === "thread" && target.type === "projects") target = snapshot.projects.find(p => p.id === source.projectId)?.projectless ? { type: "chats" } : { type: "project", id: source.projectId };
    if (source.type === "thread" && target.type === "project" && target.id !== source.projectId) return null;
    if (source.type === "project" && target.type === "project") return null;
    const key = source.type === "thread" ? `${source.projectId}:${source.id}` : source.id;
    if (anchor === key) return null;
    const order = source.type === "thread"
      ? sortRows(visibleRows.filter(row => placementKey(taskPlacement(row)) === placementKey(target)), sortMode(target.type === "pinned" ? "Pinned" : target.type === "section" || target.type === "chats" ? "Chats" : "Projects")).map(sidebarKey)
      : (target.type === "pinned" ? pinnedProjects : projects).filter(owner => placementKey(projectPlacement(owner.id)) === placementKey(target)).map(owner => owner.id);
    return { operation: "dropSidebar", source, target, anchor, edge, order };
  };
  const moveMenu = (operation: "moveThread" | "moveProject", values: Data, current?: string) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>移动到分组</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem disabled={!current && !values.pinned} onClick={() => organize({ operation, ...values, sectionId: null })}>{snapshot.projects.find(p => p.id === values.projectId)?.projectless ? "任务" : "项目"}</DropdownMenuItem>
        {sections.map(section => <DropdownMenuItem key={section.id} disabled={current === section.id} onClick={() => organize({ operation, ...values, sectionId: section.id })}>{section.title}</DropdownMenuItem>)}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  const taskRow = (row: Data) => (
    <MemoTaskItem
      key={`${row.owner.id}:${row.summary.id}`}
      id={row.summary.id}
      nested={!row.owner.projectless && !row.pinned && !row.sectionId}
      title={row.title}
      active={project?.id === row.owner.id && threadId === row.summary.id}
      pinned={row.pinned}
      running={row.running}
      attention={row.attention}
      unread={row.unread}
      statePending={row.statePending}
      dragProps={{
        ...sidebarDrag.source({ type: "thread", id: row.summary.id, projectId: row.owner.id, group: placementKey(taskPlacement(row)) }, row.owner.pending.length > 0 || !!search),
        ...sidebarDrag.target(`thread:${sidebarKey(row)}`, (source, edge) => source.type === "thread" ? dropRequest(source, taskPlacement(row), edge, sidebarKey(row)) : null),
      }}
      organizationActions={<>
        <DropdownMenuItem onClick={() => organize({ operation: "readThread", projectId: row.owner.id, threadId: row.summary.id, read: row.unread })}>{row.unread ? "标为已读" : "标为未读"}</DropdownMenuItem>
        {moveMenu("moveThread", { projectId: row.owner.id, threadId: row.summary.id, pinned: row.pinned }, row.sectionId)}
        {([[-1, "上移"], [1, "下移"]] as const).map(([direction, label]) => {
          const siblings = sortRows(visibleRows.filter(candidate => sidebarGroup(candidate) === sidebarGroup(row)), rowSortMode(row));
          const index = siblings.findIndex(candidate => sidebarKey(candidate) === sidebarKey(row));
          return <DropdownMenuItem key={label} disabled={rowSortMode(row) !== "manual" || index + direction < 0 || index + direction >= siblings.length}
            onClick={() => organize({ operation: "orderSidebarThread", projectId: row.owner.id, threadId: row.summary.id, before: direction < 0 ? sidebarKey(siblings[index - 1]) : siblings[index + 2] ? sidebarKey(siblings[index + 2]) : null })}>{label}</DropdownMenuItem>;
        })}
        <DropdownMenuSeparator />
      </>}
      archived={row.archived}
      disabled={row.owner.pending.length > 0}
      onSelect={() => void open(row.owner.id, row.summary.id)}
      onRename={() =>
        startRename(
          {
            operation: "renameThread",
            projectId: row.owner.id,
            threadId: row.summary.id,
          },
          row.title,
        )
      }
      onPin={() =>
        void action("library", {
          operation: "pinThread",
          projectId: row.owner.id,
          threadId: row.summary.id,
          pinned: !row.pinned,
        }).catch(() => {})
      }
      onArchive={() =>
        void action("manage", {
          projectId: row.owner.id,
          threadId: row.summary.id,
          operation: "archive",
        }).catch(() => {})
      }
    />
  );
  const visibleRows = summaries.sort(compareActivity).filter(
    (r) =>
      !!r.archived === archived &&
      `${r.title} ${r.owner.root}`.toLowerCase().includes(search.toLowerCase()),
  );
  const pinnedProjects = projects.filter(owner => !owner.projectless && library.projects?.[owner.id]?.pinned).sort((a, b) => {
    const mode = sortMode("Pinned");
    if (mode === "manual") return 0; // The project index already applies the saved order.
    const rows = (owner: Data) => visibleRows.filter(row => row.owner.id === owner.id);
    if (mode === "priority") {
      const priority = (owner: Data) => Math.max(0, ...rows(owner).map(row => row.attention ? 3 : row.unread ? 2 : row.running ? 1 : 0));
      const difference = priority(b) - priority(a);
      if (difference) return difference;
    }
    return Math.max(0, ...rows(b).map(row => row.updatedAt)) - Math.max(0, ...rows(a).map(row => row.updatedAt));
  });
  const dragSource = sidebarDrag.active;
  const dragTitle = !dragSource ? "" : dragSource.type === "thread"
    ? summaries.find(row => row.summary.id === dragSource.id && row.owner.id === dragSource.projectId)?.title
    : dragSource.type === "section" ? sections.find(section => section.id === dragSource.id)?.title
    : library.projects?.[dragSource.id]?.title || projects.find(owner => owner.id === dragSource.id)?.root.split("/").pop();
  const projectGroup = (owner: Data) => {
    const rows = sortRows(visibleRows.filter((r) => r.owner.id === owner.id && !r.pinned && !r.sectionId), sortMode("Projects"));
    const collapsed = collapsedProjects[owner.id] ?? false;
    const visibleCount = projectVisibleCounts[owner.id] ?? 5;
    return (
      <section className="project-group" key={owner.id} data-sidebar-project={owner.id}>
        <SidebarDragSurface className="project-row group/project"
          {...sidebarDrag.source({ type: "project", id: owner.id, group: placementKey(projectPlacement(owner.id)) }, !!search)}
          {...sidebarDrag.target(`project:${owner.id}`, (source, edge) => source.type === "thread" ? dropRequest(source, { type: "project", id: owner.id }, edge) : source.type === "project" ? dropRequest(source, projectPlacement(owner.id), edge, owner.id) : null)}
        >
          <button
            className="project-label"
            aria-current={!taskCenterOpen && project?.id === owner.id && !threadId ? "page" : undefined}
            aria-expanded={!collapsed}
            aria-controls={`project-threads-${owner.id}`}
            onClick={() => {
              setCollapsedProjects((current) => ({
                ...current,
                [owner.id]: !current[owner.id],
              }));
              setProjectVisibleCounts((current) => ({ ...current, [owner.id]: 5 }));
            }}
          >
            {collapsed ? <ProjectFolderIcon /> : <ProjectOpenFolderIcon />}
            <span>
              {library.projects?.[owner.id]?.title || owner.root.split("/").pop()}
            </span>
          </button>
          <div className="project-actions">
          <DropdownMenu>
            <DropdownMenuTrigger render={<button className="icon-button" aria-label={`项目操作 ${library.projects?.[owner.id]?.title || owner.root.split("/").pop()}`}><MoreHorizontal size={16} /></button>} />
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => requestNavigation(() => {updateSettingsOpen(false);setTaskScope(owner.id);setTaskNotification(undefined);setTaskCenterOpen(true);})}>执行任务</DropdownMenuItem>
              <DropdownMenuItem onClick={() => startRename({ operation: "renameProject", projectId: owner.id }, library.projects?.[owner.id]?.title || owner.root.split("/").pop())}>重命名</DropdownMenuItem>
              <DropdownMenuItem disabled={!services.fileOpen} onClick={() => void services.fileOpen?.({ operation: "open", projectId: owner.id, path: "." }).catch(cause => setError(cause.message))}>在默认应用中打开</DropdownMenuItem>
              <DropdownMenuItem disabled={!services.fileOpen} onClick={() => void services.fileOpen?.({ operation: "reveal", projectId: owner.id, path: "." }).catch(cause => setError(cause.message))}>在文件管理器中显示</DropdownMenuItem>
              <DropdownMenuItem onClick={() => organize({ operation: "pinProject", projectId: owner.id, pinned: !library.projects?.[owner.id]?.pinned })}>{library.projects?.[owner.id]?.pinned ? "取消置顶项目" : "置顶项目"}</DropdownMenuItem>
              {moveMenu("moveProject", { projectId: owner.id, pinned: library.projects?.[owner.id]?.pinned }, library.projects?.[owner.id]?.sectionId)}
              {([[-1, "上移"], [1, "下移"]] as const).map(([direction, label]) => {
                const siblings = projects.filter(candidate => (!!library.projects?.[candidate.id]?.pinned === !!library.projects?.[owner.id]?.pinned) && (library.projects?.[candidate.id]?.sectionId ?? null) === (library.projects?.[owner.id]?.sectionId ?? null));
                const index = siblings.findIndex(candidate => candidate.id === owner.id);
                return <DropdownMenuItem key={label} disabled={(library.projects?.[owner.id]?.pinned && sortMode("Pinned") !== "manual") || index + direction < 0 || index + direction >= siblings.length} onClick={() => organize({ operation: "orderProject", projectId: owner.id, before: direction < 0 ? siblings[index - 1].id : siblings[index + 2]?.id ?? null })}>{label}</DropdownMenuItem>;
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" className="icon-button"
            aria-label={`在项目 ${library.projects?.[owner.id]?.title || owner.root.split("/").pop()} 中新建对话`}
            title={`在项目 ${library.projects?.[owner.id]?.title || owner.root.split("/").pop()} 中新建对话`}
            onClick={() => newTask(owner.id)}><ProjectNewChatIcon /></button>
          </div>
        </SidebarDragSurface>
        <div id={`project-threads-${owner.id}`} hidden={collapsed}>
          <ul>{rows.slice(0, visibleCount).map(row => taskRow(row))}</ul>
          {rows.length > visibleCount && (
            <button
              type="button"
              className="project-show-more"
              onClick={() =>
                setProjectVisibleCounts((current) => ({
                  ...current,
                  [owner.id]: (current[owner.id] ?? 5) + 5,
                }))
              }
            >
              Show more
            </button>
          )}
        </div>
      </section>
    );
  };
  const queue = project?.state?.queues[threadId];
  const pending = project?.pending?.some((p: Data) => p.params?.threadId === threadId);
  const currentTitle = threadId && project
    ? (summaries.find((r) => r.owner.id === project.id && r.summary.id === threadId)?.title ??
      "新对话")
    : "新对话";
  const workspaceFileTree = filesOpen && project ? <WorkspaceFileTree
    key={project.id} projectId={project.id} root={project.root} action={action}
    onClose={() => { setFilesOpen(false); if (panel === "文件") setPanel("功能"); }}
    onOpen={openFile} activePath={panel.startsWith("file:") ? panel.slice(5) : revealedFile}
  /> : undefined;
  const panelBody = (panelName = panel) => {
    const panel = panelName;
    if (!project) return null;
    const props = { project, thread, action };
    if (panel.startsWith("agent:") && thread) {
      const childId = panel.slice(6);
      return <AgentConversationPane key={`${project.id}:${childId}`} project={project} parentId={project.state?.threads[childId]?.parentThreadId ?? thread.id} childId={childId} action={resourceAction} dark={dark} onLink={onLink} onFile={openFile}
        onAgent={id => showPanel(`agent:${id}`)} onReview={(id, turnId) => { setReviewRequest({ owner: panelOwner, threadId: id, turnId }); showPanel("改动"); }} />;
    }
    if (panel === "编辑目标" && thread) return <GoalEditor key={`${project.id}:${thread.id}:${thread.goals?.goal?.id ?? "new"}`} project={project} thread={thread} action={resourceAction} />;
    if (panel.startsWith("file:"))
      return (
        <WorkspaceFilePane
          key={`${project.id}:${panel}`}
          projectId={project.id}
          root={project.root}
          path={panel.slice(5)}
          action={action}
          onDirty={(path, dirty) => {
            setDirtyFiles((current) => ({ ...current, [`${project.id}:${path}`]: dirty }));
            if (dirty) setPreviewFileTab(current => current === `file:${path}` ? undefined : current);
          }}
          onLink={onLink}
          fileOpen={services.fileOpen}
          preferredFileOpenTarget={library.settings?.fileOpenTarget}
          filesOpen={filesOpen}
          onToggleFiles={() => setFilesOpen(value => !value)}
          tree={workspaceFileTree}
        />
      );
    if (panel === "文件") return <div className="file-preview-empty">选择右侧文件以预览</div>;
    if (panel === "改动") {
      const reviewedId = (reviewRequest?.owner === panelOwner ? reviewRequest.threadId ?? threadId : threadId) || "new";
      const reviewedThread = project.state?.threads[reviewedId];
      return (
        <GitPane
          key={`${project.id}:${reviewedId}`}
          projectId={project.id}
          threadId={reviewedId}
          turnId={reviewedThread?.turns?.findLast((turn: Data) => turn.status !== "inProgress")?.id}
          reviewRequest={reviewRequest?.owner === panelOwner ? reviewRequest : undefined}
          root={project.root}
          action={resourceAction}
          onFile={openFile}
          fileOpen={services.fileOpen}
          commentsDisabled={!!(reviewRequest?.owner === panelOwner && reviewRequest.threadId && reviewRequest.threadId !== threadId) || !project.state?.connected || !!thread?.desktop?.archived || !!(thread?.source === "nativeTaskAgent" && thread?.goalOwner) || !!pending || admitting || (!!threadId && !thread)}
          filesOpen={filesOpen}
          onToggleFiles={() => setFilesOpen(value => !value)}
          onReveal={(path) => {
            setRevealedFile(path);
            setFilesOpen(true);
          }}
        />
      );
    }
    if (panel === "MCP")
      return (
        <div className="utility-content">
          <McpSettings key={project.id} {...props} action={resourceAction} />
        </div>
      );
    if (panel === "设置")
      return (
        <div className="utility-content">
          <panels.Providers {...props} />
        </div>
      );
    if (panel === "预览")
      return (
        <Preview
          key={`${project.id}:${threadId}`}
          services={services}
          projectId={project.id}
          threadId={threadId}
          initialUrl={previewSource === `${project.id}:${threadId}` ? previewUrl : ""}
          initialRequest={previewRequest}
          fullAddress={library.settings?.browserFullAddress === true}
          onError={setError}
        />
      );
    if (panel === "工作组") return <WorkgroupsPane key={project.id} project={project} action={resourceAction} />;
    if (!thread) return <div className="utility-content">请先选择任务。</div>;
    if (panel === "执行计划") return <PlanPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "已保存授权") return <SavedPermissionsPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "上下文") return <ContextPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "进程") return <ProcessesPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "Skills")
      return (
        <div className="utility-content">
          <TaskSkillsSettings key={`${project.id}:${threadId}`} {...props} action={resourceAction} />
        </div>
      );
    if (panel === "调用轨迹") return <ModelTrajectoryPane key={`${project.id}:${threadId}`} thread={thread} title={currentTitle} refresh={() => resourceAction("open", { projectId: project.id, threadId })} onClose={() => setPanel("")} />;
    if (panel === "子任务") return <AgentsPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} onOpen={(id) => id === thread.parentThreadId ? void open(project.id, id) : showPanel(`agent:${id}`)} />;
    if (panel === "用量") return <Usage thread={thread} />;
    if (panel === "队列")
      return queue ? (
        <Queue
          queue={queue}
          projectId={project.id}
          threadId={threadId}
          disabled={!project.state?.connected || pending || thread.desktop?.archived}
          action={action}
        />
      ) : null;
    if (isTerminalTab(panel))
      return (
        <TerminalPane
          key={`${project.id}:${threadId}:${panel}`}
          {...props}
          terminalId={panel}
          canStart={!admitting && !pending && !!project.state?.connected}
          onError={setError}
          onLink={onLink}
        />
      );
    return null;
  };
  const admitting = useSyncExternalStore(subscribeSending, () =>
    sending.has(`areal-gui:draft:${project?.id}:${threadId || "new"}`),
  );
  const empty =
    !(thread && admitting) &&
    !thread?.turns?.some((turn: Data) => turn.items?.length || turn.status === "inProgress");
  const taskActions = <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button aria-label="任务操作" className="icon-button" disabled={!project}>
                          <MoreHorizontal size={16} />
                        </button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setArchived(!archived); setSidebar(true); }}>
                        <span aria-hidden="true" className="size-4 shrink-0" />
                        {archived ? "返回当前任务" : "查看归档"}
                      </DropdownMenuItem>
                      {thread && (
                        <DropdownMenuItem onClick={() => { setPanel("调用轨迹"); setWorkspaceView(mode => mode === "split" ? mode : "panel"); }}>
                          <span aria-hidden="true" className="size-4 shrink-0" />
                          查看调用轨迹
                        </DropdownMenuItem>
                      )}
                      {panelList
                        .filter(([name]) => name !== "终端")
                        .map(([name, icon]) => (
                          <DropdownMenuItem key={name} onClick={() => showPanel(name)}>
                            {icon ?? <span aria-hidden="true" className="size-4 shrink-0" />}
                            {name}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>;
  const applicationRail = <ApplicationRail activeId={settingsOpen ? "settings" : taskSurface ?? "home"} items={[
              { id: "home", label: "首页", icon: <Home active={!settingsOpen && !taskCenterOpen} />, onSelect: () => requestNavigation(() => { if (taskCenterOpen) recordWorkspaceLocation({ projectId: project?.id ?? "", threadId }); setTaskCenterOpen(false); updateSettingsOpen(false); }) },
              { id: "inbox", label: "Inbox", icon: <InboxIcon />, onSelect: () => requestNavigation(() => { updateSettingsOpen(false); setTaskSurface("inbox"); if (matchMedia("(max-width: 640px)").matches) setSidebar(false); }) },
              { id: "tasks", label: "执行任务", icon: <CalendarClock />, onSelect: () => requestNavigation(() => { updateSettingsOpen(false); setTaskScope(undefined); setTaskNotification(undefined); setTaskCenterOpen(true); if (matchMedia("(max-width: 640px)").matches) setSidebar(false); }) },
              { id: "plugins", label: "插件", icon: <SettingsPluginIcon />, onSelect: () => requestNavigation(() => { updateSettingsTab("插件"); setSettingsOpen(true); }) },
            ]} footer={<><UpdateIndicator services={services} /><Button variant="ghost" size="icon" className="application-rail-button" aria-label="设置" title="设置" aria-current={settingsOpen ? "page" : undefined} onClick={() => showPanel("设置")}><Settings /></Button></>} />;
  const workspaceNavigation = <div className="workspace-navigation">
    <button className="icon-button" aria-label="后退" title="后退 (⌘[)" disabled={taskCenterOpen || workspaceHistory.index <= 0} onClick={() => traverseWorkspaceHistory(-1)}><ArrowLeft size={16} /></button>
    <button className="icon-button" aria-label="前进" title="前进 (⌘])" disabled={taskCenterOpen || workspaceHistory.index >= workspaceHistory.entries.length - 1} onClick={() => traverseWorkspaceHistory(1)}><ArrowRight size={16} /></button>
    <button className="icon-button" aria-label={sidebar ? "收起侧栏" : "展开侧栏"} aria-expanded={sidebar} aria-controls="areal-sidebar" onClick={() => setSidebar(!sidebar)}><SidebarToggleIcon /></button>
  </div>;
  return (
    <WorkbenchShell
      data-view={settingsOpen ? "settings" : taskCenterOpen ? "tasks" : "workspace"}
      data-testid="areal-workbench"
      data-project-id={project?.id ?? ""}
      data-thread-id={threadId}
      data-startup-ready={startupReady}
    >
      {!sidebar && !settingsOpen && <div className="areal-update-floating"><UpdateIndicator services={services} /></div>}
      {settingsOpen ? (
        <SettingsNavigation width={sidebarWidth} rail={applicationRail}
          activeId={["Skills", "MCP"].includes(settingsTab) ? "插件" : settingsTab}
          onSelect={setSettingsTab} onBack={() => setSettingsOpen(false)}
          groups={settingsNavigationGroups}
        />
      ) : (
        <NavigationSidebar id="areal-sidebar" data-testid="areal-sidebar" data-collapsed={!sidebar} railOnly={taskCenterOpen || !sidebar} width={sidebarWidth} onWidthChange={setSidebarWidth}
            chrome={workspaceNavigation}
            rail={applicationRail}
            footer={null}
          >
              <>
                <SidebarWorkspaceHeader title="AReaL Harness" onSearch={() => setSearchOpen(true)} />
                <div className="sidebar-tools">
                  <NewTaskButtonGroup
                    disabled={false}
                    onCreateTask={() => void newTask()}
                  />
                </div>
                <DndContext {...sidebarDrag.context}>
                <div className="sidebar-scroll">
                  {(visibleRows.some((r) => r.pinned) || projects.some(owner => library.projects?.[owner.id]?.pinned) || (sidebarDrag.active && sidebarDrag.active.type !== "section")) && (
                    <section className="project-group" data-sidebar-pinned>
                      <SidebarDragSurface className="section-heading" data-sidebar-drop-zone="pinned" {...sidebarDrag.target("pinned", (source, edge) => dropRequest(source, { type: "pinned" }, edge))}><SidebarSectionToggle label="置顶" ariaLabel="置顶分类" controls="sidebar-pinned" expanded={!collapsedProjects["sidebar:pinned"]} onToggle={() => toggleSidebarGroup("sidebar:pinned")} /></SidebarDragSurface>
                      <div id="sidebar-pinned" hidden={!!collapsedProjects["sidebar:pinned"]}>
                      {pinnedProjects.map(projectGroup)}
                      <ul>{sortRows(visibleRows.filter((r) => r.pinned), sortMode("Pinned")).map(row => taskRow(row))}</ul>
                      </div>
                    </section>
                  )}
                  {sections.map((section, index) => <section className="project-group" key={section.id} data-sidebar-section={section.id}>
                    <SidebarDragSurface className="section-heading"
                      {...sidebarDrag.source({ type: "section", id: section.id }, !!search)}
                      {...sidebarDrag.target(`section:${section.id}`, (source, edge) => dropRequest(source, { type: "section", id: section.id }, edge))}
                    >
                      <SidebarSectionToggle label={section.title} ariaLabel={`分组 ${section.title}`} controls={`sidebar-section-${section.id}`} expanded={!collapsedProjects[section.id]} onToggle={() => toggleSidebarGroup(section.id)} />
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<button className="section-action-btn" aria-label={`分组操作 ${section.title}`}><MoreHorizontal size={16} /></button>} />
                        <DropdownMenuContent>
                          <DropdownMenuItem onClick={() => startRename({ operation: "renameSection", sectionId: section.id }, section.title)}>重命名</DropdownMenuItem>
                          <DropdownMenuItem disabled={index === 0} onClick={() => organize({ operation: "orderSection", sectionId: section.id, before: sections[index - 1].id })}>上移</DropdownMenuItem>
                          <DropdownMenuItem disabled={index === sections.length - 1} onClick={() => organize({ operation: "orderSection", sectionId: section.id, before: sections[index + 2]?.id ?? null })}>下移</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => organize({ operation: "removeSection", sectionId: section.id })}>移除分组</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </SidebarDragSurface>
                    <div id={`sidebar-section-${section.id}`} hidden={!!collapsedProjects[section.id]}>
                      <ul>{sortRows(visibleRows.filter(row => !row.pinned && row.sectionId === section.id), sortMode("Chats")).map(row => taskRow(row))}</ul>
                      {projects.filter(owner => !owner.projectless && !library.projects?.[owner.id]?.pinned && library.projects?.[owner.id]?.sectionId === section.id).map(projectGroup)}
                    </div>
                  </section>)}
                  <section className="project-group" data-sidebar-projects>
                  <SidebarDragSurface className="section-heading" data-sidebar-drop-zone="projects" {...sidebarDrag.target("projects", (source, edge) => dropRequest(source, { type: "projects" }, edge))}>
                    <SidebarSectionToggle label={archived ? "已归档任务" : "项目"} ariaLabel="项目分类" controls="sidebar-projects" expanded={!collapsedProjects["sidebar:projects"]} onToggle={() => toggleSidebarGroup("sidebar:projects")} />
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<button className="section-action-btn" aria-label="侧栏整理"><MoreHorizontal size={16} /></button>} />
                      <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => startRename({ operation: "createSection" }, "")}>新建分组</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {([["Chats", "独立任务排序"], ["Projects", "项目内任务排序"], ["Pinned", "置顶项排序"]] as const).map(([area, label]) => <DropdownMenuSub key={area}>
                          <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuRadioGroup value={sortMode(area)} onValueChange={value => organize({ operation: "settings", key: `sidebarSort${area}`, value, order: visibleRows.map(sidebarKey) })}>
                              {([["updated_at", "最近更新"], ["priority", "优先处理"], ["manual", "手动排序"]] as const).map(([value, title]) => <DropdownMenuRadioItem key={value} value={value}>{title}</DropdownMenuRadioItem>)}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>)}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => organize({ operation: "markAllRead" })}>全部标为已读</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarDragSurface>
                  <div id="sidebar-projects" hidden={!!collapsedProjects["sidebar:projects"]}>
                  {projects.filter(owner => !owner.projectless && !library.projects?.[owner.id]?.pinned && !library.projects?.[owner.id]?.sectionId).map(projectGroup)}
                  {!projects.length && <p className="empty-tasks">打开项目以开始</p>}
                  </div>
                  </section>
                  {visibleRows.some(row => row.owner.projectless && !row.pinned && !row.sectionId) && <section className="project-group" data-sidebar-chats>
                    <SidebarDragSurface className="section-heading" data-sidebar-drop-zone="chats"
                      {...sidebarDrag.target("chats", (source, edge) => source.type === "thread" ? dropRequest(source, { type: "projects" }, edge) : null)}>
                      <SidebarSectionToggle label="任务" ariaLabel="独立任务分类" controls="sidebar-chats" expanded={!collapsedProjects["sidebar:chats"]} onToggle={() => toggleSidebarGroup("sidebar:chats")} />
                    </SidebarDragSurface>
                    <div id="sidebar-chats" hidden={!!collapsedProjects["sidebar:chats"]}>
                      <ul>{sortRows(visibleRows.filter(row => row.owner.projectless && !row.pinned && !row.sectionId), sortMode("Chats")).map(row => taskRow(row))}</ul>
                    </div>
                  </section>}
                </div>
                <DragOverlay dropAnimation={null}>{dragSource && <div className="sidebar-drag-preview">{dragTitle}</div>}</DragOverlay>
                </DndContext>
              </>
          </NavigationSidebar>
      )}
      <main className={`work-area ${settingsOpen ? "settings-open" : ""}`}
        data-workspace-view={panel && !settingsOpen && !taskCenterOpen && workspaceView !== "split" ? workspaceView : undefined}>
        <WorkSurface panelOpen={Boolean(panel && project && !settingsOpen && !taskCenterOpen)} split={workspaceView === "split" && !settingsOpen && !taskCenterOpen}>
          {!taskCenterOpen && <WorkspaceHeader>
            {!sidebar && !settingsOpen && workspaceNavigation}
            {!settingsOpen && !taskCenterOpen && (!empty || (!thread && !!threadId)) && <div className="header-context">
              <ProjectFolderIcon />
              <strong className="header-task">{currentTitle}</strong>
            </div>}
            <div className="header-tools">
              {!settingsOpen && !taskCenterOpen && (
                <>
                  {thread && !empty && (
                    <TaskResourcesPopover key={panelOwner} project={project} thread={thread} action={resourceAction} selectedAgent={panel.startsWith("agent:") ? panel.slice(6) : undefined}
                      onPanel={name => { if (name === "改动") setReviewRequest({ owner: panelOwner, scope: "unstaged" }); showPanel(name); }}
                      onAgent={id => showPanel(`agent:${id}`)} onFile={openFile} />
                  )}
                  {showBottomPanelControl && <button
                    className={`icon-button ${terminalOpen ? "active" : ""}`}
                    aria-label="终端"
                    aria-pressed={terminalOpen}
                    disabled={!thread}
                    onClick={() => showPanel("终端")}
                  >
                    <BottomPanelIcon />
                  </button>}
                  <button
                    className={`icon-button ${panel ? "active" : ""}`}
                    aria-label="展开侧边面板"
                    aria-pressed={Boolean(panel)}
                    disabled={!project}
                    onClick={() => {
                      const last = panelViews.current.get(panelOwner)?.lastPanel;
                      setPanel(panel ? "" : last && (last === "功能" || panelTabs.includes(last)) ? last : panelTabs.at(-1) ?? "功能");
                    }}
                  >
                    <SidePanelIcon />
                  </button>
                  {taskActions}
                </>
              )}
            </div>
          </WorkspaceHeader>}
          {snapshot.connection && snapshot.connection.state !== "ready" && (
            <div className="notice" role="status">
              <span>{snapshot.connection.state === "connecting" ? "正在连接后台…" : snapshot.connection.message || "后台尚未连接"}</span>
              {snapshot.connection.state === "unavailable" && (
                <button onClick={() => { setError(""); void reconnectService().catch(cause => setError((cause as Error).message)); }}>重新连接后台</button>
              )}
            </div>
          )}
          {(error || project?.error || project?.state?.error) && (
            <div className="error-banner" role="alert">
              <span>{error || project?.error || project?.state?.error}</span>
              {thread && restoration?.projectId === project?.id && restoration?.failed && (
                <button onClick={() => void retryRestoration()}>重试加载对话</button>
              )}
              <button aria-label="关闭提示" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {/* Restored projects connect asynchronously; only actual failures need recovery. */}
          {project && !project.state?.connected && (project.error || project.state?.error) && (
            <div className="notice" role="status">
              Core 未连接。
              <button
                onClick={() => {
                  setError("");
                  void action("connect", { projectId: project.id }).catch(() => {});
                }}
              >
                重新连接
              </button>
            </div>
          )}
          {!!project?.pending.filter((entry: Data) => !entry.awaitingResponse).length && (
            <div className="notice" role="status">
              暂时无法确认 {project.pending.filter((entry: Data) => !entry.awaitingResponse).length} 项操作是否已送达，不会自动重发。
              <button
                onClick={() => void action("reconcile", { projectId: project.id }).catch(() => {})}
              >
                检查发送状态
              </button>
            </div>
          )}
          {settingsOpen ? (
            <SettingsPage
              key={settingsTab}
              className={["插件", "Skills", "MCP"].includes(settingsTab) ? "plugins-settings-page" : settingsTab === "模型服务" ? "model-settings-page" : undefined}
              title={["插件", "Skills", "MCP"].includes(settingsTab) ? "插件" : settingsLabel(settingsTab)}
              subtitle={settingsTab === "浏览器" ? "管理链接打开方式和地址栏显示。" : undefined}>
              {settingsTab === "外观" ? (
                <AppearanceSettings
                  theme={theme}
                  setTheme={setTheme}
                  fontSize={uiFontSize}
                  setFontSize={setUiFontSize}
                />
              ) : settingsTab === "常规" ? (
                <GeneralSettings settings={library.settings} power={snapshot.power} menuBar={snapshot.menuBar} projectlessDirectory={snapshot.projectless?.directory} chooseProjectlessDirectory={services.chooseProjectlessDirectory} fileOpen={services.fileOpen} action={resourceAction} connected={snapshot.connection?.state === "ready"} />
              ) : settingsTab === "浏览器" ? (
                <BrowserSettings settings={library.settings} action={resourceAction} connected={snapshot.connection?.state === "ready"} />
              ) : settingsTab === "钩子" ? (
                <HooksSettings action={resourceAction} connected={snapshot.connection?.state === "ready"} onConnect={reconnectService} />
              ) : settingsTab === "模型服务" ? (
                <ModelSettings project={project} thread={thread} action={action} />
              ) : settingsTab === "会话配置" ? (
                project && thread ? <SessionSettings key={`${project.id}:${thread.id}`} project={project} thread={thread} action={resourceAction} /> : <div className="settings-empty"><p>请先选择任务，以编辑会话配置。</p></div>
              ) : settingsTab === "手机连接" ? (
                <MobileSettings action={resourceAction} projects={snapshot.projects} />
              ) : settingsTab === "后台服务" ? (
                <><ServiceStatusSettings connected={snapshot.connection?.state === "ready"} action={resourceAction}
                  onConnect={reconnectService}
                  onTask={(pid, taskId) => { updateSettingsOpen(false); setTaskScope(undefined); setTaskNotification({ projectId: pid, taskId }); setTaskCenterOpen(true); }}
                  onOpen={(pid, tid, panelName) => { updateSettingsOpen(false); void open(pid, tid).then(() => { if (panelName) setPanel(panelName); }); }} />
                <CoreCapabilitiesSettings projects={snapshot.projects} connected={snapshot.connection?.state === "ready"} /></>
              ) : settingsTab === "用量" ? (
                <UsageDashboard action={resourceAction} />
              ) : ["插件", "Skills", "MCP"].includes(settingsTab) ? (
                <PluginsSettings key={`${project?.id}:${settingsTab}`} project={project} thread={thread} action={resourceAction} initialTab={settingsTab === "Skills" ? "skills" : "mcp"}/>
              ) : !project ? (
                <div className="settings-empty">
                  <p>请先打开项目，以读取当前项目的设置。</p>
                  <button onClick={() => void choose()}>打开项目</button>
                </div>
              ) : (
                panelBody(settingsTab)
              )}
            </SettingsPage>
          ) : taskSurface === "inbox" ? (
            <Inbox projects={snapshot.projects} connected={snapshot.connection?.state === "ready"} action={resourceAction} onClose={() => setTaskCenterOpen(false)} />
          ) : taskCenterOpen ? (
            <TaskCenter currentThread={project && thread && !thread.parentThreadId && !thread.desktop?.archived ? {projectId:project.id,threadId} : undefined} target={taskNotification} initialProjectId={taskScope} projects={snapshot.projects.map(p => ({...p,name:library.projects?.[p.id]?.title || p.root.split(/[\\/]/).pop()}))} connected={snapshot.connection?.state === "ready"} action={resourceAction} onOpenThread={(pid,id) => void open(pid, id)} renderConversation={(owner,executionThread,beforeTurns) => <><Messages beforeTurns={beforeTurns} project={owner} thread={executionThread} action={action} dark={dark} onLink={onLink}
              onFile={path => {void open(owner.id,executionThread.id).then(() => openFile(path));}}
              onReview={turnId => {void open(owner.id,executionThread.id).then(() => {setReviewRequest({owner:`${owner.id}:${executionThread.id}`,turnId});setPanel("改动");});}}
              readTurnReview={(turnId,itemId) => resourceAction("workspace",{projectId:owner.id,threadId:executionThread.id,turnId,itemId,operation:"turnReview"})}/>
              <Composer key={executionThread.id} project={owner} thread={executionThread} action={action} readAction={resourceAction} onPanel={name => {void open(owner.id,executionThread.id).then(() => showPanel(name));}} onNew={() => void newTask()}/></>}
            navigation={<>
              {!sidebar && <button className="icon-button" aria-label="展开侧栏" onClick={() => setSidebar(true)}><SidebarToggleIcon /></button>}
              <button className="icon-button" aria-label="返回对话" onClick={() => { setTaskCenterOpen(false); setTaskNotification(undefined); }}><ArrowLeft /></button>
            </>} />
          ) : (
            <div className="workspace-content">
              <div className="conversation-column">
                <section
                  className={`conversation-pane ${empty ? "draft-pane" : ""}`}
                  data-testid="chat-view"
                >
                  {thread ? (
                    <>
                      {empty ? (
                        <div className="draft-greeting">
                          <ConversationDraftEmptyState projectName={project ? library.projects?.[project.id]?.title || project.root.split("/").pop() : undefined} />
                        </div>
                      ) : (
                        <Messages
                          project={project}
                          thread={thread}
                          action={action}
                          dark={dark}
                          onLink={onLink}
                          onFile={openFile}
                          onReview={turnId => { setReviewRequest({ owner: panelOwner, turnId }); setPanel("改动"); setWorkspaceView(mode => mode === "split" ? mode : "panel"); }}
                          readTurnReview={readTurnReview}
                          onAgent={id => showPanel(`agent:${id}`)}
                        />
                      )}
                      <div className={empty ? "draft-composer" : "active-composer"}>
                        {empty && (
                          <div className="composer-project-bar">
                            <div className="composer-project-leading">
                            <div className="composer-project">
                              <ProjectFolderIcon />
                              <span>{library.projects?.[project.id]?.title || project.root.split("/").pop()}</span>
                            </div>
                            <ComposerWorkspaceContext project={project} action={resourceAction} />
                            </div>
                          </div>
                        )}
                        <Composer
                          key={`${project.id}:${thread.id}`}
                          project={project}
                          thread={thread}
                          action={action}
                          readAction={resourceAction}
                          onPanel={showPanel}
                          onNew={() => void newTask()}
                          onOpenTask={target => { updateSettingsOpen(false); setTaskScope(undefined); setTaskNotification(target); setTaskCenterOpen(true); }}
                        />
                      </div>
                    </>
                  ) : threadId ? (
                    <div className="settings-empty" role="status">
                      <p>{restoration?.failed ? "暂时无法加载对话，请重试或切换对话。" : "正在加载对话…"}</p>
                      {restoration?.failed && <Button variant="outline" size="sm" className="mt-3" onClick={() => void retryRestoration()}>重试加载对话</Button>}
                    </div>
                  ) : (
                    <>
                      <div className="draft-greeting">
                        <ConversationDraftEmptyState projectName={project ? library.projects?.[project.id]?.title || project.root.split("/").pop() : undefined} />
                      </div>
                      <div className="draft-composer">
                        <div className="composer-project-bar">
                          <div className="composer-project-leading">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <button className="composer-project" aria-label={project ? `在 ${library.projects?.[project.id]?.title || project.root.split("/").pop()} 中开始新聊天` : "不在项目中工作"}>
                                  {project ? <ProjectFolderIcon /> : <LeaveProjectIcon />}
                                  <span>
                                    {project
                                      ? library.projects?.[project.id]?.title || project.root.split("/").pop()
                                      : "不在项目中工作"}
                                  </span>
                                </button>
                              }
                            />
                            <DropdownMenuContent align="start" className="project-picker-menu">
                            {projects.filter(p => !p.projectless).map((p) => (
                              <DropdownMenuItem key={p.id} onClick={() => newTask(p.id)}>
                                <ProjectFolderIcon />
                                {library.projects?.[p.id]?.title || p.root.split("/").pop()}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem onClick={() => void choose()}>
                              <NewProjectIcon />
                              新建项目
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => leaveProject()}>
                              <LeaveProjectIcon />
                              不在项目中工作
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                          {project && <ComposerWorkspaceContext project={project} action={resourceAction} />}
                          </div>
                        {project && <WorktreeStarter key={project.id} project={project} action={resourceAction} onOpen={async id => { setSnapshot(await services.snapshot()); newTask(id); }} />}
                      </div>
                      {project ? (
                          <DraftComposer
                            key={project.id}
                            project={project}
                            action={action}
                            readAction={resourceAction}
                            onOpen={(pid, id) => open(pid, id, "replace")}
                            onPanel={showPanel}
                          />
                        ) : (
                          <ProjectlessDraft snapshot={snapshot} services={services} action={action} readAction={resourceAction} onPanel={showPanel} onOpen={(pid, id) => open(pid, id, "replace")} />
                        )}
                      </div>
                    </>
                  )}
                </section>
                {terminalOpen && thread && (
                  <section className="bottom-terminal">
                    <div className="panel-header">
                      <strong>终端</strong>
                      <button
                        className="icon-button"
                        aria-label="关闭面板"
                        onClick={() => setTerminalOpen(false)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <TerminalPane
                      key={`${project.id}:${threadId}`}
                      project={project}
                      thread={thread}
                      action={action}
                      onClosed={id => setPanelTabs(tabs => tabs.filter(tab => tab !== id))}
                      canStart={!admitting && !pending && !!project.state?.connected}
                      onError={setError}
                      onLink={onLink}
                    />
                  </section>
                )}
              </div>
            </div>
          )}
        </WorkSurface>
        {project && !settingsOpen && !taskCenterOpen && (
          <SidePane
            key={`${project.id}:${threadId}`}
            workspaceKey={project.root}
            ownerTaskId={threadId || null}
            active={panel}
            names={panelTabs}
            previewTabId={previewFileTab}
            onKeepTab={id => setPreviewFileTab(current => current === id ? undefined : current)}
            workspaceView={{ mode: workspaceView, title: empty ? "新对话" : currentTitle, onChange: setWorkspaceView, actions: taskActions,
              navigation: !sidebar ? <button className="icon-button" aria-label="展开侧栏" aria-expanded={false} aria-controls="areal-sidebar" onClick={() => setSidebar(true)}><SidebarToggleIcon /></button> : undefined }}
            dirtyFiles={Object.fromEntries(
              Object.entries(dirtyFiles)
                .filter(([key]) => key.startsWith(`${project.id}:`))
                .map(([key, value]) => [key.slice(project.id.length + 1), value]),
            )}
            canClose={async (names) => {
              const paths = names
                .filter((name) => name.startsWith("file:"))
                .map((name) => name.slice(5));
              if (!confirmCloseFiles(project.id, paths)) return false;
              try {
                for (const name of names.filter(isTerminalTab)) await closeTerminal(terminalOwner(project.id, threadId), name);
              } catch (cause) { setError((cause as Error).message); return false; }
              setDirtyFiles((current) => {
                const next = { ...current };
                for (const path of paths) delete next[`${project.id}:${path}`];
                return next;
              });
              return true;
            }}
            onSelect={(name) => {
              if (workspaceView !== "split") setWorkspaceView("panel");
              if (name === "文件") {
                showFiles();
                return;
              }
              if (name === "终端") { openTerminal(true); return; }
              if (isTerminalTab(name)) { selectTerminal(terminalOwner(project.id, threadId), name); setTerminalOpen(false); }
              if (name.startsWith("file:")) setRevealedFile(name.slice(5));
              setPanel(name);
            }}
            titleFor={name => name.startsWith("agent:") ? agentName(name.slice(6)) : isTerminalTab(name) ? terminalTitle(terminalOwner(project.id, threadId), name, project.root) : undefined}
            onChange={tabs => {
              setPanelTabs(tabs);
              setPreviewFileTab(current => current && tabs.includes(current) ? current : undefined);
            }}
            onHide={() => { setWorkspaceView("split"); setPanel(""); }}
            auxiliary={panel === "文件" ? workspaceFileTree : undefined}
            render={panelBody}
          />
        )}
      </main>
      {searchOpen && (
        <div
          className="dialog-backdrop search-backdrop"
          onClick={() => {
            setSearchOpen(false);
            setSearch("");
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="搜索任务"
            className="search-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="search">
              <Search size={18} />
              <input
                autoFocus
                aria-label="搜索任务"
                placeholder="搜索任务"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                className="icon-button"
                aria-label="关闭搜索"
                onClick={() => {
                  setSearchOpen(false);
                  setSearch("");
                }}
              >
                <X size={14} />
              </button>
            </div>
            <div className="search-results">
              {visibleRows.length ? (
                visibleRows.map((row) => (
                  <button
                    key={`${row.owner.id}:${row.summary.id}`}
                    onClick={() => {
                      setSearchOpen(false);
                      setSearch("");
                      void open(row.owner.id, row.summary.id);
                    }}
                  >
                    <i aria-hidden="true" className="size-4 shrink-0" />
                    <span>{row.title}</span>
                    <small>{row.owner.root.split("/").pop()}</small>
                  </button>
                ))
              ) : (
                <p>没有匹配的任务</p>
              )}
            </div>
          </section>
        </div>
      )}
      {rename && (
        <div className="dialog-backdrop">
          <form
            className="rename-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              void action("library", { ...rename, title: renameText })
                .then(() => setRename(null))
                .catch(() => {});
            }}
          >
            <h2>{rename.operation === "createSection" ? "新建分组" : "重命名"}</h2>
            <input
              autoFocus
              aria-label="名称"
              maxLength={200}
              required
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
            />
            <div className="utility-actions">
              <button type="button" onClick={() => setRename(null)}>
                取消
              </button>
              <button type="submit">保存</button>
            </div>
          </form>
        </div>
      )}
    </WorkbenchShell>
  );
}
