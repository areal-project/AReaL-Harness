use areal_protocol::ToolOutcome;
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::Modifier,
    text::{Line, Span},
    widgets::{
        Block, Clear, List, ListItem, ListState, Paragraph, Scrollbar, ScrollbarOrientation,
        ScrollbarState, Wrap,
    },
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    app::{App, Focus, NavTarget, View, short, thread_status},
    commands::PickerKind,
    safe_text,
    theme::{Palette, Role, Theme},
};

const CUP: [&str; 7] = [
    "       ╱",
    "    ┌─╱────┐",
    "    │ ░░░░ │",
    "    │ ░░░░ │",
    "    │ ●  ● │",
    "    │  ● ● │",
    "    ╰──────╯",
];
const CUP_ASCII: [&str; 7] = [
    "       /",
    "    +-/----+",
    "    | ~~~~ |",
    "    | ~~~~ |",
    "    | o  o |",
    "    |  o o |",
    "    +------+",
];

pub fn draw(frame: &mut Frame, app: &mut App) {
    let palette = app.prefs.palette();
    let area = frame.area();
    frame.render_widget(Block::default().style(palette.base), area);
    if area.width < 32 || area.height < 10 {
        frame.render_widget(
            Paragraph::new("Terminal too small (32x10 minimum)\nCtrl-Q: quit")
                .wrap(Wrap { trim: false })
                .style(palette.style(Role::Warning)),
            area,
        );
        return;
    }
    let [header, workspace, status, help] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(6),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " AReaL-Harness  ",
                palette.style(Role::Accent).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                if app.connected {
                    "Connected"
                } else {
                    "RECONNECTING · stale data"
                },
                palette.style(if app.connected {
                    Role::Success
                } else {
                    Role::Warning
                }),
            ),
            Span::styled(
                format!("  · {}", safe_text(&app.model_label())),
                palette.style(Role::Muted),
            ),
        ]))
        .style(palette.surface),
        header,
    );
    let (conversation, sidebar) = if workspace.width >= 80 {
        let [left, right] = Layout::horizontal([
            Constraint::Min(48),
            Constraint::Length((workspace.width / 3).clamp(28, 48)),
        ])
        .areas(workspace);
        (left, Some(right))
    } else {
        (workspace, None)
    };
    let [body, progress, input] = Layout::vertical([
        Constraint::Min(2),
        Constraint::Length(1),
        Constraint::Length(3),
    ])
    .areas(conversation);
    let read_progress = if app.view == View::Welcome {
        welcome(frame, body, app, palette);
        String::new()
    } else if app.view == View::Help {
        help_page(frame, body, palette);
        String::new()
    } else if sidebar.is_none() && app.focus == Focus::Navigation {
        context_panel(frame, body, app, palette);
        String::new()
    } else {
        conversation_view(frame, body, app, palette)
    };
    if let Some(sidebar) = sidebar {
        context_panel(frame, sidebar, app, palette);
    }
    frame.render_widget(
        Paragraph::new(read_progress).style(palette.style(Role::Accent)),
        progress,
    );
    input_view(frame, input, app, palette);
    frame.render_widget(
        Paragraph::new(safe_text(&app.status)).style(palette.style(if app.connected {
            Role::Muted
        } else {
            Role::Warning
        })),
        status,
    );
    let hint = match app.focus {
        Focus::Input => {
            " /: commands · Tab: focus · PgUp/PgDn · F5: sessions · F6: model · F1: help"
        }
        Focus::Navigation => {
            " ↑↓: select · ←→: tree · Enter: open · PgUp/PgDn: group · Tab: focus · Esc: input"
        }
        Focus::Content => {
            " ↑↓/PgUp/PgDn: browse · Home/End · Space: tool details · Tab: focus · Esc: input"
        }
    };
    frame.render_widget(Paragraph::new(hint).style(palette.surface), help);
    completion_popup(frame, input, body, app, palette);
    if app.theme_original.is_some() {
        theme_picker(frame, area, app, palette);
    }
    if app.picker.is_some() {
        picker_popup(frame, area, app, palette);
    }
}

