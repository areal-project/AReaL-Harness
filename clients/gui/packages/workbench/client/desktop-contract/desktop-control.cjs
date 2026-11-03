// @ts-check
"use strict";
const {
  modelRecord,
  count,
  isLifecycleReceipt,
  lifecycleViewOperation,
  isLifecycleProjection,
} = require("./shared.cjs");
const bugReport = require("./bug-report.cjs");
const { resourceInspection } = require("./desktop-control-resources.cjs");
/** @typedef {'accessibility'|'screenRecording'|'inputMonitoring'} Capability */
/** @typedef {{version:1,requestId:string,hostId:string,generation:string,action:'prepare'|'apply',targetVersion:string,state:'acceptedPending'|'prepared'|'blocked'|'partial'|'settlementIncomplete'|'admissionUnknown'|'completed',message?:string}} HostUpdateReceipt */
/** @typedef {{restartPending:boolean,targetVersion:string|null,prepareRequestId:string|null,operation:HostUpdateReceipt|null}} HostUpdateStatus */
/** @typedef {{operation:'status'|'install'|'uninstall'}} HostInstallationRequest */
/** @typedef {{operation:'status'|'check'}|{operation:'prepare'|'apply',requestId:string,targetVersion:string}} HostUpdateRequest */
/** @typedef {{installed:boolean,label?:string}} HostInstallation */
/** @typedef {{operation:'status'|'restart'|'stop',capability?:never}|{operation:'requestAccess'|'openSettings',capability:Capability}} ComputerRequest */
/** @typedef {{operation:'relayServiceStartLocal'|'relayServiceStopLocal'|'relayServiceUpgrade'|'relayServiceInspect'}|{operation:'relayUse',origin:string}|{operation:'relayServiceDeploy',target:string,port:number,address:string}|{operation:'relayServiceRemove',removeData:boolean}|{operation:'status'|'networkInspect'|'disable'|'enableDirect'|'disableDirect'|'cancelPair'|'forgetRevoked'}|{operation:'reject'|'revoke',id:string}|{operation:'renameDevice',id:string,name:string}|{operation:'approve'|'updateGrant',id:string,projects:string[],preset:'Observer'|'Operator'}|{operation:'pair',transport?:'direct'|'relay'}|{operation:'networkPropose',httpsPort?:number}|{operation:'networkProposeScope',scope:'private'|'public'}|{operation:'networkApply',proposalId:string,confirmed:true}|{operation:'networkChangeScope',proposalId:string,confirmed:true,publicConfirmed?:boolean}|{operation:'networkRecover'|'networkRemove',confirmed:true}|{operation:'networkConfigureOrganization',publicOrigin:string,visibility:'private'|'public',confirmed:true,publicConfirmed?:boolean}|{operation:'enable',relay:string,code?:string,confirmed:true}} RemoteRequest */
/** @typedef {{bugReport:import("./bug-report.cjs").Request,serviceLifecycle:{operation:'check'}|{operation:'update'}|{operation:'stop'}|{operation:'recover'}|{operation:'quitInterface'}|{operation:'stopAndQuit'},hostInstallation:HostInstallationRequest,hostUpdate:HostUpdateRequest,serviceStatus:Record<string,never>,stopService:Record<string,never>,recoverResources:Record<string,never>,browserData:{operation:'status'}|{operation:'importChrome'}|{operation:'clearCache'}|{operation:'clearAll'},computerControl:ComputerRequest,exportDiagnostics:Record<string,never>,connectService:Record<string,never>,export:{projectId:string,threadId:string},remoteControl:RemoteRequest}} Requests */
/** @typedef {keyof Requests} Name */
/** @template {Name} N @typedef {Requests[N]} Request */
/** @typedef {{canceled:true,kind?:string}} Canceled */
/** @typedef {{stopped:boolean,operation:import('./shared.cjs').LifecycleReceipt|import('./shared.cjs').LifecycleViewOperation,kind?:string}} LifecycleResult */
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
/** @typedef {{local:{phase:'stopped'|'starting'|'running'|'failed',address:string,error:string,version:string},deployment:{target:string,port:number,address:string,phase:'pending'|'ready'|'failed'|'removed',version:string,active:boolean,canReconfigure?:boolean}|null,job:{operation:string,phase:'running'|'done'|'failed'|'unknown',error:string}|null,profiles:Array<{origin:string,kind:'local'|'ssh'|'external',active:boolean}>}} RelayServiceStatus */
/** @typedef {{relayService?:RelayServiceStatus,enabled:boolean,connected:boolean,relay:string,relayError:string,relayUrl:string,directEnabled:boolean,directUrl:string,network:{kind:'tailscale'|'organization'|null,scope:'private'|'public'|null,reconciliation:string|null,publicOrigin:string,diagnostic:string,policy:'unknown',phoneAccess:'unknown',inspection:NetworkInspection|null},directHostId:string,directError:string,migrationError:string,pushSupported?:boolean,deviceGrants:Array<{pushRegistered?:boolean,devicePeerId:string,displayName:string,clientKind?:'web'|'ios'|'android',projectIds:string[],capabilities:string[],revision:number,status:'active'|'revoked'|'reviewRequired',pairedAt?:number,revokedAt?:number,online?:boolean,lastSeenAt?:number|null}>,devices:[],pending:Array<{id:string,name:string,clientKind?:'web'|'ios'|'android',fingerprint:string,expiresAt:number}>}} RemoteStatus */
/** @typedef {{proposalId:string,publicOrigin:string,confirmation:string}} NetworkProposal */
/** @template {Name} N @template [P=Requests[N]] @typedef {N extends 'bugReport' ? import('./bug-report.cjs').Response : N extends 'connectService' ? null : N extends 'export'|'exportDiagnostics' ? Canceled|{path:string} : N extends 'hostInstallation' ? HostInstallation : N extends 'hostUpdate' ? HostUpdateStatus & {supported:boolean} : N extends 'serviceStatus' ? ServiceStatus : N extends 'stopService' ? LifecycleResult|Canceled : N extends 'recoverResources' ? RecoveryResult : N extends 'computerControl' ? ComputerStatus : N extends 'browserData' ? P extends {operation:'status'} ? {persistent:true,shared:true,busy:boolean} : P extends {operation:'importChrome'} ? BrowserImportResult : {success:true} : N extends 'remoteControl' ? P extends {operation:'pair'} ? {payload:string,qr:string,expiresAt:number} : P extends {operation:'networkPropose'} ? NetworkProposal : P extends {operation:'networkProposeScope'} ? NetworkProposal & {sourceScope?:'private'|'public',scope:'private'|'public'} : RemoteStatus : N extends 'serviceLifecycle' ? P extends {operation:'check'} ? import('./shared.cjs').LifecycleProjection : P extends {operation:'recover'} ? RecoveryResult : P extends {operation:'quitInterface'|'stopAndQuit'} ? QuitResult : P extends {operation:'update'} ? LifecycleResult|Canceled|RecoveryResult : LifecycleResult|Canceled : never} Response */
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
  if (name === "bugReport") return bugReport.isRequest(value);
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
  if (name === "hostInstallation")
    return (
      ["status", "install", "uninstall"].includes(String(value.operation)) &&
      only(value, ["operation"])
    );
  if (name === "hostUpdate") {
    if (["status", "check"].includes(String(value.operation))) return only(value, ["operation"]);
    return (
      ["prepare", "apply"].includes(String(value.operation)) &&
      typeof value.requestId === "string" &&
      /^[a-f0-9-]{36}$/i.test(value.requestId) &&
      typeof value.targetVersion === "string" &&
      /^[0-9][a-z0-9.-]{0,95}$/i.test(value.targetVersion) &&
      only(value, ["operation", "requestId", "targetVersion"])
    );
  }
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
    case "relayServiceStartLocal":
    case "relayServiceStopLocal":
    case "relayServiceUpgrade":
    case "relayServiceInspect":
    case "status":
    case "networkInspect":
    case "disable":
    case "enableDirect":
    case "disableDirect":
    case "cancelPair":
    case "forgetRevoked":
      return only(value, ["operation"]);
    case "relayUse":
      return typeof value.origin === "string" && only(value, ["operation", "origin"]);
    case "relayServiceDeploy": {
      if (
        typeof value.target !== "string" ||
        !/^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value.target) ||
        value.target.includes("..") ||
        !count(value.port) ||
        value.port < 1 ||
        value.port > 65535 ||
        typeof value.address !== "string" ||
        !only(value, ["operation", "target", "port", "address"])
      )
        return false;
      try {
        const origin = new URL(value.address);
        return (
          origin.protocol === "https:" &&
          origin.origin === value.address &&
          !origin.username &&
          !origin.password
        );
      } catch {
        return false;
      }
    }
    case "relayServiceRemove":
      return typeof value.removeData === "boolean" && only(value, ["operation", "removeData"]);
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
/** @param {unknown} value */
function relayServiceStatus(value) {
  return (
    modelRecord(value) &&
    only(value, ["local", "deployment", "job", "profiles"]) &&
    modelRecord(value.local) &&
    only(value.local, ["phase", "address", "error", "version"]) &&
    ["stopped", "starting", "running", "failed"].includes(String(value.local.phase)) &&
    ["address", "error", "version"].every(
      (key) => modelRecord(value.local) && typeof value.local[key] === "string",
    ) &&
    (value.deployment === null ||
      (modelRecord(value.deployment) &&
        only(value.deployment, [
          "target",
          "port",
          "address",
          "phase",
          "version",
          "active",
          "canReconfigure",
        ]) &&
        ["target", "address", "version"].every(
          (key) => modelRecord(value.deployment) && typeof value.deployment[key] === "string",
        ) &&
        count(value.deployment.port) &&
        typeof value.deployment.active === "boolean" &&
        (value.deployment.canReconfigure === undefined ||
          typeof value.deployment.canReconfigure === "boolean") &&
        ["pending", "ready", "failed", "removed"].includes(String(value.deployment.phase)))) &&
    (value.job === null ||
      (modelRecord(value.job) &&
        only(value.job, ["operation", "phase", "error"]) &&
        typeof value.job.operation === "string" &&
        typeof value.job.error === "string" &&
        ["running", "done", "failed", "unknown"].includes(String(value.job.phase)))) &&
    Array.isArray(value.profiles) &&
    value.profiles.every(
      (item) =>
        modelRecord(item) &&
        only(item, ["origin", "kind", "active"]) &&
        typeof item.origin === "string" &&
        typeof item.active === "boolean" &&
        ["local", "ssh", "external"].includes(String(item.kind)),
    )
  );
}
/** @param {unknown} value @returns {value is RemoteStatus} */
function isRemoteStatus(value) {
  return (
    modelRecord(value) &&
    (value.relayService === undefined || relayServiceStatus(value.relayService)) &&
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
    (isLifecycleReceipt(value.operation) ||
      (modelRecord(value.operation) &&
        value.operation.kind === "stopHost" &&
        lifecycleViewOperation(value.operation))) &&
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
/** @param {unknown} value @returns {value is HostUpdateReceipt} */
function hostUpdateReceipt(value) {
  return (
    modelRecord(value) &&
    value.version === 1 &&
    ["requestId", "hostId", "generation", "targetVersion"].every(
      (key) => typeof value[key] === "string",
    ) &&
    ["prepare", "apply"].includes(String(value.action)) &&
    [
      "acceptedPending",
      "prepared",
      "blocked",
      "partial",
      "settlementIncomplete",
      "admissionUnknown",
      "completed",
    ].includes(String(value.state)) &&
    (value.message === undefined || typeof value.message === "string")
  );
}
/** @param {Name} name @param {Record<string,unknown>} request @param {unknown} value */
function response(name, request, value) {
  if (name === "bugReport") return bugReport.isResponse(request, value);
  if (name === "hostInstallation")
    return (
      modelRecord(value) &&
      typeof value.installed === "boolean" &&
      (value.label === undefined || typeof value.label === "string")
    );
  if (name === "hostUpdate")
    return (
      modelRecord(value) &&
      typeof value.supported === "boolean" &&
      typeof value.restartPending === "boolean" &&
      (value.targetVersion === null || typeof value.targetVersion === "string") &&
      (value.prepareRequestId === null || typeof value.prepareRequestId === "string") &&
      (value.operation === null || hostUpdateReceipt(value.operation))
    );
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
  hostUpdateReceipt,
  isRequest,
  isRemoteRequest,
  validateResponse,
  isComputerStatus,
  readComputerStatus,
  isRemoteStatus,
};
