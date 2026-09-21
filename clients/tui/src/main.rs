use anyhow::{Context, Result};
use areal_protocol::Input;
use clap::Parser;
use crossterm::{
    event::{DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyEventKind},
    execute,
};
use futures_util::StreamExt;
use std::{
    io::IsTerminal,
    time::{Duration, Instant},
};

use app::{App, View};
use client::Client;
use theme::{Preferences, UiArgs};

mod app;
mod client;
mod commands;
mod headless;
mod history;
mod local;
mod theme;
mod ui;

#[derive(Parser)]
#[command(version, about = "AReaL-Harness terminal workspace")]
struct Args {
    /// Connect to an existing Core instead of starting a local Harness.
    #[arg(long, visible_alias = "remote", conflicts_with = "LocalArgs")]
    endpoint: Option<String>,
    /// 可信启动器提供的认证文件，不把 token 放入 URL。
    #[arg(long)]
    auth_file: Option<std::path::PathBuf>,
    #[command(flatten)]
    local: local::LocalArgs,
    #[command(flatten)]
    ui: UiArgs,
    #[arg(long)]
    resume: Option<String>,
    /// 使用同一协议客户端运行一次任务，不启动全屏界面。
    #[arg(long)]
    prompt: Option<String>,
    /// Read a turn input array (text, images, or other supported media) from JSON.
    #[arg(long, conflicts_with = "prompt")]
    input_file: Option<std::path::PathBuf>,
}

pub fn safe_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}

struct TerminalGuard;
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(std::io::stdout(), DisableBracketedPaste);
        ratatui::restore();
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    anyhow::ensure!(
        args.prompt.is_some() || args.input_file.is_some() || std::io::stdin().is_terminal(),
        "interactive TUI requires a terminal; use --prompt or --input-file for scripts"
    );
    let prefs = if args.prompt.is_none() && args.input_file.is_none() {
        Some(Preferences::load(&args.ui)?)
    } else {
        None
    };
    let Some(endpoint) = &args.endpoint else {
        return local::launch(&args);
    };
    let mut client = Client::connect(endpoint, args.auth_file.as_deref()).await.with_context(|| {
        format!("Cannot connect to Core at {endpoint}. Start the server first, or omit --endpoint to start a local Harness.")
    })?;
    if let Some(prompt) = args.prompt {
        return headless::run(&mut client, args.resume, vec![Input::text(prompt)]).await;
    }
    if let Some(path) = args.input_file {
        let bytes = std::fs::read(path).context("read turn input file")?;
        anyhow::ensure!(
            bytes.len() <= areal_protocol::MAX_FRAME_BYTES / 2,
            "turn input file exceeds 2 MiB"
        );
        let input: Vec<Input> = serde_json::from_slice(&bytes).context("parse turn input array")?;
        anyhow::ensure!(!input.is_empty(), "turn input must not be empty");
        return headless::run(&mut client, args.resume, input).await;
    }
    let mut app = App::new(prefs.unwrap());
    app.bootstrap(args.resume.clone(), true)?;
    let mut terminal = ratatui::init();
    let _guard = TerminalGuard;
    execute!(std::io::stdout(), EnableBracketedPaste)?;
    interactive(&mut client, &mut app, &mut terminal, &args).await
}

async fn interactive(
    client: &mut Client,
    app: &mut App,
    terminal: &mut ratatui::DefaultTerminal,
    args: &Args,
) -> Result<()> {
    let mut events = EventStream::new();
    let mut redraw = tokio::time::interval(Duration::from_millis(50));
    redraw.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut refresh = tokio::time::interval(Duration::from_secs(3));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut clock = tokio::time::interval(Duration::from_secs(1));
    let mut reconnect: Option<tokio::task::JoinHandle<Result<Client>>> = None;
    let mut next_retry = Instant::now();
    let mut retry_seconds = 1;
    loop {
        if app.reconnect_requested {
            app.reconnect_requested = false;
            app.disconnect("manual reconnect");
            next_retry = Instant::now();
        }
        if !app.connected && reconnect.is_none() && Instant::now() >= next_retry {
            let endpoint = args.endpoint.clone().unwrap();
            let auth_file = args.auth_file.clone();
            reconnect = Some(tokio::spawn(async move {
                Client::connect(&endpoint, auth_file.as_deref()).await
            }));
        }
        if app.connected
            && let Err(e) = app.flush(client)
        {
            app.disconnect(&e.to_string());
        }
        tokio::select! {
            value = client.rx.recv(), if app.connected => {
                match value {
                    Some(value) => if let Err(e) = app.receive(value) { app.disconnect(&format!("projection error: {e}")); },
                    None => app.disconnect("connection closed; cached data may be stale"),
                }
            }
            result = async { reconnect.as_mut().unwrap().await }, if reconnect.is_some() => {
                reconnect = None;
                match result {
                    Ok(Ok(new_client)) => {
                        *client = new_client;
                        app.status = "Reconnected · rebuilding snapshots".into();
                        app.bootstrap(app.selected.clone(), false)?;
                        retry_seconds = 1;
                    }
                    _ => { next_retry = Instant::now() + Duration::from_secs(retry_seconds); retry_seconds = (retry_seconds * 2).min(15); },
                }
                app.dirty = true;
            }
            _ = redraw.tick() => {
                if app.dirty { terminal.draw(|frame| ui::draw(frame, app))?; app.dirty = false; }
            }
            _ = refresh.tick() => { if let Err(e) = app.refresh() { app.status = e.to_string(); app.dirty = true; } }
            _ = clock.tick() => { if app.active().is_some() || app.view == View::Agents { app.dirty = true; } }
            event = events.next() => {
                let Some(Ok(event)) = event else { break; };
                match event {
                    Event::Key(key) if key.kind == KeyEventKind::Press => match app.key(key) {
                        Ok(true) => break,
                        Ok(false) => {},
                        Err(e) => { app.status = e.to_string(); app.dirty = true; },
                    },
                    Event::Paste(text) => app.paste(&text),
                    Event::Resize(_, _) => app.dirty = true,
                    _ => {},
                }
            }
        }
    }
    if let Some(reconnect) = reconnect {
        reconnect.abort();
    }
    Ok(())
}
