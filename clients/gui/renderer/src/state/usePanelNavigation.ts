import React, { useState } from "react";
import { isBrowserTab } from "../app-shell/useBrowserWorkspace.js";
import { useNavigationWorkspace } from "../state/navigationWorkspace.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";
import { useSideConversations } from "../state/useSideConversations.js";
import { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
import {
  addTerminal,
  ensureTerminal,
  isTerminalTab,
  terminalOwner,
} from "../terminal/terminalWorkspace.js";
import { isSideChatTab } from "../useSideChatTabs.js";
import type { useWorkspacePreview } from "./useWorkspacePreview.js";
export function usePanelNavigation(
  session: ReturnType<typeof useSessionNavigation>,
  workspacePanels: ReturnType<typeof useWorkspacePanels>,
  preview: ReturnType<typeof useWorkspacePreview>,
  side: ReturnType<typeof useSideConversations>,
  surfaces: ReturnType<typeof useWorkbenchSurfaces>,
  navigation: ReturnType<typeof useNavigationWorkspace>["workspace"],
  initialReleased: boolean,
  terminalLocation: string,
  contextReturn: React.RefObject<(() => void) | null>,
) {
  const { project, thread, projectId, threadId } = session;
  const { panel, workspaceView } = workspacePanels.view;
  const { canCreateSide, newSide } = side;
  const { settingsOpen, setSettingsTab, setSettingsOpen } = surfaces;
  const { previewOwner, panelReturnTarget, rememberPanelTrigger, openBrowser } = preview;
  const [terminalOpen, setTerminalOpen] = useState(false);
  const sideNarrow = React.useRef(false);
  const showFiles = workspacePanels.showFiles;
  const openTerminal = (create = false) => {
    if (!project || !threadId) return;
    workspacePanels.exposePanel();
    const owner = terminalOwner(project.id, threadId);
    // Explicit side-pane creation keeps its destination; the shortcut follows
    // the preference while reusing the current owner's existing PTY.
    if (!create && terminalLocation === "bottom") {
      ensureTerminal(owner);
      workspacePanels.dismissTerminal();
      setTerminalOpen(true);
      return;
    }
    setTerminalOpen(false);
    workspacePanels.selectPanel(create ? addTerminal(owner) : ensureTerminal(owner));
  };
  const hidePanel = () => {
    const returning =
      panel === "side-chat" ||
      panel === "side-chat-history" ||
      isSideChatTab(panel) ||
      panel === "subagents" ||
      panel.startsWith("agent:") ||
      isBrowserTab(panel) ||
      panel.startsWith("file:") ||
      panel === "changes";
    const owner = `${projectId}:${threadId}`;
    const trigger = panelReturnTarget.current;
    workspacePanels.hidePanel();
    if (contextReturn.current && (panel === "subagents" || panel.startsWith("agent:"))) {
      const restore = contextReturn.current;
      contextReturn.current = null;
      requestAnimationFrame(restore);
      return;
    }
    if (returning)
      requestAnimationFrame(() => {
        if (previewOwner.current !== owner) return;
        if (
          trigger?.route === owner &&
          trigger.element.isConnected &&
          trigger.element.getClientRects().length
        )
          trigger.element.focus({ preventScroll: true });
        else
          document
            .querySelector<HTMLElement>('[data-testid="chat-input"]')
            ?.focus({ preventScroll: true });
      });
  };
  const settings = session.services.capabilities?.settings;
  const settingsRestricted = session.services.capabilities?.mutations === false;
  const canOpenSettings = !settingsRestricted || !!settings?.length;
  const openSettings = (target: string) => {
    // 设置是连接失败时的恢复入口，不能等待连接恢复后才放行。
    if (settingsRestricted && !settings?.includes(target)) return;
    if (!session.readOnly) workspacePanels.exposePanel();
    setSettingsTab(target);
    setSettingsOpen(true);
  };
  const showPanel = (name: string) => {
    if (
      ["settings", "Skills", "MCP", "diagnostics", "service", "session"].includes(name) &&
      !(name === "Skills" && thread)
    ) {
      openSettings(
        name === "settings"
          ? (settings?.[0] ?? "providers")
          : name === "service"
            ? "diagnostics"
            : name,
      );
      return;
    }
    if (!initialReleased || session.readOnly) return;
    if (name === "preview") {
      void openBrowser();
      return;
    }
    if (name === "side-chat" && canCreateSide) {
      newSide();
      return;
    }
    if (name === "changes") rememberPanelTrigger();
    if (name === "side-chat" || name === "subagents" || name.startsWith("agent:")) {
      if (panel === name) {
        hidePanel();
        return;
      }
      rememberPanelTrigger();
    }
    workspacePanels.exposePanel(name === "side-chat" && matchMedia("(max-width: 1200px)").matches);
    if (["edit-goal", "plan", "context", "permissions", "processes"].includes(name)) {
      workspacePanels.selectPanel(name);
      return;
    }
    if (name === "files") {
      showFiles();
      return;
    }
    if (name === "Skills" && thread) {
      workspacePanels.selectPanel("Skills");
      return;
    }
    if (name === "terminal") {
      if (isTerminalTab(panel) || panel === "terminal") workspacePanels.selectPanel("launcher");
      setTerminalOpen((value) => !value);
      return;
    }
    workspacePanels.togglePanel(name);
  };
  const subscribeNarrowLayout = () => {
    const query = matchMedia("(max-width: 1200px)");
    const resize = () => {
      if (panel !== "side-chat" && !isSideChatTab(panel)) return;
      if (query.matches) {
        sideNarrow.current = true;
        if (workspaceView === "split") workspacePanels.selectLayout("panel");
      } else if (sideNarrow.current) {
        sideNarrow.current = false;
        workspacePanels.selectLayout("split");
      }
    };
    resize();
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  };
  const subscribeShortcuts = () => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (
        session.readOnly &&
        !(
          (event.metaKey || event.ctrlKey) &&
          (event.key.toLowerCase() === "k" || (event.key === "," && canOpenSettings))
        )
      )
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === ","
      ) {
        if (!canOpenSettings) return;
        event.preventDefault();
        if (!settingsOpen && !document.querySelector('[data-slot="dialog-content"]'))
          showPanel("settings");
        return;
      }
      if (!initialReleased) return;
      if (project?.id && !settingsOpen && !event.altKey) {
        const key = event.key.toLowerCase();
        const panelShortcut =
          event.ctrlKey && event.shiftKey && key === "g"
            ? "changes"
            : event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey &&
                event.code === "Backquote" &&
                threadId
              ? "terminal"
              : (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "t"
                ? "preview"
                : (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "p"
                  ? "files"
                  : "";
        if (panelShortcut) {
          event.preventDefault();
          if (panelShortcut === "terminal") {
            openTerminal();
            return;
          }
          if (panelShortcut === "preview") {
            void openBrowser(true);
            return;
          }
          workspacePanels.exposePanel();
          if (panelShortcut === "files") showFiles();
          else workspacePanels.selectPanel(panelShortcut);
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigation.toggleSearch();
      }
      if (
        event.key === "Escape" &&
        !document.querySelector(
          '[data-slot="dialog-content"], [data-slot="select-content"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="context-menu-content"]',
        )
      ) {
        navigation.dismissSearch();
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  };
  return {
    terminalOpen,
    setTerminalOpen,
    showFiles,
    openTerminal,
    hidePanel,
    showPanel,
    openSettings,
    subscribeNarrowLayout,
    subscribeShortcuts,
  };
}