fn conversation_view(frame: &mut Frame, area: Rect, app: &mut App, p: Palette) -> String {
    let title = app
        .selected
        .as_deref()
        .map(short)
        .unwrap_or_else(|| "Connecting".into());
    let block = panel(
        format!(" Conversation · {title} "),
        app.focus == Focus::Content,
        p,
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [execution, history_area] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(inner);
    frame.render_widget(
        Paragraph::new(execution_status(app)).style(p.style(Role::Muted)),
        execution,
    );
    if let Some(id) = &app.selected
        && let Some(thread) = app.threads.get(id)
    {
        let history = app.histories.entry(id.clone()).or_default();
        let text_area = Rect {
            width: history_area.width.saturating_sub(1),
            ..history_area
        };
        history.prepare(thread, text_area.width, text_area.height);
        frame.render_widget(Paragraph::new(history.lines(p)), text_area);
        let mut scrollbar = ScrollbarState::new(history.total)
            .position(history.top)
            .viewport_content_length(history.height);
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight)
                .begin_symbol(None)
                .end_symbol(None)
                .style(p.style(Role::Muted)),
            history_area,
            &mut scrollbar,
        );
        history.progress()
    } else {
        String::new()
    }
}

fn context_panel(frame: &mut Frame, area: Rect, app: &mut App, p: Palette) {
    if app.view == View::Tasks {
        let block = panel(
            " Session plan · ↑↓ / PgUp/PgDn ",
            app.focus == Focus::Navigation,
            p,
        );
        let inner = block.inner(area);
        let lines = wrap_context(plan_lines(app, p), inner.width);
        app.plan_scroll = app
            .plan_scroll
            .min(lines.len().saturating_sub(usize::from(inner.height)));
        frame.render_widget(
            Paragraph::new(
                lines
                    .into_iter()
                    .skip(app.plan_scroll)
                    .take(usize::from(inner.height))
                    .collect::<Vec<_>>(),
            )
            .block(block),
            area,
        );
    } else if app.view == View::Groups {
        let [list, details] = Layout::vertical([
            Constraint::Length(if area.height >= 16 { 7 } else { 3 }),
            Constraint::Min(1),
        ])
        .areas(area);
        navigation_view(frame, list, app, p);
        group_view(frame, details, app, p);
    } else if app.view == View::Agents && area.height >= 20 {
        let [tree, detail] =
            Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(area);
        navigation_view(frame, tree, app, p);
        agent_detail(frame, detail, app, p);
    } else {
        let [plan, agents] = Layout::vertical([
            Constraint::Length(if area.height >= 16 { 8 } else { 3 }),
            Constraint::Min(1),
        ])
        .areas(area);
        let mut lines = plan_lines(app, p);
        let available = usize::from(plan.height.saturating_sub(2));
        if lines.len() > available && available > 0 {
            let remaining = lines.len() - available + 1;
            lines.truncate(available - 1);
            lines.push(Line::styled(
                format!("+{remaining} steps · /tasks to browse"),
                p.style(Role::Muted),
            ));
        }
        if lines.is_empty() {
            lines.push(Line::styled("No session plan yet", p.style(Role::Muted)));
        }
        frame.render_widget(
            Paragraph::new(lines).block(panel(" Session plan ", false, p)),
            plan,
        );
        navigation_view(frame, agents, app, p);
    }
}

fn plan_lines(app: &App, p: Palette) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if let Some(desktop) = app.current().and_then(|t| t.desktop.as_ref()) {
        for step in &desktop.plan.steps {
            lines.push(Line::styled(
                format!(
                    "{}  {}",
                    match step.status.as_str() {
                        "completed" => "[x]",
                        "in_progress" | "inProgress" => "[>]",
                        "cancelled" => "[-]",
                        _ => "[ ]",
                    },
                    safe_text(&step.text)
                ),
                p.style(status_role(&step.status)),
            ));
        }
    }
    if lines.is_empty() {
        lines.push(Line::styled("No session plan yet", p.style(Role::Muted)));
    }
    lines
}

