//! 只验证默认 Git 指导的装配与冻结；不把提示出现视为模型遵守规范的行为证据。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, Input, TurnStatus, desktop::ThreadStart};
use async_trait::async_trait;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Capture(Mutex<Vec<Message>>);

#[async_trait]
impl Model for Capture {
    fn name(&self) -> &str {
        "git-guidance-fixture"
    }

    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        *self.0.lock().unwrap() = messages;
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("No repository changes requested."),
        )])))
    }
}

struct NoTools;
#[async_trait]
impl DynamicToolHost for NoTools {
    fn id(&self) -> &str {
        "no-tools"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        unreachable!()
    }
}

#[tokio::test]
async fn default_git_guidance_reaches_the_model_and_frozen_snapshot() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let model = Arc::new(Capture::default());
    let engine = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
    let thread = engine
        .create_configured(
            "owner".into(),
            ThreadStart {
                request_id: "git-guidance".into(),
                cwd: Some(workspace.path().to_string_lossy().into_owned()),
                options: None,
                admission_guard: None,
                agent_profile: None,
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(NoTools),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("Explain the Git workflow")])
        .await
        .unwrap();
    let finished =
        tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(finished.turns[0].status, TurnStatus::Completed);
    let snapshot = finished.turns[0].instruction_snapshot.as_ref().unwrap();
    let sent = model
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|message| message.role == "system" || message.role == "developer")
        .map(Message::text_content)
        .collect::<Vec<_>>()
        .join("\n");
    for constraint in [
        "areal/<short-task-slug>",
        "not permission to switch a shared checkout",
        "existing task branch",
        "preserve unrelated staged, unstaged and untracked changes",
        "Git commit identity and remote authentication are separate",
        "git var GIT_AUTHOR_IDENT / GIT_COMMITTER_IDENT",
        "does not prove the host is unconfigured",
        "without dumping credentials, tokens or private keys",
        "retry an uncertain push",
    ] {
        assert!(
            snapshot.contains(constraint),
            "missing frozen guidance: {constraint}"
        );
        assert!(
            sent.contains(constraint),
            "missing model guidance: {constraint}"
        );
    }
    engine.shutdown().await;
}
