// @ts-check
"use strict";
const { checkedRecord } = require("./remote-network.cjs");

/** @typedef {{platform:'apns',token:string,environment:'production'|'development'}} PushRegistration */
/** @typedef {{devicePeerId:string,commandId:string,method:string,semanticDigest:string,registered:boolean}} PushCommand */
/** @typedef {{push?:PushRegistration,devicePeerId:string,displayName:string,clientKind?:'web'|'ios'|'android',projectIds:string[],capabilities:string[],revision:number,status:'active'|'revoked'|'reviewRequired',pairedAt?:number,revokedAt?:number}} DeviceGrant */
/** @typedef {{id:string,name:string,projects?:string[]}} LegacyDevice */
/** @typedef {{kind:'tailscale',mapping?:import('./remote-network.cjs').NetworkMapping,visibility?:undefined,publicOrigin?:undefined}|{kind:'organization',publicOrigin:string,visibility:'private'|'public',mapping?:undefined}} RemoteNetwork */
/** @typedef {{schemaVersion?:number,enabled?:boolean,directEnabled?:boolean,directPort?:number,identity?:string,relay?:string,relayProtocol?:string,room?:string,capability?:string,devices?:LegacyDevice[],deviceGrants?:DeviceGrant[],pushCommands?:PushCommand[],network?:RemoteNetwork|null,[key:string]:unknown}} RemoteConfig */

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

module.exports = {
  migrateLegacyDevices,
  strings,
  failureCode,
  enrollmentFailureMessage,
  parseRemoteConfig,
  pushRegistration,
};
