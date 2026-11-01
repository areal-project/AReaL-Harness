import type {
  DesktopSnapShotState,
  SnapShotServices,
  SnapShotSettings,
} from "@areal/workbench/desktop-contract/snapshots";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../components/ui/dialog.js";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";

export function SnapShotSetupDialog({
  step,
  state,
  bridge,
  settings,
  busy,
  error,
  shortcut,
  canFinish,
  onStep,
  onFinish,
  onLater,
  run,
}: {
  step: "access" | "shortcut";
  state: DesktopSnapShotState | null;
  bridge: SnapShotServices;
  settings: SnapShotSettings;
  busy: boolean;
  error?: string;
  shortcut: ReactNode;
  canFinish: boolean;
  onStep: (step: "access" | "shortcut") => Promise<void>;
  onFinish: () => Promise<void>;
  onLater: () => Promise<void>;
  run: (operation: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useI18n();
  const permissions = state?.macPermissions;
  const access =
    !!permissions?.screenRecording &&
    (!settings.snapShotIncludeAccessibility || !!permissions.accessibility);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void onLater();
      }}
    >
      <DialogContent
        data-testid="snapshot-setup-dialog"
        className="max-w-xl"
        aria-describedby="snapshot-setup-description"
      >
        <DialogTitle>{t("snapshots.setupTitle")}</DialogTitle>
        <DialogDescription id="snapshot-setup-description">
          {t("snapshots.setupDescription")}
        </DialogDescription>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <nav aria-label={t("snapshots.setupSteps")} className="flex gap-3 text-ui-sm">
          <Button
            variant={step === "access" ? "secondary" : "ghost"}
            disabled={busy}
            onClick={() => void onStep("access")}
          >
            1. {t("snapshots.access")}
          </Button>
          <Button
            variant={step === "shortcut" ? "secondary" : "ghost"}
            disabled={busy || !access}
            onClick={() => void onStep("shortcut")}
          >
            2. {t("snapshots.shortcut")}
          </Button>
        </nav>
        {step === "access" ? (
          <div className="space-y-4">
            <p className="text-ui-sm text-foreground-subtle">{t("snapshots.permissionIdentity")}</p>
            <div className="flex items-center justify-between gap-4">
              <span>
                {t("snapshots.screenRecording")} ·{" "}
                {t(permissions?.screenRecording ? "snapshots.granted" : "snapshots.required")}
              </span>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => bridge.setupSnapShot("allow-screen-recording"))}
              >
                {t("snapshots.allow")}
              </Button>
            </div>
            {settings.snapShotIncludeAccessibility && (
              <div className="flex items-center justify-between gap-4">
                <span>
                  {t("snapshots.accessibility")} ·{" "}
                  {t(permissions?.accessibility ? "snapshots.granted" : "snapshots.optional")}
                </span>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => bridge.setupSnapShot("allow-accessibility"))}
                >
                  {t("snapshots.allow")}
                </Button>
              </div>
            )}
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {state?.message}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-ui-sm text-foreground-subtle">
              {t("snapshots.shortcutDescription")}
            </p>
            {shortcut}
            <p role="status" className="text-ui-sm">
              {state?.shortcutMessage}
            </p>
          </div>
        )}
        <footer className="flex items-center justify-between gap-3 pt-4">
          <Button variant="ghost" disabled={busy} onClick={() => void onLater()}>
            {t("snapshots.finishLater")}
          </Button>
          {step === "access" ? (
            <Button
              data-testid="snapshot-setup-continue"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await bridge.setupSnapShot("test-mac-capture");
                  const latest = await bridge.getSnapShotState();
                  if (
                    latest.macPermissions?.screenRecording &&
                    (!settings.snapShotIncludeAccessibility || latest.macPermissions.accessibility)
                  )
                    await onStep("shortcut");
                })
              }
            >
              {t("snapshots.testAndContinue")}
            </Button>
          ) : (
            <Button
              data-testid="snapshot-setup-finish"
              disabled={busy || !canFinish}
              onClick={() => void onFinish()}
            >
              {t("snapshots.saveAndFinish")}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
