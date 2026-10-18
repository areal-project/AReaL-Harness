use std::collections::{BTreeMap, BTreeSet};

use areal_protocol::{
    AgentMessagePhase, Item, Thread, ToolOutcome, ToolStatus, Turn, TurnStatus,
    goals::{Goal, GoalStatus},
};
use ratatui::text::Line;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    safe_text,
    theme::{Palette, Role},
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ItemKey(pub String, pub String);

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum BlockKey {
    Item(ItemKey),
    Activity(ItemKey),
    Result(String),
    Goal(String),
    Interaction,
}

#[derive(Clone, Debug)]
struct TextRow {
    text: String,
    byte: usize,
}

#[derive(Debug)]
struct Block {
    key: BlockKey,
    parent: Option<BlockKey>,
    header: Vec<TextRow>,
    role: Role,
    rows: Vec<TextRow>,
    expandable: bool,
    open: bool,
    partial: bool,
    start: usize,
}
impl Block {
    fn height(&self) -> usize {
        self.header.len() + self.rows.len() + 1
    }
    fn new(
        key: BlockKey,
        label: String,
        role: Role,
        text: String,
        expandable: bool,
        open: bool,
        width: usize,
    ) -> Self {
        let label = if expandable {
            format!("{} {label}", if open { "[-]" } else { "[+]" })
        } else {
            label
        };
        Self {
            key,
            parent: None,
            header: wrap(&safe_text(&label), width),
            role,
            rows: wrap(&safe_text(&text), width),
            expandable,
            open,
            partial: false,
            start: 0,
        }
    }
}

