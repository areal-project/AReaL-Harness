import { useI18n, type MessageId } from "../i18n/IntlProvider.js";
import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui/button.js";
import type { Data } from "../services.js";

const methods: Record<string, { label: MessageId; description: MessageId }> = {
  apiKey: {
    label: "settings.connectionMethodPicker.useApiKey",
    description: "settings.connectionMethodPicker.apiBillingSavedOnDevice",
  },
  none: {
    label: "settings.connectionMethodPicker.noAuthentication",
    description: "settings.connectionMethodPicker.localOrCompatibleService",
  },
  siwc: {
    label: "settings.connectionMethodPicker.useChatgptSubscription",
    description: "settings.connectionMethodPicker.subscriptionBillingBrowserAuthorization",
  },
};
export function ConnectionMethodPicker({
  definition,
  onBack,
  onSelect,
  disabled,
}: {
  definition: Data;
  onBack: () => void;
  onSelect: (method: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <section
      className="provider-picker"
      aria-label={t("settings.connectionMethodPicker.chooseConnectionMethod")}
    >
      <div className="provider-picker-heading">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("settings.connectionMethodPicker.backToProviderSelection")}
          disabled={disabled}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <h2>
          {t("settings.connectionMethodPicker.providerConnectionMethod", {
            provider: definition.name,
          })}
        </h2>
      </div>
      <div className="provider-method-list">
        {(definition.authMethods ?? ["apiKey", "none"]).map((method: string) => (
          <Button
            key={method}
            variant="outline"
            size="auto"
            align="start"
            wrap
            disabled={disabled}
            className="w-full min-w-0"
            onClick={() => onSelect(method)}
          >
            <span className="provider-method-copy">
              <strong>{methods[method] ? t(methods[method].label) : method}</strong>
              <small>{methods[method] ? t(methods[method].description) : ""}</small>
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
