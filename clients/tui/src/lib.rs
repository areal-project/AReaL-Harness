use anyhow::{Context, Result};
use areal_protocol::Input;
use clap::Parser;
use crossterm::{
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, EventStream, KeyEventKind,
    },
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
pub struct Args {
    /// 启动交互界面后提交的首条消息。
    #[arg(value_name = "PROMPT", conflicts_with_all = ["prompt", "goal", "input_file"])]
    initial_prompt: Option<String>,
    /// Connect to an existing Core instead of starting a local Harness.
    #[arg(long, visible_alias = "remote", conflicts_with = "LocalArgs")]
    endpoint: Option<String>,
    /// 交互式默认 shared；脚本默认 owned，保持原有退出清理行为。
    #[arg(long, value_parser = ["shared", "owned"], conflicts_with = "endpoint")]
    local_mode: Option<String>,
    /// 可信启动器提供的认证文件，不把 token 放入 URL。
    #[arg(long, requires = "endpoint")]
    auth_file: Option<std::path::PathBuf>,
    #[arg(skip)]
    shared_service: Option<areal_local_service::LaunchSpec>,
    #[command(flatten)]
    local: local::LocalArgs,
    /// 选择已部署的 Agent Profile，格式为 id@revision。
    #[arg(long)]
    agent: Option<String>,
    #[command(flatten)]
    ui: UiArgs,
    #[arg(long)]
    resume: Option<String>,
    /// 使用同一协议客户端运行一次任务，不启动全屏界面。
    #[arg(long)]
    prompt: Option<String>,
    /// 持续推进目标直到完成或需要用户操作。
    #[arg(long, conflicts_with_all = ["prompt", "input_file"])]
    goal: Option<String>,
    #[arg(long, requires = "goal")]
    goal_token_budget: Option<u64>,
    /// Read a turn input array (text, images, or other supported media) from JSON.
    #[arg(long, conflicts_with = "prompt")]
    input_file: Option<std::path::PathBuf>,
}

impl Args {
    /// 产品入口可检查本地部署状态；远程连接不读取宿主用户配置。
    pub fn local_options(&self) -> Option<&areal_local_service::LocalArgs> {
        self.endpoint.is_none().then_some(&self.local)
    }
}

pub fn safe_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}

struct TerminalGuard;
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            std::io::stdout(),
            DisableBracketedPaste,
            DisableMouseCapture
        );
        ratatui::restore();
    }
}

pub async fn run(mut args: Args) -> Result<()> {
    let agent_profile = args
        .agent
        .as_deref()
        .map(areal_local_service::parse_agent_profile)
        .transpose()?;
    anyhow::ensure!(
        args.resume.is_none() || agent_profile.is_none(),
        "--agent cannot be used when resuming a thread"
    );
    anyhow::ensure!(
        args.prompt.is_some()
            || args.goal.is_some()
            || args.input_file.is_some()
            || std::io::stdin().is_terminal(),
        "interactive TUI requires a terminal; use areal exec, --prompt or --input-file for scripts"
    );
    let prefs = if args.prompt.is_none() && args.goal.is_none() && args.input_file.is_none() {
        Some(Preferences::load(&args.ui)?)
    } else {
        None
    };
    if args.endpoint.is_none() {
        let owned = args
            .local_mode
            .as_deref()
            .map(|mode| mode == "owned")
            .unwrap_or(args.prompt.is_some() || args.goal.is_some() || args.input_file.is_some());
        if owned {
            return local::launch(&args);
        }
        let spec = areal_local_service::LaunchSpec::resolve(&args.local)?;
        let service = areal_local_service::ensure(&spec).await?;
        eprintln!(
            "Shared Harness: {} · instance {}",
            service.identity.workspace.display(),
            service.identity.service_id
        );
        args.endpoint = Some(service.endpoint);
        args.auth_file = Some(service.auth_file);
        args.shared_service = Some(spec);
    }
    let endpoint = args.endpoint.as_ref().unwrap();
    let mut client = Client::connect(endpoint, args.auth_file.as_deref()).await.with_context(|| {
        format!("Cannot connect to Core at {endpoint}. Start the server first, or omit --endpoint to start a local Harness.")
    })?;
    if let Some(goal) = args.goal {
        return headless::goal_with_profile(
            &mut client,
            args.resume,
            goal,
            args.goal_token_budget,
            agent_profile,
        )
        .await;
    }
    if let Some(prompt) = args.prompt {
        return headless::run_with_profile(
            &mut client,
            args.resume,
            vec![Input::text(prompt)],
            agent_profile,
        )
        .await;
    }
    if let Some(path) = args.input_file {
        let bytes = std::fs::read(path).context("read turn input file")?;
        anyhow::ensure!(
            bytes.len() <= areal_protocol::MAX_FRAME_BYTES / 2,
            "turn input file exceeds 2 MiB"
        );
        let input: Vec<Input> = serde_json::from_slice(&bytes).context("parse turn input array")?;
        anyhow::ensure!(!input.is_empty(), "turn input must not be empty");
        return headless::run_with_profile(&mut client, args.resume, input, agent_profile).await;
    }
    let mut app = App::new(prefs.unwrap());
    app.agent_profile = agent_profile;
    app.monitor_configuration = args.shared_service.is_some();
    app.bootstrap(args.resume.clone(), true)?;
    let mut terminal = ratatui::init();
    let _guard = TerminalGuard;
    execute!(std::io::stdout(), EnableBracketedPaste)?;
    if app.prefs.mouse {
        execute!(std::io::stdout(), EnableMouseCapture)?;
    } else {
        execute!(std::io::stdout(), DisableMouseCapture)?;
    }
    interactive(&mut client, &mut app, &mut terminal, &args).await
}