#[derive(Debug)]
pub struct History {
    blocks: Vec<Block>,
    width: usize,
    dirty: BTreeSet<ItemKey>,
    rebuild: bool,
    reset_cache: bool,
    expanded: BTreeSet<BlockKey>,
    detail_collapsed: BTreeSet<BlockKey>,
    selected: Option<BlockKey>,
    pub detailed: bool,
    pub top: usize,
    pub total: usize,
    pub height: usize,
    pub follow: bool,
    pub unread: BTreeSet<ItemKey>,
    unread_failures: BTreeSet<String>,
    anchor: Option<(BlockKey, Option<usize>)>,
}
impl Default for History {
    fn default() -> Self {
        Self {
            blocks: Vec::new(),
            width: 0,
            dirty: BTreeSet::new(),
            rebuild: true,
            reset_cache: true,
            expanded: BTreeSet::new(),
            detail_collapsed: BTreeSet::new(),
            selected: None,
            detailed: false,
            top: 0,
            total: 0,
            height: 0,
            follow: true,
            unread: BTreeSet::new(),
            unread_failures: BTreeSet::new(),
            anchor: None,
        }
    }
}
impl History {
    pub fn invalidate(&mut self) {
        self.rebuild = true;
        self.reset_cache = true;
    }
    pub fn changed(&mut self, turn: &str, item: &str) {
        let key = ItemKey(turn.into(), item.into());
        self.dirty.insert(key.clone());
        if !self.follow {
            self.unread.insert(key);
        }
    }
    pub fn failed(&mut self, turn: &str) {
        if !self.follow {
            self.unread_failures.insert(turn.into());
        }
        self.invalidate();
    }
    fn open(&self, key: &BlockKey) -> bool {
        if self.detailed {
            !self.detail_collapsed.contains(key)
        } else {
            self.expanded.contains(key)
        }
    }
    pub fn prepare(&mut self, thread: &Thread, width: u16, height: u16) {
        let width = usize::from(width.max(1));
        self.height = usize::from(height.max(1));
        if self.width != width || self.rebuild || !self.dirty.is_empty() {
            let all = self.width != width || self.reset_cache;
            let mut old: BTreeMap<_, _> = std::mem::take(&mut self.blocks)
                .into_iter()
                .map(|b| (b.key.clone(), b))
                .collect();
            let parents: BTreeMap<_, _> = old
                .values()
                .filter_map(|b| b.parent.clone().map(|p| (b.key.clone(), p)))
                .collect();
            for turn in &thread.turns {
                let partial = if matches!(turn.status, TurnStatus::Failed | TurnStatus::Interrupted)
                {
                    turn.items.iter().rev().find_map(|item| match item {
                        Item::AgentMessage { id, text, .. } if !text.trim().is_empty() => {
                            Some(id.as_str())
                        }
                        _ => None,
                    })
                } else {
                    None
                };
                let mut activity = Vec::new();
                for item in &turn.items {
                    if matches!(item, Item::ModelContext { .. })
                        || matches!(item, Item::AgentMessage { text, .. } if text.trim().is_empty())
                    {
                        continue;
                    }
                    if is_trace(item) && partial != Some(item.id()) {
                        activity.push(item);
                        continue;
                    }
                    self.activity(turn, &activity, width, all, &mut old);
                    activity.clear();
                    let mut block =
                        self.item(turn, item, width, all, partial == Some(item.id()), &mut old);
                    if turn
                        .goal
                        .as_ref()
                        .is_some_and(|g| g.origin == "continuation")
                        && matches!(item, Item::UserMessage { .. })
                    {
                        block.header = wrap("Goal · automatic continuation", width);
                    }
                    self.blocks.push(block);
                }
                self.activity(turn, &activity, width, all, &mut old);
                if let Some(block) = self.result(turn, width) {
                    self.blocks.push(block);
                }
            }
            if let Some(goal) = &thread.goals.goal
                && matches!(
                    goal.status,
                    GoalStatus::Blocked
                        | GoalStatus::Failed
                        | GoalStatus::BudgetLimited
                        | GoalStatus::Paused
                )
            {
                let key = BlockKey::Goal(goal.id.clone());
                let open = self.open(&key);
                let mut text = format!("{}\n{}", goal_reason(goal), goal_usage(goal));
                if open {
                    text.push_str(&format!(
                        "\nGoal: {}\nReason: {}",
                        goal.id,
                        goal.reason.as_deref().unwrap_or("not supplied")
                    ));
                }
                self.blocks.push(Block::new(
                    key,
                    format!("Goal {:?} · automatic continuation stopped", goal.status),
                    Role::Warning,
                    text,
                    true,
                    open,
                    width,
                ));
            }
            let pending = thread.desktop.as_ref().map_or(0, |d| {
                d.interactions
                    .iter()
                    .filter(|i| i.status == "pending")
                    .count()
            });
            if pending > 0 {
                self.blocks.push(Block::new(
                    BlockKey::Interaction,
                    format!("Action required · {pending} pending interaction(s)"),
                    Role::Warning,
                    "Use the Web client to answer or approve.".into(),
                    false,
                    false,
                    width,
                ));
            }
            let mut start = 0;
            for block in &mut self.blocks {
                block.start = start;
                start += block.height();
            }
            self.total = start;
            self.width = width;
            self.dirty.clear();
            self.rebuild = false;
            self.reset_cache = false;
            // 收起父组或正文阶段变化时，阅读位置退到同一组；不能跳到不相关的尾部。
            if let Some(key) = &self.selected
                && !self.blocks.iter().any(|b| &b.key == key)
            {
                self.selected = parents
                    .get(key)
                    .filter(|p| self.blocks.iter().any(|b| &b.key == *p))
                    .cloned();
            }
            if let Some((key, byte)) = &mut self.anchor
                && !self.blocks.iter().any(|b| &b.key == key)
            {
                if let Some(parent) = parents.get(key) {
                    *key = parent.clone();
                    *byte = None;
                } else if let BlockKey::Item(item) = key
                    && let Some(group) = self
                        .blocks
                        .iter()
                        .find(|b| matches!(&b.key, BlockKey::Activity(first) if first.0 == item.0))
                {
                    *key = group.key.clone();
                    *byte = None;
                }
            }
            if !self.follow
                && let Some((key, byte)) = &self.anchor
                && let Some(block) = self.blocks.iter().find(|b| &b.key == key)
            {
                self.top = block.start
                    + byte.map_or(0, |byte| {
                        if byte == usize::MAX {
                            block.height() - 1
                        } else if block.rows.is_empty() {
                            0
                        } else {
                            block
                                .rows
                                .partition_point(|r| r.byte <= byte)
                                .saturating_sub(1)
                                + block.header.len()
                        }
                    });
            }
        }
        self.top = if self.follow {
            self.max_top()
        } else {
            self.top.min(self.max_top())
        };
        if self.follow || self.anchor.is_none() {
            self.remember_anchor();
        }
    }
    fn item(
        &self,
        turn: &Turn,
        item: &Item,
        width: usize,
        all: bool,
        partial: bool,
        old: &mut BTreeMap<BlockKey, Block>,
    ) -> Block {
        let item_key = ItemKey(turn.id.clone(), item.id().into());
        let key = BlockKey::Item(item_key.clone());
        let open = self.open(&key);
        if !all
            && !self.dirty.contains(&item_key)
            && let Some(block) = old.remove(&key)
            && block.open == open
            && block.partial == partial
        {
            return block;
        }
        let mut block = make_block(item, key, open, partial, width);
        block.partial = partial;
        block
    }
    fn activity(
        &mut self,
        turn: &Turn,
        items: &[&Item],
        width: usize,
        all: bool,
        old: &mut BTreeMap<BlockKey, Block>,
    ) {
        let Some(first) = items.first() else {
            return;
        };
        let key = BlockKey::Activity(ItemKey(turn.id.clone(), first.id().into()));
        let open = self.open(&key);
        let mut counts = BTreeMap::<&str, usize>::new();
        let mut failures = Vec::new();
        let mut running = None;
        let mut cancelled = 0;
        for item in items {
            if matches!(item, Item::DynamicToolCall { execution, .. } if execution.outcome == ToolOutcome::Cancelled)
            {
                cancelled += 1;
            }
            *counts.entry(activity_name(item)).or_default() += 1;
            if let Some(reason) = tool_failure(item) {
                failures.push(reason);
            }
            if let Item::DynamicToolCall {
                tool, execution, ..
            } = item
                && execution.outcome == ToolOutcome::Running
            {
                running = Some(tool.as_str());
            }
        }
        let mut label = format!(
            "Activity · {}",
            counts
                .iter()
                .map(|(name, n)| format!("{n} {name}"))
                .collect::<Vec<_>>()
                .join(" · ")
        );
        if let Some(tool) = running {
            label.push_str(&format!(" · running {}", short_text(tool, 48)));
        }
        if cancelled > 0 {
            label.push_str(&format!(" · {cancelled} cancelled"));
        }
        if !failures.is_empty() {
            label.push_str(&format!(" · {} issue(s)", failures.len()));
        }
        let text = failures
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        self.blocks.push(Block::new(
            key.clone(),
            label,
            if failures.is_empty() {
                Role::Tool
            } else {
                Role::Error
            },
            text,
            true,
            open,
            width,
        ));
        if open {
            for item in items {
                let mut block = self.item(turn, item, width, all, false, old);
                block.parent = Some(key.clone());
                self.blocks.push(block);
            }
        }
    }
    fn result(&self, turn: &Turn, width: usize) -> Option<Block> {
        let key = BlockKey::Result(turn.id.clone());
        let open = self.open(&key);
        let (label, role, mut text, expandable) = match turn.status {
            TurnStatus::Failed => ("Turn failed", Role::Error, format!("{}\nInspect the error before continuing; confirmed tools are not replayed.", turn.error.as_ref().filter(|e| !e.message.trim().is_empty()).map_or_else(|| "Server supplied no error details.".into(), |e| short_text(&e.message, 180))), true),
            TurnStatus::Interrupted => ("Interrupted · stopped", Role::Warning, "Partial output is retained.".into(), false),
            TurnStatus::Completed if !turn.items.iter().any(|i| matches!(i, Item::AgentMessage { text, phase, .. } if !text.trim().is_empty() && *phase != Some(AgentMessagePhase::Commentary)) || matches!(i, Item::AgentMedia { .. })) => ("Turn completed · no final reply", Role::Muted, "Execution records are available above.".into(), false),
            _ => return None,
        };
        if open && expandable {
            text.push_str(&format!(
                "\nTurn: {}\n{}",
                turn.id,
                turn.error
                    .as_ref()
                    .map_or("Server supplied no error details.", |e| e.message.as_str())
            ));
        }
        Some(Block::new(
            key,
            label.into(),
            role,
            text,
            expandable,
            open,
            width,
        ))
    }
    pub fn max_top(&self) -> usize {
        self.total.saturating_sub(self.height)
    }
    pub fn move_by(&mut self, delta: isize) {
        self.follow = false;
        self.top = self.top.saturating_add_signed(delta).min(self.max_top());
        self.remember_anchor();
    }
    pub fn home(&mut self) {
        self.follow = false;
        self.top = 0;
        self.remember_anchor();
    }
    pub fn end(&mut self) {
        self.follow = true;
        self.top = self.max_top();
        self.unread.clear();
        self.unread_failures.clear();
        self.selected = None;
        self.remember_anchor();
    }
    fn remember_anchor(&mut self) {
        self.anchor = self
            .blocks
            .get(
                self.blocks
                    .partition_point(|b| b.start <= self.top)
                    .saturating_sub(1),
            )
            .map(|b| {
                (
                    b.key.clone(),
                    if self.top < b.start + b.header.len() {
                        None
                    } else {
                        Some(
                            b.rows
                                .get(self.top - b.start - b.header.len())
                                .map_or(usize::MAX, |r| r.byte),
                        )
                    },
                )
            });
    }
    fn select(&mut self, key: BlockKey) {
        if let Some(block) = self.blocks.iter().find(|b| b.key == key) {
            self.follow = false;
            if block.start < self.top || block.start >= self.top + self.height {
                self.top = block.start.min(self.max_top());
            }
            self.selected = Some(key);
            self.remember_anchor();
        }
    }
    pub fn select_next(&mut self, forward: bool) {
        let candidates: Vec<_> = self.blocks.iter().filter(|b| b.expandable).collect();
        if candidates.is_empty() {
            self.move_by(if forward { 1 } else { -1 });
            return;
        }
        let index = self
            .selected
            .as_ref()
            .and_then(|k| candidates.iter().position(|b| &b.key == k));
        let index = match index {
            Some(i) if forward => (i + 1).min(candidates.len() - 1),
            Some(i) => i.saturating_sub(1),
            None => candidates
                .iter()
                .position(|b| b.start + b.height() > self.top)
                .unwrap_or(candidates.len() - 1),
        };
        self.select(candidates[index].key.clone());
    }
    pub fn expand_selected(&mut self, desired: Option<bool>) {
        let selected = self
            .selected
            .clone()
            .filter(|k| self.blocks.iter().any(|b| &b.key == k && b.expandable))
            .or_else(|| {
                self.blocks
                    .iter()
                    .find(|b| {
                        b.expandable
                            && b.start + b.height() > self.top
                            && b.start < self.top + self.height
                    })
                    .map(|b| b.key.clone())
            });
        let Some(key) = selected else {
            return;
        };
        let open = desired.unwrap_or_else(|| !self.open(&key));
        self.select(key.clone());
        self.anchor = Some((key.clone(), None));
        if self.detailed {
            if open {
                self.detail_collapsed.remove(&key);
            } else {
                self.detail_collapsed.insert(key);
            }
        } else if open {
            self.expanded.insert(key);
        } else {
            self.expanded.remove(&key);
        }
        self.rebuild = true;
    }
    pub fn hit(&self, row: usize) -> Option<BlockKey> {
        let line = self.top + row;
        self.blocks
            .iter()
            .find(|b| b.expandable && b.start <= line && line < b.start + b.header.len())
            .map(|b| b.key.clone())
    }
    pub fn click(&mut self, row: usize) -> bool {
        let Some(key) = self.hit(row) else {
            return false;
        };
        self.select(key);
        self.expand_selected(None);
        true
    }
    pub fn toggle_details(&mut self) {
        self.follow = false;
        self.remember_anchor();
        self.detailed = !self.detailed;
        self.detail_collapsed.clear();
        self.rebuild = true;
    }
    pub fn lines(&self, palette: Palette) -> Vec<Line<'_>> {
        let mut lines = Vec::with_capacity(self.height);
        let first = self
            .blocks
            .partition_point(|b| b.start + b.height() <= self.top);
        for block in &self.blocks[first..] {
            if block.start >= self.top + self.height {
                break;
            }
            for offset in self.top.saturating_sub(block.start)..block.height() {
                if lines.len() >= self.height {
                    break;
                }
                let header = block.header.get(offset);
                let (text, role) = if let Some(row) = header {
                    (row.text.as_str(), block.role)
                } else if let Some(row) = block.rows.get(offset - block.header.len()) {
                    (
                        row.text.as_str(),
                        if matches!(block.role, Role::Error | Role::Warning) {
                            block.role
                        } else {
                            Role::Text
                        },
                    )
                } else {
                    ("", Role::Text)
                };
                let style = if header.is_some() && self.selected.as_ref() == Some(&block.key) {
                    palette.selected()
                } else {
                    palette.style(role)
                };
                lines.push(Line::styled(text, style));
            }
        }
        lines
    }
    pub fn progress(&self) -> String {
        if self.total == 0 {
            return "No history · /help for commands".into();
        }
        let end = (self.top + self.height).min(self.total);
        format!(
            "{}Lines {}–{} / {} · Read {}% · {} · {}{}",
            if self.unread_failures.is_empty() {
                String::new()
            } else {
                format!(
                    "{} new failure(s) · End: latest · ",
                    self.unread_failures.len()
                )
            },
            self.top + 1,
            end,
            self.total,
            end.saturating_mul(100) / self.total,
            if self.follow { "LIVE" } else { "Browsing" },
            if self.detailed { "Details" } else { "Compact" },
            if self.unread.is_empty() {
                String::new()
            } else {
                format!(" · {} updates · End: latest", self.unread.len())
            }
        )
    }
}

