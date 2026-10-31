import { withDefaultModelCapabilities } from "@areal/provider-config";

const labels = {
  ready: "可用",
  refreshing: "正在刷新凭据",
  temporarily_unavailable: "暂时不可用",
  reauth_required: "需要重新授权",
  permission_denied: "权限或服务限制",
  quota_exceeded: "应用用量受限",
  storage_locked: "安全存储需要解锁",
  signed_out: "未登录",
};
export function subscriptionProjection(value) {
  const state = value?.state ?? (value?.authenticated ? "ready" : "signed_out");
  return {
    state,
    label: labels[state] ?? "状态待核对",
    temporary: ["refreshing", "temporarily_unavailable", "storage_locked"].includes(state),
    retryable: ["temporarily_unavailable", "storage_locked"].includes(state),
    canSignIn: ["signed_out", "reauth_required"].includes(state),
    canTest: state === "ready" && !!value?.authenticated && !!value?.models?.length,
  };
}
export function connectionBilling(provider) {
  return provider?.connection?.billing === "api" || provider?.kind === "api"
    ? "API 计费 · 与 ChatGPT 订阅独立"
    : "计费由服务商决定";
}

export function newConnectionDraft(definition, authentication, revision) {
  const { id: definitionId, ...template } = definition;
  return {
    ...template,
    definitionId: definitionId ?? definition.definitionId,
    authentication,
    enabled: true,
    parameters: structuredClone(definition.parameters ?? {}),
    models: structuredClone(definition.models ?? []).map((model) =>
      withDefaultModelCapabilities(model, definition.parameters),
    ),
    basedOnRevision: revision,
  };
}

/** 发现结果只记录服务商事实，不把报告上限变成用户覆盖值。 */
export function discoveredModels(provider, ids, modelParameters = {}) {
  return ids
    .filter((id) => !provider.models.some((model) => model.id === id))
    .map((id) =>
      withDefaultModelCapabilities(
        {
          id,
          enabled: true,
          parameters: {},
          ...(modelParameters?.[id]?.contextWindowTokens === undefined
            ? {}
            : { reportedContextWindowTokens: modelParameters[id].contextWindowTokens }),
        },
        provider.parameters,
      ),
    );
}
