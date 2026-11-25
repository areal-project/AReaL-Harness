import {
  recoveryMessage,
  recoverySettings,
  sameRestorationOwner,
} from "../recoveryPresentation.js";
import type { Translate } from "../i18n/uiMessage.js";
import type { useSessionNavigation } from "./useSessionNavigation.js";

export function startupReadyForPresentation(input: {
  themeReady: boolean;
  connectionState: string | undefined;
  selectionReady: boolean;
  restorationFailed: boolean;
  startupLifecycleBlocked: boolean;
  project: unknown;
  currentRestoration: unknown;
}) {
  return (
    input.themeReady &&
    input.connectionState === "ready" &&
    input.selectionReady &&
    !input.restorationFailed &&
    !input.startupLifecycleBlocked &&
    (input.project === undefined || input.currentRestoration !== undefined)
  );
}

export function useStartupRecovery(
  session: ReturnType<typeof useSessionNavigation>,
  themeReady: boolean,
  t: Translate,
) {
  const { snapshot, project, threadId, restoration, restorationOwner, selectionReady } = session;
  const currentRestoration = sameRestorationOwner(restoration, restorationOwner)
    ? restoration
    : undefined;
  const observationFailure = project?.observationErrors?.[threadId];
  const conversationRead = project?.conversationReads?.[threadId];
  const conversationReadState =
    conversationRead?.connectionGeneration === restorationOwner.connectionGeneration
      ? conversationRead.state
      : undefined;
  const currentObservationFailure =
    observationFailure &&
    (observationFailure.connectionGeneration === undefined ||
      observationFailure.connectionGeneration === restorationOwner.connectionGeneration)
      ? observationFailure
      : undefined;
  const viewFailure = currentObservationFailure?.code
    ? currentObservationFailure
    : (currentRestoration?.failure ?? currentObservationFailure);
  const isCloudSession = Boolean(
    project?.state?.threads?.[threadId]?.cloud ??
    project?.summaries?.find((summary: { id: string; cloud?: unknown }) => summary.id === threadId)
      ?.cloud,
  );
  const restorationError = viewFailure
    ? recoveryMessage(viewFailure, "view", t)
    : currentRestoration?.error || "";
  const reconnectingView =
    snapshot.connection?.state === "connecting" &&
    !!viewFailure &&
    viewFailure.recovery?.kind !== "needsUser" &&
    !recoverySettings(viewFailure) &&
    !["HISTORY_BUDGET_TOO_SMALL", "RESPONSE_TOO_LARGE"].includes(String(viewFailure.code)) &&
    (viewFailure.recovery?.kind === "retryRead" ||
      [
        "DISCONNECTED",
        "CONNECTION_LOST",
        "TIMEOUT",
        "RESPONSE_UNKNOWN",
        "TRANSPORT_FAILURE",
      ].includes(String(viewFailure.code)) ||
      (!viewFailure.code &&
        /连接中断|已断开|正在恢复|disconnect|timeout|connection|transport/i.test(
          viewFailure.message, // raw-error-ok: 只进详情
        )));
  const viewRefreshing =
    !!currentObservationFailure?.refreshPending || !!currentRestoration?.pending;
  const restorationFailed = !!restorationError && !viewRefreshing && !reconnectingView;
  const startupLifecycle = snapshot.lifecycle;
  const startupLifecycleBlocked =
    !!startupLifecycle?.error ||
    !!startupLifecycle?.recovery ||
    ["acceptedPending", "admissionUnconfirmed", "partial", "settlementIncomplete"].includes(
      startupLifecycle?.phase ?? "",
    );
  // 启动壳只等待 Host、主题和选择收敛；历史正文由会话区自己的读取状态承载。
  // 如果把正文读取也放在这里，慢历史会让整页停留在启动 Loading，随后再闪失败页。
  const startupReady = startupReadyForPresentation({
    themeReady,
    connectionState: snapshot.connection?.state,
    selectionReady,
    restorationFailed,
    startupLifecycleBlocked,
    project,
    currentRestoration,
  });
  const projectFailureReady =
    themeReady &&
    snapshot.connection?.state === "ready" &&
    selectionReady &&
    !!project &&
    restorationFailed &&
    !startupLifecycleBlocked;
  const restorationNoticeId =
    currentObservationFailure?.id ??
    currentRestoration?.failureId ??
    `connection:${restorationOwner.projectId}:${restorationOwner.connectionGeneration}:${restorationError}`;
  return {
    currentRestoration,
    viewFailure,
    restorationError,
    reconnectingView,
    viewRefreshing,
    restorationFailed,
    startupLifecycle,
    startupLifecycleBlocked,
    startupReady,
    projectFailureReady,
    restorationNoticeId,
    conversationReadState,
    isCloudSession,
  };
}
