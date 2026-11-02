// @ts-check
"use strict";
const { executeCore } = require("./core-process.cjs");
/** @typedef {{kind:'stopHost',requestId:string,home:string,hostId:string,generation:string,strategy:'ifIdle'|'cancel'}} HostReference */
/** @typedef {{projectId:string,serviceId:string,serviceGeneration:string,requestId:string,dispatch:'notStarted'|'started',receipt?:{version:1,requestId:string,projectId:string,serviceId:string,serviceGeneration:string,strategy:'ifIdle'|'cancel',state:string,message?:string}}} HostTarget */
/** @typedef {{version:1,requestId:string,hostId:string,generation:string,strategy:'ifIdle'|'cancel',state:string,projects:HostTarget[]}} HostReceipt */
const states = new Set([
  "acceptedPending",
  "admissionUnknown",
  "blocked",
  "partial",
  "settlementIncomplete",
  "completed",
]);
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/** @param {unknown} value @returns {value is HostReference} */
function hostReference(value) {
  return (
    record(value) &&
    value.kind === "stopHost" &&
    uuid(value.requestId) &&
    uuid(value.hostId) &&
    uuid(value.generation) &&
    typeof value.home === "string" &&
    require("node:path").isAbsolute(value.home) &&
    (value.strategy === "ifIdle" || value.strategy === "cancel")
  );
}
/** @param {HostReference} reference @param {unknown} value @returns {HostReceipt} */
function readHostReceipt(reference, value) {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.requestId !== reference.requestId ||
    value.hostId !== reference.hostId ||
    value.generation !== reference.generation ||
    value.strategy !== reference.strategy ||
    !states.has(String(value.state)) ||
    !Array.isArray(value.projects) ||
    !value.projects.every((target) => {
      if (
        !record(target) ||
        !["projectId", "serviceId", "serviceGeneration", "requestId"].every(
          (key) => typeof target[key] === "string" && target[key],
        ) ||
        !["notStarted", "started"].includes(String(target.dispatch))
      )
        return false;
      if (target.receipt === undefined) return value.state !== "completed";
      const receipt = target.receipt;
      return (
        record(receipt) &&
        receipt.version === 1 &&
        receipt.requestId === target.requestId &&
        receipt.projectId === target.projectId &&
        receipt.serviceId === target.serviceId &&
        receipt.serviceGeneration === target.serviceGeneration &&
        receipt.strategy === reference.strategy &&
        states.has(String(receipt.state)) &&
        (receipt.message === undefined || typeof receipt.message === "string") &&
        (value.state !== "completed" ||
          (target.dispatch === "started" && receipt.state === "completed"))
      );
    })
  )
    throw Object.assign(new Error("Host 回执与原操作身份不一致"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
      submissionUnknown: true,
    });
  return /** @type {HostReceipt} */ (value);
}
/** @param {HostReference} reference @param {HostReceipt} [receipt] @returns {import('@areal/workbench/desktop-contract/shared').LifecycleViewOperation} */
function projectHostReceipt(reference, receipt) {
  const phase = (state = "admissionUnknown") =>
    state === "admissionUnknown" ? "admissionUnconfirmed" : state;
  return {
    requestId: reference.requestId,
    kind: "stopHost",
    phase: phase(receipt?.state),
    targets: (receipt?.projects ?? []).map((target) => ({
      projectId: target.projectId,
      phase: phase(target.receipt?.state),
      ...(target.receipt?.message ? { message: target.receipt.message } : {}),
    })),
  };
}
/** @param {string} binary @param {HostReference} reference */
async function readOfflineHostReceipt(binary, reference) {
  const { stdout } = await executeCore(
    binary,
    ["host", "operation", reference.requestId, "--json"],
    {
      env: {
        ...Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]]] : [],
          ),
        ),
        AREAL_HARNESS_HOME: reference.home,
      },
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
  const value = JSON.parse(stdout);
  if (!record(value) || !Object.hasOwn(value, "operation"))
    throw new Error("Host 原回执查询结果无效");
  return value.operation == null ? undefined : readHostReceipt(reference, value.operation);
}
module.exports = { hostReference, readHostReceipt, projectHostReceipt, readOfflineHostReceipt };
