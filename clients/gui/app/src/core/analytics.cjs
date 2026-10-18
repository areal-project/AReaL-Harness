"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const dayKey = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const total = (usage) => count(usage?.inputTokens) + count(usage?.outputTokens);

// A local, replaceable projection of Core reports. No prompts, arguments, credentials or file paths.
class UsageAnalytics {
  constructor(backend, now = Date.now) {
    this.backend = backend;
    this.now = now;
    this.value = { version: 1, since: now(), days: {}, turns: {}, skills: {} };
    this.revision = 0;
    this.savedRevision = 0;
    this.error = null;
    this.syncErrors = new Map();
    this.syncing = new Map();
    this.previous = null;
  }
  async init() {
    try {
      const value = JSON.parse(
        await readFile(join(this.backend.home, "analytics.json"), "utf8"),
      );
      if (value.version !== 1 || !value.days || !value.turns || !value.skills)
        throw new Error("不支持的使用统计格式");
      this.value = value;
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.error = "使用统计无法读取，已停止写入以保留原文件。";
        this.readOnly = true;
      }
    }
  }
  changed() {
    this.revision++;
  }
  sample({ time = this.now(), focused, idleSeconds = 0, suspended = false }) {
    const previous = this.previous;
    this.previous = { time, active: focused && !suspended };
    // Do not bridge sleep, delayed timers, wall-clock changes, or unfocused intervals.
    if (
      !previous?.active ||
      time <= previous.time ||
      time - previous.time > 15000
    )
      return;
    const end = Math.min(time, time - Math.max(0, idleSeconds - 300) * 1000);
    let start = previous.time;
    while (start < end) {
      const d = new Date(start);
      const key = dayKey(start);
      const midnight = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate() + 1,
      ).getTime();
      const next = Math.min(midnight, end);
      this.value.days[key] = (this.value.days[key] ?? 0) + next - start;
      start = next;
      this.changed();
    }
  }
  setEntry(collection, key, value) {
    if (JSON.stringify(collection[key]) !== JSON.stringify(value)) {
      collection[key] = value;
      this.changed();
    }
  }
  recordTurn(projectId, threadId, turn, date = null) {
    if (!turn?.id || !threadId) return;
    const key = JSON.stringify([projectId, threadId, turn.id]);
    const old = this.value.turns[key];
    const usage = turn.usage;
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
    for (const item of turn.items ?? [])
      this.recordSkill(projectId, threadId, turn.id, item, date);
  }
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
      typeof args?.skill?.id !== "string" ||
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
  observe(projectId, method, params) {
    const today = dayKey(this.now());
    if (method === "turn/started")
      this.recordTurn(projectId, params.threadId, params.turn, today);
    if (method === "turn/completed")
      this.recordTurn(projectId, params.threadId, params.turn, today);
    if (method === "item/completed")
      this.recordSkill(
        projectId,
        params.threadId,
        params.turnId,
        params.item,
        today,
      );
  }
  ingest(projectId, thread) {
    for (const turn of thread?.turns ?? [])
      this.recordTurn(projectId, thread.id, turn);
  }
  async syncProject(project) {
    if (this.syncing.has(project.id)) return this.syncing.get(project.id);
    const task = (async () => {
      try {
        // thread/read does not subscribe, resume, or execute historical tasks.
        for (const summary of project.summaries ?? []) {
          if (!project.client?.ready || this.backend.closing)
            throw new Error("历史同步中断");
          const { thread } = await project.client.request("thread/read", {
            threadId: summary.id,
            includeTurns: true,
          });
          this.ingest(project.id, thread);
        }
        this.syncErrors.delete(project.id);
      } catch {
        this.syncErrors.set(project.id, "部分历史尚未同步，连接工作区后重试。");
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
  summary() {
    const days = Object.fromEntries(
      Object.entries(this.value.days).map(([date, activeMs]) => [
        date,
        { activeMs, tokens: 0, skillCalls: 0 },
      ]),
    );
    const day = (date) =>
      (days[date] ??= { activeMs: 0, tokens: 0, skillCalls: 0 });
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
  async command(request) {
    if (request.operation === "sync")
      for (const project of this.backend.projects.values()) {
        if (project.client?.ready) await this.syncProject(project);
      }
    else if (request.operation !== "read") throw new Error("不支持的统计操作");
    await this.flush();
    return this.summary();
  }
}
module.exports = { UsageAnalytics, dayKey };
