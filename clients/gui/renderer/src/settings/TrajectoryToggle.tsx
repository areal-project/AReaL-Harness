import { useI18n } from "../i18n/IntlProvider.js";
import type { TrajectoryStatus } from "../services.js";
import { Switch } from "../components/ui/switch.js";
import "./trajectory-settings.css";

export function TrajectoryToggle({
  status,
  busy,
  stale,
  onChange,
}: {
  status: TrajectoryStatus;
  busy: boolean;
  stale: boolean;
  onChange(enabled: boolean): void;
}) {
  const { t } = useI18n();
  const pending = status.capture_apply_pending || !!status.capture_apply_error;
  const enabled = status.enabled && !stale && !pending && status.state === "ready";
  const label = stale
    ? t("settings.trajectoryToggle.statusNeedsConfirmation")
    : status.enabled
      ? pending
        ? t("settings.trajectoryToggle.onPendingApplication")
        : status.state === "ready"
          ? t("settings.trajectoryToggle.on")
          : t("settings.trajectoryToggle.onNeedsAttention")
      : t("settings.trajectoryToggle.off");
  return (
    <div
      className="trajectory-toggle-control"
      data-upload-state={enabled ? "enabled" : "attention"}
    >
      <span className="trajectory-toggle-label" aria-live="polite">
        {label}
      </span>
      <Switch
        aria-label={t("settings.trajectoryToggle.enableDataFlywheel")}
        className="trajectory-toggle"
        checked={status.enabled}
        disabled={
          busy ||
          stale ||
          !/^[a-f0-9]{64}$/.test(status.config_revision ?? "") ||
          (!status.enabled && (!status.endpoint || status.endpoint === "<invalid>"))
        }
        onCheckedChange={onChange}
      />
    </div>
  );
}
