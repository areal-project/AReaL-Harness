import { lazy, Suspense, type ComponentProps } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
const Content = lazy(() =>
  import("./WorkbenchSettings.js").then((module) => ({ default: module.WorkbenchSettings })),
);
export function WorkbenchSettings(
  props: ComponentProps<typeof import("./WorkbenchSettings.js").WorkbenchSettings>,
) {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
      <Content {...props} />
    </Suspense>
  );
}
