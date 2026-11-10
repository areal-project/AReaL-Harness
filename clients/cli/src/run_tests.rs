use super::*;
use futures_util::{SinkExt, StreamExt};
use std::{os::unix::fs::PermissionsExt, sync::Arc};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message as Wire;

async fn configure_requests(
    supported: bool,
    disable: bool,
    previous: Option<bool>,
    model: Option<&str>,
) -> (Vec<Value>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        while let Some(Ok(Wire::Text(text))) = socket.next().await {
            let request: Value = serde_json::from_str(&text).unwrap();
            recorded.lock().await.push(request.clone());
            if request.get("id").is_none() {
                continue;
            }
            let method = request["method"].as_str().unwrap();
            let result = match method {
                "initialize" => json!({}),
                "areal/capabilities" => json!({"features":{"automaticSessionName":supported}}),
                "areal/model/list" => json!({"data":[
                    {"providerId":"arena","modelId":"terra"},
                    {"providerId":"other","modelId":"terra"}
                ]}),
                "areal/thread/start" | "areal/thread/observe" | "thread/read" => {
                    let mut options = json!({});
                    if let Some(enabled) = previous {
                        options["automaticSessionName"] = json!(enabled);
                    }
                    json!({"thread":{"id":"session","cwd":"/workspace",
                        "desktop":{"configuration":{"revision":3,"options":options}}}})
                }
                "areal/thread/inspect" => json!({"tools":[]}),
                "areal/profile/list" => json!({"data":[]}),
                "areal/thread/configure" => {
                    // 在读取 stdin/提交 Turn 之前结束夹具，检验真实 RPC 请求而非重复拼装逻辑。
                    socket
                        .send(Wire::Text(
                            json!({"id":request["id"],
                        "error":{"code":-32000,"message":"configuration captured"}})
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                    break;
                }
                _ => panic!("unexpected request {method}"),
            };
            socket
                .send(Wire::Text(
                    json!({"id":request["id"],"result":result})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let auth = directory.path().join("auth.json");
    std::fs::write(&auth, br#"{"principals":[{"token":"local-fixture"}]}"#).unwrap();
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut arguments = vec![
        "areal",
        "-p",
        "hello",
        "--endpoint",
        &endpoint,
        "--auth-file",
        auth.to_str().unwrap(),
    ];
    if disable {
        arguments.push("--no-session-name");
    }
    if previous.is_some() {
        arguments.extend(["--resume", "session"]);
    }
    if let Some(model) = model {
        arguments.extend(["--model", model]);
    }
    let args = LegacyArgs::try_parse_from(arguments).unwrap().cli;
    let error = tokio::time::timeout(Duration::from_secs(5), execute(&args))
        .await
        .unwrap()
        .unwrap_err()
        .to_string();
    server.abort();
    let _ = server.await;
    let result = requests.lock().await.clone();
    (result, error)
}

#[tokio::test]
async fn naming_choice_reaches_core_and_survives_cli_resume() {
    for (supported, disable, previous, expected) in [
        (false, false, None, None),
        (true, true, None, Some(false)),
        (true, false, Some(false), Some(false)),
        (true, false, Some(true), Some(true)),
        (true, true, Some(true), Some(false)),
    ] {
        let (requests, error) = configure_requests(supported, disable, previous, None).await;
        assert!(error.contains("configuration captured"), "{error}");
        let configure = requests
            .iter()
            .find(|r| r["method"] == "areal/thread/configure")
            .unwrap();
        assert_eq!(
            configure["params"]["options"]["automaticSessionName"].as_bool(),
            expected
        );
        assert_eq!(configure["params"]["expectedRevision"], 3);
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["method"] == "areal/thread/start")
                .count(),
            usize::from(previous.is_none())
        );
    }
}

#[tokio::test]
async fn unsupported_core_rejects_opt_out_before_session_or_task_mutation() {
    let (requests, error) = configure_requests(false, true, None, None).await;
    assert!(
        error.contains("Core does not support --no-session-name"),
        "{error}"
    );
    assert!(requests.iter().all(|r| matches!(
        r["method"].as_str(),
        Some("initialize" | "initialized" | "areal/capabilities")
    )));
}

#[tokio::test]
async fn explicit_provider_model_is_resolved_before_creation_and_applied_on_resume() {
    for previous in [None, Some(false)] {
        let (requests, error) =
            configure_requests(true, false, previous, Some("arena:terra")).await;
        assert!(error.contains("configuration captured"), "{error}");
        let expected = json!({"providerId":"arena","modelId":"terra"});
        let configure = requests
            .iter()
            .find(|r| r["method"] == "areal/thread/configure")
            .unwrap();
        assert_eq!(configure["params"]["model"], expected);
        if previous.is_none() {
            let catalog = requests
                .iter()
                .position(|r| r["method"] == "areal/model/list")
                .unwrap();
            let start = requests
                .iter()
                .position(|r| r["method"] == "areal/thread/start")
                .unwrap();
            assert!(catalog < start);
            assert_eq!(requests[start]["params"]["model"], expected);
        } else {
            assert!(requests.iter().all(|r| r["method"] != "areal/thread/start"));
        }
    }
}

#[tokio::test]
async fn ambiguous_model_is_rejected_before_creating_a_session() {
    let (requests, error) = configure_requests(true, false, None, Some("terra")).await;
    assert!(
        error.contains("model must identify exactly one configured API model"),
        "{error}"
    );
    assert!(requests.iter().all(|r| r["method"] != "areal/thread/start"));
}
