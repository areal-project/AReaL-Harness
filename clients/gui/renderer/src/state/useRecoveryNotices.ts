import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
import { call, type Action, type Data, type PlatformServices, type Snapshot } from "../services.js";
import {
  isIndependentCreation,
  isTechnicalErrorMessage,
  recoveredOutcome,
  recoveryMessage,
  recoverySettings,
  type RecoveryFailure,
  type RecoveryNotice,
  type RecoveryOwner,
} from "../recoveryPresentation.js";

export function useRecoveryNotices(
  services: PlatformServices,
  snapshot: Snapshot,
  selection: RecoveryOwner,
) {
  const { t } = useI18n();
  const [notices, setNotices] = useState<RecoveryNotice[]>([]);
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(() => new Set());
  const selectedRecoveryOwner = useRef<RecoveryOwner>({
    projectId: "",
    threadId: "",
    connectionGeneration: 0,
  });
  const recoverySnapshot = useRef(snapshot);
  recoverySnapshot.current = snapshot;
  const setError = useCallback(
    (message: string) => {
      if (message)
        setNotices((previous) => [
          ...previous,
          {
            ...selectedRecoveryOwner.current,
            id: crypto.randomUUID(),
            kind: "error",
            message: isTechnicalErrorMessage(message) ? t("recovery.operationFailed") : message,
            detail: isTechnicalErrorMessage(message) ? message : undefined,
          },
        ]);
    },
    [t],
  );
  const dismissNotice = (id: string) =>
    setDismissedNotices((previous) => new Set(previous).add(id));
  selectedRecoveryOwner.current = selection;
  useEffect(() => {
    setNotices((previous) => {
      let changed = false;
      const observed = [...previous];
      for (const owner of snapshot.projects)
        for (const entry of owner.pending ?? []) {
          const requestId = entry.params?.requestId;
          const ownerThreadId = entry.params?.threadId ?? entry.params?.sourceThreadId ?? "";
          if (
            !requestId ||
            isIndependentCreation(entry, []) ||
            entry.method === "areal/side/create" ||
            entry.awaitingResponse ||
            observed.some(
              (notice) => notice.projectId === owner.id && notice.requestId === requestId,
            ) ||
            recoveredOutcome(owner, requestId, ownerThreadId, entry.operation)
          )
            continue;
          changed = true;
          observed.push({
            projectId: owner.id,
            threadId: ownerThreadId,
            connectionGeneration: owner.core?.connectionGeneration ?? 0,
            id: `operation:${owner.id}:${requestId}`,
            kind: "unconfirmed",
            requestId,
            operation: entry.operation,
            message: "操作结果尚未确认。正在核对原请求，不会自动重发。",
          });
        }
      const next = observed.flatMap<RecoveryNotice>((notice) => {
        if (notice.kind !== "unconfirmed" || !notice.requestId) return [notice];
        const owner = snapshot.projects.find((item) => item.id === notice.projectId);
        const operation =
          notice.operation ??
          owner?.pending?.find((entry: Data) => entry.params?.requestId === notice.requestId)
            ?.operation;
        const outcome =
          owner && recoveredOutcome(owner, notice.requestId, notice.threadId, operation);
        if (!outcome) {
          if (operation && !notice.operation) {
            changed = true;
            return [{ ...notice, operation }];
          }
          return [notice];
        }
        changed = true;
        return outcome.status === "failed" || outcome.accepted === false
          ? [
              {
                ...notice,
                id: `failed:${notice.id}`,
                kind: "error" as const,
                message:
                  outcome.message ||
                  (outcome.accepted === false
                    ? "操作未受理，输入已保留，请检查后重试。"
                    : "操作已受理，但执行失败，请检查结果。"),
              },
            ]
          : [];
      });
      return changed ? next : previous;
    });
  }, [snapshot.projects, notices]);
  const operationNotices = notices.filter(
    (notice) =>
      notice.projectId === selection.projectId &&
      notice.threadId === selection.threadId &&
      !dismissedNotices.has(notice.id),
  );
  const action: Action = useCallback<Action>(
    async (name, params) => {
      const selected = selectedRecoveryOwner.current;
      const target = recoverySnapshot.current.projects.find(
        (item) =>
          item.id ===
          (("projectId" in params ? params.projectId : undefined) ?? selected.projectId),
      );
      const owner = {
        projectId: ("projectId" in params ? params.projectId : undefined) ?? selected.projectId,
        threadId: ("threadId" in params ? params.threadId : undefined) ?? selected.threadId,
        connectionGeneration: target?.core?.connectionGeneration ?? selected.connectionGeneration,
      };
      const scoped =
        name === "workspace" &&
        selection.threadId &&
        "projectId" in params &&
        params.projectId === selection.projectId &&
        !("threadId" in params && params.threadId) &&
        "operation" in params &&
        typeof params.operation === "string" &&
        !params.operation.startsWith("worktree")
          ? { ...params, threadId: selection.threadId }
          : params;
      const request = ["create", "configure"].includes(name)
        ? {
            ...scoped,
            requestId:
              ("requestId" in params ? params.requestId : undefined) ?? crypto.randomUUID(),
          }
        : scoped;
      try {
        return await call(services, name, request);
      } catch (cause) {
        const failure = cause as RecoveryFailure;
        const composerRefusal = name === "send" && failure.outcome?.kind === "rejected";
        if (
          !composerRefusal &&
          !["providers", "chatgpt", "prediction", "history"].includes(name) &&
          !(name === "respond" && "answers" in params && params.answers) &&
          name !== "media" &&
          name !== "feedback" &&
          !(name === "manage" && "operation" in params && params.operation === "goalCreate")
        ) {
          const operation =
            failure.outcome && "operation" in failure.outcome
              ? failure.outcome.operation
              : undefined;
          const requestId =
            operation?.requestId ??
            failure.requestId ??
            ("requestId" in request && typeof request.requestId === "string"
              ? request.requestId
              : undefined);
          const unconfirmed =
            failure.submissionUnknown === true ||
            failure.outcome?.kind === "admitted" ||
            failure.outcome?.kind === "unconfirmed";
          const id =
            unconfirmed && requestId
              ? `operation:${owner.projectId}:${requestId}`
              : crypto.randomUUID();
          const latest = recoverySnapshot.current.projects.find(
            (item) => item.id === owner.projectId,
          );
          if (
            (latest?.core?.connectionGeneration ?? owner.connectionGeneration) ===
            owner.connectionGeneration
          ) {
            const pendingOperation = latest?.pending?.find(
              (entry: Data) => entry.params?.requestId === requestId,
            )?.operation;
            setNotices((previous) => [
              ...previous.filter((notice) => notice.id !== id),
              {
                ...owner,
                id,
                requestId,
                operation: operation ?? pendingOperation,
                kind: unconfirmed ? "unconfirmed" : "error",
                message: recoveryMessage(failure),
                settings: recoverySettings(failure),
                detail: [failure.message, failure.code, failure.reason, operation?.method]
                  .filter((value) => value !== undefined)
                  .join("\n"),
              },
            ]);
          }
        }
        throw cause;
      }
    },
    [services, selection.projectId, selection.threadId],
  );
  return { operationNotices, dismissedNotices, dismissNotice, setError, action };
}
