import { useState } from "react";
import type { Action } from "../services.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { AppearanceSettings, GeneralSettings } from "../settings/DisplaySettings.js";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import { settingsLabel } from "../settings/settingsNavigation.js";

// 设置页示例：只接常规与外观两页，其余页只有标题。
export function SpecSettingsPage({ tab }: { tab: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState("system");
  const [fontSize, setFontSize] = useState(13);
  return (
    <SettingsPage key={tab} title={settingsLabel(tab, t)}>
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
      ) : null}
    </SettingsPage>
  );
}
