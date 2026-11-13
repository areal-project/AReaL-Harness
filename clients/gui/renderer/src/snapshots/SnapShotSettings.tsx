import { Play } from "lucide-react";
import { errorText } from "../errors/errorCopy.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu.js";
import { useEffect, useRef, useState } from "react";
import {
  readSnapShotSettings,
  type SnapShotSettings as Settings,
  type SnapShotServices,
  type DesktopSnapShotState,
  type SnapShotShortcut,
} from "../services.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { SettingsSwitch } from "../settings/SettingsPageParts.js";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Action } from "../services.js";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog.js";
import { SnapShotShortcutRecorder, snapShotShortcutConflict } from "./shortcut.js";
import { playSnapShotSound } from "./sound.js";

export function SnapShotSettings({
  bridge,
  settings: raw,
  action,
  connected,
}: {
  bridge?: SnapShotServices;
  settings?: unknown;
  action: Action;
  connected: boolean;
}) {
  const { t } = useI18n();
  const settings = readSnapShotSettings(raw);
  const [state, setState] = useState<DesktopSnapShotState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wizard, setWizard] = useState<"access" | "shortcut" | null>(() =>
    settings.snapShotEnabled && settings.setupStep && settings.setupStep !== "complete"
      ? settings.setupStep
      : null,
  );
  const wasEnabled = useRef(settings.snapShotEnabled && settings.setupStep === "complete");
  const [candidate, setCandidate] = useState<SnapShotShortcut>(settings.snapShotShortcut);
  const [available, setAvailable] = useState(false);
  const checkId = useRef(0);
  const saving = useRef(false);
  const latest = useRef(settings);
  latest.current = settings;
  const refresh = async () => {
    if (bridge) setState(await bridge.getSnapShotState());
  };
  useEffect(() => {
    if (!bridge) return;
    void refresh().catch((cause: Error) => setError(errorText(t, cause)));
    const visible = () => {
      void refresh().catch((cause: Error) => setError(errorText(t, cause)));
    };
    window.addEventListener("focus", visible);
    const unsubscribe = bridge.onSnapShotEvent(visible);
    return () => {
      window.removeEventListener("focus", visible);
      unsubscribe();
    };
  }, [bridge]);
  const save = async (patch: Partial<Settings>) => {
    const value = { ...latest.current, ...patch };
    await action("library", { operation: "settings", key: "snapShot", value });
    latest.current = value;
    await refresh();
  };
  const run = async (operation: () => Promise<void>) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const changed = JSON.stringify(candidate) !== JSON.stringify(settings.snapShotShortcut);
  const canSave = changed && available;
  const check = async (shortcut: SnapShotShortcut) => {
    const id = ++checkId.current;
    const saved = JSON.stringify(latest.current.snapShotShortcut);
    setCandidate(shortcut);
    setAvailable(false);
    setError("");
    if (snapShotShortcutConflict(shortcut)) {
      setError(t("snapshots.shortcutConflict"));
      return;
    }
    try {
      const result = await bridge?.checkSnapShotShortcut(shortcut);
      if (id !== checkId.current || saved !== JSON.stringify(latest.current.snapShotShortcut))
        return;
      setAvailable(result?.available === true);
      if (!result?.available) setError(result?.message ?? t("snapshots.shortcutConflict"));
    } catch (cause) {
      if (id === checkId.current) setError((cause as Error).message);
    }
  };
  const captureStatus =
    state?.message ||
    t(
      !state
        ? "snapshots.statusChecking"
        : !settings.snapShotEnabled
          ? "snapshots.statusDisabled"
          : state.shortcutPending
            ? "snapshots.statusPending"
            : state.shortcutRegistered
              ? "snapshots.statusReady"
              : "snapshots.statusSetup",
    );
  const shortcutStatus = state?.shortcutPending
    ? t("snapshots.statusPending")
    : state?.shortcutRegistered
      ? t("snapshots.shortcutSaved")
      : state?.shortcutMessage;
  const disabled = !bridge || !connected || busy || state?.mode === "unavailable";
  const recorder = bridge && (
    <div className="flex flex-wrap items-center gap-2">
      <SnapShotShortcutRecorder
        bridge={bridge}
        value={candidate}
        disabled={disabled}
        onRecord={(value) => void check(value)}
        onError={setError}
      />
      {changed && !wizard && (
        <Button
          variant="outline"
          disabled={disabled || !canSave}
          onClick={() => void run(() => save({ snapShotShortcut: candidate }))}
        >
          {t("snapshots.saveShortcut")}
        </Button>
      )}
      {changed && !wizard && (
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            checkId.current++;
            setCandidate(settings.snapShotShortcut);
            setAvailable(false);
            setError("");
          }}
        >
          {t("snapshots.cancel")}
        </Button>
      )}
    </div>
  );
  return (
    <div className="settings-sections" data-testid="snapshot-settings">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {(!bridge || state?.mode === "unavailable") && (
        <p role="status" className="settings-section-desc">
          {state?.message || t("snapshots.unavailable")}
        </p>
      )}
      <SettingsSection title={t("snapshots.title")}>
        <SettingsGroupCard>
          <SettingsRow
            label={t("snapshots.title")}
            description={
              <div className="space-y-1">
                <p>{t("snapshots.description")}</p>
                <p role="status">{captureStatus}</p>
              </div>
            }
            control={
              <div className="flex items-center gap-2">
                {settings.snapShotEnabled &&
                  !(
                    state?.macPermissions?.screenRecording &&
                    (!settings.snapShotIncludeAccessibility ||
                      state.macPermissions.accessibility) &&
                    state.shortcutRegistered
                  ) && (
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() => {
                        wasEnabled.current = settings.setupStep === "complete";
                        setWizard(settings.setupStep === "shortcut" ? "shortcut" : "access");
                      }}
                    >
                      {t("snapshots.setup")}
                    </Button>
                  )}
                <SettingsSwitch
                  aria-label={t("snapshots.title")}
                  checked={settings.snapShotEnabled || !!wizard}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    void run(async () => {
                      if (!enabled) return save({ snapShotEnabled: false });
                      wasEnabled.current = false;
                      const step = settings.setupStep === "shortcut" ? "shortcut" : "access";
                      await save({ snapShotEnabled: true, setupStep: step });
                      setWizard(step);
                    })
                  }
                />
              </div>
            }
          />
          {settings.snapShotEnabled && (
            <>
              <SettingsRow
                label={t("snapshots.includeText")}
                description={t("snapshots.includeTextDescription")}
                control={
                  <SettingsSwitch
                    aria-label={t("snapshots.includeText")}
                    checked={settings.snapShotIncludeAccessibility}
                    disabled={disabled}
                    onCheckedChange={(value) =>
                      void run(async () => {
                        if (value) await bridge?.requestSnapShotPermissions(true);
                        await save({ snapShotIncludeAccessibility: value });
                      })
                    }
                  />
                }
              />
              <SettingsRow
                label={t("snapshots.captureShortcut")}
                description={
                  <div className="space-y-1">
                    <p>{t("snapshots.shortcutDescription")}</p>
                    {shortcutStatus && <p role="status">{shortcutStatus}</p>}
                  </div>
                }
                control={recorder}
              />
              <SettingsRow
                label={t("snapshots.sound")}
                description={t("snapshots.soundDescription")}
                control={
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          disabled={disabled}
                          aria-label={t("snapshots.sound")}
                        />
                      }
                    >
                      {t(
                        !settings.snapShotPlaySound
                          ? "snapshots.off"
                          : settings.snapShotSound === "soft-pop"
                            ? "snapshots.whoosh"
                            : "snapshots.click",
                      )}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={settings.snapShotPlaySound ? settings.snapShotSound : "off"}
                        onValueChange={(value) =>
                          void run(() =>
                            value === "off"
                              ? save({ snapShotPlaySound: false })
                              : save({
                                  snapShotPlaySound: true,
                                  snapShotSound:
                                    value === "camera-shutter" ? "camera-shutter" : "soft-pop",
                                }),
                          )
                        }
                      >
                        <DropdownMenuRadioItem value="off">
                          {t("snapshots.off")}
                        </DropdownMenuRadioItem>
                        <div className="grid grid-cols-[1fr_auto]">
                          <DropdownMenuRadioItem value="soft-pop">
                            {t("snapshots.whoosh")}
                          </DropdownMenuRadioItem>
                          <DropdownMenuItem
                            closeOnClick={false}
                            aria-label={t("snapshots.playWhoosh")}
                            onClick={() => playSnapShotSound("soft-pop")}
                          >
                            <Play size={14} />
                          </DropdownMenuItem>
                        </div>
                        <div className="grid grid-cols-[1fr_auto]">
                          <DropdownMenuRadioItem value="camera-shutter">
                            {t("snapshots.click")}
                          </DropdownMenuRadioItem>
                          <DropdownMenuItem
                            closeOnClick={false}
                            aria-label={t("snapshots.playClick")}
                            onClick={() => playSnapShotSound("camera-shutter")}
                          >
                            <Play size={14} />
                          </DropdownMenuItem>
                        </div>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
              <SettingsRow
                label={t("snapshots.flash")}
                description={t("snapshots.flashDescription")}
                control={
                  <SettingsSwitch
                    aria-label={t("snapshots.flash")}
                    checked={settings.snapShotFlash}
                    disabled={disabled}
                    onCheckedChange={(value) => void run(() => save({ snapShotFlash: value }))}
                  />
                }
              />
              <SettingsRow
                label={t("snapshots.animations")}
                description={t("snapshots.animationsDescription")}
                control={
                  <SettingsSwitch
                    aria-label={t("snapshots.animations")}
                    checked={settings.snapShotAnimations}
                    disabled={disabled}
                    onCheckedChange={(value) => void run(() => save({ snapShotAnimations: value }))}
                  />
                }
              />
            </>
          )}
        </SettingsGroupCard>
      </SettingsSection>
      {wizard && bridge && (
        <SnapShotSetupDialog
          step={wizard}
          state={state}
          bridge={bridge}
          settings={settings}
          busy={busy}
          error={error}
          shortcut={recorder}
          canFinish={changed ? canSave : state?.shortcutRegistered === true}
          run={run}
          onStep={async (step) => {
            await save({ setupStep: step });
            setWizard(step);
          }}
          onLater={() =>
            run(async () => {
              await save({ snapShotEnabled: wasEnabled.current });
              setWizard(null);
            })
          }
          onFinish={() =>
            run(async () => {
              if (changed) await save({ snapShotShortcut: candidate });
              const current = await bridge.getSnapShotState();
              if (!current.shortcutRegistered)
                throw new Error(current.shortcutMessage || t("snapshots.shortcutConflict"));
              await save({ snapShotEnabled: true, setupStep: "complete" });
              setWizard(null);
            })
          }
        />
      )}
    </div>
  );
}
