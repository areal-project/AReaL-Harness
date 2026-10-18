use crate::{client::Client, safe_text};
use anyhow::{Context, Result, bail};
use areal_protocol::Input;
use areal_protocol::desktop::VersionRef;
use serde_json::json;

#[cfg(test)]
pub(crate) async fn run(
    client: &mut Client,
    resume: Option<String>,
    input: Vec<Input>,
) -> Result<()> {
    run_with_profile(client, resume, input, None).await
}

pub(crate) async fn run_with_profile(
    client: &mut Client,
    resume: Option<String>,
    input: Vec<Input>,
    agent_profile: Option<VersionRef>,
) -> Result<()> {
    anyhow::ensure!(
        resume.is_none() || agent_profile.is_none(),
        "--agent cannot be used when resuming a thread"
    );
    let id = match resume {
        Some(id) => client.send("areal/thread/observe", json!({"threadId":id}))?,
        None => match agent_profile {
            Some(profile) => client.send(
                "areal/thread/start",
                json!({"requestId":crate::goal_request_id(),"agentProfile":profile}),
            )?,
            None => client.send("thread/start", json!({}))?,
        },
    };
    let mut target_thread = None;
    let mut start_id = None;
    let mut target_turn = None;
    let mut interaction_required = false;
    loop {
        // Core owns the configured Turn and stream deadlines, including long tasks.
        let event = client.rx.recv().await.context("connection closed")?;
        if let Some(error) = event.get("error") {
            bail!("{}", error["message"]);
        }
        if event["id"] == id {
            let thread_id = event["result"]["thread"]["id"]
                .as_str()
                .context("missing thread id")?
                .to_owned();
            eprintln!("Thread: {thread_id}");
            start_id =
                Some(client.send("areal/turn/start", json!({"requestId":crate::goal_request_id(),"threadId":thread_id,"input":input,"interactionMode":"headless"}))?);
            target_thread = Some(thread_id);
        }
        if start_id.is_some() && event["id"].as_u64() == start_id {
            target_turn = Some(
                event["result"]["turn"]["id"]
                    .as_str()
                    .context("missing turn id")?
                    .to_owned(),
            );
        }
        if event["method"] == "areal/interaction/requested" {
            let request = &event["params"]["interaction"];
            if request["threadId"].as_str() == target_thread.as_deref() && !interaction_required {
                interaction_required = true;
                client.send(
                    "turn/interrupt",
                    json!({"threadId":request["threadId"],"turnId":request["turnId"]}),
                )?;
            }
        }
        // resume 可以交付旧 Turn 的增量；只接受本次 start 响应确定的 Turn。
        let event_turn = event["params"]["turnId"]
            .as_str()
            .or_else(|| event["params"]["turn"]["id"].as_str());
        if target_turn.is_none()
            || event["params"]["threadId"].as_str() != target_thread.as_deref()
            || event_turn != target_turn.as_deref()
        {
            continue;
        }
        if event["method"] == "item/agentMessage/delta" {
            use std::io::Write;
            print!(
                "{}",
                safe_text(event["params"]["delta"].as_str().unwrap_or(""))
            );
            std::io::stdout().flush()?;
        }
        if event["method"] == "areal/item/agentMedia/available" {
            println!(
                "\nMedia: {}",
                event["params"]["item"]["media"]["uri"]
                    .as_str()
                    .unwrap_or("unavailable")
            );
        }
        if event["method"] == "turn/completed" {
            println!();
            if interaction_required {
                bail!(
                    "interaction required; turn interrupted. Use interactive TUI/Web or configure permissions before retrying"
                );
            }
            if event["params"]["turn"]["status"] != "completed" {
                bail!("turn ended: {}", event["params"]["turn"]);
            }
            return Ok(());
        }
    }
}

