import { FlaskConical } from "lucide-react";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useI18n } from "../i18n/IntlProvider.js";
import { SettingsSwitch } from "./SettingsPageParts.js";
import { setLabsFeature, useLabsFeature } from "./labsFeatures.js";

export function LabsSettings() {
  const { t } = useI18n();
  const botsEnabled = useLabsFeature("bots");
  return (
    <SettingsSection>
      <SettingsGroupCard>
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              <FlaskConical size={16} aria-hidden="true" />
              {t("settings.labs.bots.label")}
            </span>
          }
          description={t("settings.labs.bots.description")}
          control={
            <SettingsSwitch
              aria-label={t("settings.labs.bots.label")}
              checked={botsEnabled}
              onCheckedChange={(enabled) => setLabsFeature("bots", enabled)}
            />
          }
        />
      </SettingsGroupCard>
    </SettingsSection>
  );
}
