import type { Translate } from "./i18n/IntlProvider.js";
import type { Data } from "./services.js";

// 定时任务在会话卡片、右侧面板和定时任务页共用同一套文案与状态，避免三处各自拼接。

export const scheduleTimeZone = (task: Data): string | undefined =>
  task.scheduleV2?.rule?.timeZone ?? task.schedule?.timeZone ?? undefined;

const weekdayIds = [
  "operations.schedules.monday",
  "operations.schedules.tuesday",
  "operations.schedules.wednesday",
  "operations.schedules.thursday",
  "operations.schedules.friday",
  "operations.schedules.saturday",
  "operations.schedules.sunday",
] as const;

export function describeInterval(seconds: number, t: Translate) {
  if (seconds % 86400 === 0) return t("operations.schedules.everyDays", { count: seconds / 86400 });
  if (seconds % 3600 === 0)
    return seconds === 3600
      ? t("operations.schedules.everyHour")
      : t("operations.schedules.everyHours", { count: seconds / 3600 });
  if (seconds % 60 === 0)
    return seconds === 60
      ? t("operations.schedules.everyMinute")
      : t("operations.schedules.everyMinutes", { count: seconds / 60 });
  return t("operations.schedules.everySeconds", { seconds });
}

/** 一句话描述重复规则，例如“每 10 分钟”“每天 09:00”“每周一、周四 08:00”。 */
export function describeSchedule(task: Data, t: Translate) {
  const rule = task.scheduleV2?.rule;
  if (!rule || rule.kind === "interval") {
    const seconds = rule?.intervalSeconds ?? task.schedule?.intervalSeconds;
    return seconds ? describeInterval(seconds, t) : t("operations.schedules.onceAt");
  }
  if (rule.kind === "once") return t("operations.schedules.onceAt");
  const time = rule.localTime;
  const interval = rule.interval ?? 1;
  const separator = t("operations.schedules.daySeparator");
  if (rule.frequency === "weekly") {
    const days = [...(rule.weekdays ?? [])]
      .sort((a: number, b: number) => a - b)
      .map((day: number) => (weekdayIds[day - 1] ? t(weekdayIds[day - 1]) : String(day)))
      .join(separator);
    return interval === 1
      ? t("operations.schedules.weeklyAt", { days, time })
      : t("operations.schedules.everyNWeeksAt", { interval, days, time });
  }
  if (rule.frequency === "monthly") {
    const days = (rule.monthDays ?? [])
      .map((day: number | string) =>
        day === "last"
          ? t("operations.schedules.lastDay")
          : t("operations.schedules.monthDay", { day }),
      )
      .join(separator);
    return t("operations.schedules.monthlyAt", { days, time });
  }
  return interval === 1
    ? t("operations.schedules.dailyAt", { time })
    : t("operations.schedules.everyNDaysAt", { interval, time });
}