async fn interactive(
    client: &mut Client,
    app: &mut App,
    terminal: &mut ratatui::DefaultTerminal,
    args: &Args,
) -> Result<()> {
    let mut initial_prompt = args.initial_prompt.clone();
    let mut events = EventStream::new();
    let mut redraw = tokio::time::interval(Duration::from_millis(50));
    redraw.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut refresh = tokio::time::interval(Duration::from_secs(3));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut clock = tokio::time::interval(Duration::from_secs(1));
    let mut reconnect: Option<tokio::task::JoinHandle<Result<Client>>> = None;
    let mut updating: Option<tokio::task::JoinHandle<Result<()>>> = None;
    let mut next_retry = Instant::now();
    let mut retry_seconds = 1;
    loop {
        // 只在首个会话快照就绪后提交一次；断线恢复不重放已经发送的消息。
        if app.connected
            && app.current().is_some()
            && let Some(prompt) = initial_prompt.take()
        {
            app.input = prompt;
            if app.submit()? {
                return Ok(());
            }
        }
        if app.connected
            && app.restart_ready
            && updating.is_none()
            && let Some(spec) = args.shared_service.clone()
        {
            app.restart_ready = false;
            updating = Some(tokio::spawn(async move {
                let current = areal_local_service::LaunchSpec::in_bin(&spec.args, spec.bin_dir)?;
                areal_local_service::reconnect(&current).await?;
                Ok(())
            }));
        }
        if app.reconnect_requested {
            app.reconnect_requested = false;
            app.disconnect("manual reconnect");
            next_retry = Instant::now();
        }
        if !app.connected
            && updating.is_none()
            && reconnect.is_none()
            && Instant::now() >= next_retry
        {
            let endpoint = args.endpoint.clone().unwrap();
            let auth_file = args.auth_file.clone();
            let service_spec = args.shared_service.clone();
            reconnect = Some(tokio::spawn(async move {
                if let Some(spec) = service_spec {
                    let current =
                        areal_local_service::LaunchSpec::in_bin(&spec.args, spec.bin_dir)?;
                    let service = areal_local_service::reconnect(&current).await?;
                    Client::connect(&service.endpoint, Some(&service.auth_file)).await
                } else {
                    Client::connect(&endpoint, auth_file.as_deref()).await
                }
            }));
        }
        if app.connected
            && let Err(e) = app.flush(client)
        {
            app.disconnect(&e.to_string());
        }
        tokio::select! {
            result = async { updating.as_mut().unwrap().await }, if updating.is_some() => {
                updating = None;
                match result {
                    Ok(Ok(())) => { app.disconnect("Configuration updated · reconnecting"); next_retry = Instant::now(); }
                    Ok(Err(error)) => { app.configuration_notice = Some(format!("Restart pending: {error:#}")); app.dirty = true; }
                    Err(error) => { app.status = error.to_string(); app.dirty = true; }
                }
            }
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
                    Event::Mouse(event) => app.mouse(event),
                    Event::Resize(_, _) => { app.history_area = None; app.dirty = true; },
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

fn goal_request_id() -> String {
    format!(
        "goal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
