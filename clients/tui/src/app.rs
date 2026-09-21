use anyhow::{Context, Result, bail, ensure};
use areal_protocol::{Item, Thread, ThreadStatus, Turn, TurnStatus};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    client::Client,
    commands::{self, ModelChoice, Picker, PickerKind},
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
    Configure(String),
}
#[derive(Clone, Debug)]
struct Request {
    method: String,
    params: Value,
    purpose: Purpose,
}

pub struct App {
    pub threads: BTreeMap<String, Thread>,
    pub selected: Option<String>,
    pub input: String,
    pub status: String,
    pub view: View,
    pub focus: Focus,
    pub prefs: Preferences,
    pub theme_original: Option<Theme>,
    pub picker: Option<Picker>,
    pub models: Vec<ModelChoice>,
    pub default_model: String,
    pub model_reset_supported: bool,
    pub completion_index: usize,
    completion_dismissed: bool,
    pub histories: BTreeMap<String, History>,
    pub tree_root: Option<String>,
    tree_direct: bool,
    pub expanded: BTreeSet<String>,
    pub nav_selected: Option<NavTarget>,
    pub pages: BTreeMap<Option<String>, Page>,
    pub subscriptions: BTreeSet<String>,
    pub freshness: BTreeMap<String, Instant>,
    pub observed: BTreeMap<String, Instant>,
    pub groups: Vec<Value>,
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
            threads: BTreeMap::new(),
            selected: None,
            input: String::new(),
            status: "Connected · /help for commands".into(),
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
            default_model: "Server default".into(),
            model_reset_supported: false,
            completion_index: 0,
            completion_dismissed: false,
            histories: BTreeMap::new(),
            tree_root: None,
            tree_direct: false,
            expanded: BTreeSet::new(),
            nav_selected: None,
            pages: BTreeMap::new(),
            subscriptions: BTreeSet::new(),
            freshness: BTreeMap::new(),
            observed: BTreeMap::new(),
            groups: Vec::new(),
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
        self.outbox.push_back(Request {
            method: method.into(),
            params,
            purpose,
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
        self.queue("thread/start", json!({}), Purpose::Create(self.generation))
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
        self.status =
            format!("Disconnected · {reason} · reconnecting; submitted actions are not replayed");
        self.pending.clear();
        self.outbox.clear();
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
                self.queue("thread/resume", json!({"threadId":id}), Purpose::Resume(id))?;
                occupied += 1;
            }
        }
        Ok(())
    }
    pub fn refresh(&mut self) -> Result<()> {
        if !self.connected {
            return Ok(());
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
        self.watch_group()
    }
    fn watch_group(&mut self) -> Result<()> {
        if !self.connected || self.view != View::Groups || Instant::now() < self.group_retry {
            return Ok(());
        }
        let Some(id) = self.group_id.clone() else {
            return Ok(());
        };
        if self
            .pending
            .values()
            .chain(self.outbox.iter())
            .any(|r| r.method == "areal/workgroup/wait")
        {
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
    fn show_groups(&mut self) -> Result<()> {
        ensure!(
            self.capabilities.is_empty() || self.capabilities.contains("areal/workgroup/list"),
            "This Core has no Workgroup service configured"
        );
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
        self.queue(
            "areal/workgroup/read",
            json!({"id":id}),
            Purpose::Group(self.group_generation),
        )
    }
    pub fn submit(&mut self) -> Result<bool> {
        let input = self.input.trim().to_owned();
        if input.is_empty() {
            return Ok(false);
        }
        match input.as_str() {
            "/quit" => return Ok(true),
            "/new" => {
                self.new_thread()?;
                self.view = View::Conversation;
            }
            "/sessions" | "/list" => {
                self.picker = Some(Picker::new(PickerKind::Sessions));
                self.load_page(None, true)?;
            }
            "/model" => {
                self.picker = Some(Picker::new(PickerKind::Models));
                self.queue("areal/model/list", json!({}), Purpose::Models)?;
            }
            "/tasks" => {
                self.view = View::Tasks;
                self.focus = Focus::Navigation;
                self.prepare_context()?;
                self.sync_subscriptions()?;
            }
            "/agents" => self.topology(true)?,
            "/topology" => self.topology(false)?,
            "/groups" => self.show_groups()?,
            "/help" => self.view = View::Help,
            "/welcome" => self.view = View::Welcome,
            "/theme" => self.theme_original = Some(self.prefs.theme),
            "/more" => {
                let parent = if self.agent_panel() {
                    self.tree_root.clone()
                } else {
                    None
                };
                self.load_page(parent, false)?;
            }
            _ => {
                if let Some(prefix) = input.strip_prefix("/open ") {
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
                        "areal/agent/spawn",
                        json!({"parentThreadId":parent,"input":[{"type":"text","text":prompt}]}),
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
                    self.group_generation += 1;
                    self.queue(method, params, Purpose::Group(self.group_generation))?;
                } else if let Some(id) = input.strip_prefix("/group-cancel ") {
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
                    if matches!(self.view, View::Welcome | View::Help) {
                        self.view = View::Conversation;
                    }
                    if let Some(h) = self.history() {
                        h.end();
                    }
                }
            }
        }
        self.input.clear();
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
    fn picker_key(&mut self, code: KeyCode) -> Result<()> {
        let picker = self.picker.as_ref().unwrap();
        let (kind, selected) = (picker.kind, picker.selected);
        let count = match kind {
            PickerKind::Sessions => self.session_choices().len(),
            PickerKind::Models => self.model_choices().len(),
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
        if self.theme_original.is_some() {
            return;
        }
        let text = safe_text(text);
        if let Some(picker) = &mut self.picker {
            if picker.query.len() + text.len() <= 256 {
                picker.query.push_str(&text.replace(['\n', '\t'], " "));
                picker.selected = 0;
            }
        } else if self.focus == Focus::Input && self.input.len() + text.len() <= 64 * 1024 {
            self.input.push_str(&text);
            if self.view == View::Welcome {
                self.view = View::Conversation;
            }
            self.completion_index = 0;
            self.completion_dismissed = false;
        }
        self.dirty = true;
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
    pub fn key(&mut self, key: KeyEvent) -> Result<bool> {
        self.dirty = true;
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('q') => return Ok(true),
                KeyCode::Char('c') => {
                    if let Some(turn) = self.active() {
                        self.queue(
                            "turn/interrupt",
                            json!({"threadId":self.selected,"turnId":turn.id}),
                            Purpose::Ordinary,
                        )?;
                    }
                }
                KeyCode::Char('r') => self.reconnect_requested = true,
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
            KeyCode::F(4) => self.show_groups()?,
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
                if matches!(self.view, View::Groups | View::Tasks)
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
                    if matches!(self.view, View::Welcome | View::Help) {
                        self.view = View::Conversation;
                    }
                }
            }
            _ if self.focus == Focus::Navigation => self.nav_key(key.code)?,
            KeyCode::Up | KeyCode::Down if self.focus == Focus::Content => {
                if let Some(h) = self.history() {
                    h.move_by(if key.code == KeyCode::Up { -1 } else { 1 });
                }
            }
            KeyCode::Char(' ') if self.focus == Focus::Content => {
                if let Some(h) = self.history() {
                    h.toggle_tool();
                }
            }
            KeyCode::Enter if self.focus == Focus::Input => return self.submit(),
            KeyCode::Backspace if self.focus == Focus::Input => {
                let end = self
                    .input
                    .grapheme_indices(true)
                    .next_back()
                    .map_or(0, |(i, _)| i);
                self.input.truncate(end);
                self.completion_index = 0;
                self.completion_dismissed = false;
            }
            KeyCode::Char(c)
                if self.focus == Focus::Input && self.input.len() + c.len_utf8() <= 64 * 1024 =>
            {
                self.input.push(c);
                self.completion_index = 0;
                self.completion_dismissed = false;
                if self.view == View::Welcome {
                    self.view = View::Conversation;
                }
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
                    self.show_groups()?;
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
                .filter_map(|g| g["id"].as_str())
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
        }
        self.freshness.insert(thread.id.clone(), Instant::now());
        self.threads.insert(thread.id.clone(), thread);
    }
    fn snapshot(&mut self, thread: Thread) {
        let id = thread.id.clone();
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
                if let Purpose::Configure(id) = &request.purpose {
                    // revision 冲突后重新读取权威配置，保留选择器供用户重试。
                    self.queue(
                        "thread/resume",
                        json!({"threadId":id}),
                        Purpose::Resume(id.clone()),
                    )?;
                }
                return Ok(());
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
                Purpose::Configure(id) => {
                    self.update_configuration(&id, result)?;
                    if self.selected.as_ref() == Some(&id) {
                        self.status = format!("Model changed: {}", self.model_label());
                        if self
                            .picker
                            .as_ref()
                            .is_some_and(|p| p.kind == PickerKind::Models)
                        {
                            self.picker = None;
                        }
                    }
                }
                Purpose::Create(generation) => {
                    let thread: Thread = serde_json::from_value(result["thread"].clone())?;
                    self.subscriptions.insert(thread.id.clone());
                    if self.generation == generation {
                        self.selected = Some(thread.id.clone());
                        self.nav_selected = Some(NavTarget::Thread(thread.id.clone()));
                    }
                    self.snapshot(thread);
                }
                Purpose::Resume(id) => {
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
                    if generation != self.group_generation {
                        return Ok(());
                    }
                    if let Some(data) = result["data"].as_array() {
                        self.groups = data.clone();
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
                    desktop.interactions.push(interaction);
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
        let thread = self.threads.get_mut(id).unwrap();
        match method {
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
            "item/agentMessage/delta" => {
                if let Some(turn) = thread
                    .turns
                    .iter_mut()
                    .find(|t| Some(t.id.as_str()) == p["turnId"].as_str())
                    && let Some(Item::AgentMessage { id: item_id, text }) = turn
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub fn thread(id: &str, parent: Option<&str>) -> Thread {
        serde_json::from_value(json!({"id":id,"sessionId":"session","parentThreadId":parent,"preview":format!("Task {id}"),"modelProvider":"fixture","createdAt":0,"updatedAt":0,"status":{"type":"idle"},"cwd":"/workspace","cliVersion":"test","source":"test","ephemeral":false,"turns":[{"id":"turn","items":[],"status":"completed","error":null}]})).unwrap()
    }
    #[test]
    fn completion_and_picker_keys_preserve_drafts_and_do_not_send_prompts() {
        let mut app = App::new(Preferences::default());
        app.input = "/ses".into();
        app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE))
            .unwrap();
        assert_eq!(app.input, "/sessions");
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
                method: "areal/thread/configure".into(),
                params: json!({}),
                purpose: Purpose::Configure("root".into()),
            },
        );
        app.receive(json!({"id":1,"error":{"message":"conflict"}}))
            .unwrap();
        assert!(app.picker.is_some());
        assert_eq!(app.outbox[0].method, "thread/resume");
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
    fn resume_replaces_old_history_without_switching_selection() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("parent".into());
        let mut old = thread("child", Some("parent"));
        old.turns[0].items.push(Item::AgentMessage {
            id: "old".into(),
            text: "stale delta".into(),
        });
        app.snapshot(old);
        app.pending.insert(
            1,
            Request {
                method: "thread/resume".into(),
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
}
