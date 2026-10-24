import { ExecutableSideChatPane } from "./ExecutableSideChatPane.js";
import { useSideChatTabs, isSideChatTab, sideResourceTab, parseSideResourceTab, type SideChatTab, type SideResourceBinding } from "./useSideChatTabs.js";
import { addConversationSelection, conversationSelectionScope, selectionLimitMessage, type ConversationSelectionReference } from "./conversationSelectionReference.js";
import { useConversationEscape } from "./useConversationEscape.js";
import { ComputerControlContext } from './ComputerControlEntry.js';
import { ComputerSettings } from './settings/ComputerSettings.js';
import { GenUiWorkspace } from "./GenUiWorkspace.js";
import startupIcon from "../../app/assets/icon-1024.png";
import { useI18n } from "./i18n/IntlProvider.js";
import { WorkspaceFileTree } from "./workspace-file-tree/WorkspaceFileTree.js";
import { WorkspaceFilePane, confirmCloseFiles, workspaceDocumentOwner } from "./WorkspaceFilePane.js";
import { GitPane } from "./GitPane.js";
import { PluginCenter } from "./settings/PluginCenter.js";
import type { ResourceDraftSeed } from "./settings/PluginSkillsPage.js";
import { readComposerSkills, type ComposerSkill } from "./ComposerSkills.js";
import { profileKey, resolveDraftProfile } from "./ProfileDetails.js";
import { useMcpAppsWorkspace, McpAppsHub, McpMentionsPicker } from "./McpAppsWorkspace.js";
import { McpAppEntrypoints, mcpAppEntrypoints, toolTitle } from "./settings/McpAppsSettings.js";
import { McpAppIcon } from "./McpAppIcon.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { UsageDashboard } from "./settings/UsageDashboard.js";
import { Home, Settings, TerminalSquare, Browser, FileTree, ScheduledIcon as CalendarClock, NavigationBackIcon as ArrowLeft, NavigationForwardIcon as ArrowRight, SearchIcon as Search, MoreOptionsIcon as MoreHorizontal } from "./interfaceIcons.js";
import { ReviewPanelIcon } from "./app-shell/panelIcons.js";
import { ModelTrajectoryPane } from "./ModelTrajectoryPane.js";
import { useAppearance, useApplicationPreferences } from "./settings/applicationPreferences.js";
import { ConversationStatusCard } from "./ConversationStatusCard.js";
import { SidePane } from "./app-shell/SidePane.js";
import { useBrowserWorkspace, browserTabId, browserPageId, isBrowserTab } from "./app-shell/useBrowserWorkspace.js";
import { Button } from "./components/ui/button.js";
import { ToastHost } from "./ToastHost.js";
import { BackendStatusNotice, type BackendStatusAction } from "./BackendStatusNotice.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
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
import { Cpu, Server, Smartphone, Database, Monitor, GitFork } from "lucide-react"; // 恢复 Inbox 入口时加回 Inbox as InboxIcon
import * as React from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DismissIcon as X } from "./interfaceIcons.js";
import { ComposerPlusIcon, LeaveProjectIcon, NewProjectIcon, ProjectFolderIcon, ProjectNewChatIcon, ProjectOpenFolderIcon, SidePanelIcon, SidebarToggleIcon, TaskSummaryIcon } from "./homeChromeIcons.js";
import { UpdateIndicator } from "./UpdateIndicator.js";
import { QuitProgressDialog } from "./QuitProgressDialog.js";
import { call, type PlatformServices, type Snapshot, type Data, type Action, type PreparedCreator, type QuitProgress } from "./services.js";
import { MemoTaskItem } from "./TaskListItem.js";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SidebarDragSurface, useSidebarDrag, type SidebarDragSource } from "./sidebarDrag.js";
import { Messages } from "./Messages.js";
import { ForkTargetDialog } from "./ForkTargetDialog.js";
import { ConversationDraftEmptyState } from "./ConversationDraftEmptyState.js";
import { NewTaskButtonGroup } from "./NewTaskButtonGroup.js";
import { ImageAnnotationPane } from "./ImageAnnotationViews.js";
import { imageAnnotation, imageAnnotationTitle, setImageAnnotationEditing, useImageAnnotationPending, type ImageAnnotationTarget } from "./imageAnnotations.js";
import { Composer, attachmentDrafts, sending, subscribeSending } from "./Composer.js";
import { isIndependentCreation, isTechnicalErrorMessage, recoveredOutcome, recoveryMessage, recoverySettings, sameRecoveryOwner, type RecoveryFailure, type RecoveryNotice, type RecoveryOwner } from "./recoveryPresentation.js";
import { DraftComposer } from "./DraftComposer.js";
import { ProjectlessDraft } from "./ProjectlessDraft.js";
import { WorktreesSettings } from "./settings/WorktreesSettings.js";
import { WorktreeActions } from "./WorktreeStatus.js";
import { WorktreeStarter, type WorktreeSelection } from "./WorktreeStarter.js";
import { ComposerWorkspaceContext } from "./ComposerWorkspaceContext.js";
import { Queue } from "./Queue.js";
import { browserAnnotationTitle } from "./browserAnnotations.js";
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
import { ExecutionsPane } from "./ExecutionsPane.js";
import { AgentHistoryPane } from "./AgentHistoryPane.js";
import { SideChatPane } from "./SideChatPane.js";
import { agentName, agentAssignment } from "./AgentIdentity.js";
import { WorkgroupsPane } from "./WorkgroupsPane.js";
import { ServiceStatusSettings } from "./settings/ServiceStatusSettings.js";
import { TrajectorySettings } from "./settings/TrajectorySettings.js";
import { useTrajectoryPolling } from "./settings/useTrajectoryPolling.js";
import type { TrajectoryStatus } from "@areal/workbench/desktop-contract";
import { CoreCapabilitiesSettings } from "./settings/CoreCapabilitiesSettings.js";
import { MobileSettings } from "./settings/MobileSettings.js";
const settingsNavigationGroups = [
  { id: "personal", label: "settings.navigation.personal", items: [
    { id: "常规", label: "settings.general.title", icon: <SettingsGeneralIcon /> },
    { id: "外观", label: "settings.appearance.title", icon: <SettingsAppearanceIcon /> },
    { id: "用量", label: "settings.usage.title", icon: <SettingsUsageIcon /> },
  ] },
  { id: "integrations", label: "settings.navigation.integrations", items: [
    { id: "插件", label: "settings.plugins.title", icon: <SettingsPluginIcon /> },
    { id: "浏览器", label: "settings.browser.title", icon: <SettingsBrowserIcon /> },
    { id: "电脑控制", label: "settings.computer.title", icon: <Monitor strokeWidth={1.5} /> },
  ] },
  { id: "coding", label: "settings.navigation.coding", items: [
    { id: "Worktrees", label: "settings.worktrees.title", icon: <GitFork strokeWidth={1.5} /> },
    { id: "钩子", label: "settings.hooks.title", icon: <SettingsHooksIcon /> },
    { id: "模型服务", label: "settings.models.title", icon: <Cpu strokeWidth={1.5} /> },
    { id: "会话配置", label: "settings.session.title", icon: <SettingsConfigurationIcon /> },
    { id: "后台服务", label: "settings.service.title", icon: <Server strokeWidth={1.5} /> },
    { id: "数据飞轮", label: "settings.trajectory.title", icon: <Database strokeWidth={1.5} /> },
    { id: "手机连接", label: "settings.mobile.title", icon: <Smartphone strokeWidth={1.5} /> },
  ] },
] as const satisfies readonly SettingsNavigationGroup[];
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
  ["旁路讨论", null],
  ["队列", null],
  ["执行计划", null],
  ["上下文", null],
  ["已保存授权", null],
  ["Skills", null],
  ["MCP", null],
  ["用量", <SettingsUsageIcon />],
  ["设置", <Settings size={16} />],
] as const;
function projectExecutionBlocked(lifecycle: Snapshot["lifecycle"], projectId: string): boolean {
  return lifecycle?.operations.some(operation =>
    operation.phase !== "completed" && operation.phase !== "blocked"
    && operation.targets.some(target => target.projectId === projectId && target.phase !== "completed" && target.phase !== "blocked"),
  ) ?? false;
}
type InitialLocation = { kind: "automatic" | "projectless" } | { kind: "project"; projectId: string; threadId: string };
type PluginTaskOrigin = { projectId: string; threadId: string };
type RestorationOwner = RecoveryOwner;
type RestorationState = RestorationOwner & { pending: boolean; error: string; failureId?: string; failure?: RecoveryFailure };
type RestorationAttempt = RestorationOwner & { operation: "connect" | "open"; pending: boolean; promise: Promise<void> };
const sameRestorationOwner = sameRecoveryOwner;
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

