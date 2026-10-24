import { useI18n, UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { useRef, useState } from "react";
import type { Action, Data } from "../services.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsSection, SettingsGroupCard, SettingsRow, SettingsSwitch } from "./SettingsPageParts.js";

export function NotificationSettings({ settings, action, connected }: { settings: Data; action?: Action; connected: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | UiMessage>("");
  const saving = useRef(false);
  const disabled = !connected || !action || busy;
  const save = async (key: string, value: string | boolean) => {
    if (saving.current || !connected || !action) return;
    saving.current = true; setBusy(true); setError("");
    try { await action("library", { operation: "settings", key, value }); }
    catch (cause) { setError(cause instanceof UiMessageError ? cause.descriptor : cause instanceof Error ? cause.message : { id: "settings.notificationSettings.failedToSaveNotificationSettings" }); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingsSection title={t("settings.notificationSettings.notifications")}>
    <Feedback error={error} />
    <SettingsGroupCard>
      <SettingsRow label={t("settings.desktop.taskNotifications")} description={t("settings.desktop.taskNotificationsDescription")} control={
        <SettingsSwitch aria-label={t("settings.desktop.taskNotifications")} disabled={disabled} checked={settings.taskNotifications !== false} onCheckedChange={v => void save("taskNotifications", v)} />
      } />
      <SettingsRow label={t("settings.notificationSettings.turnCompletionNotifications")} description={t("settings.notificationSettings.chooseWhenToBeNotifiedAfterA")} control={
        <SettingsSelect aria-label={t("settings.notificationSettings.turnCompletionNotifications")} disabled={disabled} value={settings.turnNotifications ?? "unfocused"} onValueChange={selectedValue => void save("turnNotifications", selectedValue)}>
          <option value="always">{t("settings.notificationSettings.always")}</option><option value="unfocused">{t("settings.notificationSettings.whenUnfocused")}</option><option value="never">{t("settings.notificationSettings.never")}</option>
        </SettingsSelect>
      } />
      <SettingsRow label={t("settings.notificationSettings.permissionNotifications")} description={t("settings.notificationSettings.notifyWhenAToolOperationNeedsYour")} control={
        <SettingsSwitch aria-label={t("settings.notificationSettings.permissionNotifications")} disabled={disabled} checked={settings.permissionNotifications !== false} onCheckedChange={v => void save("permissionNotifications", v)} />
      } />
      <SettingsRow label={t("settings.notificationSettings.questionNotifications")} description={t("settings.notificationSettings.notifyWhenInputIsNeededToContinue")} control={
        <SettingsSwitch aria-label={t("settings.notificationSettings.questionNotifications")} disabled={disabled} checked={settings.questionNotifications !== false} onCheckedChange={v => void save("questionNotifications", v)} />
      } />
      <SettingsRow label={t("settings.notificationSettings.notificationSound")} description={t("settings.notificationSettings.soundForTaskCompletionPermissionRequestsAnd")} control={
        <SettingsSelect aria-label={t("settings.notificationSettings.notificationSound")} disabled={disabled} value={settings.notificationSound ?? "default"} onValueChange={selectedValue => void save("notificationSound", selectedValue)}>
          <option value="default">{t("settings.notificationSettings.default")}</option><option value="silent">{t("settings.notificationSettings.none")}</option>
        </SettingsSelect>
      } />
    </SettingsGroupCard>
  </SettingsSection>;
}
