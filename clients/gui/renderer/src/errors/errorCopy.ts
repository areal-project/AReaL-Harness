import type { MessageId } from "../i18n/messages.js";
import { UiMessageError, type Translate } from "../i18n/uiMessage.js";

export type ErrorAction = "retry" | "refresh" | "reconnect" | "openSettings" | "none";
type Entry = {
  /** 用户文案；省略时用 errors.<码>。 */
  message?: MessageId;
  action: ErrorAction;
  /** 自动重试不会造成重复执行。 */
  retryable: boolean;
};

// R-RECOVERY-004 R-RECOVERY-005 后台错误码 → 用户文案的唯一登记处。Host 源码里出现的码必须在这里登记，
// scripts/ui-honesty-lint.mjs 会对照 core/host/src 检查。
export const ERROR_CODES = {
  FORBIDDEN: { action: "openSettings", retryable: false },
  GRANT_CHANGED: { action: "refresh", retryable: false },
  CAPABILITY_UNAVAILABLE: { action: "retry", retryable: true },
  CORE_UNAVAILABLE: { action: "retry", retryable: true },
  CORE_INCOMPATIBLE: { action: "none", retryable: false },
  CONFLICT: { action: "none", retryable: false },
  RESYNC_REQUIRED: { action: "refresh", retryable: false },
  INVALID_PARAMS: { action: "refresh", retryable: false },
  ATTACHMENT_UNSUPPORTED: { action: "none", retryable: false },
  PROVIDER_CREDENTIAL_REQUIRED: { action: "none", retryable: false },
  INVALID_RESPONSE: { action: "retry", retryable: true },
  LIMIT_EXCEEDED: { action: "none", retryable: false },
  INPUT_LIMIT_EXCEEDED: { action: "none", retryable: false },
  CAPACITY_EXCEEDED: { action: "retry", retryable: true },
  COMMAND_CONFLICT: { action: "retry", retryable: false },
  RESOURCE_UNAVAILABLE: { action: "refresh", retryable: false },
  RESOURCE_BUSY: { action: "retry", retryable: true },
  NOT_FOUND: { action: "refresh", retryable: false },
  TARGET_CHANGED: { action: "refresh", retryable: false },
  TURN_BUSY: { action: "none", retryable: false },
  SUBMISSION_UNKNOWN: { action: "refresh", retryable: false },
  REVIEW_INCOMPLETE: { action: "none", retryable: false },
  CONFIRMATION_STALE: { action: "refresh", retryable: false },
  TASK_CONTROL_REQUIRED: { action: "none", retryable: false },
  CREATION_REJECTED: { action: "retry", retryable: false },
  TASK_REJECTED: { action: "none", retryable: false },
  TASK_WORKSPACE_UNAVAILABLE: { action: "none", retryable: false },
  TASK_CATALOG_READ_FAILED: { action: "retry", retryable: true },
  PERSISTED_HISTORY_UNAVAILABLE: { action: "retry", retryable: true },
  MIGRATION_PENDING: { action: "none", retryable: false },
  migrationBlocked: { message: "errors.MIGRATION_PENDING", action: "none", retryable: false },
  UNSUPPORTED_PROFILE: { action: "openSettings", retryable: false },
  PROFILE_NOT_SUPPORTED: { action: "openSettings", retryable: false },
  PAIRING_EXPIRED: { action: "none", retryable: false },
  PAIRING_USED: { action: "none", retryable: false },
  PAIRING_CANCELLED: { action: "none", retryable: false },
  PROTOCOL_UNSUPPORTED: { action: "none", retryable: false },
  // 只用于诊断的码：用户看到通用说明，原码进详情。
  GUI_SOURCE_PENDING: {
    message: "errors.CAPABILITY_UNAVAILABLE",
    action: "retry",
    retryable: true,
  },
  LIFECYCLE_INVALID_REQUEST: { message: "errors.lifecycle", action: "retry", retryable: false },
  LIFECYCLE_RECEIPT_INVALID: { message: "errors.lifecycle", action: "retry", retryable: false },
  LIFECYCLE_BLOCKED: { message: "errors.lifecycle", action: "retry", retryable: false },
  LIFECYCLE_INCOMPLETE: { message: "errors.lifecycle", action: "retry", retryable: false },
  LIFECYCLE_RECEIPT_WRITE_FAILED: {
    message: "errors.lifecycle",
    action: "retry",
    retryable: false,
  },
  LIFECYCLE_REQUEST_CONFLICT: {
    message: "errors.COMMAND_CONFLICT",
    action: "retry",
    retryable: false,
  },
  // 客户端自己产生的码（连接断开、超时）。
  DISCONNECTED: { action: "reconnect", retryable: true },
  TIMEOUT: { action: "retry", retryable: true },
} as const satisfies Record<string, Entry>;
export type ErrorCode = keyof typeof ERROR_CODES;

export type PresentedError = {
  message: string;
  action: ErrorAction;
  retryable: boolean;
  /** 原始文字和错误码，只放在“查看详情”里。 */
  detail?: string;
  code?: string;
};

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function errorCode(cause: unknown): string | undefined {
  for (const candidate of [cause, field(cause, "error")]) {
    const code = field(candidate, "code") ?? field(candidate, "clientCode");
    if (typeof code === "string" && code) return code;
  }
  if (field(cause, "submissionUnknown") === true) return "SUBMISSION_UNKNOWN";
}

function registered(code: string | undefined): Entry | undefined {
  return code && Object.hasOwn(ERROR_CODES, code)
    ? (ERROR_CODES as Record<string, Entry>)[code]
    : undefined;
}

/** 后台原文，只用于详情、诊断和匹配，不直接显示给用户。 */
export function rawText(cause: unknown) {
  const message = field(cause, "message") ?? field(field(cause, "error"), "message");
  if (typeof message === "string") return message;
  if (typeof cause === "string") return cause;
}

/** 把任意错误变成用户能懂的一句话、一个动作和收起的详情。界面只从这里取错误文字。 */
export function presentError(t: Translate, cause: unknown): PresentedError {
  if (cause instanceof UiMessageError)
    return {
      message: t(cause.descriptor.id, cause.descriptor.values),
      action: "none",
      retryable: false,
    };
  const code = errorCode(cause);
  const entry = registered(code);
  const raw = rawText(cause)?.trim();
  const detail = [code, raw].filter(Boolean).join(": ") || undefined;
  return {
    message: t(entry ? (entry.message ?? (`errors.${code}` as MessageId)) : "errors.generic"),
    action: entry?.action ?? "retry",
    retryable: entry?.retryable ?? false,
    detail,
    code,
  };
}

/** 只能放一行字的地方用：用户句子在前，详情不显示。 */
export function errorText(t: Translate, cause: unknown) {
  return presentError(t, cause).message;
}
