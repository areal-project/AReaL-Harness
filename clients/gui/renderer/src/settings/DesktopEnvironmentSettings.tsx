import { useEffect, useRef, useState } from "react";
import { useI18n, UiMessageError, formatUiMessage, type MessageId, type UiMessage } from "../i18n/IntlProvider.js";
import { ActionButton } from "../components/ui/action-button.js";
import { Feedback } from "../components/ui/feedback.js";
import { Input } from "../components/ui/input.js";
import type { Action, Data } from "../services.js";
import { SettingsGroupCard, SettingsRow, SettingsSection, SettingsSwitch } from "./SettingsPageParts.js";

type SettingsProps = { settings: Data; action?: Action; connected: boolean };

function SavedSetting({ settings, action, connected, setting, label, description, placeholder, toggle = false }: SettingsProps & {
  setting: string; label: MessageId; description: MessageId; placeholder?: string; toggle?: boolean;
}) {
  const { t } = useI18n();
  const value = toggle ? settings[setting] !== false : String(settings[setting] ?? "");
  const [draft, setDraft] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | UiMessage>("");
  const [saved, setSaved] = useState(false);
  const saving = useRef(false);
  useEffect(() => { setDraft(String(value)); }, [value]);
  const disabled = !connected || !action || busy;
  const save = async (next: string | boolean) => {
    if (!connected || !action || saving.current) return;
    saving.current = true; setBusy(true); setError(""); setSaved(false);
    try {
      await action("library", { operation: "settings", key: setting, value: next });
      if (typeof next === "string") setDraft(next);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof UiMessageError ? cause.descriptor : cause instanceof Error ? cause.message : { id: "settings.desktop.saveFailed" });
    } finally { saving.current = false; setBusy(false); }
  };
  return <SettingsRow label={t(label)} description={t(description)} control={toggle
    ? <SettingsSwitch aria-label={t(label)} checked={value === true} disabled={disabled} onCheckedChange={next => void save(next)} />
    : <ActionButton disabled={disabled || draft === value} onClick={() => void save(draft.trim())}>{t("settings.desktop.save")}</ActionButton>}
    detail={<>
      {!toggle && <Input aria-label={t(label)} value={draft} placeholder={placeholder} disabled={disabled} spellCheck={false}
        onChange={event => { setDraft(event.target.value); setSaved(false); setError(""); }}
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void save(draft.trim()); } }} />}
      {error && <p role="alert" className="ui-feedback">{formatUiMessage(t, error)}</p>}
      <Feedback message={saved ? t("settings.desktop.saved") : undefined} />
    </>} />;
}

export function DesktopEnvironmentSettings(props: SettingsProps) {
  const { t } = useI18n();
  return <>
    <SettingsSection title={t("settings.desktop.terminal")}>
      <SettingsGroupCard>
        <SavedSetting {...props} setting="terminalInheritSystemProfile" label="settings.desktop.inheritTerminal" description="settings.desktop.inheritTerminalDescription" toggle />
        <SavedSetting {...props} setting="terminalFontFamily" label="settings.desktop.terminalFont" description="settings.desktop.terminalFontDescription" placeholder={t("settings.desktop.terminalFontPlaceholder")} />
      </SettingsGroupCard>
    </SettingsSection>
    <SettingsSection title={t("settings.desktop.network")}>
      <SettingsGroupCard>
        <SavedSetting {...props} setting="httpProxy" label="settings.desktop.proxy" description="settings.desktop.proxyDescription" placeholder={t("settings.desktop.proxyPlaceholder")} />
        <SavedSetting {...props} setting="httpProxyNoProxy" label="settings.desktop.noProxy" description="settings.desktop.noProxyDescription" placeholder={t("settings.desktop.noProxyPlaceholder")} />
        <SavedSetting {...props} setting="httpProxyCaCertPath" label="settings.desktop.ca" description="settings.desktop.caDescription" placeholder={t("settings.desktop.caPlaceholder")} />
      </SettingsGroupCard>
    </SettingsSection>
    <SettingsSection title={t("settings.desktop.graphics")}>
      <SettingsGroupCard>
        <SavedSetting {...props} setting="hardwareAcceleration" label="settings.desktop.hardwareAcceleration" description="settings.desktop.hardwareAccelerationDescription" toggle />
      </SettingsGroupCard>
    </SettingsSection>
  </>;
}
