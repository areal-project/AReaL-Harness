//! 仅 localhost SSE 夹具：端到端验证 decoder、持久历史和下一次 HTTP 请求，不调用外部模型。
use areal_engine::{
    Engine, Limits,
    model::{HttpModel, ModelProtocol},
};
use areal_protocol::{Input, TurnStatus};
use axum::{Json, Router, http::HeaderMap, routing::post};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[tokio::test]
async fn completed_response_order_and_phases_survive_real_http_and_engine_restart() {
    let canonical = json!([
        {"type":"reasoning","id":"rs-fixture","summary":[],"encrypted_content":"opaque-fixture"},
        {"type":"message","id":"comment-fixture","role":"assistant","status":"completed","phase":"commentary","content":[{"type":"output_text","text":"Inspect. ","annotations":[]}]},
        {"type":"message","id":"answer-fixture","role":"assistant","status":"completed","phase":"final_answer","content":[{"type":"output_text","text":"Done.","annotations":[]}]}
    ]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let output = canonical.clone();
    let app=Router::new().route("/",post(move |headers:HeaderMap, Json(body):Json<Value>| {
        let tx=tx.clone();let output=output.clone();
        async move {
            // 命名请求可与下一轮并发；只按可信请求用途采集解题请求，不依赖到达顺序。
            if headers.get("x-areal-model-purpose").and_then(|v|v.to_str().ok()) == Some("solve") {
                tx.send(body).unwrap();
            }
            let events=[
                json!({"type":"response.output_text.delta","delta":"Inspect. "}),
                json!({"type":"response.output_item.done","item":output[1]}),
                json!({"type":"response.output_item.done","item":output[0]}),
                json!({"type":"response.completed","response":{"id":"response-fixture","status":"completed","output":output,"usage":{"input_tokens":20,"output_tokens":9}}})
            ];
            let wire=events.iter().map(|event|format!("data: {event}\n\n")).collect::<String>();
            ([("content-type","text/event-stream")],wire)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let mut thread_id: Option<String> = None;
    for round in 0..2 {
        let model = Arc::new(
            HttpModel::with_protocol(
                endpoint.clone(),
                "fixture".into(),
                None,
                ModelProtocol::Responses,
            )
            .unwrap(),
        );
        let engine = Engine::open(data.path(), model, Limits::default()).unwrap();
        let id = if let Some(id) = &thread_id {
            id.clone()
        } else {
            engine.create("/fixture".into()).await.unwrap().id
        };
        engine
            .start(&id, vec![Input::text("Continue")])
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(10), engine.wait(&id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            completed.turns.last().unwrap().status,
            TurnStatus::Completed,
            "round={round}, error={:?}",
            completed.turns.last().unwrap().error
        );
        let request = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        if round == 1 {
            let raw = request["input"].as_array().unwrap();
            let start = raw
                .iter()
                .position(|v| v["id"] == "rs-fixture")
                .expect("solve request must retain the prior reasoning item");
            assert_eq!(
                raw.get(start..start + 3),
                Some(canonical.as_array().unwrap().as_slice())
            );
            let count = raw
                .iter()
                .filter(|v| {
                    v["content"].as_array().is_some_and(|parts| {
                        parts.iter().any(|part| {
                            part["text"]
                                .as_str()
                                .is_some_and(|text| text.contains("Inspect. "))
                        })
                    })
                })
                .count();
            assert_eq!(
                count, 1,
                "streaming UI text must not become a second model message"
            );
            assert!(!request.to_string().contains("visibleMessageId"));
        }
        thread_id = Some(id);
        engine.shutdown().await;
    }
    server.abort();
}
