import { useState } from "react";
import type { Action, Data } from "../services.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { BrowserSettings } from "../settings/BrowserSettings.js";
import { CloudSettings } from "../settings/CloudSettings.js";
import { ComputerSettings } from "../settings/ComputerSettings.js";
import { AppearanceSettings, GeneralSettings } from "../settings/DisplaySettings.js";
import { HooksSettings } from "../settings/HooksSettings.js";
import { MobileSettings } from "../settings/MobileSettings.js";
import { ModelSettings } from "../settings/ModelSettings.js";
import { SessionSettings } from "../settings/ResourceSettings.js";
import { TrajectorySettings } from "../settings/TrajectorySettings.js";
import { UsageDashboard } from "../settings/UsageDashboard.js";
import { WorktreesSettings } from "../settings/WorktreesSettings.js";
import { SnapShotSettings } from "../snapshots/SnapShotSettings.js";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import { settingsLabel, settingsSubtitle } from "../settings/settingsNavigation.js";

// 设置页示例：各页接真实组件，数据由示例后台回答。
export function SpecSettingsPage({
  tab,
  action,
  project,
}: {
  tab: string;
  action: Action;
  project: Data;
}) {
  const { t } = useI18n();
  const [theme, setTheme] = useState("system");
  const [fontSize, setFontSize] = useState(13);
  return (
    <SettingsPage key={tab} title={settingsLabel(tab, t)} subtitle={settingsSubtitle(tab, t)}>
      {tab === "外观" ? (
        <AppearanceSettings
          theme={theme}
          setTheme={setTheme}
          fontSize={fontSize}
          setFontSize={setFontSize}
        />
      ) : tab === "常规" ? (
        <GeneralSettings
          connected
          action={(async () => ({})) as Action}
          menuBar={{ supported: true, active: true, error: null }}
          projectlessDirectory="~/AReaL"
          chooseProjectlessDirectory={async () => null}
          fileOpen={async () => ({
            targets: [{ id: "system", label: "系统默认" }],
            preferred: "system",
            preferredLabel: "系统默认",
          })}
        />
      ) : tab === "用量" ? (
        <UsageDashboard action={action} />
      ) : tab === "SnapShots" ? (
        <SnapShotSettings action={action} connected />
      ) : tab === "浏览器" ? (
        <BrowserSettings action={action} connected />
      ) : tab === "Cloud" ? (
        <CloudSettings action={action} />
      ) : tab === "电脑控制" ? (
        <ComputerSettings action={action} connected />
      ) : tab === "Worktrees" ? (
        <WorktreesSettings action={action} projects={[project]} />
      ) : tab === "钩子" ? (
        <HooksSettings action={action} connected onConnect={async () => {}} />
      ) : tab === "模型服务" ? (
        <ModelSettings action={action} onOpenSessionSettings={() => {}} />
      ) : tab === "会话配置" ? (
        <SessionSettings project={project} action={action} />
      ) : tab === "手机连接" ? (
        <MobileSettings action={action} projects={[project]} />
      ) : tab === "数据飞轮" ? (
        <TrajectorySettings action={action} connected onStatus={() => {}} />
      ) : null}
    </SettingsPage>
  );
}
