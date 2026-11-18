// @ts-check
"use strict";

/** @typedef {{platform:'apns',token:string,environment:'production'|'development'}} PushRegistration */
/** @typedef {{devicePeerId:string,commandId:string,method:string,semanticDigest:string,registered:boolean}} PushCommand */
/** @typedef {{push?:PushRegistration,devicePeerId:string,displayName:string,clientKind?:'web'|'ios'|'android',projectIds:string[],capabilities:string[],revision:number,status:'active'|'revoked'|'reviewRequired',pairedAt?:number,revokedAt?:number}} DeviceGrant */
/** @typedef {{id:string,name:string,projects?:string[]}} LegacyDevice */
/** @typedef {{schema:1,owner:'areal-remote',id:string,state:'proposed'|'pending'|'owned'|'removed',operation:'apply'|'remove'|'scope',publicOrigin:string,target:string,httpsPort:number,scope:'private'|'public',sourceScope?:'private'|'public'}} HistoricalNetworkMapping */
/** @typedef {{kind:'tailscale',mapping?:HistoricalNetworkMapping,visibility?:undefined,publicOrigin?:undefined}|{kind:'organization',publicOrigin:string,visibility:'private'|'public',mapping?:undefined}} RemoteNetwork */
/** @typedef {{origin:string,kind:'local'|'ssh'|'external',room:string,capability:string}} RelayProfile */
/** @typedef {{target:string,port:number,address:string,ownerId:string,room:string,capability:string,phase:'pending'|'ready'|'failed'|'removed',version?:string,active?:boolean,canReconfigure?:boolean}} RelayDeploymentConfig */
/** @typedef {{schemaVersion?:number,enabled?:boolean,directEnabled?:boolean,directPort?:number,relayLocal?:{enabled:boolean,port:number,origin:string},relayDeployment?:RelayDeploymentConfig,relayProfiles?:RelayProfile[],identity?:string,relay?:string,relayProtocol?:string,room?:string,capability?:string,devices?:LegacyDevice[],deviceGrants?:DeviceGrant[],pushCommands?:PushCommand[],network?:RemoteNetwork|null,[key:string]:unknown}} RemoteConfig */

/** @param {string} code */
function failure(code) {
  return Object.assign(new Error(`Remote network: ${code}`), { code });
}

/** @param {unknown} value @param {readonly string[]} keys @returns {value is Record<string,unknown>} */
const keysOnly = (value, keys) =>
  record(value) && Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} value @returns {value is number} */
const portNumber = (value) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;

/** @param {unknown} value @returns {string} */
function validateHttpsOrigin(value) {
  try {
    if (typeof value !== "string") throw failure("invalid-origin");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== value ||
      !url.hostname
    )
      throw failure("invalid-origin");
    return value;
  } catch {
    throw failure("invalid-origin");
  }
}

/** @param {unknown} value @returns {HistoricalNetworkMapping} */
function checkedRecord(value) {
  if (!record(value)) throw failure("invalid-record");
  const normalized = { ...value, scope: value.scope === undefined ? "private" : value.scope };
  assertHistoricalNetworkMapping(normalized);
  return normalized;
}
/** @param {unknown} record @returns {asserts record is HistoricalNetworkMapping} */
function assertHistoricalNetworkMapping(record) {
  if (
    !keysOnly(record, [
      "schema",
      "owner",
      "id",
      "state",
      "operation",
      "publicOrigin",
      "target",
      "httpsPort",
      "scope",
      "sourceScope",
    ]) ||
    record.schema !== 1 ||
    record.owner !== "areal-remote" ||
    typeof record.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(record.id) ||
    !(
      typeof record.state === "string" &&
      ["proposed", "pending", "owned", "removed"].includes(record.state)
    ) ||
    !(
      typeof record.operation === "string" &&
      ["apply", "remove", "scope"].includes(record.operation)
    ) ||
    !portNumber(record.httpsPort)
  )
    throw failure("invalid-record");
  const scope = record.scope === undefined ? "private" : record.scope;
  if (
    !(typeof scope === "string" && ["private", "public"].includes(scope)) ||
    (record.operation === "scope"
      ? !(
          typeof record.sourceScope === "string" &&
          ["private", "public"].includes(record.sourceScope)
        ) || record.sourceScope === scope
      : record.sourceScope !== undefined) ||
    (record.state === "proposed" && record.operation === "apply" && scope !== "private")
  )
    throw failure("invalid-record");
  const origin = new URL(validateHttpsOrigin(record.publicOrigin));
  if (Number(origin.port || 443) !== record.httpsPort || !/^[a-z0-9.-]+$/.test(origin.hostname))
    throw failure("invalid-record");
  const match =
    typeof record.target === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d*)$/.exec(record.target);
  if (!match || !portNumber(Number(match[1]))) throw failure("invalid-record");
}

