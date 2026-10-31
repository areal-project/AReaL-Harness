// @ts-check
"use strict";

/** @typedef {Record<string,unknown>} Fields */
/** @typedef {{temperature?:number|null,maxOutputTokens?:number|null,contextWindowTokens?:number|null,reasoningEffort?:string|null,reasoningSummary?:string|null,serviceTier?:'fast'|'default'|null}} ModelParameters */
/** @typedef {{tools:boolean,vision:boolean,reasoning:boolean,reasoningEffortOptions?:string[]}} ModelCapabilities */
/** @typedef {{providerId:string,modelId:string}} ModelRef */
/** @typedef {{id:string,enabled:boolean,displayName?:string,parameters:ModelParameters,capabilities?:ModelCapabilities,reportedContextWindowTokens?:number}} ModelConfig */
/** @typedef {{id:string,name:string,endpoint:string,protocol:string,enabled:boolean,apiKeyEnv?:string,models:ModelConfig[],parameters:ModelParameters}} ProviderConfig */
/** @typedef {Fields & {path:string,revision:string,data:ProviderConfig[],defaultModel:ModelRef|null,credentialStates:Record<string,string>,credentialSources:Record<string,string>,effective:Fields}} ModelSnapshot */
/** @typedef {{expectedRevision:string,data:ProviderConfig[],defaultModel:ModelRef|null}} ModelUpdate */
/** @typedef {Fields & {providerId:string|null,providerName?:string,modelId:string,providerRevision:number|null,displayName?:string,available?:boolean,availability?:'checking'|'available'|'unavailable'}} ModelCatalogEntry */
/** @typedef {Fields & {id:string,revision:number,endpoint:string,protocol:string,models:string[],modelParameters?:Record<string,ModelParameters>,parameters:ModelParameters}} CoreProvider */
/** @typedef {{revision:string,sequence:number}} AppliedConfiguration */
/** @typedef {{code:number,message:string,data?:Fields|null}} ConfigurationError */
/** @typedef {{requestId:string,state:'applied',result:ConfigurationProof}|{requestId:string,state:'rejected'|'unknown'|'running',error?:ConfigurationError}} ConfigurationOperation */
/** @typedef {{serviceId:string,generation:string,applied:AppliedConfiguration,modelRevision:string,credentialStates:Record<string,string>,operation?:ConfigurationOperation}} ConfigurationProof */
/** @typedef {{model:ModelRef|null,modelId:string,reasoningEffort:string|null,acceptedAt:number}} AcceptedModel */
/** @param {unknown} value @returns {value is Fields} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is Record<string,string>} */
function stringMap(value) {
  return record(value) && Object.values(value).every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is ModelParameters} */
