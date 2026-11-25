// @ts-check
"use strict";
const definitions = require("./definitions.json");
/** @param {string} id */
const definition = (id) => definitions.find((item) => item.id === id);
// Core 保存的连接不增加私有 schema 字段；服务定义与连接元信息只作为客户端投影。
/** @param {{id:string,protocol:string,endpoint?:string,baseUrl?:string,apiKeyEnv?:string}} provider @param {Record<string,string>} [credentialSources] */
function connectionMetadata(provider, credentialSources = {}) {
  const protocol = provider.protocol === "chat-completions" ? "chatCompletions" : provider.protocol;
  const baseUrl =
    provider.endpoint?.replace(/\/(responses|chat\/completions)\/?$/, "") ?? provider.baseUrl;
  const preset =
    definitions.find(
      (item) =>
        item.kind === "api" && item.baseUrl === baseUrl && item.protocols.includes(protocol),
    ) ?? definition("custom-compatible");
  if (!preset) throw new Error("Missing custom-compatible provider definition");
  return {
    definitionId: preset.id,
    connectionId: provider.id,
    billing: preset.billing,
    authentication: provider.apiKeyEnv ? "apiKey" : "none",
    credentialSource: credentialSources[provider.id] ?? "none",
    region: preset.regions.find((region) => region.baseUrl === baseUrl)?.id ?? null,
    discovery: preset.discovery,
    capabilityDefaults: preset.capabilityDefaults,
  };
}
/** @template {{id:string,parameters?:{reasoningEffort?:string|null},capabilities?:unknown}} T @param {T} model @param {unknown} [_providerParameters] */
function withDefaultModelCapabilities(model, _providerParameters) {
  if (model.capabilities !== undefined) return model;
  return { ...model, capabilities: { tools: true, vision: false, reasoning: true } };
}
/** @param {{endpoint?:string,baseUrl?:string,protocol?:string}} provider @param {{id:string,capabilities?:{tools:boolean,vision:boolean,reasoning:boolean,reasoningEffortOptions?:string[]}}} model */
function resolvedModelCapabilities(provider, model) {
  const declared = model.capabilities;
  const url = new URL(provider.endpoint ?? provider.baseUrl ?? "http://unknown.invalid");
  if (url.origin !== "https://api.openai.com" || model.id !== "gpt-6.1-sol") return declared;
  const known = ["low", "medium", "high", "xhigh", "max"];
  return {
    ...(declared ?? { tools: true, vision: true, reasoning: true }),
    reasoningEffortOptions:
      declared?.reasoning === false
        ? []
        : (declared?.reasoningEffortOptions?.filter((effort) => known.includes(effort)) ?? known),
  };
}
module.exports = {
  definitions,
  connectionMetadata,
  resolvedModelCapabilities,
  withDefaultModelCapabilities,
};
