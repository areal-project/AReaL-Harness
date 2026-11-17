import { readLibraryRequest } from "../services.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Action, CommandParams, Data } from "../services.js";
import { Input } from "../components/ui/input.js";
import { Button } from "../components/ui/button.js";
import { SettingsSwitch } from "./SettingsPageParts.js";

export function ComputerSettings({
  settings = {},
  action,
  connected,
}: {
  settings?: Data;
  action: Action;
  connected: boolean;
}) {
  const { t } = useI18n();
  const [executable, setExecutable] = useState(String(settings.computerControlExecutable ?? ""));
  useEffect(
    () => setExecutable(String(settings.computerControlExecutable ?? "")),
    [settings.computerControlExecutable],
  );
  const [status, setStatus] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false),
    pending = useRef(false);
  const refresh = useCallback(async () => {
    if (!connected || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const value = await action("computerControl", { operation: "status" });
      if (mounted.current) {
        setStatus(value);
        setError("");
      }
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [action, connected]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(visibleRefresh, 5000);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [refresh]);
  const run = async (
    request: Exclude<CommandParams<"computerControl">, { operation: "status" }>,
  ) => {
    if (pending.current || !connected) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await action("computerControl", request);
      if (mounted.current) setStatus(value);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = async (key: string, value: boolean | string) => {
    if (pending.current || !connected) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action("library", readLibraryRequest({ operation: "settings", key, value }));
      setStatus(null);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const unsupported =
    status?.supported === false || (status?.platform && status.platform !== "darwin");
  const disabled = !connected || busy || unsupported;
  return (
    <div className="settings-sections" data-testid="computer-control-settings">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {unsupported && (
        <p role="status" className="settings-section-desc">
          {t("settings.computer.unsupported")}
        </p>
      )}
      <SettingsSection>
        <SettingsGroupCard>
          <SettingsRow
            label={t("settings.computer.executable")}
            description={t("settings.computer.executableDescription")}
            controlLayout="wide"
            control={
              <div className="flex w-full flex-wrap items-center gap-2">
                <Input
                  aria-label={t("settings.computer.executable")}
                  value={executable}
                  disabled={!connected || busy}
                  onChange={(event) => setExecutable(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={
                    !connected ||
                    busy ||
                    executable === String(settings.computerControlExecutable ?? "")
                  }
                  onClick={() => void save("computerControlExecutable", executable)}
                >
                  {t("settings.computer.save")}
                </Button>
              </div>
            }
          />
          <SettingsRow
            label={t("settings.computer.enable")}
            description={t("settings.computer.enableDescription")}
            control={
              <span data-testid="computer-control-enabled">
                <SettingsSwitch
                  aria-label={t("settings.computer.enable")}
                  checked={settings.computerControlEnabled === true}
                  disabled={disabled}
                  onCheckedChange={(value) => void save("computerControlEnabled", value)}
                />
              </span>
            }
          />
          <SettingsRow
            label={t("settings.computer.showEntry")}
            description={t("settings.computer.showEntryDescription")}
            control={
              <SettingsSwitch
                aria-label={t("settings.computer.showEntry")}
                checked={settings.computerControlShowEntry === true}
                disabled={!connected || busy}
                onCheckedChange={(value) => void save("computerControlShowEntry", value)}
              />
            }
          />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection
        title={t("settings.computer.lcu")}
        description={t("settings.computer.lcuDescription")}
      >
        <SettingsGroupCard>
          <SettingsRow
            label={t(
              settings.computerControlEnabled !== true
                ? "settings.computer.disabled"
                : status?.ready
                  ? "settings.computer.lcuReady"
                  : "settings.computer.lcuNotReady",
            )}
            description={
              typeof status?.reason === "string" && status.reason ? status.reason : undefined
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={!connected || busy}
                  onClick={() => void refresh()}
                >
                  {t("settings.computer.lcuRefresh")}
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void run({ operation: "restart" })}
                >
                  {t("settings.computer.check")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!connected || busy}
                  onClick={() => void run({ operation: "stop" })}
                >
                  {t("settings.computer.stop")}
                </Button>
              </div>
            }
          />
        </SettingsGroupCard>
      </SettingsSection>
    </div>
  );
}
