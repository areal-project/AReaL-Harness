export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const LEGACY_READ_METHODS = new Set([
  "initialize",
  "areal/capabilities",
  "model/list",
  "thread/list",
  "thread/read",
  "areal/thread/observe",
  "areal/thread/inspect",
  "areal/conversation/list",
  "areal/conversation/history",
  "areal/model/list",
  "areal/profile/list",
  "areal/profile/read",
  "areal/queue/list",
  "areal/interaction/list",
  "areal/permissions/read",
  "areal/plan/read",
  "areal/goal/get",
  "areal/request/read",
  "areal/server/status",
  "areal/task/list",
  "areal/task/read",
  "areal/task/subscribe",
  "areal/inbox/list",
  "areal/channel/read",
  "areal/side/context/read",
]);

export function requestFailure(message, request, code, { cause, data, received = false } = {}) {
  const readOnly = request.effect === "read" || request.effect === "subscription";
  const operation = {
    method: request.method,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    target: request.target ?? { kind: "project" },
  };
  const known = ["noMutation", "rejected", "admitted", "unconfirmed"].includes(data?.outcome?.kind);
  const outcome = known
    ? data.outcome
    : readOnly
      ? { kind: "noMutation" }
      : { kind: "unconfirmed", operation };
  const retryRead =
    readOnly && data?.retryable !== false && (!received || data?.retryable === true);
  const recovery =
    known && data?.recovery
      ? data.recovery
      : {
          kind: readOnly
            ? retryRead
              ? "retryRead"
              : "none"
            : request.requestId
              ? "queryOriginal"
              : "needsUser",
        };
  return new CoreRpcError(message, {
    code: received || readOnly ? code : "RESPONSE_UNKNOWN",
    method: request.method,
    cause,
    data: {
      ...data,
      outcome,
      recovery,
      ...(request.requestId ? { requestId: request.requestId } : {}),
    },
  });
}

export function responseTooLarge() {
  return new CoreRpcError("Core response exceeds the supported history size", {
    code: "RESPONSE_TOO_LARGE",
    data: {
      reason: "RESPONSE_TOO_LARGE",
      limitBytes: MAX_RESPONSE_BYTES,
      retryable: false,
      delivery: "resultUnavailable",
    },
  });
}

/** AReaL Core app-server 客户端。认证与 socket 创建由可信平台宿主提供。 */
export class CoreRpcError extends Error {
  constructor(message, { code, method, data, cause, submissionUnknown = false } = {}) {
    super(message, { cause });
    this.name = "CoreRpcError";
    this.code = code;
    this.method = method;
    this.data = data;
    this.reason = data?.reason;
    this.outcome = data?.outcome;
    this.recovery = data?.recovery;
    this.requestId = data?.outcome?.operation?.requestId ?? data?.requestId;
    this.delivery = data?.delivery;
    this.submissionUnknown = this.outcome
      ? ["admitted", "unconfirmed"].includes(this.outcome.kind)
      : submissionUnknown;
  }
}

export function requestIdentity(method, params, capabilities) {
  const semantics = capabilities?.methodSemantics;
  const bootstrap = method === "initialize" || method === "areal/capabilities";
  const effect = bootstrap
    ? "read"
    : semantics
      ? capabilities.methods?.includes(method)
        ? semantics[method]?.effect
        : undefined
      : LEGACY_READ_METHODS.has(method)
        ? "read"
        : undefined;
  return {
    method,
    effect,
    requestId: params.requestId,
    target: params.taskId
      ? { kind: "task", taskId: params.taskId }
      : params.threadId
        ? { kind: "thread", threadId: params.threadId }
        : { kind: "project" },
  };
}