fn is_trace(item: &Item) -> bool {
    matches!(
        item,
        Item::Reasoning { .. }
            | Item::DynamicToolCall { .. }
            | Item::AgentMessage {
                phase: Some(AgentMessagePhase::Commentary),
                ..
            }
    )
}
fn activity_name(item: &Item) -> &str {
    match item {
        Item::Reasoning { .. } => "reasoning",
        Item::AgentMessage { .. } => "commentary",
        Item::DynamicToolCall { tool, .. } => match tool.as_str() {
            "fs_read" | "read_file" | "read_files" => "reads",
            "search_files" | "search" | "grep" => "searches",
            "run_command" | "exec_command" | "read_process" => "commands",
            "agent_spawn" | "agent_wait" | "agent_read" | "delegate_tasks" | "read_agent" => {
                "agent calls"
            }
            _ => tool,
        },
        _ => "items",
    }
}
pub fn short_text(text: &str, limit: usize) -> String {
    let mut graphemes = text.graphemes(true);
    let mut text =
        safe_text(&graphemes.by_ref().take(limit).collect::<String>()).replace(['\n', '\t'], " ");
    if graphemes.next().is_some() {
        text.push('…');
    }
    text
}
fn tool_state(status: &ToolStatus, outcome: &ToolOutcome, success: &Option<bool>) -> &'static str {
    match outcome {
        ToolOutcome::Unknown => "UNKNOWN · inspect before continuing",
        ToolOutcome::Cancelled => "cancelled",
        ToolOutcome::Failed => "failed",
        _ if *status == ToolStatus::Failed || *success == Some(false) => "failed",
        ToolOutcome::Running => "running",
        _ => "succeeded",
    }
}
fn tool_failure(item: &Item) -> Option<String> {
    if let Item::DynamicToolCall {
        tool,
        status,
        execution,
        success,
        content_items,
        ..
    } = item
    {
        let state = tool_state(status, &execution.outcome, success);
        if state == "failed" || execution.outcome == ToolOutcome::Unknown {
            let reason = content_items
                .as_ref()
                .and_then(|v| v.iter().find_map(|v| v["text"].as_str()))
                .map(|s| short_text(s, 120))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "No error details supplied.".into());
            return Some(format!("{} · {state}: {reason}", short_text(tool, 48)));
        }
    }
    None
}
pub fn goal_usage(goal: &Goal) -> String {
    let usage = &goal.usage;
    if usage.unknown_requests > 0 {
        format!(
            "{} confirmed tokens · {} request(s) with unconfirmed usage",
            usage.tokens_used, usage.unknown_requests
        )
    } else if !usage.accounting_complete {
        format!(
            "{} confirmed tokens · accounting incomplete",
            usage.tokens_used
        )
    } else {
        format!("{} tokens", usage.tokens_used)
    }
}
pub fn goal_reason(goal: &Goal) -> String {
    match goal.reason.as_deref() {
        Some("usageUnknown") => {
            "Request usage is unconfirmed. Resume still requires Core usage checks.".into()
        }
        Some("storageFailure") => {
            "Could not persist execution state. Inspect Core storage before continuing.".into()
        }
        Some(reason) => short_text(reason, 180),
        None => "Inspect the goal before resuming.".into(),
    }
}
fn make_block(item: &Item, key: BlockKey, open: bool, partial: bool, width: usize) -> Block {
    let (label, role, text, expandable) = match item {
        Item::UserMessage { content, .. } => (
            "You".into(),
            Role::User,
            content
                .iter()
                .map(|i| {
                    let text = i.as_text();
                    if text.is_empty() {
                        format!("[{:?}]", i.modality())
                    } else {
                        text.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
            false,
        ),
        Item::Reasoning {
            summary, content, ..
        } => (
            "Reasoning".into(),
            Role::Agent,
            if open {
                summary
                    .iter()
                    .chain(content)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                String::new()
            },
            true,
        ),
        Item::AgentMessage { text, phase, .. } => {
            let commentary = *phase == Some(AgentMessagePhase::Commentary) && !partial;
            (
                if partial {
                    "Agent · incomplete reply"
                } else if commentary {
                    "Agent commentary"
                } else {
                    "Agent"
                }
                .into(),
                Role::Agent,
                if commentary && !open {
                    String::new()
                } else {
                    text.clone()
                },
                commentary,
            )
        }
        Item::AgentMedia {
            modality, media, ..
        } => (
            "Agent media".into(),
            Role::Agent,
            format!("[{modality:?}] {}", media.uri),
            false,
        ),
        Item::DynamicToolCall {
            tool,
            arguments,
            status,
            content_items,
            execution,
            success,
            ..
        } => {
            let state = tool_state(status, &execution.outcome, success);
            let label = format!(
                "Tool · {} · {state}{}",
                short_text(tool, 64),
                execution
                    .duration_ms
                    .map_or(String::new(), |ms| format!(" · {ms} ms"))
            );
            let text = if open {
                format!(
                    "Arguments\n{}\nOutput\n{}",
                    serde_json::to_string_pretty(arguments).unwrap_or_default(),
                    content_items
                        .as_ref()
                        .map(|items| items
                            .iter()
                            .map(|v| v["text"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| v.to_string()))
                            .collect::<Vec<_>>()
                            .join("\n"))
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "No tool output received.".into())
                )
            } else {
                tool_failure(item).unwrap_or_default()
            };
            (
                label,
                if state.starts_with("UNKNOWN") || state == "failed" {
                    Role::Error
                } else if state == "cancelled" {
                    Role::Warning
                } else {
                    Role::Tool
                },
                text,
                true,
            )
        }
        Item::ModelContext { .. } => unreachable!(),
    };
    Block::new(key, label, role, text, expandable, open, width)
}

fn wrap(text: &str, width: usize) -> Vec<TextRow> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut row = String::new();
    let mut columns = 0;
    let mut start = 0;
    for (byte, grapheme) in text.grapheme_indices(true) {
        if grapheme == "\n" {
            rows.push(TextRow {
                text: std::mem::take(&mut row),
                byte: start,
            });
            columns = 0;
            start = byte + 1;
            continue;
        }
        let size = if grapheme == "\t" {
            (4 - columns % 4).min(width)
        } else {
            grapheme.width()
        };
        if columns + size > width && !row.is_empty() {
            rows.push(TextRow {
                text: std::mem::take(&mut row),
                byte: start,
            });
            columns = 0;
            start = byte;
        }
        if grapheme == "\t" {
            let spaces = (4 - columns % 4).min(width - columns);
            row.extend(std::iter::repeat_n(' ', spaces));
            columns += spaces;
        } else if size > width {
            row.push('?');
            columns += 1;
        } else {
            row.push_str(grapheme);
            columns += size;
        }
    }
    if !row.is_empty() || text.ends_with('\n') {
        rows.push(TextRow {
            text: row,
            byte: start,
        });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::thread;
    fn output(history: &History) -> String {
        history
            .lines(Palette::new(crate::theme::Theme::Dark, false, false))
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn tool(id: &str, outcome: &str) -> Item {
        serde_json::from_value(serde_json::json!({"type":"dynamicToolCall","id":id,"tool":"fs_read","arguments":{"path":"PRIVATE_ARGUMENT"},"status":if outcome == "failed" {"failed"} else {"completed"},"success":outcome == "succeeded","callId":id,"contentItems":[{"type":"inputText","text":format!("PRIVATE_OUTPUT_{id}\nsecond line")}],"execution":{"runtimeEpoch":"","scopeId":"","operationId":id,"outcome":outcome}})).unwrap()
    }
    fn message(id: &str, phase: Option<AgentMessagePhase>, text: &str) -> Item {
        Item::AgentMessage {
            id: id.into(),
            text: text.into(),
            phase,
        }
    }
    #[test]
    fn compact_groups_hide_all_payloads_and_precise_expansion_preserves_choices() {
        let mut t = thread("root", None);
        t.turns[0].items = (0..100)
            .map(|i| tool(&i.to_string(), "succeeded"))
            .collect();
        t.turns[0].items.insert(
            0,
            message(
                "comment",
                Some(AgentMessagePhase::Commentary),
                "PRIVATE_COMMENTARY",
            ),
        );
        t.turns[0].items.insert(
            1,
            Item::Reasoning {
                id: "reason".into(),
                summary: vec![],
                content: vec!["PRIVATE_REASONING".into()],
            },
        );
        t.turns[0].items.push(message(
            "answer",
            Some(AgentMessagePhase::FinalAnswer),
            "Visible final reply",
        ));
        let mut h = History::default();
        h.prepare(&t, 180, 400);
        assert_eq!(h.blocks.len(), 2);
        assert!(output(&h).contains("100 reads"));
        assert!(!output(&h).contains("PRIVATE_"));
        h.select_next(true);
        h.expand_selected(Some(true));
        h.prepare(&t, 180, 400);
        assert_eq!(h.blocks.len(), 104);
        assert!(!output(&h).contains("PRIVATE_"));
        let row = h
            .blocks
            .iter()
            .find(|b| b.key == BlockKey::Item(ItemKey("turn".into(), "1".into())))
            .unwrap()
            .start;
        assert!(h.click(row - h.top));
        h.prepare(&t, 180, 400);
        assert!(output(&h).contains("PRIVATE_OUTPUT_1"));
        assert!(!output(&h).contains("PRIVATE_OUTPUT_0\n"));
        assert!(!h.follow);
        h.toggle_details();
        h.prepare(&t, 180, 500);
        h.home();
        assert!(output(&h).contains("PRIVATE_REASONING"));
        assert!(output(&h).contains("PRIVATE_COMMENTARY"));
        h.toggle_details();
        h.prepare(&t, 180, 500);
        h.home();
        assert!(output(&h).contains("PRIVATE_OUTPUT_1"));
        assert!(!output(&h).contains("PRIVATE_REASONING"));
        assert!(!output(&h).contains("PRIVATE_OUTPUT_0\n"));
    }
    #[test]
    fn failures_empty_messages_partial_answers_and_old_history_remain_visible() {
        let mut t = thread("root", None);
        t.turns[0].status = TurnStatus::Failed;
        t.turns[0].error = Some(areal_protocol::TurnError {
            outcome: None,
            message: "provider connection failed".into(),
        });
        t.turns[0].items = vec![message("empty", Some(AgentMessagePhase::Commentary), "")];
        let mut h = History::default();
        h.prepare(&t, 80, 100);
        assert!(!output(&h).contains("Agent"));
        assert!(output(&h).contains("provider connection failed"));
        let mut second = t.turns[0].clone();
        second.id = "second".into();
        second.error = None;
        second.items.push(message(
            "partial",
            Some(AgentMessagePhase::Commentary),
            "Keep this partial response",
        ));
        t.turns.push(second);
        h.invalidate();
        h.prepare(&t, 80, 100);
        assert_eq!(output(&h).matches("Turn failed").count(), 2);
        assert!(output(&h).contains("Agent · incomplete reply"));
        assert!(output(&h).contains("Keep this partial response"));
        assert!(output(&h).contains("Server supplied no error details"));
        let snapshot: Thread = serde_json::from_value(serde_json::to_value(t).unwrap()).unwrap();
        let mut reopened = History::default();
        reopened.prepare(&snapshot, 80, 100);
        assert_eq!(output(&h), output(&reopened));
        let mut old = thread("legacy", None);
        old.turns[0]
            .items
            .push(message("old", None, "Legacy prose remains visible"));
        h.invalidate();
        h.prepare(&old, 80, 100);
        assert!(output(&h).contains("Legacy prose remains visible"));
    }
    #[test]
    fn collapsed_failures_and_unknown_outcomes_are_visible_but_cancellation_is_distinct() {
        let mut t = thread("root", None);
        t.turns[0].items = vec![
            tool("ok", "succeeded"),
            tool("fail", "failed"),
            tool("unknown", "unknown"),
            tool("stop", "cancelled"),
        ];
        let mut h = History::default();
        h.prepare(&t, 80, 100);
        let rendered = output(&h);
        assert!(rendered.contains("2 issue(s)"));
        assert!(rendered.contains("1 cancelled"));
        assert!(rendered.contains("UNKNOWN"));
        assert!(rendered.contains("PRIVATE_OUTPUT_fail"));
        assert!(!rendered.contains("PRIVATE_OUTPUT_ok"));
        assert!(!rendered.contains("PRIVATE_OUTPUT_stop"));
        assert!(!rendered.contains("PRIVATE_ARGUMENT"));
    }
    #[test]
    fn wrapped_headers_and_scroll_offsets_target_the_right_item() {
        let mut t = thread("root", None);
        t.turns[0].items = vec![
            tool("one", "succeeded"),
            tool("two", "succeeded"),
            tool("three", "succeeded"),
        ];
        let mut h = History::default();
        h.prepare(&t, 16, 8);
        h.select_next(true);
        h.expand_selected(Some(true));
        h.prepare(&t, 16, 8);
        h.select_next(true);
        h.select_next(true);
        let selected = h.selected.clone();
        h.prepare(&t, 12, 8);
        let start = h
            .blocks
            .iter()
            .find(|b| Some(&b.key) == selected.as_ref())
            .unwrap()
            .start;
        h.move_by(start as isize - h.top as isize);
        assert!(h.click(start - h.top + 1));
        h.prepare(&t, 12, 8);
        assert_eq!(h.selected, selected);
        assert!(
            h.blocks
                .iter()
                .find(|b| Some(&b.key) == selected.as_ref())
                .unwrap()
                .open
        );
        assert!(
            h.blocks
                .iter()
                .flat_map(|b| b.header.iter().chain(&b.rows))
                .all(|r| r.text.width() <= 12)
        );
        h.end();
        assert!(h.follow);
    }
    #[test]
    fn cancelled_and_empty_completed_turns_have_explicit_results() {
        let mut t = thread("root", None);
        let mut h = History::default();
        h.prepare(&t, 80, 20);
        assert!(output(&h).contains("no final reply"));
        t.turns[0].status = TurnStatus::Interrupted;
        h.invalidate();
        h.prepare(&t, 80, 20);
        assert!(output(&h).contains("Interrupted · stopped"));
    }
    #[test]
    fn long_history_reaches_tail_without_u16_truncation() {
        let mut t = thread("root", None);
        t.turns[0].items.push(Item::AgentMessage {
            phase: None,
            id: "large".into(),
            text: (0..70_000).map(|i| format!("line {i}\n")).collect(),
        });
        let mut h = History::default();
        h.prepare(&t, 80, 20);
        assert!(h.top > 65_535);
        assert!(
            h.lines(Palette::new(crate::theme::Theme::Dark, false, false))
                .iter()
                .any(|l| l.to_string().contains("line 69999"))
        );
        h.home();
        assert_eq!(h.top, 0);
        h.move_by(-10);
        assert_eq!(h.top, 0);
        h.end();
        assert_eq!(h.top, h.max_top());
    }
    #[test]
    fn browsing_survives_streaming_and_width_changes() {
        let mut t = thread("root", None);
        t.turns[0].items.push(Item::AgentMessage {
            phase: None,
            id: "msg".into(),
            text: "汉字 e\u{301} 👍🏽\t".repeat(100),
        });
        let mut h = History::default();
        h.prepare(&t, 30, 6);
        h.home();
        h.move_by(8);
        let anchor = h.anchor.clone().unwrap();
        if let Item::AgentMessage { text, .. } = &mut t.turns[0].items[0] {
            text.push_str("tail\n");
        }
        h.changed("turn", "msg");
        h.prepare(&t, 30, 6);
        assert_eq!(h.top, 8);
        assert_eq!(h.unread.len(), 1);
        h.prepare(&t, 15, 6);
        assert_eq!(h.anchor.as_ref().unwrap().0, anchor.0);
        assert!(h.anchor.as_ref().unwrap().1 <= anchor.1);
        assert!(h.blocks[0].rows.iter().all(|r| r.text.width() <= 15));
        h.end();
        assert!(h.unread.is_empty());
    }
}
