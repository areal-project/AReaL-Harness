// @ts-check
"use strict";
const { modelRecord, count, isLifecycleReceipt, isLifecycleProjection } = require("./shared.cjs");
const { resourceInspection } = require("./desktop-control-resources.cjs");
/** @typedef {'accessibility'|'screenRecording'|'inputMonitoring'} Capability */
/** @typedef {{operation:'status'|'restart'|'stop',capability?:never}|{operation:'requestAccess'|'openSettings',capability:Capability}} ComputerRequest */
/** @typedef {{operation:'status'|'networkInspect'|'disable'|'enableDirect'|'disableDirect'|'cancelPair'|'forgetRevoked'}|{operation:'reject'|'revoke',id:string}|{operation:'renameDevice',id:string,name:string}|{operation:'approve'|'updateGrant',id:string,projects:string[],preset:'Observer'|'Operator'}|{operation:'pair',transport?:'direct'|'relay'}|{operation:'networkPropose',httpsPort?:number}|{operation:'networkProposeScope',scope:'private'|'public'}|{operation:'networkApply',proposalId:string,confirmed:true}|{operation:'networkChangeScope',proposalId:string,confirmed:true,publicConfirmed?:boolean}|{operation:'networkRecover'|'networkRemove',confirmed:true}|{operation:'networkConfigureOrganization',publicOrigin:string,visibility:'private'|'public',confirmed:true,publicConfirmed?:boolean}|{operation:'enable',relay:string,code?:string,confirmed:true}} RemoteRequest */
/** @typedef {{serviceLifecycle:{operation:'check'}|{operation:'update'}|{operation:'stop'}|{operation:'recover'}|{operation:'quitInterface'}|{operation:'stopAndQuit'},serviceStatus:Record<string,never>,stopService:Record<string,never>,recoverResources:Record<string,never>,browserData:{operation:'status'}|{operation:'importChrome'}|{operation:'clearCache'}|{operation:'clearAll'},computerControl:ComputerRequest,exportDiagnostics:Record<string,never>,connectService:Record<string,never>,export:{projectId:string,threadId:string},remoteControl:RemoteRequest}} Requests */
/** @typedef {keyof Requests} Name */
/** @template {Name} N @typedef {Requests[N]} Request */
/** @typedef {{canceled:true,kind?:string}} Canceled */
/** @typedef {{stopped:boolean,operation:import('./shared.cjs').LifecycleReceipt,kind?:string}} LifecycleResult */
/** @typedef {{recovered:boolean,canceled?:boolean,lifecycle?:import('./shared.cjs').LifecycleProjection}|Canceled} RecoveryResult */
/** @typedef {LifecycleResult|Canceled|{stopped:true,quitting:true}} QuitResult */
/** @typedef {{canStop:boolean,connected:boolean,clients:number,busy:boolean,activeCommands:number,starting:number,providerUpdating:boolean,projects:Array<Omit<import('./desktop-control-resources.cjs').ResourceInspection,'serviceId'|'generation'|'lifecycle'> & {root:string,started:boolean}>}} ServiceStatus */
/** @typedef {{success:boolean,cookies:{imported:number,skipped:number,failed:number},localStorage:{originsImported:number,entriesImported:number,originsSkipped:number,originsFailed:number,error?:string},issues?:string[],error?:string}} BrowserImportResult */
/** @typedef {{pid:number,bundle_id:string|null,name:string|null,active:boolean}} NativeApp */
/** @typedef {{active?:boolean,activeTarget?:NativeApp|null,app?:NativeApp|null,operation?:string|null,controlEpoch?:number,lastStopReason?:string|null,heldKeys?:number,heldButtons?:number,takeoverMonitoring?:boolean}} ControlActivity */
/** @typedef {ControlActivity & {available:boolean,platform:string,ready:boolean,enabled?:boolean,accessibility:string,screenRecording:string,inputMonitoring?:string,minimumOS?:string,helperGeneration?:string,grantOwner?:string,owner?:{display_name:string,bundle_id:string,path:string},ownerFence?:{count:number,limit:number,capacityReached:boolean,reason?:string},reason?:string,code?:string}} NativeStatus */
/** @typedef {{provider:'lcu',supported:boolean,platform:string,ready:boolean,state:string,reason:string,active:boolean,sessions:number,code?:string}} ExternalStatus */
/** @typedef {NativeStatus|ExternalStatus} ComputerStatus */
/** @typedef {{available?:boolean,diagnostic?:string,version?:string,persistentServe?:boolean,funnelPorts?:number[]|null,login?:string,https?:string,policy?:string}} NetworkInspection */
/** @typedef {{enabled:boolean,connected:boolean,relay:string,relayError:string,relayUrl:string,directEnabled:boolean,directUrl:string,network:{kind:'tailscale'|'organization'|null,scope:'private'|'public'|null,reconciliation:string|null,publicOrigin:string,diagnostic:string,policy:'unknown',phoneAccess:'unknown',inspection:NetworkInspection|null},directHostId:string,directError:string,migrationError:string,pushSupported?:boolean,deviceGrants:Array<{pushRegistered?:boolean,devicePeerId:string,displayName:string,clientKind?:'web'|'ios'|'android',projectIds:string[],capabilities:string[],revision:number,status:'active'|'revoked'|'reviewRequired',pairedAt?:number,revokedAt?:number,online?:boolean,lastSeenAt?:number|null}>,devices:[],pending:Array<{id:string,name:string,clientKind?:'web'|'ios'|'android',fingerprint:string,expiresAt:number}>}} RemoteStatus */
/** @typedef {{proposalId:string,publicOrigin:string,confirmation:string}} NetworkProposal */
/** @template {Name} N @template [P=Requests[N]] @typedef {N extends 'connectService' ? null : N extends 'export'|'exportDiagnostics' ? Canceled|{path:string} : N extends 'serviceStatus' ? ServiceStatus : N extends 'stopService' ? LifecycleResult|Canceled : N extends 'recoverResources' ? RecoveryResult : N extends 'computerControl' ? ComputerStatus : N extends 'browserData' ? P extends {operation:'status'} ? {persistent:true,shared:true,busy:boolean} : P extends {operation:'importChrome'} ? BrowserImportResult : {success:true} : N extends 'remoteControl' ? P extends {operation:'pair'} ? {payload:string,qr:string,expiresAt:number} : P extends {operation:'networkPropose'} ? NetworkProposal : P extends {operation:'networkProposeScope'} ? NetworkProposal & {sourceScope?:'private'|'public',scope:'private'|'public'} : RemoteStatus : N extends 'serviceLifecycle' ? P extends {operation:'check'} ? import('./shared.cjs').LifecycleProjection : P extends {operation:'recover'} ? RecoveryResult : P extends {operation:'quitInterface'|'stopAndQuit'} ? QuitResult : P extends {operation:'update'} ? LifecycleResult|Canceled|RecoveryResult : LifecycleResult|Canceled : never} Response */
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {Record<string,unknown>} value @param {string[]} keys */
function only(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
/** @template {Name} N @param {N} name @param {unknown} value @returns {value is Requests[N]} */
function isRequest(name, value) {
  if (!modelRecord(value)) return false;
  if (
    [
      "serviceStatus",
      "stopService",
      "recoverResources",
      "exportDiagnostics",
      "connectService",
    ].includes(name)
  )
    return Object.keys(value).length === 0;
  if (name === "export")
    return (
      typeof value.projectId === "string" &&
      typeof value.threadId === "string" &&
      only(value, ["projectId", "threadId"])
    );
  if (name === "serviceLifecycle")
    return (
      ["check", "update", "stop", "recover", "quitInterface", "stopAndQuit"].some(
        (entry) => value.operation === entry,
      ) && only(value, ["operation"])
    );
  if (name === "browserData")
    return (
      ["status", "importChrome", "clearCache", "clearAll"].some(
        (entry) => value.operation === entry,
      ) && only(value, ["operation"])
    );
  if (name === "computerControl")
    return (
      ["status", "requestAccess", "openSettings", "restart", "stop"].some(
        (entry) => value.operation === entry,
      ) &&
      only(value, ["operation", "capability"]) &&
      (["requestAccess", "openSettings"].some((entry) => value.operation === entry)
        ? ["accessibility", "screenRecording", "inputMonitoring"].some(
            (entry) => value.capability === entry,
          )
        : value.capability === undefined)
    );
  return name === "remoteControl" && isRemoteRequest(value);
}
/** @param {unknown} value @returns {value is RemoteRequest} */
function isRemoteRequest(value) {
  if (!modelRecord(value)) return false;
  switch (value.operation) {
    case "status":
    case "networkInspect":
    case "disable":
    case "enableDirect":
    case "disableDirect":
    case "cancelPair":
    case "forgetRevoked":
      return only(value, ["operation"]);
    case "renameDevice":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        only(value, ["operation", "id", "name"])
      );
    case "reject":
    case "revoke":
      return typeof value.id === "string" && only(value, ["operation", "id"]);
    case "approve":
    case "updateGrant":
      return (
        typeof value.id === "string" &&
        strings(value.projects) &&
        value.projects.length > 0 &&
        (value.preset === "Observer" || value.preset === "Operator") &&
        only(value, ["operation", "id", "projects", "preset"])
      );
    case "pair":
      return (
        (value.transport === undefined ||
          value.transport === "direct" ||
          value.transport === "relay") &&
        only(value, ["operation", "transport"])
      );
    case "networkPropose":
      return (
        (value.httpsPort === undefined ||
          (count(value.httpsPort) && value.httpsPort > 0 && value.httpsPort <= 65535)) &&
        only(value, ["operation", "httpsPort"])
      );
    case "networkProposeScope":
      return (
        (value.scope === "private" || value.scope === "public") &&
        only(value, ["operation", "scope"])
      );
    case "networkApply":
    case "networkChangeScope":
      return (
        typeof value.proposalId === "string" &&
        value.confirmed === true &&
        (value.publicConfirmed === undefined || typeof value.publicConfirmed === "boolean") &&
        only(value, [
          "operation",
          "proposalId",
          "confirmed",
          ...(value.operation === "networkChangeScope" ? ["publicConfirmed"] : []),
        ])
      );
    case "networkRecover":
    case "networkRemove":
      return value.confirmed === true && only(value, ["operation", "confirmed"]);
    case "networkConfigureOrganization":
      return (
        typeof value.publicOrigin === "string" &&
        (value.visibility === "private" || value.visibility === "public") &&
        value.confirmed === true &&
        (value.publicConfirmed === undefined || typeof value.publicConfirmed === "boolean") &&
        only(value, ["operation", "publicOrigin", "visibility", "confirmed", "publicConfirmed"])
      );
    case "enable":
      return (
        typeof value.relay === "string" &&
        (value.code === undefined || typeof value.code === "string") &&
        value.confirmed === true &&
        only(value, ["operation", "relay", "code", "confirmed"])
      );
  }
  return false;
}
/** @param {unknown} value @returns {value is BrowserImportResult} */
function browserImport(value) {
  return (
    modelRecord(value) &&
    typeof value.success === "boolean" &&
    modelRecord(value.cookies) &&
    ["imported", "skipped", "failed"].every(
      (key) => modelRecord(value.cookies) && count(value.cookies[key]),
    ) &&
    modelRecord(value.localStorage) &&
    ["originsImported", "entriesImported", "originsSkipped", "originsFailed"].every(
      (key) => modelRecord(value.localStorage) && count(value.localStorage[key]),
    ) &&
    (value.localStorage.error === undefined || typeof value.localStorage.error === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.issues === undefined || strings(value.issues))
  );
}
/** @param {unknown} value @returns {value is NativeApp} */
function nativeApp(value) {
  return (
    modelRecord(value) &&
    count(value.pid) &&
    (value.bundle_id === null || typeof value.bundle_id === "string") &&
    (value.name === null || typeof value.name === "string") &&
    typeof value.active === "boolean"
  );
}
/** @param {unknown} value @returns {value is ComputerStatus} */
function isComputerStatus(value) {
  if (
    !modelRecord(value) ||
    typeof value.platform !== "string" ||
    typeof value.ready !== "boolean" ||
    (value.code !== undefined && typeof value.code !== "string")
  )
    return false;
  if (value.provider === "lcu")
    return (
      typeof value.supported === "boolean" &&
      typeof value.state === "string" &&
      typeof value.reason === "string" &&
      typeof value.active === "boolean" &&
      count(value.sessions)
    );
  return (
    typeof value.available === "boolean" &&
    typeof value.accessibility === "string" &&
    typeof value.screenRecording === "string" &&
    ["enabled", "active", "takeoverMonitoring"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    ["inputMonitoring", "minimumOS", "helperGeneration", "grantOwner", "reason"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["controlEpoch", "heldKeys", "heldButtons"].every(
      (key) => value[key] === undefined || count(value[key]),
    ) &&
    ["operation", "lastStopReason"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    ) &&
    ["activeTarget", "app"].every((key) => value[key] == null || nativeApp(value[key])) &&
    (value.owner === undefined ||
      (modelRecord(value.owner) &&
        ["display_name", "bundle_id", "path"].every(
          (key) => modelRecord(value.owner) && typeof value.owner[key] === "string",
        ))) &&
    (value.ownerFence === undefined ||
      (modelRecord(value.ownerFence) &&
        count(value.ownerFence.count) &&
        count(value.ownerFence.limit) &&
        typeof value.ownerFence.capacityReached === "boolean" &&
        (value.ownerFence.reason === undefined || typeof value.ownerFence.reason === "string")))
  );
}
/** @param {unknown} value @returns {ComputerStatus} */
function readComputerStatus(value) {
  if (!isComputerStatus(value)) throw new Error("Invalid computer control status");
  return value;
}
/** @param {unknown} value @returns {value is NetworkInspection} */
function networkInspection(value) {
  return (
    modelRecord(value) &&
    ["available", "persistentServe"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    ["diagnostic", "version", "login", "https", "policy"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.funnelPorts == null ||
      (Array.isArray(value.funnelPorts) && value.funnelPorts.every(count)))
  );
}
/** @param {unknown} value @returns {value is RemoteStatus} */
function isRemoteStatus(value) {
  return (
    modelRecord(value) &&
    ["enabled", "connected", "directEnabled"].every((key) => typeof value[key] === "boolean") &&
    [
      "relay",
      "relayError",
      "relayUrl",
      "directUrl",
      "directHostId",
      "directError",
      "migrationError",
    ].every((key) => typeof value[key] === "string") &&
    modelRecord(value.network) &&
    (value.network.kind === null ||
      value.network.kind === "tailscale" ||
      value.network.kind === "organization") &&
    (value.network.scope === null ||
      value.network.scope === "private" ||
      value.network.scope === "public") &&
    (value.network.reconciliation === null || typeof value.network.reconciliation === "string") &&
    typeof value.network.publicOrigin === "string" &&
    typeof value.network.diagnostic === "string" &&
    value.network.policy === "unknown" &&
    value.network.phoneAccess === "unknown" &&
    (value.network.inspection === null || networkInspection(value.network.inspection)) &&
    (value.pushSupported === undefined || typeof value.pushSupported === "boolean") &&
    Array.isArray(value.deviceGrants) &&
    value.deviceGrants.every(
      (grant) =>
        modelRecord(grant) &&
        (grant.pushRegistered === undefined || typeof grant.pushRegistered === "boolean") &&
        grant.push === undefined &&
        typeof grant.devicePeerId === "string" &&
        typeof grant.displayName === "string" &&
        strings(grant.projectIds) &&
        strings(grant.capabilities) &&
        count(grant.revision) &&
        (grant.status === "active" ||
          grant.status === "revoked" ||
          grant.status === "reviewRequired") &&
        (grant.pairedAt === undefined || count(grant.pairedAt)) &&
        (grant.revokedAt === undefined || count(grant.revokedAt)) &&
        (grant.online === undefined || typeof grant.online === "boolean") &&
        (grant.lastSeenAt === undefined || grant.lastSeenAt === null || count(grant.lastSeenAt)),
    ) &&
    Array.isArray(value.devices) &&
    value.devices.length === 0 &&
    Array.isArray(value.pending) &&
    value.pending.every(
      (pair) =>
        modelRecord(pair) &&
        ["id", "name", "fingerprint"].every((key) => typeof pair[key] === "string") &&
        count(pair.expiresAt),
    )
  );
}
/** @param {unknown} value @returns {value is ServiceStatus} */
function serviceStatus(value) {
  return (
    modelRecord(value) &&
    ["canStop", "connected", "busy", "providerUpdating"].every(
      (key) => typeof value[key] === "boolean",
    ) &&
    ["clients", "activeCommands", "starting"].every((key) => count(value[key])) &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (project) =>
        resourceInspection(project) &&
        typeof project.root === "string" &&
        "started" in project &&
        typeof project.started === "boolean",
    )
  );
}
/** @param {unknown} value @returns {value is LifecycleResult} */
function lifecycleResult(value) {
  return (
    modelRecord(value) &&
    typeof value.stopped === "boolean" &&
    isLifecycleReceipt(value.operation) &&
    (value.kind === undefined || typeof value.kind === "string")
  );
}
/** @param {unknown} value @returns {value is Canceled} */
function canceled(value) {
  return (
    modelRecord(value) &&
    value.canceled === true &&
    (value.kind === undefined || typeof value.kind === "string")
  );
}
/** @param {unknown} value @returns {value is RecoveryResult} */
function recoveryResult(value) {
  return (
    canceled(value) ||
    (modelRecord(value) &&
      typeof value.recovered === "boolean" &&
      (value.canceled === undefined || typeof value.canceled === "boolean") &&
      (value.lifecycle === undefined || isLifecycleProjection(value.lifecycle)))
  );
}
/** @param {Name} name @param {Record<string,unknown>} request @param {unknown} value */
function response(name, request, value) {
  if (name === "connectService") return value === null;
  if (name === "export" || name === "exportDiagnostics")
    return canceled(value) || (modelRecord(value) && typeof value.path === "string");
  if (name === "serviceStatus") return serviceStatus(value);
  if (name === "stopService") return lifecycleResult(value) || canceled(value);
  if (name === "recoverResources") return recoveryResult(value);
  if (name === "serviceLifecycle") {
    if (request.operation === "check") return isLifecycleProjection(value);
    if (request.operation === "recover") return recoveryResult(value);
    if (request.operation === "quitInterface" || request.operation === "stopAndQuit")
      return (
        lifecycleResult(value) ||
        canceled(value) ||
        (modelRecord(value) && value.stopped === true && value.quitting === true)
      );
    return (
      lifecycleResult(value) ||
      canceled(value) ||
      (request.operation === "update" && recoveryResult(value))
    );
  }
  if (name === "computerControl") return isComputerStatus(value);
  if (!modelRecord(value)) return false;
  if (name === "browserData")
    return request.operation === "status"
      ? value.persistent === true && value.shared === true && typeof value.busy === "boolean"
      : request.operation === "importChrome"
        ? browserImport(value)
        : value.success === true;
  if (name === "remoteControl") {
    if (request.operation === "pair")
      return (
        typeof value.payload === "string" && typeof value.qr === "string" && count(value.expiresAt)
      );
    if (request.operation === "networkPropose" || request.operation === "networkProposeScope")
      return (
        ["proposalId", "publicOrigin", "confirmation"].every(
          (key) => typeof value[key] === "string",
        ) &&
        (request.operation !== "networkProposeScope" ||
          ((value.sourceScope === undefined ||
            value.sourceScope === "private" ||
            value.sourceScope === "public") &&
            (value.scope === "private" || value.scope === "public")))
      );
    return isRemoteStatus(value);
  }
  return false;
}
/** @template {Name} N @template {Requests[N]} P @param {N} name @param {P} request @param {unknown} value @returns {asserts value is Response<N,P>} */
function validateResponse(name, request, value) {
  if (!response(name, request, value))
    throw Object.assign(new Error("Invalid Desktop control response"), {
      code: "DESKTOP_RESPONSE_INVALID",
    });
}
module.exports = {
  isRequest,
  isRemoteRequest,
  validateResponse,
  isComputerStatus,
  readComputerStatus,
  isRemoteStatus,
};
