import { useState } from "react";
import type { Action, Data } from "../services.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { BrowserSettings } from "../settings/BrowserSettings.js";
import { CloudSettings } from "../settings/CloudSettings.js";
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
      {tab === "appearance" ? (
        <AppearanceSettings
          theme={theme}
          setTheme={setTheme}
          fontSize={fontSize}
          setFontSize={setFontSize}
        />
      ) : tab === "general" ? (
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
      ) : tab === "usage" ? (
        <UsageDashboard action={action} />
      ) : tab === "SnapShots" ? (
        <SnapShotSettings action={action} connected />
      ) : tab === "browser" ? (
        <BrowserSettings action={action} connected />
      ) : tab === "Cloud" ? (
        <CloudSettings action={action} />
      ) : tab === "Worktrees" ? (
        <WorktreesSettings action={action} projects={[project]} />
      ) : tab === "hooks" ? (
        <HooksSettings action={action} connected onConnect={async () => {}} />
      ) : tab === "providers" ? (
        <ModelSettings action={action} />
      ) : tab === "session" ? (
        <SessionSettings project={project} action={action} />
      ) : tab === "mobile" ? (
        <MobileSettings action={action} projects={[project]} />
      ) : tab === "trajectory" ? (
        <TrajectorySettings action={action} connected onStatus={() => {}} />
      ) : null}
    </SettingsPage>
  );
}