/** @param {unknown} value @returns {RemoteConfig} */
function parseRemoteConfig(value) {
  if (value == null) return { enabled: false, devices: [] };
  assertRemoteConfig(value);
  return value;
}
/** @param {unknown} value @returns {asserts value is RemoteConfig} */
function assertRemoteConfig(value) {
  if (
    !record(value) ||
    ["enabled", "directEnabled"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "boolean",
    ) ||
    ["identity", "relay", "relayProtocol", "room", "capability"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    ) ||
    (value.schemaVersion !== undefined &&
      (typeof value.schemaVersion !== "number" || !Number.isSafeInteger(value.schemaVersion))) ||
    (value.directPort !== undefined &&
      (typeof value.directPort !== "number" ||
        !Number.isInteger(value.directPort) ||
        value.directPort < 0 ||
        value.directPort > 65535)) ||
    (value.devices !== undefined &&
      (!Array.isArray(value.devices) || !value.devices.every(legacyDevice))) ||
    (value.pushCommands !== undefined &&
      (!Array.isArray(value.pushCommands) ||
        value.pushCommands.length > 4096 ||
        !value.pushCommands.every(pushCommand))) ||
    (value.deviceGrants !== undefined &&
      (!Array.isArray(value.deviceGrants) || !value.deviceGrants.every(deviceGrant)))
  )
    throw new Error("远程配置格式无效");
  if (
    value.relayProfiles !== undefined &&
    (!Array.isArray(value.relayProfiles) ||
      !value.relayProfiles.every(
        (profile) =>
          record(profile) &&
          typeof profile.origin === "string" &&
          ["local", "ssh", "external"].includes(String(profile.kind)) &&
          typeof profile.room === "string" &&
          /^[a-f0-9]{64}$/.test(profile.room) &&
          typeof profile.capability === "string" &&
          /^[A-Za-z0-9_-]{43}$/.test(profile.capability),
      ))
  )
    throw new Error("Relay 配置格式无效");
  if (
    value.relayLocal !== undefined &&
    (!record(value.relayLocal) ||
      typeof value.relayLocal.enabled !== "boolean" ||
      typeof value.relayLocal.origin !== "string" ||
      !Number.isInteger(value.relayLocal.port) ||
      Number(value.relayLocal.port) < 1024 ||
      Number(value.relayLocal.port) > 65535)
  )
    throw new Error("本机 Relay 配置无效");
  if (
    value.relayDeployment !== undefined &&
    (!record(value.relayDeployment) ||
      !["target", "address", "ownerId", "room", "capability"].every(
        (key) => record(value.relayDeployment) && typeof value.relayDeployment[key] === "string",
      ) ||
      !Number.isInteger(value.relayDeployment.port) ||
      (value.relayDeployment.canReconfigure !== undefined &&
        typeof value.relayDeployment.canReconfigure !== "boolean") ||
      !["pending", "ready", "failed", "removed"].includes(String(value.relayDeployment.phase)))
  )
    throw new Error("SSH Relay 配置无效");
  if (value.network != null) {
    if (!record(value.network)) throw new Error("远程网络配置无效");
    if (value.network.kind === "tailscale") {
      if (value.network.visibility !== undefined || value.network.publicOrigin !== undefined)
        throw new Error("远程网络配置无效");
      if (value.network.mapping !== undefined)
        value.network.mapping = checkedRecord(value.network.mapping);
    } else if (
      value.network.kind !== "organization" ||
      value.network.mapping !== undefined ||
      typeof value.network.publicOrigin !== "string" ||
      (value.network.visibility !== "private" && value.network.visibility !== "public")
    )
      throw new Error("远程网络配置无效");
  }
}
/** @param {unknown} value @returns {value is DeviceGrant} */
function deviceGrant(value) {
  return (
    record(value) &&
    typeof value.devicePeerId === "string" &&
    typeof value.displayName === "string" &&
    (value.clientKind === undefined ||
      value.clientKind === "web" ||
      value.clientKind === "ios" ||
      value.clientKind === "android") &&
    (value.push === undefined || pushRegistration(value.push)) &&
    strings(value.projectIds) &&
    strings(value.capabilities) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    (value.status === "active" ||
      value.status === "revoked" ||
      value.status === "reviewRequired") &&
    (value.pairedAt === undefined || Number.isSafeInteger(value.pairedAt)) &&
    (value.revokedAt === undefined || Number.isSafeInteger(value.revokedAt))
  );
}
/** @param {unknown} value @returns {value is LegacyDevice} */
function legacyDevice(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.projects === undefined || strings(value.projects))
  );
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is PushRegistration} */
function pushRegistration(value) {
  return (
    record(value) &&
    Object.keys(value).every((key) => ["platform", "token", "environment"].includes(key)) &&
    value.platform === "apns" &&
    typeof value.token === "string" &&
    /^[0-9a-f]{64,200}$/i.test(value.token) &&
    (value.environment === "production" || value.environment === "development")
  );
}
/** @param {unknown} value @returns {value is PushCommand} */
function pushCommand(value) {
  return (
    record(value) &&
    typeof value.devicePeerId === "string" &&
    typeof value.commandId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.commandId) &&
    ["device.push.register", "device.push.unregister"].includes(String(value.method)) &&
    typeof value.semanticDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.semanticDigest) &&
    typeof value.registered === "boolean"
  );
}
/** @param {RemoteConfig} config */
function migrateLegacyDevices(config) {
  const grants = [...(config.deviceGrants ?? [])];
  for (const device of config.devices ?? [])
    if (!grants.some((grant) => grant.devicePeerId === device.id))
      grants.push({
        devicePeerId: device.id,
        displayName: device.name,
        projectIds: [...(device.projects ?? [])],
        capabilities: [],
        revision: 1,
        status: "reviewRequired",
      });
  return {
    ...config,
    schemaVersion: 2,
    enabled: false,
    directEnabled: false,
    deviceGrants: grants,
  };
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} error @param {string} fallback */
function failureCode(error, fallback) {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code
    ? error.code
    : fallback;
}

