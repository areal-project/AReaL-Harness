use super::*;
use chrono::{Datelike, Days, LocalResult, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

const MAX_AT: i64 = 253402300799;
const SEARCH_LIMIT: usize = 146097;

fn timestamp(at: i64) -> Result<i64> {
    if !(0..=MAX_AT).contains(&at) {
        return Err(invalid("schedule timestamp must be in 1970..9999"));
    }
    Ok(at)
}
fn zone(value: &str) -> Result<Tz> {
    value.parse().map_err(|_| invalid("invalid IANA timeZone"))
}
fn date(value: &str) -> Result<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(invalid)?;
    if value.len() != 10
        || parsed.format("%Y-%m-%d").to_string() != value
        || !(1970..=9999).contains(&parsed.year())
    {
        return Err(invalid("date must be YYYY-MM-DD in 1970..9999"));
    }
    Ok(parsed)
}
fn time(value: &str) -> Result<NaiveTime> {
    let parsed = NaiveTime::parse_from_str(value, "%H:%M").map_err(invalid)?;
    if value.len() != 5 || parsed.format("%H:%M").to_string() != value {
        return Err(invalid("localTime must be HH:mm"));
    }
    Ok(parsed)
}
fn interval(seconds: u64) -> Result<()> {
    if !(1..=31_536_000).contains(&seconds) {
        return Err(invalid("intervalSeconds must be in 1..31536000"));
    }
    Ok(())
}
fn local_instant(tz: Tz, day: NaiveDate, clock: NaiveTime) -> Option<(i64, bool)> {
    match tz.from_local_datetime(&day.and_time(clock)) {
        LocalResult::None => None,
        LocalResult::Single(at) => Some((at.timestamp(), false)),
        LocalResult::Ambiguous(a, b) => Some((a.timestamp().min(b.timestamp()), true)),
    }
}
fn civil(tz: &str, clock: &str, choice: CivilDate, now: i64) -> Result<i64> {
    let tz = zone(tz)?;
    let clock = time(clock)?;
    let today = Utc
        .timestamp_opt(timestamp(now)?, 0)
        .single()
        .unwrap()
        .with_timezone(&tz)
        .date_naive();
    let (day, search) = match choice {
        CivilDate::Date { date: value } => (date(&value)?, false),
        CivilDate::Relative { days } => {
            if days > 366 {
                return Err(invalid("relative days must be in 0..366"));
            }
            (
                today
                    .checked_add_days(Days::new(days.into()))
                    .ok_or_else(|| invalid("schedule range exhausted"))?,
                false,
            )
        }
        CivilDate::Next => (today, true),
    };
    for offset in 0..if search { 370 } else { 1 } {
        let day = day
            .checked_add_days(Days::new(offset))
            .ok_or_else(|| invalid("schedule range exhausted"))?;
        if let Some((at, _)) = local_instant(tz, day, clock)
            && (!search || at >= now)
        {
            return timestamp(at);
        }
    }
    Err(invalid(
        "local time does not exist or schedule search exhausted",
    ))
}
fn iso(value: &str) -> Result<i64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).map_err(invalid)?;
    if value.contains('.') || parsed.nanosecond() != 0 {
        return Err(invalid("ISO instant requires whole seconds"));
    }
    timestamp(parsed.timestamp())
}
pub(super) fn resolve(input: ScheduleIntent, now: i64) -> Result<ScheduleV2> {
    use ScheduleIntentRule as I;
    let rule = match input.rule {
        I::Once { at } => ScheduleRule::Once { at },
        I::Interval {
            anchor_at,
            interval_seconds,
        } => ScheduleRule::Interval {
            anchor_at,
            interval_seconds,
        },
        I::Calendar {
            time_zone,
            frequency,
            interval,
            local_time,
            anchor_date,
            weekdays,
            month_days,
        } => {
            let anchor_date = match anchor_date {
                Some(value) => value,
                None => context(&time_zone, now)?.local_date,
            };
            ScheduleRule::Calendar {
                time_zone,
                frequency,
                interval,
                local_time,
                anchor_date,
                weekdays,
                month_days,
            }
        }
        I::OnceLocal {
            time_zone,
            local_time,
            date,
        } => ScheduleRule::Once {
            at: civil(&time_zone, &local_time, date, now)?,
        },
        I::IntervalLocal {
            time_zone,
            local_time,
            date,
            interval_seconds,
        } => ScheduleRule::Interval {
            anchor_at: civil(&time_zone, &local_time, date, now)?,
            interval_seconds,
        },
        I::OnceIso { at_iso } => ScheduleRule::Once { at: iso(&at_iso)? },
        I::IntervalIso {
            at_iso,
            interval_seconds,
        } => ScheduleRule::Interval {
            anchor_at: iso(&at_iso)?,
            interval_seconds,
        },
    };
    let schedule = ScheduleV2 {
        version: input.version,
        rule,
        misfire: input.misfire,
        overlap: input.overlap,
    };
    Plan::versioned(&schedule)?;
    Ok(schedule)
}
pub(super) fn context(value: &str, now: i64) -> Result<ScheduleContext> {
    let tz = zone(value)?;
    let at = Utc
        .timestamp_opt(timestamp(now)?, 0)
        .single()
        .unwrap()
        .with_timezone(&tz);
    Ok(ScheduleContext {
        core_now: now,
        time_zone: value.into(),
        local_date: at.format("%Y-%m-%d").to_string(),
        local_time: at.format("%H:%M:%S").to_string(),
    })
}
struct Calendar {
    zone: Tz,
    frequency: Frequency,
    interval: u16,
    time: NaiveTime,
    anchor: NaiveDate,
    weekdays: Vec<u8>,
    month_days: Vec<MonthDay>,
}
pub(super) struct Plan {
    rule: Rule,
    misfire: Misfire,
    max_at: i64,
}
enum Rule {
    Once(i64),
    Interval(i64, u64),
    Calendar(Calendar),
}
impl Plan {
    pub(super) fn task(task: &Task) -> Result<Self> {
        match (&task.schedule, &task.schedule_v2) {
            (Some(old), None) => {
                interval(old.interval_seconds.unwrap_or(1))?;
                Ok(Self {
                    rule: old
                        .interval_seconds
                        .map_or(Rule::Once(old.at), |n| Rule::Interval(old.at, n)),
                    misfire: Misfire::Coalesce,
                    max_at: i64::MAX,
                })
            }
            (None, Some(new)) => Self::versioned(new),
            _ => Err(invalid("scheduled task requires exactly one schedule")),
        }
    }
    pub(super) fn versioned(schedule: &ScheduleV2) -> Result<Self> {
        if schedule.version != 1 {
            return Err(invalid("unsupported schedule version"));
        }
        if matches!(schedule.misfire,Misfire::Skip{max_lateness_seconds} if max_lateness_seconds>86400)
        {
            return Err(invalid("maxLatenessSeconds must be in 0..86400"));
        }
        let rule = match &schedule.rule {
            ScheduleRule::Once { at } => Rule::Once(timestamp(*at)?),
            ScheduleRule::Interval {
                anchor_at,
                interval_seconds,
            } => {
                interval(*interval_seconds)?;
                Rule::Interval(timestamp(*anchor_at)?, *interval_seconds)
            }
            ScheduleRule::Calendar {
                time_zone,
                frequency,
                interval,
                local_time,
                anchor_date,
                weekdays,
                month_days,
            } => {
                if !(1..=366).contains(interval) {
                    return Err(invalid("calendar interval must be in 1..366"));
                }
                let unique = |values: Vec<String>| {
                    values
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        == values.len()
                };
                match frequency {
                    Frequency::Daily if weekdays.is_none() && month_days.is_none() => {}
                    Frequency::Weekly
                        if month_days.is_none()
                            && weekdays.as_ref().is_some_and(|v| {
                                !v.is_empty()
                                    && v.len() <= 7
                                    && v.iter().all(|n| (1..=7).contains(n))
                                    && unique(v.iter().map(ToString::to_string).collect())
                            }) => {}
                    Frequency::Monthly
                        if weekdays.is_none()
                            && month_days.as_ref().is_some_and(|v| {
                                !v.is_empty()
                                    && v.len() <= 32
                                    && v.iter().all(|d| {
                                        matches!(d, MonthDay::Last(_))
                                            || matches!(d,MonthDay::Day(n) if (1..=31).contains(n))
                                    })
                                    && v.iter().collect::<std::collections::BTreeSet<_>>().len()
                                        == v.len()
                            }) => {}
                    _ => {
                        return Err(invalid(
                            "calendar selectors must match frequency and contain distinct valid values",
                        ));
                    }
                }
                Rule::Calendar(Calendar {
                    zone: zone(time_zone)?,
                    frequency: frequency.clone(),
                    interval: *interval,
                    time: time(local_time)?,
                    anchor: date(anchor_date)?,
                    weekdays: weekdays.clone().unwrap_or_default(),
                    month_days: month_days.clone().unwrap_or_default(),
                })
            }
        };
        let plan = Self {
            rule,
            misfire: schedule.misfire.clone(),
            max_at: MAX_AT,
        };
        if matches!(plan.rule, Rule::Calendar(_)) && plan.next(0, &mut Vec::new())?.is_none() {
            return Err(invalid("calendar has no occurrence in the supported range"));
        }
        Ok(plan)
    }
    pub(super) fn next(&self, from: i64, warnings: &mut Vec<String>) -> Result<Option<i64>> {
        match &self.rule {
            Rule::Once(at) => Ok((*at >= from).then_some(*at)),
            Rule::Interval(anchor, seconds) => {
                let n = (*seconds) as i64;
                let count = if from <= *anchor {
                    0
                } else {
                    (from - *anchor - 1) / n + 1
                };
                Ok(count
                    .checked_mul(n)
                    .and_then(|v| anchor.checked_add(v))
                    .filter(|v| *v <= self.max_at))
            }
            Rule::Calendar(c) => {
                if from > MAX_AT {
                    return Ok(None);
                }
                let local = Utc
                    .timestamp_opt(from.max(0), 0)
                    .single()
                    .ok_or_else(|| invalid("schedule range exhausted"))?
                    .with_timezone(&c.zone)
                    .date_naive();
                let mut day = local.max(c.anchor);
                let anchor_week =
                    c.anchor.num_days_from_ce() - c.anchor.weekday().num_days_from_monday() as i32;
                for _ in 0..SEARCH_LIMIT {
                    if day.year() > 9999 {
                        return Ok(None);
                    }
                    let selected = match c.frequency {
                        Frequency::Daily => {
                            (day - c.anchor).num_days() % i64::from(c.interval) == 0
                        }
                        Frequency::Weekly => {
                            let week = day.num_days_from_ce()
                                - day.weekday().num_days_from_monday() as i32;
                            (week - anchor_week) / 7 % i32::from(c.interval) == 0
                                && c.weekdays
                                    .contains(&(day.weekday().number_from_monday() as u8))
                        }
                        Frequency::Monthly => {
                            let months = (day.year() - c.anchor.year()) * 12 + day.month() as i32
                                - c.anchor.month() as i32;
                            let last = day
                                .succ_opt()
                                .is_none_or(|next| next.month() != day.month());
                            if months % i32::from(c.interval) == 0 {
                                if last
                                    && c.month_days.iter().any(
                                        |d| matches!(d,MonthDay::Day(n) if u32::from(*n)>day.day()),
                                    )
                                {
                                    warn(warnings, "missingMonthDaySkipped");
                                }
                                c.month_days.iter().any(|d| match d {
                                    MonthDay::Day(n) => u32::from(*n) == day.day(),
                                    MonthDay::Last(_) => last,
                                })
                            } else {
                                false
                            }
                        }
                    };
                    if selected {
                        match local_instant(c.zone, day, c.time) {
                            None => warn(warnings, "dstGapSkipped"),
                            Some((at, fold)) => {
                                if fold {
                                    warn(warnings, "dstFoldEarlier");
                                }
                                if at >= from && (0..=MAX_AT).contains(&at) {
                                    return Ok(Some(at));
                                }
                            }
                        }
                    }
                    let Some(next) = day.succ_opt() else {
                        return Ok(None);
                    };
                    day = next;
                }
                Err(invalid("SCHEDULE_EVALUATION_LIMIT"))
            }
        }
    }
    pub(super) fn first(&self, now: i64, update: bool) -> Result<i64> {
        let from = if update {
            now.checked_add(1)
                .ok_or_else(|| invalid("schedule range exhausted"))?
        } else {
            match self.rule {
                Rule::Once(at) | Rule::Interval(at, _) => at,
                Rule::Calendar(_) => now,
            }
        };
        self.next(from, &mut Vec::new())?
            .ok_or_else(|| invalid("schedule has no future occurrence"))
    }
    fn due(&self, first: i64, now: i64) -> Result<DueRange> {
        if let Rule::Interval(_, seconds) = self.rule {
            let count = ((now - first) / seconds as i64 + 1) as u64;
            let last = first
                .checked_add(
                    ((count - 1) as i64)
                        .checked_mul(seconds as i64)
                        .ok_or_else(|| invalid("schedule range exhausted"))?,
                )
                .ok_or_else(|| invalid("schedule range exhausted"))?;
            return Ok(DueRange {
                first,
                last,
                count,
                next: last
                    .checked_add(seconds as i64)
                    .filter(|n| *n <= self.max_at),
            });
        }
        let mut last = first;
        let mut count = 1;
        loop {
            let next = self.next(
                last.checked_add(1)
                    .ok_or_else(|| invalid("schedule range exhausted"))?,
                &mut Vec::new(),
            )?;
            if next.is_none_or(|at| at > now) {
                return Ok(DueRange {
                    first,
                    last,
                    count,
                    next,
                });
            }
            if count >= SEARCH_LIMIT as u64 {
                return Err(invalid("SCHEDULE_EVALUATION_LIMIT"));
            }
            count += 1;
            last = next.unwrap();
        }
    }
}
struct DueRange {
    first: i64,
    last: i64,
    count: u64,
    next: Option<i64>,
}
fn warn(warnings: &mut Vec<String>, value: &str) {
    if !warnings.iter().any(|w| w == value) {
        warnings.push(value.into());
    }
}
pub(super) fn preview(input: SchedulePreview, now: i64) -> Result<SchedulePreviewed> {
    if !(1..=10).contains(&input.count) {
        return Err(invalid("preview count must be in 1..10"));
    }
    let from = timestamp(input.from.unwrap_or(now))?;
    let schedule = resolve(input.schedule, now)?;
    let plan = Plan::versioned(&schedule)?;
    let time_zone = match &schedule.rule {
        ScheduleRule::Calendar { time_zone, .. } => time_zone.clone(),
        _ => "UTC".into(),
    };
    let tz = zone(&time_zone)?;
    let mut cursor = from;
    let mut occurrences = Vec::new();
    let mut warnings = Vec::new();
    for _ in 0..input.count {
        let Some(at) = plan.next(cursor, &mut warnings)? else {
            break;
        };
        occurrences.push(ScheduleOccurrence {
            at,
            local_time: Utc
                .timestamp_opt(at, 0)
                .single()
                .unwrap()
                .with_timezone(&tz)
                .to_rfc3339(),
        });
        cursor = at + 1;
    }
    Ok(SchedulePreviewed {
        core_now: now,
        from,
        schedule,
        time_zone,
        occurrences,
        warnings,
    })
}
impl Engine {
    pub fn task_schedule_context(&self, input: ScheduleContextInput) -> Result<ScheduleContext> {
        context(&input.time_zone, self.schedule_now())
    }
    pub fn task_schedule_preview(&self, input: SchedulePreview) -> Result<SchedulePreviewed> {
        preview(input, self.schedule_now())
    }
    pub(super) fn schedule_now(&self) -> i64 {
        #[cfg(feature = "test-support")]
        {
            let value = self.task_modes.clock.load(Ordering::SeqCst);
            if value >= 0 {
                return value;
            }
        }
        now()
    }
    #[cfg(feature = "test-support")]
    pub fn set_schedule_time(&self, at: i64) -> Result<()> {
        timestamp(at)?;
        let previous = self.task_modes.clock.load(Ordering::SeqCst);
        if previous >= 0 && at < previous {
            return Err(invalid("schedule test clock must be monotonic"));
        }
        self.task_modes.clock.store(at, Ordering::SeqCst);
        self.wake_tasks();
        Ok(())
    }
    pub(super) async fn admit_schedule_due(
        &self,
        id: &str,
        host_ready: bool,
        captured_now: i64,
    ) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        let current = state.tasks.get(id).ok_or(Error::NotFound)?;
        if current.paused || current.cancelled {
            return Ok(());
        }
        let Some(at) = current.next_run_at.filter(|at| *at <= captured_now) else {
            return Ok(());
        };
        // 已停住（暂停或受阻且没有待处理工作）的上一次运行不再占用后续触发。
        let stalled = |r: &TaskRun| {
            matches!(r.status, RunStatus::Paused | RunStatus::Blocked)
                && r.reason.as_deref() != Some("resumeRequested")
                && r.workers.iter().all(|w| w.settled)
        };
        let busy = current
            .runs
            .iter()
            .any(|r| !r.status.terminal() && !stalled(r));
        if !busy && !host_ready {
            return Ok(());
        }
        let plan = Plan::task(current)?;
        let range = plan.due(at, captured_now)?;
        let missed = matches!(plan.misfire,Misfire::Skip{max_lateness_seconds} if captured_now-at>i64::from(max_lateness_seconds));
        let mut candidate = state.clone();
        let task = candidate.tasks.get_mut(id).unwrap();
        if !busy {
            let mut settled = Vec::new();
            for r in task.runs.iter_mut().filter(|r| !r.status.terminal()) {
                r.status = if r.reason.as_deref() == Some("stopRequested") {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Failed
                };
                r.completed_at = Some(captured_now);
                if r.reason.is_none() {
                    r.reason = Some("supersededBySchedule".into());
                }
                settled.push(r.id.clone());
            }
            for m in &mut task.messages {
                if m.status == "pending" && settled.contains(&m.run_id) {
                    m.status = "cancelled".into();
                    task.channel_sequence += 1;
                    m.sequence = task.channel_sequence;
                }
            }
        }
        let mut admitted = (!busy && !missed).then(|| new_run(None, range.first));
        let decision = TriggerDecision {
            sequence: task
                .last_trigger_decision
                .as_ref()
                .map_or(1, |d| d.sequence.saturating_add(1)),
            decided_at: captured_now,
            plan_revision: task.revision,
            original_scheduled_at: range.first,
            due_through: range.last,
            due_count: range.count,
            next_run_at: range.next,
            outcome: if busy {
                TriggerOutcome::SkippedOverlap
            } else if missed {
                TriggerOutcome::MissedWindow
            } else {
                TriggerOutcome::Admitted {
                    run_id: admitted.as_ref().unwrap().id.clone(),
                }
            },
        };
        if busy {
            task.skipped_runs = task.skipped_runs.saturating_add(range.count);
            task.last_skipped_at = Some(range.first);
        }
        if let Some(run) = admitted.as_mut() {
            run.objective = Some(task.objective.clone());
            run.accepted_schedule = Some(AcceptedSchedule {
                task_revision: task.revision,
                schedule: task.schedule.clone(),
                schedule_v2: task.schedule_v2.clone(),
                decision: Some(decision.clone()),
            });
        }
        let growth = admitted.is_some();
        task.next_run_at = range.next;
        task.last_trigger_decision = Some(decision);
        task.revision += 1;
        if let Some(run) = admitted {
            task.runs.push(run);
        }
        self.save_tasks(&mut state, candidate, id, growth).await
    }
}
