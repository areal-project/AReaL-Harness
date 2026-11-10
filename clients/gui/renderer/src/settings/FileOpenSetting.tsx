import { SettingsRow } from "@areal/ui/compositions";
import { errorText } from "../errors/errorCopy.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { useEffect, useRef, useState } from "react";
import { SettingsSelect } from "./SettingsPageParts.js";
import type { PlatformServices, FileOpenTargets } from "../services.js";

export function FileOpenSetting({
  service,
  preferred,
  connected,
}: {
  service?: PlatformServices["fileOpen"];
  preferred?: string;
  connected: boolean;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<FileOpenTargets>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    saving = useRef(false);
  useEffect(() => {
    let current = true;
    if (service)
      void service({ operation: "targets" })
        .then((value) => {
          if (current) {
            setCatalog(value as FileOpenTargets);
            setError("");
          }
        })
        .catch((cause) => {
          if (current) setError(errorText(t, cause));
        });
    return () => {
      current = false;
    };
  }, [service, preferred, connected]);
  const save = async (target: string) => {
    if (!service || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await service({ operation: "setDefault", target });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      label={t("settings.fileOpenSetting.openFilesIn")}
      detail={
        error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )
      }
      control={
        catalog ? (
          <SettingsSelect
            aria-label={t("settings.fileOpenSetting.openFilesIn")}
            value={catalog.preferred}
            disabled={!service || !connected || busy}
            onValueChange={(target) => void save(target)}
          >
            {catalog.targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.id === "system"
                  ? t("settings.fileOpenSetting.systemDefaultApp")
                  : target.label}
              </option>
            ))}
          </SettingsSelect>
        ) : (
          <span className="text-foreground-subtle">{t("settings.fileOpenSetting.loading")}</span>
        )
      }
    />
  );
}
