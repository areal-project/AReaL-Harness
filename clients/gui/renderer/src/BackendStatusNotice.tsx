import { useEffect, useRef } from "react";
import { Button } from "./components/ui/button.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { toast, type ToastTone } from "./components/ui/toast.js";
import { useI18n, type MessageId } from "./i18n/IntlProvider.js";
import type { Snapshot } from "./services.js";

export type BackendStatusAction = "update" | "check" | "reconnect" | "recover" | "status";

export type BackendStatusProps = {
  connection: Snapshot["connection"];
  update: Snapshot["backendUpdate"];
  lifecycle?: Snapshot["lifecycle"];
  summary?: Snapshot["serviceSummary"];
  currentCommands?: boolean;
  pending: boolean;
  error: string;
  detail?: string;
  onAction: (action: BackendStatusAction) => void;
};

function backendPresentation({ connection, update, lifecycle, summary, currentCommands, error, detail }: BackendStatusProps) {
  let message: Extract<MessageId, `backend.${string}`>;
  let diagnostic: string | undefined;
  let tone: ToastTone = "warning";
  let action: BackendStatusAction | undefined;
  if (lifecycle?.error) {
    message = "backend.operationFailed";
    diagnostic = error || lifecycle.error;
    tone = "error";
    action = "check";
  } else if (lifecycle?.recovery) {
    message = "backend.operationUnconfirmed";
    diagnostic = error || lifecycle.recovery.message;
    action = 'check';
  } else if (lifecycle?.phase === "completed" && lifecycle.desktopExit === "requested"
    && ["updateDesktop", "stopDesktop"].includes(lifecycle.kind ?? "")) {
    const updateCompleted = lifecycle.kind === "updateDesktop";
    message = updateCompleted ? "backend.updateStopped" : "backend.stoppedConfirmed";
    diagnostic = error;
    tone = "info";
    action = updateCompleted ? "update" : "reconnect";
  } else if (lifecycle?.phase && ["acceptedPending", "admissionUnconfirmed", "partial", "settlementIncomplete"].includes(lifecycle.phase)) {
    message = lifecycle.phase === "acceptedPending" ? "backend.operationPending" : "backend.operationUnconfirmed";
    diagnostic = error || lifecycle.message;
    action = "check";
  } else if (connection?.recovery === "check") {
    message = "backend.operationUnconfirmed";
    diagnostic = error || connection.message || detail;
    action = "check";
  } else if (update?.state === "applying") {
    message = "backend.updating";
    tone = "info";
    action = "update";
  } else if (connection?.state === "connecting") {
    message = "backend.reconnecting";
    diagnostic = error || connection.message || detail;
    tone = "info";
  } else if (connection?.state === "unavailable") {
    message = "backend.unavailable";
    diagnostic = error || connection.message || detail;
    action = "reconnect";
  } else if (connection?.state === "ready" && update?.state === "failed") {
    message = "backend.updateFailed";
    diagnostic = error || update.message;
    tone = "error";
    action = "update";
  } else if (connection?.state === "ready" && currentCommands === false) {
    message = "backend.updateRequired";
    diagnostic = error;
    action = "update";
  } else if (connection?.state === "ready" && update?.state === "pending") {
    message = "backend.updatePending";
    diagnostic = error;
    tone = "info";
    action = "update";
  } else if (connection?.state === "ready") {
    return null;
  } else {
    message = summary?.state === "stopped" ? "backend.stopped" : "backend.checkState";
    diagnostic = error || detail;
    action = "status";
  }
  const retryUpdate = action === "check" && lifecycle?.kind === "updateDesktop"
    && lifecycle.desktopExit !== "requested" && lifecycle.targets !== undefined
    && lifecycle.targets.every(target => ["completed", "blocked", "settlementIncomplete"].includes(target.phase))
    && ["partial", "settlementIncomplete", "acceptedPending"].includes(lifecycle.phase ?? "");
  const notify = message !== "backend.reconnecting" && message !== "backend.updatePending" && message !== "backend.checkState" && message !== "backend.stopped";
  return { message, diagnostic, tone, action, retryUpdate, notify };
}

export function BackendStatusNotice(props: BackendStatusProps) {
  const { t } = useI18n();
  const presentation = backendPresentation(props);
  const message = presentation?.message;
  const tone = presentation?.tone;
  const key = presentation?.notify ? `${props.lifecycle?.requestId ?? ""}:${presentation.message}` : "";
  const last = useRef("");
  useEffect(() => {
    if (!key || !message || !tone) { last.current = ""; return; }
    if (last.current === key) return;
    const announce = () => {
      last.current = key;
      toast(t(message), tone);
    };
    if (message === "backend.unavailable") {
      const timer = window.setTimeout(announce, 1200);
      return () => window.clearTimeout(timer);
    }
    announce();
  }, [key, message, tone, t]);
  return null;
}

export function BackendServiceStatus(props: BackendStatusProps) {
  const { t } = useI18n();
  const presentation = backendPresentation(props);
  if (!presentation) return null;
  const { message, diagnostic, tone, action, retryUpdate } = presentation;
  const { lifecycle, pending, update, onAction } = props;
  const applying = action === "update" && (pending || update?.state === "applying");
  // 后台设置页的操作状态和控件属于页面内容，不能随操作通知消失。
  return <div data-testid="backend-service-status"><FeedbackNotice transient={false} tone={tone} message={t(applying ? "backend.updating" : message)}
    detail={diagnostic} actions={<>
    {lifecycle?.recovery && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onAction("recover")}>
      {t("backend.recover")}
    </Button>}
    {retryUpdate && <Button type="button" variant="outline" size="sm" disabled={pending || update?.state === "applying"} onClick={() => onAction("update")}>
      {t("backend.update")}
    </Button>}
    {action && action !== "status" && <Button type="button" variant="outline" size="sm" disabled={pending || update?.state === "applying"} onClick={() => onAction(action)}>
      {t(applying ? "backend.updatingAction" : action === "update" ? "backend.update" : action === "check" ? "backend.check" : "backend.reconnect")}
    </Button>}
  </>} /></div>;
}
