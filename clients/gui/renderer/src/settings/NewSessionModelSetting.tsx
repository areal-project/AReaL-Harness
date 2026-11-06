import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useI18n } from "../i18n/IntlProvider.js";
import { useEffect } from "react";
import { SettingsSelect } from "./SettingsPageParts.js";
import { Feedback, useResource } from "./common.js";
import { useSettingsOperation } from "./useSettingsOperation.js";
import type { Action, CommandParams, Data } from "../services.js";

/** Application default; current-thread configuration remains owned by SessionSettings. */
export function NewSessionModelSetting({
  action,
  disabled,
  onBusyChange,
  compact = false,
}: {
  action: Action;
  disabled: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** 模型设置页底部只放这一行，配置供应商和选默认模型在同一页完成。 */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const api = <P extends CommandParams<"providers">>(request: P) => action("providers", request);
  const catalog = useResource(() => api({ operation: "list" }), "application");
  const subscription = useResource(
    () => action("chatgpt", { operation: "status", provider: "openai" }),
    "chatgpt-subscription-openai",
  );
  const { busy, error, run } = useSettingsOperation();
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const options = [
    ...(subscription.value?.authenticated ? (subscription.value.models ?? []) : []).map(
      (model: Data) => ({
        providerId: "areal_openai",
        modelId: model.id,
        label: model.displayName || model.name || model.id,
      }),
    ),
    ...(catalog.value?.data ?? [])
      .filter((provider: Data) => provider.enabled)
      .flatMap((provider: Data) =>
        provider.models
          .filter((model: Data) => model.enabled)
          .map((model: Data) => ({
            providerId: provider.id,
            modelId: model.id,
            label: model.displayName || model.id,
          })),
      ),
  ];
  const overrides = Object.entries(catalog.value?.effective?.sources ?? {}).filter(
    ([field, source]) =>
      field.startsWith("model.") && ["env", "cli"].includes((source as Data).kind),
  );
  const current = catalog.value?.defaultModel;
  const value = current ? `${current.providerId}/${current.modelId}` : "";
  const row = (
    <SettingsRow
      label={t("settings.newSessionModelSetting.fallbackDefaultModel")}
      control={
        <SettingsSelect
          aria-label={t("settings.newSessionModelSetting.fallbackDefaultModel")}
          value={value}
          disabled={disabled || busy || catalog.loading || subscription.loading || !options.length}
          onValueChange={(next) => {
            const choice = options.find(
              (option) => `${option.providerId}/${option.modelId}` === next,
            );
            if (!choice || next === value) return;
            void run(async () => {
              try {
                catalog.accept(
                  await api({
                    operation: "defaultAndApply",
                    expectedRevision: catalog.value?.revision,
                    model: { providerId: choice.providerId, modelId: choice.modelId },
                  }),
                );
              } catch (cause) {
                await catalog.refresh();
                throw cause;
              }
            });
          }}
        >
          {!options.some((option) => `${option.providerId}/${option.modelId}` === value) && (
            <option value={value}>
              {current?.modelId || t("settings.newSessionModelSetting.notSet")}
            </option>
          )}
          {options.map((option) => (
            <option
              key={`${option.providerId}/${option.modelId}`}
              value={`${option.providerId}/${option.modelId}`}
            >
              {option.label}
            </option>
          ))}
        </SettingsSelect>
      }
    />
  );
  if (compact)
    return (
      <>
        <Feedback error={catalog.error || subscription.error || error} />
        {row}
      </>
    );
  return (
    <SettingsSection
      title={t("settings.newSessionModelSetting.newSessions")}
      description={t("settings.newSessionModelSetting.newSessionsUseTheModelAndReasoning")}
    >
      <Feedback error={catalog.error || subscription.error || error} />
      {overrides.length > 0 && (
        <p role="status" className="settings-muted">
          {t("settings.newSessionModelSetting.commandLineOrEnvironmentSettingsOverrideFile")}
        </p>
      )}
      <SettingsGroupCard>{row}</SettingsGroupCard>
    </SettingsSection>
  );
}
