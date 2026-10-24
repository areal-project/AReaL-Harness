import { BrowserDataSettings } from './BrowserDataSettings.js';
import { useI18n } from "../i18n/IntlProvider.js";
import {
  SettingsGroupCard,
  SettingsSection,
  SettingsRow,
  SettingsSwitch,
  SettingsSelect,
} from "./SettingsPageParts.js";
import { useRef, useState } from "react";
import type { Action, Data } from "../services.js";

/** Only settings wired to the current native preview are editable. */
export function BrowserSettings({ settings = {}, action, connected = false }: { settings?: Data; action?: Action; connected?: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const save = async (key: string, value: string | boolean) => {
    if (!action || !connected || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action('library', { operation: 'settings', key, value }); }
    catch (cause) { setError((cause as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  const destination = (label: string, key: string, fallback: string) => <SettingsSelect aria-label={label}
    value={settings[key] ?? fallback} disabled={!action || !connected || busy} onValueChange={value => void save(key, value)}>
    <option value="internal">{t("settings.browserSettings.inApp")}</option><option value="external">{t("settings.browserSettings.defaultBrowser")}</option>
  </SettingsSelect>;
  return (
    <div className="settings-sections">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <SettingsSection title={t("settings.browserSettings.general")}>
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.browserSettings.openWebURLsAndLinksIn")}
          control={destination(t("settings.browserSettings.openWebURLsAndLinksIn"), 'browserLinkTarget', 'external')}
        />
        <SettingsRow
          label={t("settings.browserSettings.openLocalURLsIn")}
          description={t("settings.browserSettings.forLocalDevelopmentSites")}
          control={destination(t("settings.browserSettings.openLocalURLsIn"), 'browserLocalTarget', 'internal')}
        />
        <SettingsRow
          label={t("settings.browserSettings.showFullURL")}
          description={t("settings.browserSettings.showPathsQueryParametersAndFragmentsIn")}
          control={<SettingsSwitch aria-label={t("settings.browserSettings.showFullURL")} checked={settings.browserFullAddress === true} disabled={!action || !connected || busy} onCheckedChange={value => void save('browserFullAddress', value)} />}
        />
      </SettingsGroupCard>
      </SettingsSection>
      <BrowserDataSettings action={action} connected={connected} />
    </div>
  );
}
