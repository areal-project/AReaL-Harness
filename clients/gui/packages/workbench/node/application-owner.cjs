// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const { mkdirSync, realpathSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

/** @typedef {{kind:"gui",appRunId:string,profile:string}} ApplicationOwner */
/** @param {unknown} value @returns {ApplicationOwner} */
function parseOwner(value) {
  if (typeof value === "string") value = JSON.parse(value);
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "gui" ||
    !("appRunId" in value) ||
    typeof value.appRunId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.appRunId) ||
    !("profile" in value) ||
    typeof value.profile !== "string" ||
    !isAbsolute(value.profile) ||
    resolve(value.profile) !== value.profile
  )
    throw Object.assign(new Error("GUI 应用归属无效"), { code: "APPLICATION_OWNER_INVALID" });
  return { kind: "gui", appRunId: value.appRunId, profile: value.profile };
}
/** @param {string} profile */
function createOwner(profile) {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  return parseOwner({ kind: "gui", appRunId: randomUUID(), profile: realpathSync(profile) });
}
/** @param {unknown} left @param {unknown} right */
const sameOwner = (left, right) => !!left && !!right && isDeepStrictEqual(left, right);
function scrubOwnerEnvironment(environment = process.env) {
  const env = { ...environment };
  delete env.AREAL_GUI_OWNER;
  delete env.AREAL_GUI_LIFETIME_FD;
  delete env.AREAL_GUI_DESKTOP_LIFETIME_FD;
  return env;
}
module.exports = {
  parseOwner,
  createOwner,
  sameOwner,
  scrubOwnerEnvironment,
};
