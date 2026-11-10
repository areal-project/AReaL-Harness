//! CLI 只向 Host 提交任务意图；Core 是任务与触发时间的唯一权威。
use anyhow::{Context, Result, ensure};
use areal_host::Client;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    pub command: TaskCommand,
}
#[derive(Args)]
pub struct Scope {
    #[arg(long)]
    pub project_id: Option<String>,
    #[arg(long)]
    pub source_id: Option<String>,
    #[arg(long)]
    pub execution_project_id: Option<String>,
}
#[derive(Args)]
pub struct Control {
    #[command(flatten)]
    pub scope: Scope,
    pub task_id: String,
    #[arg(long)]
    pub expected_revision: u64,
    #[arg(long)]
    pub request_id: Option<String>,
}
#[derive(Subcommand)]
pub enum TaskCommand {
    List {
        #[command(flatten)]
        scope: Scope,
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    Preview {
        #[command(flatten)]
        scope: Scope,
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    Observe {
        #[command(flatten)]
        scope: Scope,
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    Inbox {
        #[command(flatten)]
        scope: Scope,
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    Read {
        #[command(flatten)]
        scope: Scope,
        task_id: String,
    },
    Create {
        #[command(flatten)]
        scope: Scope,
        #[arg(long)]
        objective: String,
        #[arg(long)]
        schedule_file: PathBuf,
        #[arg(long)]
        thread_id: Option<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        request_id: Option<String>,
    },
    Edit {
        #[command(flatten)]
        control: Control,
        #[arg(long)]
        objective: Option<String>,
        #[arg(long)]
        schedule_file: Option<PathBuf>,
    },
    Run(Control),
    Pause(Control),
    Resume(Control),
    Cancel(Control),
    Delete(Control),
    StopRun {
        #[command(flatten)]
        control: Control,
        #[arg(long)]
        expected_run_id: String,
    },
    Receipt {
        #[command(flatten)]
        scope: Scope,
        request_id: String,
    },
}

fn scope(value: &mut Value, scope: Scope, required: bool) -> Result<()> {
    ensure!(
        !required || scope.project_id.is_some(),
        "--project-id is required"
    );
    if let Some(project) = scope.project_id {
        value["projectId"] = json!(project);
    }
    value["sourceId"] = json!(scope.source_id.unwrap_or_else(|| "host".into()));
    if let Some(execution) = scope.execution_project_id {
        value["executionProjectId"] = json!(execution);
    }
    Ok(())
}
fn request(value: &mut Value, id: Option<String>) -> Result<()> {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    uuid::Uuid::parse_str(&id).context("invalid --request-id")?;
    eprintln!("Task requestId: {id}");
    value["requestId"] = json!(id);
    Ok(())
}
fn control(value: &mut Value, input: Control) -> Result<()> {
    value["taskId"] = json!(input.task_id);
    value["expectedRevision"] = json!(input.expected_revision);
    request(value, input.request_id)?;
    scope(value, input.scope, true)
}
fn schedule(path: PathBuf) -> Result<Value> {
    let bytes = std::fs::read(path)?;
    ensure!(bytes.len() <= 64 * 1024, "schedule file exceeds 64 KiB");
    let value: areal_protocol::tasks::ScheduleIntent = serde_json::from_slice(&bytes)?;
    Ok(serde_json::to_value(value)?)
}

pub async fn execute(options: Options) -> Result<()> {
    let mut value = json!({});
    let mut write = false;
    match options.command {
        TaskCommand::List {
            scope: input,
            limit,
        } => return catalog(input, "list", limit).await,
        TaskCommand::Preview {
            scope: input,
            limit,
        } => return catalog(input, "preview", limit).await,
        TaskCommand::Observe {
            scope: input,
            limit,
        } => return catalog(input, "observe", limit).await,
        TaskCommand::Inbox {
            scope: input,
            limit,
        } => return catalog(input, "inbox", limit).await,
        TaskCommand::Read {
            scope: input,
            task_id,
        } => {
            value["operation"] = json!("task");
            value["taskId"] = json!(task_id);
            scope(&mut value, input, true)?;
        }
        TaskCommand::Create {
            scope: input,
            objective,
            schedule_file,
            thread_id,
            cwd,
            request_id,
        } => {
            write = true;
            value["operation"] = json!("taskCreate");
            value["mode"] = json!("scheduled");
            value["objective"] = json!(objective);
            value["scheduleV2"] = schedule(schedule_file)?;
            value["interactionMode"] = json!("interactive");
            if let Some(thread) = thread_id {
                value["threadId"] = json!(thread);
            }
            if let Some(cwd) = cwd {
                value["cwd"] = json!(cwd);
            }
            request(&mut value, request_id)?;
            scope(&mut value, input, true)?;
        }
        TaskCommand::Edit {
            control: input,
            objective,
            schedule_file,
        } => {
            ensure!(
                objective.is_some() || schedule_file.is_some(),
                "provide --objective or --schedule-file"
            );
            write = true;
            value["operation"] = json!("taskUpdate");
            if let Some(objective) = objective {
                value["objective"] = json!(objective);
            }
            if let Some(path) = schedule_file {
                value["scheduleV2"] = schedule(path)?;
            }
            control(&mut value, input)?;
        }
        TaskCommand::Run(input) => {
            write = true;
            value["operation"] = json!("taskRunNow");
            control(&mut value, input)?;
        }
        TaskCommand::Pause(input) => {
            write = true;
            value["operation"] = json!("taskPause");
            control(&mut value, input)?;
        }
        TaskCommand::Resume(input) => {
            write = true;
            value["operation"] = json!("taskResume");
            control(&mut value, input)?;
        }
        TaskCommand::Cancel(input) => {
            write = true;
            value["operation"] = json!("taskCancel");
            control(&mut value, input)?;
        }
        TaskCommand::Delete(input) => {
            write = true;
            value["operation"] = json!("taskDelete");
            control(&mut value, input)?;
        }
        TaskCommand::StopRun {
            control: input,
            expected_run_id,
        } => {
            write = true;
            value["operation"] = json!("taskStopRun");
            value["expectedRunId"] = json!(expected_run_id);
            control(&mut value, input)?;
        }
        TaskCommand::Receipt {
            scope: input,
            request_id,
        } => {
            value["operation"] = json!("receipt");
            value["requestId"] = json!(request_id);
            scope(&mut value, input, true)?;
        }
    }
    let client = Client::connect_or_start().await?;
    let result = if write {
        client.tasks_command(value).await?
    } else {
        client.tasks_read(value).await?
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

async fn catalog(input: Scope, operation: &str, limit: usize) -> Result<()> {
    ensure!((1..=100).contains(&limit), "--limit must be 1..100");
    let mut value = json!({"operation":operation,"limit":limit});
    scope(&mut value, input, false)?;
    let result = Client::connect_or_start().await?.tasks_read(value).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
