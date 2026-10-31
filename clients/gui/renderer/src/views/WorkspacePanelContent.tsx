import React from "react";
import { AgentHistoryPane } from "../AgentHistoryPane.js";
import { browserPageId, isBrowserTab } from "../app-shell/useBrowserWorkspace.js";
import { ContextPane } from "../ContextPane.js";
import { createCorePanels } from "../CorePanels.js";
import { ExecutionsPane } from "../ExecutionsPane.js";
import { GitPane } from "../GitPane.js";
import { GoalEditor } from "../Goal.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { useMcpAppsWorkspace } from "../McpAppsWorkspace.js";
import { ModelTrajectoryPane } from "../ModelTrajectoryPane.js";
import { PlanPane } from "../PlanPane.js";
import { Preview } from "../Preview.js";
import { ProcessesPane } from "../ProcessesPane.js";
import { Queue } from "../Queue.js";
import { SavedPermissionsPane } from "../SavedPermissionsPane.js";
import { type Action, type Data, type PlatformServices } from "../services.js";
import { McpAppEntrypoints } from "../settings/McpAppsSettings.js";
import { McpSettings, TaskSkillsSettings } from "../settings/ResourceSettings.js";
import { SideChatPane } from "../SideChatPane.js";
import { projectExecutionBlocked } from "../state/projectExecution.js";
import type { usePanelNavigation } from "../state/usePanelNavigation.js";
import type { useSessionNavigation } from "../state/useSessionNavigation.js";
import type { useWorkbenchNavigation } from "../state/useWorkbenchNavigation.js";
import type { useWorkspaceDocuments } from "../state/useWorkspaceDocuments.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
import type { useWorkspacePreview } from "../state/useWorkspacePreview.js";
import { isTerminalTab } from "../terminal/terminalWorkspace.js";
import { isSideChatTab, parseSideResourceTab } from "../useSideChatTabs.js";
import { ConversationUsage } from "../views/ConversationUsage.js";
import { WorkgroupsPane } from "../WorkgroupsPane.js";
import { WorkspaceFilePane, workspaceDocumentOwner } from "../WorkspaceFilePane.js";

