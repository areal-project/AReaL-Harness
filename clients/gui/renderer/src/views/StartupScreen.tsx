import { HostPrerequisiteGuide } from "../HostPrerequisiteGuide.js";
import type { ReactNode } from "react";
import startupIcon from "../../../app/assets/icon-1024.png";
import { useI18n } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";
import { SettingsDisclosure } from "../settings/SettingsDisclosure.js";
import type { BackendStatusAction } from "../BackendStatusNotice.js";
import type { PlatformServices, Snapshot } from "../services.js";
import type { RecoveryFailure } from "../recoveryPresentation.js";

type StartupScreenState = {
  connection: Snapshot["connection"];
  lifecycle: Snapshot["lifecycle"];
  lifecycleBlocked: boolean;
  delayed: boolean;
  restoration: { failed: boolean; refreshing: boolean; error: string; failure?: RecoveryFailure };
  backend: { pending: boolean; error: string };
};

export function StartupScreen({
  services,
  state,
  settingsPage,
  onCloseSettings,
  onSettings,
  onRetry,
  onBackendAction,
  onQuit,
}: {
  services: PlatformServices;
  state: StartupScreenState;
  settingsPage?: ReactNode;
  onCloseSettings: () => void;
  onSettings: () => void;
  onRetry: () => void;
  onBackendAction: (kind: BackendStatusAction) => void;
  onQuit: () => void;
}) {
  const { t } = useI18n();
  const failed =
    state.restoration.failed || state.connection?.state === "unavailable" || state.lifecycleBlocked;
  const recovery = failed || state.delayed;
  const busy =
    state.backend.pending ||
    state.restoration.refreshing ||
    state.connection?.state === "connecting";
  const reconnect =
    state.connection?.state === "unavailable" &&
    state.connection.recovery !== "check" &&
    !state.lifecycleBlocked;
  const details =
    state.backend.error ||
    state.restoration.failure?.message || // raw-error-ok: 只进详情
    state.restoration.error ||
    state.lifecycle?.error ||
    state.lifecycle?.recovery?.message ||
    state.lifecycle?.message ||
    state.connection?.message;
  return (
    <div className="startup-screen" data-testid="startup-loading">
      <div className="startup-drag-region" aria-hidden="true" />
      {settingsPage !== undefined ? (
        <div className="startup-settings">
          <Button variant="ghost" size="sm" onClick={onCloseSettings}>
            {t("startup.back")}
          </Button>
          {settingsPage}
        </div>
      ) : (
        <div className="startup-content">
          <img src={startupIcon} alt="AReaL Harness" width={40} height={40} />
          {state.connection?.prerequisite ? (
            <HostPrerequisiteGuide
              prerequisite={state.connection.prerequisite}
              services={services}
              pending={busy}
              onRetry={() => onBackendAction("reconnect")}
            />
          ) : (
            <>
              <p role={failed ? "alert" : "status"}>
                {t(
                  recovery
                    ? state.delayed && !failed
                      ? "startup.delayed"
                      : "startup.failed"
                    : "startup.loading",
                )}
              </p>
              {recovery && (
                <>
                  <div className="startup-actions">
                    {state.restoration.failed && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
                        {t("recovery.retryView")}
                      </Button>
                    )}
                    {services.capabilities?.native !== false && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => onBackendAction(reconnect ? "reconnect" : "check")}
                        >
                          {t(reconnect ? "startup.reconnect" : "startup.check")}
                        </Button>
                        {state.lifecycle?.recovery && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => onBackendAction("recover")}
                          >
                            {t("startup.recover")}
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={onSettings}>
                          {t("recovery.checkSettings")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={state.backend.pending}
                          onClick={onQuit}
                        >
                          {t("startup.quit")}
                        </Button>
                      </>
                    )}
                  </div>
                  {details && (
                    <SettingsDisclosure title={t("recovery.details")}>
                      <pre>{details}</pre>
                    </SettingsDisclosure>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
