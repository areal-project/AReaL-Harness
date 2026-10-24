import type { ComponentProps } from "react";
import { WorkSurface as Surface, NavigationSidebar as Sidebar } from "@areal/ui/wip";
import { useI18n } from "../i18n/IntlProvider.js";
import { useReducedMotion } from "../settings/applicationPreferences.js";
import "@areal/ui/workbench.css";
export { WorkbenchShell, WorkspaceHeader } from "@areal/ui/wip";
export function WorkSurface(props: ComponentProps<typeof Surface>) { const reducedMotion = useReducedMotion(); return <Surface reducedMotion={reducedMotion} {...props} />; }
export function NavigationSidebar(props: ComponentProps<typeof Sidebar>) { const { t } = useI18n(); return <Sidebar resizeLabel={t("common.resizeSidebar")} {...props} />; }
