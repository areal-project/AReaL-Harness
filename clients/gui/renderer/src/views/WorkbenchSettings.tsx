import { lazy, Suspense, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Action, PlatformServices } from "../services.js";
import { BrowserSettings } from "../settings/BrowserSettings.js";
import { CloudSettings } from "../settings/CloudSettings.js";
import { ComputerSettings } from "../settings/ComputerSettings.js";
import { CreationRecoverySettings } from "../settings/CreationRecoverySettings.js";
import { CoreCapabilitiesSettings } from "../settings/CoreCapabilitiesSettings.js";
import { AppearanceSettings, GeneralSettings } from "../settings/DisplaySettings.js";
import { HooksSettings } from "../settings/HooksSettings.js";
import { MobileSettings } from "../settings/MobileSettings.js";
import { ModelSettings } from "../settings/ModelSettings.js";
import { SessionSettings } from "../settings/ResourceSettings.js";
import { ServiceStatusSettings } from "../settings/ServiceStatusSettings.js";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import { TrajectorySettings } from "../settings/TrajectorySettings.js";
import { WorktreesSettings } from "../settings/WorktreesSettings.js";
import { settingsLabel } from "../settings/settingsNavigation.js";
import type { useTaskWorkspace } from "../state/taskWorkspace.js";
import type { useBackendRecovery } from "../state/useBackendRecovery.js";
import type { useSessionNavigation } from "../state/useSessionNavigation.js";
import type { useWorkbenchAppearance } from "../state/useWorkbenchAppearance.js";
import type { useWorkbenchNavigation } from "../state/useWorkbenchNavigation.js";
import type { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
import type { useWorkspacePanels } from "../state/useWorkspacePanels.js";

const UsageDashboard = lazy(() =>
  import("../settings/UsageDashboard.js").then((module) => ({ default: module.UsageDashboard })),
);

type Props = {
  session: ReturnType<typeof useSessionNavigation>;
  surfaces: ReturnType<typeof useWorkbenchSurfaces>;
  tasks: ReturnType<typeof useTaskWorkspace>["workspace"];
  workspacePanels: ReturnType<typeof useWorkspacePanels>;
  navigationCommands: ReturnType<typeof useWorkbenchNavigation>;
  services: PlatformServices;
  action: Action;
  appearance: ReturnType<typeof useWorkbenchAppearance>;
  backend: ReturnType<typeof useBackendRecovery>;
  reconnectService: () => Promise<void>;
  initialReleased: boolean;
  panelBody: (name: string) => ReactNode;
};
export function WorkbenchSettings({
  session,
  surfaces,
  tasks,
  workspacePanels,
  navigationCommands,
  services,
  action,
  appearance,
  backend,
  reconnectService,
  initialReleased,
  panelBody,
}: Props) {
  const { snapshot, project, thread, projects, resourceAction, contextualFileOpen, setSnapshot } =
    session;
  const { settingsTab, setSettingsTab, worktreeSettingsTarget, onTrajectoryStatus } = surfaces;
  const { choose, open } = navigationCommands;
  const onTask = (projectId: string, taskId: string) => {
    surfaces.leaveSettings();
    tasks.openTarget({ projectId, taskId });
  };
  const onOpen = (pid: string, tid: string, panelName?: string) => {
    surfaces.leaveSettings();
    void open(pid, tid).then(() => {
      if (panelName) workspacePanels.selectPanel(panelName);
    });
  };
  const { t } = useI18n();
  const library = snapshot.library ?? {};
  const { theme, setTheme, uiFontSize, setUiFontSize } = appearance;
  const { backendActionPending, backendActionError, runBackendAction } = backend;
  return (
    <SettingsPage
      key={settingsTab}
      className={
        ["插件", "Skills", "MCP"].includes(settingsTab)
          ? "plugins-settings-page"
          : settingsTab === "模型服务"
            ? "model-settings-page"
            : undefined
      }
      title={settingsLabel(settingsTab, t)}
      subtitle={settingsTab === "浏览器" ? t("settings.browser.subtitle") : undefined}
    >
      {settingsTab === "外观" ? (
        <AppearanceSettings
          theme={theme}
          setTheme={setTheme}
          fontSize={uiFontSize}
          setFontSize={setUiFontSize}
        />
      ) : settingsTab === "常规" ? (
        <GeneralSettings
          settings={library.settings}
          power={snapshot.power}
          menuBar={snapshot.menuBar}
          projectlessDirectory={snapshot.projectless?.directory}
          chooseProjectlessDirectory={services.chooseProjectlessDirectory}
          fileOpen={contextualFileOpen}
          action={resourceAction}
          connected={snapshot.connection?.state === "ready"}
        />
      ) : settingsTab === "浏览器" ? (
        <BrowserSettings
          settings={library.settings}
          action={resourceAction}
          connected={snapshot.connection?.state === "ready"}
        />
      ) : settingsTab === "Cloud" ? (
        <CloudSettings action={resourceAction} />
      ) : settingsTab === "电脑控制" ? (
        <ComputerSettings
          settings={library.settings}
          action={resourceAction}
          connected={snapshot.connection?.state === "ready"}
        />
      ) : settingsTab === "Worktrees" ? (
        <WorktreesSettings
          onAddProject={async () => {
            const id = await services.chooseProject();
            if (id) setSnapshot(await services.snapshot());
            return id || undefined;
          }}
          action={resourceAction}
          projects={projects}
          initialProjectId={worktreeSettingsTarget.projectId}
          initialTab={worktreeSettingsTarget.tab}
        />
      ) : settingsTab === "钩子" ? (
        <HooksSettings
          action={resourceAction}
          connected={snapshot.connection?.state === "ready"}
          onConnect={reconnectService}
        />
      ) : settingsTab === "模型服务" ? (
        <ModelSettings
          action={action}
          subscription={snapshot.subscription}
          onOpenSessionSettings={() => setSettingsTab("会话配置")}
        />
      ) : settingsTab === "会话配置" ? (
        <SessionSettings
          key={`${project?.id}:${thread?.id}`}
          project={project}
          thread={thread}
          action={resourceAction}
        />
      ) : settingsTab === "手机连接" ? (
        <MobileSettings action={resourceAction} projects={snapshot.projects} />
      ) : settingsTab === "数据飞轮" ? (
        <TrajectorySettings
          action={resourceAction}
          connected={snapshot.connection?.state === "ready"}
          onStatus={onTrajectoryStatus}
        />
      ) : settingsTab === "后台服务" ? (
        <>
          <ServiceStatusSettings
            backendStatus={{
              connection: snapshot.connection,
              update: snapshot.backendUpdate,
              lifecycle: snapshot.lifecycle,
              summary: snapshot.serviceSummary,
              currentCommands:
                snapshot.desktopCapabilities?.currentCommands ??
                project?.desktopCapabilities?.currentCommands,
              pending: backendActionPending,
              error: backendActionError,
              detail: project?.error || project?.state?.error,
              onAction: (kind) => void runBackendAction(kind),
            }}
            recovery={snapshot.lifecycle?.recovery}
            runningState={snapshot.serviceSummary?.state}
            connected={snapshot.connection?.state === "ready"}
            action={resourceAction}
            onConnect={reconnectService}
            onTask={initialReleased ? onTask : undefined}
            onOpen={initialReleased ? onOpen : undefined}
          />
          <CreationRecoverySettings
            projects={snapshot.projects}
            connected={snapshot.connection?.state === "ready"}
            action={resourceAction}
          />
          <CoreCapabilitiesSettings
            projects={snapshot.projects}
            connected={snapshot.connection?.state === "ready"}
          />
        </>
      ) : settingsTab === "用量" ? (
        <Suspense fallback={<div className="settings-empty">{t("common.loading")}</div>}>
          <UsageDashboard action={resourceAction} />
        </Suspense>
      ) : !project ? (
        <div className="settings-empty">
          <p>{t("settings.chooseProject")}</p>
          <Button unstyled onClick={() => void choose()}>
            {t("settings.openProject")}
          </Button>
        </div>
      ) : (
        panelBody(settingsTab)
      )}
    </SettingsPage>
  );
}
