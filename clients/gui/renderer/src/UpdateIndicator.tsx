import {
  Button,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@areal/ui";
import { Check, CircleAlert, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RefreshIcon } from "./interfaceIcons.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { PlatformServices, UpdateState } from "./services.js";

export function UpdateIndicator({ services }: { services: PlatformServices }) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const updateRevision = useRef(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!services.updateState || !services.onUpdate) return;
    const off = services.onUpdate((state) => {
      updateRevision.current++;
      setUpdate(state);
      if (state.status === "idle") setOpen(false);
    });
    const revision = updateRevision.current;
    void services
      .updateState()
      .then((state) => {
        if (updateRevision.current === revision) setUpdate(state);
      })
      .catch(() => {});
    return off;
  }, [services]);
  if (!update?.enabled || update.status === "idle") return null;
  const installationError =
    update.status === "error" && Boolean(update.downloaded || update.installing);
  const canDownload =
    update.status === "available" || (update.status === "error" && !installationError);
  const needsResources = update.status === "deferred" && Boolean(update.downloaded);
  const errorDetail =
    !update.installing && !update.downloaded && update.detail?.includes("ERR_NETWORK_CHANGED")
      ? t("common.update.networkChanged")
      : update.detail;
  const percent =
    typeof update.percent === "number" && Number.isFinite(update.percent)
      ? Math.max(0, Math.min(100, Math.round(update.percent)))
      : null;
  const performUpdate = async (action: () => Promise<UpdateState>, failureDetail: string) => {
    const revision = updateRevision.current;
    try {
      const state = await action();
      // 操作回包可能晚于后续状态事件到达，不能把安装状态退回下载中。
      if (updateRevision.current === revision) setUpdate(state);
    } catch (error) {
      console.warn("Update action failed", error);
      if (updateRevision.current === revision)
        setUpdate((current) => current && { ...current, status: "error", detail: failureDetail });
    }
  };
  const titles = {
    available: "common.update.available",
    downloading: "common.update.downloading",
    validating: "common.update.validating",
    deferred: "common.update.deferred",
    installing: "common.update.installing",
    error: installationError ? "common.update.installIncomplete" : "common.update.failed",
  } as const;
  const title = t(titles[update.status]);
  const descriptions = {
    available: "common.update.availableHelp",
    downloading: "common.update.downloadingHelp",
    validating: "common.update.validatingHelp",
    deferred: "common.update.deferredHelp",
    installing: "common.update.installingHelp",
    error: installationError ? "common.update.reopenHelp" : "common.update.retryHelp",
  } as const;
  const downloading = update.status === "downloading";
  const busy = downloading || update.status === "validating" || update.status === "installing";
  const indeterminate = busy && (!downloading || percent === null);
  const label = t("common.update.open", { state: title });
  const icon =
    update.status === "error" ? (
      <CircleAlert size={18} />
    ) : needsResources ? (
      <Check size={18} />
    ) : busy ? (
      <RefreshIcon size={16} />
    ) : (
      <Download size={18} />
    );
  return (
    <div
      className="areal-update-indicator"
      data-testid="areal-update-status"
      data-state={update.status}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {title}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              unstyled
              data-slot={undefined}
              type="button"
              className="areal-update-trigger"
              data-testid="areal-update-trigger"
              data-state={update.status}
              aria-label={label}
              title={downloading && percent !== null ? `${title} · ${percent}%` : title}
            />
          }
        >
          {busy && (
            <svg
              className="areal-update-ring"
              data-indeterminate={indeterminate || undefined}
              viewBox="0 0 36 36"
              aria-hidden="true"
            >
              <circle className="areal-update-ring-track" cx="18" cy="18" r="15" />
              <circle
                className="areal-update-ring-value"
                cx="18"
                cy="18"
                r="15"
                pathLength="100"
                strokeDasharray={indeterminate ? "24 76" : "100"}
                strokeDashoffset={indeterminate ? 0 : 100 - (percent ?? 0)}
              />
            </svg>
          )}
          {downloading && percent !== null ? (
            <span className="areal-update-percent">{percent}%</span>
          ) : (
            icon
          )}
          {update.status === "available" && (
            <span className="areal-update-dot" aria-hidden="true" />
          )}
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="end"
          sideOffset={12}
          className="areal-update-panel"
          aria-label={t("common.update.panel")}
        >
          <div className="areal-update-panel-heading">
            <span className="areal-update-state-icon" data-state={update.status} aria-hidden="true">
              {icon}
            </span>
            <div>
              <PopoverTitle>{title}</PopoverTitle>
              {update.version && (
                <p className="areal-update-version">
                  {t("common.update.version", { version: update.version })}
                </p>
              )}
            </div>
          </div>
          <PopoverDescription className="areal-update-description">
            {t(descriptions[update.status])}
          </PopoverDescription>
          {downloading && (
            <div className="areal-update-progress-section">
              <div className="areal-update-progress-caption">
                <span>
                  {percent === null
                    ? t("common.update.progressUnknown")
                    : t("common.update.progress")}
                </span>
                {percent !== null && (
                  <span className="areal-update-progress-number">{percent}%</span>
                )}
              </div>
              <div
                className="areal-update-progress"
                data-testid="areal-update-progress"
                role="progressbar"
                aria-label={t("common.update.progress")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                data-indeterminate={percent === null || undefined}
              >
                <span
                  style={{ transform: percent === null ? undefined : `scaleX(${percent / 100})` }}
                />
              </div>
            </div>
          )}
          {update.status === "deferred" && update.detail && (
            <p className="areal-update-detail">{update.detail}</p>
          )}
          {update.status === "error" && errorDetail && (
            <p className="areal-update-detail areal-update-error-detail" role="alert">
              {errorDetail}
            </p>
          )}
          {canDownload && services.downloadUpdate ? (
            <Button
              size="sm"
              className="areal-update-primary"
              data-testid="areal-update-download"
              aria-label={
                update.version
                  ? t(
                      update.status === "error"
                        ? "common.update.retryVersion"
                        : "common.update.downloadVersion",
                      { version: update.version },
                    )
                  : t("common.update.retryCheck")
              }
              onClick={() => {
                if (services.downloadUpdate)
                  void performUpdate(services.downloadUpdate, t("common.update.downloadFailed"));
              }}
            >
              {update.status === "error" ? <RefreshIcon size={16} /> : <Download size={16} />}
              {update.status === "error" ? t("common.update.retry") : t("common.update.download")}
            </Button>
          ) : needsResources && services.recoverUpdateResources ? (
            <Button
              size="sm"
              className="areal-update-primary"
              data-testid="areal-update-recover"
              aria-label={t("common.update.recoverLabel")}
              onClick={() => {
                if (services.recoverUpdateResources)
                  void performUpdate(
                    services.recoverUpdateResources,
                    t("common.update.recoveryFailed"),
                  );
              }}
            >
              {t("common.update.recover")}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