const parts = (date: Date, zone?: string) => {
  const format = (timeZone?: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  let values;
  try {
    values = format(zone);
  } catch {
    values = format("UTC");
  }
  const pick = (type: string) => values.find((part) => part.type === type)?.value ?? "";
  return {
    day: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}`,
  };
};

/** 时间点的短写法：今天/明天用相对写法，其余显示月日。 */
export function describeMoment(
  seconds: number | null | undefined,
  t: Translate,
  zone?: string,
  now = Date.now(),
) {
  if (seconds == null) return "";
  const at = new Date(seconds * 1000);
  const target = parts(at, zone);
  if (target.day === parts(new Date(now), zone).day)
    return t("operations.schedules.today", { time: target.time });
  if (target.day === parts(new Date(now + 86400000), zone).day)
    return t("operations.schedules.tomorrow", { time: target.time });
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  } catch {
    return `${target.day} ${target.time}`;
  }
}

const settled = (run?: Data) =>
  !!run && ["completed", "failed", "cancelled", "skipped"].includes(run.status);

export type ScheduledTaskState =
  | { kind: "enabled" }
  | { kind: "running" }
  | { kind: "paused" }
  | { kind: "attention"; reason: string; retryRunId?: string }
  | { kind: "finished" }
  | { kind: "deleted" };

/** 把任务、最近一次运行和项目调度事实收成用户能区分的一种状态。 */
export function scheduledTaskState(task: Data, project: Data | undefined, t: Translate) {
  const run: Data | undefined = task.activeRun ?? task.latestRun ?? task.runs?.at(-1);
  if (task.deletedAt != null) return { kind: "deleted" } as const;
  if (task.cancelled || (task.nextRunAt == null && (settled(run) || !run)))
    return { kind: "finished" } as const;
  if (task.paused) return { kind: "paused" } as const;
  const activation = project?.scheduling?.activationError;
  if (project?.scheduling?.suppressed)
    return { kind: "attention", reason: t("operations.schedules.reasonSuppressed") } as const;
  if (activation)
    return {
      kind: "attention",
      reason: t("operations.schedules.reasonActivation", { error: activation }),
    } as const;
  switch (run?.status) {
    case "blocked":
      return {
        kind: "attention",
        reason: t("operations.schedules.reasonBlocked"),
        retryRunId: run.id,
      } as const;
    case "waitingForInput":
      return { kind: "attention", reason: t("operations.schedules.reasonWaiting") } as const;
    case "paused":
      return {
        kind: "attention",
        reason: t("operations.schedules.reasonInterrupted"),
        retryRunId: run.id,
      } as const;
    case "failed":
      return {
        kind: "attention",
        reason: ["serverRestarted", "hostUnavailable"].includes(run.reasonPreview ?? run.reason)
          ? t("operations.schedules.reasonInterrupted")
          : t("operations.schedules.reasonFailed"),
      } as const;
    case "queued":
    case "running":
    case "waitingForAgents":
      return { kind: "running" } as const;
  }
  return { kind: "enabled" } as const;
}

export function scheduledTaskStateLabel(state: ScheduledTaskState, t: Translate) {
  return t(
    (
      {
        enabled: "operations.schedules.enabled",
        running: "operations.schedules.running",
        paused: "operations.schedules.paused",
        attention: "operations.schedules.attention",
        finished: "operations.schedules.finishedGroup",
        deleted: "operations.schedules.deleted",
      } as const
    )[state.kind],
  );
}

/** 任务的显示名：取指令第一行的前 24 个字。 */
export function scheduledTaskName(task: Data) {
  const text = String(task.objectivePreview ?? task.objective ?? "").trim();
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

/** 规则与下次时间的一行摘要，例如“每 10 分钟 · 下次 今天 16:17”。 */
export function scheduledTaskSummary(task: Data, t: Translate, now = Date.now()) {
  const rule = describeSchedule(task, t);
  const next = describeMoment(task.nextRunAt, t, scheduleTimeZone(task), now);
  return next ? `${rule} · ${t("operations.schedules.nextShort", { time: next })}` : rule;
}

// 编辑弹窗的表单与 Core ScheduleIntent 互转，纯函数便于测试。
export type Repeat = "interval" | "daily" | "weekly" | "once";
export type Unit = "minutes" | "hours";
export type ScheduleForm = {
  objective: string;
  repeat: Repeat;
  every: number;
  unit: Unit;
  time: string;
  weekdays: number[];
  at: string;
};

const pad = (value: number) => String(value).padStart(2, "0");
const localInput = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 从任务的当前规则推出表单初值；读不懂的规则退回“间隔 1 小时”。 */
export function scheduleForm(task: Data, now = Date.now()): ScheduleForm {
  const rule = task.scheduleV2?.rule;
  const base: ScheduleForm = {
    objective: task.objective ?? "",
    repeat: "interval",
    every: 1,
    unit: "hours",
    time: "09:00",
    weekdays: [1],
    at: localInput(Math.floor(now / 1000) + 3600),
  };
  const seconds = rule?.kind === "interval" ? rule.intervalSeconds : task.schedule?.intervalSeconds;
  if ((!rule || rule.kind === "interval") && seconds) {
    return seconds % 3600 === 0
      ? { ...base, every: seconds / 3600, unit: "hours" }
      : { ...base, every: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
  }
  if (rule?.kind === "once" || (!rule && task.schedule?.at))
    return { ...base, repeat: "once", at: localInput(rule?.at ?? task.schedule.at) };
  if (rule?.kind === "calendar" && rule.frequency === "weekly")
    return { ...base, repeat: "weekly", time: rule.localTime, weekdays: rule.weekdays ?? [1] };
  if (rule?.kind === "calendar" && rule.frequency === "daily" && (rule.interval ?? 1) === 1)
    return { ...base, repeat: "daily", time: rule.localTime };
  return base;
}

/** 把表单转成 Core 的 ScheduleIntent；无效输入返回 null。 */
export function scheduleIntent(form: ScheduleForm, task: Data, now = Date.now()) {
  const zone = scheduleTimeZone(task) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const misfire = task.scheduleV2?.misfire ?? { kind: "skip", maxLatenessSeconds: 300 };
  const definition = <R>(rule: R) => ({ version: 1, rule, misfire, overlap: "skip" as const });
  const seconds = Math.floor(now / 1000);
  if (form.repeat === "interval") {
    const every = Math.floor(form.every);
    if (!Number.isFinite(every) || every < 1) return null;
    const intervalSeconds = every * (form.unit === "hours" ? 3600 : 60);
    return definition({
      kind: "interval" as const,
      anchorAt: seconds + intervalSeconds,
      intervalSeconds,
    });
  }
  if (form.repeat === "once") {
    const at = Math.floor(new Date(form.at).getTime() / 1000);
    return Number.isFinite(at) && at > seconds ? definition({ kind: "once" as const, at }) : null;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return null;
  if (form.repeat === "weekly" && !form.weekdays.length) return null;
  return definition({
    kind: "calendar" as const,
    timeZone: zone,
    frequency: form.repeat as "daily" | "weekly",
    interval: 1,
    localTime: form.time,
    ...(form.repeat === "weekly" ? { weekdays: [...form.weekdays].sort((a, b) => a - b) } : {}),
  });
}
