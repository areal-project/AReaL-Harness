import type { ComponentProps } from "react";
import { SettingsNavigation as View } from "@areal/ui/wip";
import { useI18n } from "../i18n/IntlProvider.js";
import { useNavigationBusy } from "./UnsavedChanges.js";
import { NavigationBackIcon, NavigationForwardIcon } from "../interfaceIcons.js";
import "./SettingsWorkspace.css";
import "@areal/ui/workbench.css";
export type { SettingsNavigationGroup } from "@areal/ui/wip";
export { SettingsPage } from "@areal/ui/wip";
export function SettingsNavigation(props: Omit<ComponentProps<typeof View>, "labels" | "locale" | "navigationBusy" | "backIcon" | "forwardIcon">) { const { t, locale } = useI18n(); const navigationBusy = useNavigationBusy(); return <View {...props} locale={locale} navigationBusy={navigationBusy} backIcon={<NavigationBackIcon size={16} />} forwardIcon={<NavigationForwardIcon size={16} />} labels={{ back: t("settings.settingsWorkspace.backToApp"), forward: t("settings.settingsWorkspace.forward"), title: t("settings.settingsWorkspace.settings"), search: t("settings.settingsWorkspace.searchSettings"), searchPlaceholder: t("settings.settingsWorkspace.search"), clear: t("settings.settingsWorkspace.clearSettingsSearch"), navigation: t("settings.settingsWorkspace.settingsNavigation"), empty: t("settings.settingsWorkspace.noMatchingSettings") }} />; }