function TaskResourcesPopover({ project, thread, action, onPanel, onAgent, onFile, scheduledTask, runHistory, revealKey, onReveal, onAddSchedule, onOpenSchedule, onReadAgents, onAddSource, onLink }: {
  onAddSource?: () => void; onLink?: (url: string) => void; onReadAgents?: (restore: () => void) => void; project: Data; thread: Data; action: Action; scheduledTask?: Data; runHistory?: React.ReactNode; revealKey?: string; onReveal?: (key: string) => void;
  onPanel: (name: string) => void; onAgent: (id: string) => void; onFile: (path: string) => void; onAddSchedule?: () => void; onOpenSchedule?: (task: Data) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  useEffect(() => { if (revealKey) { setOpen(true); onReveal?.(revealKey); } }, [revealKey, onReveal]);
  const navigate = <T,>(callback: (value: T) => void) => (value: T) => { setOpen(false); callback(value); };
  return <Popover open={open} onOpenChange={(next, details) => {
    if (!next && ["outside-press", "focus-out"].includes(details.reason)) return;
    setOpen(next);
  }}>
    <PopoverTrigger render={<button ref={trigger} className={`icon-button ${open ? "active" : ""}`} aria-label="任务资源" />}><TaskSummaryIcon /></PopoverTrigger>
    <PopoverContent keepMounted finalFocus={trigger} align="end" sideOffset={8} className="task-resources-popup" aria-label="任务资源面板">
      <React.Activity mode={open ? "visible" : "hidden"}>
      <ConversationStatusCard onLink={onLink} onAddSource={onAddSource ? () => { setOpen(false); onAddSource(); } : undefined} project={project} thread={thread} action={action} scheduledTask={scheduledTask} runHistory={runHistory} onAddSchedule={onAddSchedule ? () => { setOpen(false); onAddSchedule(); } : undefined} onOpenSchedule={onOpenSchedule ? navigate(onOpenSchedule) : undefined}
        onAgents={() => { setOpen(false); if (onReadAgents) onReadAgents(() => setOpen(true)); else onPanel("子代理"); }}
        onPanel={navigate(onPanel)} onAgent={navigate(onAgent)} onFile={navigate(onFile)} />
      </React.Activity>
    </PopoverContent>
  </Popover>;
}
export function App({ services }: { services: PlatformServices }) {
  const [quitProgress, setQuitProgress] = useState<QuitProgress>({ state: "idle" });
  useEffect(() => services.onQuitProgress?.(setQuitProgress), [services]);
  return <UnsavedChangesProvider><GenUiWorkspace services={services}><AppContent services={services} /></GenUiWorkspace><QuitProgressDialog progress={quitProgress} /></UnsavedChangesProvider>;
}
function AppContent({ services }: { services: PlatformServices }) {
  const { t } = useI18n();
  const settingsLabel = (name: string) => {
    const id = ["Skills", "MCP"].includes(name) ? "插件" : name;
    const item = settingsNavigationGroups.flatMap(group => group.items.map(item => ({ id: item.id, label: item.label }))).find(item => item.id === id);
    return item ? t(item.label) : name;
  };
  const requestNavigation = useGuardedNavigation();
  useEffect(() => services.onQuitRequested?.(() => requestNavigation(() => {})), [services, requestNavigation]);
  const { terminalLocation, nextPromptSuggestions } = useApplicationPreferences();
  const [snapshot, updateSnapshot] = useState<Snapshot>({ projects: [], connection: { state: "connecting" } });
  const [worktreeSettingsTarget, setWorktreeSettingsTarget] = useState<{ projectId?: string; tab: "general" | "environments" }>({ tab: "general" });
  const [worktreeSelections, setWorktreeSelections] = useState<Record<string, WorktreeSelection | undefined>>({});
  const backendActionInFlight = React.useRef(false);
  const [backendActionPending, setBackendActionPending] = useState(false);
  const [backendActionError, setBackendActionError] = useState("");
  useEffect(() => { setBackendActionError(""); }, [snapshot.connection?.state, snapshot.connection?.message,
    snapshot.connection?.recovery, snapshot.backendUpdate?.state, snapshot.backendUpdate?.message,
    snapshot.desktopCapabilities?.currentCommands, snapshot.lifecycle?.phase, snapshot.lifecycle?.message]);
  const [themeReady, setThemeReady] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [initialPresentation, setInitialPresentation] = useState<"pending" | "failed" | "ready">("pending");
  const initialReleased = initialPresentation === "ready";
  const [startupDelayed, setStartupDelayed] = useState(false);
  const [trajectoryAttention, setTrajectoryAttention] = useState(false);
  const [restoration, setRestoration] = useState<RestorationState>();
  const restorationAttempt = React.useRef<RestorationAttempt | undefined>(undefined);
  const [selectedProject, setSelectedProject] = useState<string>();
  useEffect(() => () => { restorationAttempt.current = undefined; }, []);
  // 初始 IPC 读回可能晚于订阅事件；只接受本 GUI 连接中更新的投影。
  const setSnapshot = useCallback((next: Snapshot) => updateSnapshot(previous =>
    next.revision !== undefined && previous.revision !== undefined && next.revision < previous.revision ? previous : next
  ), []);
  const [initialLocation] = useState<InitialLocation>(() => {
    const saved = localStorage.getItem("areal-gui:project");
    return saved === null ? { kind: "automatic" } : saved === "" ? { kind: "projectless" }
      : { kind: "project", projectId: saved, threadId: localStorage.getItem(`areal-gui:thread:${saved}`) ?? "" };
  });
  const [projectId, setProjectId] = useState(initialLocation.kind === "project" ? initialLocation.projectId : "");
  const [noProject, setNoProject] = useState(initialLocation.kind === "projectless");
  const [threadId, setThreadId] = useState(initialLocation.kind === "project" ? initialLocation.threadId : "");
  // Window-local locations, never Core execution or a persisted recovery log.
  const [workspaceHistory, setWorkspaceHistory] = useState<{ entries: { projectId: string; threadId: string }[]; index: number }>({ entries: [], index: -1 });
  const mcpPendingReveal = React.useRef<{tab:string;owner:string}|null>(null);
  const [panel, setPanel] = useState("");
  const [annotationTarget, setAnnotationTarget] = useState<(ImageAnnotationTarget & { owner: string; previousView: "split" | "panel" | "conversation"; previousPanel: string; sessionId: string }) | null>(null);
  const annotationPending = useImageAnnotationPending(annotationTarget?.file);
  const [reviewRequest, setReviewRequest] = useState<{ owner: string; threadId?: string } & ({ turnId: string; scope?: never } | { scope: "unstaged"; turnId?: never })>();
  const [panelTabs, setPanelTabs] = useState<string[]>([]);
  const [previewFileTab, setPreviewFileTab] = useState<string | undefined>();
  const sideNarrow = React.useRef(false);
  const contextReturn = React.useRef<(() => void) | null>(null);
  const panelReturnTarget = React.useRef<{ element: HTMLElement; route: string } | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"split" | "panel" | "conversation">("split");
  const [filesOpen, setFilesOpen] = useState(false);
  const [revealedFile, setRevealedFile] = useState("");
  const panelViews = React.useRef(new Map<string, { panel: string; lastPanel?: string; tabs: string[]; previewFileTab?: string; filesOpen: boolean; revealedFile: string }>());
  const activePanelOwner = React.useRef("");
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (panel && panel !== "功能" && panel !== "预览")
      setPanelTabs((tabs) => (tabs.includes(panel) ? tabs : [...tabs, panel]));
  }, [panel]);
  const [settingsTab, updateSettingsTab] = useState("常规");
  const setSettingsTab = (next: string) => { if (next !== settingsTab) requestNavigation(() => updateSettingsTab(next)); };
  const [taskSurface, setTaskSurface] = useState<"tasks" | "inbox" | null>(null);
  const taskCenterOpen = taskSurface !== null;
  const setTaskCenterOpen = (open: boolean) => setTaskSurface(open ? "tasks" : null);
  const [taskScope, setTaskScope] = useState<string>();
  const [taskNotification, setTaskNotification] = useState<{ projectId: string; taskId: string; runId?: string; questionId?: string; eventId?: string } | undefined>();
  const consumedResourceReveal = React.useRef<string | undefined>(undefined);
  const consumeResourceReveal = useCallback((key: string) => { consumedResourceReveal.current = key; }, []);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginTaskOrigin, setPluginTaskOrigin] = useState<PluginTaskOrigin | null>(null);
  const pluginTaskFocus = React.useRef<PluginTaskOrigin | null>(null);
  const [pluginMarketRequest, setPluginMarketRequest] = useState(0);
  const [settingsOpen, updateSettingsOpen] = useState(false);
  const rememberPluginTask = () => {
    if (!pluginsOpen && !settingsOpen) {
      setPluginTaskOrigin(!taskCenterOpen && projectId && threadId ? { projectId, threadId } : null);
      pluginTaskFocus.current = null;
    }
  };
  const settingsTrigger = React.useRef<{ element: HTMLElement; route: string } | null>(null);
  const setSettingsOpen = (open: boolean) => {
    if (open) {
      rememberPluginTask();
      if (!settingsOpen && document.activeElement instanceof HTMLElement)
        settingsTrigger.current = { element: document.activeElement, route: `${projectId}:${threadId}` };
      setPluginsOpen(false); setTaskCenterOpen(false); updateSettingsOpen(true);
    } else requestNavigation(() => updateSettingsOpen(false));
  };
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
  const [notices, setNotices] = useState<RecoveryNotice[]>([]);
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(() => new Set());
  const selectedRecoveryOwner = React.useRef<RecoveryOwner>({ projectId: "", threadId: "", connectionGeneration: 0 });
  const recoverySnapshot = React.useRef(snapshot);
  recoverySnapshot.current = snapshot;
  const setError = useCallback((message: string) => {
    if (message) setNotices(previous => [...previous, { ...selectedRecoveryOwner.current, id: crypto.randomUUID(), kind: "error", message: isTechnicalErrorMessage(message) ? t("recovery.operationFailed") : message, detail: isTechnicalErrorMessage(message) ? message : undefined }]);
  }, [t]);
  const dismissNotice = (id: string) => setDismissedNotices(previous => new Set(previous).add(id));
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
      const trigger = settingsTrigger.current;
      if (!settingsOpen && trigger?.route === `${projectId}:${threadId}`) {
        // Settings replaces the chat subtree, so resolve a remounted composer
        // only within the same conversation. Never focus a previous task.
        const target = trigger.element.isConnected ? trigger.element
          : trigger.element.matches('[data-testid="chat-input"]')
            ? document.querySelector<HTMLElement>('[data-testid="chat-input"]') : null;
        if (target) { target.focus({ preventScroll: true }); return; }
      }
      const selector = settingsOpen
        ? '[aria-label="设置导航"] [aria-current="page"]'
        : '[aria-label="设置"], [aria-label="展开侧栏"]';
      document.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
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
  const [rename, setRename] = useState<Data | null>(null);
  const [forkIntent, setForkIntent] = useState<{ projectId: string; sourceThreadId: string; turnId: string; route: string; anchor?: HTMLElement; resolve: () => void } | null>(null);
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
  const logicalProject = noProject ? undefined : snapshot.projects.find((p) => p.id === projectId)
    ?? (snapshot.connection?.state === "ready" ? projects.find(p => !p.projectless) : undefined);
  const executionThread = logicalProject?.state?.threads[threadId];
  const project = logicalProject && executionThread?.worktree?.directory ? {
    ...logicalProject, logicalRoot: logicalProject.root, root: executionThread.worktree.directory,
    core: { ...logicalProject.core, ...executionThread.executionCore },
    state: { ...logicalProject.state, connected: executionThread.executionConnected ?? logicalProject.state?.connected },
    error: executionThread.executionError ?? logicalProject.error,
  } : logicalProject;
  const thread = project?.state?.threads[threadId];
  const worktreeSelection = project ? worktreeSelections[project.id] : undefined;
  const changeWorktreeSelection = (pid: string, value: WorktreeSelection | undefined) => {
    setWorktreeSelections(previous => ({ ...previous, [pid]: value }));
  };
  const restorationOwner: RestorationOwner = { projectId: project?.id ?? "", threadId,
    connectionGeneration: project?.core?.connectionGeneration ?? 0 };
  const selectedRestoration = React.useRef(restorationOwner);
  selectedRestoration.current = restorationOwner;
  selectedRecoveryOwner.current = restorationOwner;
  const selectionReady = selectedProject === (project?.id ?? "");
  const currentRestoration = sameRestorationOwner(restoration, restorationOwner) ? restoration : undefined;
  const observationFailure = project?.observationErrors?.[threadId];
  const currentObservationFailure = observationFailure && (observationFailure.connectionGeneration === undefined
    || observationFailure.connectionGeneration === restorationOwner.connectionGeneration) ? observationFailure : undefined;
  const viewFailure = currentObservationFailure ?? (threadId ? currentRestoration?.failure : undefined);
  const restorationError = viewFailure ? recoveryMessage(viewFailure, "view") : threadId ? currentRestoration?.error || "" : "";
  const reconnectingView = snapshot.connection?.state === "connecting" && !!viewFailure
    && viewFailure.recovery?.kind !== "needsUser" && !recoverySettings(viewFailure)
    && !["HISTORY_BUDGET_TOO_SMALL", "RESPONSE_TOO_LARGE"].includes(String(viewFailure.code))
    && (viewFailure.recovery?.kind === "retryRead"
      || ["DISCONNECTED", "CONNECTION_LOST", "TIMEOUT", "RESPONSE_UNKNOWN", "TRANSPORT_FAILURE"].includes(String(viewFailure.code))
      || !viewFailure.code && /连接中断|已断开|正在恢复|disconnect|timeout|connection|transport/i.test(viewFailure.message));
  const [viewRecoveryVisible, setViewRecoveryVisible] = useState(false);
  useEffect(() => {
    setViewRecoveryVisible(false);
    if (!reconnectingView) return;
    const timer = window.setTimeout(() => setViewRecoveryVisible(true), 1200);
    return () => window.clearTimeout(timer);
  }, [reconnectingView, restorationOwner.projectId, restorationOwner.threadId, restorationOwner.connectionGeneration]);
  const viewRefreshing = !!currentObservationFailure?.refreshPending || !!currentRestoration?.pending;
  const restorationFailed = !!restorationError && !viewRefreshing && !reconnectingView;
  const restorationNoticeId = currentObservationFailure?.id ?? currentRestoration?.failureId
    ?? `connection:${restorationOwner.projectId}:${restorationOwner.connectionGeneration}:${restorationError}`;
  useEffect(() => {
    setNotices(previous => {
      let changed = false;
      const observed = [...previous];
      for (const owner of snapshot.projects) for (const entry of owner.pending ?? []) {
        const requestId = entry.params?.requestId;
        const ownerThreadId = entry.params?.threadId ?? entry.params?.sourceThreadId ?? "";
        if (!requestId || entry.awaitingResponse || observed.some(notice => notice.projectId === owner.id && notice.requestId === requestId)
          || recoveredOutcome(owner, requestId, ownerThreadId, entry.operation)) continue;
        changed = true;
        observed.push({ projectId: owner.id, threadId: ownerThreadId,
          connectionGeneration: owner.core?.connectionGeneration ?? 0, id: `operation:${owner.id}:${requestId}`,
          kind: "unconfirmed", requestId, operation: entry.operation,
          message: "操作结果尚未确认。正在核对原请求，不会自动重发。" });
      }
      const next = observed.flatMap(notice => {
        if (notice.kind !== "unconfirmed" || !notice.requestId) return [notice];
        const owner = snapshot.projects.find(item => item.id === notice.projectId);
        const operation = notice.operation ?? owner?.pending?.find((entry: Data) => entry.params?.requestId === notice.requestId)?.operation;
        const outcome = owner && recoveredOutcome(owner, notice.requestId, notice.threadId, operation);
        if (!outcome) {
          if (operation && !notice.operation) { changed = true; return [{ ...notice, operation }]; }
          return [notice];
        }
        changed = true;
        return outcome.status === "failed" || outcome.accepted === false
          ? [{ ...notice, id: `failed:${notice.id}`, kind: "error" as const, message: outcome.message || (outcome.accepted === false ? "操作未受理，输入已保留，请检查后重试。" : "操作已受理，但执行失败，请检查结果。") }]
          : [];
      });
      return changed ? next : previous;
    });
  }, [snapshot.projects, notices]);
  const operationNotices = notices.filter(notice => notice.projectId === restorationOwner.projectId
    && notice.threadId === restorationOwner.threadId && !dismissedNotices.has(notice.id));
  const activeConversation = React.useRef("");
  activeConversation.current = `${project?.id ?? ""}:${thread?.id ?? ""}`;
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
  const browserWorkspace = useBrowserWorkspace(services, project?.id ?? "", threadId, browserPageId(panel));
  const rememberPanelTrigger = useCallback(() => {
    const focused = document.activeElement;
    const element = focused?.getAttribute("role") === "menuitem"
      ? document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]') ?? focused : focused;
    if (element instanceof HTMLElement && !element.closest(".side-panel")) panelReturnTarget.current = { element, route: `${projectId}:${threadId}` };
  }, [projectId, threadId]);
  const openingBrowser = React.useRef<string | null>(null);
  const openBrowser = useCallback(async (create = false, url?: string) => {
    if (!project) return;
    const owner = `${project.id}:${threadId}`;
    if (openingBrowser.current === owner) return;
    openingBrowser.current = owner;
    if (!isBrowserTab(panel)) rememberPanelTrigger();
    try {
      let value = await browserWorkspace.request("state");
      if (previewOwner.current !== owner) return;
      if (create || !value.workspace?.selectedPageId) value = await browserWorkspace.request("newPage");
      if (previewOwner.current !== owner) return;
      const pageId = value.browser?.pageId;
      if (!pageId) return;
      if (url) await browserWorkspace.request("navigate", { pageId, url });
      if (previewOwner.current !== owner) return;
      await browserWorkspace.request("selectPage", { pageId });
      if (previewOwner.current !== owner) return;
      setWorkspaceView(mode => mode === "split" ? mode : "panel");
      setPanel(browserTabId(pageId));
    } catch (cause) { if (previewOwner.current === owner) setError((cause as Error).message); }
    finally { if (openingBrowser.current === owner) openingBrowser.current = null; }
  }, [project?.id, threadId, browserWorkspace.request, panel, rememberPanelTrigger]);
  useEffect(() => services.onPreviewEvent?.(event => {
    // 仅呈现当前聊天已由 Core 批准的页面，不切换后台聊天或重放导航。
    if (event.kind !== 'reveal' || previewOwner.current !== `${event.projectId}:${event.threadId}`) return;
    setWorkspaceView('split');
    setPanel(browserTabId(event.pageId));
  }), [services]);
  const terminalState = useTerminalWorkspace(terminalOwner(project?.id ?? "", threadId));
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  useEffect(() => { contextReturn.current = null; }, [panelOwner]);
  const annotationVisible = annotationTarget?.owner === panelOwner;
  const openImageAnnotation = (target: ImageAnnotationTarget) => {
    setAnnotationTarget({ ...target, owner: panelOwner, previousView: workspaceView, previousPanel: panel, sessionId: crypto.randomUUID() });
    setWorkspaceView("split");
  };
  const finishImageAnnotation = () => {
    if (!annotationTarget) return;
    const pending = imageAnnotation(annotationTarget.file)?.pending;
    if (pending && pending.kind !== "idle") return;
    setAnnotationTarget(null);
    setWorkspaceView(annotationTarget.previousView);
    requestAnimationFrame(annotationTarget.returnFocus);
  };
  React.useLayoutEffect(() => {
    if (!annotationTarget) return;
    if (annotationTarget.owner !== panelOwner || annotationTarget.previousPanel !== panel) { setAnnotationTarget(null); return; }
    setImageAnnotationEditing(annotationTarget.draftKey, true);
    return () => setImageAnnotationEditing(annotationTarget.draftKey, false);
  }, [annotationTarget, panelOwner, panel]);
  useEffect(() => {
    if (!annotationTarget) return;
    const refresh = () => {
      if (attachmentDrafts.get(annotationTarget.draftKey)?.includes(annotationTarget.file)) return;
      setAnnotationTarget(null);
      if (annotationTarget.owner === panelOwner) setWorkspaceView(annotationTarget.previousView);
    };
    window.addEventListener("areal-attachments-change", refresh);
    window.addEventListener("areal-draft-change", refresh);
    return () => { window.removeEventListener("areal-attachments-change", refresh); window.removeEventListener("areal-draft-change", refresh); };
  }, [annotationTarget, panelOwner]);
  React.useLayoutEffect(() => {
    if (activePanelOwner.current !== panelOwner) {
      activePanelOwner.current = panelOwner;
      setWorkspaceView("split");
      const remembered = panelViews.current.get(panelOwner);
      const appReveal = mcpPendingReveal.current?.owner === panelOwner ? mcpPendingReveal.current.tab : null;
      if(appReveal)mcpPendingReveal.current=null;
      // Only the terminal owner can supply live IDs; the view cache owns no PTY.
      setPanelTabs([...new Set([...(remembered?.tabs.filter(id => id !== "任务资源" && !isTerminalTab(id)) ?? []), ...terminalState.ids, ...(appReveal?[appReveal]:[])])]);
      setPanel(appReveal ?? (remembered && remembered.panel !== "任务资源" && (!isTerminalTab(remembered.panel) || terminalState.ids.includes(remembered.panel)) ? remembered.panel : ""));
      setFilesOpen(remembered?.filesOpen ?? false);
      setRevealedFile(remembered?.revealedFile ?? "");
      setPreviewFileTab(remembered?.previewFileTab);
      return;
    }
    panelViews.current.set(panelOwner, { panel, lastPanel: panel || panelViews.current.get(panelOwner)?.lastPanel, tabs: panelTabs, previewFileTab, filesOpen, revealedFile });
  }, [panelOwner, panel, panelTabs, previewFileTab, filesOpen, revealedFile, terminalState.ids]);
  useEffect(() => {
    if (!browserWorkspace.workspace || activePanelOwner.current !== panelOwner) return;
    const ids = browserWorkspace.pages.map(page => browserTabId(page.pageId));
    setPanelTabs(tabs => {
      const next = [...tabs.filter(id => id !== "预览" && (!isBrowserTab(id) || ids.includes(id))), ...ids.filter(id => !tabs.includes(id))];
      return next.length === tabs.length && next.every((id, index) => id === tabs[index]) ? tabs : next;
    });
    // A removed/closed native page must never keep a stale UI tab alive.
    setPanel(current => {
      if (!isBrowserTab(current)) return current;
      const selected = browserWorkspace.workspace.selectedPageId;
      // Native popups and other Main-side selection changes share the same strip.
      if (selected && ids.includes(browserTabId(selected))) return browserTabId(selected);
      return ids.includes(current) ? current : "功能";
    });
  }, [browserWorkspace.workspace, panelOwner]);
  useEffect(() => {
    setPanelTabs(tabs => [...tabs.filter(id => !isTerminalTab(id) || terminalState.ids.includes(id)), ...terminalState.ids.filter(id => !tabs.includes(id))]);
  }, [terminalState.ids]);
  const action: Action = useCallback(
    async (name: import("./services.js").CommandName, params: Data = {}) => {
      const selected = selectedRecoveryOwner.current;
      const target = recoverySnapshot.current.projects.find(item => item.id === (params.projectId ?? selected.projectId));
      const owner = { projectId: params.projectId ?? selected.projectId, threadId: params.threadId ?? selected.threadId,
        connectionGeneration: target?.core?.connectionGeneration ?? selected.connectionGeneration };
      const scoped = name === "workspace" && threadId && params.projectId === project?.id
        && !params.threadId && !String(params.operation).startsWith("worktree") ? { ...params, threadId } : params;
      const request = ["create", "configure"].includes(name) ? { ...scoped, requestId: params.requestId ?? crypto.randomUUID() } : scoped;
      try {
        return await call(services, name, request);
      } catch (cause) {
        const failure = cause as RecoveryFailure;
        // Composer owns confirmed send refusals and clears them on acceptance.
        // Unconfirmed/admitted sends still keep their global recovery notice.
        const composerRefusal = name === "send" && failure.outcome?.kind === "rejected";
        if (!composerRefusal && !["providers", "chatgpt", "prediction"].includes(name) && !(name === "respond" && params.answers)
          && name !== "media" && name !== "feedback" && !(name === "manage" && params.operation === "goalCreate")) {
          const operation = failure.outcome && "operation" in failure.outcome ? failure.outcome.operation : undefined;
          const requestId = operation?.requestId ?? failure.requestId ?? request.requestId;
          const unconfirmed = failure.submissionUnknown === true || failure.outcome?.kind === "admitted" || failure.outcome?.kind === "unconfirmed";
          const id = unconfirmed && requestId ? `operation:${owner.projectId}:${requestId}` : crypto.randomUUID();
          const latest = recoverySnapshot.current.projects.find(item => item.id === owner.projectId);
          if ((latest?.core?.connectionGeneration ?? owner.connectionGeneration) === owner.connectionGeneration) {
            const pendingOperation = latest?.pending?.find((entry: Data) => entry.params?.requestId === requestId)?.operation;
            setNotices(previous => [...previous.filter(notice => notice.id !== id), { ...owner, id, requestId, operation: operation ?? pendingOperation,
              kind: unconfirmed ? "unconfirmed" : "error", message: recoveryMessage(failure), settings: recoverySettings(failure),
              detail: [failure.message, failure.code, failure.reason, operation?.method].filter(value => value !== undefined).join("\n") }]);
          }
        }
        throw cause;
      }
    },
    [services, project?.id, threadId],
  );
  const cancelledPredictions = React.useRef(new Set<string>());
  useEffect(() => {
    if (nextPromptSuggestions) { cancelledPredictions.current.clear(); return; }
    const pending = new Set<string>();
    for (const project of snapshot.projects) {
      if (!project.state?.connected || !project.core?.features?.promptPrediction) continue;
      for (const thread of Object.values(project.state.threads ?? {}) as Data[]) {
        const slot = thread.desktop?.promptPrediction;
        if (slot?.status !== "pending") continue;
        const key = `${project.core?.instanceId}:${project.id}:${thread.id}:${slot.sourceTurnId}`;
        pending.add(key);
        if (cancelledPredictions.current.has(key)) continue;
        cancelledPredictions.current.add(key);
        void action("prediction", { projectId: project.id, threadId: thread.id, sourceTurnId: slot.sourceTurnId, operation: "cancel" }).catch(() => {});
      }
    }
    for (const key of cancelledPredictions.current) if (!pending.has(key)) cancelledPredictions.current.delete(key);
  }, [nextPromptSuggestions, snapshot.projects, action]);
  // Resource pages own their loading, validation and recovery feedback.
  const resourceAction: Action = useCallback(
    (name: import("./services.js").CommandName, params: Data = {}) => {
      return call(services, name, name === "workspace" && threadId && params.projectId === project?.id
        && !params.threadId && !String(params.operation).startsWith("worktree") ? { ...params, threadId } : params);
    },
    [services, project?.id, threadId],
  );
  const contextualFileOpen = useMemo<PlatformServices["fileOpen"]>(() => services.fileOpen ? request => {
    return services.fileOpen!("projectId" in request && request.projectId === project?.id && threadId
      ? { ...request, threadId } : request);
  } : undefined, [services.fileOpen, project?.id, threadId]);
  const sideChats = useSideChatTabs(resourceAction);
  const sideSource = React.useRef({ owner: panelOwner, instanceId: project?.core?.instanceId });
  sideSource.current = { owner: panelOwner, instanceId: project?.core?.instanceId };
  const mainPane = React.useRef<HTMLElement>(null);
  const sideResourceBindings = React.useRef(new Map<string, SideResourceBinding>());
  useConversationEscape({ pane: mainPane, project, thread, action, onError: setError,
    enabled: initialReleased && !settingsOpen && !taskCenterOpen && !pluginsOpen && workspaceView !== "panel"
      && !!project?.state?.connected && !projectExecutionBlocked(snapshot.lifecycle, project?.id ?? ""),
    outsideFallback: !annotationVisible && (!panel || workspaceView === "conversation") });
  const canCreateSide = !!project && !!thread && project.core?.features?.sideExecutableV2 === true
    && !!project.state?.connected && !thread.desktop?.archived && !thread.parentThreadId && thread.conversation?.kind !== "side"
    && !project.configurations?.[thread.id]?.options?.appendInstructions?.startsWith("AREAL_TASK_DRAFT_V1\n")
    && !matchMedia("(max-width: 640px)").matches;
  const revealSide = (tab: SideChatTab) => {
    if (!sideChats.hasChild(tab.projectId, tab.childId)) return;
    const owner = `${tab.projectId}:${tab.parentId}`;
    if (activePanelOwner.current !== owner) {
      const view = panelViews.current.get(owner);
      panelViews.current.set(owner, { panel: tab.id, lastPanel: tab.id, tabs: [...new Set([...(view?.tabs ?? []), tab.id])], filesOpen: view?.filesOpen ?? false, revealedFile: view?.revealedFile ?? "", previewFileTab: view?.previewFileTab });
      return;
    }
    setWorkspaceView(matchMedia("(max-width: 1200px)").matches ? "panel" : "split");
    setPanelTabs(tabs => tabs.includes(tab.id) ? tabs : [...tabs, tab.id]);
    setPanel(tab.id);
  };
  const openSideResource = (tab: SideChatTab, resource: string) => {
    if (!sideChats.hasChild(tab.projectId, tab.childId)) return;
    const owner = `${tab.projectId}:${tab.parentId}`;
    const id = sideResourceTab(tab.childId, resource);
    if (activePanelOwner.current !== owner) {
      const view = panelViews.current.get(owner);
      if (view) panelViews.current.set(owner, { ...view, tabs: [...new Set([...view.tabs, id])] });
      return;
    }
    setPanelTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]); setPanel(id);
  };
  const removeSideResource = (tab: SideChatTab, resource: string) => {
    const owner = `${tab.projectId}:${tab.parentId}`;
    const id = sideResourceTab(tab.childId, resource);
    const view = panelViews.current.get(owner);
    if (view) panelViews.current.set(owner, { ...view, tabs: view.tabs.filter(name => name !== id), panel: view.panel === id ? tab.id : view.panel });
    if (activePanelOwner.current === owner) {
      setPanelTabs(tabs => tabs.filter(name => name !== id));
      setPanel(current => current === id ? tab.id : current);
    }
  };
  const createSide = async (text = "") => {
    if (!canCreateSide || !project || !thread) throw new Error(t("chat.side.unavailable"));
    rememberPanelTrigger();
    const tab = await sideChats.create(project.id, thread.id, text);
    revealSide(tab);
    return tab;
  };
  const newSide = () => { void createSide().catch(cause => setError(cause.message)); };
  const removeSideTab = (tab: SideChatTab) => {
    sideChats.forget(tab);
    const owner = `${tab.projectId}:${tab.parentId}`;
    const view = panelViews.current.get(owner);
    if (view) panelViews.current.set(owner, { ...view, tabs: view.tabs.filter(id => id !== tab.id && parseSideResourceTab(id)?.childId !== tab.childId), panel: view.panel === tab.id || parseSideResourceTab(view.panel)?.childId === tab.childId ? "功能" : view.panel });
    if (activePanelOwner.current === owner) {
      setPanelTabs(tabs => tabs.filter(id => id !== tab.id && parseSideResourceTab(id)?.childId !== tab.childId));
      setPanel(current => current === tab.id || parseSideResourceTab(current)?.childId === tab.childId ? "功能" : current);
    }
  };
  useEffect(() => {
    for (const tab of sideChats.tabs) {
      const owner = snapshot.projects.find(project => project.id === tab.projectId);
      const observed = owner?.state?.threads?.[tab.childId];
      if (observed?.conversation?.policy?.kind === "sideExecutableV2" && observed.desktop?.archived
        && Object.values<Data>(owner?.outcomes ?? {}).some((outcome) => outcome.method === "areal/side/close"
          && outcome.threadId === tab.childId && outcome.accepted === true && outcome.cleanupConfirmed === true))
        removeSideTab(tab);
    }
  }, [snapshot.projects, sideChats.tabs]);
  const restoreConversation = useCallback((owner: RestorationOwner, operation: "connect" | "open", options: { connectService?: boolean } = {}) => {
    const previous = restorationAttempt.current;
    if (sameRestorationOwner(previous, owner) && previous?.operation === operation && previous.pending) return previous.promise;
    const attempt: RestorationAttempt = { ...owner, operation, pending: true, promise: Promise.resolve() };
    restorationAttempt.current = attempt;
    setRestoration(previous => sameRestorationOwner(previous, owner) && previous
      ? { ...previous, pending: true } : { ...owner, pending: true, error: "" });
    const current = () => restorationAttempt.current === attempt && sameRestorationOwner(selectedRestoration.current, owner);
    attempt.promise = (async () => {
      try {
        if (options.connectService) {
          await resourceAction("connectService");
          if (!current()) return;
        }
        if (operation === "connect") await resourceAction("connect", { projectId: owner.projectId });
        else if (owner.threadId) {
          await resourceAction("open", { projectId: owner.projectId, threadId: owner.threadId });
          if (!current()) return;
          void resourceAction("library", { operation: "readThread", projectId: owner.projectId, threadId: owner.threadId, read: true }).catch(() => {});
        }
        if (current()) setRestoration({ ...owner, pending: false, error: "" });
      } catch (cause) {
        if (current()) {
          const failure = cause as RecoveryFailure;
          setRestoration({ ...owner, pending: false, error: recoveryMessage(failure, "view"), failure, failureId: crypto.randomUUID() });
        }
      } finally {
        attempt.pending = false;
      }
    })();
    return attempt.promise;
  }, [resourceAction]);
  const onTrajectoryStatus = useCallback((status: TrajectoryStatus | null) => {
    setTrajectoryAttention(!status || status.state === "degraded" || status.state === "invalid");
  }, []);
  // 状态只更新设置入口，不阻塞启动、不反复弹窗，也不进入聊天错误栏。
  useTrajectoryPolling(resourceAction, {
    connected: snapshot.connection?.state === "ready",
    intervalMs: 15000,
    onResult: onTrajectoryStatus,
    onError: () => onTrajectoryStatus(null),
  });
  const readTurnReview = useCallback((turnId: string, itemId?: string) => resourceAction("workspace", {
    projectId: project?.id, threadId, turnId, itemId, operation: "turnReview",
  }), [resourceAction, project?.id, threadId]);
  const selectedCompletion = library.threads?.[`${project?.id}:${threadId}`]?.completionId;
  const completionInterruptPending = snapshot.lifecycle?.operations.some(operation =>
    operation.kind === "interruptTurn" && operation.threadId === threadId && operation.turnId === selectedCompletion
    && operation.phase !== "completed" && operation.phase !== "blocked"
    && operation.targets.some(target => target.projectId === project?.id && target.phase !== "completed" && target.phase !== "blocked"),
  ) ?? false;
  useEffect(() => {
    // A new completion visible in the foreground is read. A manual unread mark
    // does not change completionId, so it survives until the user opens it again.
    if (!initialReleased || !project?.id || !project.state?.connected || !threadId || thread?.id !== threadId || !selectedCompletion || completionInterruptPending || settingsOpen || taskCenterOpen || !document.hasFocus() || document.visibilityState !== "visible") return;
    void action("library", { operation: "readThread", projectId: project.id, threadId, read: true, completionId: selectedCompletion }).catch(() => {});
  }, [initialReleased, project?.id, project?.state?.connected, threadId, thread?.id, selectedCompletion, completionInterruptPending, settingsOpen, taskCenterOpen, action]);
  const reconnectService = async () => {
    if (!initialReleased && restorationAttempt.current?.pending) {
      await restorationAttempt.current.promise;
      return;
    }
    if (project) {
      await restoreConversation(restorationOwner, project.state?.connected ? "open" : "connect", { connectService: true });
    } else await resourceAction("connectService");
  };
  const runBackendAction = async (kind: BackendStatusAction) => {
    if (backendActionInFlight.current) return;
    backendActionInFlight.current = true;
    setBackendActionPending(true);
    setBackendActionError("");
    try {
      if (kind === "status") {
        setSettingsTab("后台服务"); setSettingsOpen(true);
      } else if (kind === "update") {
        await resourceAction("serviceLifecycle", { operation: "update" });
      } else if (kind === "recover") {
        const result = await resourceAction("serviceLifecycle", { operation: "recover" });
        if (result?.recovered) await reconnectService();
      } else if (kind === "check") {
        await resourceAction("serviceLifecycle", { operation: "check" });
      } else {
        await reconnectService();
      }
    } catch (cause) {
      setBackendActionError((cause as Error).message);
    } finally {
      backendActionInFlight.current = false;
      setBackendActionPending(false);
    }
  };
  const choose = async () => {
    if (!initialReleased) return;
    try {
      const id = await services.chooseProject();
      if (id) {
        setPanel("");
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
      if (!initialReleased) return;
      if (navigation !== "restore") recordWorkspaceLocation({ projectId: pid, threadId: id }, navigation === "replace");
      setPluginsOpen(false);
      setTaskCenterOpen(false);
      setNoProject(false);
      setProjectId(pid);
      setThreadId(id);
      if (matchMedia("(max-width: 640px)").matches) setSidebar(false);
      localStorage.setItem(`areal-gui:thread:${pid}`, id);
      const target = snapshot.projects.find(item => item.id === pid);
      const owner = { projectId: pid, threadId: id, connectionGeneration: target?.core?.connectionGeneration ?? 0 };
      selectedRestoration.current = owner;
      await restoreConversation(owner, target?.state?.connected ? "open" : "connect");
    },
    [initialReleased, snapshot.projects, restoreConversation, recordWorkspaceLocation],
  );
  const returnToPluginTask = () => {
    const origin = pluginTaskOrigin;
    if (!origin) return;
    void requestNavigation(() => {
      pluginTaskFocus.current = origin;
      updateSettingsOpen(false);
      if (projectId === origin.projectId && threadId === origin.threadId) {
        setPluginsOpen(false);
        setTaskCenterOpen(false);
      } else void open(origin.projectId, origin.threadId);
    });
  };
  useEffect(() => {
    const target = pluginTaskFocus.current;
    if (!target) return;
    if (pluginsOpen || settingsOpen || taskCenterOpen || projectId !== target.projectId || threadId !== target.threadId) {
      pluginTaskFocus.current = null;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
      if (composer) {
        composer.focus({ preventScroll: true });
        pluginTaskFocus.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pluginsOpen, settingsOpen, taskCenterOpen, projectId, threadId, thread]);
  const [mcpMentionsOpen, setMcpMentionsOpen] = useState(false);
  const mcpWorkspace = useMcpAppsWorkspace({ services, project, deepLinksEnabled: initialReleased, projects: snapshot.projects, activeTab: !annotationVisible && !pluginsOpen && !settingsOpen && !taskCenterOpen && workspaceView !== "conversation" ? panel : "", threadId, action: resourceAction,
    onOpenThread: async (pid, tid) => { updateSettingsOpen(false); await open(pid, tid); },
    onReveal: (tab, owner) => { if(activePanelOwner.current!==`${owner.projectId}:${owner.threadId}`){mcpPendingReveal.current={tab,owner:`${owner.projectId}:${owner.threadId}`};return;} updateSettingsOpen(false); setWorkspaceView("split"); setPanelTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab]); setPanel(tab); },
    onRemoveTab: tab => {
      for (const [owner, view] of panelViews.current) panelViews.current.set(owner, { ...view, tabs: view.tabs.filter(item => item !== tab), panel: view.panel === tab ? "" : view.panel, lastPanel: view.lastPanel === tab ? undefined : view.lastPanel });
      if (mcpPendingReveal.current?.tab === tab) mcpPendingReveal.current = null;
      setPanelTabs(tabs => tabs.filter(item => item !== tab)); setPanel(current => current === tab ? "" : current);
    }, onError: setError });
  const appEntries: ComposerCatalogEntry[] = mcpAppEntrypoints(mcpWorkspace.servers, "thread").map(({ server, tool }) => ({
    value: `app:${server.serverId}:${tool.name}`,
    label: toolTitle(tool),
    description: t("chat.composer.openApp"),
    source: server.title ?? server.pluginId,
    keywords: ["app", "应用", "plugin", "插件"],
    icon: <McpAppIcon icon={tool.icons?.[0] ?? server.icons?.[0]} size={16} loadMetadataImage={mcpWorkspace.loadMetadataImage} />,
    group: "应用",
    disabled: !project?.state?.connected || project.desktopCapabilities?.currentCommands === false || !!thread?.desktop?.archived,
    run: () => { void mcpWorkspace.openApp(server, tool, { kind: "thread" }).catch(cause => setError(cause.message)); },
  }));
  useEffect(() => {
    if (!initialReleased) return;
    return services.onNotificationOpen?.(target => requestNavigation(() => {
      updateSettingsOpen(false);
      setSearchOpen(false);
      if (target.taskId !== undefined) {
        setTaskScope(undefined);
        setTaskNotification({ projectId: target.projectId, taskId: target.taskId, runId: target.runId, questionId: target.questionId, eventId: crypto.randomUUID() });
        setTaskCenterOpen(true);
      } else void open(target.projectId, target.threadId);
    }));
  }, [services, open, requestNavigation, projectId, initialReleased]);
  useEffect(() => {
    if (snapshot.connection?.state !== "ready" || selectionReady) return;
    setSelectedProject(project?.id ?? "");
    if (!project?.id) {
      setProjectId("");
      setThreadId("");
      localStorage.setItem("areal-gui:project", "");
      return;
    }
    setProjectId(project.id);
    localStorage.setItem("areal-gui:project", project.id);
    const remembered = localStorage.getItem(`areal-gui:thread:${project.id}`);
    setThreadId(remembered ?? "");
  }, [project?.id, selectionReady, snapshot.connection?.state]);
  useEffect(() => {
    if (!selectionReady || !project?.id || snapshot.connection?.state !== "ready") return;
    const previous = restorationAttempt.current;
    const owner = { projectId: project.id, threadId, connectionGeneration: project.core?.connectionGeneration ?? 0 };
    if (!project.state?.connected && sameRestorationOwner(previous, owner)) return;
    if (project.observationErrors?.[threadId]?.connectionGeneration === owner.connectionGeneration) return;
    void restoreConversation(owner, project.state?.connected ? "open" : "connect");
  }, [selectionReady, project?.id, threadId, project?.state?.connected, project?.core?.connectionGeneration, snapshot.connection?.state, restoreConversation]);
  const startupLifecycle = snapshot.lifecycle;
  const startupLifecycleBlocked = !!startupLifecycle?.error || !!startupLifecycle?.recovery
    || ["acceptedPending", "admissionUnconfirmed", "partial", "settlementIncomplete"].includes(startupLifecycle?.phase ?? "");
  const startupReady = themeReady && snapshot.connection?.state === "ready" && selectionReady
    && !restorationFailed && !startupLifecycleBlocked
    && (!project || (currentRestoration && !currentRestoration.pending && (!threadId || !!thread)));
  useEffect(() => {
    if (restorationFailed || startupReady)
      setInitialPresentation(previous => previous === "ready" ? previous : startupReady ? "ready" : "failed");
  }, [startupReady, restorationFailed]);
  useEffect(() => {
    setStartupDelayed(false);
    if (initialReleased) return;
    const timer = window.setTimeout(() => setStartupDelayed(true), 15000);
    return () => window.clearTimeout(timer);
  }, [initialReleased, restoration, restorationOwner.projectId, restorationOwner.threadId, restorationOwner.connectionGeneration]);
  const presented = React.useRef(false);
  useEffect(() => {
    if (!themeReady || presented.current) return;
    let active = true, frame = 0;
    // Wait for layout/fonts and a painted frame, not just receipt of a snapshot.
    void document.fonts.ready.then(() => {
      if (!active) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!active) return;
          presented.current = true;
          setShellReady(true);
          void services.presentReady?.().catch(() => {});
        });
      });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [themeReady, services]);
  const retryRestoration = async () => {
    if (!project) return;
    await restoreConversation(restorationOwner, project.state?.connected ? "open" : "connect",
      { connectService: snapshot.connection?.state !== "ready" });
  };
  const newTask = (pid = project?.id, record = true) => {
    if (!initialReleased) return;
    if (!pid || snapshot.projects.find(p => p.id === pid)?.projectless) { leaveProject(record); return; }
    requestNavigation(() => {
      if (record) recordWorkspaceLocation({ projectId: pid, threadId: "" });
      setPluginsOpen(false);
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
    if (!initialReleased) return;
    requestNavigation(() => {
      if (record) recordWorkspaceLocation({ projectId: "", threadId: "" });
      setPluginsOpen(false);
      setTaskCenterOpen(false); updateSettingsOpen(false);
      setNoProject(true);
      setProjectId("");
      setThreadId("");
      setPanel("");
      localStorage.setItem("areal-gui:project", "");
    });
  };
  const traverseWorkspaceHistory = (delta: -1 | 1) => {
    if (!initialReleased || settingsOpen || taskCenterOpen) return;
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
      if (!initialReleased) return;
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
  }, [initialReleased, project?.id, snapshot.projects, workspaceHistory, settingsOpen, taskCenterOpen]);
  const onLink = useCallback((url: string) => {
    if (!project) return;
    const owner = `${project.id}:${threadId}`;
    void services.preview({ operation: 'openLink', projectId: project.id, threadId, url }).then(result => {
      if (previewOwner.current !== owner || result.destination !== 'internal') return;
      setWorkspaceView(mode => mode === "split" ? mode : "panel");
      void openBrowser(false, result.url);
    }).catch(cause => { if (previewOwner.current === owner) setError(cause.message); });
  }, [services, project?.id, threadId, openBrowser]);
  const openFile = (path: string) => {
    rememberPanelTrigger();
    setWorkspaceView(mode => mode === "split" ? mode : "panel");
    const relative =
      project && path.startsWith(project.root + "/") ? path.slice(project.root.length + 1) : path;
    const next = `file:${relative}`;
    if (!panelTabs.includes(next)) {
      // A temporary view owns one clean document slot. Edited documents retain
      // their existing revision/draft owner and can never be replaced by browsing.
      const replace = previewFileTab && project &&
        !dirtyFiles[`${workspaceDocumentOwner(project.id, project.root)}:${previewFileTab.slice(5)}`] &&
        confirmCloseFiles(project.id, [previewFileTab.slice(5)], project.root);
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
  const hidePanel = () => {
    const returning = panel === "旁路讨论" || panel === "历史旁路讨论" || isSideChatTab(panel) || (panel === "子代理" || panel.startsWith("agent:")) || isBrowserTab(panel) || panel.startsWith("file:") || panel === "改动";
    const owner = `${projectId}:${threadId}`;
    const trigger = panelReturnTarget.current;
    setWorkspaceView("split"); setPanel("");
    if (contextReturn.current && (panel === "子代理" || panel.startsWith("agent:"))) {
      const restore = contextReturn.current; contextReturn.current = null;
      requestAnimationFrame(restore); return;
    }
    if (returning) requestAnimationFrame(() => {
      if (previewOwner.current !== owner) return;
      if (trigger?.route === owner && trigger.element.isConnected && trigger.element.getClientRects().length) trigger.element.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-testid="chat-input"]')?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    const query = matchMedia("(max-width: 1200px)");
    const resize = () => {
      if (panel !== "旁路讨论" && !isSideChatTab(panel)) return;
      if (query.matches) { sideNarrow.current = true; if (workspaceView === "split") setWorkspaceView("panel"); }
      else if (sideNarrow.current) { sideNarrow.current = false; setWorkspaceView("split"); }
    };
    resize(); query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, [panel, workspaceView]);
  const showPanel = (name: string) => {
    if (!initialReleased) return;
    if (name === "预览") { void openBrowser(); return; }
    if (name === "旁路讨论" && canCreateSide) { newSide(); return; }
    if (name === "改动") rememberPanelTrigger();
    if (name === "旁路讨论" || name === "子代理" || name.startsWith("agent:")) { if (panel === name) { hidePanel(); return; } rememberPanelTrigger(); }
    setWorkspaceView(mode => name === "旁路讨论" && matchMedia("(max-width: 1200px)").matches ? "panel" : mode === "split" ? mode : "panel");
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
    if (["设置", "Skills", "MCP", "后台服务", "会话配置"].includes(name)) {
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
      if (!initialReleased || event.isComposing) return;
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
          if (panelShortcut === "预览") { void openBrowser(true); return; }
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
  }, [initialReleased, project?.id, settingsOpen, threadId, terminalLocation, openBrowser]);
  const title = (owner: Data, summary: Data) =>
    library.threads?.[`${owner.id}:${summary.id}`]?.title ||
    owner.state?.threads[summary.id]?.name ||
    summary.name ||
    imageAnnotationTitle(browserAnnotationTitle(owner.state?.threads[summary.id]?.turns
      ?.flatMap((t: Data) => t.items ?? [])
      .find((i: Data) => i.type === "userMessage")
      ?.content?.find((p: Data) => p.type === "text")?.text ||
    summary.preview ||
    "新对话"));
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
    return [...map.values()].filter(summary => {
      const live = owner.state?.threads[summary.id];
      return !scheduledThreads.has(summary.id)
        && !(owner.configurations?.[summary.id]?.options?.appendInstructions ?? live?.desktop?.configuration?.options?.appendInstructions)?.startsWith("AREAL_TASK_DRAFT_V1\n")
        && !live?.parentThreadId && !summary.parentThreadId
        && live?.conversation?.kind !== "side" && summary.conversation?.kind !== "side";
    }).map((summary) => {
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
  const conversationReferences = summaries
    .filter(row => row.owner.id === project?.id && row.summary.id !== thread?.id && !row.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.summary.id.localeCompare(b.summary.id))
    .map(row => ({ threadId: row.summary.id, title: row.title, updatedAt: row.updatedAt }));
  const sidebarKey = (row: Data) => `${row.owner.id}:${row.summary.id}`;
  const sidebarGroup = (row: Data) => row.pinned ? "pinned" : (row.owner.projectless ? "chats" : row.owner.id);
  const sortMode = (area: "Chats" | "Projects" | "Pinned") => library.settings?.[`sidebarSort${area}`] ?? library.settings?.sidebarSort ?? "updated_at";
  const rowSortMode = (row: Data) => sortMode(row.pinned ? "Pinned" : row.owner.projectless ? "Chats" : "Projects");
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
  const taskPlacement = (row: Data) => row.pinned ? { type: "pinned" } : row.owner.projectless ? { type: "chats" } : { type: "project", id: row.owner.id };
  const projectPlacement = (id: string) => library.projects?.[id]?.pinned ? { type: "pinned" } : { type: "projects" };
  const placementKey = (target: Data) => target.id ? `${target.type}:${target.id}` : target.type;
  const dropRequest = (source: SidebarDragSource, target: Data, edge: "before" | "after", anchor: string | null = null) => {
    if (source.type === "section") return null;
    if (source.type === "thread" && target.type === "projects") target = snapshot.projects.find(p => p.id === source.projectId)?.projectless ? { type: "chats" } : { type: "project", id: source.projectId };
    if (source.type === "thread" && target.type === "project" && target.id !== source.projectId) return null;
    if (source.type === "project" && target.type === "project") return null;
    const key = source.type === "thread" ? `${source.projectId}:${source.id}` : source.id;
    if (anchor === key) return null;
    const order = source.type === "thread"
      ? sortRows(visibleRows.filter(row => placementKey(taskPlacement(row)) === placementKey(target)), sortMode(target.type === "pinned" ? "Pinned" : target.type === "chats" ? "Chats" : "Projects")).map(sidebarKey)
      : (target.type === "pinned" ? pinnedProjects : projects).filter(owner => placementKey(projectPlacement(owner.id)) === placementKey(target)).map(owner => owner.id);
    return { operation: "dropSidebar", source, target, anchor, edge, order };
  };
  const taskRow = (row: Data) => (
    <MemoTaskItem
      key={`${row.owner.id}:${row.summary.id}`}
      id={row.summary.id}
      nested={!row.owner.projectless && !row.pinned}
      title={row.title}
      worktree={row.summary.worktree}
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
    : dragSource.type === "section" ? ""
    : library.projects?.[dragSource.id]?.title || projects.find(owner => owner.id === dragSource.id)?.root.split("/").pop();
  const projectGroup = (owner: Data) => {
    const rows = sortRows(visibleRows.filter((r) => r.owner.id === owner.id && !r.pinned), sortMode("Projects"));
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
              <DropdownMenuItem onClick={() => requestNavigation(() => {updateSettingsOpen(false);setTaskScope(owner.id);setTaskNotification(undefined);setTaskCenterOpen(true);})}>定时任务</DropdownMenuItem>
              <DropdownMenuItem onClick={() => startRename({ operation: "renameProject", projectId: owner.id }, library.projects?.[owner.id]?.title || owner.root.split("/").pop())}>重命名</DropdownMenuItem>
              <DropdownMenuItem disabled={!services.fileOpen} onClick={() => void services.fileOpen?.({ operation: "open", projectId: owner.id, path: "." }).catch(cause => setError(cause.message))}>在默认应用中打开</DropdownMenuItem>
              <DropdownMenuItem disabled={!services.fileOpen} onClick={() => void services.fileOpen?.({ operation: "reveal", projectId: owner.id, path: "." }).catch(cause => setError(cause.message))}>在文件管理器中显示</DropdownMenuItem>
              <DropdownMenuItem onClick={() => organize({ operation: "pinProject", projectId: owner.id, pinned: !library.projects?.[owner.id]?.pinned })}>{library.projects?.[owner.id]?.pinned ? "取消置顶项目" : "置顶项目"}</DropdownMenuItem>
              {([[-1, "上移"], [1, "下移"]] as const).map(([direction, label]) => {
                const siblings = projects.filter(candidate => (!!library.projects?.[candidate.id]?.pinned === !!library.projects?.[owner.id]?.pinned));
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
  const currentTitle = threadId
    ? (summaries.find((r) => r.owner.id === project?.id && r.summary.id === threadId)?.title ?? t("startup.loadingConversation"))
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
    if (panel.startsWith("mcp-app:")) return mcpWorkspace.render(panel);
    if ((panel === "旁路讨论" || panel === "历史旁路讨论") && thread && project.core?.features?.sidePreview === true && !thread.parentThreadId && thread.conversation?.kind !== "side") {
      return <SideChatPane onPanel={showPanel} onReturn={hidePanel} key={`${project.core?.instanceId}:${project.id}:${thread.id}:side`} project={project} source={thread} executionBlocked={projectExecutionBlocked(snapshot.lifecycle, project.id)} action={resourceAction} dark={dark} />;
    }
    if (isSideChatTab(panel) || parseSideResourceTab(panel)) return null;
    if ((panel === "子代理" || panel.startsWith("agent:")) && thread) {
      const childId = panel.startsWith("agent:") ? panel.slice(6) : undefined;
      const parent = childId && project.state?.threads[childId]?.parentThreadId;
      const ownerThread = parent && project.state?.threads[parent] || thread;
      return <AgentHistoryPane key={`${panelOwner}:${panel}`} project={project} thread={ownerThread} initialId={childId} action={resourceAction} dark={dark} onLink={onLink} onFile={openFile}
        onClose={hidePanel} onAgent={id => showPanel(`agent:${id}`)} onReview={(id, turnId) => { setReviewRequest({ owner: panelOwner, threadId: id, turnId }); showPanel("改动"); }} />;
    }
    if (panel === "编辑目标" && thread) return <GoalEditor key={`${project.id}:${thread.id}:${thread.goals?.goal?.id ?? "new"}`} project={project} thread={thread} action={resourceAction} />;
    if (panel.startsWith("file:"))
      return (
        <div className="flex h-full min-h-0 flex-col">
        {threadId && <McpAppEntrypoints servers={mcpWorkspace.servers} loadMetadataImage={mcpWorkspace.loadMetadataImage} kind="file" fileName={panel.slice(5)} onOpen={(server, tool) => { if (dirtyFiles[`${workspaceDocumentOwner(project.id, project.root)}:${panel.slice(5)}`]) { setError("请先保存当前文件，再用应用打开。"); return; } void mcpWorkspace.openApp(server, tool, {kind:"file",filePath:panel.slice(5)}).catch(cause=>setError(cause.message)); }}/>}<WorkspaceFilePane
          key={`${project.id}:${project.root}:${panel}`}
          projectId={project.id}
          root={project.root}
          path={panel.slice(5)}
          action={action}
          onDirty={(path, dirty) => {
            setDirtyFiles((current) => ({ ...current, [`${workspaceDocumentOwner(project.id, project.root)}:${path}`]: dirty }));
            if (dirty) setPreviewFileTab(current => current === `file:${path}` ? undefined : current);
          }}
          onLink={onLink}
          fileOpen={contextualFileOpen}
          preferredFileOpenTarget={library.settings?.fileOpenTarget}
          filesOpen={filesOpen}
          onToggleFiles={() => setFilesOpen(value => !value)}
          tree={workspaceFileTree}
        /></div>
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
          fileOpen={contextualFileOpen}
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
    if (isBrowserTab(panel))
      return (
        <Preview
          key={`${project.id}:${threadId}:${panel}`}
          services={services}
          projectId={project.id}
          threadId={threadId}
          pageId={browserPageId(panel)!}
          state={browserWorkspace.state}
          requestPage={browserWorkspace.request}
          fullAddress={library.settings?.browserFullAddress === true}
          thread={thread}
          action={resourceAction}
          onReview={turnId => { rememberPanelTrigger(); setReviewRequest({ owner: panelOwner, turnId }); setPanel("改动"); }}
          onTool={itemId => {
            setWorkspaceView("split");
            requestAnimationFrame(() => document.querySelector(`[data-tool-id="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: "center" }));
          }}
          onError={setError}
        />
      );
    if (panel === "工作组") return <WorkgroupsPane key={project.id} project={project} action={resourceAction} />;
    if (!thread) return <div className="utility-content">请先选择任务。</div>;
    if (panel === "执行计划") return <PlanPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "已保存授权") return <SavedPermissionsPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "上下文") return <ContextPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} />;
    if (panel === "进程") return <ProcessesPane key={`${project.id}:${threadId}`} {...props} action={resourceAction}
      onOpenService={url => {
        void openBrowser(false, url);
      }} />;
    if (panel === "Skills")
      return (
        <div className="utility-content">
          <TaskSkillsSettings key={`${project.id}:${threadId}`} {...props} action={resourceAction} />
        </div>
      );
    if (panel === "调用轨迹") return <ModelTrajectoryPane key={`${project.id}:${threadId}`} thread={thread} title={currentTitle} refresh={() => resourceAction("open", { projectId: project.id, threadId })} onClose={() => setPanel("")} />;
    if (panel === "子任务") return <ExecutionsPane key={`${project.id}:${threadId}`} {...props} action={resourceAction} onOpen={(id) => id === thread.parentThreadId ? void open(project.id, id) : showPanel(`agent:${id}`)} />;
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
    thread?.conversation?.kind !== "fork" &&
    !thread?.turns?.some((turn: Data) => turn.items?.length || turn.status === "inProgress");
  const forkFromTurn = (turnId: string, anchor?: HTMLElement): Promise<void> => {
    if (!project || !thread) return Promise.resolve();
    const owner = project.id;
    const sourceThreadId = thread.id;
    const route = `${owner}:${sourceThreadId}`;
    return new Promise(resolve => setForkIntent({ projectId: owner, sourceThreadId, turnId,
      route, anchor: anchor ?? document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"] .turn-fork-trigger`) ?? undefined, resolve }));
  };
  const canStageSelection = !!project && !!thread && !thread.desktop?.archived && !thread.parentThreadId
    && thread.conversation?.kind !== "side" && !!project.state?.connected && !project.observationErrors?.[thread.id]
    && snapshot.connection?.state === "ready" && !viewRefreshing && !projectExecutionBlocked(snapshot.lifecycle, project.id);
  const addSelectionToChat = (reference: ConversationSelectionReference) => {
    if (!canStageSelection || !project || !thread) return;
    const key = `areal-gui:draft:${project.id}:${thread.id}`;
    if (sending.has(key) || localStorage.getItem(`${key}:pending`) || localStorage.getItem(`${key}:queue-edit`)
      || project.pending?.some((request: Data) => request.params?.threadId === thread.id)) return;
    const result = addConversationSelection(conversationSelectionScope(project.id, thread.id), reference);
    if (!result.ok) setError(selectionLimitMessage(t, result.reason));
  };
  const openSideSelection = (_selection: Data, _excerpt: string, _anchor?: Data, reference?: ConversationSelectionReference) => {
    if (!canStageSelection || !canCreateSide || !project || !thread || !reference) return;
    const owner = { projectId: project.id, parentId: thread.id, coreInstanceId: project.core?.instanceId };
    const sourceOwner = `${owner.projectId}:${owner.parentId}`;
    const sourceCurrent = () => sideSource.current.owner === sourceOwner && sideSource.current.instanceId === owner.coreInstanceId;
    const active = workspaceView !== "conversation" && !annotationVisible ? sideChats.tabs.find(tab => tab.id === panel && tab.projectId === owner.projectId && tab.parentId === owner.parentId) : undefined;
    if (active?.closeRequestId) return;
    void (async () => {
      let tab = active;
      if (tab) {
        try {
          const snapshot = await resourceAction("open", { projectId: tab.projectId, threadId: tab.childId });
          const current = sideChats.getTab(tab.projectId, tab.childId);
          const observedProject = snapshot.projects?.find((item: Data) => item.id === tab!.projectId);
          const observed = observedProject?.state?.threads?.[tab.childId];
          if (!current || current.closeRequestId || !sourceCurrent()
            || (observed?.executionCore?.instanceId ?? observedProject?.core?.instanceId) !== owner.coreInstanceId || observed?.desktop?.archived
            || observed?.conversation?.origin?.sourceThreadId !== owner.parentId) return;
          tab = current;
        } catch (cause) {
          const failure = cause as RecoveryFailure;
          if (failure.code !== -32004 && failure.code !== "THREAD_NOT_FOUND" && failure.reason !== "thread_not_found") throw cause;
          const current = sideChats.getTab(tab.projectId, tab.childId);
          if (!current || current.closeRequestId || !sourceCurrent()) return;
          removeSideTab(current);
          tab = undefined;
        }
      }
      if (!sourceCurrent()) return;
      tab ??= await createSide();
      const current = sideChats.getTab(tab.projectId, tab.childId);
      if (!current || current.closeRequestId || !sourceCurrent()) return;
      const key = `areal-gui:draft:${tab.projectId}:${tab.childId}`;
      if (sending.has(key) || project.pending?.some((request: Data) => request.params?.threadId === tab.childId)) return;
      const result = addConversationSelection(conversationSelectionScope(tab.projectId, tab.childId), reference);
      if (!result.ok) setError(selectionLimitMessage(t, result.reason));
      revealSide(tab);
    })().catch(cause => setError(cause.message));
  };
  const taskActions = <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button aria-label="任务操作" className="icon-button" disabled={!project}>
                          <MoreHorizontal size={16} />
                        </button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      {thread && project?.core?.features?.sidePreview === true && <DropdownMenuItem onClick={() => { setPanel("历史旁路讨论"); setWorkspaceView("split"); }}>{t("chat.side.history")}</DropdownMenuItem>}
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
                        .filter(([name]) => name !== "终端" && (name !== "旁路讨论" || !!thread && !thread.parentThreadId && thread.conversation?.kind !== "side" && project?.core?.features?.sidePreview === true))
                        .map(([name, icon]) => (
                          <DropdownMenuItem key={name} onClick={() => showPanel(name)}>
                            {icon ?? <span aria-hidden="true" className="size-4 shrink-0" />}
                            {name}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>;
  const startResourceDraft = async (seed: ResourceDraftSeed) => {
    if (!initialReleased) return;
    const owner = seed.kind === "creator" ? snapshot.projects.find(item => item.id === seed.projectId && !item.projectless)
      : project?.projectless ? undefined : project;
    const key = owner ? `areal-gui:draft:${owner.id}:new` : "areal-gui:draft:projectless:new";
    let text: string;
    let skill: ComposerSkill | undefined;
    let creatorProfile: PreparedCreator["profile"] | undefined;
    if (seed.kind === "creator") {
      if (!owner) throw new Error("请先选择要创建 Skill 的项目。");
      const selection = localStorage.getItem(`${key}:profile`);
      let requestedProfile: PreparedCreator["profile"] | undefined;
      if (selection !== null) {
        try { requestedProfile = JSON.parse(selection); }
        catch { throw new Error("保存的任务配置无效，现有草稿已保留。"); }
      }
      const prepared = await resourceAction("prepareCreator", { projectId: owner.id,
        ...(selection !== null ? { profile: requestedProfile } : {}) });
      const refreshed = await services.snapshot();
      const current = refreshed.projects.find(item => item.id === owner.id && !item.projectless);
      if (!current?.state?.connected || !current.profiles.some((item: Data) => profileKey(item) === profileKey(prepared.profile)))
        throw new Error("准备后的任务配置尚不可用，现有草稿已保留。");
      setSnapshot(refreshed);
      creatorProfile = prepared.profile;
      skill = { ...prepared.skill, source: "官方 · OpenAI" };
      const destination = `${owner.root.replace(/[\\/]+$/, "")}/.agents/skills/<name>`;
      text = `请使用 Skill Creator 帮我在当前所选项目中创建一个可复用的 Skill。目标目录是 ${destination}。请按 Skill Creator 的指导初始化并验证 Skill，不要写入个人或全局 Skill 目录。请先了解我希望复用的工作和具体需求。`;
    } else {
      ({ text, skill } = seed);
    }
    if (owner && seed.kind !== "creator") {
      if (!owner.state?.connected) throw new Error("连接当前项目后再使用 Skill，现有输入已保留。");
      const selection = localStorage.getItem(`${key}:profile`);
      const profile = resolveDraftProfile(owner, selection);
      if (!profile) throw new Error("当前任务配置不可用，无法附加 Skill。");
      const available = skill ? await resourceAction("manage", { projectId: owner.id, operation: "skills", agentProfile: { id: profile.id, revision: profile.revision } }) : null;
      if (skill && !(available?.data ?? []).some((item: Data) => item.available && item.id === skill.id && item.revision === skill.revision))
        throw new Error("当前任务配置未提供此 Skill 的确切版本，现有草稿已保留。");
    }
    const existingSkills = readComposerSkills(key);
    const existingText = localStorage.getItem(key) || "";
    localStorage.setItem(key, existingText.trim() ? `${existingText}\n\n${text}` : text);
    if (skill && !existingSkills.some(item => item.id === skill.id && item.revision === skill.revision))
      localStorage.setItem(`${key}:skills`, JSON.stringify([...existingSkills, skill]));
    if (creatorProfile) localStorage.setItem(`${key}:profile`, profileKey(creatorProfile));
    requestNavigation(() => {
      setPluginsOpen(false); updateSettingsOpen(false); setTaskCenterOpen(false); setThreadId(""); setPanel("");
      if (owner) { setNoProject(false); setProjectId(owner.id); localStorage.removeItem(`areal-gui:thread:${owner.id}`); }
      else { setNoProject(true); setProjectId(""); localStorage.setItem("areal-gui:project", ""); }
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    });
  };
  const pluginSettingsOpen = settingsOpen && ["插件", "Skills", "MCP"].includes(settingsTab);
  const pluginCenterActive = pluginsOpen || pluginSettingsOpen;
  const applicationRail = <ApplicationRail activeId={settingsOpen ? "settings" : pluginsOpen ? "plugins" : taskSurface ?? "home"} items={[
              { id: "home", label: "首页", icon: <Home active={!pluginsOpen && !settingsOpen && !taskCenterOpen} />, onSelect: () => requestNavigation(() => { if (taskCenterOpen) recordWorkspaceLocation({ projectId: project?.id ?? "", threadId }); setPluginsOpen(false); setTaskCenterOpen(false); updateSettingsOpen(false); }) },
              // 暂时隐藏 Inbox 入口（恢复时同时把 InboxIcon 加回 import）
              // { id: "inbox", label: "Inbox", icon: <InboxIcon />, onSelect: () => requestNavigation(() => { updateSettingsOpen(false); setTaskSurface("inbox"); if (matchMedia("(max-width: 640px)").matches) setSidebar(false); }) },
              { id: "tasks", label: "定时任务", icon: <CalendarClock />, onSelect: () => requestNavigation(() => { setPluginsOpen(false); updateSettingsOpen(false); setTaskScope(undefined); setTaskNotification(undefined); setTaskCenterOpen(true); if (matchMedia("(max-width: 640px)").matches) setSidebar(false); }) },
              { id: "plugins", label: "插件", icon: <SettingsPluginIcon />, onSelect: () => requestNavigation(() => { rememberPluginTask(); updateSettingsOpen(false); setTaskCenterOpen(false); setPluginMarketRequest(value => value + 1); setPluginsOpen(true); }) },
            ]} footer={<><UpdateIndicator services={services} /><Button variant="ghost" size="icon" className="application-rail-button relative" aria-label={t("settings.title")} title={t(trajectoryAttention ? "settings.attention" : "settings.title")} aria-current={settingsOpen ? "page" : undefined} onClick={() => showPanel("设置")}><Settings />{trajectoryAttention && <span aria-label={t("settings.trajectory.attention")} className="absolute top-1 right-1 size-2 rounded-full bg-amber-500" />}</Button></>} />;
  const workspaceNavigation = <div className="workspace-navigation">
    <button className="icon-button" aria-label="后退" title="后退 (⌘[)" disabled={taskCenterOpen || workspaceHistory.index <= 0} onClick={() => traverseWorkspaceHistory(-1)}><ArrowLeft size={16} /></button>
    <button className="icon-button" aria-label="前进" title="前进 (⌘])" disabled={taskCenterOpen || workspaceHistory.index >= workspaceHistory.entries.length - 1} onClick={() => traverseWorkspaceHistory(1)}><ArrowRight size={16} /></button>
    <button className="icon-button" aria-label={sidebar ? "收起侧栏" : "展开侧栏"} aria-expanded={sidebar} aria-controls="areal-sidebar" onClick={() => setSidebar(!sidebar)}><SidebarToggleIcon /></button>
  </div>;
  const settingsPage = (
    <SettingsPage
      key={settingsTab}
      className={["插件", "Skills", "MCP"].includes(settingsTab) ? "plugins-settings-page" : settingsTab === "模型服务" ? "model-settings-page" : undefined}
      title={settingsLabel(settingsTab)}
      subtitle={settingsTab === "浏览器" ? t("settings.browser.subtitle") : undefined}>
      {settingsTab === "外观" ? (
        <AppearanceSettings
          theme={theme}
          setTheme={setTheme}
          fontSize={uiFontSize}
          setFontSize={setUiFontSize}
        />
      ) : settingsTab === "常规" ? (
        <GeneralSettings settings={library.settings} power={snapshot.power} menuBar={snapshot.menuBar} projectlessDirectory={snapshot.projectless?.directory} chooseProjectlessDirectory={services.chooseProjectlessDirectory} fileOpen={contextualFileOpen} action={resourceAction} connected={snapshot.connection?.state === "ready"} />
      ) : settingsTab === "浏览器" ? (
        <BrowserSettings settings={library.settings} action={resourceAction} connected={snapshot.connection?.state === "ready"} />
      ) : settingsTab === "电脑控制" ? (
        <ComputerSettings settings={library.settings} action={resourceAction} connected={snapshot.connection?.state === "ready"} />
      ) : settingsTab === "Worktrees" ? (
        <WorktreesSettings onAddProject={async () => { const id = await services.chooseProject(); if (id) setSnapshot(await services.snapshot()); return id || undefined; }} action={resourceAction} projects={projects} initialProjectId={worktreeSettingsTarget.projectId} initialTab={worktreeSettingsTarget.tab} />
      ) : settingsTab === "钩子" ? (
        <HooksSettings action={resourceAction} connected={snapshot.connection?.state === "ready"} onConnect={reconnectService} />
      ) : settingsTab === "模型服务" ? (
        <ModelSettings action={action} onOpenSessionSettings={() => setSettingsTab("会话配置")} />
      ) : settingsTab === "会话配置" ? (
        <SessionSettings key={`${project?.id}:${thread?.id}`} project={project} thread={thread} action={resourceAction} />
      ) : settingsTab === "手机连接" ? (
        <MobileSettings action={resourceAction} projects={snapshot.projects} />
      ) : settingsTab === "数据飞轮" ? (
        <TrajectorySettings action={resourceAction} connected={snapshot.connection?.state === "ready"} onStatus={onTrajectoryStatus} />
      ) : settingsTab === "后台服务" ? (
        <><ServiceStatusSettings backendStatus={{ connection: snapshot.connection, update: snapshot.backendUpdate, lifecycle: snapshot.lifecycle,
          summary: snapshot.serviceSummary, currentCommands: snapshot.desktopCapabilities?.currentCommands ?? project?.desktopCapabilities?.currentCommands,
          pending: backendActionPending, error: backendActionError, detail: project?.error || project?.state?.error, onAction: kind => void runBackendAction(kind) }} recovery={snapshot.lifecycle?.recovery} runningState={snapshot.serviceSummary?.state} connected={snapshot.connection?.state === "ready"} action={resourceAction}
          onConnect={reconnectService}
          onTask={initialReleased ? (pid, taskId) => { updateSettingsOpen(false); setTaskScope(undefined); setTaskNotification({ projectId: pid, taskId }); setTaskCenterOpen(true); } : undefined}
          onOpen={initialReleased ? (pid, tid, panelName) => { updateSettingsOpen(false); void open(pid, tid).then(() => { if (panelName) setPanel(panelName); }); } : undefined} />
        <CoreCapabilitiesSettings projects={snapshot.projects} connected={snapshot.connection?.state === "ready"} /></>
      ) : settingsTab === "用量" ? (
        <UsageDashboard action={resourceAction} />
      ) : !project ? (
        <div className="settings-empty">
          <p>{t("settings.chooseProject")}</p>
          <button onClick={() => void choose()}>{t("settings.openProject")}</button>
        </div>
      ) : (
        panelBody(settingsTab)
      )}
    </SettingsPage>
  );
  const startupRecovery = restorationFailed || snapshot.connection?.state === "unavailable" || startupLifecycleBlocked || startupDelayed;
  const startupBusy = backendActionPending || viewRefreshing || snapshot.connection?.state === "connecting";
  const startupDetails = backendActionError || viewFailure?.message || restorationError || startupLifecycle?.error
    || startupLifecycle?.recovery?.message || startupLifecycle?.message || snapshot.connection?.message;
  const quitStartup = async () => {
    if (backendActionInFlight.current) return;
    backendActionInFlight.current = true;
    setBackendActionPending(true);
    try { await resourceAction("serviceLifecycle", { operation: "quitInterface" }); }
    catch (cause) { setBackendActionError((cause as Error).message); }
    finally { backendActionInFlight.current = false; setBackendActionPending(false); }
  };
  return (
    <ComputerControlContext.Provider value={{ visible: library.settings?.computerControlShowEntry === true, open: () => { setSettingsTab("电脑控制"); showPanel("设置"); } }}>
    <WorkbenchShell
      data-view={settingsOpen ? "settings" : pluginsOpen ? "plugins" : taskCenterOpen ? "tasks" : "workspace"}
      data-testid="areal-workbench"
      data-project-id={project?.id ?? projectId}
      data-thread-id={threadId}
      data-startup-ready={startupReady}
      data-shell-ready={shellReady}
    >
      <ToastHost />
      {snapshot.computerControl?.active === true && <div role="status" className="fixed bottom-4 right-4 z-50 flex items-center justify-between gap-3 rounded-lg border bg-background px-4 py-2 text-ui-sm shadow-lg">
        <span>{t('settings.computer.working')}{snapshot.computerControl.app?.name ? ` · ${snapshot.computerControl.app.name}` : ''}</span>
        <Button variant="outline" size="sm" onClick={() => void resourceAction('computerControl', { operation: 'stop' })}>{t('settings.computer.stop')}</Button>
      </div>}
      <BackendStatusNotice summary={snapshot.serviceSummary} connection={snapshot.connection} update={snapshot.backendUpdate} lifecycle={snapshot.lifecycle}
        currentCommands={snapshot.desktopCapabilities?.currentCommands ?? project?.desktopCapabilities?.currentCommands}
        pending={backendActionPending} error={backendActionError} onAction={kind => void runBackendAction(kind)} />
      {!initialReleased ? <div className="startup-screen" data-testid="startup-loading">
        <div className="startup-drag-region" aria-hidden="true" />
        {settingsOpen ? <div className="startup-settings">
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(false)}>{t("startup.back")}</Button>
          {settingsPage}
        </div> : <div className="startup-content">
          <img src={startupIcon} alt="AReaL Harness" width={40} height={40} />
          <p role={restorationFailed || snapshot.connection?.state === "unavailable" || startupLifecycleBlocked ? "alert" : "status"}>
            {t(startupRecovery ? startupDelayed && !restorationFailed && snapshot.connection?.state !== "unavailable" && !startupLifecycleBlocked ? "startup.delayed" : "startup.failed" : "startup.loading")}
          </p>
          {startupRecovery && <>
            <div className="startup-actions">
              {restorationFailed && <Button variant="outline" size="sm" disabled={startupBusy} onClick={() => void retryRestoration()}>{t("recovery.retryView")}</Button>}
              <Button variant="outline" size="sm" disabled={startupBusy} onClick={() => void runBackendAction(snapshot.connection?.state === "unavailable" && snapshot.connection?.recovery !== "check" && !startupLifecycleBlocked ? "reconnect" : "check")}>{t(snapshot.connection?.state === "unavailable" && snapshot.connection?.recovery !== "check" && !startupLifecycleBlocked ? "startup.reconnect" : "startup.check")}</Button>
              {startupLifecycle?.recovery && <Button variant="outline" size="sm" disabled={startupBusy} onClick={() => void runBackendAction("recover")}>{t("startup.recover")}</Button>}
              <Button variant="ghost" size="sm" onClick={() => { setSettingsTab((viewFailure && recoverySettings(viewFailure)) || "后台服务"); setSettingsOpen(true); }}>{t("recovery.checkSettings")}</Button>
              <Button variant="ghost" size="sm" disabled={backendActionPending} onClick={() => void quitStartup()}>{t("startup.quit")}</Button>
            </div>
            {startupDetails && <SettingsDisclosure title={t("recovery.details")}><pre>{startupDetails}</pre></SettingsDisclosure>}
          </>}
        </div>}
      </div> : <>
      {!sidebar && !settingsOpen && <div className="areal-update-floating"><UpdateIndicator services={services} /></div>}
      {settingsOpen ? (
        <SettingsNavigation width={sidebarWidth} rail={applicationRail}
          activeId={["Skills", "MCP"].includes(settingsTab) ? "插件" : settingsTab}
          onSelect={setSettingsTab} onBack={() => setSettingsOpen(false)}
          groups={settingsNavigationGroups.map(group => ({ ...group,
            label: t(group.label), items: group.items.map(item => ({ ...item,
              label: t(item.id === "数据飞轮" && trajectoryAttention ? "settings.trajectory.attentionTitle" : item.label),
            })),
          }))}
        />
      ) : (
        <NavigationSidebar id="areal-sidebar" data-testid="areal-sidebar" data-collapsed={pluginsOpen || !sidebar} railOnly={taskCenterOpen || pluginsOpen || !sidebar} width={sidebarWidth} onWidthChange={setSidebarWidth}
            chrome={workspaceNavigation}
            rail={applicationRail}
            footer={null}
          >
              <>
                <SidebarWorkspaceHeader title="AReaL Harness" onSearch={() => setSearchOpen(true)} />
                <div className="sidebar-tools">
                  <NewTaskButtonGroup
                    onCreateTask={() => void newTask()}
                  />
                </div>
                {<DndContext {...sidebarDrag.context}>
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
                  <section className="project-group" data-sidebar-projects>
                  <SidebarDragSurface className="section-heading" data-sidebar-drop-zone="projects" {...sidebarDrag.target("projects", (source, edge) => dropRequest(source, { type: "projects" }, edge))}>
                    <SidebarSectionToggle label={archived ? "已归档任务" : "项目"} ariaLabel="项目分类" controls="sidebar-projects" expanded={!collapsedProjects["sidebar:projects"]} onToggle={() => toggleSidebarGroup("sidebar:projects")} />
                    <Button type="button" variant="ghost" size="icon-sm" className="section-action-btn" aria-label={t("settings.openProject")} title={t("settings.openProject")} onClick={() => void requestNavigation(() => void choose())}><ComposerPlusIcon width={16} height={16} /></Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<button className="section-action-btn" aria-label="侧栏整理"><MoreHorizontal size={16} /></button>} />
                      <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => void requestNavigation(() => void choose())}>{t("chat.newProject")}</DropdownMenuItem>
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
                  {projects.filter(owner => !owner.projectless && !library.projects?.[owner.id]?.pinned).map(projectGroup)}
                  {!projects.length && <p className="empty-tasks">打开项目以开始</p>}
                  </div>
                  </section>
                  {visibleRows.some(row => row.owner.projectless && !row.pinned) && <section className="project-group" data-sidebar-chats>
                    <SidebarDragSurface className="section-heading" data-sidebar-drop-zone="chats"
                      {...sidebarDrag.target("chats", (source, edge) => source.type === "thread" ? dropRequest(source, { type: "projects" }, edge) : null)}>
                      <SidebarSectionToggle label="任务" ariaLabel="独立任务分类" controls="sidebar-chats" expanded={!collapsedProjects["sidebar:chats"]} onToggle={() => toggleSidebarGroup("sidebar:chats")} />
                    </SidebarDragSurface>
                    <div id="sidebar-chats" hidden={!!collapsedProjects["sidebar:chats"]}>
                      <ul>{sortRows(visibleRows.filter(row => row.owner.projectless && !row.pinned), sortMode("Chats")).map(row => taskRow(row))}</ul>
                    </div>
                  </section>}
                </div>
                <DragOverlay dropAnimation={null}>{dragSource && <div className="sidebar-drag-preview">{dragTitle}</div>}</DragOverlay>
                </DndContext>}
              </>
          </NavigationSidebar>
      )}
      <main className={`work-area ${settingsOpen ? "settings-open" : ""}`}
        data-workspace-view={!annotationVisible && panel && !pluginsOpen && !settingsOpen && !taskCenterOpen && workspaceView !== "split" ? workspaceView : undefined}>
        <WorkSurface panelOpen={Boolean((annotationVisible || (panel && project)) && !pluginsOpen && !settingsOpen && !taskCenterOpen)} split={workspaceView === "split" && !pluginsOpen && !settingsOpen && !taskCenterOpen}>
          {!taskCenterOpen && <WorkspaceHeader>
            {!sidebar && !settingsOpen && workspaceNavigation}
            {!pluginsOpen && !settingsOpen && !taskCenterOpen && (!empty || (!thread && !!threadId)) && <div className="header-context">
              <ProjectFolderIcon />
              <strong className="header-task">{currentTitle}</strong>
            </div>}
            <div className="header-tools">
              {!pluginsOpen && !settingsOpen && !taskCenterOpen && (
                <>
                  {thread && !empty && (
                    <TaskResourcesPopover key={panelOwner} onLink={onLink} onAddSource={() => mainPane.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click()} onReadAgents={restore => { contextReturn.current = restore; showPanel("子代理"); }} project={project} thread={thread} action={resourceAction}
                      onAddSchedule={() => {
                        const key = `areal-gui:draft:${project.id}:${thread.id}`;
                        const text = localStorage.getItem(key) ?? "";
                        const intent = t("operations.schedules.creationIntent");
                        localStorage.setItem(key, text.trim() ? `${text}\n${intent}` : intent);
                        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key })));
                      }}
                      onOpenSchedule={task => { setTaskNotification({ projectId: project.id, taskId: task.id }); setTaskCenterOpen(true); }}
                      onPanel={name => { if (name === "改动") setReviewRequest({ owner: panelOwner, scope: "unstaged" }); showPanel(name); }}
                      onAgent={id => showPanel(`agent:${id}`)} onFile={openFile} />
                  )}
                  <button
                    className={`icon-button ${panel ? "active" : ""}`}
                    aria-label="展开侧边面板"
                    aria-pressed={Boolean(panel)}
                    disabled={!project}
                    onClick={() => {
                      if (panel) { hidePanel(); return; }
                      rememberPanelTrigger();
                      const last = panelViews.current.get(panelOwner)?.lastPanel;
                      setPanel(last && (last === "功能" || panelTabs.includes(last)) ? last : panelTabs.at(-1) ?? "功能");
                    }}
                  >
                    <SidePanelIcon />
                  </button>
                  {thread?.worktree && project && <WorktreeActions key={`${project.id}:${thread.id}`} projectId={project.id} threadId={thread.id} worktree={thread.worktree} action={resourceAction} />}
                  {taskActions}
                </>
              )}
            </div>
          </WorkspaceHeader>}
          {operationNotices.map(notice => (
            <FeedbackNotice key={notice.id} tone={notice.kind === "unconfirmed" ? "warning" : "error"}
              transient
              message={notice.kind === "unconfirmed" ? t("recovery.operationUnconfirmed") : isTechnicalErrorMessage(notice.message) ? t("recovery.operationFailed") : notice.message} requestId={notice.requestId} onDismiss={() => dismissNotice(notice.id)}
              detail={(notice.requestId || notice.detail || isTechnicalErrorMessage(notice.message)) ? <>
                {notice.requestId && <div>{t("recovery.requestId", { id: notice.requestId })}</div>}
                {(notice.detail || isTechnicalErrorMessage(notice.message)) && <pre>{notice.detail || notice.message}</pre>}
              </> : undefined}
              actions={<>
                {notice.settings && <Button variant="ghost" size="sm" onClick={() => { setSettingsTab(notice.settings!); setSettingsOpen(true); }}>{t(notice.settings === "模型服务" ? "recovery.checkModelSettings" : "recovery.checkSessionSettings")}</Button>}
                {notice.kind === "unconfirmed" && <Button variant="ghost" size="sm" onClick={() => void resourceAction("reconcile", { projectId: notice.projectId }).catch(() => {})}>{t("recovery.checkOriginal")}</Button>}
              </>} />
          ))}
          {restorationError && (!reconnectingView || viewRecoveryVisible) && !dismissedNotices.has(restorationNoticeId) && (
            <FeedbackNotice tone={viewRefreshing || reconnectingView ? "info" : "error"}
              message={viewRefreshing || reconnectingView ? t("recovery.loadingView") : restorationError}
              detail={viewFailure && viewFailure.message !== restorationError ? viewFailure.message : undefined}
              onDismiss={() => dismissNotice(restorationNoticeId)} actions={<>
                {viewFailure && recoverySettings(viewFailure) && <Button variant="ghost" size="sm" onClick={() => { setSettingsTab(recoverySettings(viewFailure)!); setSettingsOpen(true); }}>{t("recovery.checkSettings")}</Button>}
                {!viewRefreshing && !reconnectingView && <Button variant="ghost" size="sm" onClick={() => void retryRestoration()}>{t("recovery.retryView")}</Button>}
              </>} />
          )}
          {<PluginCenter active={pluginCenterActive} marketRequest={pluginMarketRequest} surface={pluginSettingsOpen ? "settings" : "workspace"}
            initialTab={settingsTab === "Skills" ? "skills" : settingsTab === "MCP" ? "mcp" : "plugins"}
            project={project} projects={snapshot.projects} thread={thread} action={resourceAction}
            apps={pluginId => <McpAppsHub key={pluginId} pluginId={pluginId} workspace={mcpWorkspace} project={project} threadId={threadId} action={resourceAction} />}
            onOpenThread={(pid, tid) => { setPluginsOpen(false); updateSettingsOpen(false); void open(pid, tid); }}
            onSettings={() => { setPluginsOpen(false); updateSettingsTab("插件"); updateSettingsOpen(true); }}
            onMarket={preserveDetail => { updateSettingsOpen(false); if (!preserveDetail) setPluginMarketRequest(value => value + 1); setPluginsOpen(true); }}
            onChooseProject={() => void choose()}
            onSelectProject={id => { setNoProject(false); setProjectId(id); }}
            onReturnToTask={pluginTaskOrigin ? returnToPluginTask : undefined}
            onStartDraft={startResourceDraft} />}
          {pluginCenterActive ? null : settingsOpen ? (
            settingsPage
          ) : taskSurface === "inbox" ? (
            <Inbox projects={snapshot.projects} connected={snapshot.connection?.state === "ready"} action={resourceAction} onClose={() => setTaskCenterOpen(false)} />
          ) : taskCenterOpen ? (
            <TaskCenter target={taskNotification} initialProjectId={taskScope} defaultProjectId={project?.projectless ? undefined : project?.id} projects={snapshot.projects.map(p => ({...p,name:library.projects?.[p.id]?.title || p.root.split(/[\\/]/).pop()}))} connected={snapshot.connection?.state === "ready"} action={resourceAction} onOpenThread={(pid,id) => void open(pid, id)} onOpenModelSettings={() => showPanel("设置")} renderConversation={(owner,managementThread,beforeTurns,options) => <><Messages beforeTurns={beforeTurns} afterTurns={options?.afterTurns} embedded={options?.embedded} readOnly={options?.readOnly} reserveResponseSpace={!options?.embedded && !options?.afterTurns} project={owner} thread={managementThread} action={resourceAction} dark={dark} onLink={onLink}
              onFile={path => {void open(owner.id,managementThread.id).then(() => openFile(path));}}
              onReview={turnId => {void open(owner.id,managementThread.id).then(() => {setReviewRequest({owner:`${owner.id}:${managementThread.id}`,turnId});setPanel("改动");});}}
              readTurnReview={(turnId,itemId) => resourceAction("workspace",{projectId:owner.id,threadId:managementThread.id,turnId,itemId,operation:"turnReview"})}/>
              {!options?.embedded && !options?.readOnly && <Composer key={managementThread.id} project={owner} thread={managementThread} executionBlocked={projectExecutionBlocked(snapshot.lifecycle, owner.id)} action={resourceAction} readAction={resourceAction} onPanel={name => {if(name === "设置") {showPanel("设置");} else {void open(owner.id,managementThread.id).then(() => showPanel(name));}}} onNew={() => void newTask()}/>}</>}
            renderResources={(owner,managementThread,scheduledTask,runHistory,revealKey?: string) => <TaskResourcesPopover revealKey={revealKey !== consumedResourceReveal.current ? revealKey : undefined} onReveal={consumeResourceReveal} project={owner} thread={managementThread} scheduledTask={scheduledTask} runHistory={runHistory} action={resourceAction} onPanel={name => {void open(owner.id,managementThread.id).then(() => showPanel(name));}} onAgent={id => void open(owner.id,id)} onFile={path => {void open(owner.id,managementThread.id).then(() => openFile(path));}} />}

            navigation={<>
              {!sidebar && <button className="icon-button" aria-label="展开侧栏" onClick={() => setSidebar(true)}><SidebarToggleIcon /></button>}
              <button className="icon-button" aria-label="返回对话" onClick={() => { setTaskCenterOpen(false); setTaskNotification(undefined); }}><ArrowLeft /></button>
            </>} />
          ) : (
            <div className="workspace-content">
              <div className="conversation-column">
                <section
                  ref={mainPane}
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
                          onOpenResult={mcpWorkspace.openResult}
                          resultStates={mcpWorkspace.resultStates}
                          onFork={forkFromTurn}
                          onAddSelection={canStageSelection ? addSelectionToChat : undefined}
                          onSideSelection={canStageSelection && canCreateSide ? openSideSelection : undefined}
                          dark={dark}
                          onLink={onLink}
                          onFile={openFile}
                          onReview={turnId => { rememberPanelTrigger(); setReviewRequest({ owner: panelOwner, turnId }); setPanel("改动"); setWorkspaceView(mode => mode === "split" ? mode : "panel"); }}
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
                            <ComposerWorkspaceContext project={project} threadId={thread?.id} action={resourceAction} backendReady={snapshot.connection?.state === "ready"} />
                            </div>
                          </div>
                        )}
                        {project && thread && sideChats.hasPendingCreation(project.id, thread.id) && <p role="status" className="notice">{t("chat.side.createUnconfirmed")}
                          <Button variant="ghost" size="sm" onClick={() => { void sideChats.recoverCreation(project.id, thread.id).then(tab => { if (tab) revealSide(tab); }).catch(cause => setError(cause.message)); }}>{t("chat.side.inspectCreation")}</Button>
                        </p>}
                        {mcpWorkspace.contexts}
                        {mcpWorkspace.formsView}
                        {mcpMentionsOpen && <McpMentionsPicker servers={mcpWorkspace.servers} projectId={project.id} threadId={thread.id} action={resourceAction} onClose={()=>setMcpMentionsOpen(false)}/>}
                        <Composer
                          surfaceLayout={workspaceView === "panel" ? "compact" : "default"}
                          onAnnotate={openImageAnnotation}
                          key={`${project.id}:${thread.id}`}
                          onMcpMention={()=>setMcpMentionsOpen(true)}
                          appEntries={appEntries}
                          conversationReferences={conversationReferences}
                          project={project}
                          thread={thread}
                          executionBlocked={snapshot.connection?.state !== "ready" || viewRefreshing || projectExecutionBlocked(snapshot.lifecycle, project.id)}
                          action={action}
                          readAction={resourceAction}
                          onPanel={showPanel}
                          onSide={canCreateSide ? async text => { await createSide(text); } : undefined}
                          onNew={() => void newTask()}
                          onOpenTask={target => { updateSettingsOpen(false); setTaskScope(undefined); setTaskNotification({ ...target, eventId: crypto.randomUUID() }); setTaskCenterOpen(true); }}
                        />
                      </div>
                    </>
                  ) : threadId ? (
                    <div className="settings-empty" role="status">
                      <p>{restorationFailed ? "暂时无法加载对话，请重试或切换对话。" : t("startup.loadingConversation")}</p>
                      {restorationFailed && <Button variant="outline" size="sm" className="mt-3" onClick={() => void retryRestoration()}>重试加载对话</Button>}
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
                              {t("chat.newProject")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => leaveProject()}>
                              <LeaveProjectIcon />
                              不在项目中工作
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                          {project && <ComposerWorkspaceContext project={project} showBranch={false} action={resourceAction} backendReady={snapshot.connection?.state === "ready"} />}
                          </div>
                        {project && <WorktreeStarter key={project.id} project={project} action={resourceAction} value={worktreeSelection} onChange={value => changeWorktreeSelection(project.id, value)} onConfigureEnvironments={() => { setWorktreeSettingsTarget({ projectId: project.id, tab: "environments" }); setSettingsTab("Worktrees"); setSettingsOpen(true); }} disabled={admitting || project.pending?.some((entry: Data) => !isIndependentCreation(entry, []))} />}
                      </div>
                      {project ? (
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
                        ) : (
                          <ProjectlessDraft onAnnotate={openImageAnnotation} snapshot={snapshot} services={services} action={action} readAction={resourceAction} onPanel={showPanel} onOpen={(pid, id) => open(pid, id, "replace")} />
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
        {mcpWorkspace.pages}
        {annotationVisible && annotationTarget && !pluginsOpen && !settingsOpen && !taskCenterOpen && <SidePane
          transient hideDisabled={annotationPending} workspaceKey={project?.root ?? "projectless"} ownerTaskId={threadId || null} active="图片标注" names={["图片标注"]}
          onSelect={() => {}} onChange={() => {}} onHide={finishImageAnnotation} dirtyFiles={{}} canClose={() => false}
          render={() => <ImageAnnotationPane key={annotationTarget.sessionId} file={annotationTarget.file} onDone={finishImageAnnotation} />}
        />}
        {(project || sideChats.tabs.length > 0) && (
          <SidePane
            workspaceKey={project?.root ?? ""}
            ownerTaskId={threadId || null}
            active={project && !annotationVisible && !pluginsOpen && !settingsOpen && !taskCenterOpen ? panel : ""}
            names={project ? panelTabs : []}
            onNewSide={canCreateSide ? newSide : undefined}
            retainedPanels={sideChats.tabs.flatMap(tab => {
              const owner = snapshot.projects.find(item => item.id === tab.projectId);
              if (!owner) return [];
              const execution = owner.state?.threads?.[tab.childId];
              const ownerProject = execution?.worktree?.directory ? {
                ...owner, logicalRoot: owner.root, root: execution.worktree.directory,
                core: { ...owner.core, ...execution.executionCore },
                state: { ...owner.state, connected: execution.executionConnected ?? owner.state?.connected },
                error: execution.executionError ?? owner.error,
              } : owner;
              const resource = parseSideResourceTab(panel);
              const selected = tab.projectId === project?.id && tab.parentId === threadId && !annotationVisible && !pluginsOpen && !settingsOpen && !taskCenterOpen
                && (panel === tab.id || resource?.childId === tab.childId);
              return [{ id: tab.id, visible: selected, content: <ExecutableSideChatPane tab={tab} project={ownerProject} projects={snapshot.projects} services={services}
                dark={dark} active={selected && workspaceView !== "conversation"} resource={selected ? resource?.resource ?? "" : ""}
                executionBlocked={snapshot.connection?.state !== "ready" || projectExecutionBlocked(snapshot.lifecycle, tab.projectId)} onNew={newSide}
                onOpenResource={name => openSideResource(tab, name)} onRemoveResource={name => removeSideResource(tab, name)}
                onBackToChat={() => { if (activePanelOwner.current === `${tab.projectId}:${tab.parentId}` && sideChats.hasChild(tab.projectId, tab.childId)) setPanel(tab.id); }}
                onBinding={binding => { if (binding) sideResourceBindings.current.set(tab.childId, binding); else sideResourceBindings.current.delete(tab.childId); }}
                onInspectClose={() => { void sideChats.close(tab).then(() => removeSideTab(tab)).catch(cause => setError(cause.message)); }} /> }];
            })}
            previewTabId={previewFileTab}
            onKeepTab={id => setPreviewFileTab(current => current === id ? undefined : current)}
            workspaceView={{ mode: workspaceView, title: empty ? "新对话" : currentTitle, onChange: mode => {
              if ((panel === "旁路讨论" || isSideChatTab(panel)) && mode === "split" && matchMedia("(max-width: 1200px)").matches) hidePanel();
              else setWorkspaceView(mode);
            }, actions: taskActions,
              navigation: !sidebar ? <button className="icon-button" aria-label="展开侧栏" aria-expanded={false} aria-controls="areal-sidebar" onClick={() => setSidebar(true)}><SidebarToggleIcon /></button> : undefined }}
            dirtyFiles={project ? Object.fromEntries(
              Object.entries(dirtyFiles)
                .filter(([key]) => key.startsWith(`${workspaceDocumentOwner(project.id, project.root)}:`))
                .map(([key, value]) => [key.slice(workspaceDocumentOwner(project.id, project.root).length + 1), value]),
            ) : {}}
            canClose={async (names) => {
              if (!project) return false;
              for (const name of names.filter(name => name.startsWith("mcp-app:"))) await mcpWorkspace.close(name);
              const closingChildren = new Set(names.filter(isSideChatTab).map(name => name.slice(5)));
              const paths = [...names.filter(name => name.startsWith("file:")).map(name => name.slice(5)),
                ...panelTabs.flatMap(name => {
                  const resource = parseSideResourceTab(name);
                  return resource && (names.includes(name) || closingChildren.has(resource.childId)) && resource.resource.startsWith("file:") ? [resource.resource.slice(5)] : [];
                })];
              if (!confirmCloseFiles(project.id, paths, project.root)) return false;
              try {
                for (const name of names.filter(isSideChatTab)) {
                  const tab = sideChats.tabs.find(tab => tab.id === name && tab.projectId === project.id);
                  if (tab) { await sideChats.close(tab); removeSideTab(tab); }
                }
                for (const name of names) {
                  const resource = parseSideResourceTab(name);
                  if (resource && !names.includes(`side:${resource.childId}`)) await sideResourceBindings.current.get(resource.childId)?.close(resource.resource);
                }
                for (const name of names.filter(isBrowserTab)) {
                  await browserWorkspace.request("release", { pageId: browserPageId(name), userIntent: true });
                }
                for (const name of names.filter(isTerminalTab)) await closeTerminal(terminalOwner(project.id, threadId), name);
              } catch (cause) { setError((cause as Error).message); return false; }
              setDirtyFiles((current) => {
                const next = { ...current };
                for (const path of paths) delete next[`${workspaceDocumentOwner(project.id, project.root)}:${path}`];
                return next;
              });
              return true;
            }}
            onSelect={(name) => {
              if (!project) return;
              const childId = isSideChatTab(name) ? name.slice(5) : parseSideResourceTab(name)?.childId;
              if (childId && !sideChats.hasChild(project.id, childId)) { setPanel("功能"); return; }
              if (workspaceView !== "split") setWorkspaceView("panel");
              if (name === "文件") {
                showFiles();
                return;
              }
              if (name === "终端") { openTerminal(true); return; }
              if (name === "预览") { void openBrowser(true); return; }
              if (isBrowserTab(name)) {
                const owner = panelOwner;
                setPanel(name);
                void browserWorkspace.request("selectPage", { pageId: browserPageId(name) })
                  .catch(cause => { if (previewOwner.current === owner) setError(cause.message); });
                return;
              }
              if (isTerminalTab(name)) { selectTerminal(terminalOwner(project.id, threadId), name); setTerminalOpen(false); }
              if (name.startsWith("file:")) setRevealedFile(name.slice(5));
              setPanel(name);
            }}
            titleFor={name => parseSideResourceTab(name) ? (() => {
              const resource = parseSideResourceTab(name)!.resource;
              return resource.startsWith("browser:") ? "浏览器" : resource.startsWith("mcp-app:") ? "应用" : resource.startsWith("file:") ? resource.slice(5).split("/").pop() : resource;
            })() : isSideChatTab(name) ? t("chat.side.numbered", { ordinal: sideChats.tabs.find(tab => tab.id === name)?.ordinal ?? "" }) : name.startsWith("mcp-app:") ? mcpWorkspace.titleFor(name) : isBrowserTab(name) ? (() => {
              const page = browserWorkspace.pages.find(page => page.pageId === browserPageId(name));
              let title = page?.title;
              if (!title && page?.url) { try { title = new URL(page.url).host; } catch { title = page.url; } }
              return (title || "新标签页") + (page?.resource === "suspended" ? " · 已暂停" : "");
            })() : name.startsWith("agent:") ? agentAssignment(thread ?? {}, name.slice(6)) || agentName(name.slice(6)) : isTerminalTab(name) ? terminalTitle(terminalOwner(project?.id ?? "", threadId), name, project?.root ?? "") : undefined}
            onChange={tabs => {
              setPanelTabs(tabs.filter(name => {
                const childId = isSideChatTab(name) ? name.slice(5) : parseSideResourceTab(name)?.childId;
                return !childId || !!project && sideChats.hasChild(project.id, childId);
              }));
              setPreviewFileTab(current => current && tabs.includes(current) ? current : undefined);
            }}
            onHide={hidePanel}
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
            <h2>重命名</h2>
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
      {forkIntent && <ForkTargetDialog anchor={forkIntent.anchor}
        onClose={() => { forkIntent.resolve(); setForkIntent(current => current === forkIntent ? null : current); }}
        onCheck={() => resourceAction("reconcile", { projectId: forkIntent.projectId })}
        onCreate={async () => {
          const result = await resourceAction("fork", { projectId: forkIntent.projectId, sourceThreadId: forkIntent.sourceThreadId,
            anchor: { turnId: forkIntent.turnId, boundary: "after" }, workspaceMode: "sharedCurrent" });
          forkIntent.resolve(); setForkIntent(current => current === forkIntent ? null : current);
          if (activeConversation.current === forkIntent.route) void open(forkIntent.projectId, result.threadId).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
        }} />}
      </>}
    </WorkbenchShell>
    </ComputerControlContext.Provider>
  );
}
