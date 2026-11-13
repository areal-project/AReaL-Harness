use super::*;
use futures_util::StreamExt;

#[tokio::test]
async fn unavailable_default_provider_reports_model_configuration_error() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(
        model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None).unwrap(),
    );
    let engine = Engine::open(data.path(), model, Limits::default()).unwrap();
    engine
        .install_configured_models(ConfiguredModels {
            providers: vec![
                serde_json::from_value(json!({
                    "id":"arena","revision":0,"endpoint":"http://127.0.0.1:9",
                    "protocol":"responses","models":["terra"]
                }))
                .unwrap(),
            ],
            provider_ids: BTreeSet::from(["arena".into()]),
            default_model: Some(ModelRef {
                provider_id: "areal_openai".into(),
                model_id: "terra".into(),
            }),
            ..Default::default()
        })
        .unwrap();
    let error = engine
        .resolve_config(None, None, Default::default(), 1)
        .unwrap_err();
    assert!(matches!(error, Error::Invalid(_)), "{error}");
    assert!(
        error
            .to_string()
            .contains("MODEL_NOT_CONFIGURED: provider 'areal_openai'")
    );
    assert!(!error.to_string().contains("thread not found"));
    let selected = engine
        .resolve_config(
            None,
            Some(ModelRef {
                provider_id: "arena".into(),
                model_id: "terra".into(),
            }),
            Default::default(),
            1,
        )
        .unwrap();
    assert_eq!(selected.provider.unwrap().id, "arena");
    engine.shutdown().await;
}

#[tokio::test]
async fn selected_provider_requests_keep_private_errors_and_owner_correlation() {
    use axum::{Router, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let app = Router::new().route("/", post(|| async {
        ([("content-type", "text/event-stream")], "data: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"private-provider-explanation\"}}\n\n")
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let default = Arc::new(
        model::HttpModel::with_protocol(
            endpoint.clone(),
            "fixture".into(),
            None,
            model::ModelProtocol::Responses,
        )
        .unwrap(),
    );
    let engine = Engine::open(data.path(), default, Limits::default()).unwrap();
    engine
        .register_credential(
            "credential-fixture".into(),
            "private-credential-fixture".into(),
        )
        .unwrap();
    let provider: Provider = serde_json::from_value(json!({
        "id":"selected-provider","revision":1,"endpoint":endpoint,"protocol":"responses",
        "models":["fixture"],"credentialRef":"credential-fixture"
    }))
    .unwrap();
    let selected = engine
        .provider_model(&provider, "fixture", &ModelParameters::default(), None)
        .unwrap();
    for purpose in [model::RequestPurpose::Solve, model::RequestPurpose::Summary] {
        let events = model::REQUEST_OWNER
            .scope(("thread-fixture".into(), "turn-fixture".into()), async {
                selected
                    .chat_for(
                        vec![model::Message::text("user", "private-task-fixture")],
                        vec![],
                        purpose,
                    )
                    .await
                    .unwrap()
                    .collect::<Vec<_>>()
                    .await
            })
            .await;
        assert!(events.iter().any(|event| event.is_err()));
    }
    let root = data.path().join("model-requests");
    let journal = std::fs::read_to_string(root.join("requests.jsonl")).unwrap();
    let audits: Vec<Value> = journal
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(audits.len(), 2);
    for (audit, purpose) in audits.iter().zip(["Solve", "Summary"]) {
        assert_eq!(audit["purpose"], purpose);
        assert_eq!(audit["threadId"], "thread-fixture");
        assert_eq!(audit["turnId"], "turn-fixture");
        assert_eq!(audit["outcome"], "failed");
        let path = std::path::PathBuf::from(audit["errorDetailFile"].as_str().unwrap());
        assert!(path.starts_with(root.canonicalize().unwrap().join("errors")));
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("private-provider-explanation")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    for private in [
        "private-task-fixture",
        "private-credential-fixture",
        "private-provider-explanation",
    ] {
        assert!(!journal.contains(private));
    }
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
}
