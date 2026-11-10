import { SettingsRow } from "@areal/ui/compositions";
import { currentErrorText } from "../errors/currentErrorText.js";
import { useI18n, UiMessageError, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { useRef, useState } from "react";
import type { Action, Snapshot } from "../services.js";
import { SettingsSwitch } from "./SettingsPageParts.js";

export function MenuBarSetting({
  enabled,
  state,
  action,
  connected,
}: {
  enabled: boolean;
  state?: Snapshot["menuBar"];
  action?: Action;
  connected: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | UiMessage>("");
  const saving = useRef(false);
  const save = async (value: boolean) => {
    if (saving.current || !connected || !action || !state?.supported) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await action("library", { operation: "settings", key: "showInMenuBar", value });
    } catch (cause) {
      setError(
        cause instanceof UiMessageError
          ? cause.descriptor
          : cause instanceof Error
            ? currentErrorText(cause)
            : { id: "settings.menuBarSetting.failedToSaveMenuBarSettings" },
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsRow
        label={t("settings.menuBarSetting.showInMenuBar")}
        description={t("settings.menuBarSetting.returnToTheAppFromTheMacOS")}
        control={
          <SettingsSwitch
            aria-label={t("settings.menuBarSetting.showInMenuBar")}
            checked={enabled}
            disabled={!state?.supported || !connected || !action || busy}
            onCheckedChange={(value) => void save(value)}
          />
        }
      />
      {(error || state?.error) && (
        <p role="alert" className="px-4 py-2 text-destructive">
          {formatUiMessage(t, error) || state?.error}
        </p>
      )}
    </>
  );
}
