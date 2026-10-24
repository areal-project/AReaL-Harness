import type { ComponentProps } from "react";
import { SettingsDisclosure as View } from "@areal/ui/wip";
import { useI18n } from "../i18n/IntlProvider.js";
export function SettingsDisclosure(props: ComponentProps<typeof View>) { const { t } = useI18n(); return <View expandLabel={t("settings.settingsDisclosure.expand")} collapseLabel={t("settings.settingsDisclosure.collapse")} {...props} />; }
