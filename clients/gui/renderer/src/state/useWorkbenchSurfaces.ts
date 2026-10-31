import type { TrajectoryStatus } from "@areal/workbench/desktop-contract";
import { useCallback, useRef, useState } from "react";
import type { useGuardedNavigation } from "../settings/UnsavedChanges.js";
import type { createTaskWorkspace } from "./taskWorkspace.js";

type PluginTaskOrigin = { projectId: string; threadId: string };
export function useWorkbenchSurfaces(
  projectId: string,
  threadId: string,
  taskCenterOpen: boolean,
  requestNavigation: ReturnType<typeof useGuardedNavigation>,
  tasks: ReturnType<typeof createTaskWorkspace>,
  open: (projectId: string, threadId: string) => Promise<void>,
) {
  const [worktreeSettingsTarget, setWorktreeSettingsTarget] = useState<{
    projectId?: string;
    tab: "general" | "environments";
  }>({ tab: "general" });
  const [trajectoryAttention, setTrajectoryAttention] = useState(false);
  const onTrajectoryStatus = useCallback((status: TrajectoryStatus | null) => {
    setTrajectoryAttention(!status || status.state === "degraded" || status.state === "invalid");
  }, []);
  const [settingsTab, updateSettingsTab] = useState("常规");
  const setSettingsTab = (next: string) => {
    if (next !== settingsTab) requestNavigation(() => updateSettingsTab(next));
  };
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginTaskOrigin, setPluginTaskOrigin] = useState<PluginTaskOrigin | null>(null);
  const pluginTaskFocus = useRef<PluginTaskOrigin | null>(null);
  const [pluginMarketRequest, setPluginMarketRequest] = useState(0);
  const [settingsOpen, updateSettingsOpen] = useState(false);
  const rememberPluginTask = () => {
    if (!pluginsOpen && !settingsOpen) {
      setPluginTaskOrigin(
        !taskCenterOpen && projectId && threadId ? { projectId, threadId } : null,
      );
      pluginTaskFocus.current = null;
    }
  };
  const settingsTrigger = useRef<{ element: HTMLElement; route: string } | null>(null);
  const setSettingsOpen = (open: boolean) => {
    if (open) {
      rememberPluginTask();
      if (!settingsOpen && document.activeElement instanceof HTMLElement)
        settingsTrigger.current = {
          element: document.activeElement,
          route: `${projectId}:${threadId}`,
        };
      setPluginsOpen(false);
      tasks.close();
      updateSettingsOpen(true);
    } else requestNavigation(() => updateSettingsOpen(false));
  };
  const previousSettingsOpen = useRef(settingsOpen);
  const restoreSettingsFocus = () => {
    if (previousSettingsOpen.current === settingsOpen) return;
    previousSettingsOpen.current = settingsOpen;
    const frame = requestAnimationFrame(() => {
      const trigger = settingsTrigger.current;
      if (!settingsOpen && trigger?.route === `${projectId}:${threadId}`) {
        // Settings replaces the chat subtree, so resolve a remounted composer
        // only within the same conversation. Never focus a previous task.
        const target = trigger.element.isConnected
          ? trigger.element
          : trigger.element.matches('[data-testid="chat-input"]')
            ? document.querySelector<HTMLElement>('[data-testid="chat-input"]')
            : null;
        if (target) {
          target.focus({ preventScroll: true });
          return;
        }
      }
      const selector = settingsOpen
        ? '[aria-label="设置导航"] [aria-current="page"]'
        : '[aria-label="设置"], [aria-label="展开侧栏"]';
      document.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  };
  const returnToPluginTask = (target?: PluginTaskOrigin) => {
    const origin = target ?? pluginTaskOrigin;
    if (!origin) return;
    void requestNavigation(() => {
      pluginTaskFocus.current = origin;
      updateSettingsOpen(false);
      if (projectId === origin.projectId && threadId === origin.threadId) {
        setPluginsOpen(false);
        tasks.close();
      } else void open(origin.projectId, origin.threadId);
    });
  };
  const restorePluginFocus = () => {
    const target = pluginTaskFocus.current;
    if (!target) return;
    if (
      pluginsOpen ||
      settingsOpen ||
      taskCenterOpen ||
      projectId !== target.projectId ||
      threadId !== target.threadId
    ) {
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
  };
  const pluginSettingsOpen = settingsOpen && ["插件", "Skills", "MCP"].includes(settingsTab);
  return {
    pluginSettingsOpen,
    pluginCenterActive: pluginsOpen || pluginSettingsOpen,
    worktreeSettingsTarget,
    setWorktreeSettingsTarget,
    trajectoryAttention,
    onTrajectoryStatus,
    settingsTab,
    settingsOpen,
    pluginsOpen,
    pluginTaskOrigin,
    pluginMarketRequest,
    setSettingsTab,
    setSettingsOpen,
    rememberPluginTask,
    returnToPluginTask,
    restoreSettingsFocus,
    restorePluginFocus,
    leaveSettings: () => updateSettingsOpen(false),
    leavePlugins: () => setPluginsOpen(false),
    openMarketplace(preserveDetail = false) {
      updateSettingsOpen(false);
      if (!preserveDetail) setPluginMarketRequest((value) => value + 1);
      setPluginsOpen(true);
    },
    openPluginSettings() {
      setPluginsOpen(false);
      updateSettingsTab("插件");
      updateSettingsOpen(true);
    },
  };
}
