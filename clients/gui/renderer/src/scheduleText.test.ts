import { createIntl } from "react-intl";
import { catalogs } from "./i18n/messages.js";
import type { Translate } from "./i18n/IntlProvider.js";
import { describe, expect, it } from "vite-plus/test";
import {
  describeMoment,
  describeSchedule,
  scheduleForm,
  scheduleIntent,
  scheduledTaskName,
  scheduledTaskState,
  scheduledTaskSummary,
} from "./scheduleText.js";

const intl = createIntl({ locale: "zh-CN", messages: catalogs["zh-CN"] });
const t: Translate = (id, values) => intl.formatMessage({ id }, values);
// 2026-10-29 08:00 UTC
const now = Date.UTC(2026, 9, 29, 8, 0);
const at = (hours: number, minutes = 0, days = 0) =>
  Math.floor(Date.UTC(2026, 9, 29 + days, hours, minutes) / 1000);

describe("describeSchedule", () => {
  it("reads intervals in the largest whole unit", () => {
    const interval = (intervalSeconds: number) => ({
      scheduleV2: { rule: { kind: "interval", anchorAt: 0, intervalSeconds } },
    });
    expect(describeSchedule(interval(600), t)).toBe("每 10 分钟");
    expect(describeSchedule(interval(3600), t)).toBe("每小时");
    expect(describeSchedule(interval(7200), t)).toBe("每 2 小时");
    expect(describeSchedule(interval(86400), t)).toBe("每 1 天");
    expect(describeSchedule(interval(45), t)).toBe("每 45 秒");
    expect(describeSchedule({ schedule: { at: 1, intervalSeconds: 1800 } }, t)).toBe("每 30 分钟");
  });

  it("reads calendar rules as day and time", () => {
    const calendar = (rule: object) => ({
      scheduleV2: { rule: { kind: "calendar", interval: 1, localTime: "09:00", ...rule } },
    });
    expect(describeSchedule(calendar({ frequency: "daily" }), t)).toBe("每天 09:00");
    expect(describeSchedule(calendar({ frequency: "weekly", weekdays: [4, 1] }), t)).toBe(
      "每周一、周四 09:00",
    );
    expect(describeSchedule(calendar({ frequency: "monthly", monthDays: [1, "last"] }), t)).toBe(
      "每月 1 日、最后一天 09:00",
    );
    expect(describeSchedule({ scheduleV2: { rule: { kind: "once", at: 1 } } }, t)).toBe("仅一次");
  });
});

describe("describeMoment", () => {
  it("uses today and tomorrow, then the date", () => {
    expect(describeMoment(at(16, 17), t, "UTC", now)).toBe("今天 16:17");
    expect(describeMoment(at(10, 10, 1), t, "UTC", now)).toBe("明天 10:10");
    expect(describeMoment(at(9, 0, 5), t, "UTC", now)).not.toMatch(/今天|明天/);
    expect(describeMoment(null, t, "UTC", now)).toBe("");
  });
});

describe("scheduledTaskState", () => {
  const task = (patch: object) => ({
    mode: "scheduled",
    nextRunAt: at(9),
    runs: [],
    ...patch,
  });
  it("separates enabled, running, paused and finished", () => {
    expect(scheduledTaskState(task({}), {}, t).kind).toBe("enabled");
    expect(scheduledTaskState(task({ runs: [{ status: "running" }] }), {}, t).kind).toBe("running");
    expect(scheduledTaskState(task({ paused: true }), {}, t).kind).toBe("paused");
    expect(
      scheduledTaskState(task({ nextRunAt: null, runs: [{ status: "completed" }] }), {}, t).kind,
    ).toBe("finished");
    expect(scheduledTaskState(task({ deletedAt: 1 }), {}, t).kind).toBe("deleted");
  });

  it("explains why an enabled task needs attention", () => {
    expect(
      scheduledTaskState(task({ runs: [{ status: "failed", reason: "serverRestarted" }] }), {}, t),
    ).toEqual({ kind: "attention", reason: "上次运行被中断" });
    expect(scheduledTaskState(task({ runs: [{ id: "r", status: "blocked" }] }), {}, t)).toEqual({
      kind: "attention",
      reason: "上次运行受阻，可重试本次",
      retryRunId: "r",
    });
    expect(scheduledTaskState(task({}), { scheduling: { suppressed: true } }, t).kind).toBe(
      "attention",
    );
    expect(
      scheduledTaskState(task({}), { scheduling: { activationError: "端口占用" } }, t),
    ).toEqual({ kind: "attention", reason: "后台没能启动：端口占用" });
  });
});

describe("summary and name", () => {
  it("keeps the card to one line", () => {
    const task = {
      objective: "用中文向用户简短、友好地问好，例如“你好！祝你今天心情愉快！”\n第二行",
      nextRunAt: at(16, 17),
      scheduleV2: {
        rule: { kind: "interval", anchorAt: 0, intervalSeconds: 600, timeZone: "UTC" },
      },
    };
    expect(scheduledTaskName(task)).toBe("用中文向用户简短、友好地问好，例如“你好！祝你今…");
    expect(scheduledTaskSummary(task, t, now)).toBe("每 10 分钟 · 下次 今天 16:17");
  });
});

describe("edit dialog schedule", () => {
  it("round-trips a weekly rule into a ScheduleIntent", () => {
    const task = {
      objective: "汇总",
      scheduleV2: {
        rule: {
          kind: "calendar",
          frequency: "weekly",
          interval: 1,
          localTime: "08:30",
          weekdays: [1, 4],
          timeZone: "Asia/Shanghai",
        },
        misfire: { kind: "coalesce" },
      },
    };
    const form = scheduleForm(task, now);
    expect(form).toMatchObject({ repeat: "weekly", time: "08:30", weekdays: [1, 4] });
    expect(scheduleIntent(form, task, now)).toEqual({
      version: 1,
      misfire: { kind: "coalesce" },
      overlap: "skip",
      rule: {
        kind: "calendar",
        timeZone: "Asia/Shanghai",
        frequency: "weekly",
        interval: 1,
        localTime: "08:30",
        weekdays: [1, 4],
      },
    });
  });

  it("turns an interval into seconds and rejects invalid input", () => {
    const task = { scheduleV2: { rule: { kind: "interval", anchorAt: 0, intervalSeconds: 600 } } };
    const form = scheduleForm(task, now);
    expect(form).toMatchObject({ repeat: "interval", every: 10, unit: "minutes" });
    expect(scheduleIntent({ ...form, unit: "hours", every: 2 }, task, now)?.rule).toEqual({
      kind: "interval",
      anchorAt: Math.floor(now / 1000) + 7200,
      intervalSeconds: 7200,
    });
    expect(scheduleIntent({ ...form, every: 0 }, task, now)).toBeNull();
    expect(scheduleIntent({ ...form, repeat: "weekly", weekdays: [] }, task, now)).toBeNull();
    expect(scheduleIntent({ ...form, repeat: "daily", time: "25:00" }, task, now)).toBeNull();
  });
});
