use anyhow::{Context, Result, bail, ensure};
use areal_protocol::desktop::VersionRef;
use areal_protocol::{Item, Thread, ThreadStatus, Turn, TurnStatus};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    client::Client,
    commands::{self, ModelChoice, Picker, PickerKind, SkillChoice},
    history::History,
    safe_text,
    theme::{Preferences, Theme},
};

const SUBSCRIPTION_BUDGET: usize = 64;
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub enum View {
    #[default]
    Conversation,
    Agents,
    Groups,
    Tasks,
    Welcome,
    Help,
    Permissions,
}
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub enum Focus {
    #[default]
    Input,
    Navigation,
    Content,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NavTarget {
    Thread(String),
    More(Option<String>),
    Group(String),
}
#[derive(Clone, Debug)]
pub struct NavRow {
    pub target: NavTarget,
    pub depth: usize,
    pub prefix: String,
}
#[derive(Default)]
pub struct Page {
    pub cursor: Option<String>,
    pub loaded: bool,
    generation: u64,
}
#[derive(Clone, Debug)]
enum Purpose {
    Permissions(String),
    ForgetPermissions(String),
    Interaction(String),
    Configuration,
    Ordinary,
    Create(u64),
    Resume(String),
    Summary(String),
    List {
        parent: Option<String>,
        generation: u64,
    },
    Release(Vec<String>),
    Group(u64),
    Models,
    Skills,
    Configure(String),
}
#[derive(Clone, Debug)]
struct Request {
    method: String,
    params: Value,
    purpose: Purpose,
    submitted_input: Option<String>,
}

pub struct SubmissionFailure {
    pub message: String,
    pub input: String,
}

pub struct RetryState {
    pub turn_id: String,
    pub purpose: String,
    pub attempt: u64,
    pub until: Instant,
}

pub struct App {
    pub agent_profile: Option<VersionRef>,
    pub permission_info: Value,
    pub permission_mode: String,
    pub approval_choice: usize,
    pub interaction_scroll: u16,
    pub permission_scroll: u16,
    approval_request: Option<String>,
    pub monitor_configuration: bool,
    pub restart_ready: bool,
    pub configuration_notice: Option<String>,
    pub trajectory_notice: Option<String>,
    configuration: Value,
    pub threads: BTreeMap<String, Thread>,
    pub selected: Option<String>,
    pub input: String,
    // 使用字素边界的字节偏移，避免拆开中文、组合字符和 emoji。
    pub input_cursor: usize,
    pub status: String,
    pub rsi_artifact: Option<(String, String, String, Vec<u8>)>,
    pub view: View,
    pub focus: Focus,
    pub prefs: Preferences,
    pub theme_original: Option<Theme>,
    pub picker: Option<Picker>,
    pub models: Vec<ModelChoice>,
    pub skills: Vec<SkillChoice>,
    pub default_model: String,
    pub model_reset_supported: bool,
    pub completion_index: usize,
    completion_dismissed: bool,
    pub histories: BTreeMap<String, History>,
    pub retries: BTreeMap<String, RetryState>,
    pub submission_failures: BTreeMap<String, SubmissionFailure>,
    pub history_area: Option<(String, Rect)>,
    mouse_down: Option<(String, crate::history::BlockKey)>,
    pub syncing: BTreeSet<String>,
    resynced: BTreeMap<String, (String, u64)>,
    pub tree_root: Option<String>,
    tree_direct: bool,
    pub expanded: BTreeSet<String>,
    pub nav_selected: Option<NavTarget>,
    pub pages: BTreeMap<Option<String>, Page>,
    pub subscriptions: BTreeSet<String>,
    pub freshness: BTreeMap<String, Instant>,
    pub observed: BTreeMap<String, Instant>,
    pub groups: Vec<Value>,
    pub execution_view: bool,
    pub execution_next_offset: Option<u64>,
    pub group: Option<Value>,
    pub group_id: Option<String>,
    pub group_scroll: usize,
    pub plan_scroll: usize,
    pub connected: bool,
    pub reconnect_requested: bool,
    pub dirty: bool,
    pub nav_offset: usize,
    pub capabilities: BTreeSet<String>,
    pending: BTreeMap<u64, Request>,
    outbox: VecDeque<Request>,
    releasing: BTreeSet<String>,
    generation: u64,
    group_generation: u64,
    refresh_cursor: usize,
    group_retry: Instant,
}
impl App {
    pub fn new(prefs: Preferences) -> Self {
        Self {
            agent_profile: None,
            permission_info: Value::Null,
            permission_mode: "Unknown".into(),
            approval_choice: 0,
            interaction_scroll: 0,
            permission_scroll: 0,
            approval_request: None,
            monitor_configuration: false,
            restart_ready: false,
            configuration_notice: None,
            trajectory_notice: None,
            configuration: Value::Null,
            threads: BTreeMap::new(),
            selected: None,
            input: String::new(),
            input_cursor: 0,
            status: "Connected · /help for commands".into(),
            rsi_artifact: None,
            view: if prefs.no_logo {
                View::Conversation
            } else {
                View::Welcome
            },
            focus: Focus::Input,
            prefs,
            theme_original: None,
            picker: None,
            models: Vec::new(),
            skills: Vec::new(),
            default_model: "Server default".into(),
            model_reset_supported: false,
            completion_index: 0,
            completion_dismissed: false,
            histories: BTreeMap::new(),
            retries: BTreeMap::new(),
            submission_failures: BTreeMap::new(),
            history_area: None,
            mouse_down: None,
            syncing: BTreeSet::new(),
            resynced: BTreeMap::new(),
            tree_root: None,
            tree_direct: false,
            expanded: BTreeSet::new(),
            nav_selected: None,
            pages: BTreeMap::new(),
            subscriptions: BTreeSet::new(),
            freshness: BTreeMap::new(),
            observed: BTreeMap::new(),
            groups: Vec::new(),
            execution_view: false,
            execution_next_offset: None,
            group: None,
            group_id: None,
            group_scroll: 0,
            plan_scroll: 0,
            connected: true,
            reconnect_requested: false,
            dirty: true,
            nav_offset: 0,
            capabilities: BTreeSet::new(),
            pending: BTreeMap::new(),
            outbox: VecDeque::new(),
            releasing: BTreeSet::new(),
            generation: 0,
            group_generation: 0,
            refresh_cursor: 0,
            group_retry: Instant::now(),
        }
    }
    pub fn current(&self) -> Option<&Thread> {
        self.selected.as_ref().and_then(|id| self.threads.get(id))
    }
    pub fn active(&self) -> Option<&Turn> {
        self.current()?
            .turns
            .last()
            .filter(|t| t.status == TurnStatus::InProgress)
    }
    pub fn node_status(&self, id: &str) -> &'static str {
        let Some(thread) = self.threads.get(id) else {
            return "Unknown";
        };
        if self.connected && self.subscriptions.contains(id) {
            thread_status(thread)
        } else {
            match thread.status {
                ThreadStatus::Active { .. } => "Running",
                ThreadStatus::SystemError => "Error",
                ThreadStatus::Idle => "Idle",
            }
        }
    }
    pub fn history(&mut self) -> Option<&mut History> {
        let id = self.selected.clone()?;
        Some(self.histories.entry(id).or_default())
    }
    fn queue(&mut self, method: &str, params: Value, purpose: Purpose) -> Result<()> {
        ensure!(
            self.connected,
            "Disconnected; input is retained. Reconnect before sending."
        );
        ensure!(
            self.outbox.len() < 128,
            "Client request queue is full; try again shortly."
        );
        let submitted_input = matches!(
            method,
            "turn/start"
                | "turn/steer"
                | "areal/goal/create"
                | "areal/goal/selectCandidate"
                | "areal/goal/evolve"
                | "areal/goal/evaluateCandidate"
        )
        .then(|| self.input.clone());
        self.outbox.push_back(Request {
            method: method.into(),
            params,
            purpose,
            submitted_input,
        });
        Ok(())
    }
    fn in_flight(&self, method: &str, key: &str, value: &str) -> bool {
        self.pending
            .values()
            .chain(self.outbox.iter())
            .any(|r| r.method == method && r.params[key].as_str() == Some(value))
    }
    fn list_in_flight(&self, parent: &Option<String>) -> bool {
        self.pending
            .values()
            .chain(self.outbox.iter())
            .any(|r| matches!(&r.purpose, Purpose::List { parent: p, .. } if p == parent))
    }
    pub fn bootstrap(&mut self, resume: Option<String>, initial: bool) -> Result<()> {
        self.connected = true;
        self.queue("areal/capabilities", json!({}), Purpose::Ordinary)?;
        self.queue("areal/model/list", json!({}), Purpose::Models)?;
        if let Some(id) = resume {
            self.selected = Some(id.clone());
            if initial {
                self.nav_selected = Some(NavTarget::Thread(id));
            }
            self.sync_subscriptions()?;
        } else if initial {
            self.new_thread()?;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.kind == PickerKind::Sessions)
        {
            self.load_page(None, true)?;
        }
        Ok(())
    }
    fn new_thread(&mut self) -> Result<()> {
        ensure!(
            !self
                .pending
                .values()
                .chain(self.outbox.iter())
                .any(|r| matches!(r.purpose, Purpose::Create(_))),
            "Wait for the current session creation to finish"
        );
        self.generation += 1;
        // 创建会话也会占用服务端订阅；先退回当前会话订阅，为新会话预留槽位。
        if self.view != View::Welcome {
            self.view = View::Conversation;
        }
        self.tree_root = None;
        self.sync_subscriptions()?;
        let (method, params) = if let Some(profile) = &self.agent_profile {
            (
                "areal/thread/start",
                json!({"requestId":crate::goal_request_id(),"agentProfile":profile}),
            )
        } else {
            ("thread/start", json!({}))
        };
        self.queue(method, params, Purpose::Create(self.generation))
    }
    pub fn flush(&mut self, client: &mut Client) -> Result<()> {
        for _ in 0..8 {
            if self.pending.len() >= 64 || client.tx.capacity() == 0 {
                break;
            }
            let Some(request) = self.outbox.front() else {
                break;
            };
            if matches!(request.purpose, Purpose::Create(_))
                && self.subscriptions.union(&self.reserved()).count() >= SUBSCRIPTION_BUDGET
            {
                let deferred = self.outbox.pop_front().unwrap();
                self.outbox.push_back(deferred);
                continue;
            }
            let id = client.send(&request.method, request.params.clone())?;
            self.pending.insert(id, self.outbox.pop_front().unwrap());
        }
        Ok(())
    }
    pub fn disconnect(&mut self, reason: &str) {
        self.connected = false;
        self.restart_ready = false;
        self.status =
            format!("Disconnected · {reason} · reconnecting; submitted actions are not replayed");
        for request in self.pending.values().chain(self.outbox.iter()) {
            if let (Some(input), Some(id)) = (
                &request.submitted_input,
                request.params["threadId"].as_str(),
            ) {
                self.submission_failures.insert(id.into(), SubmissionFailure {
                    message: "Connection lost; submission outcome unknown. Inspect the restored session before resubmitting.".into(), input: input.clone(),
                });
            }
        }
        self.pending.clear();
        self.outbox.clear();
        self.retries.clear();
        self.syncing.clear();
        self.resynced.clear();
        self.history_area = None;
        self.mouse_down = None;
        self.subscriptions.clear();
        self.releasing.clear();
        self.observed.clear();
        self.capabilities.clear();
        self.dirty = true;
    }
    pub fn open(&mut self, id: &str) -> Result<()> {
        ensure!(
            self.connected,
            "Disconnected; reconnect before opening a session"
        );
        self.generation += 1;
        self.selected = Some(id.into());
        self.nav_selected = Some(NavTarget::Thread(id.into()));
        self.histories.entry(id.into()).or_default();
        if self.view != View::Welcome {
            self.view = View::Conversation;
        }
        self.tree_root = None;
        self.tree_direct = false;
        self.prepare_context()?;
        self.sync_subscriptions()?;
        Ok(())
    }
    fn load_page(&mut self, parent: Option<String>, reset: bool) -> Result<()> {
        if self.list_in_flight(&parent) {
            return Ok(());
        }
        let page = self.pages.entry(parent.clone()).or_default();
        if reset {
            page.generation += 1;
        }
        let cursor = if reset { None } else { page.cursor.clone() };
        let generation = page.generation;
        let method = if parent.is_some() {
            "areal/agent/list"
        } else {
            "thread/list"
        };
        let mut params = json!({"limit":100,"cursor":cursor});
        if let Some(id) = &parent {
            params["parentThreadId"] = json!(id);
        }
        self.queue(method, params, Purpose::List { parent, generation })
    }
    fn root_for(&self, id: &str) -> String {
        let mut current = id.to_owned();
        let mut seen = BTreeSet::new();
        while seen.insert(current.clone()) {
            let Some(parent) = self
                .threads
                .get(&current)
                .and_then(|t| t.parent_thread_id.as_ref())
            else {
                break;
            };
            current = parent.clone();
        }
        current
    }
    fn prepare_context(&mut self) -> Result<()> {
        let Some(id) = self.selected.as_ref() else {
            return Ok(());
        };
        if self.tree_root.is_none() && self.threads.contains_key(id) {
            let root = self.root_for(id);
            self.tree_root = Some(root.clone());
            self.expanded.insert(root.clone());
            self.load_page(Some(root), true)?;
        }
        Ok(())
    }
    pub fn agent_panel(&self) -> bool {
        matches!(self.view, View::Conversation | View::Agents)
    }
    pub fn topology(&mut self, direct: bool) -> Result<()> {
        let id = self
            .selected
            .as_ref()
            .context("Create or open a session first")?;
        let root = if direct {
            id.clone()
        } else {
            self.root_for(id)
        };
        self.tree_root = Some(root.clone());
        self.tree_direct = direct;
        self.expanded.insert(root.clone());
        self.view = View::Agents;
        self.focus = Focus::Navigation;
        self.nav_selected = Some(NavTarget::Thread(root.clone()));
        self.load_page(Some(root), true)?;
        self.sync_subscriptions()
    }
    fn reserved(&self) -> BTreeSet<String> {
        self.pending
            .values()
            .chain(self.outbox.iter())
            .filter_map(|r| match &r.purpose {
                Purpose::Resume(id) => Some(id.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn sync_subscriptions(&mut self) -> Result<()> {
        if !self.connected {
            return Ok(());
        }
        let mut desired = Vec::new();
        if let Some(id) = &self.selected {
            desired.push(id.clone());
        }
        if let Some(root) = &self.tree_root {
            desired.push(root.clone());
        }
        if self.agent_panel() {
            let visible: Vec<_> = self
                .nav_rows()
                .into_iter()
                .filter_map(|r| match r.target {
                    NavTarget::Thread(id) => Some(id),
                    _ => None,
                })
                .collect();
            if let Some(NavTarget::Thread(id)) = &self.nav_selected {
                desired.push(id.clone());
            }
            desired.extend(
                visible
                    .iter()
                    .filter(|id| self.expanded.contains(*id))
                    .cloned(),
            );
            desired.extend(visible);
        }
        let mut unique = BTreeSet::new();
        desired.retain(|id| unique.insert(id.clone()));
        desired.truncate(SUBSCRIPTION_BUDGET);
        let desired_set: BTreeSet<_> = desired.iter().cloned().collect();
        let remove: Vec<_> = self
            .subscriptions
            .difference(&desired_set)
            .filter(|id| !self.releasing.contains(*id))
            .cloned()
            .collect();
        if !remove.is_empty() {
            self.queue(
                "areal/subscription/remove",
                json!({"threadIds":remove}),
                Purpose::Release(remove.clone()),
            )?;
            self.releasing.extend(remove);
        }
        let reserved = self.reserved();
        let mut occupied = self.subscriptions.union(&reserved).count()
            + self
                .pending
                .values()
                .chain(self.outbox.iter())
                .filter(|r| matches!(r.purpose, Purpose::Create(_)))
                .count();
        for id in desired {
            if occupied >= SUBSCRIPTION_BUDGET {
                break;
            }
            if !self.subscriptions.contains(&id)
                && !reserved.contains(&id)
                && !self.releasing.contains(&id)
            {
                self.queue(
                    "areal/thread/observe",
                    json!({"threadId":id}),
                    Purpose::Resume(id),
                )?;
                occupied += 1;
            }
        }
        Ok(())
    }
    pub fn set_trajectory_notice(&mut self, notice: String) {
        if self.trajectory_notice.is_none() {
            self.trajectory_notice = Some(safe_text(&notice));
            self.dirty = true;
        }
    }

    pub fn status_notice(&self) -> &str {
        self.configuration_notice.as_deref().unwrap_or(&self.status)
    }

    fn configuration_changed(&mut self, configuration: &Value) -> Result<()> {
        if configuration.is_null() || self.configuration == *configuration {
            return Ok(());
        }
        let changed_model = !self.configuration.is_null()
            && self.configuration["modelRevision"] != configuration["modelRevision"];
        self.configuration = configuration.clone();
        self.configuration_notice = if let Some(error) = configuration["error"].as_str() {
            Some(format!("Configuration unchanged: {}", safe_text(error)))
        } else if configuration["restartRequired"] == true {
            Some("Configuration update pending · restarting when background work settles".into())
        } else {
            None
        };
        if changed_model {
            self.status = "Model configuration updated · applies to new submissions".into();
            self.queue("areal/model/list", json!({}), Purpose::Models)?;
        }
        self.dirty = true;
        Ok(())
    }

    pub fn refresh(&mut self) -> Result<()> {
        if !self.connected {
            return Ok(());
        }
        if self.monitor_configuration
            && !self
                .pending
                .values()
                .chain(self.outbox.iter())
                .any(|r| matches!(r.purpose, Purpose::Configuration))
        {
            self.queue("areal/server/status", json!({}), Purpose::Configuration)?;
        }
        if self.agent_panel() {
            let parents: Vec<_> = self
                .nav_rows()
                .into_iter()
                .filter_map(|r| match r.target {
                    NavTarget::Thread(id) if self.expanded.contains(&id) => Some(id),
                    _ => None,
                })
                .collect();
            if !parents.is_empty() {
                let id = parents[self.refresh_cursor % parents.len()].clone();
                self.refresh_cursor = self.refresh_cursor.wrapping_add(1);
                // 分页尚未读完时保留游标，避免定时刷新不断把用户送回第一页。
                if self
                    .pages
                    .get(&Some(id.clone()))
                    .is_none_or(|p| p.cursor.is_none())
                {
                    self.load_page(Some(id), true)?;
                }
            }
        }
        self.sync_subscriptions()?;
        if let Some(thread) = self.current()
            && thread.goals.goal.as_ref().is_some_and(|g| g.rsi.is_some())
            && !self.in_flight("areal/goal/get", "threadId", &thread.id)
        {
            let id = thread.id.clone();
            self.queue("areal/goal/get", json!({"threadId":id}), Purpose::Ordinary)?;
        }
        if let Some(thread) = self.current()
            && let Some(turn) = thread.turns.last()
            && let Some(goal) = &thread.goals.goal
            && turn.status == TurnStatus::InProgress
            && goal.active_turn_id.is_none()
            && !goal.settling
            && goal.status != areal_protocol::goals::GoalStatus::Active
            && turn.goal.as_ref().is_some_and(|g| g.goal_id == goal.id)
        {
            let id = thread.id.clone();
            let fingerprint = (turn.id.clone(), thread.goals.event_sequence);
            if self.resynced.get(&id) != Some(&fingerprint)
                && !self.in_flight("areal/thread/observe", "threadId", &id)
            {
                self.queue(
                    "areal/thread/observe",
                    json!({"threadId":id}),
                    Purpose::Resume(id.clone()),
                )?;
                self.resynced.insert(id.clone(), fingerprint);
                self.syncing.insert(id);
            }
        }
        self.watch_group()
    }
    fn watch_group(&mut self) -> Result<()> {
        if !self.connected || self.view != View::Groups || Instant::now() < self.group_retry {
            return Ok(());
        }
        let Some(id) = self.group_id.clone() else {
            return Ok(());
        };
        if self.pending.values().chain(self.outbox.iter()).any(|r| {
            matches!(
                r.method.as_str(),
                "areal/workgroup/wait" | "areal/execution/wait" | "areal/execution/read"
            )
        }) {
            return Ok(());
        }
        if self.execution_view {
            if let Some(execution) = &self.group
                && execution["executionId"].as_str() == Some(&id)
                && execution["settled"] == false
            {
                let parent = self.selected.clone().context("Select a task first")?;
                if execution["status"] == "awaitingDelivery" {
                    // 只读等待在候选就绪时提前返回；交付阶段按间隔刷新，避免紧循环。
                    self.group_retry = Instant::now() + Duration::from_secs(2);
                    self.queue(
                        "areal/execution/read",
                        json!({"parentThreadId":parent,"executionId":id}),
                        Purpose::Group(self.group_generation),
                    )?;
                } else {
                    self.queue(
                        "areal/execution/wait",
                        json!({"parentThreadId":parent,"executionId":id,"timeoutMs":3000}),
                        Purpose::Group(self.group_generation),
                    )?;
                }
            }
            return Ok(());
        }
        if let Some(group) = &self.group
            && group["id"].as_str() == Some(&id)
            && group["record"]["status"].as_str() == Some("running")
        {
            let revision = group["record"]["revision"].as_u64().unwrap_or(0);
            self.queue(
                "areal/workgroup/wait",
                json!({"id":id,"afterRevision":revision,"timeoutMs":3000}),
                Purpose::Group(self.group_generation),
            )?;
        }
        Ok(())
    }
    fn show_executions(&mut self) -> Result<()> {
        ensure!(
            self.capabilities.is_empty() || self.capabilities.contains("areal/execution/list"),
            "This Core does not provide unified subtask execution; legacy history is available with /groups"
        );
        let parent = self.selected.clone().context("Select a task first")?;
        self.view = View::Groups;
        self.groups.clear();
        self.execution_next_offset = None;
        self.execution_view = true;
        self.focus = Focus::Navigation;
        self.group = None;
        self.group_id = None;
        self.group_generation += 1;
        self.queue(
            "areal/execution/list",
            json!({"parentThreadId":parent,"offset":0,"limit":50}),
            Purpose::Group(self.group_generation),
        )
    }
    fn show_groups(&mut self) -> Result<()> {
        ensure!(
            self.capabilities.is_empty() || self.capabilities.contains("areal/workgroup/list"),
            "This Core has no Workgroup service configured"
        );
        if self.execution_view {
            self.groups.clear();
            self.group = None;
            self.group_id = None;
        }
        self.execution_view = false;
        self.view = View::Groups;
        self.focus = Focus::Navigation;
        self.group_generation += 1;
        self.queue(
            "areal/workgroup/list",
            json!({}),
            Purpose::Group(self.group_generation),
        )
    }
    fn open_group(&mut self, id: &str) -> Result<()> {
        self.view = View::Groups;
        self.group_id = Some(id.into());
        self.group = None;
        self.group_scroll = 0;
        self.nav_selected = Some(NavTarget::Group(id.into()));
        self.group_generation += 1;
        let (method, params) = if self.execution_view {
            let parent = self.selected.clone().context("Select a task first")?;
            (
                "areal/execution/read",
                json!({"parentThreadId":parent,"executionId":id}),
            )
        } else {
            ("areal/workgroup/read", json!({"id":id}))
        };
        self.queue(method, params, Purpose::Group(self.group_generation))
    }
    pub fn submit(&mut self) -> Result<bool> {
        let input = self.input.trim().to_owned();
        if input.is_empty() {
            return Ok(false);
        }
        match input.as_str() {
            "/goal" | "/rsi-refresh" => {
                let id = self.selected.clone().context("Create a thread first")?;
                self.queue("areal/goal/get", json!({"threadId":id}), Purpose::Ordinary)?;
            }
            "/rsi-evolve" | "/rsi-evaluate" => {
                anyhow::bail!("Usage: /rsi-evolve JSON_FILE or /rsi-evaluate JSON_FILE")
            }
            "/rsi-goal" => anyhow::bail!("Usage: /rsi-goal TEXT"),
            "/rsi-select" => anyhow::bail!("Usage: /rsi-select CANDIDATE"),
            "/rsi-artifact" => anyhow::bail!("Usage: /rsi-artifact CANDIDATE [OFFSET]"),
            "/goal-pause" | "/goal-resume" | "/goal-clear" => {
                self.goal_control(input.strip_prefix("/goal-").unwrap(), None)?
            }
            "/quit" => return Ok(true),
            "/new" => {
                self.new_thread()?;
                self.view = View::Conversation;
            }
            "/sessions" | "/list" => {
                self.picker = Some(Picker::new(PickerKind::Sessions));
                self.load_page(None, true)?;
            }
            "/permissions" => {
                let id = self.selected.clone().context("Create a thread first")?;
                self.view = View::Permissions;
                self.permission_scroll = 0;
                self.queue(
                    "areal/permissions/read",
                    json!({"threadId":id}),
                    Purpose::Permissions(id),
                )?;
            }
            "/permissions clear-session" | "/permissions clear-project" => {
                let id = self.selected.clone().context("Create a thread first")?;
                self.queue(
                    "areal/permissions/forget",
                    json!({"threadId":id,"project":input.ends_with("clear-project")}),
                    Purpose::ForgetPermissions(id),
                )?;
            }
            "/model" => {
                self.picker = Some(Picker::new(PickerKind::Models));
                self.queue("areal/model/list", json!({}), Purpose::Models)?;
            }
            "/skills" => {
                let id = self.selected.clone().context("Create a thread first")?;
                self.picker = Some(Picker::new(PickerKind::Skills));
                self.queue("areal/skill/list", json!({"threadId":id}), Purpose::Skills)?;
            }
            "/tasks" => {
                self.view = View::Tasks;
                self.focus = Focus::Navigation;
                self.prepare_context()?;
                self.sync_subscriptions()?;
            }
            "/agents" | "/executions" => self.show_executions()?,
            "/topology" => self.topology(false)?,
            "/groups" => self.show_groups()?,
            "/help" => self.view = View::Help,
            "/welcome" => self.view = View::Welcome,
            "/theme" => self.theme_original = Some(self.prefs.theme),
            "/details" => self.toggle_details(),
            "/restore-input" => {
                let id = self.selected.as_ref().context("Select a session first")?;
                let failure = self
                    .submission_failures
                    .get(id)
                    .context("No failed submission to restore")?;
                self.input = failure.input.clone();
                self.input_cursor = self.input.len();
                self.completion_dismissed = true;
                return Ok(false);
            }
            "/more" if self.view == View::Groups && self.execution_view => {
                let parent = self.selected.clone().context("Select a task first")?;
                if let Some(offset) = self.execution_next_offset {
                    self.queue(
                        "areal/execution/list",
                        json!({"parentThreadId":parent,"offset":offset,"limit":50}),
                        Purpose::Group(self.group_generation),
                    )?;
                }
            }
            "/more" => {
                let parent = if self.agent_panel() {
                    self.tree_root.clone()
                } else {
                    None
                };
                self.load_page(parent, false)?;
            }
            _ => {
                if let Some(text) = input.strip_prefix("/goal ") {
                    let thread = self.current().context("Create a thread first")?;
                    self.queue("areal/goal/create", json!({"threadId":thread.id,"requestId":crate::goal_request_id(),"expectedRevision":thread.goals.revision,"objective":text}), Purpose::Ordinary)?;
                } else if input.starts_with("/rsi-evolve ") || input.starts_with("/rsi-evaluate ") {
                    let (command, path) = input.split_once(' ').unwrap();
                    let extra: Value = serde_json::from_slice(&std::fs::read(path.trim())?)?;
                    self.goal_control(
                        if command == "/rsi-evolve" {
                            "evolve"
                        } else {
                            "evaluateCandidate"
                        },
                        Some(extra),
                    )?;
                } else if let Some(text) = input.strip_prefix("/rsi-goal ") {
                    let thread = self.current().context("Create a thread first")?;
                    self.queue("areal/goal/create", json!({"threadId":thread.id,"requestId":crate::goal_request_id(),"expectedRevision":thread.goals.revision,"objective":text.strip_prefix("--html ").unwrap_or(text),"workflow":"rsiArtifact","outputFormat":if text.starts_with("--html ") { "html" } else { "markdown" }}), Purpose::Ordinary)?;
                } else if let Some(text) = input.strip_prefix("/rsi-select ") {
                    self.goal_control("selectCandidate", Some(json!({"candidateId":text.trim()})))?;
                } else if let Some(text) = input.strip_prefix("/rsi-artifact ") {
                    let mut parts = text.split_whitespace();
                    let candidate = parts
                        .next()
                        .context("Usage: /rsi-artifact CANDIDATE [OFFSET]")?;
                    let offset = parts
                        .next()
                        .map(str::parse::<usize>)
                        .transpose()?
                        .unwrap_or(0);
                    ensure!(
                        parts.next().is_none(),
                        "Usage: /rsi-artifact CANDIDATE [OFFSET]"
                    );
                    let thread = self.current().context("Select a thread first")?;
                    let goal = thread.goals.goal.as_ref().context("No current goal")?;
                    self.queue("areal/goal/candidateArtifact", json!({"threadId":thread.id,"goalId":goal.id,"candidateId":candidate,"offset":offset}), Purpose::Ordinary)?;
                } else if let Some(text) = input.strip_prefix("/goal-edit ") {
                    self.goal_control("update", Some(json!({"objective":text})))?;
                } else if let Some(value) = input.strip_prefix("/goal-budget ") {
                    let budget = if value == "none" {
                        Value::Null
                    } else {
                        json!(value.parse::<u64>()?)
                    };
                    self.goal_control("update", Some(json!({"tokenBudget":budget})))?;
                } else if let Some(name) = input.strip_prefix("/skill ") {
                    let query = name.trim().to_lowercase();
                    let index = self
                        .skills
                        .iter()
                        .position(|skill| {
                            skill.id.to_lowercase() == query || skill.label.to_lowercase() == query
                        })
                        .context("Skill not found; use /skills to choose one")?;
                    self.choose_skill(index)?;
                } else if let Some(prefix) = input.strip_prefix("/open ") {
                    let matches: Vec<_> = self
                        .threads
                        .keys()
                        .filter(|id| id.starts_with(prefix.trim()))
                        .cloned()
                        .collect();
                    ensure!(
                        matches.len() <= 1,
                        "Ambiguous thread prefix; enter more characters"
                    );
                    self.view = View::Conversation;
                    self.open(matches.first().map_or(prefix.trim(), String::as_str))?;
                } else if let Some(prompt) = input.strip_prefix("/spawn ") {
                    let parent = self.selected.as_ref().context("Create a thread first")?;
                    self.queue(
                        "areal/agent/delegate",
                        json!({"requestId":crate::goal_request_id(),"parentThreadId":parent,"input":[{"type":"text","text":prompt}]}),
                        Purpose::Ordinary,
                    )?;
                } else if let Some(path) = input
                    .strip_prefix("/group-start ")
                    .or_else(|| input.strip_prefix("/group-revise "))
                {
                    let method = if input.starts_with("/group-start ") {
                        "areal/workgroup/start"
                    } else {
                        "areal/workgroup/revise"
                    };
                    let params = serde_json::from_slice(&std::fs::read(path.trim())?)?;
                    self.view = View::Groups;
                    self.execution_view = false;
                    self.group_generation += 1;
                    self.queue(method, params, Purpose::Group(self.group_generation))?;
                } else if let Some(id) = input.strip_prefix("/execution-cancel ") {
                    let parent = self.selected.clone().context("Select a task first")?;
                    self.execution_view = true;
                    self.view = View::Groups;
                    self.group_generation += 1;
                    self.queue(
                        "areal/execution/cancel",
                        json!({"parentThreadId":parent,"executionId":id.trim(),"mode":"graceful"}),
                        Purpose::Group(self.group_generation),
                    )?;
                } else if let Some(id) = input.strip_prefix("/group-cancel ") {
                    self.execution_view = false;
                    self.group_generation += 1;
                    self.group_id = Some(id.trim().into());
                    self.group = None;
                    self.view = View::Groups;
                    self.queue(
                        "areal/workgroup/cancel",
                        json!({"id":id.trim()}),
                        Purpose::Group(self.group_generation),
                    )?;
                } else if let Some(id) = input.strip_prefix("/group ") {
                    self.execution_view = false;
                    self.open_group(id.trim())?;
                } else if input.starts_with('/') {
                    bail!("Unknown command. Use /help.");
                } else {
                    let thread = self
                        .selected
                        .as_ref()
                        .context("Create or open a thread first")?;
                    ensure!(
                        self.subscriptions.contains(thread),
                        "Wait for the session snapshot before sending"
                    );
                    ensure!(
                        !self.in_flight("areal/thread/configure", "threadId", thread),
                        "Wait for the model change to finish before sending"
                    );
                    if let Some(turn) = self.active() {
                        self.queue("turn/steer", json!({"threadId":thread,"expectedTurnId":turn.id,"input":[{"type":"text","text":input}]}), Purpose::Ordinary)?;
                    } else {
                        self.queue(
                            "turn/start",
                            json!({"threadId":thread,"input":[{"type":"text","text":input}]}),
                            Purpose::Ordinary,
                        )?;
                    }
                    if matches!(self.view, View::Welcome | View::Help | View::Permissions) {
                        self.view = View::Conversation;
                    }
                    if let Some(h) = self.history() {
                        h.end();
                    }
                }
            }
        }
        self.input.clear();
        self.input_cursor = 0;
        self.completion_index = 0;
        self.completion_dismissed = false;
        self.dirty = true;
        Ok(false)
    }
    pub fn completions(&self) -> Vec<&'static commands::Command> {
        if self.focus != Focus::Input
            || self.picker.is_some()
            || self.theme_original.is_some()
            || self.completion_dismissed
        {
            return Vec::new();
        }
        commands::candidates(&self.input)
    }
    pub fn session_choices(&self) -> Vec<NavTarget> {
        let query = self
            .picker
            .as_ref()
            .map_or("", |p| p.query.as_str())
            .to_lowercase();
        let mut threads: Vec<_> = self
            .threads
            .values()
            .filter(|t| {
                t.id.to_lowercase().contains(&query) || t.preview.to_lowercase().contains(&query)
            })
            .collect();
        threads.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let mut rows: Vec<_> = threads
            .into_iter()
            .map(|t| NavTarget::Thread(t.id.clone()))
            .collect();
        if self.pages.get(&None).is_some_and(|p| p.cursor.is_some()) {
            rows.push(NavTarget::More(None));
        }
        rows
    }
    pub fn model_choices(&self) -> Vec<usize> {
        let query = self
            .picker
            .as_ref()
            .map_or("", |p| p.query.as_str())
            .to_lowercase();
        self.models
            .iter()
            .enumerate()
            .filter_map(|(i, m)| m.label.to_lowercase().contains(&query).then_some(i))
            .collect()
    }
    pub fn skill_choices(&self) -> Vec<usize> {
        let query = self
            .picker
            .as_ref()
            .map_or("", |p| p.query.as_str())
            .to_lowercase();
        self.skills
            .iter()
            .enumerate()
            .filter_map(|(i, skill)| {
                (skill.id.to_lowercase().contains(&query)
                    || skill.label.to_lowercase().contains(&query)
                    || skill.description.to_lowercase().contains(&query))
                .then_some(i)
            })
            .collect()
    }
    pub fn model_label(&self) -> String {
        self.current()
            .and_then(|t| t.desktop.as_ref())
            .and_then(|d| d.configuration.model.as_ref())
            .map_or_else(
                || self.default_model.clone(),
                |m| format!("{} / {}", m.provider_id, m.model_id),
            )
    }
    fn choose_model(&mut self, index: usize) -> Result<()> {
        let choice = self
            .models
            .get(index)
            .context("Choose a model from the catalog")?
            .clone();
        ensure!(
            choice.available,
            "Model unavailable; configure its provider and credentials first"
        );
        let thread = self.current().context("Create or open a session first")?;
        ensure!(
            self.connected && self.subscriptions.contains(&thread.id),
            "Wait for the session snapshot before changing models"
        );
        ensure!(
            self.active().is_none() && !matches!(thread.status, ThreadStatus::Active { .. }),
            "Wait for this Turn to finish, or cancel it before changing models"
        );
        ensure!(
            !self.in_flight("areal/thread/configure", "threadId", &thread.id),
            "A model change is already pending"
        );
        let config = thread.desktop.as_ref().map(|d| &d.configuration);
        if choice.model.is_none() && config.is_none_or(|c| c.model.is_none()) {
            self.picker = None;
            self.status = format!("Model unchanged: {}", self.model_label());
            return Ok(());
        }
        let id = thread.id.clone();
        let mut params = json!({"threadId":id,"expectedRevision":config.map_or(1, |c| c.revision),"parameters":{}});
        if let Some(model) = choice.model {
            params["model"] = json!(model);
        } else {
            ensure!(
                self.model_reset_supported,
                "This Core cannot reset a model override; update the server first"
            );
            params["resetModel"] = json!(true);
        }
        self.queue("areal/thread/configure", params, Purpose::Configure(id))?;
        self.status = "Changing model…".into();
        Ok(())
    }
    fn choose_skill(&mut self, index: usize) -> Result<()> {
        let choice = self.skills.get(index).context("Choose a skill")?.clone();
        ensure!(
            choice.available,
            "Skill unavailable; refresh the skill list"
        );
        let thread = self.current().context("Create or open a session first")?;
        ensure!(
            self.connected && self.subscriptions.contains(&thread.id),
            "Wait for the session snapshot before changing skills"
        );
        ensure!(
            self.active().is_none() && !matches!(thread.status, ThreadStatus::Active { .. }),
            "Wait for this Turn to finish before changing skills"
        );
        ensure!(
            !self.in_flight("areal/thread/configure", "threadId", &thread.id),
            "A session change is already pending"
        );
        let config = thread.desktop.as_ref().map(|d| &d.configuration);
        let id = thread.id.clone();
        self.queue(
            "areal/thread/configure",
            json!({
                "threadId": id,
                "expectedRevision": config.map_or(1, |c| c.revision),
                "selectedSkills": [{"id": choice.id, "revision": choice.revision}],
            }),
            Purpose::Configure(thread.id.clone()),
        )?;
        self.status = format!("Selecting skill: {}…", choice.label);
        Ok(())
    }
    fn picker_key(&mut self, code: KeyCode) -> Result<()> {
        let picker = self.picker.as_ref().unwrap();
        let (kind, selected) = (picker.kind, picker.selected);
        let count = match kind {
            PickerKind::Sessions => self.session_choices().len(),
            PickerKind::Models => self.model_choices().len(),
            PickerKind::Skills => self.skill_choices().len(),
        };
        match code {
            KeyCode::Esc => self.picker = None,
            KeyCode::Up | KeyCode::Down => {
                self.picker.as_mut().unwrap().selected = if code == KeyCode::Up {
                    selected.saturating_sub(1)
                } else {
                    (selected + 1).min(count.saturating_sub(1))
                };
            }
            KeyCode::Enter => match kind {
                PickerKind::Sessions => {
                    if let Some(target) = self.session_choices().get(selected).cloned() {
                        match target {
                            NavTarget::Thread(id) => {
                                self.open(&id)?;
                                self.view = View::Conversation;
                                self.picker = None;
                                self.focus = Focus::Input;
                            }
                            NavTarget::More(_) => self.load_page(None, false)?,
                            _ => {}
                        }
                    }
                }
                PickerKind::Models => {
                    if let Some(index) = self.model_choices().get(selected) {
                        self.choose_model(*index)?;
                    }
                }
                PickerKind::Skills => {
                    if let Some(index) = self.skill_choices().get(selected) {
                        self.choose_skill(*index)?;
                    }
                }
            },
            KeyCode::Backspace => {
                let picker = self.picker.as_mut().unwrap();
                let end = picker
                    .query
                    .grapheme_indices(true)
                    .next_back()
                    .map_or(0, |(i, _)| i);
                picker.query.truncate(end);
                picker.selected = 0;
            }
            KeyCode::Char(c) => {
                let picker = self.picker.as_mut().unwrap();
                if picker.query.len() < 256 {
                    picker.query.push(c);
                    picker.selected = 0;
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn paste(&mut self, text: &str) {
        if self.theme_original.is_some() || self.pending_approval().is_some() {
            return;
        }
        let text = safe_text(text);
        if let Some(picker) = &mut self.picker {
            if picker.query.len() + text.len() <= 256 {
                picker.query.push_str(&text.replace(['\n', '\t'], " "));
                picker.selected = 0;
            }
        } else if self.focus == Focus::Input {
            self.insert_input(&text);
        }
        self.dirty = true;
    }
    fn previous_input_boundary(&self) -> usize {
        self.input[..self.input_cursor]
            .grapheme_indices(true)
            .next_back()
            .map_or(0, |(i, _)| i)
    }
    fn next_input_boundary(&self) -> usize {
        self.input[self.input_cursor..]
            .graphemes(true)
            .next()
            .map_or(self.input.len(), |g| self.input_cursor + g.len())
    }
    /// Codex insert-mode `move_word_left`（Option+← / Alt+b）：跳过光标前的空白，落到上一词开头。
    ///
    /// 词按 Unicode 词边界再按标点拆开；连续标点算同一个词。光标只落在完整字素上。
    fn previous_input_word(&self) -> usize {
        word_boundary(&self.input, self.input_cursor, false)
    }
    /// Codex insert-mode `move_word_right`（Option+→ / Alt+f）：跳过光标后的空白，落到下一词结尾。
    fn next_input_word(&self) -> usize {
        word_boundary(&self.input, self.input_cursor, true)
    }
    fn input_changed(&mut self) {
        // 插入或删除可能合并相邻字素，光标必须重新对齐到完整字素之后。
        self.input_cursor = self
            .input
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .find(|i| *i >= self.input_cursor)
            .unwrap_or(self.input.len());
        self.completion_index = 0;
        self.completion_dismissed = false;
    }
    fn insert_input(&mut self, text: &str) {
        if self.input.len() + text.len() > 64 * 1024 {
            return;
        }
        self.input.insert_str(self.input_cursor, text);
        self.input_cursor += text.len();
        self.input_changed();
        if self.view == View::Welcome {
            self.view = View::Conversation;
        }
    }
    fn delete_input(&mut self, backward: bool) {
        let (start, end) = if backward {
            (self.previous_input_boundary(), self.input_cursor)
        } else {
            (self.input_cursor, self.next_input_boundary())
        };
        if start == end {
            return;
        }
        self.input.replace_range(start..end, "");
        self.input_cursor = start;
        self.input_changed();
    }
    fn update_configuration(&mut self, id: &str, value: &Value) -> Result<()> {
        let config: areal_protocol::desktop::EffectiveConfig =
            serde_json::from_value(value.clone())?;
        if let Some(thread) = self.threads.get_mut(id) {
            let desktop = thread.desktop.get_or_insert_with(Default::default);
            if config.revision >= desktop.configuration.revision {
                desktop.configuration = config;
            }
        }
        Ok(())
    }
    fn goal_control(&mut self, action: &str, patch: Option<Value>) -> Result<()> {
        let thread = self.current().context("Select a thread first")?;
        let goal = thread.goals.goal.as_ref().context("No current goal")?;
        let mut params = json!({"threadId":thread.id,"requestId":crate::goal_request_id(),"goalId":goal.id,"expectedRevision":thread.goals.revision});
        if let Some(Value::Object(patch)) = patch {
            params.as_object_mut().unwrap().extend(patch);
        }
        self.queue(&format!("areal/goal/{action}"), params, Purpose::Ordinary)
    }
    fn toggle_details(&mut self) {
        self.view = View::Conversation;
        if let Some(history) = self.history() {
            history.toggle_details();
        }
        self.dirty = true;
    }
    pub fn mouse(&mut self, event: MouseEvent) {
        if self.pending_approval().is_some() {
            match event.kind {
                MouseEventKind::ScrollUp => {
                    self.interaction_scroll = self.interaction_scroll.saturating_sub(3)
                }
                MouseEventKind::ScrollDown => {
                    self.interaction_scroll = self.interaction_scroll.saturating_add(3)
                }
                _ => {}
            }
            self.dirty = true;
            return;
        }

        if !self.prefs.mouse || self.picker.is_some() || self.theme_original.is_some() {
            self.mouse_down = None;
            return;
        }
        let Some((id, area)) = self
            .history_area
            .clone()
            .filter(|(id, _)| self.selected.as_ref() == Some(id))
        else {
            return;
        };
        let inside = event.column >= area.x
            && event.column < area.right()
            && event.row >= area.y
            && event.row < area.bottom();
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) if inside => {
                self.mouse_down = self
                    .histories
                    .get(&id)
                    .and_then(|h| h.hit(usize::from(event.row - area.y)))
                    .map(|key| (id.clone(), key));
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let down = self.mouse_down.take();
                if inside
                    && let Some(history) = self.histories.get_mut(&id)
                    // 增量可在按下和松开间到达；比较内容身份，避免误点或每个增量都取消点击。
                    && down.is_some()
                    && down == history.hit(usize::from(event.row - area.y)).map(|key| (id, key))
                {
                    self.focus = Focus::Content;
                    history.click(usize::from(event.row - area.y));
                    self.dirty = true;
                }
                self.mouse_down = None;
            }
            MouseEventKind::Drag(_) => self.mouse_down = None,
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown if inside => {
                self.mouse_down = None;
                if let Some(history) = self.histories.get_mut(&id) {
                    history.move_by(if event.kind == MouseEventKind::ScrollUp {
                        -3
                    } else {
                        3
                    });
                }
                self.dirty = true;
            }
            _ => self.mouse_down = None,
        }
    }
    pub fn pending_approval(&self) -> Option<&areal_protocol::desktop::Interaction> {
        fn pending(thread: &Thread) -> Option<&areal_protocol::desktop::Interaction> {
            thread.desktop.as_ref().and_then(|d| {
                d.interactions
                    .iter()
                    .find(|i| i.kind == "approval" && i.status == "pending")
            })
        }
        if let Some(thread) = self.current()
            && let Some(i) = pending(thread)
        {
            return Some(i);
        }
        self.threads
            .values()
            .filter(|t| Some(&t.id) != self.selected.as_ref())
            .find_map(pending)
    }
    pub fn approval_selection(&self) -> usize {
        if self.pending_approval().map(|i| i.request_id.as_str())
            == self.approval_request.as_deref()
        {
            self.approval_choice
        } else {
            0
        }
    }
    pub fn approval_choices(&self) -> Vec<(&'static str, &'static str)> {
        let mut choices = vec![("deny", "Deny"), ("allowOnce", "Allow once")];
        if self
            .pending_approval()
            .and_then(|i| i.effective_permissions.as_ref())
            .is_some_and(|p| p["rememberAllowed"] == true)
        {
            choices.extend([
                ("allowSession", "Remember exact request for this session"),
                ("allowProject", "Remember exact request for this project"),
            ]);
        }
        choices
    }
    pub fn key(&mut self, key: KeyEvent) -> Result<bool> {
        self.dirty = true;
        self.mouse_down = None;
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('q') => return Ok(true),
                KeyCode::Char('c') => {
                    if self
                        .current()
                        .and_then(|t| t.goals.goal.as_ref())
                        .is_some_and(|g| g.status == areal_protocol::goals::GoalStatus::Active)
                    {
                        self.goal_control("pause", None)?;
                    } else if let Some(turn) = self.active() {
                        self.queue(
                            "turn/interrupt",
                            json!({"threadId":self.selected,"turnId":turn.id}),
                            Purpose::Ordinary,
                        )?;
                    }
                }
                KeyCode::Char('r') => self.reconnect_requested = true,
                KeyCode::Char('o') if self.picker.is_none() && self.theme_original.is_none() => {
                    self.toggle_details()
                }
                KeyCode::Char(c)
                    if self.focus == Focus::Input
                        && self.picker.is_none()
                        && self.theme_original.is_none()
                        && self.pending_approval().is_none() =>
                {
                    match c {
                        'a' => {
                            self.input_cursor = self.input[..self.input_cursor]
                                .rfind('\n')
                                .map_or(0, |i| i + 1);
                        }
                        'e' => {
                            self.input_cursor = self.input[self.input_cursor..]
                                .find('\n')
                                .map_or(self.input.len(), |i| self.input_cursor + i);
                        }
                        'd' => self.delete_input(false),
                        _ => {}
                    }
                }
                _ => {}
            }
            return Ok(false);
        }
        if let Some(interaction) = self.pending_approval().cloned() {
            if self.approval_request.as_deref() != Some(&interaction.request_id) {
                self.approval_request = Some(interaction.request_id.clone());
                self.approval_choice = 0;
                self.interaction_scroll = 0;
            }
            let choices = self.approval_choices();
            match key.code {
                KeyCode::Up => self.approval_choice = self.approval_choice.saturating_sub(1),
                KeyCode::Down => {
                    self.approval_choice = (self.approval_choice + 1).min(choices.len() - 1)
                }
                KeyCode::PageUp => {
                    self.interaction_scroll = self.interaction_scroll.saturating_sub(10)
                }
                KeyCode::PageDown => {
                    self.interaction_scroll = self.interaction_scroll.saturating_add(10)
                }
                KeyCode::Enter | KeyCode::Esc => {
                    let decision = if key.code == KeyCode::Esc {
                        "deny"
                    } else {
                        choices[self.approval_choice.min(choices.len() - 1)].0
                    };
                    if !self.pending.values().chain(self.outbox.iter()).any(|r| matches!(&r.purpose, Purpose::Interaction(id) if *id == interaction.thread_id)) {
                        self.queue("areal/interaction/respond", json!({"threadId":interaction.thread_id,"turnId":interaction.turn_id,"requestId":interaction.request_id,"argumentsDigest":interaction.arguments_digest,"decision":decision}), Purpose::Interaction(interaction.thread_id))?;
                        self.approval_choice = 0;
                        self.interaction_scroll = 0;
                    }
                }
                _ => {}
            }
            return Ok(false);
        }
        if let Some(original) = self.theme_original {
            match key.code {
                KeyCode::Esc => {
                    self.prefs.theme = original;
                    self.theme_original = None;
                }
                KeyCode::Up | KeyCode::Left | KeyCode::Down | KeyCode::Right => {
                    let index = Theme::ALL
                        .iter()
                        .position(|t| *t == self.prefs.theme)
                        .unwrap();
                    let next = if matches!(key.code, KeyCode::Up | KeyCode::Left) {
                        (index + 2) % 3
                    } else {
                        (index + 1) % 3
                    };
                    self.prefs.theme = Theme::ALL[next];
                }
                KeyCode::Enter => {
                    self.theme_original = None;
                    self.status = match self.prefs.save() {
                        Ok(()) => format!("Theme saved: {}", self.prefs.theme.name()),
                        Err(e) => format!("Theme applied for this session only: {e}"),
                    };
                }
                _ => {}
            }
            return Ok(false);
        }
        if self.picker.is_some() {
            self.picker_key(key.code)?;
            return Ok(false);
        }
        let completions = self.completions();
        if !completions.is_empty() {
            let index = self.completion_index.min(completions.len() - 1);
            match key.code {
                KeyCode::Up | KeyCode::Down => {
                    self.completion_index = if key.code == KeyCode::Up {
                        (index + completions.len() - 1) % completions.len()
                    } else {
                        (index + 1) % completions.len()
                    };
                    return Ok(false);
                }
                KeyCode::Tab | KeyCode::Enter
                    if key.code == KeyCode::Tab || self.input != completions[index].name =>
                {
                    let command = completions[index];
                    self.input = format!(
                        "{}{}",
                        command.name,
                        if command.argument.is_empty() { "" } else { " " }
                    );
                    self.input_cursor = self.input.len();
                    self.completion_index = 0;
                    self.completion_dismissed = true;
                    return Ok(false);
                }
                KeyCode::Esc => {
                    self.completion_dismissed = true;
                    return Ok(false);
                }
                _ => {}
            }
        }
        match key.code {
            KeyCode::F(1) => self.view = View::Help,
            KeyCode::F(2) => self.theme_original = Some(self.prefs.theme),
            KeyCode::F(3) => self.topology(false)?,
            KeyCode::F(4) => self.show_executions()?,
            KeyCode::F(5) => {
                self.picker = Some(Picker::new(PickerKind::Sessions));
                self.load_page(None, true)?;
            }
            KeyCode::F(6) => {
                self.picker = Some(Picker::new(PickerKind::Models));
                self.queue("areal/model/list", json!({}), Purpose::Models)?;
            }
            KeyCode::Tab | KeyCode::BackTab => {
                self.focus = match (self.focus, key.code == KeyCode::BackTab) {
                    (Focus::Input, false) | (Focus::Content, true) => Focus::Navigation,
                    (Focus::Navigation, false) | (Focus::Input, true) => Focus::Content,
                    _ => Focus::Input,
                };
            }
            KeyCode::Esc => {
                self.view = View::Conversation;
                self.focus = Focus::Input;
            }
            KeyCode::PageUp | KeyCode::PageDown | KeyCode::Home | KeyCode::End => {
                if self.view == View::Permissions {
                    self.permission_scroll = match key.code {
                        KeyCode::PageUp => self.permission_scroll.saturating_sub(10),
                        KeyCode::PageDown => self.permission_scroll.saturating_add(10),
                        KeyCode::Home => 0,
                        _ => self.permission_scroll.saturating_add(30),
                    };
                } else if matches!(self.view, View::Groups | View::Tasks)
                    && self.focus == Focus::Navigation
                {
                    let scroll = if self.view == View::Tasks {
                        &mut self.plan_scroll
                    } else {
                        &mut self.group_scroll
                    };
                    *scroll = match key.code {
                        KeyCode::PageUp => scroll.saturating_sub(10),
                        KeyCode::PageDown => scroll.saturating_add(10),
                        KeyCode::Home => 0,
                        _ => usize::MAX,
                    };
                } else if let Some(h) = self.history() {
                    match key.code {
                        KeyCode::PageUp => h.move_by(-(h.height as isize).max(1)),
                        KeyCode::PageDown => h.move_by(h.height as isize),
                        KeyCode::Home => h.home(),
                        _ => h.end(),
                    }
                    if matches!(self.view, View::Welcome | View::Help | View::Permissions) {
                        self.view = View::Conversation;
                    }
                }
            }
            _ if self.focus == Focus::Navigation => self.nav_key(key.code)?,
            KeyCode::Up | KeyCode::Down if self.focus == Focus::Content => {
                if let Some(h) = self.history() {
                    h.select_next(key.code == KeyCode::Down);
                }
            }
            KeyCode::Char(' ') | KeyCode::Enter | KeyCode::Left | KeyCode::Right
                if self.focus == Focus::Content =>
            {
                if let Some(h) = self.history() {
                    h.expand_selected(match key.code {
                        KeyCode::Left => Some(false),
                        KeyCode::Right => Some(true),
                        _ => None,
                    });
                }
            }
            KeyCode::Enter if self.focus == Focus::Input => return self.submit(),
            KeyCode::Left if self.focus == Focus::Input => {
                self.input_cursor = if key.modifiers.contains(KeyModifiers::ALT) {
                    self.previous_input_word()
                } else {
                    self.previous_input_boundary()
                };
            }
            KeyCode::Right if self.focus == Focus::Input => {
                self.input_cursor = if key.modifiers.contains(KeyModifiers::ALT) {
                    self.next_input_word()
                } else {
                    self.next_input_boundary()
                };
            }
            KeyCode::Backspace if self.focus == Focus::Input => {
                self.delete_input(true);
            }
            KeyCode::Delete if self.focus == Focus::Input => self.delete_input(false),
            // macOS Option 在非 Kitty 键盘协议下常把 Option+←/→ 发成 Alt+b / Alt+f。
            KeyCode::Char('b' | 'f')
                if self.focus == Focus::Input && key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.input_cursor = if key.code == KeyCode::Char('b') {
                    self.previous_input_word()
                } else {
                    self.next_input_word()
                };
            }
            KeyCode::Char(c) if self.focus == Focus::Input => {
                self.insert_input(c.encode_utf8(&mut [0; 4]));
            }
            _ => {}
        }
        Ok(false)
    }
    fn nav_key(&mut self, code: KeyCode) -> Result<()> {
        if self.view == View::Tasks {
            match code {
                KeyCode::Up => self.plan_scroll = self.plan_scroll.saturating_sub(1),
                KeyCode::Down => self.plan_scroll = self.plan_scroll.saturating_add(1),
                _ => {}
            }
            return Ok(());
        }
        let rows = self.nav_rows();
        if rows.is_empty() {
            return Ok(());
        }
        let index = rows
            .iter()
            .position(|r| Some(&r.target) == self.nav_selected.as_ref())
            .unwrap_or(0);
        match code {
            KeyCode::Up | KeyCode::Down => {
                let index = if code == KeyCode::Up {
                    index.saturating_sub(1)
                } else {
                    (index + 1).min(rows.len() - 1)
                };
                self.nav_selected = Some(rows[index].target.clone());
                self.sync_subscriptions()?;
            }
            KeyCode::Enter => match &rows[index].target {
                NavTarget::Thread(id) => {
                    self.view = View::Conversation;
                    self.open(id)?;
                    self.focus = Focus::Input;
                }
                NavTarget::More(parent) => self.load_page(parent.clone(), false)?,
                NavTarget::Group(id) => self.open_group(id)?,
            },
            KeyCode::Right | KeyCode::Char(' ') if self.agent_panel() => {
                if let NavTarget::Thread(id) = &rows[index].target {
                    if code == KeyCode::Char(' ') && self.expanded.remove(id) {
                        return self.sync_subscriptions();
                    }
                    self.expanded.insert(id.clone());
                    if self.pages.get(&Some(id.clone())).is_none_or(|p| !p.loaded) {
                        self.load_page(Some(id.clone()), true)?;
                    }
                    self.sync_subscriptions()?;
                }
            }
            KeyCode::Left if self.agent_panel() => {
                if let NavTarget::Thread(id) = &rows[index].target {
                    if !self.expanded.remove(id)
                        && let Some(parent) = self
                            .threads
                            .get(id)
                            .and_then(|t| t.parent_thread_id.clone())
                    {
                        self.nav_selected = Some(NavTarget::Thread(parent));
                    }
                    self.sync_subscriptions()?;
                }
            }
            KeyCode::Char('r') => {
                if self.view == View::Groups {
                    if self.execution_view {
                        self.show_executions()?;
                    } else {
                        self.show_groups()?;
                    }
                } else {
                    let parent = if self.agent_panel() {
                        match &rows[index].target {
                            NavTarget::Thread(id) => Some(id.clone()),
                            NavTarget::More(parent) => parent.clone(),
                            _ => None,
                        }
                    } else {
                        None
                    };
                    self.load_page(parent, true)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn nav_rows(&self) -> Vec<NavRow> {
        if self.view == View::Groups {
            return self
                .groups
                .iter()
                .filter_map(|g| g["executionId"].as_str().or_else(|| g["id"].as_str()))
                .map(|id| NavRow {
                    target: NavTarget::Group(id.into()),
                    depth: 0,
                    prefix: String::new(),
                })
                .collect();
        }
        let Some(root) = &self.tree_root else {
            return Vec::new();
        };
        let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for thread in self.threads.values() {
            if let Some(parent) = &thread.parent_thread_id {
                children.entry(parent).or_default().push(&thread.id);
            }
        }
        let mut rows = Vec::new();
        let mut stack = vec![(NavTarget::Thread(root.clone()), String::new(), 0, true)];
        let mut seen = BTreeSet::new();
        while let Some((target, prefix, depth, last)) = stack.pop() {
            if rows.len() >= 10_000 {
                break;
            }
            let branch = if depth == 0 {
                ""
            } else if self.prefs.ascii {
                if last { "`- " } else { "+- " }
            } else if last {
                "└─ "
            } else {
                "├─ "
            };
            rows.push(NavRow {
                target: target.clone(),
                depth,
                prefix: format!("{prefix}{branch}"),
            });
            let NavTarget::Thread(id) = target else {
                continue;
            };
            if !seen.insert(id.clone()) || !self.expanded.contains(&id) {
                continue;
            }
            let mut targets: Vec<_> = children
                .get(id.as_str())
                .into_iter()
                .flatten()
                .map(|id| NavTarget::Thread((*id).into()))
                .collect();
            if self
                .pages
                .get(&Some(id.clone()))
                .is_some_and(|p| p.cursor.is_some())
            {
                targets.push(NavTarget::More(Some(id)));
            }
            let next_prefix = if depth == 0 {
                String::new()
            } else {
                format!(
                    "{prefix}{}",
                    if last {
                        "   "
                    } else if self.prefs.ascii {
                        "|  "
                    } else {
                        "│  "
                    }
                )
            };
            let len = targets.len();
            for (i, target) in targets.into_iter().enumerate().rev() {
                stack.push((target, next_prefix.clone(), depth + 1, i + 1 == len));
            }
        }
        rows
    }
    fn merge_summary(&mut self, mut thread: Thread) {
        if let Some(old) = self.threads.get_mut(&thread.id) {
            // 摘要不含最新 Turn；历史只用于阅读，不能据此推断摘要节点的终态。
            thread.turns = std::mem::take(&mut old.turns);
            thread.context_checkpoint = old.context_checkpoint.take();
            if self.subscriptions.contains(&thread.id) {
                thread.status = old.status.clone();
                thread.desktop = old.desktop.take();
            }
            if old.goals.event_sequence >= thread.goals.event_sequence {
                thread.goals = old.goals.clone();
            }
        }
        self.freshness.insert(thread.id.clone(), Instant::now());
        self.threads.insert(thread.id.clone(), thread);
    }
    fn snapshot(&mut self, thread: Thread) {
        let id = thread.id.clone();
        self.retries.remove(&id);
        self.syncing.remove(&id);
        if let Some(old) = self.threads.get(&id) {
            for turn in &old.turns {
                self.observed.remove(&turn.id);
            }
        }
        self.histories.entry(id.clone()).or_default().invalidate();
        if let Some(turn) = thread
            .turns
            .last()
            .filter(|t| t.status == TurnStatus::InProgress)
        {
            self.observed
                .entry(turn.id.clone())
                .or_insert_with(Instant::now);
        }
        self.freshness.insert(id.clone(), Instant::now());
        if !thread.turns.is_empty()
            && self.selected.as_ref() == Some(&id)
            && self.view == View::Welcome
        {
            self.view = View::Conversation;
        }
        self.threads.insert(id, thread);
    }
    pub fn receive(&mut self, value: Value) -> Result<()> {
        self.dirty = true;
        if let Some(id) = value["id"].as_u64() {
            let Some(request) = self.pending.remove(&id) else {
                return Ok(());
            };
            if let Some(error) = value.get("error") {
                if let (Some(input), Some(thread_id)) = (
                    &request.submitted_input,
                    request.params["threadId"].as_str(),
                ) {
                    self.submission_failures.insert(
                        thread_id.into(),
                        SubmissionFailure {
                            message: crate::history::short_text(
                                error["message"].as_str().unwrap_or("Request failed"),
                                240,
                            ),
                            input: input.clone(),
                        },
                    );
                    if self.selected.as_deref() == Some(thread_id) && self.input.is_empty() {
                        self.input = input.clone();
                        self.input_cursor = self.input.len();
                    }
                }
                if let Purpose::Resume(id) = &request.purpose {
                    self.syncing.remove(id);
                }
                if let Purpose::Release(ids) = &request.purpose {
                    for id in ids {
                        self.releasing.remove(id);
                    }
                }
                self.group_retry = Instant::now() + Duration::from_secs(5);
                self.status = format!(
                    "{}: {}",
                    request.method,
                    safe_text(error["message"].as_str().unwrap_or("request failed"))
                );
                if matches!(
                    request.method.as_str(),
                    "areal/goal/selectCandidate"
                        | "areal/goal/evolve"
                        | "areal/goal/evaluateCandidate"
                ) {
                    if let Some(id) = request.params["threadId"].as_str() {
                        self.queue("areal/goal/get", json!({"threadId":id}), Purpose::Ordinary)?;
                    }
                    self.status
                        .push_str(" · refresh requested; inspect current state before retrying");
                }
                if let Purpose::Configure(id) = &request.purpose {
                    // revision 冲突后重新读取权威配置，保留选择器供用户重试。
                    self.queue(
                        "areal/thread/observe",
                        json!({"threadId":id}),
                        Purpose::Resume(id.clone()),
                    )?;
                }
                return Ok(());
            }
            if request.submitted_input.is_some()
                && let Some(id) = request.params["threadId"].as_str()
            {
                self.submission_failures.remove(id);
            }
            let result = &value["result"];
            // 列表刷新不能把键盘当前选择悄悄移到另一个会话。
            let picker_target = self
                .picker
                .as_ref()
                .filter(|p| p.kind == PickerKind::Sessions)
                .and_then(|p| self.session_choices().get(p.selected).cloned());
            let picker_model = self
                .picker
                .as_ref()
                .filter(|p| p.kind == PickerKind::Models)
                .and_then(|p| {
                    self.model_choices()
                        .get(p.selected)
                        .map(|i| self.models[*i].model.clone())
                });
            match request.purpose {
                Purpose::ForgetPermissions(id) => {
                    self.queue(
                        "areal/permissions/read",
                        json!({"threadId":id}),
                        Purpose::Permissions(id),
                    )?;
                }
                Purpose::Permissions(id) => {
                    if self.selected.as_ref() == Some(&id) {
                        self.permission_info = result.clone();
                    }
                }
                Purpose::Interaction(id) => {
                    self.queue(
                        "areal/thread/observe",
                        json!({"threadId":id}),
                        Purpose::Resume(id),
                    )?;
                }
                Purpose::Configuration => {
                    self.restart_ready = result["configuration"]["restartRequired"] == true
                        && result["restartSafe"] == true
                        && result["activeGoals"] == json!([])
                        && result["pendingQueueItems"] == 0;
                    self.configuration_changed(&result["configuration"])?;
                }
                Purpose::Models => {
                    let data = result["data"].as_array().context("Invalid model catalog")?;
                    let default = data.iter().find(|m| m["providerId"].is_null());
                    self.default_model = default
                        .and_then(|m| m["modelId"].as_str())
                        .unwrap_or("Not configured")
                        .into();
                    let profile_model = self
                        .current()
                        .and_then(|t| t.desktop.as_ref())
                        .and_then(|d| d.configuration.profile.as_ref())
                        .and_then(|p| p.model.as_ref());
                    self.models = vec![ModelChoice {
                        label: profile_model.map_or_else(
                            || format!("Default ({})", self.default_model),
                            |m| format!("Default (profile: {} / {})", m.provider_id, m.model_id),
                        ),
                        model: None,
                        available: profile_model.map_or(default.is_some(), |model| {
                            data.iter().any(|entry| {
                                entry["providerId"].as_str() == Some(&model.provider_id)
                                    && entry["modelId"].as_str() == Some(&model.model_id)
                                    && entry["available"].as_bool() == Some(true)
                            })
                        }),
                    }];
                    for entry in data {
                        if let (Some(provider), Some(model)) =
                            (entry["providerId"].as_str(), entry["modelId"].as_str())
                        {
                            self.models.push(ModelChoice {
                                label: format!("{provider} / {model}"),
                                model: Some(areal_protocol::desktop::ModelRef {
                                    provider_id: provider.into(),
                                    model_id: model.into(),
                                }),
                                available: entry["available"].as_bool().unwrap_or(false),
                            });
                        }
                    }
                }
                Purpose::Skills => {
                    let data = result["data"].as_array().context("Invalid skill catalog")?;
                    self.skills = data
                        .iter()
                        .map(|entry| SkillChoice {
                            id: entry["id"].as_str().unwrap_or_default().into(),
                            revision: entry["revision"].as_str().unwrap_or_default().into(),
                            label: entry["name"].as_str().unwrap_or_default().into(),
                            description: entry["description"].as_str().unwrap_or_default().into(),
                            available: entry["available"].as_bool().unwrap_or(false),
                        })
                        .collect();
                }
                Purpose::Configure(id) => {
                    self.update_configuration(&id, result)?;
                    if self.selected.as_ref() == Some(&id) {
                        let skill_change = self
                            .picker
                            .as_ref()
                            .is_some_and(|p| p.kind == PickerKind::Skills)
                            || request.params.get("selectedSkills").is_some();
                        self.status = if skill_change {
                            "Skill changed for later Turns".into()
                        } else {
                            format!("Model changed: {}", self.model_label())
                        };
                        if self.picker.as_ref().is_some_and(|p| {
                            matches!(p.kind, PickerKind::Models | PickerKind::Skills)
                        }) {
                            self.picker = None;
                        }
                    }
                }
                Purpose::Create(generation) => {
                    if let Some(mode) = result["permissionMode"].as_str() {
                        self.permission_mode = mode.into();
                    }
                    let thread: Thread = serde_json::from_value(result["thread"].clone())?;
                    self.subscriptions.insert(thread.id.clone());
                    if self.generation == generation {
                        self.selected = Some(thread.id.clone());
                        self.nav_selected = Some(NavTarget::Thread(thread.id.clone()));
                    }
                    self.snapshot(thread);
                }
                Purpose::Resume(id) => {
                    if let Some(mode) = result["permissionMode"].as_str() {
                        self.permission_mode = mode.into();
                    }
                    let thread: Thread = serde_json::from_value(result["thread"].clone())?;
                    ensure!(thread.id == id, "resume returned a different thread");
                    self.subscriptions.insert(id);
                    // resume 是新基线，必须替换旧投影，不能用旧 delta 覆盖服务端快照。
                    self.snapshot(thread);
                }
                Purpose::Summary(id) => {
                    let thread: Thread = serde_json::from_value(result["thread"].clone())?;
                    ensure!(thread.id == id, "read returned a different thread");
                    self.merge_summary(thread);
                }
                Purpose::Release(ids) => {
                    for id in ids {
                        self.subscriptions.remove(&id);
                        self.releasing.remove(&id);
                    }
                }
                Purpose::List { parent, generation } => {
                    let page = self.pages.entry(parent).or_default();
                    if page.generation != generation {
                        return Ok(());
                    }
                    page.loaded = true;
                    page.cursor = result["nextCursor"].as_str().map(str::to_owned);
                    if let Some(data) = result["data"].as_array() {
                        for entry in data {
                            self.merge_summary(serde_json::from_value(entry.clone())?);
                        }
                    }
                }
                Purpose::Group(generation) => {
                    if request.method.starts_with("areal/execution/")
                        && request.params["parentThreadId"].as_str() != self.selected.as_deref()
                    {
                        return Ok(());
                    }
                    if generation != self.group_generation {
                        return Ok(());
                    }
                    if let Some(data) = result["data"].as_array() {
                        if request.method == "areal/execution/list"
                            && request.params["offset"].as_u64().unwrap_or(0) > 0
                        {
                            for item in data {
                                if !self
                                    .groups
                                    .iter()
                                    .any(|old| old["executionId"] == item["executionId"])
                                {
                                    self.groups.push(item.clone());
                                }
                            }
                        } else {
                            self.groups = data.clone();
                        }
                        self.execution_next_offset = result["nextOffset"].as_u64();
                    }
                    if result["executionId"].is_string() {
                        self.group_id = result["executionId"].as_str().map(str::to_owned);
                        self.group = Some(result.clone());
                    }
                    if result["record"].is_object() {
                        self.group_id = result["id"].as_str().map(str::to_owned);
                        self.group = Some(result.clone());
                    }
                }
                Purpose::Ordinary => match request.method.as_str() {
                    "areal/capabilities" => {
                        self.model_reset_supported =
                            result["features"]["modelReset"].as_bool().unwrap_or(false);
                        self.capabilities = result["methods"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect();
                    }
                    "areal/goal/candidateArtifact" => {
                        use base64::{Engine, engine::general_purpose::STANDARD};
                        let bytes = STANDARD.decode(result["dataBase64"].as_str().unwrap_or(""))?;
                        let thread = request.params["threadId"].as_str().unwrap_or("");
                        let goal = request.params["goalId"].as_str().unwrap_or("");
                        let candidate = request.params["candidateId"].as_str().unwrap_or("");
                        let offset = request.params["offset"].as_u64().unwrap_or(0) as usize;
                        // 连续分页先拼接字节，避免 UTF-8 字符跨页时被永久替换。
                        if let Some((old_thread, old_goal, old_candidate, content)) =
                            &mut self.rsi_artifact
                            && old_thread == thread
                            && old_goal == goal
                            && old_candidate == candidate
                            && content.len() == offset
                        {
                            content.extend_from_slice(&bytes);
                        } else {
                            self.rsi_artifact =
                                Some((thread.into(), goal.into(), candidate.into(), bytes));
                        }
                        self.status = if result["complete"] == true {
                            "RSI artifact: complete".into()
                        } else {
                            format!(
                                "Next page: /rsi-artifact {} {}",
                                request.params["candidateId"].as_str().unwrap_or(""),
                                result["nextOffset"]
                            )
                        };
                    }
                    method if method.starts_with("areal/goal/") => {
                        if let Some(id) = result["threadId"].as_str()
                            && let Some(t) = self.threads.get_mut(id)
                        {
                            let sequence = result["eventSequence"].as_u64().unwrap_or(0);
                            if sequence >= t.goals.event_sequence {
                                t.goals.revision = result["revision"].as_u64().unwrap_or(0);
                                t.goals.event_sequence = sequence;
                                t.goals.goal = serde_json::from_value(result["goal"].clone())?;
                                self.histories.entry(id.into()).or_default().invalidate();
                            }
                        }
                    }
                    "areal/agent/delegate" => {
                        // 创建回包可能晚于用户后续导航，不能切换面板或重置选中项。
                        if let Some(id) = result["threadId"].as_str()
                            && !self.in_flight("thread/read", "threadId", id)
                        {
                            self.queue(
                                "thread/read",
                                json!({"threadId":id,"includeTurns":false}),
                                Purpose::Summary(id.into()),
                            )?;
                        }
                        if request.params["parentThreadId"].as_str() == self.selected.as_deref() {
                            self.status = format!(
                                "Subtask {}: {} · /executions for progress",
                                safe_text(result["title"].as_str().unwrap_or("created")),
                                result["status"].as_str().unwrap_or("unknown")
                            );
                            if self.view == View::Groups && self.execution_view {
                                if let Some(item) = self
                                    .groups
                                    .iter_mut()
                                    .find(|item| item["executionId"] == result["executionId"])
                                {
                                    *item = result.clone();
                                } else {
                                    self.groups.push(result.clone());
                                }
                            }
                        }
                    }
                    "areal/agent/spawn" => {
                        self.snapshot(serde_json::from_value(result["thread"].clone())?);
                    }
                    "turn/start" => {
                        if let Some(id) = request.params["threadId"].as_str() {
                            self.receive_turn(id, serde_json::from_value(result["turn"].clone())?);
                        }
                    }
                    _ => {}
                },
            }
            if let Some(target) = picker_target {
                let index = self.session_choices().iter().position(|row| *row == target);
                if let (Some(picker), Some(index)) = (&mut self.picker, index) {
                    picker.selected = index;
                }
            }
            if let Some(model) = picker_model {
                let index = self
                    .model_choices()
                    .iter()
                    .position(|i| self.models[*i].model == model);
                if let (Some(picker), Some(index)) = (&mut self.picker, index) {
                    picker.selected = index;
                }
            }
            self.prepare_context()?;
            if !self.tree_direct
                && let Some(root) = self.tree_root.clone()
            {
                let ancestor = self.root_for(&root);
                if ancestor != root {
                    self.tree_root = Some(ancestor.clone());
                    self.expanded.insert(ancestor.clone());
                    self.load_page(Some(ancestor), true)?;
                }
            }
            self.sync_subscriptions()?;
            self.watch_group()?;
            return Ok(());
        }
        let method = value["method"].as_str().unwrap_or("");
        let p = &value["params"];
        if method == "areal/server/configurationChanged" {
            self.configuration_changed(&p["configuration"])?;
            return Ok(());
        }
        if method == "areal/agent/spawned" {
            if let Some(id) = p["threadId"].as_str()
                && !self.in_flight("thread/read", "threadId", id)
            {
                self.queue(
                    "thread/read",
                    json!({"threadId":id,"includeTurns":false}),
                    Purpose::Summary(id.into()),
                )?;
            }
            return Ok(());
        }
        if matches!(
            method,
            "areal/interaction/requested" | "areal/interaction/resolved"
        ) {
            let interaction: areal_protocol::desktop::Interaction =
                serde_json::from_value(p["interaction"].clone())?;
            if let Some(thread) = self.threads.get_mut(&interaction.thread_id) {
                let desktop = thread.desktop.get_or_insert_with(Default::default);
                let revision = p["revision"].as_u64().unwrap_or(0);
                if revision >= desktop.interaction_revision {
                    desktop.interaction_revision = revision;
                    desktop
                        .interactions
                        .retain(|i| i.request_id != interaction.request_id);
                    let thread_id = interaction.thread_id.clone();
                    desktop.interactions.push(interaction);
                    self.histories.entry(thread_id).or_default().invalidate();
                }
            }
            return Ok(());
        }
        let Some(id) = p["threadId"].as_str() else {
            return Ok(());
        };
        if method == "areal/thread/configured" {
            return self.update_configuration(id, &p["configuration"]);
        }
        if !self.threads.contains_key(id) {
            return Ok(());
        }
        self.freshness.insert(id.into(), Instant::now());
        if matches!(method, "turn/started" | "turn/completed") {
            self.receive_turn(id, serde_json::from_value(p["turn"].clone())?);
            return Ok(());
        }
        if method == "areal/model/watchdogRetry" {
            if let (Some(turn_id), Some(attempt), Some(delay)) = (
                p["turnId"].as_str(),
                p["retry"].as_u64(),
                p["delayMs"].as_u64(),
            ) && self.threads[id]
                .turns
                .last()
                .is_some_and(|t| t.id == turn_id && t.status == TurnStatus::InProgress)
            {
                self.retries.insert(
                    id.into(),
                    RetryState {
                        turn_id: turn_id.into(),
                        purpose: if p["purpose"] == "summary" {
                            "summary"
                        } else {
                            "model"
                        }
                        .into(),
                        attempt,
                        until: Instant::now() + Duration::from_millis(delay.min(3_600_000)),
                    },
                );
            }
            return Ok(());
        }
        if matches!(
            method,
            "item/agentMessage/delta"
                | "item/reasoning/textDelta"
                | "item/reasoning/summaryTextDelta"
                | "item/completed"
        ) && self
            .retries
            .get(id)
            .is_some_and(|retry| Some(retry.turn_id.as_str()) == p["turnId"].as_str())
        {
            self.retries.remove(id);
        }
        let thread = self.threads.get_mut(id).unwrap();
        match method {
            "areal/goal/updated" | "areal/goal/cleared" => {
                let sequence = p["eventSequence"].as_u64().unwrap_or(0);
                if sequence >= thread.goals.event_sequence {
                    thread.goals.revision = p["revision"].as_u64().unwrap_or(0);
                    thread.goals.event_sequence = sequence;
                    thread.goals.goal = serde_json::from_value(p["goal"].clone())?;
                    self.histories.entry(id.into()).or_default().invalidate();
                }
            }
            "areal/plan/updated" => {
                let plan: areal_protocol::desktop::Plan =
                    serde_json::from_value(p["plan"].clone())?;
                let desktop = thread.desktop.get_or_insert_with(Default::default);
                if plan.revision >= desktop.plan.revision {
                    desktop.plan = plan;
                }
            }
            "item/started" | "item/completed" | "areal/item/agentMedia/available" => {
                if let Some(turn) = thread
                    .turns
                    .iter_mut()
                    .find(|t| Some(t.id.as_str()) == p["turnId"].as_str())
                {
                    let item: Item = serde_json::from_value(p["item"].clone())?;
                    self.histories
                        .entry(id.into())
                        .or_default()
                        .changed(&turn.id, item.id());
                    if let Some(old) = turn.items.iter_mut().find(|i| i.id() == item.id()) {
                        *old = item;
                    } else {
                        turn.items.push(item);
                    }
                }
            }
            "areal/model/completionDiscarded" => {
                if let Some(ids) = p["itemIds"].as_array() {
                    for turn in &mut thread.turns {
                        turn.items
                            .retain(|item| !ids.iter().any(|id| id.as_str() == Some(item.id())));
                    }
                    self.histories.entry(id.into()).or_default().invalidate();
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                let is_summary = method == "item/reasoning/summaryTextDelta";
                if let (Some(turn_id), Some(item_id), Some(delta), Some(index)) = (
                    p["turnId"].as_str(),
                    p["itemId"].as_str(),
                    p["delta"].as_str(),
                    p[if is_summary {
                        "summaryIndex"
                    } else {
                        "contentIndex"
                    }]
                    .as_u64()
                    .filter(|i| *i < 64),
                ) && let Some(turn) = thread.turns.iter_mut().find(|t| t.id == turn_id)
                    && let Some(Item::Reasoning {
                        content, summary, ..
                    }) = turn.items.iter_mut().find(|i| i.id() == item_id)
                {
                    let parts = if is_summary { summary } else { content };
                    parts.resize_with(parts.len().max(index as usize + 1), String::new);
                    parts[index as usize].push_str(delta);
                    self.histories
                        .entry(id.into())
                        .or_default()
                        .changed(turn_id, item_id);
                }
            }
            "item/agentMessage/delta" => {
                if let Some(turn) = thread
                    .turns
                    .iter_mut()
                    .find(|t| Some(t.id.as_str()) == p["turnId"].as_str())
                    && let Some(Item::AgentMessage {
                        id: item_id, text, ..
                    }) = turn
                        .items
                        .iter_mut()
                        .find(|i| Some(i.id()) == p["itemId"].as_str())
                {
                    text.push_str(p["delta"].as_str().unwrap_or(""));
                    self.histories
                        .entry(id.into())
                        .or_default()
                        .changed(&turn.id, item_id);
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn receive_turn(&mut self, id: &str, turn: Turn) {
        let Some(thread) = self.threads.get_mut(id) else {
            return;
        };
        let status = turn.status.clone();
        if thread.turns.iter().any(|t| {
            t.id == turn.id
                && t.status != TurnStatus::InProgress
                && status == TurnStatus::InProgress
        }) {
            return;
        }
        if self.selected.as_deref() == Some(id) {
            self.status = turn.error.as_ref().map_or_else(
                || format!("{}: {status:?}", short(id)),
                |e| safe_text(&e.message),
            );
        }
        if status == TurnStatus::InProgress {
            self.observed
                .entry(turn.id.clone())
                .or_insert_with(Instant::now);
        } else {
            self.observed.remove(&turn.id);
            if self.retries.get(id).is_some_and(|r| r.turn_id == turn.id) {
                self.retries.remove(id);
            }
        }
        if status == TurnStatus::Failed
            && !thread
                .turns
                .iter()
                .any(|old| old.id == turn.id && old.status == TurnStatus::Failed)
        {
            self.histories
                .entry(id.into())
                .or_default()
                .failed(&turn.id);
        }
        if let Some(old) = thread.turns.iter_mut().find(|t| t.id == turn.id) {
            *old = turn;
        } else {
            thread.turns.push(turn);
        }
        thread.status = if thread
            .turns
            .last()
            .is_some_and(|t| t.status == TurnStatus::InProgress)
        {
            ThreadStatus::Active {
                active_flags: Vec::new(),
            }
        } else {
            ThreadStatus::Idle
        };
        self.histories.entry(id.into()).or_default().invalidate();
    }
}

pub fn short(id: &str) -> String {
    id.chars().take(8).collect()
}
pub fn thread_status(thread: &Thread) -> &'static str {
    // 订阅外摘要优先显示活动事实，历史 Turn 可能尚未加载或已经过期。
    match thread.status {
        ThreadStatus::Active { .. } => "Running",
        ThreadStatus::SystemError => "Error",
        ThreadStatus::Idle => match thread.turns.last().map(|t| &t.status) {
            Some(TurnStatus::Completed) => "Completed",
            Some(TurnStatus::Failed) => "Failed",
            Some(TurnStatus::Interrupted) => "Interrupted",
            _ => "Idle",
        },
    }
}

/// Codex 词分隔符。空白已由外层跳过，这里只拆标点与普通字符。
const WORD_SEPARATORS: &str = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
fn is_word_separator(ch: char) -> bool {
    WORD_SEPARATORS.contains(ch)
}
/// 先按 Unicode 词边界切段，再在段内按分隔符性质切开。连续同类字符保持一段。
fn split_word_pieces(run: &str) -> Vec<(usize, &str)> {
    let mut pieces = Vec::new();
    for (segment_start, segment) in run.split_word_bound_indices() {
        let mut piece_start = 0;
        let mut chars = segment.char_indices();
        let Some((_, first_char)) = chars.next() else {
            continue;
        };
        let mut in_separator = is_word_separator(first_char);
        for (idx, ch) in chars {
            let is_separator = is_word_separator(ch);
            if is_separator == in_separator {
                continue;
            }
            pieces.push((segment_start + piece_start, &segment[piece_start..idx]));
            piece_start = idx;
            in_separator = is_separator;
        }
        pieces.push((segment_start + piece_start, &segment[piece_start..]));
    }
    pieces
}
/// `forward` 为下一词结尾（insert-mode Alt+f），否则为上一词开头（Alt+b）。
fn word_boundary(text: &str, cursor: usize, forward: bool) -> usize {
    if forward {
        end_of_next_word(text, cursor)
    } else {
        beginning_of_previous_word(text, cursor)
    }
}
fn beginning_of_previous_word(text: &str, cursor: usize) -> usize {
    let prefix = &text[..cursor];
    let Some((first_non_ws_idx, ch)) = prefix
        .char_indices()
        .rev()
        .find(|&(_, ch)| !ch.is_whitespace())
    else {
        return 0;
    };
    let run_start = prefix[..first_non_ws_idx]
        .char_indices()
        .rev()
        .find(|&(_, ch)| ch.is_whitespace())
        .map_or(0, |(idx, ch)| idx + ch.len_utf8());
    let run_end = first_non_ws_idx + ch.len_utf8();
    let pieces = split_word_pieces(&prefix[run_start..run_end]);
    let mut pieces = pieces.into_iter().rev().peekable();
    let Some((piece_start, piece)) = pieces.next() else {
        return run_start;
    };
    let mut start = run_start + piece_start;
    if piece.chars().all(is_word_separator) {
        while let Some((idx, piece)) = pieces.peek() {
            if !piece.chars().all(is_word_separator) {
                break;
            }
            start = run_start + *idx;
            pieces.next();
        }
    }
    start
}
fn end_of_next_word(text: &str, cursor: usize) -> usize {
    let suffix = &text[cursor..];
    let Some(first_non_ws) = suffix.find(|ch: char| !ch.is_whitespace()) else {
        return text.len();
    };
    let run = &suffix[first_non_ws..];
    let run = &run[..run.find(char::is_whitespace).unwrap_or(run.len())];
    let mut pieces = split_word_pieces(run).into_iter().peekable();
    let Some((start, piece)) = pieces.next() else {
        return cursor + first_non_ws;
    };
    let word_start = cursor + first_non_ws + start;
    let mut end = word_start + piece.len();
    if piece.chars().all(is_word_separator) {
        while let Some((idx, piece)) = pieces.peek() {
            if !piece.chars().all(is_word_separator) {
                break;
            }
            end = cursor + first_non_ws + *idx + piece.len();
            pieces.next();
        }
    }
    end
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub fn thread(id: &str, parent: Option<&str>) -> Thread {
        serde_json::from_value(json!({"id":id,"sessionId":"session","parentThreadId":parent,"preview":format!("Task {id}"),"modelProvider":"fixture","createdAt":0,"updatedAt":0,"status":{"type":"idle"},"cwd":"/workspace","cliVersion":"test","source":"test","ephemeral":false,"turns":[{"id":"turn","items":[],"status":"completed","error":null}]})).unwrap()
    }
    pub fn blocked_goal() -> areal_protocol::goals::Goal {
        serde_json::from_value(json!({"id":"goal","threadId":"root","objective":"inspect","status":"blocked","reason":"usageUnknown","tokenBudget":null,"maxTurns":10,"maxActiveSeconds":100,"usage":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"tokensUsed":0,"reservedTokens":500,"unknownRequests":1,"timeUsedSeconds":1.0,"turnsStarted":1,"accountingComplete":false},"activeTurnId":null,"settling":false,"waitingForInput":false,"waitingForCapacity":false,"report":null,"reportTurnId":null,"unreportedTurns":0})).unwrap()
    }
    #[test]
    fn goal_commands_share_lifecycle_and_only_rsi_sets_workflow() {
        for (command, workflow) in [("/goal", None), ("/rsi-goal", Some("rsiArtifact"))] {
            let mut app = App::new(Preferences::default());
            app.connected = true;
            app.selected = Some("root".into());
            let mut snapshot = thread("root", None);
            snapshot.goals.revision = 7;
            app.snapshot(snapshot);
            let objective = "Compare harnesses for 原始 query\nKeep this query fixed";
            let submitted = format!("{command} {objective}");
            app.input = submitted.clone();
            assert!(!app.submit().unwrap());
            assert_eq!(app.outbox.len(), 1);
            let request = app.outbox.front().unwrap();
            assert_eq!(request.method, "areal/goal/create");
            assert_eq!(request.params["threadId"], "root");
            assert_eq!(request.params["expectedRevision"], 7);
            assert_eq!(request.params["objective"], objective);
            assert!(
                request.params["requestId"]
                    .as_str()
                    .unwrap()
                    .starts_with("goal-")
            );
            assert_eq!(
                request.params.get("workflow").and_then(Value::as_str),
                workflow
            );
            assert!(matches!(request.purpose, Purpose::Ordinary));
            assert_eq!(request.submitted_input.as_deref(), Some(submitted.as_str()));
            assert!(app.input.is_empty());
        }
    }

    #[test]
    fn rsi_goal_requires_text_and_a_thread_without_losing_input() {
        for input in ["/rsi-goal", "/rsi-goal   ", "/rsi-goal compare variants"] {
            let mut app = App::new(Preferences::default());
            app.connected = true;
            app.input = input.into();
            let error = app.submit().unwrap_err().to_string();
            assert!(error.contains(if input.trim() == "/rsi-goal" {
                "Usage: /rsi-goal TEXT"
            } else {
                "Create a thread first"
            }));
            assert!(app.outbox.is_empty());
            assert_eq!(app.input, input);
        }
    }

    #[test]
    fn rsi_selection_conflict_refreshes_without_replaying_the_write() {
        let mut app = App::new(Preferences::default());
        app.connected = true;
        app.selected = Some("root".into());
        let mut snapshot = thread("root", None);
        snapshot.goals.goal = Some(blocked_goal());
        snapshot.goals.revision = 12;
        app.snapshot(snapshot);
        app.input = "/rsi-select candidate-3".into();
        app.submit().unwrap();
        let request = app.outbox.pop_front().unwrap();
        assert_eq!(request.method, "areal/goal/selectCandidate");
        assert_eq!(request.params["candidateId"], "candidate-3");
        assert_eq!(request.params["expectedRevision"], 12);
        assert_eq!(request.params["goalId"], "goal");
        app.pending.insert(1, request);
        app.receive(json!({"id":1,"error":{"code":-32009,"message":"revision conflict"}}))
            .unwrap();
        assert_eq!(app.outbox.len(), 1);
        assert_eq!(app.outbox.front().unwrap().method, "areal/goal/get");
        assert_eq!(app.input, "/rsi-select candidate-3");
    }

    #[test]
    fn rsi_artifact_pages_preserve_utf8_and_candidate_identity() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let mut app = App::new(Preferences::default());
        app.connected = true;
        app.selected = Some("root".into());
        let mut snapshot = thread("root", None);
        snapshot.goals.goal = Some(blocked_goal());
        app.snapshot(snapshot);
        let bytes = "# 产物\n内容".as_bytes();
        for (id, offset, chunk) in [(1, 0, &bytes[..3]), (2, 3, &bytes[3..])] {
            app.outbox.clear();
            app.input = format!("/rsi-artifact candidate-3 {offset}");
            app.submit().unwrap();
            let request = app.outbox.pop_front().unwrap();
            assert_eq!(request.method, "areal/goal/candidateArtifact");
            app.pending.insert(id, request);
            app.receive(json!({"id":id,"result":{"dataBase64":STANDARD.encode(chunk),"complete":id==2,"nextOffset":offset+chunk.len()}})).unwrap();
        }
        let (thread, goal, candidate, content) = app.rsi_artifact.unwrap();
        assert_eq!(
            (thread.as_str(), goal.as_str(), candidate.as_str()),
            ("root", "goal", "candidate-3")
        );
        assert_eq!(String::from_utf8(content).unwrap(), "# 产物\n内容");
    }

    #[test]
    fn bare_goal_still_reads_the_existing_goal() {
        let mut app = App::new(Preferences::default());
        app.connected = true;
        app.selected = Some("root".into());
        app.input = "/goal".into();
        app.submit().unwrap();
        let request = app.outbox.front().unwrap();
        assert_eq!(request.method, "areal/goal/get");
        assert_eq!(request.params, json!({"threadId":"root"}));
    }

    #[test]
    fn trajectory_notice_is_once_and_never_replaces_configuration_or_history() {
        let mut app = App::new(Preferences::default());
        app.status = "Connected".into();
        app.configuration_notice = Some("Model configuration failed".into());
        app.set_trajectory_notice("Trajectory needs attention".into());
        app.set_trajectory_notice("Duplicate".into());
        assert_eq!(app.status_notice(), "Model configuration failed");
        assert_eq!(
            app.trajectory_notice.as_deref(),
            Some("Trajectory needs attention")
        );
        assert!(app.histories.is_empty());
        assert_eq!(app.status, "Connected");
        app.configuration_notice = None;
        assert_eq!(app.status_notice(), "Connected");
        app.status = "areal/model/list: permission denied".into();
        assert_eq!(app.status_notice(), "areal/model/list: permission denied");
        app.configuration_changed(&json!({"error":"new model configuration failure"}))
            .unwrap();
        assert!(
            app.status_notice()
                .contains("new model configuration failure")
        );
        assert_eq!(
            app.trajectory_notice.as_deref(),
            Some("Trajectory needs attention")
        );
    }

    #[test]
    fn approvals_preserve_digest_default_to_deny_and_follow_resolution() {
        let mut app = App::new(Preferences::default());
        app.connected = true;
        app.selected = Some("root".into());
        app.snapshot(thread("root", None));
        app.paste("draft");
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .unwrap();
        let mut request = json!({"requestId":"r1","threadId":"root","turnId":"turn","callId":"call","kind":"approval","status":"pending","expiresAt":9999999999_i64,"questions":[],"tool":"run_command","argumentsDigest":"digest1","generation":null,"effectivePermissions":{"rememberAllowed":true},"effectiveArguments":{"argv":["echo","<untrusted>"]},"response":null});
        let event = |request: &Value, revision| json!({"method":"areal/interaction/requested","params":{"revision":revision,"interaction":request}});
        app.receive(event(&request, 1)).unwrap();
        app.paste("hidden paste");
        for c in ['a', 'd', 'e'] {
            app.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL))
                .unwrap();
            assert_eq!(app.input, "draft");
            assert_eq!(app.input_cursor, 4);
        }
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.outbox.back().unwrap().params["decision"], "deny");
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.outbox.len(), 1);
        app.outbox.clear();
        request["status"] = json!("answered");
        app.receive(event(&request, 2)).unwrap();
        assert!(app.pending_approval().is_none());
        request["status"] = json!("pending");
        request["requestId"] = json!("r2");
        request["argumentsDigest"] = json!("digest2");
        app.receive(event(&request, 3)).unwrap();
        for _ in 0..2 {
            app.key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
                .unwrap();
        }
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        let answer = &app.outbox.back().unwrap().params;
        assert_eq!(answer["decision"], "allowSession");
        assert_eq!(answer["argumentsDigest"], "digest2");
        assert_eq!(answer["requestId"], "r2");
        app.outbox.clear();
        request["status"] = json!("answered");
        app.receive(event(&request, 4)).unwrap();
        request["status"] = json!("pending");
        request["requestId"] = json!("r3");
        request["effectivePermissions"]["rememberAllowed"] = json!(false);
        app.receive(event(&request, 5)).unwrap();
        assert_eq!(app.approval_choices().len(), 2);
        app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.outbox.back().unwrap().params["decision"], "deny");
    }

    #[test]
    fn retries_end_on_progress_completion_snapshot_and_disconnect() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        let mut t = thread("root", None);
        t.turns[0].status = TurnStatus::InProgress;
        t.turns[0].items.push(Item::AgentMessage {
            id: "a".into(),
            text: String::new(),
            phase: Some(areal_protocol::AgentMessagePhase::Commentary),
        });
        app.snapshot(t.clone());
        let retry = json!({"method":"areal/model/watchdogRetry","params":{"threadId":"root","turnId":"turn","purpose":"solve","retry":2,"delayMs":4000}});
        app.receive(retry.clone()).unwrap();
        assert_eq!(app.retries["root"].attempt, 2);
        app.receive(json!({"method":"item/agentMessage/delta","params":{"threadId":"root","turnId":"turn","itemId":"a","delta":"prefix"}})).unwrap();
        assert!(app.retries.is_empty());
        app.receive(retry.clone()).unwrap();
        app.snapshot(t.clone());
        assert!(app.retries.is_empty());
        app.receive(retry.clone()).unwrap();
        app.history().unwrap().follow = false;
        let mut failed = t.turns[0].clone();
        failed.status = TurnStatus::Failed;
        app.receive_turn("root", failed.clone());
        app.receive_turn("root", failed);
        assert!(app.retries.is_empty());
        assert!(!app.observed.contains_key("turn"));
        let snapshot = app.current().unwrap().clone();
        app.history().unwrap().prepare(&snapshot, 80, 20);
        assert!(
            app.history()
                .unwrap()
                .progress()
                .starts_with("1 new failure(s)")
        );
        app.history().unwrap().end();
        assert!(!app.history().unwrap().progress().contains("new failure"));
        app.receive(retry.clone()).unwrap();
        assert!(app.retries.is_empty());
        app.receive_turn("root", t.turns[0].clone());
        assert_eq!(app.current().unwrap().turns[0].status, TurnStatus::Failed);
        assert_eq!(app.current().unwrap().turns.len(), 1);
        app.snapshot(t);
        app.receive(retry).unwrap();
        app.disconnect("fixture");
        assert!(app.retries.is_empty());
    }
    #[test]
    fn input_keys_edit_at_cursor_and_submit_the_result() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        app.subscriptions.insert("root".into());
        app.paste("helo!");
        for _ in 0..3 {
            app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
                .unwrap();
        }
        app.key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL))
            .unwrap();
        app.paste("say ");
        app.key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.input, "say hello!");
        assert_eq!(app.input_cursor, app.input.len());
        app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE))
            .unwrap();
        assert!(
            !app.key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL))
                .unwrap()
        );
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.outbox[0].params["input"][0]["text"], "say hello!");
        assert!(app.input.is_empty());
        assert_eq!(app.input_cursor, 0);
        for key in [
            KeyEvent::new(KeyCode::Left, KeyModifiers::NONE),
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE),
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
        ] {
            assert!(!app.key(key).unwrap());
            assert!(app.input.is_empty());
            assert_eq!(app.input_cursor, 0);
        }
    }
    #[test]
    fn input_movement_and_deletion_preserve_complete_graphemes() {
        for grapheme in ["中", "e\u{301}", "👩‍💻", "🇨🇳"] {
            let mut app = App::new(Preferences::default());
            app.paste(&format!("a{grapheme}z"));
            for _ in 0..2 {
                app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
                    .unwrap();
            }
            assert_eq!(app.input_cursor, 1);
            app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE))
                .unwrap();
            assert_eq!(app.input_cursor, 1 + grapheme.len());
            app.key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE))
                .unwrap();
            assert_eq!(app.input, "az");
            assert_eq!(app.input_cursor, 1);
            app.paste(grapheme);
            app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
                .unwrap();
            app.key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE))
                .unwrap();
            assert_eq!(app.input, "az");
            assert_eq!(app.input_cursor, 1);
        }
        let mut app = App::new(Preferences::default());
        app.paste("👩💻");
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Char('\u{200d}'), KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.input, "👩‍💻");
        assert_eq!(app.input_cursor, app.input.len());
        app.key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE))
            .unwrap();
        assert!(app.input.is_empty());
    }
    #[test]
    fn option_arrows_move_by_codex_word_boundaries() {
        let mut app = App::new(Preferences::default());
        app.paste("  alpha  beta   gamma");
        let after_alpha = "  alpha".len();
        app.input_cursor = after_alpha;
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, 2);
        app.key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, after_alpha);
        app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "  alpha  beta".len());
        app.key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "  alpha  ".len());
        assert_eq!(app.input, "  alpha  beta   gamma");

        // 撇号、句点属于 Codex 分隔符，can't / 32.3 / foo.bar 都会被切开。
        let mut app = App::new(Preferences::default());
        app.paste("can't 32.3 foo.bar");
        for (cursor, expected) in [(5, 4), (4, 3), (10, 9), (18, 15)] {
            app.input_cursor = cursor;
            app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT))
                .unwrap();
            assert_eq!(app.input_cursor, expected, "left from {cursor}");
        }
        app.input_cursor = 0;
        app.key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "can".len());
        app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "can'".len());
        app.key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "can't".len());
        assert_eq!(app.input, "can't 32.3 foo.bar");

        let mut app = App::new(Preferences::default());
        app.paste("你好世界");
        app.key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "你好世".len());
        app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, app.input.len());

        // Unicode 词边界把汉字逐字切开，hello你好 是 hello | 你 | 好。
        let mut app = App::new(Preferences::default());
        app.paste("hello你好");
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "hello你".len());
        app.key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "hello".len());
        app.key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, 0);
        app.key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "hello".len());
        app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input_cursor, "hello你".len());
        assert_eq!(app.input, "hello你好");

        for grapheme in ["中", "e\u{301}", "👩‍💻", "🇨🇳"] {
            let mut app = App::new(Preferences::default());
            app.paste(&format!("a {grapheme} z"));
            let text = app.input.clone();
            // 行尾回退先落到空白前，再回到字素开头；前进跳过空白落到字素结尾。
            app.key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT))
                .unwrap();
            assert_eq!(app.input_cursor, text.len() - 1);
            app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT))
                .unwrap();
            assert_eq!(app.input_cursor, 2);
            app.key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT))
                .unwrap();
            assert_eq!(app.input_cursor, 2 + grapheme.len());
            assert!(app.input.is_char_boundary(app.input_cursor));
        }

        let mut app = App::new(Preferences::default());
        app.paste("draft");
        app.focus = Focus::Content;
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT))
            .unwrap();
        assert_eq!(app.input, "draft");
        assert_eq!(app.input_cursor, 5);
    }
    #[test]
    fn input_line_shortcuts_and_newline_deletion_handle_pasted_text() {
        let mut app = App::new(Preferences::default());
        app.paste("first\nsecond\nthird");
        app.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.input_cursor, "first\nsecond\n".len());
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.input_cursor, "first\n".len());
        app.key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.input_cursor, "first\nsecond".len());
        app.key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(app.input, "first\nsecondthird");

        let mut app = App::new(Preferences::default());
        app.paste("e\n\u{301}x");
        app.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.input, "e\u{301}x");
        assert_eq!(app.input_cursor, "e\u{301}".len());
    }
    #[test]
    fn input_shortcuts_do_not_edit_background_drafts() {
        for mode in 0..4 {
            let mut app = App::new(Preferences::default());
            app.paste("draft");
            match mode {
                0 => app.focus = Focus::Navigation,
                1 => app.focus = Focus::Content,
                2 => app.picker = Some(Picker::new(PickerKind::Sessions)),
                _ => app.theme_original = Some(app.prefs.theme),
            }
            for c in ['a', 'd', 'e'] {
                app.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL))
                    .unwrap();
                assert_eq!(app.input, "draft");
                assert_eq!(app.input_cursor, 5);
            }
        }
    }
    #[test]
    fn submission_failures_restore_empty_input_without_overwriting_new_drafts() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        app.snapshot(thread("root", None));
        app.subscriptions.insert("root".into());
        app.input = "original request".into();
        app.submit().unwrap();
        let request = app.outbox.pop_front().unwrap();
        app.pending.insert(1, request);
        app.receive(json!({"id":1,"error":{"message":"fixture rejected"}}))
            .unwrap();
        assert_eq!(app.input, "original request");
        assert_eq!(app.input_cursor, app.input.len());
        assert_eq!(app.submission_failures["root"].message, "fixture rejected");
        app.submit().unwrap();
        let request = app.outbox.pop_front().unwrap();
        app.pending.insert(2, request);
        app.input = "new draft".into();
        app.receive(json!({"id":2,"error":{"message":"rejected again"}}))
            .unwrap();
        assert_eq!(app.input, "new draft");
        app.input = "/restore-input".into();
        app.submit().unwrap();
        assert_eq!(app.input, "original request");
        assert_eq!(app.input_cursor, app.input.len());
        assert!(app.outbox.is_empty());
    }
    #[test]
    fn conflicting_goal_projection_resyncs_once_and_preserves_newer_goal_updates() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        app.subscriptions.insert("root".into());
        let mut t = thread("root", None);
        t.turns[0].status = TurnStatus::InProgress;
        t.turns[0].goal = Some(
            serde_json::from_value(json!({"goalId":"goal","sequence":1,"origin":"initial"}))
                .unwrap(),
        );
        t.goals.goal = Some(blocked_goal());
        t.goals.event_sequence = 2;
        app.snapshot(t.clone());
        app.refresh().unwrap();
        app.refresh().unwrap();
        assert_eq!(
            app.outbox
                .iter()
                .filter(|r| r.method == "areal/thread/observe")
                .count(),
            1
        );
        assert!(app.syncing.contains("root"));
        let mut stale = t.clone();
        stale.goals.event_sequence = 1;
        stale.goals.goal = None;
        app.merge_summary(stale);
        assert!(app.current().unwrap().goals.goal.is_some());
        app.outbox.clear();
        app.snapshot(t);
        app.refresh().unwrap();
        assert!(
            app.outbox
                .iter()
                .all(|r| r.method != "areal/thread/observe")
        );
        let goal = app
            .threads
            .get_mut("root")
            .unwrap()
            .goals
            .goal
            .as_mut()
            .unwrap();
        goal.active_turn_id = Some("turn".into());
        app.resynced.clear();
        app.refresh().unwrap();
        assert!(
            app.outbox
                .iter()
                .all(|r| r.method != "areal/thread/observe")
        );
    }
    #[test]
    fn details_toggle_preserves_input_and_does_not_submit() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        app.input = "unsent draft".into();
        app.key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL))
            .unwrap();
        assert!(app.histories["root"].detailed);
        assert_eq!(app.input, "unsent draft");
        assert!(app.outbox.is_empty());
        app.input = "/details".into();
        app.submit().unwrap();
        assert!(!app.histories["root"].detailed);
        assert!(app.outbox.is_empty());
    }
    #[test]
    fn reasoning_deltas_and_discard_update_the_authoritative_projection() {
        let mut app = App::new(Preferences::default());
        app.snapshot(thread("root", None));
        app.receive(json!({"method":"item/started","params":{"threadId":"root","turnId":"turn","item":{"type":"reasoning","id":"r","summary":[],"content":[""]}}})).unwrap();
        for delta in ["检查", "完成"] {
            app.receive(json!({"method":"item/reasoning/textDelta","params":{"threadId":"root","turnId":"turn","itemId":"r","contentIndex":0,"delta":delta}})).unwrap();
        }
        assert!(
            matches!(&app.threads["root"].turns[0].items[0], Item::Reasoning {content,..} if content == &["检查完成"])
        );
        app.receive(json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"root","turnId":"turn","itemId":"r","summaryIndex":1,"delta":"摘要"}})).unwrap();
        assert!(
            matches!(&app.threads["root"].turns[0].items[0], Item::Reasoning {summary,..} if summary == &["", "摘要"])
        );
        app.receive(json!({"method":"areal/model/completionDiscarded","params":{"threadId":"root","itemIds":["r"]}})).unwrap();
        assert!(app.threads["root"].turns[0].items.is_empty());
    }

    #[test]
    fn completion_and_picker_keys_preserve_drafts_and_do_not_send_prompts() {
        let mut app = App::new(Preferences::default());
        app.input = "/ses".into();
        app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.input, "/sessions");
        assert_eq!(app.input_cursor, app.input.len());
        assert!(app.outbox.is_empty());
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        assert!(
            app.picker
                .as_ref()
                .is_some_and(|p| p.kind == PickerKind::Sessions)
        );
        assert_eq!(app.outbox[0].method, "thread/list");
        app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        app.input = "未发送的草稿".into();
        app.key(KeyEvent::new(KeyCode::F(5), KeyModifiers::NONE))
            .unwrap();
        app.paste("search");
        assert_eq!(app.input, "未发送的草稿");
        assert_eq!(app.picker.as_ref().unwrap().query, "search");
        app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.input, "未发送的草稿");
        app.input = "/spawn".into();
        app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.input, "/spawn ");
        assert_eq!(app.input_cursor, app.input.len());
        assert!(app.completions().is_empty());
    }
    #[test]
    fn session_picker_filters_and_switches_without_global_navigation() {
        let mut app = App::new(Preferences::default());
        app.snapshot(thread("root", None));
        app.snapshot(thread("unrelated", None));
        app.selected = Some("root".into());
        app.prepare_context().unwrap();
        assert_eq!(app.nav_rows().len(), 1);
        app.picker = Some(Picker::new(PickerKind::Sessions));
        app.paste("unrelated");
        assert_eq!(
            app.session_choices(),
            vec![NavTarget::Thread("unrelated".into())]
        );
        app.picker_key(KeyCode::Enter).unwrap();
        assert_eq!(app.selected.as_deref(), Some("unrelated"));
        assert_eq!(app.tree_root.as_deref(), Some("unrelated"));
        assert!(app.picker.is_none());
    }
    #[test]
    fn model_change_waits_for_ack_and_uses_revision_without_losing_history() {
        let mut app = App::new(Preferences::default());
        app.snapshot(thread("root", None));
        app.selected = Some("root".into());
        app.subscriptions.insert("root".into());
        app.models.push(ModelChoice {
            label: "fixture / alternate".into(),
            model: Some(areal_protocol::desktop::ModelRef {
                provider_id: "fixture".into(),
                model_id: "alternate".into(),
            }),
            available: true,
        });
        app.picker = Some(Picker::new(PickerKind::Models));
        app.choose_model(0).unwrap();
        assert_eq!(app.model_label(), "Server default");
        assert!(app.picker.is_some());
        app.input = "queued draft".into();
        assert!(app.submit().is_err());
        assert_eq!(app.input, "queued draft");
        let request = app.outbox.pop_front().unwrap();
        assert_eq!(request.params["expectedRevision"], 1);
        assert_eq!(request.params["model"]["modelId"], "alternate");
        app.pending.insert(1, request);
        let config = json!({"revision":2,"model":{"providerId":"fixture","modelId":"alternate"},"provider":null,"profile":null});
        app.receive(json!({"id":1,"result":config})).unwrap();
        assert_eq!(app.model_label(), "fixture / alternate");
        assert!(app.picker.is_none());
        assert_eq!(app.current().unwrap().turns.len(), 1);
        app.receive(json!({"method":"areal/thread/configured","params":{"threadId":"root","configuration":{"revision":1,"model":null,"provider":null,"profile":null}}})).unwrap();
        assert_eq!(app.model_label(), "fixture / alternate");
        app.threads.get_mut("root").unwrap().turns[0].status = TurnStatus::InProgress;
        assert!(app.choose_model(0).is_err());
    }
    #[test]
    fn catalog_refresh_keeps_model_identity_and_does_not_invent_a_default() {
        let mut app = App::new(Preferences::default());
        let request = || Request {
            submitted_input: None,
            method: "areal/model/list".into(),
            params: json!({}),
            purpose: Purpose::Models,
        };
        app.pending.insert(1, request());
        app.receive(json!({"id":1,"result":{"data":[
            {"providerId":"fixture","modelId":"a","available":true},
            {"providerId":"fixture","modelId":"b","available":true}
        ]}}))
        .unwrap();
        assert!(!app.models[0].available);
        assert_eq!(app.default_model, "Not configured");
        app.picker = Some(Picker {
            kind: PickerKind::Models,
            query: String::new(),
            selected: 2,
        });
        app.pending.insert(2, request());
        app.receive(json!({"id":2,"result":{"data":[
            {"providerId":"fixture","modelId":"b","available":true}
        ]}}))
        .unwrap();
        let selected = app.picker.as_ref().unwrap().selected;
        assert_eq!(
            app.models[app.model_choices()[selected]]
                .model
                .as_ref()
                .unwrap()
                .model_id,
            "b"
        );
    }
    #[test]
    fn model_conflict_refreshes_configuration_and_keeps_picker_open() {
        let mut app = App::new(Preferences::default());
        app.picker = Some(Picker::new(PickerKind::Models));
        app.pending.insert(
            1,
            Request {
                submitted_input: None,
                method: "areal/thread/configure".into(),
                params: json!({}),
                purpose: Purpose::Configure("root".into()),
            },
        );
        app.receive(json!({"id":1,"error":{"message":"conflict"}}))
            .unwrap();
        assert!(app.picker.is_some());
        assert_eq!(app.outbox[0].method, "areal/thread/observe");
        assert!(app.status.contains("conflict"));
    }
    #[test]
    fn spawned_unknown_child_is_read_before_projection_lookup() {
        let mut app = App::new(Preferences::default());
        app.receive(json!({"method":"areal/agent/spawned","params":{"parentThreadId":"parent","threadId":"child","turnId":"child-turn"}})).unwrap();
        assert_eq!(app.outbox[0].method, "thread/read");
        assert_eq!(app.outbox[0].params["threadId"], "child");
    }
    #[test]
    fn delegation_reply_preserves_later_navigation_and_loads_child_history() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("parent".into());
        app.view = View::Agents;
        app.focus = Focus::Navigation;
        app.nav_selected = Some(NavTarget::Thread("parent".into()));
        app.pending.insert(
            1,
            Request {
                method: "areal/agent/delegate".into(),
                params: json!({"parentThreadId":"parent"}),
                purpose: Purpose::Ordinary,
                submitted_input: None,
            },
        );
        app.receive(json!({"id":1,"result":{"executionId":"execution","parentThreadId":"parent","threadId":"child","title":"child task","status":"running"}})).unwrap();
        assert_eq!(app.view, View::Agents);
        assert_eq!(app.focus, Focus::Navigation);
        assert_eq!(app.nav_selected, Some(NavTarget::Thread("parent".into())));
        assert!(app.outbox.iter().any(
            |request| request.method == "thread/read" && request.params["threadId"] == "child"
        ));
        assert!(
            !app.outbox
                .iter()
                .any(|request| request.method == "areal/execution/list")
        );
    }
    #[test]
    fn resume_replaces_old_history_without_switching_selection() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("parent".into());
        let mut old = thread("child", Some("parent"));
        old.turns[0].items.push(Item::AgentMessage {
            phase: None,
            id: "old".into(),
            text: "stale delta".into(),
        });
        app.snapshot(old);
        app.pending.insert(
            1,
            Request {
                submitted_input: None,
                method: "areal/thread/observe".into(),
                params: json!({}),
                purpose: Purpose::Resume("child".into()),
            },
        );
        app.receive(json!({"id":1,"result":{"thread":thread("child", Some("parent"))}}))
            .unwrap();
        assert!(app.threads["child"].turns[0].items.is_empty());
        assert_eq!(app.selected.as_deref(), Some("parent"));
    }
    #[test]
    fn empty_page_keeps_cursor_and_tree_selection_is_stable() {
        let mut app = App::new(Preferences::default());
        app.pages.entry(Some("root".into())).or_default();
        app.pending.insert(
            1,
            Request {
                submitted_input: None,
                method: "areal/agent/list".into(),
                params: json!({}),
                purpose: Purpose::List {
                    parent: Some("root".into()),
                    generation: 0,
                },
            },
        );
        app.receive(json!({"id":1,"result":{"data":[],"nextCursor":"next"}}))
            .unwrap();
        app.tree_root = Some("root".into());
        app.expanded.insert("root".into());
        app.view = View::Agents;
        app.nav_selected = Some(NavTarget::Thread("child".into()));
        app.merge_summary(thread("child", Some("root")));
        app.merge_summary(thread("aaa", Some("root")));
        assert_eq!(app.nav_selected, Some(NavTarget::Thread("child".into())));
        assert!(
            app.nav_rows()
                .iter()
                .any(|r| r.target == NavTarget::More(Some("root".into())))
        );
    }
    #[test]
    fn subscription_reservations_are_bounded_and_disconnect_never_replays_actions() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        app.tree_root = Some("root".into());
        app.view = View::Agents;
        app.expanded.insert("root".into());
        for i in 0..140 {
            app.merge_summary(thread(&format!("node-{i}"), Some("root")));
        }
        app.sync_subscriptions().unwrap();
        app.sync_subscriptions().unwrap();
        assert_eq!(app.reserved().len(), SUBSCRIPTION_BUDGET);
        app.input = "/spawn work".into();
        app.submit().unwrap();
        app.disconnect("fixture");
        assert!(app.outbox.is_empty());
        assert!(app.pending.is_empty());
        app.bootstrap(Some("root".into()), false).unwrap();
        assert!(!app.outbox.iter().any(|r| r.method == "areal/agent/spawn"));
    }
    #[test]
    fn selecting_outside_budget_releases_before_resuming() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("new".into());
        for i in 0..SUBSCRIPTION_BUDGET {
            app.subscriptions.insert(format!("old-{i}"));
        }
        app.sync_subscriptions().unwrap();
        assert!(app.reserved().is_empty());
        let release = app.outbox.pop_front().unwrap();
        assert_eq!(release.method, "areal/subscription/remove");
        app.pending.insert(1, release);
        app.receive(json!({"id":1,"result":{}})).unwrap();
        assert_eq!(app.reserved(), BTreeSet::from(["new".into()]));
        assert!(app.subscriptions.is_empty());
    }
    #[test]
    fn stale_group_and_page_responses_do_not_replace_new_views() {
        let mut app = App::new(Preferences::default());
        app.group_generation = 2;
        app.group_id = Some("new-group".into());
        app.pending.insert(
            1,
            Request {
                submitted_input: None,
                method: "areal/workgroup/read".into(),
                params: json!({}),
                purpose: Purpose::Group(1),
            },
        );
        app.receive(json!({"id":1,"result":{"id":"old-group","record":{"status":"completed"}}}))
            .unwrap();
        assert_eq!(app.group_id.as_deref(), Some("new-group"));
        assert!(app.group.is_none());
        app.pages.insert(
            None,
            Page {
                generation: 2,
                ..Default::default()
            },
        );
        app.pending.insert(
            2,
            Request {
                submitted_input: None,
                method: "thread/list".into(),
                params: json!({}),
                purpose: Purpose::List {
                    parent: None,
                    generation: 1,
                },
            },
        );
        app.receive(json!({"id":2,"result":{"data":[thread("stale",None)],"nextCursor":"stale"}}))
            .unwrap();
        assert!(app.threads.is_empty());
        assert!(app.pages[&None].cursor.is_none());
    }
    #[test]
    fn nested_tree_is_lazy_and_browsing_does_not_change_input_target() {
        let mut app = App::new(Preferences::default());
        for t in [
            thread("root", None),
            thread("child", Some("root")),
            thread("grandchild", Some("child")),
        ] {
            app.merge_summary(t);
        }
        app.selected = Some("root".into());
        app.topology(false).unwrap();
        assert_eq!(app.nav_rows().len(), 2);
        app.nav_key(KeyCode::Down).unwrap();
        app.nav_key(KeyCode::Right).unwrap();
        assert_eq!(app.nav_rows().len(), 3);
        assert_eq!(app.selected.as_deref(), Some("root"));
        assert!(app.list_in_flight(&Some("child".into())));
        app.nav_key(KeyCode::Left).unwrap();
        assert_eq!(app.nav_rows().len(), 2);
    }
    #[test]
    fn workgroup_wait_tracks_revision_and_stops_at_terminal_state() {
        let mut app = App::new(Preferences::default());
        app.view = View::Groups;
        app.group_id = Some("group".into());
        app.group = Some(json!({"id":"group","record":{"status":"running","revision":9}}));
        app.watch_group().unwrap();
        app.watch_group().unwrap();
        assert_eq!(app.outbox.len(), 1);
        let request = app.outbox.pop_front().unwrap();
        assert_eq!(request.params["afterRevision"], 9);
        app.pending.insert(1, request);
        app.receive(
            json!({"id":1,"result":{"id":"group","record":{"status":"completed","revision":10}}}),
        )
        .unwrap();
        assert_eq!(app.group.as_ref().unwrap()["record"]["revision"], 10);
        assert!(
            !app.outbox
                .iter()
                .any(|r| r.method == "areal/workgroup/wait")
        );
    }
    #[test]
    fn unified_execution_commands_keep_owner_and_stop_waiting_after_settlement() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("parent".into());
        app.show_executions().unwrap();
        let list = app.outbox.pop_front().unwrap();
        assert_eq!(list.method, "areal/execution/list");
        assert_eq!(list.params["parentThreadId"], "parent");
        app.pending.insert(1, list);
        app.receive(json!({"id":1,"result":{"data":[{"executionId":"child","status":"running"}],"nextOffset":50}})).unwrap();
        assert_eq!(app.nav_rows()[0].target, NavTarget::Group("child".into()));
        assert_eq!(app.execution_next_offset, Some(50));
        app.open_group("child").unwrap();
        let index = app
            .outbox
            .iter()
            .position(|request| request.method == "areal/execution/read")
            .unwrap();
        let read = app.outbox.remove(index).unwrap();
        assert_eq!(read.method, "areal/execution/read");
        assert_eq!(read.params["parentThreadId"], "parent");
        app.pending.insert(2, read);
        app.receive(
            json!({"id":2,"result":{"executionId":"child","status":"running","settled":false}}),
        )
        .unwrap();
        app.watch_group().unwrap();
        let index = app
            .outbox
            .iter()
            .position(|request| request.method == "areal/execution/wait")
            .unwrap();
        let wait = app.outbox.remove(index).unwrap();
        assert_eq!(wait.method, "areal/execution/wait");
        assert_eq!(wait.params["executionId"], "child");
        assert!(wait.params.get("afterRevision").is_none());
        app.pending.insert(3, wait);
        app.receive(json!({"id":3,"result":{"executionId":"child","status":"completed","settled":true,"delivery":{"status":"conflict"}}})).unwrap();
        app.watch_group().unwrap();
        assert!(
            !app.outbox
                .iter()
                .any(|request| request.method == "areal/execution/wait")
        );
        assert_eq!(
            app.group.as_ref().unwrap()["delivery"]["status"],
            "conflict"
        );
        app.group =
            Some(json!({"executionId":"child","status":"awaitingDelivery","settled":false}));
        app.watch_group().unwrap();
        app.watch_group().unwrap();
        assert_eq!(
            app.outbox
                .iter()
                .filter(|request| request.method == "areal/execution/read")
                .count(),
            1
        );
        assert!(
            !app.outbox
                .iter()
                .any(|request| request.method == "areal/execution/wait")
        );
    }
}
