// @ts-check
"use strict";
const { isDesktopSnapshot } = require("@areal/workbench/desktop-contract/shared");
const { sameOwner } = require("@areal/workbench-service/desktop/core/application-owner.cjs");

/** @typedef {import('@areal/workbench/desktop-contract/shared').ServiceThread} ServiceThread */
/** @typedef {import('@areal/workbench/desktop-contract/shared').ServiceProject} ServiceProject */
/** @typedef {import('@areal/workbench/desktop-contract/shared').DesktopSnapshot} ServiceSnapshot */
/** @typedef {{connected:true,busy:boolean,providerUpdating:boolean,clients:number,activeCommands:number,starting:number,pid:number,applicationOwner?:unknown,selectedThreadObservation?:boolean,browserCore?:Record<string,string|null>,browserControlEndpoints?:string[],[key:string]:unknown}} ServiceState */
/** @typedef {{sequence:number,snapshot:ServiceSnapshot,service:ServiceState,[key:string]:unknown}} ServicePacket */

/** @type {(packet:unknown,metadata:unknown)=>asserts packet is ServicePacket} */
const validateServicePacket = (packet, metadata) => {
  if (!servicePacket(packet, metadata)) {
    throw Object.assign(
      new Error("后台服务快照不受支持，原后台保持运行。请安全重启后使用本次配置。"),
      { code: "SERVICE_SNAPSHOT_INVALID" },
    );
  }
};
/** @param {unknown} packet @param {unknown} metadata @returns {packet is ServicePacket} */
function servicePacket(packet, metadata) {
  if (!record(packet) || !record(metadata)) return false;
  const snapshot = packet.snapshot,
    service = packet.service;
  if (!record(snapshot) || !record(snapshot.library) || !record(service)) return false;
  return (
    count(packet.sequence) &&
    isDesktopSnapshot(snapshot) &&
    (service.browserCore === undefined ||
      (record(service.browserCore) &&
        Object.values(service.browserCore).every(
          (value) => value === null || typeof value === "string",
        ))) &&
    (service.browserControlEndpoints === undefined ||
      (Array.isArray(service.browserControlEndpoints) &&
        service.browserControlEndpoints.every((value) => typeof value === "string"))) &&
    (service.selectedThreadObservation === undefined ||
      typeof service.selectedThreadObservation === "boolean") &&
    service.connected === true &&
    typeof service.busy === "boolean" &&
    typeof service.providerUpdating === "boolean" &&
    count(service.clients) &&
    count(service.activeCommands) &&
    count(service.starting) &&
    typeof service.pid === "number" &&
    Number.isSafeInteger(service.pid) &&
    service.pid > 1 &&
    service.pid === metadata.pid &&
    ((metadata.applicationOwner === undefined && service.applicationOwner === undefined) ||
      sameOwner(metadata.applicationOwner, service.applicationOwner))
  );
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} packet @param {unknown} metadata @returns {ServicePacket} */
function readServicePacket(packet, metadata) {
  validateServicePacket(packet, metadata);
  return packet;
}

/** @typedef {{projects:(import('@areal/workbench-service/desktop/core/gen-ui-state.cjs').GenUiProject & {outcomes?:unknown})[],library:{projects:Record<string,unknown>}}} PageSnapshot */
/** @param {PageSnapshot} snapshot @param {string} projectId @param {string} threadId */
function ownsThread(snapshot, projectId, threadId) {
  const project = snapshot.library.projects[projectId];
  if (record(project) && project.hidden) return false;
  const state = snapshot.projects.find((p) => p.id === projectId)?.state;
  const thread = record(state) && record(state.threads) ? state.threads[threadId] : undefined;
  return record(thread) && !(record(thread.desktop) && thread.desktop.archived);
}
/** @param {PageSnapshot} snapshot @param {string} projectId @param {string} threadId */
function retainsThreadResources(snapshot, projectId, threadId) {
  const project = snapshot.projects.find((project) => project.id === projectId);
  const state = project?.state;
  const thread = record(state) && record(state.threads) ? state.threads[threadId] : undefined;
  if (
    !record(thread) ||
    !record(thread.conversation) ||
    !record(thread.conversation.policy) ||
    thread.conversation.policy.kind !== "sideExecutableV2" ||
    !record(thread.desktop) ||
    thread.desktop.archived !== true
  )
    return false;
  return !Object.values(record(project?.outcomes) ? project.outcomes : {}).some(
    (outcome) =>
      record(outcome) &&
      outcome.method === "areal/side/close" &&
      outcome.threadId === threadId &&
      outcome.accepted === true &&
      outcome.cleanupConfirmed === true,
  );
}

module.exports = { validateServicePacket, readServicePacket, ownsThread, retainsThreadResources };