pub(crate) async fn goal_with_profile(
    client: &mut Client,
    resume: Option<String>,
    objective: String,
    token_budget: Option<u64>,
    agent_profile: Option<VersionRef>,
) -> Result<()> {
    anyhow::ensure!(
        resume.is_none() || agent_profile.is_none(),
        "--agent cannot be used when resuming a thread"
    );
    let start = match resume {
        Some(id) => client.send("areal/thread/observe", json!({"threadId":id}))?,
        None => match agent_profile {
            Some(profile) => client.send(
                "areal/thread/start",
                json!({"requestId":crate::goal_request_id(),"agentProfile":profile}),
            )?,
            None => client.send("thread/start", json!({}))?,
        },
    };
    let mut thread_id = None;
    let mut create = None;
    let mut get = None;
    let mut goal_id = None;
    loop {
        let event = client
            .rx
            .recv()
            .await
            .context("connection closed; inspect the Goal before retrying")?;
        if let Some(error) = event.get("error") {
            bail!("{}", error["message"]);
        }
        if event["id"] == start {
            let thread = &event["result"]["thread"];
            let id = thread["id"]
                .as_str()
                .context("missing thread id")?
                .to_owned();
            eprintln!("Thread: {id}");
            create = Some(client.send("areal/goal/create",json!({"threadId":id,"requestId":crate::goal_request_id(),"expectedRevision":thread["goals"]["revision"].as_u64().unwrap_or(0),"objective":objective,"tokenBudget":token_budget,"interactionMode":"headless"}))?);
            thread_id = Some(id);
        }
        if create.is_some() && event["id"].as_u64() == create {
            goal_id = event["result"]["goal"]["id"].as_str().map(str::to_owned);
            get = Some(client.send("areal/goal/get", json!({"threadId":thread_id}))?);
        }
        if event["method"] == "areal/interaction/requested" {
            let request = &event["params"]["interaction"];
            if request["threadId"].as_str() == thread_id.as_deref() {
                eprintln!("Interaction required; interrupting. Resume with interactive TUI/Web.");
                client.send(
                    "turn/interrupt",
                    json!({"threadId":request["threadId"],"turnId":request["turnId"]}),
                )?;
            }
        }
        let view = if get.is_some() && event["id"].as_u64() == get {
            &event["result"]
        } else {
            &event["params"]
        };
        if view["threadId"].as_str() != thread_id.as_deref() {
            continue;
        }
        if event["method"] == "areal/goal/cleared" && view["goalId"].as_str() == goal_id.as_deref()
        {
            bail!("goal was cleared by another client");
        }
        if event["method"] == "item/agentMessage/delta" {
            use std::io::Write;
            print!("{}", safe_text(view["delta"].as_str().unwrap_or("")));
            std::io::stdout().flush()?;
        }
        if goal_id.is_some()
            && view["goal"]["id"].as_str() == goal_id.as_deref()
            && view["goal"]["status"] != "active"
            && view["goal"]["activeTurnId"].is_null()
        {
            println!("\nGoal: {}", view["goal"]);
            anyhow::ensure!(
                view["goal"]["status"] == "completed",
                "goal stopped: {} ({})",
                view["goal"]["status"],
                view["goal"]["reason"]
            );
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use areal_protocol::notification;
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn headless_interrupts_when_approval_requires_a_human() {
        let (tx, mut requests) = mpsc::channel(8);
        let (events, rx) = mpsc::channel(8);
        let mut client = Client { tx, rx, next: 1 };
        let task =
            tokio::spawn(async move { run(&mut client, None, vec![Input::text("fixture")]).await });
        let create = requests.recv().await.unwrap();
        events
            .send(json!({"id":create["id"],"result":{"thread":{"id":"thread"}}}))
            .await
            .unwrap();
        let start = requests.recv().await.unwrap();
        events
            .send(json!({"id":start["id"],"result":{"turn":{"id":"turn"}}}))
            .await
            .unwrap();
        events
            .send(notification(
                "areal/interaction/requested",
                json!({"interaction":{"threadId":"thread","turnId":"turn","kind":"approval"}}),
            ))
            .await
            .unwrap();
        let interrupt = requests.recv().await.unwrap();
        assert_eq!(interrupt["method"], "turn/interrupt");
        assert!(!task.is_finished());
        events
            .send(notification(
                "turn/completed",
                json!({"threadId":"thread","turn":{"id":"turn","status":"interrupted"}}),
            ))
            .await
            .unwrap();
        assert!(
            task.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("interaction required")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn headless_waits_for_core_beyond_six_minutes() {
        let (tx, mut requests) = mpsc::channel(8);
        let (events, rx) = mpsc::channel(8);
        let mut client = Client { tx, rx, next: 1 };
        let run = tokio::spawn(async move {
            run(
                &mut client,
                None,
                vec![
                    Input::text("long task"),
                    Input::LocalImage {
                        path: "/problem_assets/screenshot.png".into(),
                        detail: None,
                    },
                ],
            )
            .await
        });
        let create = requests.recv().await.unwrap();
        events
            .send(json!({"id":create["id"],"result":{"thread":{"id":"thread"}}}))
            .await
            .unwrap();
        let start = requests.recv().await.unwrap();
        assert_eq!(start["params"]["input"][1]["type"], "localImage");
        assert_eq!(
            start["params"]["input"][1]["path"],
            "/problem_assets/screenshot.png"
        );
        events
            .send(json!({"id":start["id"],"result":{"turn":{"id":"turn"}}}))
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(361)).await;
        tokio::task::yield_now().await;
        assert!(
            !run.is_finished(),
            "client must respect Core's Turn deadline"
        );
        events
            .send(notification(
                "turn/completed",
                json!({"threadId":"thread","turn":{"id":"turn","status":"completed"}}),
            ))
            .await
            .unwrap();
        run.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn headless_resume_waits_for_its_own_turn_completion() {
        let (tx, mut requests) = mpsc::channel(8);
        let (events, rx) = mpsc::channel(8);
        let mut client = Client { tx, rx, next: 1 };
        let run = tokio::spawn(async move {
            run(
                &mut client,
                Some("thread-fixture".into()),
                vec![Input::text("new request")],
            )
            .await
        });
        let resume = requests.recv().await.unwrap();
        events
            .send(json!({"id":resume["id"],"result":{"thread":{"id":"thread-fixture"}}}))
            .await
            .unwrap();
        let start = requests.recv().await.unwrap();
        assert_eq!(start["method"], "areal/turn/start");
        // 恢复基线之后的旧 Turn 事件可以先于本次 turn/start 响应到达。
        events
            .send(notification(
                "turn/completed",
                json!({"threadId":"thread-fixture","turn":{"id":"old-turn","status":"completed"}}),
            ))
            .await
            .unwrap();
        let _ = events
            .send(json!({"id":start["id"],"result":{"turn":{"id":"new-turn"}}}))
            .await;
        let _ = events
            .send(notification(
                "turn/completed",
                json!({"threadId":"thread-fixture","turn":{"id":"new-turn","status":"failed"}}),
            ))
            .await;
        let result = tokio::time::timeout(Duration::from_secs(2), run)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().to_string().contains("new-turn"));
    }
}
