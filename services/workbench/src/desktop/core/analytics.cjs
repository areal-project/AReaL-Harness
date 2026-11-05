// @ts-check
"use strict";
const catalogContract = require("@areal/workbench/desktop-contract/catalog");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const WebSocket = require("ws");
const { modelRecord, isCoreItem } = require("@areal/workbench/core-model-contract");
const { readObservationResult } = require("./history-contract.cjs");
/** @typedef {{inputTokens:number,outputTokens:number,cachedInputTokens:number}} Usage */
/** @typedef {{date:string|null,usage?:Usage}} TurnUsage */
/** @typedef {{name:string,date:string|null}} SkillUsage */
/** @typedef {{version:number,since:number,days:Record<string,number>,turns:Record<string,TurnUsage>,skills:Record<string,SkillUsage>}} AnalyticsState */
/** @typedef {{home:string,projects:Map<string,import('./project-state.cjs').CoreProject>,closing:boolean,save:(name:string,value:unknown)=>Promise<unknown>}} AnalyticsHost */
/** @param {number|string|Date} time */
const dayKey = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** @param {unknown} n */
const count = (n) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0);
/** @param {Usage} usage */
const total = (usage) => count(usage?.inputTokens) + count(usage?.outputTokens);

// A local, replaceable projection of Core reports. No prompts, arguments, credentials or file paths.
class UsageAnalytics {
  /** @param {AnalyticsHost} backend @param {()=>number} [now] */
  constructor(backend, now = Date.now) {
    this.backend = backend;
    this.now = now;
    /** @type {AnalyticsState} */
    this.value = { version: 1, since: now(), days: {}, turns: {}, skills: {} };
    this.revision = 0;
    this.savedRevision = 0;
    /** @type {string|null} */
    this.error = null;
    /** @type {Map<string,string>} */
    this.syncErrors = new Map();
    /** @type {Map<string,Promise<void>>} */
    this.syncing = new Map();
    /** @type {{time:number,active:boolean}|null} */
    this.previous = null;
  }
  async init() {
    try {
      /** @type {unknown} */
      const value = JSON.parse(await readFile(join(this.backend.home, "analytics.json"), "utf8"));
      if (!isAnalyticsState(value)) throw new Error("不支持的使用统计格式");
      this.value = value;
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") {
        this.error = "使用统计无法读取，已停止写入以保留原文件。";
        this.readOnly = true;
      }
    }
  }
  changed() {
    this.revision++;
  }
  /** @param {{time?:number,focused:boolean,idleSeconds?:number,suspended?:boolean}} sample */
  sample({ time = this.now(), focused, idleSeconds = 0, suspended = false }) {
    const previous = this.previous;
    this.previous = { time, active: focused && !suspended };
    // Do not bridge sleep, delayed timers, wall-clock changes, or unfocused intervals.
    if (!previous?.active || time <= previous.time || time - previous.time > 15000) return;
    const end = Math.min(time, time - Math.max(0, idleSeconds - 300) * 1000);
    let start = previous.time;
    while (start < end) {
      const d = new Date(start);
      const key = dayKey(start);
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const next = Math.min(midnight, end);
      this.value.days[key] = (this.value.days[key] ?? 0) + next - start;
      start = next;
      this.changed();
    }
  }
  /** @template T @param {Record<string,T>} collection @param {string} key @param {T} value */
  setEntry(collection, key, value) {
    if (JSON.stringify(collection[key]) !== JSON.stringify(value)) {
      collection[key] = value;
      this.changed();
    }
  }
  /** @param {string} projectId @param {string|undefined} threadId @param {import("@areal/workbench/core-model-contract").CoreTurn|undefined} turn @param {string|null} [date] */
  recordTurn(projectId, threadId, turn, date = null) {
    if (!turn?.id || !threadId) return;
    const key = JSON.stringify([projectId, threadId, turn.id]);
    const old = this.value.turns[key];
    const usage = modelRecord(turn.usage) ? turn.usage : undefined;
    if (usage || date || old)
      this.setEntry(this.value.turns, key, {
        date: old ? old.date : date,
        ...(old?.usage ? { usage: old.usage } : {}),
        ...(usage
          ? {
              usage: {
                inputTokens: count(usage.inputTokens),
                outputTokens: count(usage.outputTokens),
                cachedInputTokens: count(usage.cachedInputTokens),
              },
            }
          : {}),
      });
    for (const item of turn.items ?? []) this.recordSkill(projectId, threadId, turn.id, item, date);
  }
  /** @param {string} projectId @param {string|undefined} threadId @param {string|undefined} turnId @param {import("@areal/workbench/core-model-contract").CoreItem|undefined} item @param {string|null} [date] */
  recordSkill(projectId, threadId, turnId, item, date = null) {
    if (
      !item?.id ||
      !turnId ||
      !threadId ||
      item?.type !== "dynamicToolCall" ||
      item.tool !== "skill_read" ||
      item.status !== "completed" ||
      item.success !== true
    )
      return;
    const args = item.arguments;
    if (
      !modelRecord(args) ||
      !modelRecord(args.skill) ||
      typeof args.skill.id !== "string" ||
      (args.resource ?? "SKILL.md") !== "SKILL.md" ||
      (args.offset ?? 0) !== 0
    )
      return;
    const key = JSON.stringify([projectId, threadId, turnId, item.id]);
    this.setEntry(this.value.skills, key, {
      name: args.skill.id,
      date: this.value.skills[key] ? this.value.skills[key].date : date,
    });
  }
  /** @param {string} projectId @param {string} method @param {import("./history-contract.cjs").HistoryNotification} params */
  observe(projectId, method, params) {
    const today = dayKey(this.now());
    if (method === "turn/started") this.recordTurn(projectId, params.threadId, params.turn, today);
    if (method === "turn/completed")
      this.recordTurn(projectId, params.threadId, params.turn, today);
    if (method === "item/completed")
      this.recordSkill(
        projectId,
        params.threadId,
        params.turnId,
        isCoreItem(params.item) ? params.item : undefined,
        today,
      );
  }
  /** @param {string} projectId @param {import("@areal/workbench/core-model-contract").CoreThread} thread */
  ingest(projectId, thread) {
    for (const turn of thread?.turns ?? []) this.recordTurn(projectId, thread.id, turn);
  }
  /** @param {import("./project-state.cjs").CoreProject} project */
  async syncProject(project) {
    if (this.syncing.has(project.id)) return this.syncing.get(project.id);
    const primary = project.client;
    const { endpoint, token } = project;
    const serviceId = project.service?.serviceId;
    const generation = project.service?.generation;
    const summaries = (project.summaries ?? []).map((summary) => summary.id);
    /** @type {import("@areal/runtime-client/core").CoreClient|undefined} */
    let reader;
    let primaryClosed = false;
    const ownsIdentity = () =>
      this.backend.projects.get(project.id) === project &&
      project.client === primary &&
      project.endpoint === endpoint &&
      project.token === token &&
      project.service?.serviceId === serviceId &&
      project.service?.generation === generation;
    const current = () =>
      ownsIdentity() &&
      !primaryClosed &&
      !this.backend.closing &&
      primary?.ready &&
      !primary.closed;
    const requireCurrent = () => {
      if (!current()) throw new Error("历史同步中断");
    };
    // 主连接关闭必须覆盖模块加载与握手等待，只释放本次统计读取连接。
    const removeClose = primary?.onClose(() => {
      primaryClosed = true;
      reader?.close();
    });
    const task = (async () => {
      try {
        requireCurrent();
        const { CoreClient, MAX_RESPONSE_BYTES } = await import("@areal/runtime-client/core");
        requireCurrent();
        if (!endpoint) throw new Error("历史同步中断");
        reader = new CoreClient({
          createSocket: () =>
            new WebSocket(endpoint, {
              headers: { Authorization: `Bearer ${token}` },
              followRedirects: false,
              maxPayload: MAX_RESPONSE_BYTES,
            }),
        });
        await reader.connect();
        requireCurrent();
        // 独立连接只读取历史，不订阅、恢复或执行历史任务。
        for (const threadId of summaries) {
          requireCurrent();
          const { thread } = await reader.request(
            "thread/read",
            {
              threadId,
              includeTurns: true,
            },
            { decode: readObservationResult },
          );
          requireCurrent();
          this.ingest(project.id, thread);
        }
        requireCurrent();
        this.syncErrors.delete(project.id);
      } catch {
        if (ownsIdentity()) this.syncErrors.set(project.id, "部分历史尚未同步，连接工作区后重试。");
      } finally {
        removeClose?.();
        reader?.close();
      }
      await this.flush();
    })().finally(() => this.syncing.delete(project.id));
    this.syncing.set(project.id, task);
    return task;
  }
  async flush() {
    if (this.readOnly || this.savedRevision === this.revision) return;
    const revision = this.revision;
    try {
      await this.backend.save("analytics.json", this.value);
      this.savedRevision = Math.max(this.savedRevision, revision);
      this.error = null;
    } catch {
      this.error = "使用统计保存失败，当前数据尚未持久化。";
    }
  }
  /** @returns {import("@areal/workbench/desktop-contract/catalog").AnalyticsSummary} */
  summary() {
    const days = Object.fromEntries(
      Object.entries(this.value.days).map(([date, activeMs]) => [
        date,
        { activeMs, tokens: 0, skillCalls: 0 },
      ]),
    );
    /** @param {string} date */
    const day = (date) => (days[date] ??= { activeMs: 0, tokens: 0, skillCalls: 0 });
    let tokens = 0,
      undatedTokens = 0,
      reportedTurns = 0;
    for (const turn of Object.values(this.value.turns))
      if (turn.usage) {
        const n = total(turn.usage);
        tokens += n;
        reportedTurns++;
        if (turn.date) day(turn.date).tokens += n;
        else undatedTokens += n;
      }
    /** @type {Map<string,number>} */
    const ranking = new Map();
    let undatedSkills = 0;
    for (const skill of Object.values(this.value.skills)) {
      ranking.set(skill.name, (ranking.get(skill.name) ?? 0) + 1);
      if (skill.date) day(skill.date).skillCalls++;
      else undatedSkills++;
    }
    const today = dayKey(this.now());
    const yesterday = new Date(this.now());
    yesterday.setDate(yesterday.getDate() - 1);
    const activeDays = Object.keys(this.value.days)
      .filter((date) => this.value.days[date] > 0)
      .sort();
    let longestStreak = 0,
      run = 0,
      last;
    for (const date of activeDays) {
      const before = new Date(date + "T12:00:00");
      before.setDate(before.getDate() - 1);
      run = last === dayKey(before) ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      last = date;
    }
    let streak = 0;
    const cursor = new Date(this.now());
    if (!(days[today]?.activeMs > 0)) cursor.setDate(cursor.getDate() - 1);
    while (days[dayKey(cursor)]?.activeMs > 0) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return {
      since: this.value.since,
      today,
      yesterday: dayKey(yesterday),
      days,
      activeMs: Object.values(this.value.days).reduce((a, b) => a + b, 0),
      activeDays: activeDays.length,
      streak,
      longestStreak,
      tokens,
      undatedTokens,
      reportedTurns,
      skillCalls: Object.keys(this.value.skills).length,
      undatedSkills,
      skills: [...ranking]
        .map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
      syncing: this.syncing.size > 0,
      error: this.error ?? [...this.syncErrors.values()][0] ?? null,
    };
  }
  /** @param {{operation:unknown}} request */
  async command(request) {
    if (!catalogContract.isRequest("analytics", request)) throw new Error("不支持的统计操作");
    if (request.operation === "sync")
      for (const project of this.backend.projects.values()) {
        if (project.client?.ready) await this.syncProject(project);
      }
    else if (request.operation !== "read") throw new Error("不支持的统计操作");
    await this.flush();
    return this.summary();
  }
}
/** @param {unknown} value @returns {value is AnalyticsState} */
function isAnalyticsState(value) {
  if (
    !modelRecord(value) ||
    value.version !== 1 ||
    typeof value.since !== "number" ||
    !modelRecord(value.days) ||
    !modelRecord(value.turns) ||
    !modelRecord(value.skills)
  )
    return false;
  const date = (/** @type {unknown} */ value) => value === null || typeof value === "string";
  return (
    Object.values(value.days).every((value) => typeof value === "number") &&
    Object.values(value.turns).every(
      (value) =>
        modelRecord(value) &&
        date(value.date) &&
        (value.usage === undefined ||
          (modelRecord(value.usage) &&
            [
              value.usage.inputTokens,
              value.usage.outputTokens,
              value.usage.cachedInputTokens,
            ].every((value) => typeof value === "number"))),
    ) &&
    Object.values(value.skills).every(
      (value) => modelRecord(value) && typeof value.name === "string" && date(value.date),
    )
  );
}
module.exports = { UsageAnalytics, dayKey };
