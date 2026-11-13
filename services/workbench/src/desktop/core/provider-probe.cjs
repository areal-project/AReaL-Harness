// @ts-check
"use strict";
const providerContract = require("./provider-contract.cjs");
const { validContextWindow } = providerContract;
const { baseUrl } = require("./model-config.cjs");
const connectionFailures = [
  {
    causes: ["ENOTFOUND", "EAI_AGAIN"],
    category: "DNS",
    message: "域名解析失败：请检查 Base URL、DNS 和网络代理设置",
  },
  {
    causes: ["ECONNREFUSED"],
    category: "REFUSED",
    message: "连接被拒绝：请检查 Base URL、服务端口及网络代理是否可用",
  },
  {
    causes: [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ],
    category: "TLS",
    message: "TLS 证书验证失败：请检查服务地址、系统信任证书和网络代理证书",
  },
  {
    causes: ["ETIMEDOUT", "ABORT_ERR", "AbortError", "TimeoutError"],
    category: "TIMEOUT",
    message: "连接超时或已取消：请检查网络和服务状态后重试",
  },
  {
    causes: ["proxy-unavailable"],
    category: "PROXY",
    message: "网络代理不可用：请检查系统代理设置后重试",
  },
  {
    causes: ["no-redirect"],
    category: "REDIRECT",
    message: "模型服务返回重定向：请将 Base URL 改为最终服务地址",
  },
];

/** @param {unknown} cause */
function connectionError(cause) {
  const error = providerContract.record(cause) ? cause : {};
  const nested = providerContract.record(error.cause) ? error.cause : {};
  const reasons = [error?.code, nested.code, error?.type, error?.name];
  if (error?.message === "ChatGPT proxy unavailable") reasons.push("proxy-unavailable");
  const failure = connectionFailures.find(({ causes }) =>
    causes.some((code) => reasons.includes(code)),
  ) ?? { category: "UNAVAILABLE", message: "连接失败：请检查 Base URL、网络及服务是否可用" };
  return Object.assign(new Error(failure.message), {
    code: `PROVIDER_NETWORK_${failure.category}`,
  });
}

/** Core 拥有模型元数据，Desktop 只负责加密凭据与 OAuth。 */
/** @param {{endpoint:string,protocol:string,apiKeyEnv?:string,models?:import('./provider-contract.cjs').ModelConfig[]}} provider @param {{model?:unknown,operation:string,apiKey?:string}} request @param {InstanceType<typeof import('./providers.cjs').AppProviders>} providers */
async function testConnection(provider, { model, operation, apiKey }, providers) {
  const key = apiKey ?? providers.key(provider);
  const url = operation === "discover" ? `${baseUrl(provider.endpoint)}/models` : provider.endpoint;
  if (operation === "probe" && !provider.models?.some((m) => m.id === model && m.enabled))
    throw new Error("请选择已启用的模型");
  const body =
    provider.protocol === "responses"
      ? {
          model,
          input: [{ role: "user", content: "Reply with OK." }],
          store: false,
          stream: true,
        }
      : { model, messages: [{ role: "user", content: "Reply with OK." }], stream: true };
  let response;
  try {
    response = await (
      await providers.network()
    ).fetch(url, {
      method: operation === "discover" ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
      },
      ...(operation === "probe" ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw connectionError(error);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401 || response.status === 403
        ? "认证失败：请检查 API Key 及模型访问权限"
        : `模型服务返回 HTTP ${response.status}`,
    );
  }
  if (operation === "probe") {
    const { probeResponse } = await import("@areal/chatgpt-provider/core");
    try {
      return await probeResponse(
        response,
        provider.protocol === "chat-completions" ? "chatCompletions" : provider.protocol,
      );
    } catch {
      throw new Error("模型服务未完成有效的流式文本回复，请检查模型和协议");
    }
  }
  // 上游响应可能包含凭据，不得将响应原文返回 IPC。
  let bytes = 0,
    chunks = [];
  try {
    if (!response.body) throw new Error("响应为空");
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("模型服务响应过大");
      chunks.push(chunk);
    }
  } catch {
    throw new Error("模型列表读取失败，请重试或手动添加模型");
  }
  /** @type {unknown} */ let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error("模型服务未返回有效的 JSON 响应");
  }
  if (operation === "discover") {
    if (!providerContract.record(data) || !Array.isArray(data.data))
      throw new Error("服务未返回模型列表，请手动添加模型");
    const models = [
      ...new Map(
        data.data
          .filter(providerContract.record)
          .flatMap((item) => {
            if (
              typeof item.id !== "string" ||
              !item.id.trim() ||
              item.id.length > 256 ||
              (key && item.id.includes(key))
            )
              return [];
            const id = item.id.trim();
            return [
              {
                id,
                ...(validContextWindow(item.context_window)
                  ? { contextWindow: item.context_window }
                  : {}),
              },
            ];
          })
          .map((item) => [item.id, item]),
      ).values(),
    ].slice(0, 64);
    const parameters = Object.fromEntries(
      models.flatMap((item) =>
        item.contextWindow === undefined
          ? []
          : [[item.id, { contextWindowTokens: item.contextWindow }]],
      ),
    );
    return {
      models: models.map((p) => p.id),
      ...(Object.keys(parameters).length ? { modelParameters: parameters } : {}),
    };
  }
  throw new Error("不支持的供应商测试操作");
}
/** @param {unknown} value */
function errorMessage(value) {
  return value instanceof Error
    ? value.message
    : providerContract.record(value) && typeof value.message === "string"
      ? value.message
      : String(value);
}

module.exports = { errorMessage, testConnection };
