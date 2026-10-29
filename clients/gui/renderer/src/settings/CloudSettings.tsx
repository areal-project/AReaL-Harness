import { useEffect, useRef, useState } from "react";
import { useI18n, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import type { Action } from "../services.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SettingsSection, SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";

export function CloudSettings({ action }: { action: Action }) {
  const { t } = useI18n();
  const [baseURL, setBaseURL] = useState("");
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | UiMessage>("");
  const request = useRef(action);
  request.current = action;
  useEffect(() => {
    let active = true;
    void request
      .current("cloud", { operation: "status" })
      .then((value) => {
        if (active) {
          setBaseURL(value.baseURL);
          setConfigured(value.tokenConfigured);
        }
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const value = await request.current("cloud", {
        operation: "save",
        baseURL,
        ...(token ? { token } : {}),
      });
      setBaseURL(value.baseURL);
      setConfigured(value.tokenConfigured);
      setToken("");
      window.dispatchEvent(new Event("areal-cloud-config"));
      setMessage({ id: "cloud.settings.saved" });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-sections"
      aria-label={t("cloud.settings.title")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SettingsSection
        title={t("cloud.settings.connection")}
        description={t("cloud.settings.description")}
      >
        <SettingsGroupCard>
          <SettingsRow
            label={<label htmlFor="cloud-url">{t("cloud.settings.address")}</label>}
            description={t("cloud.settings.addressDescription")}
            controlLayout="wide"
            control={
              <Input
                id="cloud-url"
                aria-label={t("cloud.settings.addressLabel")}
                type="text"
                value={baseURL}
                disabled={busy}
                placeholder="https://backend.example/openapi/v1/app-server/"
                required
                onChange={(event) => {
                  setMessage("");
                  setBaseURL(event.target.value);
                }}
              />
            }
          />
          <SettingsRow
            label={<label htmlFor="cloud-token">{t("cloud.settings.token")}</label>}
            description={t("cloud.settings.tokenDescription")}
            controlLayout="wide"
            control={
              <Input
                id="cloud-token"
                aria-label={t("cloud.settings.tokenLabel")}
                type="password"
                autoComplete="off"
                value={token}
                disabled={busy}
                placeholder={t(
                  configured ? "cloud.settings.tokenSaved" : "cloud.settings.tokenInput",
                )}
                onChange={(event) => {
                  setMessage("");
                  setToken(event.target.value);
                }}
              />
            }
          />
        </SettingsGroupCard>
      </SettingsSection>
      <div className="flex items-center justify-end gap-3">
        <Button type="submit" disabled={busy || !baseURL.trim()}>
          {t(busy ? "cloud.settings.saving" : "cloud.settings.save")}
        </Button>
      </div>
      {message && (
        <p role="status" className="settings-section-desc">
          {formatUiMessage(t, message)}
        </p>
      )}
    </form>
  );
}
