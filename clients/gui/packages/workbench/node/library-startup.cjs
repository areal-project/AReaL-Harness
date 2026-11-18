// @ts-check
"use strict";
const { join } = require("node:path");
const { openSync, fstatSync, readSync, closeSync, constants } = require("node:fs");
const { modelRecord } = require("@areal/workbench/core-model-contract");

/** @typedef {{terminalInheritSystemProfile:boolean,terminalFontFamily:string,httpProxy:string,httpProxyNoProxy:string,httpProxyCaCertPath:string,hardwareAcceleration:boolean,taskNotifications:boolean}} StartupSettings */
const DESKTOP_SETTING_DEFAULTS = Object.freeze({
  terminalInheritSystemProfile: true,
  terminalFontFamily: "",
  httpProxy: "",
  httpProxyNoProxy: "",
  httpProxyCaCertPath: "",
  hardwareAcceleration: true,
  taskNotifications: true,
});

/** @param {string} home @returns {StartupSettings} */
function readLibraryStartupSettings(home) {
  let fd;
  try {
    fd = openSync(join(home, "library.json"), constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (modelRecord(error) && error.code === "ENOENT") return { ...DESKTOP_SETTING_DEFAULTS };
    throw error;
  }
  try {
    const maximum = 8 * 1024 * 1024,
      stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum)
      throw new Error("Desktop library must be a regular file no larger than 8 MiB");
    const bytes = Buffer.alloc(maximum + 1),
      length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maximum) throw new Error("Desktop library exceeds 8 MiB");
    /** @type {unknown} */
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!modelRecord(value) || (value.settings !== undefined && !modelRecord(value.settings)))
      throw new Error("Invalid desktop library settings");
    const settings = modelRecord(value.settings) ? value.settings : {};
    /** @overload @param {string} key @param {string} fallback @returns {string} */
    /** @overload @param {string} key @param {boolean} fallback @returns {boolean} */
    /** @param {string} key @param {string|boolean} fallback */
    function setting(key, fallback) {
      const value = settings[key];
      if (value === undefined) return fallback;
      if (
        typeof value !== typeof fallback ||
        (typeof value !== "string" && typeof value !== "boolean")
      )
        throw new Error(`Invalid desktop setting ${key}`);
      if (
        typeof value === "string" &&
        (value.length > (key === "terminalFontFamily" ? 256 : 4096) || hasControlCharacters(value))
      )
        throw new Error(`Invalid desktop setting ${key}`);
      return typeof value === "string" ? value.trim() : value;
    }
    return {
      terminalInheritSystemProfile: setting(
        "terminalInheritSystemProfile",
        DESKTOP_SETTING_DEFAULTS.terminalInheritSystemProfile,
      ),
      terminalFontFamily: setting(
        "terminalFontFamily",
        DESKTOP_SETTING_DEFAULTS.terminalFontFamily,
      ),
      httpProxy: setting("httpProxy", DESKTOP_SETTING_DEFAULTS.httpProxy),
      httpProxyNoProxy: setting("httpProxyNoProxy", DESKTOP_SETTING_DEFAULTS.httpProxyNoProxy),
      httpProxyCaCertPath: setting(
        "httpProxyCaCertPath",
        DESKTOP_SETTING_DEFAULTS.httpProxyCaCertPath,
      ),
      hardwareAcceleration: setting(
        "hardwareAcceleration",
        DESKTOP_SETTING_DEFAULTS.hardwareAcceleration,
      ),
      taskNotifications: setting("taskNotifications", DESKTOP_SETTING_DEFAULTS.taskNotifications),
    };
  } finally {
    closeSync(fd);
  }
}
/** @param {string} value */
function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

module.exports = { readLibraryStartupSettings, hasControlCharacters };
