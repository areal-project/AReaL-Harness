import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Clock3,
  Flame,
  RefreshCw,
  Sparkles,
  Zap,
} from "lucide-react";
import type { Action } from "../services.js";
import "./usage.css";

type Day = { activeMs: number; tokens: number; skillCalls: number };
type Stats = {
  since: number;
  today: string;
  yesterday: string;
  days: Record<string, Day>;
  activeMs: number;
  activeDays: number;
  streak: number;
  longestStreak: number;
  tokens: number;
  undatedTokens: number;
  reportedTurns: number;
  skillCalls: number;
  undatedSkills: number;
  skills: { name: string; calls: number }[];
  syncing: boolean;
  error: string | null;
};
const zero: Day = { activeMs: 0, tokens: 0, skillCalls: 0 };
const number = (n: number) => n.toLocaleString("zh-CN");
function duration(ms: number) {
  if (ms <= 0) return "0 分钟";
  if (ms < 60000) return "不足 1 分钟";
  const mins = Math.floor(ms / 60000);
  return mins < 60
    ? `${mins} 分钟`
    : `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
}
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const level = (ms: number) =>
  ms <= 0
    ? 0
    : ms < 30 * 60000
      ? 1
      : ms < 60 * 60000
        ? 2
        : ms < 120 * 60000
          ? 3
          : 4;
function calendar(year: number) {
  const first = new Date(year, 0, 1, 12);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const weeks: (string | null)[][] = [];
  while (first.getFullYear() <= year) {
    const week: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(first.getFullYear() === year ? dateKey(first) : null);
      first.setDate(first.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}
export function UsageDashboard({ action }: { action: Action }) {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [selected, setSelected] = useState(dateKey(new Date()));
  const [query, setQuery] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(
    async (sync = false) => {
      const id = ++sequence.current;
      if (sync) setBusy(true);
      try {
        const next = await action("analytics", {
          operation: sync ? "sync" : "read",
        });
        if (id === sequence.current) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (id === sequence.current)
          setError(e instanceof Error ? e.message : "无法读取使用统计");
      } finally {
        if (sync) setBusy(false);
      }
    },
    [action],
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [refresh]);
  if (!data)
    return (
      <div className="usage-dashboard" role="status">
        {error || "正在读取本机使用记录…"}
        <button onClick={() => void refresh()}>重试</button>
      </div>
    );
  const daily = data.days[selected] ?? zero;
  const yesterday = data.days[data.yesterday] ?? zero;
  const today = data.days[data.today] ?? zero;
  const weeks = calendar(year);
  const currentYear = Number(data.today.slice(0, 4));
  const firstYear = Math.min(
    currentYear,
    new Date(data.since).getFullYear(),
    ...Object.keys(data.days).map((d) => Number(d.slice(0, 4))),
  );
  const years = Array.from(
    { length: currentYear - firstYear + 1 },
    (_, i) => currentYear - i,
  );
  const filtered = data.skills.filter((s) =>
    s.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const top = data.skills[0]?.calls || 1;
  return (
    <div className="usage-dashboard" data-testid="usage-dashboard">
      <div className="usage-heading">
        <div>
          <span className="usage-local">
            <span />
            本机记录 · 所有工作区
          </span>
          <p>每天的投入与消耗，在这里一目了然。</p>
        </div>
        <button
          className="usage-refresh"
          disabled={busy || data.syncing}
          onClick={() => void refresh(true)}
        >
          <RefreshCw
            size={15}
            className={busy || data.syncing ? "animate-spin" : ""}
          />
          {busy || data.syncing ? "同步中…" : "同步历史"}
        </button>
      </div>
      {(error || data.error) && (
        <div className="usage-error" role="alert">
          {error || data.error}
        </div>
      )}
      <div className="usage-metrics">
        {[
          [
            "累计使用",
            duration(data.activeMs),
            `${data.activeDays} 个活跃日`,
            Clock3,
          ],
          [
            "连续使用",
            `${data.streak} 天`,
            `最长连续 ${data.longestStreak} 天`,
            Flame,
          ],
          [
            "累计 Token",
            number(data.tokens),
            `${number(data.reportedTurns)} 轮已报告用量`,
            Zap,
          ],
          ["今日 Token", number(today.tokens), data.today, Activity],
          ["昨日 Token", number(yesterday.tokens), data.yesterday, Activity],
          [
            "Skills 调用",
            number(data.skillCalls),
            `${data.skills.length} 个技能`,
            Sparkles,
          ],
        ].map(([label, value, note, Icon]) => {
          const Symbol = Icon as typeof Clock3;
          return (
            <article
              className="usage-metric"
              key={String(label)}
              data-testid={`metric-${label}`}
            >
              <span>
                <Symbol size={15} />
                {String(label)}
              </span>
              <strong>{String(value)}</strong>
              <small>{String(note)}</small>
            </article>
          );
        })}
      </div>
      {data.undatedTokens > 0 && (
        <p className="usage-undated">
          累计包含 {number(data.undatedTokens)} 个日期未知的历史
          Token；每日统计不包含这些记录。
        </p>
      )}
      <section className="usage-section">
        <div className="usage-section-heading">
          <div>
            <h2>使用活跃度</h2>
            <p>颜色越深，当天使用时间越长</p>
          </div>
          <select
            aria-label="统计年份"
            value={year}
            onChange={(e) => {
              const y = Number(e.target.value);
              setYear(y);
              setSelected(y === currentYear ? data.today : `${y}-12-31`);
            }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
          </select>
        </div>
        <div className="usage-calendar-scroll">
          <div className="usage-calendar">
            <div className="usage-weekdays">
              <span>一</span>
              <span>三</span>
              <span>五</span>
              <span>日</span>
            </div>
            <div className="usage-weeks">
              {weeks.map((week, w) => (
                <div className="usage-week" key={w}>
                  <span className="usage-month">
                    {week
                      .find((d) => d?.endsWith("-01"))
                      ?.slice(5, 7)
                      .replace(/^0/, "")}
                    {week.some((d) => d?.endsWith("-01")) ? "月" : ""}
                  </span>
                  {week.map((date, row) => {
                    if (!date || date > data.today)
                      return (
                        <span
                          className="usage-cell usage-cell-blank"
                          key={row}
                        />
                      );
                    const day = data.days[date] ?? zero;
                    const label = `${date}，使用 ${duration(day.activeMs)}，${number(day.tokens)} Token，${day.skillCalls} 次 Skills 调用`;
                    return (
                      <button
                        key={date}
                        data-date={date}
                        className={`usage-cell usage-level-${level(day.activeMs)}`}
                        aria-label={label}
                        title={label}
                        aria-pressed={selected === date}
                        tabIndex={date === selected ? 0 : -1}
                        onClick={() => setSelected(date)}
                        onKeyDown={(e) => {
                          const delta = (
                            {
                              ArrowUp: -1,
                              ArrowDown: 1,
                              ArrowLeft: -7,
                              ArrowRight: 7,
                            } as Record<string, number>
                          )[e.key];
                          if (!delta) return;
                          e.preventDefault();
                          const next = new Date(`${date}T12:00:00`);
                          next.setDate(next.getDate() + delta);
                          const target = e.currentTarget
                            .closest(".usage-calendar")
                            ?.querySelector<HTMLButtonElement>(
                              `[data-date="${dateKey(next)}"]`,
                            );
                          target?.focus();
                          if (target) setSelected(dateKey(next));
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="usage-legend">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`usage-cell usage-level-${i}`}
              title={
                [
                  "未使用",
                  "不足 30 分钟",
                  "30–60 分钟",
                  "1–2 小时",
                  "2 小时以上",
                ][i]
              }
            />
          ))}
          <span>多</span>
        </div>
        <div className="usage-day" aria-live="polite" data-testid="usage-day">
          <div>
            <strong>
              {selected === data.today
                ? "今天"
                : selected === data.yesterday
                  ? "昨天"
                  : selected}
            </strong>
            <small>{selected}</small>
          </div>
          <div>
            <small>使用时间</small>
            <strong>{duration(daily.activeMs)}</strong>
          </div>
          <div>
            <small>Token</small>
            <strong>{number(daily.tokens)}</strong>
          </div>
          <div>
            <small>Skills 调用</small>
            <strong>{daily.skillCalls} 次</strong>
          </div>
        </div>
      </section>
      <section className="usage-section">
        <div className="usage-section-heading">
          <div>
            <h2>Skills 排行</h2>
            <p>累计成功调用 · 按次数排序</p>
          </div>
          <input
            aria-label="搜索 Skills 排行"
            placeholder="搜索技能…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length ? (
          <ol className="usage-ranking">
            {filtered.map((skill) => (
              <li key={skill.name}>
                <span className="usage-rank">
                  {data.skills.indexOf(skill) + 1}
                </span>
                <div className="usage-skill-name">
                  <strong>{skill.name}</strong>
                  <div className="usage-rank-track">
                    <span style={{ width: `${(skill.calls / top) * 100}%` }} />
                  </div>
                </div>
                <span>
                  {number(skill.calls)} <small>次</small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="usage-empty">
            <Sparkles size={24} />
            <strong>
              {query ? "没有匹配的技能" : "还没有 Skills 调用记录"}
            </strong>
            <p>
              {query
                ? "试试其他关键词。"
                : "Agent 成功读取技能入口后，调用次数会出现在这里。"}
            </p>
          </div>
        )}
      </section>
      <details className="usage-method">
        <summary>统计口径与数据范围</summary>
        <p>
          使用时间从 {new Date(data.since).toLocaleDateString("zh-CN")}{" "}
          开始记录，仅累计应用在前台且系统空闲不超过 5
          分钟的时间；锁屏、睡眠及后台运行不计入。每 5
          秒采样，按记录时的本机日期归档。连续使用允许今天尚未开始，延续至昨天的连续活跃日。
        </p>
        <p>
          Token 为 Core
          报告的输入与输出之和，缓存输入已包含在输入中，不重复相加。同步历史只读取已连接工作区，不自动启动其他工作区。新轮次按观测到的开始日期归档。旧轮次没有日期的{" "}
          {number(data.undatedTokens)} Token 仅计入累计，不计入每日。
        </p>
        <p>
          Skills 调用指 Agent 成功读取 SKILL.md 入口（offset 为
          0）的次数，按调用 ID
          去重；不包含目录浏览、设置页预览、分页续读或失败调用，不代表技能工作流已完成。历史有{" "}
          {number(data.undatedSkills)}{" "}
          次调用日期未知。数据仅保存在本机，不上传统计服务。
        </p>
      </details>
    </div>
  );
}
