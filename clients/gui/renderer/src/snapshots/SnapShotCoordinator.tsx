import { SnapShotCaptureContext } from "./captureContext.js";
import { readSnapShotSettings } from "../services.js";
import { sending } from "../composerDraftAttachments.js";
import { composerDraftStorage } from "../composerDraftStorage.js";
import {
  beginSnapShotAnimation,
  configureSnapShotAnimations,
  dismissSnapShotAnimations,
  waitForSnapShotAnimation,
} from "./animation.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SnapShotServices, SnapShotSettings } from "../services.js";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { currentSnapShotDraft } from "./activeDraft.js";
import {
  acceptSnapShot,
  pinSnapShot,
  restoreSnapShotDrafts,
  snapShotDraftRecords,
  snapShotDraftTarget,
} from "./drafts.js";
import { playSnapShotSound } from "./sound.js";
import { useReducedMotion } from "../settings/applicationPreferences.js";

export function SnapShotCoordinator({
  bridge,
  settings,
}: {
  bridge?: SnapShotServices;
  settings: SnapShotSettings;
}) {
  const { t } = useI18n();
  const reducedMotion = useReducedMotion();
  const options = useRef({ settings, reducedMotion });
  options.current = { settings, reducedMotion };
  const [error, setError] = useState("");
  const [localError, setLocalError] = useState("");
  const [unassigned, setUnassigned] = useState<string[]>([]);
  const draining = useRef<Promise<void> | null>(null);
  const pins = useRef(new Map<string, Promise<void>>());
  const sounded = useRef(new Set<string>());
  const missingRef = useRef(unassigned);
  missingRef.current = unassigned;
  useEffect(() => {
    if (!bridge) return;
    configureSnapShotAnimations(bridge);
    let active = true;
    const restore = restoreSnapShotDrafts();
    let rerun = false;
    const drain = () => {
      if (draining.current) {
        rerun = true;
        return draining.current;
      }
      const operation = (async () => {
        await restore;
        do {
          rerun = false;
          const missing: string[] = [];
          for (const pending of await bridge.listPendingSnapShots()) {
            await pins.current.get(pending.id);
            const record = (await snapShotDraftRecords()).find(
              (record) => record.id === pending.id,
            );
            if (
              record &&
              (sending.has(snapShotDraftTarget(record.id, record.draftKey)) ||
                composerDraftStorage.getItem(
                  `${snapShotDraftTarget(record.id, record.draftKey)}:pending`,
                ))
            )
              continue;
            const capture = await bridge.readSnapShot(pending.id);
            if (!(await acceptSnapShot(capture))) {
              missing.push(pending.id);
              continue;
            }
            if (options.current.reducedMotion || !options.current.settings.snapShotAnimations)
              await bridge.dismissSnapShotAnimation(pending.id);
            await waitForSnapShotAnimation(pending.id);
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
            await bridge.acknowledgeSnapShot(pending.id);
            pins.current.delete(pending.id);
          }
          if (active) {
            setUnassigned(missing);
            setError("");
          }
        } while (rerun && active);
      })()
        .catch((cause: Error) => {
          if (active) setError(cause.message);
        })
        .finally(() => {
          draining.current = null;
        });
      draining.current = operation;
      return operation;
    };
    const unsubscribe = bridge.onSnapShotEvent((event) => {
      if (event.type === "requested") {
        const key = currentSnapShotDraft();
        if (key) {
          const pin = pinSnapShot(event.id, key);
          pins.current.set(event.id, pin);
          void pin.catch((cause: Error) => {
            if (active) setError(cause.message);
          });
        }
      }
      if (event.type === "started" && !sounded.current.has(event.id)) {
        sounded.current.add(event.id);
        if (options.current.settings.snapShotPlaySound)
          playSnapShotSound(options.current.settings.snapShotSound);
        if (options.current.reducedMotion || !options.current.settings.snapShotAnimations)
          void bridge.dismissSnapShotAnimation(event.id).catch(() => {});
      }
      if (event.type === "ready") {
        if (!options.current.reducedMotion && options.current.settings.snapShotAnimations)
          beginSnapShotAnimation(event.id);
        void drain();
      }
      if (event.type === "failed") {
        if (event.id) void bridge.dismissSnapShotAnimation(event.id).catch(() => {});
        if (active) setError(event.message ?? t("snapshots.captureFailed"));
      }
    });
    const localFailure = (event: Event) =>
      setLocalError(
        `${t("snapshots.localCleanupFailed")} ${(event as CustomEvent<string>).detail}`,
      );
    window.addEventListener("areal-snapshot-local-error", localFailure);
    const focus = () => {
      void drain();
    };
    const blur = () => dismissSnapShotAnimations();
    const visibility = () => {
      if (document.visibilityState === "visible") void drain();
      else dismissSnapShotAnimations();
    };
    const recover = async () => {
      const key = currentSnapShotDraft();
      if (!key) return;
      await Promise.all(missingRef.current.map((id) => pinSnapShot(id, key)));
      await drain();
    };
    window.addEventListener("areal-recover-snapshots", recover);
    window.addEventListener("focus", focus);
    window.addEventListener("areal-snapshot-drain", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    void drain();
    return () => {
      active = false;
      window.removeEventListener("areal-snapshot-local-error", localFailure);
      unsubscribe();
      window.removeEventListener("areal-recover-snapshots", recover);
      window.removeEventListener("focus", focus);
      window.removeEventListener("areal-snapshot-drain", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [bridge, t]);
  if (!error && !localError && !unassigned.length) return null;
  return (
    <div
      role={error || localError ? "alert" : "status"}
      className="fixed bottom-4 right-4 z-50 max-w-md rounded-lg border border-border bg-background p-4 text-ui-sm shadow-lg"
    >
      <p>{localError || error || t("snapshots.recovery")}</p>
      {!!unassigned.length && (
        <Button
          variant="outline"
          onClick={() => window.dispatchEvent(new Event("areal-recover-snapshots"))}
        >
          {t("snapshots.recover")}
        </Button>
      )}
      {(error || localError) && (
        <Button
          variant="ghost"
          onClick={() => {
            setError("");
            setLocalError("");
          }}
        >
          {t("common.close")}
        </Button>
      )}
    </div>
  );
}

export function SnapShotProvider({
  bridge,
  settings,
  children,
  ready,
  openSettings,
}: {
  bridge?: SnapShotServices;
  settings: unknown;
  children: ReactNode;
  ready?: boolean;
  openSettings: () => void;
}) {
  useSnapShotSetupResume(ready === true, settings, bridge, openSettings);
  const preferences = readSnapShotSettings(settings);
  return (
    <SnapShotCaptureContext.Provider value={preferences.snapShotEnabled ? bridge : undefined}>
      <SnapShotCoordinator bridge={bridge} settings={preferences} />
      {children}
    </SnapShotCaptureContext.Provider>
  );
}
export function useSnapShotSetupResume(
  ready: boolean,
  settings: unknown,
  bridge: SnapShotServices | undefined,
  openSettings: () => void,
) {
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !ready || !bridge) return;
    checked.current = true;
    const preferences = readSnapShotSettings(settings);
    if (
      preferences.snapShotEnabled &&
      preferences.setupStep &&
      preferences.setupStep !== "complete"
    )
      openSettings();
  }, [ready, settings, bridge, openSettings]);
}