function parameters(value) {
  return (
    record(value) &&
    ["temperature", "maxOutputTokens", "contextWindowTokens"].every(
      (key) =>
        value[key] == null || (typeof value[key] === "number" && Number.isFinite(value[key])),
    ) &&
    ["reasoningEffort", "reasoningSummary"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    ) &&
    (value.serviceTier == null || value.serviceTier === "fast" || value.serviceTier === "default")
  );
}
/** @param {unknown} value @returns {value is ModelCapabilities} */
function capabilities(value) {
  return (
    record(value) &&
    typeof value.tools === "boolean" &&
    typeof value.vision === "boolean" &&
    typeof value.reasoning === "boolean" &&
    (value.reasoningEffortOptions === undefined || strings(value.reasoningEffortOptions))
  );
}
/** @param {unknown} value @returns {value is ModelRef} */
function modelRef(value) {
  return record(value) && typeof value.providerId === "string" && typeof value.modelId === "string";
}
/** @param {unknown} value @returns {value is ModelConfig} */
function modelConfig(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.enabled === "boolean" &&
    (value.displayName === undefined || typeof value.displayName === "string") &&
    parameters(value.parameters) &&
    (value.reportedContextWindowTokens === undefined ||
      validContextWindow(value.reportedContextWindowTokens)) &&
    (value.capabilities === undefined || capabilities(value.capabilities))
  );
}
/** @param {unknown} value @returns {value is ProviderConfig} */
function providerConfig(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.protocol === "string" &&
    typeof value.enabled === "boolean" &&
    (value.apiKeyEnv === undefined || typeof value.apiKeyEnv === "string") &&
    Array.isArray(value.models) &&
    value.models.every(modelConfig) &&
    parameters(value.parameters)
  );
}
/** @param {unknown} value @returns {ModelSnapshot} */
function modelSnapshot(value) {
  if (
    !record(value) ||
    typeof value.path !== "string" ||
    typeof value.revision !== "string" ||
    !Array.isArray(value.data) ||
    !value.data.every(providerConfig) ||
    (value.defaultModel !== null && !modelRef(value.defaultModel)) ||
    !stringMap(value.credentialStates) ||
    !stringMap(value.credentialSources) ||
    !record(value.effective)
  )
    throw new Error("Core 返回了无效的模型配置");
  return {
    ...value,
    path: value.path,
    revision: value.revision,
    data: value.data,
    defaultModel: value.defaultModel,
    credentialStates: value.credentialStates,
    credentialSources: value.credentialSources,
    effective: value.effective,
  };
}
/** @param {unknown} value @returns {value is CoreProvider} */
function coreProvider(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    integer(value.revision) &&
    typeof value.endpoint === "string" &&
    typeof value.protocol === "string" &&
    strings(value.models) &&
    parameters(value.parameters) &&
    (value.modelParameters === undefined ||
      (record(value.modelParameters) && Object.values(value.modelParameters).every(parameters)))
  );
}
/** @param {unknown} value @returns {CoreProvider} */
function provider(value) {
  if (!coreProvider(value)) throw new Error("Core 供应商记录无效");
  return value;
}
/** @param {unknown} value @returns {{data:CoreProvider[]}} */
function providers(value) {
  if (!record(value) || !Array.isArray(value.data) || !value.data.every(coreProvider))
    throw new Error("Core 供应商目录无效");
  return { data: value.data };
}
/** @param {unknown} value @returns {value is ModelCatalogEntry} */
function modelEntry(value) {
  return (
    record(value) &&
    (value.providerId === null || typeof value.providerId === "string") &&
    typeof value.modelId === "string" &&
    (value.providerRevision === null || integer(value.providerRevision)) &&
    (value.providerName === undefined || typeof value.providerName === "string") &&
    (value.displayName === undefined || typeof value.displayName === "string") &&
    (value.available === undefined || typeof value.available === "boolean") &&
    (value.availability === undefined ||
      ["checking", "available", "unavailable"].includes(String(value.availability)))
  );
}
/** @param {unknown} value @returns {{data:ModelCatalogEntry[],lastAcceptedModel?:AcceptedModel|null}} */
function models(value) {
  if (!record(value) || !Array.isArray(value.data) || !value.data.every(modelEntry))
    throw new Error("Core 模型目录无效");
  return {
    data: value.data,
    ...(value.lastAcceptedModel === undefined
      ? {}
      : {
          lastAcceptedModel:
            value.lastAcceptedModel === null ? null : acceptedModel(value.lastAcceptedModel),
        }),
  };
}
/** @param {unknown} value @returns {value is ConfigurationError} */
function configurationError(value) {
  return (
    record(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string" &&
    (value.data == null || record(value.data))
  );
}
/** @param {unknown} value @returns {value is ConfigurationProof} */
function proofRecord(value) {
  return (
    record(value) &&
    typeof value.serviceId === "string" &&
    typeof value.generation === "string" &&
    record(value.applied) &&
    typeof value.applied.revision === "string" &&
    integer(value.applied.sequence) &&
    typeof value.modelRevision === "string" &&
    stringMap(value.credentialStates) &&
    (value.operation === undefined || operation(value.operation))
  );
}
/** @param {unknown} value @returns {value is ConfigurationOperation} */
function operation(value) {
  return (
    record(value) &&
    typeof value.requestId === "string" &&
    (value.state === "applied"
      ? proofRecord(value.result)
      : (value.state === "rejected" || value.state === "unknown" || value.state === "running") &&
        (value.error === undefined || configurationError(value.error)))
  );
}
/** @param {unknown} value @returns {ConfigurationProof} */
function configurationProof(value) {
  if (!proofRecord(value)) throw new Error("Core 模型配置应用证明无效，请刷新核对。");
  return value;
}
/** @param {unknown} value @returns {{restartSafe:boolean}} */
function serverStatus(value) {
  if (!record(value) || typeof value.restartSafe !== "boolean")
    throw new Error("Core 服务状态无效");
  return { restartSafe: value.restartSafe };
}
/** @param {unknown} value @returns {value is AcceptedModel} */
function isAcceptedModel(value) {
  return (
    record(value) &&
    (value.model === null || modelRef(value.model)) &&
    typeof value.modelId === "string" &&
    (value.reasoningEffort === null || typeof value.reasoningEffort === "string") &&
    integer(value.acceptedAt)
  );
}
/** @param {unknown} value @returns {AcceptedModel} */
function acceptedModel(value) {
  if (!isAcceptedModel(value)) throw new Error("模型选择记录无效");
  return value;
}

/** @param {unknown} baseUrl @param {unknown} protocol */
function connection(baseUrl, protocol) {
  if (typeof protocol !== "string" || !["chatCompletions", "responses"].includes(protocol))
    throw new Error("请选择 Chat Completions 或 Responses");
  let url;
  try {
    if (typeof baseUrl !== "string") throw new Error();
    url = new URL(baseUrl);
  } catch {
    throw new Error("请输入有效的 Base URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Base URL 必须是无认证信息、查询参数和片段的 HTTP(S) 地址");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|responses)$/, "");
  const base = url.toString().replace(/\/$/, "");
  return {
    baseUrl: base,
    endpoint: base + (protocol === "responses" ? "/responses" : "/chat/completions"),
  };
}

