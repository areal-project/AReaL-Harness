import React from "react";
import { projectUserState } from "../state/userStates.js";
import { currentErrorText } from "../errors/currentErrorText.js";
import { agentAssignment, agentName } from "../AgentIdentity.js";
import { SidePane } from "../app-shell/SidePane.js";
import {
  browserPageId,
  isBrowserTab,
  useBrowserWorkspace,
} from "../app-shell/useBrowserWorkspace.js";
import { Button } from "../components/ui/button.js";
import { ExecutableSideChatPane } from "../ExecutableSideChatPane.js";
import { SidebarToggleIcon } from "../homeChromeIcons.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { ImageAnnotationPane } from "../ImageAnnotationViews.js";
import { useMcpAppsWorkspace } from "../McpAppsWorkspace.js";
import { type PlatformServices } from "../services.js";
import { projectExecutionBlocked } from "../state/projectExecution.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";
import { useSideConversations } from "../state/useSideConversations.js";
import { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
import { useWorkspaceAnnotation } from "../state/useWorkspaceAnnotation.js";
import { useWorkspaceDocuments } from "../state/useWorkspaceDocuments.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
import {
  closeTerminal,
  isTerminalTab,
  selectTerminal,
  terminalOwner,
  terminalTitle,
} from "../terminal/terminalWorkspace.js";
import {
  isSideChatTab,
  parseSideResourceTab,
  type SideResourceBinding,
} from "../useSideChatTabs.js";
import { confirmCloseFiles, workspaceDocumentOwner } from "../WorkspaceFilePane.js";
type WorkspacePanelsProps = {
  session: ReturnType<typeof useSessionNavigation>;
  workspacePanels: ReturnType<typeof useWorkspacePanels>;
  side: ReturnType<typeof useSideConversations>;
  documents: ReturnType<typeof useWorkspaceDocuments>;
  annotation: ReturnType<typeof useWorkspaceAnnotation>;
  surfaces: ReturnType<typeof useWorkbenchSurfaces>;
  browserWorkspace: ReturnType<typeof useBrowserWorkspace>;
  mcpWorkspace: ReturnType<typeof useMcpAppsWorkspace>;
  taskCenterOpen: boolean;
  services: PlatformServices;
  dark: boolean;
  empty: boolean;
  currentTitle: string;
  sidebar: boolean;
  setSidebar: (show: boolean) => void;
  taskActions: React.ReactNode;
  workspaceFileTree: React.ReactNode;
  panelBody: (name?: string) => React.ReactNode;
  hidePanel: () => void;
  showFiles: () => void;
  openTerminal: (create?: boolean) => void;
  openBrowser: (create?: boolean, url?: string) => Promise<void>;
  setTerminalOpen: (show: boolean) => void;
  previewOwner: React.RefObject<string>;
  setError: (message: string) => void;
};
function usePanelTabLifecycle(props: WorkspacePanelsProps) {
  const {
    session,
    workspacePanels,
    side,
    documents,
    browserWorkspace,
    mcpWorkspace,
    showFiles,
    openTerminal,
    openBrowser,
    setTerminalOpen,
    previewOwner,
    setError,
  } = props;
  const { project, threadId } = session;
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  const { panelTabs, workspaceView } = workspacePanels.view;
  const { sideChats, removeSideTab } = side;

  const sideResourceBindings = React.useRef(new Map<string, SideResourceBinding>());

  const canClose = async (names: string[]) => {
    if (!project) return false;
    for (const name of names.filter((name) => name.startsWith("mcp-app:")))
      await mcpWorkspace.close(name);
    const closingChildren = new Set(names.filter(isSideChatTab).map((name) => name.slice(5)));
    const paths = [
      ...names.filter((name) => name.startsWith("file:")).map((name) => name.slice(5)),
      ...panelTabs.flatMap((name) => {
        const resource = parseSideResourceTab(name);
        return resource &&
          (names.includes(name) || closingChildren.has(resource.childId)) &&
          resource.resource.startsWith("file:")
          ? [resource.resource.slice(5)]
          : [];
      }),
    ];
    if (!confirmCloseFiles(project.id, paths, project.root)) return false;
    try {
      for (const name of names.filter(isSideChatTab)) {
        const tab = sideChats.tabs.find((tab) => tab.id === name && tab.projectId === project.id);
        if (tab) {
          await sideChats.close(tab);
          removeSideTab(tab);
        }
      }
      for (const name of names) {
        const resource = parseSideResourceTab(name);
        if (resource && !names.includes(`side:${resource.childId}`))
          await sideResourceBindings.current.get(resource.childId)?.close(resource.resource);
      }
      for (const name of names.filter(isBrowserTab)) {
        await browserWorkspace.request({
          operation: "release",
          pageId: browserPageId(name),
          userIntent: true,
        });
      }
      for (const name of names.filter(isTerminalTab))
        await closeTerminal(terminalOwner(project.id, threadId), name);
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    }
    documents.forgetClosed(project.id, project.root, paths);
    return true;
  };
  const selectTab = (name: string) => {
    if (!project) return;
    const childId = isSideChatTab(name) ? name.slice(5) : parseSideResourceTab(name)?.childId;
    if (childId && !sideChats.hasChild(project.id, childId)) {
      workspacePanels.selectPanel("功能");
      return;
    }
    if (workspaceView !== "split") workspacePanels.selectLayout("panel");
    if (name === "文件") {
      showFiles();
      return;
    }
    if (name === "终端") {
      openTerminal(true);
      return;
    }
    if (name === "预览") {
      void openBrowser(true);
      return;
    }
    if (isBrowserTab(name)) {
      const pageId = browserPageId(name);
      if (pageId === undefined) return;
      const owner = panelOwner;
      workspacePanels.selectPanel(name);
      void browserWorkspace.request({ operation: "selectPage", pageId }).catch((cause) => {
        if (previewOwner.current === owner) setError(currentErrorText(cause));
      });
      return;
    }
    if (isTerminalTab(name)) {
      selectTerminal(terminalOwner(project.id, threadId), name);
      setTerminalOpen(false);
    }
    workspacePanels.selectFileTab(name);
  };
  return { canClose, selectTab, sideResourceBindings };
}
function retainedSidePanels(
  props: WorkspacePanelsProps,
  sideResourceBindings: React.RefObject<Map<string, SideResourceBinding>>,
) {
  const {
    session,
    workspacePanels,
    side,
    annotation,
    surfaces,
    taskCenterOpen,
    services,
    dark,
    setError,
  } = props;
  const { project, threadId, snapshot } = session;
  const { panel, workspaceView } = workspacePanels.view;
  const { sideChats, newSide, openSideResource, removeSideResource, removeSideTab } = side;

  const { annotationVisible } = annotation;
  const { pluginsOpen, settingsOpen } = surfaces;

  return sideChats.tabs.flatMap((tab) => {
    const owner = snapshot.projects.find((item) => item.id === tab.projectId);
    if (!owner) return [];
    const execution = owner.state?.threads?.[tab.childId];
    const ownerProject = execution?.worktree?.directory
      ? {
          ...owner,
          logicalRoot: owner.root,
          root: execution.worktree.directory,
          core: { ...owner.core, ...execution.executionCore },
          state: {
            ...owner.state,
            connected: execution.executionConnected ?? projectUserState(owner).canAct,
          },
          error: execution.executionError ?? owner.error,
        }
      : owner;
    const resource = parseSideResourceTab(panel);
    const selected =
      tab.projectId === project?.id &&
      tab.parentId === threadId &&
      !annotationVisible &&
      !pluginsOpen &&
      !settingsOpen &&
      !taskCenterOpen &&
      (panel === tab.id || resource?.childId === tab.childId);
    return [
      {
        id: tab.id,
        visible: selected,
        content: (
          <ExecutableSideChatPane
            tab={tab}
            project={ownerProject}
            projects={snapshot.projects}
            services={services}
            dark={dark}
            active={selected && workspaceView !== "conversation"}
            resource={selected ? (resource?.resource ?? "") : ""}
            executionBlocked={
              snapshot.connection?.state !== "ready" ||
              projectExecutionBlocked(snapshot.lifecycle, tab.projectId)
            }
            onNew={newSide}
            onOpenResource={(name) => openSideResource(tab, name)}
            onRemoveResource={(name) => removeSideResource(tab, name)}
            onBackToChat={() => {
              if (
                workspacePanels.isActiveOwner(`${tab.projectId}:${tab.parentId}`) &&
                sideChats.hasChild(tab.projectId, tab.childId)
              )
                workspacePanels.selectPanel(tab.id);
            }}
            onBinding={(binding) => {
              if (binding) sideResourceBindings.current.set(tab.childId, binding);
              else sideResourceBindings.current.delete(tab.childId);
            }}
            onInspectClose={() => {
              void sideChats
                .close(tab)
                .then(() => removeSideTab(tab))
                .catch((cause) => setError(currentErrorText(cause)));
            }}
          />
        ),
      },
    ];
  });
}
export function WorkspacePanels(props: WorkspacePanelsProps) {
  const {
    session,
    workspacePanels,
    side,
    documents,
    annotation,
    surfaces,
    browserWorkspace,
    mcpWorkspace,
    taskCenterOpen,
    empty,
    currentTitle,
    sidebar,
    setSidebar,
    taskActions,
    workspaceFileTree,
    panelBody,
    hidePanel,
  } = props;
  const { project, thread, threadId } = session;
  const { panel, panelTabs, previewFileTab, workspaceView } = workspacePanels.view;
  const { sideChats, canCreateSide, newSide } = side;
  const { dirtyFiles } = documents;
  const { annotationVisible, annotationTarget, annotationPending, finishImageAnnotation } =
    annotation;
  const { pluginsOpen, settingsOpen } = surfaces;

  const { t } = useI18n();
  const { canClose, selectTab, sideResourceBindings } = usePanelTabLifecycle(props);
  const retainedPanels = retainedSidePanels(props, sideResourceBindings);
  return (
    <>
      {annotationVisible &&
        annotationTarget &&
        !pluginsOpen &&
        !settingsOpen &&
        !taskCenterOpen && (
          <SidePane
            transient
            hideDisabled={annotationPending}
            workspaceKey={project?.root ?? "projectless"}
            ownerTaskId={threadId || null}
            active="图片标注"
            names={["图片标注"]}
            onSelect={() => {}}
            onChange={() => {}}
            onHide={finishImageAnnotation}
            dirtyFiles={{}}
            canClose={() => false}
            render={() => (
              <ImageAnnotationPane
                key={annotationTarget.sessionId}
                file={annotationTarget.file}
                onDone={finishImageAnnotation}
              />
            )}
          />
        )}
      {(project || sideChats.tabs.length > 0) && (
        <SidePane
          workspaceKey={project?.root ?? ""}
          ownerTaskId={threadId || null}
          active={
            project && !annotationVisible && !pluginsOpen && !settingsOpen && !taskCenterOpen
              ? panel
              : ""
          }
          names={project ? panelTabs : []}
          onNewSide={canCreateSide ? newSide : undefined}
          sideCreationUnconfirmed={
            !!project && !!thread && !!sideChats.pendingCreation(project.id, thread.id)
          }
          retainedPanels={retainedPanels}
          previewTabId={previewFileTab}
          onKeepTab={workspacePanels.keepFile}
          workspaceView={{
            mode: workspaceView,
            title: empty ? t("common.navigation.newConversation") : currentTitle,
            onChange: (mode) => {
              if (
                (panel === "旁路讨论" || isSideChatTab(panel)) &&
                mode === "split" &&
                matchMedia("(max-width: 1200px)").matches
              )
                hidePanel();
              else workspacePanels.selectLayout(mode);
            },
            actions: taskActions,
            navigation: !sidebar ? (
              <Button
                unstyled
                className="icon-button"
                aria-label={t("common.navigation.expandSidebar")}
                aria-expanded={false}
                aria-controls="areal-sidebar"
                onClick={() => setSidebar(true)}
              >
                <SidebarToggleIcon />
              </Button>
            ) : undefined,
          }}
          dirtyFiles={
            project
              ? Object.fromEntries(
                  Object.entries(dirtyFiles)
                    .filter(([key]) =>
                      key.startsWith(`${workspaceDocumentOwner(project.id, project.root)}:`),
                    )
                    .map(([key, value]) => [
                      key.slice(workspaceDocumentOwner(project.id, project.root).length + 1),
                      value,
                    ]),
                )
              : {}
          }
          canClose={canClose}
          onSelect={selectTab}
          titleFor={(name) =>
            parseSideResourceTab(name)
              ? (() => {
                  const resource = parseSideResourceTab(name)!.resource;
                  return resource.startsWith("browser:")
                    ? "浏览器"
                    : resource.startsWith("mcp-app:")
                      ? "应用"
                      : resource.startsWith("file:")
                        ? resource.slice(5).split("/").pop()
                        : resource;
                })()
              : isSideChatTab(name)
                ? t("chat.side.numbered", {
                    ordinal: sideChats.tabs.find((tab) => tab.id === name)?.ordinal ?? "",
                  })
                : name.startsWith("mcp-app:")
                  ? mcpWorkspace.titleFor(name)
                  : isBrowserTab(name)
                    ? (() => {
                        const page = browserWorkspace.pages.find(
                          (page) => page.pageId === browserPageId(name),
                        );
                        let title = page?.title;
                        if (!title && page?.url) {
                          try {
                            title = new URL(page.url).host;
                          } catch {
                            title = page.url;
                          }
                        }
                        return (
                          (title || "新标签页") +
                          (page?.resource === "suspended" ? " · 已暂停" : "")
                        );
                      })()
                    : name.startsWith("agent:")
                      ? agentAssignment(thread ?? {}, name.slice(6)) || agentName(name.slice(6))
                      : isTerminalTab(name)
                        ? terminalTitle(
                            terminalOwner(project?.id ?? "", threadId),
                            name,
                            project?.root ?? "",
                          )
                        : undefined
          }
          onChange={(tabs) =>
            workspacePanels.replaceTabs(
              tabs,
              (childId) => !!project && sideChats.hasChild(project.id, childId),
            )
          }
          onHide={hidePanel}
          auxiliary={panel === "文件" ? workspaceFileTree : undefined}
          render={panelBody}
        />
      )}
    </>
  );
}
