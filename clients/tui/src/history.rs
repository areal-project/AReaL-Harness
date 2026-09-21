use std::collections::{BTreeMap, BTreeSet};

use areal_protocol::{Item, Thread, ToolOutcome, ToolStatus};
use ratatui::text::Line;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    safe_text,
    theme::{Palette, Role},
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ItemKey(pub String, pub String);

#[derive(Clone, Debug)]
struct TextRow {
    text: String,
    byte: usize,
}

#[derive(Debug)]
struct Block {
    key: ItemKey,
    label: String,
    role: Role,
    rows: Vec<TextRow>,
    tool: bool,
    start: usize,
}
impl Block {
    fn height(&self) -> usize {
        self.rows.len() + 2
    }
}

#[derive(Debug)]
pub struct History {
    blocks: Vec<Block>,
    width: usize,
    dirty: BTreeSet<ItemKey>,
    rebuild: bool,
    expanded: BTreeSet<ItemKey>,
    pub top: usize,
    pub total: usize,
    pub height: usize,
    pub follow: bool,
    pub unread: BTreeSet<ItemKey>,
    anchor: Option<(ItemKey, Option<usize>)>,
}
impl Default for History {
    fn default() -> Self {
        Self {
            blocks: Vec::new(),
            width: 0,
            dirty: BTreeSet::new(),
            rebuild: true,
            expanded: BTreeSet::new(),
            top: 0,
            total: 0,
            height: 0,
            follow: true,
            unread: BTreeSet::new(),
            anchor: None,
        }
    }
}
impl History {
    pub fn invalidate(&mut self) {
        self.rebuild = true;
    }
    pub fn changed(&mut self, turn: &str, item: &str) {
        let key = ItemKey(turn.into(), item.into());
        self.dirty.insert(key.clone());
        if !self.follow {
            self.unread.insert(key);
        }
    }
    pub fn prepare(&mut self, thread: &Thread, width: u16, height: u16) {
        let width = usize::from(width.max(1));
        self.height = usize::from(height.max(1));
        if self.width != width || self.rebuild || !self.dirty.is_empty() {
            let all = self.width != width || self.rebuild;
            let mut old: BTreeMap<_, _> = std::mem::take(&mut self.blocks)
                .into_iter()
                .map(|b| (b.key.clone(), b))
                .collect();
            let mut start = 0;
            for turn in &thread.turns {
                for item in &turn.items {
                    if matches!(item, Item::ModelContext { .. }) {
                        continue;
                    }
                    let key = ItemKey(turn.id.clone(), item.id().into());
                    let block = if !all && !self.dirty.contains(&key) {
                        old.remove(&key)
                    } else {
                        None
                    };
                    let mut block = block.unwrap_or_else(|| {
                        make_block(item, key.clone(), self.expanded.contains(&key), width)
                    });
                    block.start = start;
                    start += block.height();
                    self.blocks.push(block);
                }
            }
            self.total = start;
            self.width = width;
            self.dirty.clear();
            self.rebuild = false;
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
                                + 1
                        }
                    });
            }
        }
        if self.follow {
            self.top = self.max_top();
        } else {
            self.top = self.top.min(self.max_top());
        }
        if self.follow || self.anchor.is_none() {
            self.remember_anchor();
        }
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
                    if self.top == b.start {
                        None
                    } else {
                        Some(
                            b.rows
                                .get(self.top - b.start - 1)
                                .map_or(usize::MAX, |r| r.byte),
                        )
                    },
                )
            });
    }
    pub fn toggle_tool(&mut self) {
        // 展开视口内第一个工具；锚点始终绑定内容身份，避免展开后跳回尾部。
        if let Some(block) = self
            .blocks
            .iter()
            .find(|b| b.tool && b.start + b.height() > self.top && b.start < self.top + self.height)
        {
            let key = block.key.clone();
            if !self.expanded.remove(&key) {
                self.expanded.insert(key.clone());
            }
            self.dirty.insert(key);
        }
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
                let (text, role) = if offset == 0 {
                    (block.label.as_str(), block.role)
                } else if let Some(row) = block.rows.get(offset - 1) {
                    (row.text.as_str(), Role::Text)
                } else {
                    ("", Role::Text)
                };
                lines.push(Line::styled(text, palette.style(role)));
            }
        }
        lines
    }
    pub fn progress(&self) -> String {
        if self.total == 0 {
            return "No history · /help for commands".into();
        }
        let end = (self.top + self.height).min(self.total);
        let percent = end.saturating_mul(100) / self.total;
        format!(
            "Lines {}–{} / {} · Read {}% · {}{}",
            self.top + 1,
            end,
            self.total,
            percent,
            if self.follow { "LIVE" } else { "Browsing" },
            if self.unread.is_empty() {
                String::new()
            } else {
                format!(" · {} updated items · End: latest", self.unread.len())
            }
        )
    }
}

fn make_block(item: &Item, key: ItemKey, expanded: bool, width: usize) -> Block {
    let (label, role, text, tool) = match item {
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
        Item::AgentMessage { text, .. } => ("Agent".into(), Role::Agent, text.clone(), false),
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
            status,
            content_items,
            execution,
            success,
            ..
        } => {
            let failed = *status == ToolStatus::Failed
                || *success == Some(false)
                || matches!(
                    execution.outcome,
                    ToolOutcome::Failed | ToolOutcome::Unknown
                );
            let label = format!(
                "{} Tool · {} · {:?} / {:?}{}",
                if expanded { "[-]" } else { "[+]" },
                tool,
                status,
                execution.outcome,
                execution
                    .duration_ms
                    .map_or(String::new(), |v| format!(" · {v} ms"))
            );
            let text = content_items
                .as_ref()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let text = if expanded {
                text
            } else {
                text.lines()
                    .next()
                    .unwrap_or(if failed {
                        "Tool failed; focus history and press Space for details."
                    } else {
                        "Space: expand tool output"
                    })
                    .graphemes(true)
                    .take(160)
                    .collect()
            };
            (
                label,
                if failed { Role::Error } else { Role::Tool },
                text,
                true,
            )
        }
        Item::ModelContext { .. } => unreachable!(),
    };
    Block {
        key,
        label: safe_text(&label),
        role,
        rows: wrap(&safe_text(&text), width),
        tool,
        start: 0,
    }
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
    #[test]
    fn long_history_reaches_tail_without_u16_truncation() {
        let mut t = thread("root", None);
        t.turns[0].items.push(Item::AgentMessage {
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
