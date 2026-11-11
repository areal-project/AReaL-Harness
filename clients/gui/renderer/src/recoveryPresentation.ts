import type { DesktopError } from "./services.js";
import type { Data } from "./services.js";
import { ERROR_CODES, errorCode, errorText, rawText } from "./errors/errorCopy.js";
import { UiMessageError, type Translate } from "./i18n/uiMessage.js";

export type RecoveryFailure = DesktopError;
export type RecoveryOperation = Extract<
  NonNullable<DesktopError["outcome"]>,
  { operation: unknown }
>["operation"];
export type RecoveryOwner = { projectId: string; threadId: string; connectionGeneration: number };
export type RecoveryNotice = RecoveryOwner & {
  id: string;
  message: string;
  kind: "error" | "unconfirmed";
  requestId?: string;
  operation?: RecoveryOperation;
  settings?: "模型服务" | "会话配置";
  detail?: string;
};
type PendingOperation = {
  method?: string;
  params?: { requestId?: string; threadId?: string; taskId?: string };
  operation?: RecoveryOperation;
};
export function isIndependentCreation(
  entry: PendingOperation,
  ownRequestIds: readonly (string | null | undefined)[],
) {
  const requestId = entry.params?.requestId;
  return (
    entry.method === "areal/thread/start" &&
    typeof requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId) &&
    !ownRequestIds.includes(requestId) &&
    !entry.params?.threadId &&
    !entry.params?.taskId &&
    (!entry.operation ||
      (entry.operation.requestId === requestId &&
        entry.operation.method === entry.method &&
        entry.operation.target?.kind === "project"))
  );
}
export function sameRecoveryOwner(left: RecoveryOwner | undefined, right: RecoveryOwner) {
  return (
    left?.projectId === right.projectId &&
    left.threadId === right.threadId &&
    left.connectionGeneration === right.connectionGeneration
  );
}
export function sameRecoveryOperation(left: RecoveryOperation, right: RecoveryOperation) {
  return (
    left.requestId === right.requestId &&
    left.method === right.method &&
    left.target.kind === right.target.kind &&
    (left.target.kind !== "thread" ||
      (right.target.kind === "thread" && left.target.threadId === right.target.threadId)) &&
    (left.target.kind !== "task" ||
      (right.target.kind === "task" && left.target.taskId === right.target.taskId))
  );
}
export function recoveredOutcome(
  project: Data,
  requestId: string,
  threadId: string,
  operation?: RecoveryOperation,
): Data | undefined {
  if (!operation || operation.requestId !== requestId) return;
  const outcome = project.outcomes?.[requestId];
  if (!outcome || (outcome.status && !["completed", "failed"].includes(outcome.status))) return;
  if (outcome.operation && outcome.operation.requestId !== requestId) return;
  const target = outcome.operation?.target;
  const method = operation?.method ?? outcome.operation?.method;
  const createsThread =
    (method === "areal/thread/start" && !threadId) ||
    (["areal/thread/fork", "areal/side/start", "areal/side/create"].includes(method ?? "") &&
      !!threadId &&
      outcome.sourceThreadId === threadId);
  const bindsCreatedTarget =
    operation?.target.kind === "project" &&
    outcome.operation?.method === operation.method &&
    outcome.operation.requestId === operation.requestId &&
    ((createsThread && target?.kind === "thread") ||
      (method === "areal/task/create" && !threadId && target?.kind === "task"));
  if (
    operation &&
    !bindsCreatedTarget &&
    (!outcome.operation || !sameRecoveryOperation(operation, outcome.operation))
  )
    return;
  if (bindsCreatedTarget) return outcome;
  if (
    threadId &&
    ((target?.kind === "thread" && target.threadId !== threadId) ||
      (outcome.threadId && outcome.threadId !== threadId))
  )
    return;
  if (!outcome.status && typeof outcome.accepted !== "boolean") return;
  return outcome;
}
// 经 Host 命令通道回来的失败只剩错误码和原文；Core 的拒绝原文以“原因码:”开头，从这里取回原因。
function reasonAndCode(failure: RecoveryFailure) {
  const reason = failure.reason ?? rawText(failure)?.match(/^([A-Z][A-Z_]+):/)?.[1] ?? "";
  return `${reason} ${failure.code ?? ""}`;
}
/** 传入 t 时，已登记的错误码用错误文案表，未知错误不再原样显示后台文字。 */
export function recoveryMessage(
  failure: RecoveryFailure,
  context: "operation" | "view" = "operation",
  t?: Translate,
) {
  if (
    context === "operation" &&
    (failure.submissionUnknown ||
      failure.outcome?.kind === "admitted" ||
      failure.outcome?.kind === "unconfirmed")
  )
    return "操作结果待确认。";
  if (["migrationBlocked", "MIGRATION_PENDING"].includes(String(failure.code)))
    return "旧运行状态尚未确认，暂时无法打开项目。历史和草稿已保留，请先检查原任务的停止结果。";
  if (t && failure instanceof UiMessageError) return errorText(t, failure);
  const code = errorCode(failure);
  if (t && context === "operation" && code && Object.hasOwn(ERROR_CODES, code))
    return errorText(t, failure);
  if (/auth|credential|api.?key|unauthorized|鉴权|凭据/i.test(reasonAndCode(failure)))
    return "无法完成操作，请检查模型服务的登录或凭据设置后重试。";
  if (failure.code === -32003 || /permission|forbidden|权限|denied/i.test(reasonAndCode(failure)))
    return "当前权限不允许此操作，请检查权限设置后重试。";
  if (/config|配置/i.test(reasonAndCode(failure)))
    return "当前配置不可用，请检查会话或模型配置后重试。";
  if (
    context === "view" &&
    ["HISTORY_BUDGET_TOO_SMALL", "RESPONSE_TOO_LARGE"].includes(String(failure.code))
  )
    return "对话内容超过当前加载范围，暂时无法完整显示。请重试或查看详情。";
  if (
    context === "view" &&
    (failure.recovery?.kind === "retryRead" ||
      /disconnect|timeout|connection|transport|RESPONSE_UNKNOWN/i.test(
        `${rawText(failure)} ${failure.code ?? ""}`,
      ))
  )
    return "暂时无法加载对话。连接恢复后可重新加载，历史和草稿已保留。";
  if (failure.recovery?.kind === "needsUser")
    return context === "view"
      ? "加载对话需要处理，请检查相关设置或查看详情。"
      : "此操作需要处理，请检查相关设置或操作结果后重试。";
  if (context === "view") return "暂时无法加载这段对话，请查看详情。";
  if (
    context === "operation" &&
    /disconnect|timeout|connection|transport|RESPONSE_UNKNOWN/i.test(
      `${rawText(failure)} ${failure.code ?? ""}`,
    )
  )
    return failure.outcome?.kind === "rejected" || failure.outcome?.kind === "noMutation"
      ? "操作尚未受理，输入已保留，请在连接恢复后重试。"
      : "暂时无法完成操作，请检查原操作结果后继续。";
  if (t) return t("errors.generic");
  return failure.message || "操作未完成，请重试。"; // raw-error-ok: 未传 t 的旧调用
}

export function recoverySettings(failure: RecoveryFailure): RecoveryNotice["settings"] {
  const reason = reasonAndCode(failure);
  if (/auth|credential|api.?key|unauthorized|鉴权|凭据/i.test(reason)) return "模型服务";
  if (failure.code === -32003 || /permission|forbidden|权限|denied|config|配置/i.test(reason))
    return "会话配置";
}

export function isTechnicalErrorMessage(message: string) {
  return /Error invoking remote method|\bIPC\b|\b(?:ENOENT|ECONNREFUSED|ECONNRESET|EACCES)\b|control\.sock|service socket path|service requires explicit lifecycle restart|Host disconnected|Project Core unavailable|\n\s*at /i.test(
    message,
  );
}
