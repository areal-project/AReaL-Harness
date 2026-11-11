import { Button } from "../components/ui/button.js";
import { rawText } from "../errors/errorCopy.js";
import { FeedbackNotice } from "../FeedbackNotice.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { isTechnicalErrorMessage, recoverySettings } from "../recoveryPresentation.js";
import { useRecoveryNotices } from "../state/useRecoveryNotices.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";
import { useStartupRecovery } from "../state/useStartupRecovery.js";
import { useWorkbenchSurfaces } from "../state/useWorkbenchSurfaces.js";
type RecoveryNoticesProps = {
  recovery: ReturnType<typeof useRecoveryNotices>;
  startup: ReturnType<typeof useStartupRecovery>;
  session: ReturnType<typeof useSessionNavigation>;
  surfaces: ReturnType<typeof useWorkbenchSurfaces>;
};
export function RecoveryNotices({ recovery, startup, session, surfaces }: RecoveryNoticesProps) {
  const { operationNotices, dismissedNotices, dismissNotice } = recovery;
  const { restorationError, restorationFailed, restorationNoticeId, viewFailure } = startup;
  const { setSettingsTab, setSettingsOpen } = surfaces;
  const { retryRestoration } = session;
  const { t } = useI18n();
  return (
    <>
      {operationNotices.map((notice) => (
        <FeedbackNotice
          key={notice.id}
          tone={notice.kind === "unconfirmed" ? "warning" : "error"}
          transient
          message={
            notice.kind === "unconfirmed"
              ? t(
                  /turn\/(start|enqueue|submit)$/.test(notice.operation?.method ?? "")
                    ? "recovery.sendUnresolved"
                    : "recovery.operationUnresolved",
                )
              : isTechnicalErrorMessage(notice.message)
                ? t("recovery.operationFailed")
                : notice.message
          }
          requestId={notice.requestId}
          onDismiss={() => dismissNotice(notice.id)}
          detail={
            notice.requestId || notice.detail || isTechnicalErrorMessage(notice.message) ? (
              <>
                {notice.requestId && <div>{t("recovery.requestId", { id: notice.requestId })}</div>}
                {(notice.detail || isTechnicalErrorMessage(notice.message)) && (
                  <pre>{notice.detail || notice.message}</pre>
                )}
              </>
            ) : undefined
          }
          actions={
            <>
              {notice.settings && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSettingsTab(notice.settings!);
                    setSettingsOpen(true);
                  }}
                >
                  {t(
                    notice.settings === "模型服务"
                      ? "recovery.checkModelSettings"
                      : "recovery.checkSessionSettings",
                  )}
                </Button>
              )}
            </>
          }
        />
      ))}
      {/* 对话区读不出来时原位已有说明和重试；只有对话仍显示旧内容时才提醒。 */}
      {restorationFailed && session.thread && !dismissedNotices.has(restorationNoticeId) && (
        <FeedbackNotice
          tone="error"
          message={restorationError}
          detail={
            viewFailure && rawText(viewFailure) !== restorationError
              ? rawText(viewFailure)
              : undefined
          }
          onDismiss={() => dismissNotice(restorationNoticeId)}
          actions={
            <>
              {viewFailure && recoverySettings(viewFailure) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSettingsTab(recoverySettings(viewFailure)!);
                    setSettingsOpen(true);
                  }}
                >
                  {t("recovery.checkSettings")}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => void retryRestoration()}>
                {t("recovery.retryView")}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
