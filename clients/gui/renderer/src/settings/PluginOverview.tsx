import type { PluginPresentation } from "./pluginPresentation.js";
import { useI18n, type MessageId } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";

const states: Record<PluginPresentation["state"], MessageId> = {
  unknown: "settings.pluginCenter.operationResultUnconfirmed",
  working: "settings.pluginCenter.processing",
  notInstalled: "settings.pluginCenter.notInstalled",
  disabled: "settings.pluginCenter.disabledInCurrentProject",
  blocked: "operations.blockedSnapshot",
  notObserved: "settings.pluginCenter.runtimeNotObservedTitle",
  configure: "settings.pluginConnectionPanel.connectionConfigurationRequired",
  partial: "settings.pluginCenter.partiallyAvailable",
  authenticate: "settings.pluginConnectionPanel.authenticationRequired",
  authenticationPending: "settings.pluginConnectionPanel.waitingForAuthentication",
  reviewMcp: "settings.pluginConnectionPanel.waitingToConnect",
  available: "settings.pluginCenter.declaredComponentsAvailable",
};
const actions: Partial<Record<PluginPresentation["nextAction"], MessageId>> = {
  connectProject: "settings.pluginCenter.connectProjectBackend",
  chooseProject: "settings.pluginCenter.chooseProjectToInstall",
  queryOriginal: "settings.pluginCenter.checkPluginSubmission",
  install: "settings.pluginCenter.reviewInstallation",
  enable: "settings.pluginCenter.enablePlugin",
  components: "operations.viewRequirements",
  refresh: "settings.pluginCenter.refreshSnapshot",
  configure: "settings.pluginConnectionPanel.connectionConfigurationRequired",
  connections: "settings.pluginConnectionPanel.pluginConnectionStatus",
};
export function PluginOverview({
  presentation,
  onNext,
  disabled,
}: {
  presentation: PluginPresentation;
  onNext: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const action = actions[presentation.nextAction];
  return (
    <section className="plugin-status-panel" aria-label={t("settings.pluginCenter.pluginOverview")}>
      <h2>{t(states[presentation.state])}</h2>
      <p className="plugin-status-description">
        {t(
          presentation.state === "notObserved"
            ? "settings.pluginCenter.runtimeNotObserved"
            : "settings.pluginCenter.componentFactsRemainIndependent",
        )}
      </p>
      {presentation.skillsAvailable && (
        <p>{t("settings.pluginCenter.skillsInstalledAndEnabled")}</p>
      )}
      {presentation.hookReviewRequired && (
        <p>{t("settings.pluginCenter.hooksRequireSeparateReview")}</p>
      )}
      {action && (
        <Button disabled={disabled} onClick={onNext}>
          {t(action)}
        </Button>
      )}
    </section>
  );
}
