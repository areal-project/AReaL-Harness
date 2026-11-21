import { lazy, Suspense, type ComponentProps } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
const Content = lazy(() =>
  import("./WorkspacePanelContent.js").then((module) => ({
    default: module.WorkspacePanelContent,
  })),
);
export function WorkspacePanelContent(
  props: ComponentProps<typeof import("./WorkspacePanelContent.js").WorkspacePanelContent>,
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
