import { useMemo, useRef, useState } from "react";
import { browserTabId, isBrowserTab } from "../app-shell/useBrowserWorkspace.js";
import { isTerminalTab } from "../terminal/terminalWorkspace.js";
import { parseSideResourceTab, sideResourceTab, type SideChatTab } from "../useSideChatTabs.js";

export type FileLocation = { owner: string; path: string; requestId: number; line?: number };

type WorkspaceLayout = "split" | "panel" | "conversation";
type PanelView = {
  panel: string;
  lastPanel?: string;
  tabs: string[];
  previewFileTab?: string;
  filesOpen: boolean;
  revealedFile: string;
  fileLocation?: FileLocation;
};

export function useWorkspacePanels() {
  const [panel, setPanel] = useState("");
  const [panelTabs, setPanelTabs] = useState<string[]>([]);
  const [previewFileTab, setPreviewFileTab] = useState<string | undefined>();
  const [workspaceView, setWorkspaceView] = useState<WorkspaceLayout>("split");
  const [filesOpen, setFilesOpen] = useState(false);
  const [revealedFile, setRevealedFile] = useState("");
  const [fileLocation, setFileLocation] = useState<FileLocation>();
  const panelViews = useRef(new Map<string, PanelView>());
  const activePanelOwner = useRef("");
  const mcpPendingReveal = useRef<{ tab: string; owner: string } | null>(null);
  const commands = useMemo(() => {
    const revealSide = (tab: SideChatTab, narrow: boolean) => {
      const owner = `${tab.projectId}:${tab.parentId}`;
      if (activePanelOwner.current !== owner) {
        const view = panelViews.current.get(owner);
        panelViews.current.set(owner, {
          panel: tab.id,
          lastPanel: tab.id,
          tabs: [...new Set([...(view?.tabs ?? []), tab.id])],
          filesOpen: view?.filesOpen ?? false,
          revealedFile: view?.revealedFile ?? "",
          previewFileTab: view?.previewFileTab,
        });
        return;
      }
      setWorkspaceView(narrow ? "panel" : "split");
      setPanelTabs((tabs) => (tabs.includes(tab.id) ? tabs : [...tabs, tab.id]));
      setPanel(tab.id);
    };
    const openSideResource = (tab: SideChatTab, resource: string) => {
      const owner = `${tab.projectId}:${tab.parentId}`;
      const id = sideResourceTab(tab.childId, resource);
      if (activePanelOwner.current !== owner) {
        const view = panelViews.current.get(owner);
        if (view)
          panelViews.current.set(owner, { ...view, tabs: [...new Set([...view.tabs, id])] });
        return;
      }
      setPanelTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
      setPanel(id);
    };
    const removeSideResource = (tab: SideChatTab, resource: string) => {
      const owner = `${tab.projectId}:${tab.parentId}`;
      const id = sideResourceTab(tab.childId, resource);
      const view = panelViews.current.get(owner);
      if (view)
        panelViews.current.set(owner, {
          ...view,
          tabs: view.tabs.filter((name) => name !== id),
          panel: view.panel === id ? tab.id : view.panel,
        });
      if (activePanelOwner.current === owner) {
        setPanelTabs((tabs) => tabs.filter((name) => name !== id));
        setPanel((current) => (current === id ? tab.id : current));
      }
    };
    const removeSide = (tab: SideChatTab) => {
      const owner = `${tab.projectId}:${tab.parentId}`;
      const view = panelViews.current.get(owner);
      if (view)
        panelViews.current.set(owner, {
          ...view,
          tabs: view.tabs.filter(
            (id) => id !== tab.id && parseSideResourceTab(id)?.childId !== tab.childId,
          ),
          panel:
            view.panel === tab.id || parseSideResourceTab(view.panel)?.childId === tab.childId
              ? "功能"
              : view.panel,
        });
      if (activePanelOwner.current === owner) {
        setPanelTabs((tabs) =>
          tabs.filter((id) => id !== tab.id && parseSideResourceTab(id)?.childId !== tab.childId),
        );
        setPanel((current) =>
          current === tab.id || parseSideResourceTab(current)?.childId === tab.childId
            ? "功能"
            : current,
        );
      }
    };
    return {
      isActiveOwner: (owner: string) => activePanelOwner.current === owner,
      selectPanel: (name: string) => setPanel(name),
      togglePanel: (name: string) => setPanel((current) => (current === name ? "" : name)),
      selectLayout: (mode: WorkspaceLayout) => setWorkspaceView(mode),
      exposePanel: (narrow = false) =>
        setWorkspaceView((mode) => (narrow || mode !== "split" ? "panel" : mode)),
      hidePanel() {
        setWorkspaceView("split");
        setPanel("");
      },
      retainSelectedTab(name: string) {
        if (name && name !== "功能" && name !== "预览")
          setPanelTabs((tabs) => (tabs.includes(name) ? tabs : [...tabs, name]));
      },
      showFiles() {
        setWorkspaceView((mode) => (mode === "split" ? mode : "panel"));
        setFilesOpen(true);
        setPanel("文件");
      },
      closeFiles() {
        setFilesOpen(false);
        setPanel((current) => (current === "文件" ? "功能" : current));
      },
      toggleFiles: () => setFilesOpen((current) => !current),
      revealFile(location: FileLocation) {
        setFileLocation(location);
        setRevealedFile(location.path);
        setFilesOpen(true);
      },
      selectFileTab(name: string) {
        if (name.startsWith("file:")) setRevealedFile(name.slice(5));
        setPanel(name);
      },
      keepFile: (id: string) =>
        setPreviewFileTab((current) => (current === id ? undefined : current)),
      replaceTabs(tabs: string[], hasChild: (childId: string) => boolean) {
        setPanelTabs(
          tabs.filter((name) => {
            const childId = name.startsWith("side:")
              ? name.slice(5)
              : parseSideResourceTab(name)?.childId;
            return !childId || hasChild(childId);
          }),
        );
        setPreviewFileTab((current) => (current && tabs.includes(current) ? current : undefined));
      },
      removeTerminalTab: (id: string) => setPanelTabs((tabs) => tabs.filter((tab) => tab !== id)),
      dismissTerminal: () =>
        setPanel((current) => (isTerminalTab(current) || current === "终端" ? "功能" : current)),
      revealSide,
      openSideResource,
      removeSideResource,
      removeSide,
      revealApp(tab: string, owner: { projectId: string; threadId: string }) {
        if (activePanelOwner.current !== `${owner.projectId}:${owner.threadId}`) {
          mcpPendingReveal.current = { tab, owner: `${owner.projectId}:${owner.threadId}` };
          return false;
        }
        setWorkspaceView("split");
        setPanelTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]));
        setPanel(tab);
        return true;
      },
      removeApp(tab: string) {
        for (const [owner, view] of panelViews.current)
          panelViews.current.set(owner, {
            ...view,
            tabs: view.tabs.filter((item) => item !== tab),
            panel: view.panel === tab ? "" : view.panel,
            lastPanel: view.lastPanel === tab ? undefined : view.lastPanel,
          });
        if (mcpPendingReveal.current?.tab === tab) mcpPendingReveal.current = null;
        setPanelTabs((tabs) => tabs.filter((item) => item !== tab));
        setPanel((current) => (current === tab ? "" : current));
      },
      reconcileBrowser(
        panelOwner: string,
        browserWorkspace: {
          workspace?: { selectedPageId?: string };
          pages: readonly { pageId: string }[];
        },
      ) {
        if (!browserWorkspace.workspace || activePanelOwner.current !== panelOwner) return;
        const workspace = browserWorkspace.workspace;
        const ids = browserWorkspace.pages.map((page) => browserTabId(page.pageId));
        setPanelTabs((tabs) => {
          const next = [
            ...tabs.filter((id) => id !== "预览" && (!isBrowserTab(id) || ids.includes(id))),
            ...ids.filter((id) => !tabs.includes(id)),
          ];
          return next.length === tabs.length && next.every((id, index) => id === tabs[index])
            ? tabs
            : next;
        });
        // A removed/closed native page must never keep a stale UI tab alive.
        setPanel((current) => {
          if (!isBrowserTab(current)) return current;
          const selected = workspace.selectedPageId;
          // Native popups and other Main-side selection changes share the same strip.
          if (selected && ids.includes(browserTabId(selected))) return browserTabId(selected);
          return ids.includes(current) ? current : "功能";
        });
      },
      reconcileTerminals(ids: string[]) {
        setPanelTabs((tabs) => [
          ...tabs.filter((id) => !isTerminalTab(id) || ids.includes(id)),
          ...ids.filter((id) => !tabs.includes(id)),
        ]);
      },
    };
  }, []);
  return {
    view: {
      panel,
      panelTabs,
      previewFileTab,
      workspaceView,
      filesOpen,
      revealedFile,
      fileLocation,
    },
    ...commands,
    commitOwner(panelOwner: string, ids: string[]) {
      if (activePanelOwner.current !== panelOwner) {
        activePanelOwner.current = panelOwner;
        setWorkspaceView("split");
        const remembered = panelViews.current.get(panelOwner);
        const appReveal =
          mcpPendingReveal.current?.owner === panelOwner ? mcpPendingReveal.current.tab : null;
        if (appReveal) mcpPendingReveal.current = null;
        // Only the terminal owner can supply live IDs; the view cache owns no PTY.
        setPanelTabs([
          ...new Set([
            ...(remembered?.tabs.filter((id) => id !== "任务资源" && !isTerminalTab(id)) ?? []),
            ...ids,
            ...(appReveal ? [appReveal] : []),
          ]),
        ]);
        setPanel(
          appReveal ??
            (remembered &&
            remembered.panel !== "任务资源" &&
            (!isTerminalTab(remembered.panel) || ids.includes(remembered.panel))
              ? remembered.panel
              : ""),
        );
        setFilesOpen(remembered?.filesOpen ?? false);
        setRevealedFile(remembered?.revealedFile ?? "");
        setFileLocation(remembered?.fileLocation);
        setPreviewFileTab(remembered?.previewFileTab);
        return;
      }
      panelViews.current.set(panelOwner, {
        panel,
        lastPanel: panel || panelViews.current.get(panelOwner)?.lastPanel,
        tabs: panelTabs,
        previewFileTab,
        filesOpen,
        revealedFile,
        fileLocation,
      });
    },
    openFile(location: FileLocation, canReplacePreview: (path: string) => boolean) {
      const { path } = location;
      setFileLocation(location);
      commands.exposePanel();
      const next = `file:${path}`;
      if (!panelTabs.includes(next)) {
        const replace = previewFileTab && canReplacePreview(previewFileTab.slice(5));
        setPanelTabs((tabs) =>
          replace && tabs.includes(previewFileTab)
            ? tabs.map((id) => (id === previewFileTab ? next : id))
            : [...tabs, next],
        );
        setPreviewFileTab(next);
      }
      setPanel(next);
      setRevealedFile(path);
    },
    restoreLastPanel(owner: string) {
      const last = panelViews.current.get(owner)?.lastPanel;
      setPanel(
        last && (last === "功能" || panelTabs.includes(last)) ? last : (panelTabs.at(-1) ?? "功能"),
      );
    },
  };
}
