import { recoveryMessage, recoverySettings, sameRecoveryOwner } from "../recoveryPresentation.js";
import type { useSessionNavigation } from "./useSessionNavigation.js";

export function useStartupRecovery(
  session: ReturnType<typeof useSessionNavigation>,
  themeReady: boolean,
) {
  const { snapshot, project, thread, threadId, restoration, restorationOwner, selectionReady } =
    session;
  const currentRestoration = sameRecoveryOwner(restoration, restorationOwner)
    ? restoration
    : undefined;
  const observationFailure = project?.observationErrors?.[threadId];
  const currentObservationFailure =
    observationFailure &&
    (observationFailure.connectionGeneration === undefined ||
      observationFailure.connectionGeneration === restorationOwner.connectionGeneration)
      ? observationFailure
      : undefined;
  const viewFailure = currentObservationFailure ?? currentRestoration?.failure;
  const restorationError = viewFailure
    ? recoveryMessage(viewFailure, "view")
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
          viewFailure.message,
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
  const startupReady =
    themeReady &&
    snapshot.connection?.state === "ready" &&
    selectionReady &&
    !restorationFailed &&
    !startupLifecycleBlocked &&
    (!project || (currentRestoration && !currentRestoration.pending && (!threadId || !!thread)));
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
  };
}