fn wrap_context(lines: Vec<Line<'_>>, width: u16) -> Vec<Line<'static>> {
    let width = usize::from(width.max(1));
    let mut wrapped = Vec::new();
    for line in lines {
        for text in line.to_string().split('\n') {
            let mut row = String::new();
            let mut used = 0;
            for grapheme in text.graphemes(true) {
                if used + grapheme.width() > width && !row.is_empty() {
                    wrapped.push(Line::styled(std::mem::take(&mut row), line.style));
                    used = 0;
                }
                row.push_str(grapheme);
                used += grapheme.width();
            }
            wrapped.push(Line::styled(row, line.style));
        }
    }
    wrapped
}

fn panel<'a>(title: impl Into<Line<'a>>, focused: bool, p: Palette) -> Block<'a> {
    Block::bordered()
        .title(title)
        .border_style(p.style(if focused { Role::Accent } else { Role::Muted }))
}

fn welcome(frame: &mut Frame, area: Rect, app: &App, p: Palette) {
    let title = app
        .current()
        .map(|t| format!("Workspace: {}", safe_text(&t.cwd)))
        .unwrap_or_else(|| "Connecting to Core…".into());
    let mut lines = Vec::new();
    if !app.prefs.no_logo && area.height >= 15 {
        lines.extend(
            (if app.prefs.ascii { &CUP_ASCII } else { &CUP })
                .iter()
                .map(|s| Line::styled(*s, p.style(Role::Accent))),
        );
        lines.push(Line::raw(""));
    }
    lines.push(Line::styled(
        "AReaL-Harness",
        p.style(Role::Accent).add_modifier(Modifier::BOLD),
    ));
    lines.push(Line::raw(title));
    if let Some(id) = &app.selected {
        lines.push(Line::styled(id.clone(), p.style(Role::Muted)));
    }
    lines.push(Line::raw(""));
    lines.push(Line::raw("Start typing to begin a task."));
    lines.push(Line::styled(
        "/sessions  /model  /theme  /topology  /help",
        p.style(Role::Muted),
    ));
    frame.render_widget(
        Paragraph::new(lines)
            .centered()
            .block(panel(" Welcome ", false, p))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn navigation_view(frame: &mut Frame, area: Rect, app: &mut App, p: Palette) {
    let rows = app.nav_rows();
    let selected = rows
        .iter()
        .position(|r| Some(&r.target) == app.nav_selected.as_ref())
        .unwrap_or(0);
    let title = match app.view {
        View::Agents | View::Conversation | View::Welcome | View::Help | View::Tasks => {
            " Agents · session tree "
        }
        View::Groups => " Workgroups ",
    };
    let items: Vec<_> = rows
        .iter()
        .map(|row| match &row.target {
            NavTarget::More(_) => ListItem::new(Line::styled(
                format!("{}Load more…", row.prefix),
                p.style(Role::Accent),
            )),
            NavTarget::Group(id) => {
                let group = app.groups.iter().find(|g| g["id"].as_str() == Some(id));
                ListItem::new(vec![
                    Line::raw(short(id)),
                    Line::styled(
                        safe_text(
                            group
                                .and_then(|g| g["objective"].as_str())
                                .unwrap_or("Workgroup"),
                        ),
                        p.style(Role::Muted),
                    ),
                ])
            }
            NavTarget::Thread(id) => {
                let expanded = app.expanded.contains(id);
                let mark = if app.view != View::Groups {
                    if expanded { "[-] " } else { "[+] " }
                } else {
                    ""
                };
                let label = app.threads.get(id).map_or_else(
                    || "Loading…".into(),
                    |t| format!("{} {}", short(id), safe_text(&t.preview)),
                );
                let status = app.node_status(id);
                let role = status_role(status);
                let live = app.connected && app.subscriptions.contains(id);
                ListItem::new(vec![
                    Line::styled(
                        format!("{}{mark}{label}", row.prefix),
                        p.style(if Some(id) == app.selected.as_ref() {
                            Role::Accent
                        } else {
                            Role::Text
                        }),
                    ),
                    Line::styled(
                        format!(
                            "{}{} · {}",
                            " ".repeat((row.depth * 3).min(30)),
                            status,
                            if live { "live" } else { "snapshot" }
                        ),
                        p.style(role),
                    ),
                ])
            }
        })
        .collect();
    let mut state = ListState::default()
        .with_offset(app.nav_offset)
        .with_selected(if rows.is_empty() {
            None
        } else {
            Some(selected)
        });
    frame.render_stateful_widget(
        List::new(items)
            .highlight_style(p.selected())
            .highlight_symbol("> ")
            .block(panel(title, app.focus == Focus::Navigation, p)),
        area,
        &mut state,
    );
    app.nav_offset = state.offset();
}

fn agent_detail(frame: &mut Frame, area: Rect, app: &App, p: Palette) {
    let target = match &app.nav_selected {
        Some(NavTarget::Thread(id)) => app.threads.get(id),
        _ => None,
    };
    let mut lines = vec![
        Line::styled(
            "Parent/child ownership · session history",
            p.style(Role::Muted),
        ),
        Line::raw(""),
    ];
    if let Some(t) = target {
        let live = app.connected && app.subscriptions.contains(&t.id);
        lines.extend([
            Line::styled(safe_text(&t.preview), p.style(Role::Accent)),
            Line::raw(format!("Thread: {}", t.id)),
            Line::raw(format!(
                "Parent: {}",
                t.parent_thread_id.as_deref().unwrap_or("root")
            )),
            Line::styled(
                format!("Status: {}", app.node_status(&t.id)),
                p.style(status_role(app.node_status(&t.id))),
            ),
            Line::raw(format!(
                "Data: {}",
                if live {
                    "live subscription".into()
                } else {
                    app.freshness.get(&t.id).map_or_else(
                        || "not loaded".into(),
                        |at| format!("snapshot · {}s ago", at.elapsed().as_secs()),
                    )
                }
            )),
            Line::raw(format!(
                "Known children: {}",
                app.threads
                    .values()
                    .filter(|c| c.parent_thread_id.as_ref() == Some(&t.id))
                    .count()
            )),
        ]);
        if let Some(turn) = t.turns.last() {
            lines.push(Line::raw(format!("Latest Turn: {}", turn.id)));
            if let Some(error) = &turn.error {
                lines.push(Line::styled(
                    safe_text(&error.message),
                    p.style(Role::Error),
                ));
            }
        }
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            "Enter: open this session · →: load children",
            p.style(Role::Accent),
        ));
        lines.push(Line::styled(
            "Preview keeps the current input/cancel target.",
            p.style(Role::Muted),
        ));
    } else {
        lines.push(Line::raw(
            "Select an agent; Enter loads more when a page is incomplete.",
        ));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(panel(" Agent details ", app.focus == Focus::Content, p)),
        area,
    );
}

