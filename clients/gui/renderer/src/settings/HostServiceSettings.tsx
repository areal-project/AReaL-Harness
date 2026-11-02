import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "../components/ui/action-button.js";
import { Input } from "../components/ui/input.js";
import { Feedback } from "../components/ui/feedback.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Action, CommandResponse } from "../services.js";
import { SettingsSwitch } from "./SettingsPageParts.js";

export function HostServiceSettings({ action, connected }: { action: Action; connected: boolean }) {
  const { t } = useI18n();
  const [installation, setInstallation] = useState<CommandResponse<"hostInstallation"> | null>(
    null,
  );
  const [update, setUpdate] = useState<CommandResponse<"hostUpdate"> | null>(null);
  const [targetVersion, setTargetVersion] = useState("");
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);
  const read = useCallback(() => {
    if (inflight.current) return inflight.current;
    const ticket = generation.current;
    const pending = (async () => {
      const installation = await action("hostInstallation", { operation: "status" });
      if (ticket === generation.current) setInstallation(installation);
      const update = connected ? await action("hostUpdate", { operation: "status" }) : null;
      if (ticket === generation.current) setUpdate(update);
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = pending;
    return pending;
  }, [action, connected]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!locked.current) {
        try {
          await read();
          if (live) setReadError("");
        } catch (cause) {
          if (live) setReadError((cause as Error).message);
        }
      }
      if (live) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      live = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [read]);
  const run = async (operation: "install" | "uninstall" | "prepare" | "apply" | "check") => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await inflight.current?.catch(() => {});
      if (operation === "install" || operation === "uninstall")
        setInstallation(await action("hostInstallation", { operation }));
      else if (operation === "check") setUpdate(await action("hostUpdate", { operation }));
      else
        setUpdate(
          await action("hostUpdate", {
            operation,
            requestId: crypto.randomUUID(),
            targetVersion: operation === "apply" ? update!.targetVersion! : targetVersion.trim(),
          }),
        );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const prepared = update?.operation?.state === "prepared";
  const pending =
    update?.operation && !["prepared", "completed", "blocked"].includes(update.operation.state);
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={t("settings.host.login")}
        description={t("settings.host.loginDescription")}
        control={
          <SettingsSwitch
            aria-label={t("settings.host.login")}
            checked={installation?.installed === true}
            disabled={busy || !installation}
            onCheckedChange={(enabled) => void run(enabled ? "install" : "uninstall")}
          />
        }
      />
      {update?.supported && (
        <>
          <SettingsRow
            label={t("settings.host.update")}
            description={
              update.restartPending
                ? t("settings.host.restartPending", { value0: update.targetVersion ?? "" })
                : t("settings.host.updateDescription")
            }
            control={
              <ActionButton
                pending={busy}
                disabled={busy || !connected}
                onClick={() => void run("check")}
              >
                {t("settings.host.checkUpdate")}
              </ActionButton>
            }
          />
          {!pending && !prepared && (
            <SettingsRow
              label={t("settings.host.targetVersion")}
              control={
                <Input
                  value={targetVersion}
                  disabled={busy}
                  aria-label={t("settings.host.targetVersion")}
                  onChange={(event) => setTargetVersion(event.target.value)}
                />
              }
            />
          )}
          {!pending && (
            <SettingsRow
              label={prepared ? t("settings.host.applyUpdate") : t("settings.host.prepareUpdate")}
              description={t("settings.host.idleUpdate")}
              control={
                <ActionButton
                  pending={busy}
                  disabled={busy || (!prepared && !targetVersion.trim())}
                  onClick={() => void run(prepared ? "apply" : "prepare")}
                >
                  {prepared ? t("settings.host.applyUpdate") : t("settings.host.prepareUpdate")}
                </ActionButton>
              }
            />
          )}
          <Feedback message={update.operation?.message} />
          {pending && <Feedback message={t("settings.host.originalUpdatePending")} />}
        </>
      )}
      <Feedback error={error || readError} />
    </SettingsGroupCard>
  );
}
