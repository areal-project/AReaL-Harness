// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { openSync, fstatSync, readSync, closeSync, constants } = require("node:fs");
const { normalizeNetworkSetting } = require("./desktop-network.cjs");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { readObservationResult } = require("./history-contract.cjs");
const {
  readLibraryState,
  readLibraryRequest,
} = require("@areal/workbench/desktop-contract/library-media");
/** @typedef {{terminalInheritSystemProfile:boolean,terminalFontFamily:string,httpProxy:string,httpProxyNoProxy:string,httpProxyCaCertPath:string,hardwareAcceleration:boolean,taskNotifications:boolean}} StartupSettings */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").NavigationSummary} NavigationSummary */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryMetadata} LibraryMetadata */
/** @typedef {import("@areal/workbench/desktop-contract/library-media").LibraryState} LibraryState */
/** @typedef {{home:string,saved:import('./project-index.cjs').SavedProject[],projects:Map<string,import('./project-state.cjs').CoreProject>,cloudConversations?:{owns:(projectId:string,threadId:string)=>boolean},worktrees?:{owners:(id:string)=>import('./project-index.cjs').SavedProject[]},start:(id:string)=>Promise<import('./project-state.cjs').CoreProject>,save:(name:string,value:unknown)=>Promise<unknown>,onChange:()=>void}} LibraryHost */
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
  }
  async init() {
    try {
      this.value = {
        ...this.value,
        ...readLibraryState(
          JSON.parse(await readFile(join(this.backend.home, "library.json"), "utf8")),
          this.value,
        ),
      };
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  /** @param {(state:LibraryState)=>void} change */
  async change(change) {
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(this.value);
        change(next);
        // Only layout/membership changes invalidate a held drag. Names, unread
        // state and activity timestamps continue to merge across GUI clients.
        if (sidebarLayout(next) !== sidebarLayout(this.value))
          next.sidebarRevision = (this.value.sidebarRevision ?? 0) + 1;
        try {
          await this.backend.save("library.json", next);
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
  /** @param {string} projectId @param {string|undefined} threadId @param {string} [completionId] */
  async recordThreadActivity(projectId, threadId, completionId) {
    projectId =
      this.backend.saved.find((project) => project.id === projectId)?.logicalProjectId ?? projectId;
    if (!threadId) return;
    // Core timestamps have second precision; retain observed order only as a tie-break.
    return this.change((state) => {
      const project = (state.projects[projectId] ??= {});
      project.threadOrder = [
        threadId,
        ...(project.threadOrder ?? []).filter((id) => id !== threadId),
      ];
      if (completionId) {
        const meta = (state.threads[`${projectId}:${threadId}`] ??= {});
        if (meta.completionId !== completionId) {
          meta.completionId = completionId;
          meta.unread = true;
        }
      }
    });
  }
  /** @param {string} projectId @param {{id:string,status:string,threadId?:string|null}} run @param {string} [completionId] */
  async recordScheduledCompletion(projectId, run, completionId) {
    projectId =
      this.backend.saved.find((project) => project.id === projectId)?.logicalProjectId ?? projectId;
    if (
      !completionId ||
      !run.threadId ||
      run.status !== "completed" ||
      this.value.threads[`${projectId}:${run.threadId}`]?.scheduledCompletionId === run.id
    )
      return;
    return this.change((state) => {
      const meta = (state.threads[`${projectId}:${run.threadId}`] ??= {});
      if (meta.scheduledCompletionId === run.id) return;
      meta.scheduledCompletionId = run.id;
      // 只沿用同一最终 Turn 的阅读状态；较早一轮的已读不能遮蔽新的结果。
      if (meta.completionId !== completionId) {
        meta.completionId = completionId;
        meta.unread = true;
      }
    });
  }
  /** @param {string|undefined} projectId */
  threadSummaries(projectId) {
    if (projectId === undefined) return [];
    const owners =
      this.backend.worktrees?.owners(projectId) ??
      this.backend.saved.filter((project) => project.id === projectId);
    const data = owners.flatMap(
      /** @returns {Array<NavigationSummary|import('@areal/workbench/core-model-contract').CoreThread>} */ (
        owner,
      ) => {
        const live = this.backend.projects.get(owner.id);
        if (live?.summariesLoaded || live?.summaries?.length) return live.summaries;
        const cached = this.value.projects[owner.id]?.navigationSummaries;
        return Array.isArray(cached) ? cached : [];
      },
    );
    if (data.length) return data;
    const prefix = `${projectId}:`;
    return Object.keys(this.value.threads)
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ id: key.slice(prefix.length), preview: "未加载的任务" }));
  }

  /** @param {string} projectId @param {import('@areal/workbench/core-model-contract').CoreThread[]} summaries */
  async recordThreadSummaries(projectId, summaries) {
    // Deliberate whitelist: thread/list also carries configuration, permissions,
    // receipts and other execution state, none of which belongs in this cache.
    const navigationSummaries = summaries.map((summary) => ({
      id: summary.id,
      ...(typeof summary.parentThreadId === "string"
        ? { parentThreadId: summary.parentThreadId }
        : {}),
      ...(typeof summary.conversation?.kind === "string"
        ? { conversation: { kind: summary.conversation.kind } }
        : {}),
      ...(typeof summary.name === "string" ? { name: summary.name } : {}),
      ...(typeof summary.preview === "string" ? { preview: summary.preview } : {}),
      ...(typeof summary.createdAt === "number" && Number.isFinite(summary.createdAt)
        ? { createdAt: summary.createdAt }
        : {}),
      ...(typeof summary.updatedAt === "number" && Number.isFinite(summary.updatedAt)
        ? { updatedAt: summary.updatedAt }
        : {}),
      desktop: { archived: summary.desktop?.archived === true },
    }));
    return this.change((state) => {
      (state.projects[projectId] ??= {}).navigationSummaries = navigationSummaries;
    });
  }
  /** @param {unknown} input */
  async command(input) {
    const request = readLibraryRequest(input);
    const { operation, projectId, threadId, title, before } = request;
    const global = [
      "settings",
      "createSection",
      "renameSection",
      "removeSection",
      "orderSection",
      "markAllRead",
      "dropSidebar",
    ].includes(operation);
    if (
      !global &&
      (typeof projectId !== "string" || !this.backend.saved.some((item) => item.id === projectId))
    )
      throw new Error("未知工作区");
    if (
      [
        "renameThread",
        "pinThread",
        "orderThread",
        "moveThread",
        "readThread",
        "orderSidebarThread",
      ].includes(operation) &&
      (typeof projectId !== "string" ||
        typeof threadId !== "string" ||
        (!this.threadSummaries(projectId).some((item) => item.id === threadId) &&
          !(
            operation === "readThread" &&
            (this.backend.projects.get(projectId)?.model.state.threads?.[threadId] ||
              this.backend.cloudConversations?.owns(projectId, threadId))
          )))
    )
      throw new Error("未知会话");
    if (operation === "hideProject" && request.hidden && projectId) {
      const owners =
        this.backend.worktrees?.owners(projectId) ??
        this.backend.saved.filter((project) => project.id === projectId);
      for (const owner of owners) {
        const live = await this.backend.start(owner.id);
        for (const summary of live.summaries) {
          if (!live.client) throw new Error("Core 连接不可用");
          const { thread } = await live.client.request(
            "thread/read",
            { threadId: summary.id, includeTurns: true },
            { decode: readObservationResult },
          );
          if (
            thread.turns?.some((turn) => turn.status === "inProgress") ||
            thread.desktop?.queue?.items?.some(
              (item) => modelRecord(item) && ["pending", "running"].includes(String(item.status)),
            )
          )
            throw new Error("工作区仍有活动任务或排队消息，请先处理后再移出侧边栏");
        }
        if (
          live.pending.length ||
          Object.values(live.model.state.threads ?? {}).some((thread) =>
            thread.turns?.some((turn) => turn.status === "inProgress"),
          ) ||
          Object.values(live.model.state.queues ?? {}).some((queue) =>
            queue.items.some(
              (item) => modelRecord(item) && ["pending", "running"].includes(String(item.status)),
            ),
          )
        )
          throw new Error("工作区仍有活动任务或排队消息，请先处理后再移出侧边栏");
      }
    }
    return this.change((state) => {
      /** @type {LibraryMetadata} */
      const project = projectId ? (state.projects[projectId] ??= {}) : {};
      const key = `${projectId}:${threadId}`;
      const section = state.sections.find((item) => item.id === request.sectionId);
      if (["renameSection", "removeSection", "orderSection"].includes(operation) && !section)
        throw new Error("分组已不存在，请刷新");
      if (
        ["moveThread", "moveProject"].includes(operation) &&
        request.sectionId != null &&
        !section
      )
        throw new Error("分组已不存在，请刷新");
      switch (operation) {
        case "dropSidebar":
          this.dropSidebar(state, request);
          break;
        case "renameProject":
          project.title = requireTitle(title);
          break;
        case "renameThread":
          (state.threads[key] ??= {}).title = requireTitle(title);
          break;
        case "pinThread": {
          const meta = (state.threads[key] ??= {});
          meta.pinned = request.pinned === true;
          if (meta.pinned) delete meta.sectionId;
          break;
        }
        case "pinProject": {
          project.pinned = request.pinned === true;
          if (project.pinned) delete project.sectionId;
          break;
        }
        case "createSection":
          state.sections.push({ id: randomUUID(), title: requireTitle(title) });
          break;
        case "renameSection":
          if (!section) throw new Error("分组已不存在，请刷新");
          section.title = requireTitle(title);
          break;
        case "removeSection": {
          if (!section) throw new Error("分组已不存在，请刷新");
          state.sections = state.sections.filter((item) => item.id !== section.id);
          for (const meta of [...Object.values(state.projects), ...Object.values(state.threads)]) {
            if (meta.sectionId === section.id) delete meta.sectionId;
          }
          break;
        }
        case "orderSection": {
          if (!section) throw new Error("分组已不存在，请刷新");
          const ids = state.sections.map((item) => item.id);
          const order = reorder(ids, ids, section.id, before);
          state.sections.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
          break;
        }
        case "moveThread": {
          const meta = (state.threads[key] ??= {});
          meta.sectionId = request.sectionId ?? null;
          meta.pinned = false;
          break;
        }
        case "moveProject": {
          project.sectionId = request.sectionId ?? null;
          project.pinned = false;
          break;
        }
        case "readThread": {
          if (typeof request.read !== "boolean") throw new Error("无效已读状态");
          if (
            request.read &&
            request.completionId !== undefined &&
            request.completionId !== state.threads[key]?.completionId
          )
            break;
          (state.threads[key] ??= {}).unread = !request.read;
          break;
        }
        case "markAllRead":
          for (const meta of Object.values(state.threads)) meta.unread = false;
          break;
        case "orderSidebarThread": {
          // Unopened projects may not have summaries in this service lifetime.
          // Their persisted ordering is not evidence that their Threads vanished.
          const available = [
            ...new Set([
              ...state.sidebarThreadOrder,
              ...this.backend.saved.flatMap((owner) =>
                this.threadSummaries(owner.id).map((item) => `${owner.id}:${item.id}`),
              ),
            ]),
          ];
          /** @param {string} id */
          const bucket = (id) => {
            const meta = state.threads[id];
            const owner = id.slice(0, id.lastIndexOf(":"));
            return meta?.pinned
              ? "pinned"
              : this.backend.saved.find((p) => p.id === owner)?.projectless
                ? "chats"
                : owner;
          };
          if (before != null && bucket(before) !== bucket(key))
            throw new Error("排序位置已变化，请刷新");
          state.sidebarThreadOrder = reorder(state.sidebarThreadOrder, available, key, before);
          const meta = state.threads[key];
          state.settings[
            meta?.pinned
              ? "sidebarSortPinned"
              : this.backend.saved.find((p) => p.id === projectId)?.projectless
                ? "sidebarSortChats"
                : "sidebarSortProjects"
          ] = "manual";
          break;
        }
        case "hideProject":
          project.hidden = request.hidden === true;
          break;
        case "orderProject": {
          const ids = this.backend.saved.map((item) => item.id);
          state.projectOrder = reorder(state.projectOrder, ids, requireId(projectId), before);
          break;
        }
        case "orderThread": {
          const ids = this.threadSummaries(projectId).map((item) => item.id);
          project.threadOrder = reorder(
            project.threadOrder ?? [],
            ids,
            requireId(threadId),
            before,
          );
          break;
        }
        case "settings": {
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
          if (
            [
              "sidebarSort",
              "sidebarSortChats",
              "sidebarSortProjects",
              "sidebarSortPinned",
            ].includes(request.key) &&
            request.value === "manual" &&
            !state.sidebarThreadOrder.length
          ) {
            const available = this.backend.saved.flatMap((owner) =>
              this.threadSummaries(owner.id).map((item) => `${owner.id}:${item.id}`),
            );
            if (
              !Array.isArray(request.order) ||
              request.order.some((id) => !available.includes(id)) ||
              new Set(request.order).size !== request.order.length
            )
              throw new Error("排序列表已变化，请刷新");
            state.sidebarThreadOrder = [
              ...request.order,
              ...available.filter((id) => !request.order?.includes(id)),
            ];
          }
          Object.assign(state.settings, { [request.key]: settingValue });
          break;
        }
        default:
          throw new Error("不支持的整理操作");
      }
    });
  }
  /** @param {LibraryState} state @param {LibraryRequest} request */
  dropSidebar(state, { source, target, anchor = null, edge, order = [], expectedSidebarRevision }) {
    const changed = () => {
      throw new Error("整理位置已变化，请刷新后重试");
    };
    if (
      !Number.isSafeInteger(expectedSidebarRevision) ||
      expectedSidebarRevision !== (state.sidebarRevision ?? 0)
    )
      return changed();
    /** @param {string[]} ids @param {string} id @param {string} targetId */
    const around = (ids, id, targetId) => {
      if (!ids.includes(targetId) || id === targetId || (edge !== "before" && edge !== "after"))
        return changed();
      const others = ids.filter((value) => value !== id),
        index = others.indexOf(targetId);
      others.splice(index + (edge === "after" ? 1 : 0), 0, id);
      return others;
    };
    if (source?.type === "section") {
      const ids = state.sections.map((item) => item.id);
      if (
        typeof source.id !== "string" ||
        !ids.includes(source.id) ||
        target?.type !== "section" ||
        typeof target.id !== "string"
      )
        return changed();
      const next = around(ids, source.id, target.id);
      state.sections.sort((a, b) => next.indexOf(a.id) - next.indexOf(b.id));
      return;
    }
    if (
      !source ||
      (source.type !== "thread" && source.type !== "project") ||
      typeof source.id !== "string"
    )
      return changed();
    const thread = source.type === "thread";
    const available = thread
      ? this.backend.saved.flatMap((owner) =>
          this.threadSummaries(owner.id).map((item) => `${owner.id}:${item.id}`),
        )
      : this.backend.saved.map((owner) => owner.id);
    const key = thread ? `${source.projectId}:${source.id}` : source.id;
    if (!available.includes(key)) return changed();
    const metadata = thread ? state.threads : state.projects;
    /** @param {string} id */
    const projectless = (id) =>
      this.backend.saved.find((p) => p.id === id.slice(0, id.lastIndexOf(":")))?.projectless ===
      true;
    /** @param {string} id */
    const group = (id) =>
      metadata[id]?.pinned
        ? "pinned"
        : metadata[id]?.sectionId
          ? `section:${metadata[id].sectionId}`
          : thread
            ? projectless(id)
              ? "chats"
              : `project:${id.slice(0, id.lastIndexOf(":"))}`
            : "projects";
    if (group(key) !== source.group) return changed();
    let destination;
    if (target?.type === "section" && state.sections.some((item) => item.id === target.id))
      destination = `section:${target.id}`;
    else if (target?.type === "pinned") destination = "pinned";
    else if (thread && target?.type === "chats" && projectless(key)) destination = "chats";
    else if (
      thread &&
      !projectless(key) &&
      target?.type === "project" &&
      target.id === source.projectId
    )
      destination = `project:${source.projectId}`;
    else if (!thread && target?.type === "projects") destination = "projects";
    else return changed();
    // Membership, anchor validation, ordering and preference are one Library
    // transaction. A failed/stale drop cannot leave a half-completed move.
    const meta = (metadata[key] ??= {});
    meta.pinned = destination === "pinned";
    meta.sectionId = target.type === "section" ? target.id : null;
    const members = available.filter((id) => group(id) === destination);
    if (
      !Array.isArray(order) ||
      new Set(order).size !== order.length ||
      order.some((id) => !members.includes(id))
    )
      return changed();
    if (anchor !== null && (!members.includes(anchor) || anchor === key)) return changed();
    const field = thread ? "sidebarThreadOrder" : "projectOrder";
    const existing = state[field] ?? [];
    const seed = [
      ...new Set([...order, ...existing.filter((id) => members.includes(id)), ...members]),
    ];
    const next =
      anchor === null ? [...seed.filter((id) => id !== key), key] : around(seed, key, anchor);
    state[field] = [...existing.filter((id) => !members.includes(id)), ...next];
    if (thread)
      state.settings[
        destination === "pinned"
          ? "sidebarSortPinned"
          : target.type === "section" || target.type === "chats"
            ? "sidebarSortChats"
            : "sidebarSortProjects"
      ] = "manual";
    else if (destination === "pinned") state.settings.sidebarSortPinned = "manual";
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
/** @param {string[]} current @param {string[]} available @param {string} id @param {string|null|undefined} before */
function reorder(current, available, id, before) {
  if (before != null && !available.includes(before)) throw new Error("排序位置已变化，请刷新");
  const ids = [...new Set([...current, ...available])].filter(
    (value) => value !== id && available.includes(value),
  );
  if (before === id) return [...new Set([...current, ...available])];
  ids.splice(before == null ? ids.length : ids.indexOf(before), 0, id);
  return ids;
}
/** @param {unknown} value */
function requireTitle(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("名称需要 1–200 个字符");
  return value.trim();
}
/** @param {unknown} value */
function requireId(value) {
  if (typeof value !== "string") throw new Error("未知工作区或会话");
  return value;
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
