import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useI18n, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useRef, useState } from "react";
import type { TrajectoryStatus } from "@areal/workbench/desktop-contract";
import { Button } from "../components/ui/button.js";
import type { Action } from "../services.js";
import { useTrajectoryPolling } from "./useTrajectoryPolling.js";
import { UserFeedbackPreference } from "./UserFeedbackPreference.js";
import { TrajectoryToggle } from "./TrajectoryToggle.js";
import type { TrajectoryOperation } from "../lib/trajectory-polling.js";
import { SettingsBadge } from "./SettingsPageParts.js";

const RECORDS_PER_PAGE = 15;

const recordLabels = {
  pending: "settings.trajectorySettings.recordStatus.pending",
  uploading: "settings.trajectorySettings.recordStatus.uploading",
  failed: "settings.trajectorySettings.recordStatus.failed",
  uploaded: "settings.trajectorySettings.uploaded",
  evicted: "settings.trajectorySettings.recordStatus.evicted",
} as const;
const stateLabels = {
  disabled: "settings.trajectorySettings.captureState.disabled",
  ready: "settings.trajectorySettings.captureState.ready",
  degraded: "settings.trajectorySettings.captureState.degraded",
  invalid: "settings.trajectorySettings.captureState.invalid",
} as const;
export function TrajectorySettings({
  action,
  connected,
  onStatus,
}: {
  action: Action;
  connected: boolean;
  onStatus: (status: TrajectoryStatus | null) => void;
}) {
  const { t, intl } = useI18n();
  const size = (bytes: number) =>
    bytes < 1024
      ? intl.formatNumber(bytes, { style: "unit", unit: "byte", unitDisplay: "short" })
      : intl.formatNumber(bytes / (bytes < 1024 ** 2 ? 1024 : 1024 ** 2), {
          maximumFractionDigits: 1,
          minimumFractionDigits: 1,
        }) + (bytes < 1024 ** 2 ? " KiB" : " MiB");
  const date = (value: number | null) =>
    value == null
      ? t("settings.trajectorySettings.noRecords")
      : intl.formatDate(value, { dateStyle: "medium", timeStyle: "medium" });
  const duration = (value: number | null | undefined) =>
    value == null
      ? t("settings.trajectorySettings.unknownDuration")
      : intl.formatNumber(value, {
          style: "unit",
          unit: "millisecond",
          unitDisplay: "short",
          maximumFractionDigits: 3,
        });
  const [status, setStatus] = useState<TrajectoryStatus | null>(null);
  const [recordPage, setRecordPage] = useState(1);
  const recordsTop = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<TrajectoryOperation | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | UiMessage>(""),
    [notice, setNotice] = useState<string | UiMessage>(""),
    [checkedAt, setCheckedAt] = useState<number | null>(null);
  const lastStatus = useRef<TrajectoryStatus | null>(null);
  const refresh = useTrajectoryPolling(action, {
    connected,
    intervalMs: 2500,
    onResult(value, operation) {
      lastStatus.current = value;
      setStatus(value);
      // 刷新保留正在阅读的页；记录减少时收敛到仍然存在的最后一页。
      setRecordPage((page) =>
        Math.min(page, Math.max(1, Math.ceil(value.records.length / RECORDS_PER_PAGE))),
      );
      setError("");
      setCheckedAt(Date.now());
      onStatus(value);
      if (operation === "retry")
        setNotice({
          id: "settings.trajectorySettings.retryRequestedUploadProgressWillUpdateAutomatically",
        });
      if (operation === "enable" || operation === "disable")
        setNotice(
          value.capture_apply_error ||
            (value.capture_apply_pending
              ? { id: "settings.trajectorySettings.uploadControlsAppliedCaptureSettingsWillApply" }
              : operation === "enable"
                ? { id: "settings.trajectorySettings.dataFlywheelIsOnTheBackgroundService" }
                : { id: "settings.trajectorySettings.dataFlywheelIsOffSavedTrajectoriesRemain" }),
        );
    },
    onError(cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : { id: "settings.trajectorySettings.couldNotReadTrajectoryUploadStatus" },
      );
      onStatus(null);
    },
    onBusy(operation) {
      setWorking(operation !== null);
      // 后台刷新保留上次结果和错误；仅首次加载或显式操作显示读取中。
      if (!operation || operation !== "status" || !lastStatus.current) setBusy(operation);
    },
  });
  const run = (operation: TrajectoryOperation) => {
    if (refresh(operation)) {
      setBusy(operation);
      if (operation !== "status") setNotice("");
    }
  };
  const stale = !connected || !!error;
  const recordCount = status?.records.length ?? 0;
  const recordPageCount = Math.max(1, Math.ceil(recordCount / RECORDS_PER_PAGE));
  const recordOffset = (recordPage - 1) * RECORDS_PER_PAGE;
  const visibleRecords = status?.records.slice(recordOffset, recordOffset + RECORDS_PER_PAGE) ?? [];
  const changeRecordPage = (page: number, position: "top" | "bottom") => {
    setRecordPage(page);
    if (position === "bottom") {
      recordsTop.current?.focus({ preventScroll: true });
      recordsTop.current?.scrollIntoView({ block: "start" });
    }
  };
  const recordPagination = (position: "top" | "bottom") =>
    recordCount > 0 && (
      <nav
        ref={position === "top" ? recordsTop : undefined}
        tabIndex={-1}
        aria-label={t("settings.trajectorySettings.uploadRecordsPagination")}
        className="flex flex-wrap items-center justify-between gap-field"
      >
        <p className="settings-section-desc" role={position === "top" ? "status" : undefined}>
          {t("settings.trajectorySettings.recordRange", {
            from: recordOffset + 1,
            to: Math.min(recordOffset + RECORDS_PER_PAGE, recordCount),
            total: recordCount,
          })}
        </p>
        <div className="flex items-center gap-inline">
          <Button
            size="sm"
            variant="outline"
            disabled={recordPage === 1}
            onClick={() => changeRecordPage(recordPage - 1, position)}
          >
            {t("settings.trajectorySettings.previousPage")}
          </Button>
          <span className="settings-section-desc whitespace-nowrap">
            {t("settings.trajectorySettings.recordPage", {
              page: recordPage,
              total: recordPageCount,
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={recordPage >= recordPageCount}
            onClick={() => changeRecordPage(recordPage + 1, position)}
          >
            {t("settings.trajectorySettings.nextPage")}
          </Button>
        </div>
      </nav>
    );
  return (
    <div
      className="settings-sections"
      aria-label={t("settings.trajectorySettings.dataFlywheelStatus")}
    >
      <UserFeedbackPreference action={action} connected={connected} />
      <SettingsSection
        title={t("settings.trajectorySettings.trajectoryUploads")}
        description={t("settings.trajectorySettings.uploadsRunInTheBackgroundStatusUpdates")}
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!connected || working}
            onClick={() => void run("status")}
          >
            {t("settings.trajectorySettings.refreshUploadStatus")}
          </Button>
        }
      >
        {!connected && (
          <p role="status" className="settings-section-desc">
            {t("settings.trajectorySettings.backgroundServiceDisconnected")}
          </p>
        )}
        <p role="status" className="settings-section-desc">
          {busy === "status"
            ? t("settings.trajectorySettings.reading")
            : busy === "retry"
              ? t("settings.trajectorySettings.requestingRetry")
              : busy === "enable" || busy === "disable"
                ? t("settings.trajectorySettings.applyingChange")
                : checkedAt
                  ? t("settings.trajectorySettings.lastChecked", {
                      time: intl.formatTime(checkedAt, { timeStyle: "medium" }),
                      stale: String(stale),
                    })
                  : t("settings.trajectorySettings.uploadStatusHasNotBeenRead")}
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {formatUiMessage(t, error)}
            {status && <> {t("settings.trajectorySettings.staleResult")}</>}
          </p>
        )}
        {notice && <p role="status">{formatUiMessage(t, notice)}</p>}
        {status && (
          <SettingsGroupCard>
            <SettingsRow
              label={t("settings.trajectorySettings.dataFlywheel")}
              description={
                status.enabled
                  ? status.capture_apply_error ||
                    (status.capture_apply_pending
                      ? t("settings.trajectorySettings.backgroundUploadsAreOnNewCaptureSettings")
                      : t("settings.trajectorySettings.backgroundTrajectoryUploadsAreOnReEnabling"))
                  : t("settings.trajectorySettings.trajectoryExportIsOffConfigurationAndDisk")
              }
              control={
                <TrajectoryToggle
                  status={status}
                  busy={working}
                  stale={stale}
                  onChange={(enabled) => run(enabled ? "enable" : "disable")}
                />
              }
            />
            <SettingsRow
              label={t("settings.trajectorySettings.configurationStatus")}
              control={<SettingsBadge>{t(stateLabels[status.state])}</SettingsBadge>}
              description={
                status.config_revision === "missing"
                  ? t("settings.trajectorySettings.configureTheDestinationAndAuthenticationInUser")
                  : !/^[a-f0-9]{64}$/.test(status.config_revision ?? "")
                    ? t("settings.trajectorySettings.thisCoreDoesNotProvideAControl")
                    : t(
                        "settings.trajectorySettings.manageTheDestinationAuthenticationAndCapacityIn",
                      )
              }
            />
            <SettingsRow
              label={t("settings.trajectorySettings.uploadProcess")}
              description={
                status.worker_running
                  ? t("settings.trajectorySettings.theBackgroundUploadProcessIsRunning")
                  : t("settings.trajectorySettings.refreshingDoesNotStartTheUploadProcess")
              }
              control={
                <span>
                  {status.worker_running
                    ? t("settings.trajectorySettings.running")
                    : t("settings.trajectorySettings.notRunning")}
                </span>
              }
            />
            <SettingsRow
              label={t("settings.trajectorySettings.uploadDestination")}
              control={null}
              description={
                <span className="break-all">
                  {status.endpoint || t("settings.trajectorySettings.notConfigured")}
                </span>
              }
            />
          </SettingsGroupCard>
        )}
      </SettingsSection>
      {status && (
        <>
          <SettingsSection
            title={t("settings.trajectorySettings.queueAndFailures")}
            description={t("settings.trajectorySettings.thisReflectsTheUploadQueueOnlyIt")}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !connected ||
                  working ||
                  !!error ||
                  !status.enabled ||
                  status.state === "invalid" ||
                  status.queue.pending + status.queue.failed + status.queue.uploading === 0
                }
                onClick={() => void run("retry")}
              >
                {t("settings.trajectorySettings.retryUploads")}
              </Button>
            }
          >
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.trajectorySettings.pendingUploadingFailed")}
                control={
                  <span>
                    {intl.formatNumber(status.queue.pending)} /{" "}
                    {intl.formatNumber(status.queue.uploading)} /{" "}
                    {intl.formatNumber(status.queue.failed)}
                  </span>
                }
              />
              <SettingsRow
                label={t("settings.trajectorySettings.uploaded")}
                control={<span>{intl.formatNumber(status.queue.uploaded)}</span>}
                description={t("settings.trajectorySettings.lastSuccessfulUploadValue", {
                  value0: date(status.last_success_at),
                })}
              />
              <SettingsRow
                label={t("settings.trajectorySettings.queueStorage")}
                control={
                  <span>
                    {size(status.queue.bytes)} / {size(status.queue.max_bytes)}
                  </span>
                }
              />
              <SettingsRow
                label={t("settings.trajectorySettings.evictedDroppedFromMemoryTooLarge")}
                control={
                  <span>
                    {intl.formatNumber(status.queue.evicted)} /{" "}
                    {intl.formatNumber(status.queue.dropped_memory)} /{" "}
                    {intl.formatNumber(status.queue.dropped_oversize)}
                  </span>
                }
                description={t("settings.trajectorySettings.evictedOrDroppedDataCannotBeRecovered")}
              />
              <SettingsRow
                label={t("settings.trajectorySettings.latestFailure")}
                control={null}
                description={
                  <span className="break-all">
                    {status.last_error || t("settings.trajectorySettings.noFailuresRecorded")}
                  </span>
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
          <SettingsSection
            title={t("settings.trajectorySettings.modelCallDuration")}
            description={t("settings.trajectorySettings.recentModelRecords", {
              value0: status.model_call_summary?.records_considered ?? status.records.length,
            })}
          >
            {status.model_call_summary ? (
              <SettingsGroupCard>
                <SettingsRow
                  label={t("settings.trajectorySettings.modelCallsWithDurationData")}
                  control={<span>{intl.formatNumber(status.model_call_summary.model_calls)}</span>}
                  description={t("settings.trajectorySettings.upToTheLatest100RecordsRetries")}
                />
                <SettingsRow
                  label={t("settings.trajectorySettings.totalAverageMaximumCallDuration")}
                  control={null}
                  description={[
                    duration(status.model_call_summary.total_duration_ms),
                    duration(status.model_call_summary.mean_duration_ms),
                    duration(status.model_call_summary.max_duration_ms),
                  ].join(" / ")}
                />
              </SettingsGroupCard>
            ) : (
              <p className="settings-section-desc">
                {t("settings.trajectorySettings.thisCoreDoesNotProvideAModel")}
              </p>
            )}
          </SettingsSection>
          <SettingsSection
            title={t("settings.trajectorySettings.recentUploadRecords")}
            description={t("settings.trajectorySettings.showsUpToTheLatest100Records", {
              pageSize: RECORDS_PER_PAGE,
            })}
          >
            {recordPagination("top")}
            <SettingsGroupCard>
              {status.records.length === 0 ? (
                <p className="p-4 settings-section-desc">
                  {t("settings.trajectorySettings.noTrajectoryUploadRecordsYet")}
                </p>
              ) : (
                visibleRecords.map((record) => (
                  <SettingsRow
                    key={record.id}
                    label={<span className="break-all">{record.id}</span>}
                    control={<SettingsBadge>{t(recordLabels[record.status])}</SettingsBadge>}
                    description={
                      <>
                        {record.turn_id && (
                          <p className="break-all">
                            {t("settings.trajectorySettings.recordTurn", {
                              turn: record.turn_id,
                            })}
                          </p>
                        )}
                        {(record.model_name || record.harness_version) && (
                          <p className="break-all">
                            {[
                              record.model_name &&
                                t("settings.trajectorySettings.modelValue", {
                                  value0: record.model_name,
                                }),
                              record.harness_version &&
                                t("settings.trajectorySettings.recordHarness", {
                                  version: record.harness_version,
                                }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                        {record.event_name && (
                          <p className="break-all">
                            {t("settings.trajectorySettings.recordEvent", {
                              event: record.event_name,
                            })}
                          </p>
                        )}
                        {record.occurred_at != null && record.occurred_at > 0 && (
                          <p>
                            {t("settings.trajectorySettings.recordEventTime", {
                              date: date(record.occurred_at),
                            })}
                          </p>
                        )}
                        {record.execution_duration_ms != null && (
                          <p>
                            {t("settings.trajectorySettings.recordAgentDuration", {
                              duration: duration(record.execution_duration_ms),
                            })}
                          </p>
                        )}
                        {record.model_call_duration_ms != null && (
                          <p>
                            {t("settings.trajectorySettings.recordModelDuration", {
                              duration: duration(record.model_call_duration_ms),
                            })}
                          </p>
                        )}
                        <span>
                          {t("settings.trajectorySettings.recordCreatedDetails", {
                            date: date(record.created_at),
                            size: size(record.bytes),
                            attempts: record.attempts,
                          })}
                        </span>
                        {record.uploaded_at != null && (
                          <p>
                            {t("settings.trajectorySettings.recordUploadTime", {
                              date: date(record.uploaded_at),
                            })}
                          </p>
                        )}
                        {record.next_attempt_at != null &&
                          record.status !== "uploaded" &&
                          record.status !== "evicted" && (
                            <p>
                              {t("settings.trajectorySettings.recordNextAttempt", {
                                date: date(record.next_attempt_at),
                              })}
                            </p>
                          )}
                        {record.error && (
                          <p className="break-all text-destructive">{record.error}</p>
                        )}
                      </>
                    }
                  />
                ))
              )}
            </SettingsGroupCard>
            {recordPagination("bottom")}
          </SettingsSection>
        </>
      )}
      <SettingsDisclosure title={t("settings.trajectorySettings.uploadConfigurationAndLimits")}>
        {status && (
          <SettingsGroupCard>
            {status.configPath && (
              <SettingsRow
                label={t("settings.trajectorySettings.configurationFile")}
                control={null}
                description={<span className="break-all">{status.configPath}</span>}
              />
            )}
            <SettingsRow
              label={t("settings.trajectorySettings.localUploadCache")}
              control={null}
              description={<span className="break-all">{status.spool_dir}</span>}
            />
            <SettingsRow
              label={t("settings.trajectorySettings.retryAndBufferLimits")}
              control={null}
              description={t("settings.trajectorySettings.retryLimits", {
                value0: status.limits.max_retries,
                value1: duration(status.limits.upload_interval_ms),
                value2: size(status.limits.max_memory_bytes),
              })}
            />
          </SettingsGroupCard>
        )}
        <p className="settings-section-desc">
          {t("settings.trajectorySettings.configureTheUploadDestinationAndAuthenticationBefore")}
        </p>
        <p className="settings-section-desc">
          {t("settings.trajectorySettings.configurationInstructions")}
        </p>
      </SettingsDisclosure>
    </div>
  );
}