type WorkspacePanelProps = {
  panel: string;
  session: ReturnType<typeof useSessionNavigation>;
  services: PlatformServices;
  action: Action;
  mcpWorkspace: ReturnType<typeof useMcpAppsWorkspace>;
  workspacePanels: ReturnType<typeof useWorkspacePanels>;
  preview: ReturnType<typeof useWorkspacePreview>;
  panelNavigation: ReturnType<typeof usePanelNavigation>;
  navigationCommands: ReturnType<typeof useWorkbenchNavigation>;
  documents: ReturnType<typeof useWorkspaceDocuments>;
  dark: boolean;
  setError: (message: string) => void;
  workspaceFileTree: React.ReactNode;
  pending: boolean | undefined;
  admitting: boolean;
  currentTitle: string;
};
const panels = createCorePanels(React);
const TerminalPane = React.lazy(async () => {
  const { TerminalPane } = await import("../terminal/TerminalPane.js");
  return { default: TerminalPane };
});
export function WorkspacePanelContent({
  panel,
  session,
  services,
  action,
  mcpWorkspace,
  workspacePanels,
  preview,
  panelNavigation,
  navigationCommands,
  documents,
  dark,
  setError,
  workspaceFileTree,
  pending,
  admitting,
  currentTitle,
}: WorkspacePanelProps) {
  const { project, thread, threadId, snapshot, library, resourceAction, contextualFileOpen } =
    session;
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  const { browserWorkspace, openBrowser, onLink, rememberPanelTrigger } = preview;
  const { showPanel, hidePanel } = panelNavigation;
  const { open } = navigationCommands;
  const { openFile, dirtyFiles, reviewRequest, requestReview: setReviewRequest } = documents;
  const { filesOpen } = workspacePanels.view;
  const queue = project?.state?.queues[threadId];
  const { t } = useI18n();

  if (!project) return null;
  const props = { project, thread, action };
  if (panel.startsWith("mcp-app:")) return mcpWorkspace.render(panel);
  if (
    (panel === "旁路讨论" || panel === "历史旁路讨论") &&
    thread &&
    project.core?.features?.sidePreview === true &&
    !thread.parentThreadId &&
    thread.conversation?.kind !== "side"
  ) {
    return (
      <SideChatPane
        onPanel={showPanel}
        onReturn={hidePanel}
        key={`${project.core?.instanceId}:${project.id}:${thread.id}:side`}
        project={project}
        source={thread}
        executionBlocked={projectExecutionBlocked(snapshot.lifecycle, project.id)}
        action={resourceAction}
        dark={dark}
      />
    );
  }
  if (isSideChatTab(panel) || parseSideResourceTab(panel)) return null;
  if ((panel === "子代理" || panel.startsWith("agent:")) && thread) {
    const childId = panel.startsWith("agent:") ? panel.slice(6) : undefined;
    const parent = childId && project.state?.threads[childId]?.parentThreadId;
    const ownerThread = (parent && project.state?.threads[parent]) || thread;
    return (
      <AgentHistoryPane
        key={`${panelOwner}:${panel}`}
        project={project}
        thread={ownerThread}
        initialId={childId}
        action={resourceAction}
        dark={dark}
        onLink={onLink}
        onFile={openFile}
        onClose={hidePanel}
        onAgent={(id) => showPanel(`agent:${id}`)}
        onReview={(id, turnId) => {
          setReviewRequest({ owner: panelOwner, threadId: id, turnId });
          showPanel("改动");
        }}
      />
    );
  }
  if (panel === "编辑目标" && thread)
    return (
      <GoalEditor
        key={`${project.id}:${thread.id}:${thread.goals?.goal?.id ?? "new"}`}
        project={project}
        thread={thread}
        action={resourceAction}
      />
    );
  if (panel.startsWith("file:"))
    return (
      <div className="flex h-full min-h-0 flex-col">
        {threadId && (
          <McpAppEntrypoints
            servers={mcpWorkspace.servers}
            loadMetadataImage={mcpWorkspace.loadMetadataImage}
            kind="file"
            fileName={panel.slice(5)}
            onOpen={(server, tool) => {
              if (
                dirtyFiles[`${workspaceDocumentOwner(project.id, project.root)}:${panel.slice(5)}`]
              ) {
                setError("请先保存当前文件，再用应用打开。");
                return;
              }
              void mcpWorkspace
                .openApp(server, tool, { kind: "file", filePath: panel.slice(5) })
                .catch((cause) => setError(cause.message));
            }}
          />
        )}
        <WorkspaceFilePane
          key={`${project.id}:${project.root}:${panel}`}
          projectId={project.id}
          root={project.root}
          path={panel.slice(5)}
          action={action}
          onDirty={(path, dirty) => {
            documents.markDirty(project.id, project.root, path, dirty);
          }}
          onLink={onLink}
          fileOpen={contextualFileOpen}
          preferredFileOpenTarget={library.settings?.fileOpenTarget}
          filesOpen={filesOpen}
          onToggleFiles={workspacePanels.toggleFiles}
          tree={workspaceFileTree}
        />
      </div>
    );
  if (panel === "文件")
    return <div className="file-preview-empty">{t("common.files.selectPreview")}</div>;
  if (panel === "改动") {
    const reviewedId =
      (reviewRequest?.owner === panelOwner ? (reviewRequest.threadId ?? threadId) : threadId) ||
      "new";
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
        commentsDisabled={
          !!(
            reviewRequest?.owner === panelOwner &&
            reviewRequest.threadId &&
            reviewRequest.threadId !== threadId
          ) ||
          !project.state?.connected ||
          !!thread?.desktop?.archived ||
          !!(thread?.source === "nativeTaskAgent" && thread?.goalOwner) ||
          !!pending ||
          admitting ||
          (!!threadId && !thread)
        }
        filesOpen={filesOpen}
        onToggleFiles={workspacePanels.toggleFiles}
        onReveal={workspacePanels.revealFile}
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
        onReview={(turnId) => {
          rememberPanelTrigger();
          setReviewRequest({ owner: panelOwner, turnId });
          workspacePanels.selectPanel("改动");
        }}
        onTool={(itemId) => {
          workspacePanels.selectLayout("split");
          requestAnimationFrame(() =>
            document
              .querySelector(`[data-tool-id="${CSS.escape(itemId)}"]`)
              ?.scrollIntoView({ block: "center" }),
          );
        }}
        onError={setError}
      />
    );
  if (panel === "工作组")
    return <WorkgroupsPane key={project.id} project={project} action={resourceAction} />;
  if (!thread) return <div className="utility-content">{t("common.tasks.select")}</div>;
  const threadProps = { project, thread, action };
  if (panel === "执行计划")
    return <PlanPane key={`${project.id}:${threadId}`} {...threadProps} action={resourceAction} />;
  if (panel === "已保存授权")
    return (
      <SavedPermissionsPane
        key={`${project.id}:${threadId}`}
        {...threadProps}
        action={resourceAction}
      />
    );
  if (panel === "上下文")
    return (
      <ContextPane key={`${project.id}:${threadId}`} {...threadProps} action={resourceAction} />
    );
  if (panel === "进程")
    return (
      <ProcessesPane
        key={`${project.id}:${threadId}`}
        {...threadProps}
        action={resourceAction}
        onOpenService={(url) => {
          void openBrowser(false, url);
        }}
      />
    );
  if (panel === "Skills")
    return (
      <div className="utility-content">
        <TaskSkillsSettings
          key={`${project.id}:${threadId}`}
          {...threadProps}
          action={resourceAction}
        />
      </div>
    );
  if (panel === "调用轨迹")
    return (
      <ModelTrajectoryPane
        key={`${project.id}:${threadId}`}
        thread={thread}
        title={currentTitle}
        projectId={project.id}
        action={resourceAction}
        refresh={() => resourceAction("open", { projectId: project.id, threadId })}
        onClose={() => workspacePanels.selectPanel("")}
      />
    );
  if (panel === "子任务")
    return (
      <ExecutionsPane
        key={`${project.id}:${threadId}`}
        {...threadProps}
        action={resourceAction}
        onOpen={(id) =>
          id === thread.parentThreadId ? void open(project.id, id) : showPanel(`agent:${id}`)
        }
      />
    );
  if (panel === "用量") return <ConversationUsage thread={thread} />;
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
      <React.Suspense
        fallback={
          <p role="status" className="p-3 text-ui-base text-foreground-subtle">
            {t("common.loading")}
          </p>
        }
      >
        <TerminalPane
          key={`${project.id}:${threadId}:${panel}`}
          {...threadProps}
          terminalId={panel}
          canStart={!admitting && !pending && !!project.state?.connected}
          onError={setError}
          onLink={onLink}
        />
      </React.Suspense>
    );
  return null;
}
