// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { openSync, fstatSync, readSync, closeSync, constants } = require("node:fs");
const { normalizeNetworkSetting } = require("./desktop-network.cjs");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  readLibraryState,
  readLibraryRequest,
} = require("@areal/workbench/desktop-contract/library-media");
/** @typedef {{terminalInheritSystemProfile:boolean,terminalFontFamily:string,httpProxy:string,httpProxyNoProxy:string,httpProxyCaCertPath:string,hardwareAcceleration:boolean,taskNotifications:boolean}} StartupSettings */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").NavigationSummary} NavigationSummary */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryMetadata} LibraryMetadata */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryState} LibraryState */
/** @typedef {{home:string,saved:import('./project-index.cjs').SavedProject[],projects:Map<string,import('./project-state.cjs').CoreProject>,cloudConversations?:{owns:(projectId:string,threadId:string)=>boolean},worktrees?:{owners:(id:string)=>import('./project-index.cjs').SavedProject[]},start:(id:string)=>Promise<import('./project-state.cjs').CoreProject>,save:(name:string,value:unknown)=>Promise<unknown>,onChange:()=>void,hostCall:(call:string,params:unknown)=>Promise<unknown>}} LibraryHost */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").SidebarItem} SidebarItem */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryRequest} LibraryRequest */
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
/** @param {string} key @param {unknown} value */
function validateDesktopString(key, value) {
  if (key === "terminalFontFamily") {
    if (typeof value !== "string" || value.length > 256 || hasControlCharacters(value))
      throw new Error(
        "Terminal font must be no longer than 256 characters without control characters",
      );
    return value.trim();
  }
  return normalizeNetworkSetting(key, value);
}

