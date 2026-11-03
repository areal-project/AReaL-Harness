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
      panel === "旁路讨论" ||
      panel === "历史旁路讨论" ||
      isSideChatTab(panel) ||
      panel === "子代理" ||
      panel.startsWith("agent:") ||
      isBrowserTab(panel) ||
      panel.startsWith("file:") ||
      panel === "改动";
    const owner = `${projectId}:${threadId}`;
    const trigger = panelReturnTarget.current;
    workspacePanels.hidePanel();
    if (contextReturn.current && (panel === "子代理" || panel.startsWith("agent:"))) {
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
  const showPanel = (name: string) => {
    if (!initialReleased) return;
    if (name === "预览") {
      void openBrowser();
      return;
    }
    if (name === "旁路讨论" && canCreateSide) {
      newSide();
      return;
    }
    if (name === "改动") rememberPanelTrigger();
    if (name === "旁路讨论" || name === "子代理" || name.startsWith("agent:")) {
      if (panel === name) {
        hidePanel();
        return;
      }
      rememberPanelTrigger();
    }
    workspacePanels.exposePanel(name === "旁路讨论" && matchMedia("(max-width: 1200px)").matches);
    if (["编辑目标", "执行计划", "上下文", "已保存授权", "进程"].includes(name)) {
      workspacePanels.selectPanel(name);
      return;
    }
    if (name === "文件") {
      showFiles();
      return;
    }
    if (name === "Skills" && thread) {
      workspacePanels.selectPanel("Skills");
      return;
    }
    if (["设置", "Skills", "MCP", "高级诊断", "后台服务", "会话配置"].includes(name)) {
      setSettingsTab(name === "设置" ? "模型服务" : name === "后台服务" ? "高级诊断" : name);
      setSettingsOpen(true);
      return;
    }
    if (name === "终端") {
      if (isTerminalTab(panel) || panel === "终端") workspacePanels.selectPanel("功能");
      setTerminalOpen((value) => !value);
      return;
    }
    workspacePanels.togglePanel(name);
  };
  const subscribeNarrowLayout = () => {
    const query = matchMedia("(max-width: 1200px)");
    const resize = () => {
      if (panel !== "旁路讨论" && !isSideChatTab(panel)) return;
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
      if (!initialReleased || event.isComposing) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === ","
      ) {
        event.preventDefault();
        if (!settingsOpen && !document.querySelector('[data-slot="dialog-content"]'))
          showPanel("设置");
        return;
      }
      if (project?.id && !settingsOpen && !event.altKey) {
        const key = event.key.toLowerCase();
        const panelShortcut =
          event.ctrlKey && event.shiftKey && key === "g"
            ? "改动"
            : event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey &&
                event.code === "Backquote" &&
                threadId
              ? "终端"
              : (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "t"
                ? "预览"
                : (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "p"
                  ? "文件"
                  : "";
        if (panelShortcut) {
          event.preventDefault();
          if (panelShortcut === "终端") {
            openTerminal();
            return;
          }
          if (panelShortcut === "预览") {
            void openBrowser(true);
            return;
          }
          workspacePanels.exposePanel();
          if (panelShortcut === "文件") showFiles();
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
    subscribeNarrowLayout,
    subscribeShortcuts,
  };
}
