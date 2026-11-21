import { lazy, Suspense, type ComponentProps } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
const loadWorkbenchSettings = () => import("./WorkbenchSettings.js");
export function preloadWorkbenchSettings() {
  void loadWorkbenchSettings();
}
const Content = lazy(() =>
  loadWorkbenchSettings().then((module) => ({ default: module.WorkbenchSettings })),
);
export function WorkbenchSettings(
  props: ComponentProps<typeof import("./WorkbenchSettings.js").WorkbenchSettings>,
) {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <div className="settings-empty" role="status">
          {t("common.loading")}
        </div>
      }
    >
      <Content {...props} />
    </Suspense>
  );
}