/** @param {NodeJS.ErrnoException} error */
function enrollmentFailureMessage(error) {
  const code = error.code ?? "";
  const certificateFailure = [
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ].includes(code);
  return certificateFailure
    ? `Relay HTTPS 证书验证失败（${code}）。请检查证书域名、有效期和桌面进程信任的 CA。`
    : "Relay 登记失败，请检查 HTTPS 和登记码";
}

/** @param {RemoteConfig} config */
function withCurrentProfile(config) {
  const { relay, room, capability, relayProtocol } = config;
  if (!relay || !room || !capability || relayProtocol !== "areal.remote.v2") return config;
  if ((config.relayProfiles ?? []).some((profile) => profile.origin === relay)) return config;
  return {
    ...config,
    relayProfiles: [
      ...(config.relayProfiles ?? []),
      { origin: relay, kind: /** @type {const} */ ("external"), room, capability },
    ],
  };
}

/** @param {RemoteConfig} config @param {{phase:string,address?:string}} local @param {string} origin */
function selectRelayProfile(config, local, origin) {
  const profile = (config.relayProfiles ?? []).find((item) => item.origin === origin);
  if (!profile) throw new Error("此 Relay 尚未登记");
  if (profile.kind === "local" && (local.phase !== "running" || local.address !== origin))
    throw new Error("请先启动本机 Relay");
  if (profile.kind !== "local") validateHttpsOrigin(origin);
  return {
    ...withCurrentProfile(config),
    relay: profile.origin,
    room: profile.room,
    capability: profile.capability,
    enabled: true,
    relayProtocol: "areal.remote.v2",
  };
}

const PRESETS = Object.freeze({
  Observer: ["observe", "review"],
  Operator: ["observe", "review", "submit", "interrupt", "answer", "pauseTask"],
});
/** 管理是第四级授权，只能叠在 Operator 上单独勾选；已配对设备不会自动获得。 @param {keyof typeof PRESETS} preset @param {boolean} [manage] */
function presetCapabilities(preset, manage) {
  return [...PRESETS[preset], ...(manage && preset === "Operator" ? ["manage"] : [])];
}

module.exports = {
  PRESETS,
  presetCapabilities,
  selectRelayProfile,
  withCurrentProfile,
  migrateLegacyDevices,
  strings,
  failureCode,
  enrollmentFailureMessage,
  parseRemoteConfig,
  pushRegistration,
};