fn execution_status(app: &App) -> String {
    let Some(t) = app.current() else {
        return "Loading session…".into();
    };
    let mut parts = vec![thread_status(t).to_owned()];
    if let Some(turn) = t.turns.last() {
        if let Some(at) = app.observed.get(&turn.id) {
            parts.push(format!("observed {}s", at.elapsed().as_secs()));
        }
        if let Some(areal_protocol::Item::DynamicToolCall {
            tool, execution, ..
        }) = turn.items.last()
            && execution.outcome == ToolOutcome::Running
        {
            parts.push(format!("tool: {}", safe_text(tool)));
        }
        if let Some(usage) = &turn.usage {
            parts.push(format!(
                "tokens in/out {}/{}",
                usage.input_tokens, usage.output_tokens
            ));
        }
    }
    if let Some(d) = &t.desktop {
        if !d.plan.steps.is_empty() {
            let complete = d
                .plan
                .steps
                .iter()
                .filter(|s| s.status == "completed")
                .count();
            let cancelled = d
                .plan
                .steps
                .iter()
                .filter(|s| s.status == "cancelled")
                .count();
            parts.push(format!(
                "session plan {complete}/{} · cancelled {cancelled}",
                d.plan.steps.len()
            ));
        }
        let pending = d
            .interactions
            .iter()
            .filter(|i| i.status == "pending")
            .count();
        if pending > 0 {
            parts.push(format!(
                "{pending} pending interaction(s) · use Web client to respond"
            ));
        }
    }
    if !app.connected {
        parts.push("STALE".into());
    }
    parts.join(" · ")
}

