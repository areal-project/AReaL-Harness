import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { currentErrorText } from "../errors/currentErrorText.js";
import { useI18n, UiMessageError, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { useRef, useState } from "react";
import type { Action } from "../services.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { SettingsSwitch } from "./SettingsPageParts.js";

// 只有带自动更新的桌面应用渲染；关闭后不降级，停在当前版本直到正式版追上。
export function BetaUpdateSetting({
  enabled,
  action,
  connected,
}: {
  enabled: boolean;
  action?: Action;
  connected: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | UiMessage>("");
  const saving = useRef(false);
  const save = async (value: boolean) => {
    if (saving.current || !connected || !action) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await action("library", { operation: "settings", key: "betaUpdates", value });
    } catch (cause) {
      setError(
        cause instanceof UiMessageError
          ? cause.descriptor
          : cause instanceof Error
            ? currentErrorText(cause)
            : { id: "settings.betaUpdates.saveFailed" },
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={t("settings.betaUpdates.section")}>
      <SettingsDisclosure title={t("settings.betaUpdates.advanced")}>
        <SettingsGroupCard>
          <SettingsRow
            label={t("settings.betaUpdates.label")}
            description={t("settings.betaUpdates.description")}
            control={
              <SettingsSwitch
                aria-label={t("settings.betaUpdates.label")}
                checked={enabled}
                disabled={!connected || !action || busy}
                onCheckedChange={(value) => void save(value)}
              />
            }
          />
          {error && (
            <p role="alert" className="px-4 py-2 text-destructive">
              {formatUiMessage(t, error)}
            </p>
          )}
        </SettingsGroupCard>
      </SettingsDisclosure>
    </SettingsSection>
  );
}
