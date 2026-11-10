import { TitleTooltip } from "@areal/ui";
import { currentErrorText } from "../errors/currentErrorText.js";
import { Button, Input } from "@areal/ui";
import { useI18n, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { ActionButton } from "../components/ui/action-button.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Clock3, Flame, Sparkles, Zap } from "lucide-react";
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
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const level = (ms: number) =>
  ms <= 0 ? 0 : ms < 30 * 60000 ? 1 : ms < 60 * 60000 ? 2 : ms < 120 * 60000 ? 3 : 4;
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
  const { t, intl } = useI18n();
  const number = (value: number) => intl.formatNumber(value);
  const displayDate = (key: string) =>
    intl.formatDate(new Date(key + "T12:00:00"), { dateStyle: "medium" });
  const duration = (ms: number) => {
    if (ms <= 0) return t("settings.usageDashboard.durationZero");
    if (ms < 60000) return t("settings.usageDashboard.durationUnderMinute");
    const minutes = Math.floor(ms / 60000);
    return minutes < 60
      ? t("settings.usageDashboard.durationMinutes", { minutes })
      : t("settings.usageDashboard.durationHoursMinutes", {
          hours: Math.floor(minutes / 60),
          minutes: minutes % 60,
        });
  };
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | UiMessage>("");
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
          setError(
            e instanceof Error
              ? currentErrorText(e)
              : { id: "settings.usageDashboard.couldNotReadUsageStatistics" },
          );
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
        {formatUiMessage(t, error) || t("settings.usageDashboard.readingLocalUsageRecords")}
        <Button unstyled data-slot={undefined} type="submit" onClick={() => void refresh()}>
          {t("settings.usageDashboard.retry")}
        </Button>
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
  const years = Array.from({ length: currentYear - firstYear + 1 }, (_, i) => currentYear - i);
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
            {t("settings.usageDashboard.localRecordsAllWorkspaces")}
          </span>
        </div>
        <ActionButton pending={busy || data.syncing} onClick={() => void refresh(true)}>
          {busy || data.syncing
            ? t("settings.usageDashboard.syncing")
            : t("settings.usageDashboard.syncHistory")}
        </ActionButton>
      </div>
      {(error || data.error) && (
        <div className="usage-error" role="alert">
          {formatUiMessage(t, error) || data.error}
        </div>
      )}
      <div className="usage-metrics">
        {[
          [
            "累计使用",
            t("settings.usageDashboard.totalTime"),
            duration(data.activeMs),
            t("settings.usageDashboard.activeDays", { value0: data.activeDays }),
            Clock3,
          ],
          [
            "连续使用",
            t("settings.usageDashboard.currentStreak"),
            t("settings.usageDashboard.streakDays", { value0: data.streak }),
            t("settings.usageDashboard.longestStreak", { value0: data.longestStreak }),
            Flame,
          ],
          [
            "累计 Token",
            t("settings.usageDashboard.totalTokens"),
            number(data.tokens),
            t("settings.usageDashboard.reportedTurns", { value0: data.reportedTurns }),
            Zap,
          ],
          [
            "今日 Token",
            t("settings.usageDashboard.todaySTokens"),
            number(today.tokens),
            displayDate(data.today),
            Activity,
          ],
          [
            "昨日 Token",
            t("settings.usageDashboard.yesterdaySTokens"),
            number(yesterday.tokens),
            displayDate(data.yesterday),
            Activity,
          ],
          [
            "Skills 调用",
            t("settings.usageDashboard.skillCalls"),
            number(data.skillCalls),
            t("settings.usageDashboard.skillCount", { value0: data.skills.length }),
            Sparkles,
          ],
        ].map(([key, label, value, note, Icon]) => {
          const Symbol = Icon as typeof Clock3;
          return (
            <article className="usage-metric" key={String(key)} data-testid={`metric-${key}`}>
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
          {t("settings.usageDashboard.undatedTokensNote", { count: data.undatedTokens })}
        </p>
      )}
      <section className="usage-section">
        <div className="usage-section-heading">
          <div>
            <h2>{t("settings.usageDashboard.usageActivity")}</h2>
            <p>{t("settings.usageDashboard.darkerColorsMeanMoreTimeUsedThat")}</p>
          </div>
          <SettingsSelect
            aria-label={t("settings.usageDashboard.statisticsYear")}
            value={year}
            onValueChange={(selectedValue) => {
              const y = Number(selectedValue);
              setYear(y);
              setSelected(y === currentYear ? data.today : `${y}-12-31`);
            }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {intl.formatDate(new Date(y, 0, 1), { year: "numeric" })}
              </option>
            ))}
          </SettingsSelect>
        </div>
        <div className="usage-calendar-scroll">
          <div className="usage-calendar">
            <div className="usage-weekdays">
              <span>{intl.formatDate(new Date(2024, 0, 1), { weekday: "short" })}</span>
              <span>{intl.formatDate(new Date(2024, 0, 3), { weekday: "short" })}</span>
              <span>{intl.formatDate(new Date(2024, 0, 5), { weekday: "short" })}</span>
              <span>{intl.formatDate(new Date(2024, 0, 7), { weekday: "short" })}</span>
            </div>
            <div className="usage-weeks">
              {weeks.map((week, w) => (
                <div className="usage-week" key={w}>
                  <span className="usage-month">
                    {week.some((d) => d?.endsWith("-01"))
                      ? intl.formatDate(
                          new Date(week.find((d) => d?.endsWith("-01"))! + "T12:00:00"),
                          { month: "short" },
                        )
                      : ""}
                  </span>
                  {week.map((date, row) => {
                    if (!date || date > data.today)
                      return <span className="usage-cell usage-cell-blank" key={row} />;
                    const day = data.days[date] ?? zero;
                    const label = t("settings.usageDashboard.calendarDaySummary", {
                      value0: displayDate(date),
                      value1: duration(day.activeMs),
                      value2: day.tokens,
                      value3: day.skillCalls,
                    });
                    return (
                      <Button
                        unstyled
                        data-slot={undefined}
                        type="submit"
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
                            ?.querySelector<HTMLButtonElement>(`[data-date="${dateKey(next)}"]`);
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
          <span>{t("settings.usageDashboard.less")}</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <TitleTooltip
              key={i}
              title={
                [
                  t("settings.usageDashboard.noUsage"),
                  t("settings.usageDashboard.lessThan30Minutes"),
                  t("settings.usageDashboard.3060Minutes"),
                  t("settings.usageDashboard.12Hours"),
                  t("settings.usageDashboard.moreThan2Hours"),
                ][i]
              }
            >
              <span className={`usage-cell usage-level-${i}`} />
            </TitleTooltip>
          ))}
          <span>{t("settings.usageDashboard.more")}</span>
        </div>
        <div className="usage-day" aria-live="polite" data-testid="usage-day">
          <div>
            <strong>
              {selected === data.today
                ? t("settings.usageDashboard.today")
                : selected === data.yesterday
                  ? t("settings.usageDashboard.yesterday")
                  : displayDate(selected)}
            </strong>
            <small>{displayDate(selected)}</small>
          </div>
          <div>
            <small>{t("settings.usageDashboard.timeUsed")}</small>
            <strong>{duration(daily.activeMs)}</strong>
          </div>
          <div>
            <small>{t("settings.usageDashboard.tokens")}</small>
            <strong>{number(daily.tokens)}</strong>
          </div>
          <div>
            <small>{t("settings.usageDashboard.skillCalls")}</small>
            <strong>{t("settings.usageDashboard.callCount", { count: daily.skillCalls })}</strong>
          </div>
        </div>
      </section>
      <section className="usage-section">
        <div className="usage-section-heading">
          <div>
            <h2>{t("settings.usageDashboard.skillRankings")}</h2>
            <p>{t("settings.usageDashboard.totalSuccessfulCallsSortedByCount")}</p>
          </div>
          <Input
            unstyled
            data-slot={undefined}
            aria-label={t("settings.usageDashboard.searchSkillRankings")}
            placeholder={t("settings.usageDashboard.searchSkills")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length ? (
          <ol className="usage-ranking">
            {filtered.map((skill) => (
              <li key={skill.name}>
                <span className="usage-rank">{number(data.skills.indexOf(skill) + 1)}</span>
                <div className="usage-skill-name">
                  <strong>{skill.name}</strong>
                  <div className="usage-rank-track">
                    <span style={{ width: `${(skill.calls / top) * 100}%` }} />
                  </div>
                </div>
                <span>{t("settings.usageDashboard.callCount", { count: skill.calls })}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="usage-empty">
            <Sparkles size={24} />
            <strong>
              {query
                ? t("settings.usageDashboard.noMatchingSkills")
                : t("settings.usageDashboard.noSkillCallsYet")}
            </strong>
            <p>
              {query
                ? t("settings.usageDashboard.tryAnotherSearch")
                : t("settings.usageDashboard.callsAppearHereAfterTheAgentSuccessfully")}
            </p>
          </div>
        )}
      </section>
      <SettingsDisclosure
        className="usage-method"
        title={<> {t("settings.usageDashboard.howStatisticsAreCounted")}</>}
      >
        <p>
          {t("settings.usageDashboard.timeMethod", {
            since: intl.formatDate(data.since, { dateStyle: "medium" }),
          })}
        </p>
        <p>{t("settings.usageDashboard.tokenMethod", { count: data.undatedTokens })}</p>
        <p>{t("settings.usageDashboard.skillMethod", { count: data.undatedSkills })}</p>
      </SettingsDisclosure>
    </div>
  );
}