/** @param {unknown} value @returns {value is number} */
function validContextWindow(value) {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_000_000
  );
}

/** @param {unknown} raw @returns {ModelParameters} */
function modelParameters(raw = {}) {
  if (!record(raw)) throw new Error("模型参数无效");
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "temperature",
          "maxOutputTokens",
          "contextWindowTokens",
          "reasoningEffort",
          "serviceTier",
        ].includes(key) || raw[key] === undefined,
    )
  )
    throw new Error("模型参数无效");
  const { temperature, maxOutputTokens, contextWindowTokens, reasoningEffort, serviceTier } = raw;
  if (
    (temperature != null &&
      (typeof temperature !== "number" ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2)) ||
    (maxOutputTokens != null &&
      (typeof maxOutputTokens !== "number" ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens <= 0)) ||
    (contextWindowTokens != null && !validContextWindow(contextWindowTokens)) ||
    (serviceTier != null && serviceTier !== "fast" && serviceTier !== "default") ||
    (reasoningEffort != null &&
      (typeof reasoningEffort !== "string" ||
        !["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          reasoningEffort,
        )))
  )
    throw new Error("模型参数无效");
  return {
    ...(temperature == null ? {} : { temperature }),
    ...(maxOutputTokens == null ? {} : { maxOutputTokens }),
    ...(contextWindowTokens == null ? {} : { contextWindowTokens }),
    ...(reasoningEffort == null ? {} : { reasoningEffort }),
    ...(serviceTier == null ? {} : { serviceTier }),
  };
}

/** @param {unknown} raw @returns {ModelCapabilities|undefined} */
function modelCapabilities(raw) {
  if (raw === undefined) return undefined;
  if (
    !capabilities(raw) ||
    Object.keys(raw).some(
      (field) => !["tools", "vision", "reasoning", "reasoningEffortOptions"].includes(field),
    ) ||
    raw.reasoningEffortOptions?.some(
      (value) => !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value),
    ) ||
    (raw.reasoningEffortOptions &&
      new Set(raw.reasoningEffortOptions).size !== raw.reasoningEffortOptions.length)
  )
    throw new Error("模型能力配置无效");
  return {
    tools: raw.tools,
    vision: raw.vision,
    reasoning: raw.reasoning,
    ...(raw.reasoningEffortOptions === undefined
      ? {}
      : { reasoningEffortOptions: [...raw.reasoningEffortOptions] }),
  };
}