fn group_view(frame: &mut Frame, area: Rect, app: &mut App, p: Palette) {
    let mut lines = Vec::new();
    if let Some(group) = &app.group {
        let record = &group["record"];
        let tasks = record["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let integrated = tasks.iter().filter(|t| t["status"] == "integrated").count();
        let status = record["status"].as_str().unwrap_or("unknown");
        lines.push(Line::styled(
            safe_text(record["objective"].as_str().unwrap_or("Workgroup")),
            p.style(Role::Accent),
        ));
        lines.push(Line::styled(
            format!(
                "{status} · Integrated {integrated}/{} · r{}",
                tasks.len(),
                record["planRevision"].as_u64().unwrap_or(0)
            ),
            p.style(status_role(status)),
        ));
        lines.push(Line::raw(format!(
            "Final check: {} · Cleanup: {}",
            record["finalCheck"]["passed"]
                .as_bool()
                .map_or("pending", |v| if v { "passed" } else { "failed" }),
            record["cleanupConfirmed"]
                .as_bool()
                .map_or("pending", |v| if v { "confirmed" } else { "unconfirmed" })
        )));
        if let Some(error) = record["error"].as_str() {
            lines.push(Line::styled(safe_text(error), p.style(Role::Error)));
        }
        lines.push(Line::raw(""));
        for task in tasks {
            let status = task["status"].as_str().unwrap_or("unknown");
            lines.push(Line::styled(
                format!(
                    "{status:12} {} · generation {}",
                    safe_text(task["spec"]["id"].as_str().unwrap_or("?")),
                    task["generation"].as_u64().unwrap_or(0)
                ),
                p.style(status_role(status)),
            ));
            for (field, label) in [
                ("depends", "Execution depends"),
                ("integrationDepends", "Integration depends"),
            ] {
                if let Some(ids) = task["spec"][field].as_array().filter(|ids| !ids.is_empty()) {
                    lines.push(Line::styled(
                        format!(
                            "  {label}: {}",
                            ids.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                        p.style(Role::Muted),
                    ));
                }
            }
            if let Some(feedback) = task["feedback"].as_str().filter(|s| !s.is_empty()) {
                lines.push(Line::raw(format!("  {}", safe_text(feedback))));
            }
        }
    } else {
        lines.push(Line::raw(
            "Select a Workgroup and press Enter, or /group ID.",
        ));
    }
    let block = panel(" Workgroup tasks ", app.focus == Focus::Content, p);
    let inner = block.inner(area);
    let lines = wrap_context(lines, inner.width);
    // 任务表按行裁剪，避免超长反馈把偏移截断为 u16；完整制品仍通过既有接口读取。
    app.group_scroll = app
        .group_scroll
        .min(lines.len().saturating_sub(usize::from(inner.height)));
    let visible: Vec<_> = lines
        .into_iter()
        .skip(app.group_scroll)
        .take(usize::from(inner.height))
        .collect();
    frame.render_widget(Paragraph::new(visible).block(block), area);
}

fn input_view(frame: &mut Frame, area: Rect, app: &App, p: Palette) {
    let target = app.selected.as_deref().unwrap_or("loading");
    let block = panel(
        format!(
            " To {} · Enter: send/steer · Ctrl-C: cancel ",
            short(target)
        ),
        app.focus == Focus::Input,
        p,
    );
    let inner = block.inner(area);
    let text = safe_text(&app.input)
        .replace('\n', "↵")
        .replace('\t', "    ");
    let capacity = usize::from(inner.width.saturating_sub(1));
    let mut width = 0;
    let mut tail = Vec::new();
    for g in text.graphemes(true).rev() {
        if width + g.width() > capacity {
            break;
        }
        width += g.width();
        tail.push(g);
    }
    tail.reverse();
    let text = tail.concat();
    frame.render_widget(Paragraph::new(text).block(block), area);
    if app.focus == Focus::Input
        && app.theme_original.is_none()
        && app.picker.is_none()
        && inner.width > 0
        && inner.height > 0
    {
        frame.set_cursor_position((inner.x + width as u16, inner.y));
    }
}

fn completion_popup(frame: &mut Frame, input: Rect, body: Rect, app: &App, p: Palette) {
    let choices = app.completions();
    if choices.is_empty() || body.height < 3 {
        return;
    }
    let count = choices
        .len()
        .min(6)
        .min(usize::from(body.height.saturating_sub(2)));
    let height = (count + 2) as u16;
    let area = Rect::new(input.x, input.y.saturating_sub(height), input.width, height);
    frame.render_widget(Clear, area);
    let selected = app.completion_index.min(choices.len() - 1);
    let mut state = ListState::default().with_selected(Some(selected));
    let items = choices
        .iter()
        .map(|c| {
            ListItem::new(Line::from(vec![
                Span::styled(format!("{} {}", c.name, c.argument), p.style(Role::Accent)),
                Span::styled(format!("  {}", c.description), p.style(Role::Muted)),
            ]))
        })
        .collect::<Vec<_>>();
    frame.render_stateful_widget(
        List::new(items)
            .style(p.surface)
            .highlight_style(p.selected())
            .highlight_symbol("> ")
            .block(panel(" Commands · ↑↓ select · Tab complete ", true, p)),
        area,
        &mut state,
    );
}

fn picker_popup(frame: &mut Frame, area: Rect, app: &App, p: Palette) {
    let picker = app.picker.as_ref().unwrap();
    let width = area.width.min(86);
    let height = area.height.saturating_sub(2).min(22);
    let popup = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    frame.render_widget(Block::default().style(p.surface), popup);
    let title = match picker.kind {
        PickerKind::Sessions => " Sessions · Enter switch · Esc close ",
        PickerKind::Models => " Models · Enter apply · Esc close ",
    };
    let block = panel(title, true, p);
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    let [search, list, note, status] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(2),
        Constraint::Length(2),
    ])
    .areas(inner);
    frame.render_widget(
        Paragraph::new(format!("Filter: {}", safe_text(&picker.query)))
            .style(p.style(Role::Accent)),
        search,
    );
    let items: Vec<_> = match picker.kind {
        PickerKind::Sessions => app
            .session_choices()
            .iter()
            .map(|target| match target {
                NavTarget::Thread(id) => {
                    let t = &app.threads[id];
                    ListItem::new(format!(
                        "{} {} · {}",
                        if Some(id) == app.selected.as_ref() {
                            "*"
                        } else {
                            " "
                        },
                        short(id),
                        safe_text(&t.preview)
                    ))
                }
                _ => ListItem::new("Load more sessions…"),
            })
            .collect(),
        PickerKind::Models => app
            .model_choices()
            .iter()
            .map(|i| {
                let m = &app.models[*i];
                ListItem::new(format!(
                    "{}{}",
                    safe_text(&m.label),
                    if m.available { "" } else { " (unavailable)" }
                ))
            })
            .collect(),
    };
    let mut state = ListState::default().with_selected(
        (!items.is_empty()).then_some(picker.selected.min(items.len().saturating_sub(1))),
    );
    if items.is_empty() {
        frame.render_widget(
            Paragraph::new("No matches in the loaded list").style(p.style(Role::Muted)),
            list,
        );
    } else {
        frame.render_stateful_widget(
            List::new(items)
                .highlight_style(p.selected())
                .highlight_symbol("> "),
            list,
            &mut state,
        );
    }
    let note_text = match picker.kind {
        PickerKind::Sessions => "↑↓ select · type to filter loaded sessions
Load more fetches the next page; Esc preserves your draft"
            .into(),
        PickerKind::Models => format!(
            "Current: {}
Idle Turns only · configured models; availability is not a connection probe",
            safe_text(&app.model_label())
        ),
    };
    frame.render_widget(Paragraph::new(note_text).style(p.style(Role::Muted)), note);
    frame.render_widget(
        Paragraph::new(safe_text(&app.status))
            .wrap(Wrap { trim: false })
            .style(p.style(Role::Warning)),
        status,
    );
}

