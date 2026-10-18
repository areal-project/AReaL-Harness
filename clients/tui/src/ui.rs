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
    app::{App, Focus, NavTarget, View, short},
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
    app.history_area = None;
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
                format!(
                    "  · {} · {}",
                    safe_text(&app.model_label()),
                    safe_text(&app.permission_mode)
                ),
                palette.style(Role::Muted),
            ),
        ]))
        .style(palette.surface),
        header,
    );
    // 复用页眉第二行，避免长期提醒覆盖请求错误或挤占会话区域。
    if let Some(notice) = &app.trajectory_notice {
        frame.render_widget(
            Paragraph::new(safe_text(notice)).style(palette.style(Role::Warning)),
            Rect::new(header.x, header.y + 1, header.width, 1),
        );
    }
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
    let request_notice = app
        .selected
        .as_ref()
        .and_then(|id| app.submission_failures.get(id))
        .map(|failure| format!("Submission issue: {} · /restore-input", failure.message));
    let notice_lines = request_notice
        .as_ref()
        .map(|s| wrap_context(vec![Line::raw(s.clone())], conversation.width))
        .unwrap_or_default();
    let notice_height = notice_lines
        .len()
        .min(3)
        .min(usize::from(conversation.height.saturating_sub(6))) as u16;
    let [body, progress, notice, input] = Layout::vertical([
        Constraint::Min(2),
        Constraint::Length(1),
        Constraint::Length(notice_height),
        Constraint::Length(3),
    ])
    .areas(conversation);
    let read_progress = if app.view == View::Welcome {
        welcome(frame, body, app, palette);
        String::new()
    } else if app.view == View::Permissions {
        frame.render_widget(Paragraph::new(format!("/permissions clear-session | clear-project\nGlobal mode: config [permissions].mode or AREAL_HARNESS_PERMISSION_MODE; restart the service to apply.\n\n{}", serde_json::to_string_pretty(&app.permission_info).unwrap_or_default())).block(panel(" Permissions ", true, palette)).wrap(Wrap { trim:false }).scroll((app.permission_scroll,0)), body);
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
    frame.render_widget(
        Paragraph::new(notice_lines).style(palette.style(Role::Error)),
        notice,
    );
    input_view(frame, input, app, palette);
    frame.render_widget(
        Paragraph::new(safe_text(app.status_notice())).style(palette.style(if app.connected {
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
            " ↑↓: select · Enter/Space: expand · ←→ · PgUp/PgDn · Ctrl-O: details · Esc: input"
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
    if let Some(interaction) = app.pending_approval() {
        let popup = area.inner(ratatui::layout::Margin {
            horizontal: 2,
            vertical: 1,
        });
        frame.render_widget(Clear, popup);
        let block = panel(
            " Permission required · ↑↓ choose · Enter confirm · PgUp/PgDn details ",
            true,
            palette,
        );
        let inner = block.inner(popup);
        frame.render_widget(block, popup);
        let choices = app.approval_choices();
        let [details, buttons] =
            Layout::vertical([Constraint::Min(1), Constraint::Length(choices.len() as u16)])
                .areas(inner);
        let permissions = interaction.effective_permissions.as_ref();
        let scope = if permissions.is_some_and(|p| p["readOnly"] == true) {
            "Read-only task · network blocked"
        } else if permissions.is_some_and(|p| p["runtime"]["capabilities"]["fullAccess"] == true) {
            "Full filesystem access · network allowed"
        } else {
            "Restricted deployment · inspect /permissions for its boundaries"
        };
        let text = format!(
            "Session {} · {}\n{scope}.\nRemembering applies only to this exact tool and arguments.\n\n{}",
            short(&interaction.thread_id),
            interaction.tool.as_deref().unwrap_or("tool"),
            serde_json::to_string_pretty(&interaction.effective_arguments).unwrap_or_default()
        );
        frame.render_widget(
            Paragraph::new(safe_text(&text))
                .wrap(Wrap { trim: false })
                .scroll((app.interaction_scroll, 0)),
            details,
        );
        let lines: Vec<Line> = choices
            .iter()
            .enumerate()
            .map(|(index, (_, label))| {
                Line::styled(
                    format!(
                        "{} {}",
                        if index == app.approval_selection() {
                            ">"
                        } else {
                            " "
                        },
                        label
                    ),
                    palette.style(if index == app.approval_selection() {
                        Role::Accent
                    } else {
                        Role::Muted
                    }),
                )
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), buttons);
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
    let execution_lines = wrap_context(vec![Line::raw(execution_status(app))], inner.width);
    let execution_height = execution_lines
        .len()
        .min(3)
        .min(usize::from(inner.height.saturating_sub(1))) as u16;
    let [execution, history_area] =
        Layout::vertical([Constraint::Length(execution_height), Constraint::Min(1)]).areas(inner);
    frame.render_widget(
        Paragraph::new(execution_lines).style(p.style(Role::Muted)),
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
        app.history_area = Some((id.clone(), text_area));
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
    if let Some(goal) = app.current().and_then(|t| t.goals.goal.as_ref()) {
        lines.push(Line::styled(
            format!("Goal · {:?}", goal.status),
            p.style(Role::Muted),
        ));
        lines.push(Line::raw(safe_text(&goal.objective)));
        lines.push(Line::raw(format!(
            "{} · {:.0}s · {}/{} Turns",
            crate::history::goal_usage(goal),
            goal.usage.time_used_seconds,
            goal.usage.turns_started,
            goal.max_turns
                .map(|n| n.to_string())
                .unwrap_or_else(|| "unlimited".into())
        )));
        if goal.reason.is_some() {
            lines.push(Line::raw(crate::history::goal_reason(goal)));
        }
        if let Some(rsi) = &goal.rsi {
            lines.push(Line::raw(format!("RSI · {:?}", rsi.phase)));
            for candidate in &rsi.candidates {
                lines.push(Line::raw(format!(
                    "{}{} · {} · {:?} · R{}",
                    "  ".repeat(candidate.round as usize),
                    if let Some(parent) = &candidate.parent_candidate_id {
                        format!("└─ {} ← {parent}", candidate.id)
                    } else {
                        format!("├─ {}", candidate.id)
                    },
                    candidate.label,
                    candidate.status,
                    candidate.round
                )));
                lines.push(Line::raw(safe_text(&candidate.harness)));
                lines.push(Line::raw(format!(
                    "{} · run {}",
                    candidate.workspace_mode, candidate.run_id
                )));
                if let Some(path) = &candidate.workspace_path {
                    lines.push(Line::raw(safe_text(path)));
                }
                if let Some(path) = &candidate.artifact_path {
                    lines.push(Line::raw(safe_text(path)));
                }
                if let Some(summary) = &candidate.artifact_summary {
                    lines.extend(summary.lines().map(|line| Line::raw(safe_text(line))));
                }
                if let Some(error) = &candidate.error {
                    lines.push(Line::raw(safe_text(error)));
                }
            }
            if let Some(winner) = &rsi.selected_candidate_id {
                lines.push(Line::raw(format!("Winner: {winner}")));
            }
            lines.push(Line::raw("/rsi-refresh · /rsi-artifact ID [OFFSET]"));
            lines.push(Line::raw(
                "/rsi-select ID · /rsi-evolve JSON_FILE · /rsi-evaluate JSON_FILE · /goal-clear",
            ));
        } else {
            lines.push(Line::raw("/goal-pause · /goal-resume · /goal-edit"));
        }
    }
    if let Some((thread, goal, candidate, content)) = &app.rsi_artifact
        && app.selected.as_ref() == Some(thread)
        && app
            .current()
            .and_then(|t| t.goals.goal.as_ref())
            .is_some_and(|g| &g.id == goal)
    {
        lines.push(Line::raw(format!("Artifact · {candidate}")));
        lines.extend(
            String::from_utf8_lossy(content)
                .lines()
                .map(|line| Line::raw(safe_text(line))),
        );
    }
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
        View::Agents
        | View::Conversation
        | View::Welcome
        | View::Help
        | View::Tasks
        | View::Permissions => " Agents · session tree ",
        View::Groups => {
            if app.execution_view {
                " Subtasks and delivery "
            } else {
                " Legacy Workgroups "
            }
        }
    };
    let items: Vec<_> =
        rows.iter()
            .map(|row| match &row.target {
                NavTarget::More(_) => ListItem::new(Line::styled(
                    format!("{}Load more…", row.prefix),
                    p.style(Role::Accent),
                )),
                NavTarget::Group(id) => {
                    let group = app.groups.iter().find(|g| {
                        g["executionId"].as_str().or_else(|| g["id"].as_str()) == Some(id)
                    });
                    ListItem::new(vec![
                        Line::raw(short(id)),
                        Line::styled(
                            safe_text(
                                group
                                    .and_then(|g| {
                                        g["title"].as_str().or_else(|| g["objective"].as_str())
                                    })
                                    .unwrap_or("Subtask"),
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
    let live = app.connected && app.subscriptions.contains(&t.id);
    let mut parts = vec![if !live {
        "Status awaiting synchronization".into()
    } else if app.syncing.contains(&t.id) {
        "Synchronizing execution state".into()
    } else {
        format!(
            "Turn {}",
            t.turns.last().map_or("Idle", |turn| match turn.status {
                areal_protocol::TurnStatus::InProgress => "Running",
                areal_protocol::TurnStatus::Completed => "Completed",
                areal_protocol::TurnStatus::Failed => "Failed",
                areal_protocol::TurnStatus::Interrupted => "Interrupted",
            })
        )
    }];
    if let Some(turn) = t.turns.last() {
        if live
            && !app.syncing.contains(&t.id)
            && turn.status == areal_protocol::TurnStatus::InProgress
        {
            if let Some(retry) = app.retries.get(&t.id).filter(|r| r.turn_id == turn.id) {
                let wait = retry.until.saturating_duration_since(std::time::Instant::now()).as_millis().div_ceil(1000);
                parts.push(if wait > 0 { format!("{} retry {} in {wait}s", retry.purpose, retry.attempt) } else { format!("Retrying {} · attempt {}", retry.purpose, retry.attempt) });
            } else if let Some(areal_protocol::Item::DynamicToolCall { tool, .. }) = turn.items.iter().rev().find(|i| matches!(i, areal_protocol::Item::DynamicToolCall { execution, .. } if execution.outcome == ToolOutcome::Running)) {
                parts.push(format!("tool: {}", crate::history::short_text(tool, 48)));
            } else {
                parts.push("Waiting for model response".into());
            }
            if let Some(at) = app.observed.get(&turn.id) {
                parts.push(format!("observed {}s", at.elapsed().as_secs()));
            }
        }
        if let Some(usage) = &turn.usage {
            parts.push(format!(
                "tokens in/out {}/{}",
                usage.input_tokens, usage.output_tokens
            ));
        } else {
            parts.push("Turn usage unknown".into());
        }
    }
    if let Some(goal) = &t.goals.goal {
        parts.push(format!(
            "Goal {:?} · {}",
            goal.status,
            crate::history::goal_usage(goal)
        ));
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
                "{pending} pending interaction(s) · approvals open in this terminal"
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
    if app.execution_view {
        if let Some(execution) = &app.group {
            let status = execution["status"].as_str().unwrap_or("unknown");
            lines.push(Line::styled(
                safe_text(
                    execution["title"]
                        .as_str()
                        .or_else(|| execution["objective"].as_str())
                        .unwrap_or("Subtask"),
                ),
                p.style(Role::Accent),
            ));
            let delivery = execution["delivery"]["status"]
                .as_str()
                .unwrap_or("unknown");
            // 执行结束不能把冲突、未知交付或尚待承接的候选渲染为成功。
            let delivery_role = match delivery {
                "failed" | "conflict" | "partial" | "unknown" => Role::Error,
                "notRequired" | "applied" => status_role(status),
                _ => Role::Warning,
            };
            let delivery_label = if delivery == "requiresActiveTurn" {
                "continue the original task to apply"
            } else {
                delivery
            };
            lines.push(Line::styled(
                format!("{status} · Delivery: {delivery_label}"),
                p.style(delivery_role),
            ));
            lines.push(Line::raw(format!(
                "Verification: {} ({}) · Resources: {}",
                execution["verification"]["status"]
                    .as_str()
                    .unwrap_or("notRun"),
                execution["verification"]["kind"].as_str().unwrap_or("none"),
                if execution["resourcesReleased"] == true {
                    "released"
                } else {
                    "pending"
                }
            )));
            if let Some(error) = execution["error"].as_str() {
                lines.push(Line::styled(safe_text(error), p.style(Role::Error)));
            }
            if let Some(text) = execution["text"].as_str() {
                for line in text.lines() {
                    lines.push(Line::raw(safe_text(line)));
                }
            }
            if let Some(thread) = execution["threadId"].as_str() {
                lines.push(Line::raw(format!("History: /open {thread}")));
            }
            if execution["settled"] == false {
                lines.push(Line::raw(format!(
                    "Stop: /execution-cancel {}",
                    execution["executionId"].as_str().unwrap_or("?")
                )));
            }
        } else {
            lines.push(Line::raw(
                "Select a subtask and press Enter. Core manages execution and delivery.",
            ));
        }
        if app.execution_next_offset.is_some() {
            lines.push(Line::raw("More subtasks are available: /more"));
        }
    } else if let Some(group) = &app.group {
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
    let block = panel(
        if app.execution_view {
            " Subtask progress and delivery "
        } else {
            " Legacy Workgroup tasks "
        },
        app.focus == Focus::Content,
        p,
    );
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
    let (text, cursor_column) = input_window(&app.input, app.input_cursor, inner.width);
    frame.render_widget(Paragraph::new(text).block(block), area);
    if app.focus == Focus::Input
        && app.theme_original.is_none()
        && app.picker.is_none()
        && app.pending_approval().is_none()
        && inner.width > 0
        && inner.height > 0
    {
        frame.set_cursor_position((inner.x + cursor_column, inner.y));
    }
}

fn input_window(input: &str, cursor: usize, width: u16) -> (String, u16) {
    let display = |text: &str| safe_text(text).replace('\n', "↵").replace('\t', "    ");
    let before = display(&input[..cursor]);
    let after = display(&input[cursor..]);
    let width = usize::from(width);
    // 为光标处的完整字素留出空间，窄窗口也不把双宽字符切成两半。
    let reserved = after.graphemes(true).next().map_or(1, |g| g.width().max(1));
    let capacity = width.saturating_sub(reserved);
    let mut cursor_column = 0;
    let mut visible = Vec::new();
    for g in before.graphemes(true).rev() {
        if cursor_column + g.width() > capacity {
            break;
        }
        cursor_column += g.width();
        visible.push(g);
    }
    visible.reverse();
    let mut used = cursor_column;
    for g in after.graphemes(true) {
        if used + g.width() > width {
            break;
        }
        used += g.width();
        visible.push(g);
    }
    (visible.concat(), cursor_column as u16)
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
        PickerKind::Skills => " Skills · Enter apply · Esc close ",
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
        PickerKind::Skills => app
            .skill_choices()
            .iter()
            .map(|i| {
                let skill = &app.skills[*i];
                ListItem::new(format!(
                    "{}{} · {}",
                    if skill.available {
                        ""
                    } else {
                        "(unavailable) "
                    },
                    safe_text(&skill.label),
                    safe_text(&skill.description)
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
        PickerKind::Skills => {
            "↑↓ select · type to filter · Enter applies the selected skill".into()
        }
    };
    frame.render_widget(Paragraph::new(note_text).style(p.style(Role::Muted)), note);
    frame.render_widget(
        Paragraph::new(safe_text(app.status_notice()))
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
    let text = "F1 /help: help · F2 /theme: theme picker\nF3 /topology: history · F4 /executions: subtasks and delivery\nF5 /sessions: switch session · F6 /model: switch model\n/skills: choose skill · /skill NAME: apply by name\n/goal OBJECTIVE · /goal-pause · /goal-resume · /goal-clear\n/goal-edit OBJECTIVE · /goal-budget TOKENS|none\n/rsi-goal TEXT: run three isolated harness templates\n/rsi-refresh · /rsi-artifact ID [OFFSET] · /rsi-select ID\n/new · /tasks · /sessions · /open ID · /spawn PROMPT · /agents\n/executions · /execution-cancel ID · /welcome · /quit\nAdvanced compatibility: /groups · /group ID\n/group-start JSON_FILE · /group-revise JSON_FILE · /group-cancel ID\n\n/: command suggestions · ↑↓ select · Tab complete\nTab / Shift-Tab: input, right panel, history focus\nInput: ←→ move · Option+←/→ word · Ctrl-A/E line start/end\nCtrl-D/Delete: delete next · Backspace: delete previous\nNavigation: arrows select/expand, Enter open, r refresh\nHistory: ↑↓ select, Enter/Space expand, ←→ collapse/expand\nPgUp/PgDn scroll, Home/End; --mouse=true enables clicking summaries\nCtrl-O /details: compact or detailed records\n/restore-input: restore failed submission\nMouse: --mouse=false enables native drag selection and terminal Copy\nCtrl-C: interrupt the input target's active Turn\nCtrl-R: reconnect · Ctrl-Q: quit\n\nRead % describes loaded history; session plan counts are separate.\nTask trees include historical child sessions. Snapshot nodes can lag.\nApprovals: use the terminal dialog. /permissions: inspect rules. Questions: respond in Web.\nEsc: return to input";
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
    fn rsi_panel_shows_candidate_state_harness_artifact_and_winner() {
        let mut app = App::new(Preferences::default());
        app.selected = Some("root".into());
        let mut snapshot = thread("root", None);
        let mut goal = crate::app::tests::blocked_goal();
        goal.rsi = Some(serde_json::from_value(serde_json::json!({
            "phase":"selected", "selectedCandidateId":"candidate-3",
            "candidates":[{"id":"candidate-3","label":"critic-and-revise","harness":"Inspect gaps then revise",
                "status":"selected","workspaceMode":"isolatedWrite","workspacePath":"/isolated/3",
                "artifactPath":"/isolated/3/artifact.md","artifactSummary":"saved summary","runId":"run-3","taskId":"candidate-3"}]
        })).unwrap());
        snapshot.goals.goal = Some(goal);
        app.threads.insert("root".into(), snapshot);
        app.rsi_artifact = Some((
            "root".into(),
            "goal".into(),
            "candidate-3".into(),
            "# 完整产物".as_bytes().to_vec(),
        ));
        let text = plan_lines(&app, app.prefs.palette())
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        for expected in [
            "RSI",
            "Selected",
            "critic-and-revise",
            "Inspect gaps then revise",
            "isolatedWrite",
            "saved summary",
            "Winner: candidate-3",
            "# 完整产物",
            "/rsi-select",
        ] {
            assert!(text.contains(expected), "missing {expected}");
        }
    }

    #[test]
    fn trajectory_notice_uses_header_without_hiding_rpc_or_disconnect_status() {
        let mut app = App::new(Preferences::default());
        let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
        app.connected = true;
        app.status = "areal/model/list: permission denied".into();
        terminal.draw(|frame| draw(frame, &mut app)).unwrap();
        let before = screen(&terminal);
        let notice = "Trajectory needs attention; check settings";
        app.set_trajectory_notice(notice.into());
        terminal.draw(|frame| draw(frame, &mut app)).unwrap();
        let after = screen(&terminal);
        let rows: Vec<_> = after.lines().collect();
        assert_eq!(rows.len(), 36);
        assert_eq!(rows[1].trim(), notice);
        assert!(rows[34].contains("areal/model/list: permission denied"));
        // 提醒只能改变原有空白行；其余布局、聊天和状态内容保持原样。
        for (row, (before, after)) in before.lines().zip(&rows).enumerate() {
            if row != 1 {
                assert_eq!(before, *after, "row {row}");
            }
        }
        assert!(app.histories.is_empty());
        app.disconnect("fixture transport reset");
        terminal.draw(|frame| draw(frame, &mut app)).unwrap();
        let text = screen(&terminal);
        assert_eq!(text.lines().nth(1).unwrap().trim(), notice);
        assert!(
            text.lines()
                .nth(34)
                .unwrap()
                .contains("Disconnected · fixture transport reset")
        );
        assert!(text.contains("RECONNECTING · stale data"));
        app.configuration_notice = Some("Model configuration failed".into());
        terminal.draw(|frame| draw(frame, &mut app)).unwrap();
        let text = screen(&terminal);
        assert_eq!(text.lines().nth(1).unwrap().trim(), notice);
        assert!(
            text.lines()
                .nth(34)
                .unwrap()
                .contains("Model configuration failed")
        );
        assert!(!text.contains("fixture transport reset"));
        app.configuration_notice = None;
        app.status = "areal/model/list: permission denied".into();
        app.picker = Some(crate::commands::Picker::new(PickerKind::Models));
        terminal.draw(|frame| draw(frame, &mut app)).unwrap();
        let text = screen(&terminal);
        assert_eq!(text.lines().nth(1).unwrap().trim(), notice);
        assert_eq!(
            text.matches("areal/model/list: permission denied").count(),
            2
        );
    }

    #[test]
    fn input_window_tracks_cursor_and_keeps_wide_graphemes_visible() {
        for (text, cursor, width, visible, column) in [
            ("abcdef", 0, 4, "abcd", 0),
            ("abcdef", 3, 4, "abcd", 3),
            ("abcdef", 4, 4, "bcde", 3),
            ("abcdef", 6, 4, "def", 3),
            ("ab中文z", 2, 4, "ab中", 2),
            ("ab中文z", 5, 4, "中文", 2),
            ("e\u{301}👩‍💻x", 3, 4, "e\u{301}👩‍💻x", 1),
            ("a\t中\nz", 5, 10, "a    中↵z", 7),
            ("中", 0, 1, "", 0),
            ("中", 3, 0, "", 0),
        ] {
            assert_eq!(input_window(text, cursor, width), (visible.into(), column));
        }
    }
    #[test]
    fn input_renders_cursor_at_display_column_after_moving_and_resizing() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        use ratatui::backend::Backend;
        let mut app = App::new(Preferences::default());
        app.paste("ab中文z");
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .unwrap();
        let mut terminal = Terminal::new(TestBackend::new(12, 3)).unwrap();
        let palette = app.prefs.palette();
        terminal
            .draw(|f| input_view(f, f.area(), &app, palette))
            .unwrap();
        assert_eq!(terminal.backend_mut().get_cursor_position().unwrap().x, 5);
        terminal.backend_mut().resize(6, 3);
        terminal
            .draw(|f| input_view(f, f.area(), &app, palette))
            .unwrap();
        assert_eq!(terminal.backend_mut().get_cursor_position().unwrap().x, 3);
        assert_eq!(terminal.backend().buffer()[(1, 1)].symbol(), "中");
        assert_eq!(terminal.backend().buffer()[(3, 1)].symbol(), "文");
        app.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL))
            .unwrap();
        terminal
            .draw(|f| input_view(f, f.area(), &app, palette))
            .unwrap();
        assert_eq!(terminal.backend_mut().get_cursor_position().unwrap().x, 1);
        assert!(screen(&terminal).contains("ab中"));
    }
    fn screen(terminal: &Terminal<TestBackend>) -> String {
        terminal
            .backend()
            .buffer()
            .content
            .chunks(usize::from(terminal.size().unwrap().width))
            .map(|row| row.iter().map(|c| c.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn mouse(app: &mut App, kind: crossterm::event::MouseEventKind, column: u16, row: u16) {
        app.mouse(crossterm::event::MouseEvent {
            kind,
            column,
            row,
            modifiers: crossterm::event::KeyModifiers::NONE,
        });
    }
    #[test]
    fn approval_dialog_keeps_decisions_visible_at_small_sizes() {
        let mut app = App::new(Preferences::default());
        app.connected = true;
        app.selected = Some("root".into());
        let mut t = thread("root", None);
        t.desktop.get_or_insert_with(Default::default).interactions.push(serde_json::from_value(serde_json::json!({
            "requestId":"approval","threadId":"root","turnId":"turn","callId":"call","kind":"approval","status":"pending","expiresAt":9999999999_i64,
            "questions":[],"tool":"run_command","argumentsDigest":"digest","generation":null,
            "effectiveArguments":{"command":"echo fixture"},"effectivePermissions":{"rememberAllowed":true,"runtime":{"capabilities":{"fullAccess":true}}},"response":null
        })).unwrap());
        app.threads.insert("root".into(), t);
        for (width, height) in [(60, 18), (120, 36)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal.draw(|frame| draw(frame, &mut app)).unwrap();
            let text = screen(&terminal);
            assert!(text.contains("run_command"));
            assert!(text.contains("> Deny"));
            assert!(text.contains("Allow once"));
            assert!(text.contains("Remember exact request for this project"));
        }
    }

    #[test]
    fn mouse_and_keyboard_target_individual_records_after_resize() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEventKind};
        let mut app = App::new(Preferences::default());
        let mut t = thread("root", None);
        t.turns[0].items = (0..3).map(|i| serde_json::from_value(serde_json::json!({
            "type":"dynamicToolCall","id":format!("t{i}"),"tool":format!("inspect_{i}"),
            "arguments":{"path":"参数内容"},"status":"completed","success":true,"callId":format!("t{i}"),
            "contentItems":[{"type":"inputText","text":format!("OUTPUT_{i}")}],
            "execution":{"runtimeEpoch":"","scopeId":"","operationId":format!("t{i}"),"outcome":"succeeded"}
        })).unwrap()).collect();
        app.selected = Some("root".into());
        app.threads.insert("root".into(), t);
        app.view = View::Conversation;
        let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(!screen(&terminal).contains("OUTPUT_"));
        let (_, area) = app.history_area.clone().unwrap();
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            area.x,
            area.y,
        );
        mouse(
            &mut app,
            MouseEventKind::Drag(MouseButton::Left),
            area.x + 1,
            area.y,
        );
        mouse(
            &mut app,
            MouseEventKind::Up(MouseButton::Left),
            area.x,
            area.y,
        );
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(!screen(&terminal).contains("Tool ·"));
        app.prefs.mouse = false;
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            area.x,
            area.y,
        );
        mouse(
            &mut app,
            MouseEventKind::Up(MouseButton::Left),
            area.x,
            area.y,
        );
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(!screen(&terminal).contains("Tool ·"));
        app.prefs.mouse = true;
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            area.x,
            area.y,
        );
        let item = app.threads["root"].turns[0].items[2].clone();
        app.receive(serde_json::json!({"method":"item/completed","params":{"threadId":"root","turnId":"turn","item":item}})).unwrap();
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        mouse(
            &mut app,
            MouseEventKind::Up(MouseButton::Left),
            area.x,
            area.y,
        );
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(screen(&terminal).contains("Tool · inspect_2"));
        assert!(!screen(&terminal).contains("OUTPUT_"));
        terminal.backend_mut().resize(42, 32);
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        let row = screen(&terminal)
            .lines()
            .position(|line| line.contains("Tool · inspect_1"))
            .unwrap() as u16;
        let (_, area) = app.history_area.clone().unwrap();
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            area.x,
            row,
        );
        mouse(&mut app, MouseEventKind::Up(MouseButton::Left), area.x, row);
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(screen(&terminal).contains("OUTPUT_1"));
        assert!(!screen(&terminal).contains("OUTPUT_0"));
        assert!(!screen(&terminal).contains("OUTPUT_2"));
        app.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            .unwrap();
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        terminal.draw(|f| draw(f, &mut app)).unwrap();
        assert!(!screen(&terminal).contains("OUTPUT_1"));
        assert!(screen(&terminal).contains("OUTPUT_2"));
        assert!(app.input.is_empty());
    }
    #[test]
    fn failure_and_unknown_usage_survive_history_rebuild_in_narrow_monochrome_view() {
        use areal_protocol::{Item, TurnStatus};
        let mut app = App::new(Preferences {
            color: crate::theme::ColorMode::Never,
            ..Default::default()
        });
        let mut t = thread("root", None);
        t.turns[0].status = TurnStatus::Failed;
        t.turns[0].error = Some(
            serde_json::from_value(serde_json::json!({"message":"Provider rejected request"}))
                .unwrap(),
        );
        t.turns[0].items.push(Item::AgentMessage {
            id: "empty".into(),
            text: String::new(),
            phase: None,
        });
        t.goals.goal = Some(crate::app::tests::blocked_goal());
        app.selected = Some("root".into());
        app.connected = true;
        app.subscriptions.insert("root".into());
        t.status = areal_protocol::ThreadStatus::Active {
            active_flags: vec![],
        };
        app.view = View::Conversation;
        let mut terminal = Terminal::new(TestBackend::new(60, 32)).unwrap();
        for _ in 0..2 {
            app.threads.insert("root".into(), t.clone());
            app.histories.entry("root".into()).or_default().invalidate();
            terminal.draw(|f| draw(f, &mut app)).unwrap();
            let text = screen(&terminal);
            assert!(text.contains("Turn failed"), "{text}");
            assert!(text.contains("Provider rejected request"));
            assert!(text.contains("Goal Blocked"));
            assert!(text.contains("unconfirmed usage"));
            assert!(!text.contains("Session plan"));
            assert!(!text.contains("Waiting for model"));
            assert!(text.contains("Turn Failed"));
            assert!(!text.contains("Turn Running"));
        }
    }
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
    fn completed_execution_does_not_style_unresolved_delivery_as_success() {
        let palette = Palette::new(Theme::Dark, true, true);
        let mut app = App::new(Preferences::default());
        app.execution_view = true;
        let mut terminal = Terminal::new(TestBackend::new(100, 12)).unwrap();
        for (delivery, expected) in [
            ("unknown", Role::Error),
            ("failed", Role::Error),
            ("conflict", Role::Error),
            ("partial", Role::Error),
            ("requiresActiveTurn", Role::Warning),
            ("candidate", Role::Warning),
            ("applied", Role::Success),
        ] {
            app.group = Some(
                serde_json::json!({"title":"Unit","status":"completed","settled":true,"resourcesReleased":true,"delivery":{"status":delivery}}),
            );
            terminal
                .draw(|frame| group_view(frame, frame.area(), &mut app, palette))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let line = buffer
                .content
                .chunks(100)
                .find(|row| {
                    row.iter()
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                        .contains("Delivery:")
                })
                .unwrap();
            let cell = line.iter().find(|cell| cell.symbol() == "D").unwrap();
            assert_eq!(cell.fg, palette.style(expected).fg.unwrap(), "{delivery}");
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
                phase: None,
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
