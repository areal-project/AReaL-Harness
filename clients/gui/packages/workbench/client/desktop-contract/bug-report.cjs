// @ts-check
"use strict";
const { modelRecord } = require("./shared.cjs");
/** @typedef {{id:string,description:string,screenshots:string[],diagnosticsToken?:string}} Input */
/** @typedef {{operation:'prepare'|'list'}|{operation:'read'|'delete'|'export',id:string}|({operation:'save'} & Input)} Request */
/** @typedef {{id:string,createdAt:string,screenshotCount:number,hasDiagnostics:boolean}} Summary */
/** @typedef {{schemaVersion:1,id:string,createdAt:string,state:'local-only',description:string,screenshots:string[],diagnostics:string|null}} Report */
/** @typedef {{token?:string,diagnostics?:string,reports?:Summary[],report?:Report,id?:string,deleted?:boolean,canceled?:boolean,path?:string}} Response */
const uuid = (/** @type {unknown} */ v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
/** @param {unknown} v @returns {v is string[]} */
function images(v) {
  return (
    Array.isArray(v) &&
    v.length <= 5 &&
    v.every(
      (s) =>
        typeof s === "string" &&
        s.length <= 2800000 &&
        /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(s),
    )
  );
}
/** @param {unknown} v @returns {v is Request} */
function isRequest(v) {
  if (!modelRecord(v)) return false;
  const only = (/** @type {string[]} */ keys) => Object.keys(v).every((key) => keys.includes(key));
  if (v.operation === "prepare" || v.operation === "list") return only(["operation"]);
  if (["read", "delete", "export"].includes(String(v.operation)))
    return uuid(v.id) && only(["operation", "id"]);
  return (
    v.operation === "save" &&
    uuid(v.id) &&
    typeof v.description === "string" &&
    v.description.trim().length > 0 &&
    v.description.length <= 4000 &&
    images(v.screenshots) &&
    (v.diagnosticsToken === undefined || uuid(v.diagnosticsToken)) &&
    only(["operation", "id", "description", "screenshots", "diagnosticsToken"])
  );
}
/** @param {unknown} v @returns {v is Report} */
function report(v) {
  return (
    modelRecord(v) &&
    v.schemaVersion === 1 &&
    uuid(v.id) &&
    v.state === "local-only" &&
    typeof v.createdAt === "string" &&
    typeof v.description === "string" &&
    v.description.length <= 4000 &&
    images(v.screenshots) &&
    (v.diagnostics === null ||
      (typeof v.diagnostics === "string" && v.diagnostics.length <= 24 * 1024 * 1024))
  );
}
/** @param {Record<string,unknown>} request @param {unknown} v */
function isResponse(request, v) {
  if (!modelRecord(v)) return false;
  switch (request.operation) {
    case "prepare":
      return uuid(v.token) && typeof v.diagnostics === "string";
    case "list":
      return (
        Array.isArray(v.reports) &&
        v.reports.every(
          (r) =>
            modelRecord(r) &&
            uuid(r.id) &&
            typeof r.createdAt === "string" &&
            Number.isInteger(r.screenshotCount) &&
            typeof r.hasDiagnostics === "boolean",
        )
      );
    case "save":
      return v.id === request.id;
    case "read":
      return report(v.report) && v.report.id === request.id;
    case "delete":
      return v.deleted === true;
    case "export":
      return v.canceled === true || typeof v.path === "string";
    default:
      return false;
  }
}
module.exports = { isRequest, isResponse, report };