/** 桌面整理偏好与可重建导航摘要；Core 继续拥有会话、执行和历史。 */
class CoreLibrary {
  /** @param {LibraryHost} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {LibraryState} */
    this.value = {
      projects: {},
      threads: {},
      projectOrder: [],
      sections: [],
      sidebarThreadOrder: [],
      sidebarRevision: 0,
      settings: {},
    };
    /** @type {Promise<unknown>} */
    this.writes = Promise.resolve();
    /** 切到 Host 单写时的写入口；未设置时 Main 自己写文件。 @type {{required?:boolean,write:(value:unknown,expectedDigest:string|null)=>Promise<string>}|null} */
    this.store = null;
    /** 最近一次读到或写入的文件内容摘要，交给 Host 做比较后替换。 @type {string|null} */
    this.digest = null;
  }
  async init() {
    await this.reload();
  }
  async reload() {
    const empty = {
      projects: {},
      threads: {},
      projectOrder: [],
      sections: [],
      sidebarThreadOrder: [],
      sidebarRevision: 0,
      settings: {},
    };
    let bytes;
    try {
      bytes = await readFile(join(this.backend.home, "library.json"));
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
      this.digest = null;
      return;
    }
    this.value = { ...empty, ...readLibraryState(JSON.parse(bytes.toString("utf8")), empty) };
    this.digest = createHash("sha256").update(bytes).digest("hex");
  }
  /**
   * 资料库改由 Host 单写（areal.oneProtocol.domains 含 library）。在写队列里切换，切换前先重读磁盘。
   * @param {{required?:boolean,write:(value:unknown,expectedDigest:string|null)=>Promise<string>}|null} store
   */
  useStore(store) {
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        if (store) await this.reload();
        this.store = store;
      });
    this.writes = task.catch(() => {});
    return task;
  }
  /** @param {(state:LibraryState)=>void} change */
  async change(change) {
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        const prepare = () => {
          const next = structuredClone(this.value);
          change(next);
          // Only layout/membership changes invalidate a held drag. Names, unread
          // state and activity timestamps continue to merge across GUI clients.
          if (sidebarLayout(next) !== sidebarLayout(this.value))
            next.sidebarRevision = (this.value.sidebarRevision ?? 0) + 1;
          return next;
        };
        let next = prepare();
        try {
          for (let attempt = 0; ; attempt++) {
            const patches = [];
            for (const key of new Set([...Object.keys(this.value.settings), ...Object.keys(next.settings)])) {
              if (JSON.stringify(this.value.settings[key]) !== JSON.stringify(next.settings[key]))
                patches.push({ path: ["settings", key], before: this.value.settings[key] ?? null, after: next.settings[key] ?? null });
            }
            for (const [id, value] of Object.entries(next.projects)) {
              for (const key of /** @type {const} */ (["worktreeEnvironments", "worktreeEnvironmentRevision"])) {
                if (JSON.stringify(this.value.projects[id]?.[key]) !== JSON.stringify(value[key]))
                  patches.push({ path: ["projects", id, key], before: this.value.projects[id]?.[key] ?? null, after: value[key] ?? null });
              }
            }
            try {
              next = readLibraryState(await this.backend.hostCall("library.patch", { patches }), this.value);
              break;
            } catch (error) {
              if (attempt >= 2 || !modelRecord(error) || error.code !== "conflict") throw error;
              await this.reload();
              next = prepare();
            }
          }
        } catch (error) {
          console.error("侧栏整理保存失败", error);
          throw Object.assign(
            new Error(error instanceof Error ? error.message : String(error), {
              cause: error,
            }),
            { code: "SIDEBAR_SAVE_FAILED" },
          );
        }
        this.value = next;
        this.backend.onChange();
        return next;
      });
    // The drain tracks completion, not an already reported validation failure.
    // Actual disk failures remain tracked by backend.saves and block shutdown.
    this.writes = task.catch(() => {});
    return task;
  }

  /** @param {unknown} input */
  async command(input) {
    const request = readLibraryRequest(input);
    const navigation = request.operation !== "settings" || ["sidebarSort", "sidebarSortChats", "sidebarSortProjects", "sidebarSortPinned", "showPinned", "showCompleted"].includes(request.key ?? "");
    if (navigation) {
      const result = await this.backend.hostCall("library.command", request);
      this.value = readLibraryState(result, this.value);
      this.backend.onChange();
      return this.value;
    }
    // 走到这里只剩非导航类偏好；导航与整理由 Host 的资料库负责。
    return this.change((state) => {
      if (typeof request.key !== "string") throw new Error("无效偏好设置");
      let settingValue = request.value;
      if (
        ["terminalFontFamily", "httpProxy", "httpProxyNoProxy", "httpProxyCaCertPath"].includes(
          request.key,
        )
      ) {
        if (typeof request.value !== "string") throw new Error("Invalid desktop setting");
        settingValue = validateDesktopString(request.key, request.value);
      } else if (request.key === "computerControlExecutable") {
        if (
          typeof request.value !== "string" ||
          request.value.length > 4096 ||
          request.value.includes("\0") ||
          (request.value && !require("node:path").isAbsolute(request.value))
        )
          throw new Error("LCU executable must be an absolute path");
      }
      Object.assign(state.settings, { [request.key]: settingValue });
    });
  }
}
/** @param {LibraryState} state */
function sidebarLayout(state) {
  /** @param {LibraryMetadata} meta */
  const placement = (meta) => [meta.pinned === true, meta.sectionId ?? null];
  return JSON.stringify([
    state.projectOrder,
    state.sidebarThreadOrder,
    state.sections.map((section) => section.id),
    Object.entries(state.projects).map(([id, meta]) => [
      id,
      placement(meta),
      meta.hidden === true,
      (meta.navigationSummaries ?? [])
        .map((thread) => ({ id: thread.id, archived: thread.desktop?.archived === true }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((thread) => [thread.id, thread.archived]),
    ]),
    Object.entries(state.threads)
      .filter(([, meta]) => meta.pinned || meta.sectionId)
      .map(([id, meta]) => [id, placement(meta)]),
    [
      "sidebarSort",
      "sidebarSortChats",
      "sidebarSortProjects",
      "sidebarSortPinned",
      "showPinned",
      "showCompleted",
    ].map((key) => state.settings[key]),
  ]);
}
module.exports = { CoreLibrary, readLibraryStartupSettings };

/** @param {string} value */
function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
