import type { ComponentProps } from "react";
import { SettingsValueAction as Value, SettingsSelect as Select } from "@areal/ui/wip";
import { useI18n } from "../i18n/IntlProvider.js";
import "./SettingsPageParts.css";
export { SettingsSection, SettingsRow, SettingsGroupCard, SettingsLockedValue, SettingsBadge, SettingsSwitch } from "@areal/ui/wip";
export function SettingsValueAction(props: ComponentProps<typeof Value>) { const { t } = useI18n(); return <Value actionLabel={t("settings.settingsPageParts.change")} {...props} />; }
export function SettingsSelect(props: ComponentProps<typeof Select>) { const { t } = useI18n(); return <Select placeholder={t("settings.settingsPageParts.selectAnOption")} emptyLabel={t("settings.settingsPageParts.noOptionsAvailable")} {...props} />; }
