import { PluginCenter } from "../settings/PluginCenter.js";
import type { useSessionNavigation } from "../state/useSessionNavigation.js";
import type { useWorkbenchNavigation } from "../state/useWorkbenchNavigation.js";
import type { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
export function WorkbenchPlugins({
  session,
  surfaces,
  navigationCommands,
}: {
  session: ReturnType<typeof useSessionNavigation>;
  surfaces: ReturnType<typeof useWorkbenchSurfaces>;
  navigationCommands: ReturnType<typeof useWorkbenchNavigation>;
}) {
  const { project, snapshot, thread, threadId, resourceAction } = session;
  const {
    pluginCenterActive,
    pluginSettingsOpen,
    pluginMarketRequest,
    settingsTab,
    pluginTaskOrigin,
    returnToPluginTask,
  } = surfaces;
  const { open, choose, startResourceDraft } = navigationCommands;
  return (
    <PluginCenter
      active={pluginCenterActive}
      marketRequest={pluginMarketRequest}
      surface={pluginSettingsOpen ? "settings" : "workspace"}
      initialTab={settingsTab === "Skills" ? "skills" : settingsTab === "MCP" ? "mcp" : "plugins"}
      project={project}
      projects={snapshot.projects}
      thread={thread}
      action={resourceAction}
      onOpenThread={(pid, tid) => {
        surfaces.leavePlugins();
        surfaces.leaveSettings();
        void open(pid, tid);
      }}
      onSettings={() => {
        surfaces.openPluginSettings();
      }}
      onMarket={(preserveDetail) => {
        surfaces.openMarketplace(preserveDetail);
      }}
      onChooseProject={() => void choose()}
      onSelectProject={(id) => {
        session.selectProject(id);
      }}
      onReturnToTask={pluginTaskOrigin ? () => returnToPluginTask() : undefined}
      onRunCommand={
        thread?.id && project
          ? async (command) => {
              await resourceAction("send", {
                projectId: project.id,
                threadId,
                text: "",
                command,
                requestId: crypto.randomUUID(),
              });
              returnToPluginTask({ projectId: project.id, threadId });
            }
          : undefined
      }
      onStartDraft={startResourceDraft}
    />
  );
}
