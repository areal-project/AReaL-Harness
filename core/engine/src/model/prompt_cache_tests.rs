use super::*;
use axum::{Json, Router, routing::post};

#[test]
fn prompt_cache_requires_responses_and_a_valid_owner() {
    assert!(
        HttpModel::new("http://127.0.0.1:1/".into(), "fixture".into(), None)
            .unwrap()
            .with_options(ModelOptions {
                responses_prompt_cache: true,
                ..Default::default()
            })
            .is_err()
    );
    for owner in [
        None,
        Some(("thread\r\ninjection".into(), "turn".into())),
        Some(("thread".into(), "".into())),
        Some(("x".repeat(129), "turn".into())),
    ] {
        assert!(
            affinity::prompt_cache_key("fixture", None, owner, RequestPurpose::Solve).is_none()
        );
    }
}

#[tokio::test]
async fn prompt_cache_is_opt_in_scoped_and_keeps_the_complete_request() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(body): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(body).unwrap();
            ([("content-type", "text/event-stream")], "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n")
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let make = |enabled, name: &str, credential: &str| {
        HttpModel::with_protocol(
            endpoint.clone(),
            name.into(),
            Some(credential.into()),
            ModelProtocol::Responses,
        )
        .unwrap()
        .with_options(ModelOptions {
            responses_prompt_cache: enabled,
            ..Default::default()
        })
        .unwrap()
    };
    let cases = [
        (
            false,
            "fixture",
            "fixture-account-a",
            Some(("thread-a", "turn-1")),
            RequestPurpose::Solve,
        ),
        (
            true,
            "fixture",
            "fixture-account-a",
            Some(("thread-a", "turn-1")),
            RequestPurpose::Solve,
        ),
        (
            true,
            "fixture",
            "fixture-account-a",
            Some(("thread-a", "turn-2")),
            RequestPurpose::Solve,
        ),
        (
            true,
            "fixture",
            "fixture-account-a",
            Some(("thread-b", "turn-1")),
            RequestPurpose::Solve,
        ),
        (
            true,
            "fixture",
            "fixture-account-b",
            Some(("thread-a", "turn-1")),
            RequestPurpose::Solve,
        ),
        (
            true,
            "other-model",
            "fixture-account-a",
            Some(("thread-a", "turn-1")),
            RequestPurpose::Solve,
        ),
        (
            true,
            "fixture",
            "fixture-account-a",
            Some(("thread-a", "turn-1")),
            RequestPurpose::Summary,
        ),
        (
            true,
            "fixture",
            "fixture-account-a",
            None,
            RequestPurpose::Solve,
        ),
        (
            true,
            "fixture",
            "fixture-account-a",
            Some(("", "turn-1")),
            RequestPurpose::Solve,
        ),
    ];
    let mut bodies = Vec::new();
    for (enabled, name, credential, owner, purpose) in cases {
        let model = make(enabled, name, credential);
        let request = async {
            let mut stream = model
                .chat_for(vec![Message::text("user", "原始输入不变")], vec![], purpose)
                .await
                .unwrap();
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
        };
        if let Some((thread, turn)) = owner {
            REQUEST_OWNER
                .scope((thread.into(), turn.into()), request)
                .await;
        } else {
            request.await;
        }
        bodies.push(rx.recv().await.unwrap());
    }
    let key = bodies[1]["prompt_cache_key"]
        .as_str()
        .expect("显式开启的 Core 请求必须携带稳定正文键");
    assert_eq!(key.len(), 64);
    assert!(key.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        bodies[2]["prompt_cache_key"], key,
        "重建模型和新 Turn 保持同线程键"
    );
    for body in &bodies[3..7] {
        assert_ne!(body["prompt_cache_key"], key);
    }
    for i in [0, 7, 8] {
        assert!(bodies[i].get("prompt_cache_key").is_none());
    }
    let mut enabled = bodies[1].clone();
    enabled.as_object_mut().unwrap().remove("prompt_cache_key");
    assert_eq!(enabled, bodies[0], "只增加传输字段，不能改输入、工具或预算");
    assert!(!key.contains("fixture-account"));
    server.abort();
    let _ = server.await;
}