fn theme_picker(frame: &mut Frame, area: Rect, app: &App, p: Palette) {
    let width = area.width.min(48);
    let height = area.height.min(8);
    let popup = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    let mut lines = vec![
        Line::styled(
            "↑↓ Preview · Enter save · Esc restore",
            p.style(Role::Muted),
        ),
        Line::raw(""),
    ];
    for theme in Theme::ALL {
        lines.push(Line::styled(
            format!(
                "{} {}",
                if theme == app.prefs.theme { ">" } else { " " },
                theme.name()
            ),
            if theme == app.prefs.theme {
                p.selected()
            } else {
                p.style(Role::Text)
            },
        ));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(p.surface)
            .block(panel(" Theme ", true, p)),
        popup,
    );
}
fn help_page(frame: &mut Frame, area: Rect, p: Palette) {
    let text = "F1 /help: help · F2 /theme: theme picker\nF3 /topology: agents · F4 /groups: workgroups\nF5 /sessions: switch session · F6 /model: switch model\n/new · /tasks · /sessions · /open ID · /spawn PROMPT · /agents\n/group ID · /group-start JSON_FILE · /group-revise JSON_FILE\n/group-cancel ID · /welcome · /quit\n\n/: command suggestions · ↑↓ select · Tab complete\nTab / Shift-Tab: input, right panel, history focus\nNavigation: arrows select/expand, Enter open, r refresh\nHistory: PgUp/PgDn, Home/End, Space expand visible tool\nCtrl-C: interrupt the input target's active Turn\nCtrl-R: reconnect · Ctrl-Q: quit\n\nRead % describes loaded history; session plan counts are separate.\nTask trees include historical child sessions. Snapshot nodes can lag.\nPending questions/approvals are shown here; respond in the Web client.\nEsc: return to input";
    frame.render_widget(
        Paragraph::new(text)
            .wrap(Wrap { trim: false })
            .block(panel(" Help ", true, p)),
        area,
    );
}
fn status_role(status: &str) -> Role {
    match status.to_ascii_lowercase().as_str() {
        "failed" | "error" | "unknown" => Role::Error,
        "completed" | "integrated" => Role::Success,
        "running" | "inprogress" | "in_progress" | "validating" | "blocked" | "submitted" => {
            Role::Warning
        }
        _ => Role::Muted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::tests::thread, theme::Preferences};
    use ratatui::{Terminal, backend::TestBackend};
    #[test]
    fn conversation_is_left_and_unrelated_sessions_only_appear_in_picker() {
        let mut app = App::new(Preferences::default());
        app.view = View::Conversation;
        app.selected = Some("root".into());
        app.tree_root = Some("root".into());
        app.expanded.insert("root".into());
        app.threads.insert("root".into(), thread("root", None));
        app.threads.insert("other".into(), thread("other", None));
        let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        let rows = terminal
            .backend()
            .buffer()
            .content
            .chunks(120)
            .map(|row| row.iter().map(|c| c.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        assert!(rows[2].find("Conversation").unwrap() < rows[2].find("Session plan").unwrap());
        assert!(!rows.join("\n").contains("Task other"));
        app.picker = Some(crate::commands::Picker::new(PickerKind::Sessions));
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(text.contains("Task other"));
    }
    #[test]
    fn layouts_and_themes_render_at_supported_sizes() {
        for (width, height) in [(32, 10), (60, 20), (80, 24), (120, 36)] {
            for theme in Theme::ALL {
                let mut app = App::new(Preferences {
                    theme,
                    ..Default::default()
                });
                app.selected = Some("root".into());
                app.threads.insert("root".into(), thread("root", None));
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                for view in [
                    View::Welcome,
                    View::Conversation,
                    View::Agents,
                    View::Groups,
                    View::Tasks,
                    View::Help,
                ] {
                    app.view = view;
                    terminal.draw(|f| draw(f, &mut app)).unwrap();
                    let buffer = terminal.backend().buffer();
                    assert_eq!(buffer.area.width, width);
                    assert!(buffer.content.iter().any(|c| c.symbol() == "A"));
                }
                app.theme_original = Some(theme);
                terminal.draw(|f| draw(f, &mut app)).unwrap();
                app.theme_original = None;
                for kind in [PickerKind::Sessions, PickerKind::Models] {
                    app.picker = Some(crate::commands::Picker::new(kind));
                    terminal.draw(|f| draw(f, &mut app)).unwrap();
                }
                app.picker = None;
                app.input = "/".into();
                app.completion_index = 17;
                terminal.draw(|f| draw(f, &mut app)).unwrap();
            }
        }
    }
    #[test]
    fn semantic_roles_use_distinct_colors_and_theme_change_preserves_reader() {
        let dark = Palette::new(Theme::Dark, true, true);
        let light = Palette::new(Theme::Light, true, true);
        assert_ne!(dark.style(Role::User).fg, dark.style(Role::Tool).fg);
        assert_ne!(dark.style(Role::User).fg, light.style(Role::User).fg);
        let mut app = App::new(Preferences::default());
        app.input = "draft".into();
        app.selected = Some("root".into());
        app.history().unwrap().follow = false;
        app.theme_original = Some(Theme::Dark);
        app.key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Down,
            crossterm::event::KeyModifiers::NONE,
        ))
        .unwrap();
        assert_eq!(app.prefs.theme, Theme::Light);
        assert_eq!(app.input, "draft");
        assert!(!app.history().unwrap().follow);
    }
    #[test]
    fn terminal_buffer_contains_logo_and_semantic_message_styles() {
        use areal_protocol::{Input, Item};
        let mut app = App::new(Preferences::default());
        let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(
            terminal
                .backend()
                .buffer()
                .content
                .iter()
                .any(|c| c.symbol() == "●")
        );
        let mut t = thread("root", None);
        t.turns[0].items = vec![
            Item::UserMessage {
                id: "you".into(),
                content: vec![Input::Text {
                    text: "question".into(),
                    text_elements: Vec::new(),
                }],
            },
            Item::AgentMessage {
                id: "agent".into(),
                text: "answer".into(),
            },
        ];
        app.selected = Some("root".into());
        app.threads.insert("root".into(), t);
        app.view = View::Conversation;
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        let p = app.prefs.palette();
        let cells = &terminal.backend().buffer().content;
        assert!(
            cells
                .iter()
                .any(|c| c.symbol() == "Y" && Some(c.fg) == p.style(Role::User).fg)
        );
        assert!(
            cells
                .iter()
                .any(|c| c.symbol() == "A" && Some(c.fg) == p.style(Role::Agent).fg)
        );
    }
    #[test]
    fn workgroup_integration_count_does_not_hide_pending_final_check() {
        let mut app = App::new(Preferences::default());
        app.view = View::Groups;
        app.group = Some(
            serde_json::json!({"id":"group","record":{"objective":"Build game","status":"running","planRevision":2,"tasks":[{"spec":{"id":"map","depends":[],"integrationDepends":[]},"status":"integrated"},{"spec":{"id":"game","depends":["map"],"integrationDepends":[]},"status":"validating"}]}}),
        );
        let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .chunks(120)
            .map(|row| row.iter().map(|c| c.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Integrated 1/2"));
        assert!(text.contains("Final check: pending"));
        assert!(text.contains("Execution depends: map"));
        assert!(text.contains("validating"));
    }
}
