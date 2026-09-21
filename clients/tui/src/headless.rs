use crate::{client::Client, safe_text};
use anyhow::{Context, Result, bail};
use areal_protocol::Input;
use serde_json::json;

pub(crate) async fn run(
    client: &mut Client,
    resume: Option<String>,
    input: Vec<Input>,
) -> Result<()> {
    let id = match resume {
        Some(id) => client.send("thread/resume", json!({"threadId":id}))?,
        None => client.send("thread/start", json!({}))?,
    };
    let mut target_thread = None;
    let mut start_id = None;
    let mut target_turn = None;
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
                Some(client.send("turn/start", json!({"threadId":thread_id,"input":input}))?);
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
            if event["params"]["turn"]["status"] != "completed" {
                bail!("turn ended: {}", event["params"]["turn"]);
            }
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
        assert_eq!(start["method"], "turn/start");
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