/** @typedef {'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'} ReasoningEffort */
/** @typedef {Pick<ModelParameters,'temperature'|'maxOutputTokens'|'contextWindowTokens'|'serviceTier'> & {reasoningEffort?:ReasoningEffort|'default'|null}} ModelInputParameters */
/** @typedef {Pick<ModelCapabilities,'tools'|'vision'|'reasoning'> & {reasoningEffortOptions?:ReasoningEffort[]}} ModelInputCapabilities */
/** @typedef {{id?:string,name:string,baseUrl:string,protocol:'chatCompletions'|'responses',enabled?:boolean,models:Array<{id:string,displayName?:string,enabled?:boolean,parameters?:ModelInputParameters,capabilities?:ModelInputCapabilities}>,parameters?:ModelInputParameters}} ProviderDraft */
/** @typedef {{baseUrl:string,protocol:'chatCompletions'|'responses',credential:{kind:'none'}|{kind:'draft',value:string}|{kind:'saved',providerId:string,expectedRevision:string}}} DiscoveryConnection */
/** @typedef {{operation:'list'}|{operation:'revealKey'|'remove'|'removeAndApply',id:string,expectedRevision:string}|{operation:'apply',expectedRevision:string}|{operation:'default'|'defaultAndApply',expectedRevision:string,model?:ModelRef|null}|{operation:'save'|'saveAndApply',expectedRevision:string,provider:ProviderDraft,authentication?:'none'|'apiKey',apiKey?:string,discoverModels?:boolean}|{operation:'probe',id:string,model:string}|{operation:'discover',id:string,connection?:never}|{operation:'discover',connection:DiscoveryConnection,id?:never}} ProviderRequest */
/** @typedef {{provider?:'openai'} & ({operation:'status'|'forget'|'logout'|'cancel'}|{operation:'login',newAccount?:boolean,accountId?:string}|{operation:'selectAccount',accountId:string}|{operation:'probe',model?:string})} ChatGPTRequest */
/** @typedef {{kind:'saved'|'applied'|'unknown',revision:string}|{kind:'deferred',revision:string,reason:'disconnected'|'busy'}|{kind:'failed',revision:string,message:string}} ApplicationState */
/** @typedef {{strategy:string,path:string,shape:string}} Discovery */
/** @typedef {{stream:boolean,tools:boolean|null,usage:boolean|null,store?:boolean,unsupportedParameters?:string[]}} CapabilityDefaults */
/** @typedef {{definitionId:string,connectionId:string,billing:string,authentication:string,credentialSource:string,region:string|null,discovery:Discovery,capabilityDefaults:CapabilityDefaults}} ConnectionMetadata */
/** @typedef {{id:string,name:string,kind:string,icon:string|null,baseUrl:string,protocol:string,protocols:string[],authMethods:string[],billing:string,models:Array<{id:string,enabled:boolean}>,configurationSchema:Record<string,string>,discovery:Discovery,capabilityDefaults:CapabilityDefaults,regions:Array<{id:string,name:string,baseUrl:string}>}} ProviderDefinition */
/** @typedef {Pick<ModelSnapshot,'path'|'revision'|'defaultModel'|'credentialStates'|'credentialSources'|'effective'> & {data:Array<ProviderConfig & {baseUrl:string,connection:ConnectionMetadata}>,projects:Array<{projectId:string,root:string,connected:boolean,applied:boolean,error:string|null,application:ApplicationState}>,pendingApply:boolean,application:ApplicationState,definitions:ProviderDefinition[]}} ProviderStatus */
/** @typedef {{id:string,name?:string,source?:string,parameters?:{contextWindowTokens:number},reasoningEffortOptions?:string[]}} SubscriptionModel */
/** @typedef {{loginId:string,authUrl:string}} Login */
/** @typedef {{code:string,state:string,phase:string,httpStatus:number|null,requestId:string|null}} Diagnostic */
/** @typedef {{authenticated:boolean,state:string,email:string|null,planType:string|null,modelError:string|null,models:SubscriptionModel[],diagnostic:Diagnostic|null,login:Login|null,error:string|null,activeAccountId?:string|null,accounts?:Array<{id:string,label:string,email:string|null,active:boolean,state:string,billing:string}>}} AccountStatus */
/** @typedef {AccountStatus & {availability?:'checking'|'available'|'unavailable',refreshing?:boolean,billing:string,catalog:{source:string,fetchedAt:number|null,fresh:boolean,sessionRevision:number|null,overrides:boolean}|null}} ChatGPTStatus */
/** @template {string} N @typedef {N extends 'providers' ? ProviderRequest : N extends 'chatgpt' ? ChatGPTRequest : never} Request */
/** @template {string} N @template P @typedef {N extends 'providers' ? P extends {operation:'revealKey'} ? {apiKey:string} : P extends {operation:'probe'} ? {state:'connected'} : P extends {operation:'discover'} ? {models:string[],modelParameters?:Record<string,ModelParameters>} : P extends {operation:'list'|'apply'|'save'|'saveAndApply'|'removeAndApply'|'defaultAndApply'|'remove'|'default'} ? ProviderStatus : never : N extends 'chatgpt' ? P extends {operation:'login'} ? Login : P extends {operation:'probe'} ? {state:'connected'} : P extends {operation:'status'|'forget'|'logout'|'selectAccount'|'cancel'} ? ChatGPTStatus : never : never} Response */
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string";
}
/** @param {unknown} value @returns {value is string|null} */
function nullableText(value) {
  return value === null || text(value);
}
/** @param {unknown} value @returns {value is ProviderDraft} */
function providerDraft(value) {
  if (
    !record(value) ||
    !text(value.name) ||
    !text(value.baseUrl) ||
    (value.id !== undefined && !text(value.id)) ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    !Array.isArray(value.models)
  )
    return false;
  connection(value.baseUrl, value.protocol);
  modelParameters(value.parameters);
  return value.models.every((item) => {
    if (
      !record(item) ||
      !text(item.id) ||
      (item.displayName !== undefined && !text(item.displayName)) ||
      (item.enabled !== undefined && typeof item.enabled !== "boolean")
    )
      return false;
    modelParameters(item.parameters);
    modelCapabilities(item.capabilities);
    return true;
  });
}
/** @param {unknown} value @returns {value is DiscoveryConnection} */
function discoveryConnection(value) {
  if (
    !record(value) ||
    !text(value.baseUrl) ||
    !["chatCompletions", "responses"].some((entry) => entry === value.protocol) ||
    !record(value.credential)
  )
    return false;
  const credential = value.credential;
  return (
    credential.kind === "none" ||
    (credential.kind === "draft" && text(credential.value)) ||
    (credential.kind === "saved" &&
      text(credential.providerId) &&
      text(credential.expectedRevision))
  );
}
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function checkRequest(name, value) {
  if (!record(value)) return false;
  if (name === "chatgpt") {
    if (value.provider !== undefined && value.provider !== "openai") return false;
    if (["status", "forget", "logout", "cancel"].some((entry) => entry === value.operation))
      return true;
    if (value.operation === "login")
      return (
        (value.newAccount === undefined || typeof value.newAccount === "boolean") &&
        (value.accountId === undefined || text(value.accountId))
      );
    if (value.operation === "selectAccount") return text(value.accountId);
    return value.operation === "probe" && (value.model === undefined || text(value.model));
  }
  if (name !== "providers") return false;
  if (value.operation === "list") return true;
  if (value.operation === "probe") return text(value.id) && text(value.model);
  if (value.operation === "discover")
    return value.connection === undefined ? text(value.id) : discoveryConnection(value.connection);
  if (!text(value.expectedRevision)) return false;
  if (value.operation === "apply") return true;
  if (value.operation === "revealKey")
    return (
      text(value.id) &&
      value.id.trim().length > 0 &&
      value.id.length <= 256 &&
      value.expectedRevision.trim().length > 0 &&
      value.expectedRevision.length <= 256 &&
      Object.keys(value).every((key) => ["operation", "id", "expectedRevision"].includes(key))
    );
  if (["remove", "removeAndApply"].some((entry) => entry === value.operation))
    return text(value.id);
  if (value.operation === "default" || value.operation === "defaultAndApply")
    return value.model == null || modelRef(value.model);
  return (
    (value.operation === "save" || value.operation === "saveAndApply") &&
    providerDraft(value.provider) &&
    (value.authentication === undefined ||
      value.authentication === "none" ||
      value.authentication === "apiKey") &&
    (value.apiKey === undefined || text(value.apiKey)) &&
    (value.discoverModels === undefined || typeof value.discoverModels === "boolean")
  );
}
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function isRequest(name, value) {
  try {
    return checkRequest(name, value);
  } catch {
    return false;
  }
}
/** @template {string} N @param {N} name @param {unknown} value @returns {Request<N>} */
function readRequest(name, value) {
  if (!checkRequest(name, value))
    throw new Error(name === "chatgpt" ? "ChatGPT 操作参数无效" : "供应商操作参数无效");
  return value;
}
/** @param {unknown} value @returns {value is ApplicationState} */
function application(value) {
  if (!record(value) || !text(value.revision)) return false;
  if (value.kind === "failed") return text(value.message);
  if (value.kind === "deferred") return value.reason === "disconnected" || value.reason === "busy";
  return value.kind === "saved" || value.kind === "applied" || value.kind === "unknown";
}
/** @param {unknown} value @returns {value is Discovery} */
function discovery(value) {
  return record(value) && text(value.strategy) && text(value.path) && text(value.shape);
}
/** @param {unknown} value @returns {value is CapabilityDefaults} */
function capabilityDefaults(value) {
  return (
    record(value) &&
    typeof value.stream === "boolean" &&
    (value.tools === null || typeof value.tools === "boolean") &&
    (value.usage === null || typeof value.usage === "boolean") &&
    (value.store === undefined || typeof value.store === "boolean") &&
    (value.unsupportedParameters === undefined || strings(value.unsupportedParameters))
  );
}
/** @param {unknown} value @returns {value is ConnectionMetadata} */
function connectionMetadata(value) {
  return (
    record(value) &&
    ["definitionId", "connectionId", "billing", "authentication", "credentialSource"].every((key) =>
      text(value[key]),
    ) &&
    nullableText(value.region) &&
    discovery(value.discovery) &&
    capabilityDefaults(value.capabilityDefaults)
  );
}
/** @param {unknown} value @returns {value is ProviderDefinition} */
function providerDefinition(value) {
  return (
    record(value) &&
    ["id", "name", "kind", "baseUrl", "protocol", "billing"].every((key) => text(value[key])) &&
    nullableText(value.icon) &&
    strings(value.protocols) &&
    strings(value.authMethods) &&
    Array.isArray(value.models) &&
    value.models.every(
      (item) => record(item) && text(item.id) && typeof item.enabled === "boolean",
    ) &&
    stringMap(value.configurationSchema) &&
    discovery(value.discovery) &&
    capabilityDefaults(value.capabilityDefaults) &&
    Array.isArray(value.regions) &&
    value.regions.every(
      (item) => record(item) && text(item.id) && text(item.name) && text(item.baseUrl),
    )
  );
}
/** @param {unknown} value @returns {value is ProviderStatus} */
function providerStatus(value) {
  return (
    record(value) &&
    text(value.path) &&
    text(value.revision) &&
    (value.defaultModel === null || modelRef(value.defaultModel)) &&
    stringMap(value.credentialStates) &&
    stringMap(value.credentialSources) &&
    record(value.effective) &&
    Array.isArray(value.data) &&
    value.data.every(
      (item) =>
        record(item) &&
        text(item.baseUrl) &&
        connectionMetadata(item.connection) &&
        providerConfig(item),
    ) &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (item) =>
        record(item) &&
        text(item.projectId) &&
        text(item.root) &&
        typeof item.connected === "boolean" &&
        typeof item.applied === "boolean" &&
        nullableText(item.error) &&
        application(item.application),
    ) &&
    typeof value.pendingApply === "boolean" &&
    application(value.application) &&
    Array.isArray(value.definitions) &&
    value.definitions.every(providerDefinition)
  );
}
/** @param {unknown} value @returns {value is SubscriptionModel} */
function subscriptionModel(value) {
  return (
    record(value) &&
    text(value.id) &&
    (value.reasoningEffortOptions === undefined || strings(value.reasoningEffortOptions)) &&
    (value.name === undefined || text(value.name)) &&
    (value.source === undefined || text(value.source)) &&
    (value.parameters === undefined ||
      (record(value.parameters) &&
        integer(value.parameters.contextWindowTokens) &&
        value.parameters.contextWindowTokens > 0))
  );
}
/** @param {unknown} value @returns {SubscriptionModel[]} */
function subscriptionModels(value) {
  if (!Array.isArray(value) || !value.every(subscriptionModel))
    throw new Error("ChatGPT 模型目录无效");
  return value;
}
/** @param {unknown} value @returns {value is Login} */
function login(value) {
  return record(value) && text(value.loginId) && text(value.authUrl);
}
/** @param {unknown} value @returns {value is Diagnostic} */
function diagnostic(value) {
  return (
    record(value) &&
    text(value.code) &&
    text(value.state) &&
    text(value.phase) &&
    (value.httpStatus === null || integer(value.httpStatus)) &&
    nullableText(value.requestId)
  );
}
/** @param {unknown} value @returns {value is AccountStatus} */
function isAccountStatus(value) {
  return (
    record(value) &&
    typeof value.authenticated === "boolean" &&
    text(value.state) &&
    nullableText(value.email) &&
    nullableText(value.planType) &&
    nullableText(value.modelError) &&
    nullableText(value.error) &&
    (value.diagnostic === null || diagnostic(value.diagnostic)) &&
    (value.login === null || login(value.login)) &&
    Array.isArray(value.models) &&
    value.models.every(subscriptionModel) &&
    (value.activeAccountId === undefined || nullableText(value.activeAccountId)) &&
    (value.accounts === undefined ||
      (Array.isArray(value.accounts) &&
        value.accounts.every(
          (item) =>
            record(item) &&
            text(item.id) &&
            text(item.label) &&
            nullableText(item.email) &&
            typeof item.active === "boolean" &&
            text(item.state) &&
            text(item.billing),
        )))
  );
}
/** @param {unknown} value @returns {AccountStatus} */
function accountStatus(value) {
  if (!isAccountStatus(value)) throw new Error("ChatGPT 账号状态无效");
  return value;
}
/** @template {string} N @template P @param {N} name @param {P} request @param {unknown} value @returns {value is Response<N,P>} */
function isResponse(name, request, value) {
  if (!record(request) || !record(value)) return false;
  if (name === "providers") {
    if (request.operation === "revealKey")
      return (
        text(value.apiKey) &&
        value.apiKey.trim().length > 0 &&
        value.apiKey.length <= 16384 &&
        Object.keys(value).every((key) => key === "apiKey")
      );
    if (request.operation === "probe") return value.state === "connected";
    if (request.operation === "discover")
      return (
        strings(value.models) &&
        (value.modelParameters === undefined ||
          (record(value.modelParameters) && Object.values(value.modelParameters).every(parameters)))
      );
    return (
      [
        "list",
        "apply",
        "save",
        "saveAndApply",
        "removeAndApply",
        "defaultAndApply",
        "remove",
        "default",
      ].some((entry) => entry === request.operation) && providerStatus(value)
    );
  }
  if (name !== "chatgpt") return false;
  if (request.operation === "login") return login(value);
  if (request.operation === "probe") return value.state === "connected";
  return (
    ["status", "forget", "logout", "selectAccount", "cancel"].some(
      (entry) => entry === request.operation,
    ) &&
    (value.availability === undefined ||
      ["checking", "available", "unavailable"].includes(String(value.availability))) &&
    (value.refreshing === undefined || typeof value.refreshing === "boolean") &&
    text(value.billing) &&
    (value.catalog === null ||
      (record(value.catalog) &&
        text(value.catalog.source) &&
        (value.catalog.fetchedAt === null || integer(value.catalog.fetchedAt)) &&
        typeof value.catalog.fresh === "boolean" &&
        (value.catalog.sessionRevision === null || integer(value.catalog.sessionRevision)) &&
        typeof value.catalog.overrides === "boolean")) &&
    isAccountStatus(value)
  );
}
module.exports = {
  connection,
  validContextWindow,
  modelParameters,
  modelCapabilities,
  record,
  integer,
  strings,
  stringMap,
  parameters,
  capabilities,
  modelRef,
  modelConfig,
  providerConfig,
  modelSnapshot,
  provider,
  providers,
  models,
  configurationProof,
  serverStatus,
  acceptedModel,
  isAcceptedModel,
  modelEntry,
  isRequest,
  readRequest,
  isResponse,
  providerStatus,
  providerDefinition,
  connectionMetadata,
  subscriptionModels,
  accountStatus,
  isAccountStatus,
};
