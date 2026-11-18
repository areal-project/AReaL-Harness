// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { hasControlCharacters } = require("@areal/workbench/node/library-startup");
const { normalizeNetworkSetting } = require("@areal/workbench/node/desktop-network");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  readLibraryState,
  readLibraryRequest,
} = require("@areal/workbench/desktop-contract/library-media");
/** @typedef {import("@areal/workbench/desktop-contract/library-media").NavigationSummary} NavigationSummary */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryMetadata} LibraryMetadata */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryState} LibraryState */
/** @typedef {{home:string,saved:import('./project-index.cjs').SavedProject[],projects:Map<string,import('./project-state.cjs').CoreProject>,worktrees?:{owners:(id:string)=>import('./project-index.cjs').SavedProject[]},start:(id:string)=>Promise<import('./project-state.cjs').CoreProject>,save:(name:string,value:unknown)=>Promise<unknown>,onChange:()=>void,hostCall:(call:string,params:unknown)=>Promise<unknown>}} LibraryHost */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").SidebarItem} SidebarItem */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryRequest} LibraryRequest */
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
      return;
    }
    this.value = { ...empty, ...readLibraryState(JSON.parse(bytes.toString("utf8")), empty) };
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
            for (const key of new Set([
              ...Object.keys(this.value.settings),
              ...Object.keys(next.settings),
            ])) {
              if (JSON.stringify(this.value.settings[key]) !== JSON.stringify(next.settings[key]))
                patches.push({
                  path: ["settings", key],
                  before: this.value.settings[key] ?? null,
                  after: next.settings[key] ?? null,
                });
            }
            for (const [id, value] of Object.entries(next.projects)) {
              for (const key of /** @type {const} */ ([
                "worktreeEnvironments",
                "worktreeEnvironmentRevision",
              ])) {
                if (JSON.stringify(this.value.projects[id]?.[key]) !== JSON.stringify(value[key]))
                  patches.push({
                    path: ["projects", id, key],
                    before: this.value.projects[id]?.[key] ?? null,
                    after: value[key] ?? null,
                  });
              }
            }
            try {
              next = readLibraryState(
                await this.backend.hostCall("library.patch", { patches }),
                this.value,
              );
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
    const navigation =
      request.operation !== "settings" ||
      [
        "sidebarSort",
        "sidebarSortChats",
        "sidebarSortProjects",
        "sidebarSortPinned",
        "showPinned",
        "showCompleted",
      ].includes(request.key ?? "");
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
module.exports = { CoreLibrary };
