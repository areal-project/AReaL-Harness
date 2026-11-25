//! 使用统计是 Host 的可重建投影；不启动执行实例，也不保存提示或工具正文。
use super::Host;
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use chrono::{Days, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

const ACTIVE_WINDOW: i64 = 15_000;
const MAX_COUNT: u64 = 9_007_199_254_740_991;
fn now() -> i64 {
    Local::now().timestamp_millis()
}
fn day(time: i64) -> String {
    Local
        .timestamp_millis_opt(time)
        .single()
        .map(|date| date.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}
fn count(value: &Value) -> u64 {
    value.as_u64().filter(|n| *n <= MAX_COUNT).unwrap_or(0)
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Turn {
    date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Skill {
    name: String,
    date: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct State {
    version: u32,
    since: f64,
    days: BTreeMap<String, f64>,
    turns: BTreeMap<String, Turn>,
    skills: BTreeMap<String, Skill>,
}
impl State {
    fn empty(time: i64) -> Self {
        Self {
            version: 1,
            since: time as f64,
            days: BTreeMap::new(),
            turns: BTreeMap::new(),
            skills: BTreeMap::new(),
        }
    }
    fn valid(&self) -> bool {
        self.version == 1
            && self.since.is_finite()
            && self
                .days
                .values()
                .all(|v| v.is_finite() && *v >= 0.0 && *v <= MAX_COUNT as f64)
            && self
                .turns
                .values()
                .filter_map(|t| t.usage.as_ref())
                .all(|u| {
                    [u.input_tokens, u.output_tokens, u.cached_input_tokens]
                        .into_iter()
                        .all(|n| n <= MAX_COUNT)
                })
    }
}
struct Activity {
    time: i64,
    focused: bool,
    idle_seconds: f64,
}
struct Projection {
    path: PathBuf,
    state: State,
    dirty: bool,
    read_only: bool,
    error: Option<String>,
    clients: BTreeMap<String, Activity>,
    previous: Option<(i64, bool)>,
    syncing: bool,
    sync_errors: BTreeMap<String, String>,
}
impl Projection {
    fn load(home: &Path) -> Self {
        let path = home.join("workbench/analytics.json");
        let (state, read_only) = match storage::read_optional::<State>(&path) {
            Ok(Some(state)) if state.valid() => (state, false),
            Ok(None) => (State::empty(now()), false),
            _ => (State::empty(now()), true),
        };
        Self {
            path,
            state,
            dirty: false,
            read_only,
            error: read_only.then(|| "使用统计无法读取，已停止写入以保留原文件。".into()),
            clients: BTreeMap::new(),
            previous: None,
            syncing: false,
            sync_errors: BTreeMap::new(),
        }
    }
    fn flush(&mut self) {
        if self.read_only || !self.dirty {
            return;
        }
        let saved = self
            .path
            .parent()
            .context("missing analytics parent")
            .and_then(storage::private_dir)
            .and_then(|_| storage::write(&self.path, &self.state));
        match saved {
            Ok(()) => {
                self.dirty = false;
                self.error = None;
            }
            Err(_) => self.error = Some("使用统计保存失败，当前数据尚未持久化。".into()),
        }
    }
    fn skill(
        &mut self,
        project: &str,
        thread: &str,
        turn: &str,
        item: &Value,
        date: Option<String>,
    ) {
        let args = &item["arguments"];
        if item["type"] != "dynamicToolCall"
            || item["tool"] != "skill_read"
            || item["status"] != "completed"
            || item["success"] != true
            || args.get("resource").is_some_and(|v| v != "SKILL.md")
            || args.get("offset").is_some_and(|v| v != 0)
        {
            return;
        }
        let (Some(id), Some(name)) = (item["id"].as_str(), args["skill"]["id"].as_str()) else {
            return;
        };
        let key = json!([project, thread, turn, id]).to_string();
        let date = self
            .state
            .skills
            .get(&key)
            .map(|s| s.date.clone())
            .unwrap_or(date);
        self.state.skills.insert(
            key,
            Skill {
                name: name.into(),
                date,
            },
        );
        self.dirty = true;
    }
    fn turn(&mut self, project: &str, thread: &str, turn: &Value, date: Option<String>) {
        let Some(id) = turn["id"].as_str() else {
            return;
        };
        let key = json!([project, thread, id]).to_string();
        let old = self.state.turns.get(&key);
        let usage = turn["usage"]
            .is_object()
            .then(|| Usage {
                input_tokens: count(&turn["usage"]["inputTokens"]),
                output_tokens: count(&turn["usage"]["outputTokens"]),
                cached_input_tokens: count(&turn["usage"]["cachedInputTokens"]),
            })
            .or_else(|| old.and_then(|t| t.usage.clone()));
        if usage.is_some() || date.is_some() || old.is_some() {
            let retained = old.map(|t| t.date.clone()).unwrap_or_else(|| date.clone());
            self.state.turns.insert(
                key,
                Turn {
                    date: retained,
                    usage,
                },
            );
            self.dirty = true;
        }
        for item in turn["items"].as_array().into_iter().flatten() {
            self.skill(project, thread, id, item, date.clone());
        }
    }
    fn activity(&mut self, client: &str, params: &Value, time: i64) {
        let idle_seconds = params["idleSeconds"]
            .as_f64()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0)
            .max(0.0);
        self.clients.insert(
            client.into(),
            Activity {
                time,
                focused: params["focused"] == true,
                idle_seconds,
            },
        );
        self.clients
            .retain(|_, entry| time - entry.time <= ACTIVE_WINDOW);
        let focused = self.clients.values().any(|entry| entry.focused);
        let idle = self
            .clients
            .values()
            .filter(|entry| entry.focused)
            .map(|entry| entry.idle_seconds)
            .fold(f64::INFINITY, f64::min);
        let previous = self.previous.replace((time, focused));
        let Some((mut start, true)) = previous else {
            return;
        };
        if time <= start || time - start > ACTIVE_WINDOW {
            return;
        }
        let idle_ms = if focused {
            ((idle - 300.0).max(0.0) * 1000.0).min(i64::MAX as f64) as i64
        } else {
            0
        };
        let end = time.saturating_sub(idle_ms).min(time);
        while start < end {
            let Some(date) = Local.timestamp_millis_opt(start).single() else {
                break;
            };
            let Some(next_date) = date.date_naive().checked_add_days(Days::new(1)) else {
                break;
            };
            let midnight = Local
                .from_local_datetime(&next_date.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .map(|d| d.timestamp_millis())
                .unwrap_or(end);
            let next = midnight.min(end);
            if next <= start {
                break;
            }
            let entry = self.state.days.entry(day(start)).or_default();
            *entry = (*entry + (next - start) as f64).min(MAX_COUNT as f64);
            self.dirty = true;
            start = next;
        }
    }
    fn import(&mut self, input: &Value) -> Result<()> {
        ensure!(
            !self.read_only,
            "使用统计无法读取，已停止写入以保留原文件。"
        );
        let mut value =
            json!({"version":1,"since":self.state.since,"days":{},"turns":{},"skills":{}});
        if let Some(input) = input.as_object() {
            value.as_object_mut().unwrap().extend(input.clone());
        }
        let state: State = serde_json::from_value(value).context("INVALID_PARAMS")?;
        ensure!(
            state.valid() && state.days.len() + state.turns.len() + state.skills.len() <= 2000,
            "INVALID_PARAMS"
        );
        self.state.since = self.state.since.min(state.since);
        for (date, ms) in state.days {
            let current = self.state.days.entry(date).or_default();
            *current = (*current).max(ms);
        }
        for (key, turn) in state.turns {
            self.state.turns.entry(key).or_insert(turn);
        }
        for (key, skill) in state.skills {
            self.state.skills.entry(key).or_insert(skill);
        }
        self.dirty = true;
        Ok(())
    }
    fn summary(&self, time: i64) -> Value {
        let mut days: BTreeMap<String, Value> = self
            .state
            .days
            .iter()
            .map(|(date, ms)| {
                (
                    date.clone(),
                    json!({"activeMs":ms,"tokens":0,"skillCalls":0}),
                )
            })
            .collect();
        let mut tokens = 0u64;
        let mut undated_tokens = 0u64;
        let mut reported_turns = 0u64;
        for turn in self.state.turns.values() {
            if let Some(usage) = &turn.usage {
                let n = usage.input_tokens.saturating_add(usage.output_tokens);
                tokens = tokens.saturating_add(n);
                reported_turns += 1;
                if let Some(date) = &turn.date {
                    let item = days
                        .entry(date.clone())
                        .or_insert(json!({"activeMs":0,"tokens":0,"skillCalls":0}));
                    item["tokens"] = json!(item["tokens"].as_u64().unwrap_or(0).saturating_add(n));
                } else {
                    undated_tokens = undated_tokens.saturating_add(n);
                }
            }
        }
        let mut ranking = BTreeMap::<String, u64>::new();
        let mut undated_skills = 0u64;
        for skill in self.state.skills.values() {
            *ranking.entry(skill.name.clone()).or_default() += 1;
            if let Some(date) = &skill.date {
                let item = days
                    .entry(date.clone())
                    .or_insert(json!({"activeMs":0,"tokens":0,"skillCalls":0}));
                item["skillCalls"] = json!(item["skillCalls"].as_u64().unwrap_or(0) + 1);
            } else {
                undated_skills += 1;
            }
        }
        let mut skills: Vec<_> = ranking
            .into_iter()
            .map(|(name, calls)| json!({"name":name,"calls":calls}))
            .collect();
        skills.sort_by(|a, b| {
            b["calls"]
                .as_u64()
                .cmp(&a["calls"].as_u64())
                .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
        });
        let today = day(time);
        let date = NaiveDate::parse_from_str(&today, "%Y-%m-%d").ok();
        let yesterday = date
            .and_then(|d| d.pred_opt())
            .map(|d| d.to_string())
            .unwrap_or_default();
        let active_days: Vec<_> = self
            .state
            .days
            .iter()
            .filter(|(_, ms)| **ms > 0.0)
            .map(|(date, _)| date)
            .collect();
        let mut longest = 0;
        let mut run = 0;
        let mut previous = None;
        for date in &active_days {
            let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok();
            run = if parsed
                .and_then(|d| d.pred_opt())
                .is_some_and(|d| Some(d) == previous)
            {
                run + 1
            } else {
                1
            };
            longest = longest.max(run);
            previous = parsed;
        }
        let mut streak = 0;
        let mut cursor = if self.state.days.get(&today).copied().unwrap_or(0.0) > 0.0 {
            date
        } else {
            date.and_then(|d| d.pred_opt())
        };
        while let Some(current) = cursor {
            if self
                .state
                .days
                .get(&current.to_string())
                .copied()
                .unwrap_or(0.0)
                == 0.0
            {
                break;
            }
            streak += 1;
            cursor = current.pred_opt();
        }
        json!({"since":self.state.since,"today":today,"yesterday":yesterday,"days":days,"activeMs":self.state.days.values().copied().sum::<f64>(),"activeDays":active_days.len(),"streak":streak,"longestStreak":longest,"tokens":tokens,"undatedTokens":undated_tokens,"reportedTurns":reported_turns,"skillCalls":self.state.skills.len(),"undatedSkills":undated_skills,"skills":skills,"syncing":self.syncing,"error":self.error.as_ref().or_else(||self.sync_errors.values().next())})
    }
}

#[derive(Default)]
pub(super) struct Analytics {
    projection: RefCell<Option<Projection>>,
    scheduled: Cell<bool>,
    changed: tokio::sync::Notify,
}
impl Analytics {
    fn with<T>(&self, home: &Path, action: impl FnOnce(&mut Projection) -> T) -> T {
        let mut projection = self.projection.borrow_mut();
        let value = projection.get_or_insert_with(|| Projection::load(home));
        action(value)
    }
    fn later(self: &Rc<Self>) {
        if self.scheduled.replace(true) {
            return;
        }
        let owner = self.clone();
        tokio::task::spawn_local(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            owner.flush();
            owner.scheduled.set(false);
        });
    }
    pub(super) fn flush(&self) {
        if let Some(projection) = self.projection.borrow_mut().as_mut() {
            projection.flush();
        }
    }
    pub(super) fn observe(self: &Rc<Self>, home: &Path, project: &str, event: &Value) {
        let method = event["method"].as_str().unwrap_or("");
        let params = &event["params"];
        if !matches!(method, "turn/started" | "turn/completed" | "item/completed") {
            return;
        }
        let Some(thread) = params["threadId"].as_str() else {
            return;
        };
        self.with(home, |p| {
            if method == "item/completed" {
                if let Some(turn) = params["turnId"].as_str() {
                    p.skill(project, thread, turn, &params["item"], Some(day(now())));
                }
            } else {
                p.turn(project, thread, &params["turn"], Some(day(now())));
            }
        });
        self.later();
    }
    pub(super) async fn request(
        self: &Rc<Self>,
        host: &Rc<Host>,
        method: &str,
        params: &Value,
        context: &Value,
    ) -> Result<Value> {
        match method {
            "analytics.activity" => {
                ensure!(params["focused"].is_boolean(), "INVALID_PARAMS");
                let client = json!([context["principal"], context["connection"]]).to_string();
                self.with(&host.home, |p| p.activity(&client, params, now()));
                self.later();
                return Ok(Value::Null);
            }
            "analytics.import" => {
                self.with(&host.home, |p| p.import(&params["state"]))?;
            }
            "analytics.sync" => {
                let notified = self.changed.notified();
                let start = self.with(&host.home, |p| {
                    let start = !p.syncing;
                    p.syncing = true;
                    start
                });
                if start {
                    let owner = self.clone();
                    let host = host.clone();
                    tokio::task::spawn_local(async move {
                        let projects: Vec<_> = host
                            .slots
                            .borrow()
                            .iter()
                            .filter(|(_, s)| s.state == "ready")
                            .map(|(id, _)| id.clone())
                            .collect();
                        for project in projects {
                            let result = owner.sync_project(&host, &project).await;
                            owner.with(&host.home, |p| {
                                if result.is_ok() {
                                    p.sync_errors.remove(&project);
                                } else {
                                    p.sync_errors.insert(
                                        project,
                                        "部分历史尚未同步，连接工作区后重试。".into(),
                                    );
                                }
                            });
                        }
                        owner.with(&host.home, |p| p.syncing = false);
                        owner.flush();
                        owner.changed.notify_waiters();
                    });
                }
                let _ = tokio::time::timeout(Duration::from_secs(20), notified).await;
            }
            "analytics.read" => {}
            _ => anyhow::bail!("methodNotFound"),
        }
        self.flush();
        Ok(self.with(&host.home, |p| p.summary(now())))
    }
    async fn sync_project(&self, host: &Host, project: &str) -> Result<()> {
        let scope = host.schedules.connections.shared_identity(host, project)?;
        let request = async |method: &str, params: Value| {
            host.schedules
                .connections
                .remote_request(
                    host,
                    project,
                    (&scope.0, &scope.1, &scope.2),
                    method,
                    params,
                )
                .await
        };
        let mut threads = Vec::new();
        let mut cursor = Value::Null;
        let mut seen = BTreeSet::new();
        loop {
            let mut params = json!({"limit":100});
            if !cursor.is_null() {
                params["cursor"] = cursor.clone();
            }
            let page = request("thread/list", params).await?;
            for thread in page["data"]
                .as_array()
                .context("invalid thread directory")?
            {
                threads.push(
                    thread["id"]
                        .as_str()
                        .context("invalid thread id")?
                        .to_owned(),
                );
            }
            ensure!(threads.len() <= 10_000, "LIMIT_EXCEEDED");
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
            ensure!(
                cursor.is_string() && seen.insert(cursor.to_string()),
                "invalid directory cursor"
            );
        }
        for thread in threads {
            let value = request(
                "thread/read",
                json!({"threadId":thread,"includeTurns":true}),
            )
            .await?;
            let value = value
                .get("thread")
                .filter(|v| v.is_object())
                .context("invalid thread")?;
            let id = value["id"].as_str().context("invalid thread id")?;
            self.with(&host.home, |p| {
                for turn in value["turns"].as_array().into_iter().flatten() {
                    p.turn(
                        project,
                        id,
                        turn,
                        turn["startedAt"]
                            .as_i64()
                            .and_then(|at| at.checked_mul(1000))
                            .map(day),
                    );
                }
            });
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "analytics_tests.rs"]
mod tests;
