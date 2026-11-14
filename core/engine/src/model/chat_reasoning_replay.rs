/// Chat Completions `reasoning_content` is not an official OpenAI field.
/// Replay is gated by explicit configuration or a conservative auto policy.
use super::{ModelOptions, ModelProtocol};

pub(super) fn should_replay_chat_reasoning_content(
    protocol: ModelProtocol,
    endpoint: &str,
    options: &ModelOptions,
    has_tools: bool,
) -> bool {
    if protocol != ModelProtocol::ChatCompletions {
        return false;
    }
    if let Some(explicit) = options.replay_chat_reasoning_content {
        return explicit;
    }
    if options
        .capabilities
        .as_ref()
        .is_some_and(|capabilities| !capabilities.reasoning)
    {
        return false;
    }
    match chat_reasoning_auto_host(endpoint) {
        ChatReasoningAutoHost::OfficialOpenAi | ChatReasoningAutoHost::Unknown => false,
        ChatReasoningAutoHost::DeepSeek | ChatReasoningAutoHost::QwenDashScope => has_tools,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatReasoningAutoHost {
    OfficialOpenAi,
    DeepSeek,
    QwenDashScope,
    Unknown,
}

fn chat_reasoning_auto_host(endpoint: &str) -> ChatReasoningAutoHost {
    let Some(host) = endpoint_host(endpoint) else {
        return ChatReasoningAutoHost::Unknown;
    };
    if host == "api.openai.com" {
        return ChatReasoningAutoHost::OfficialOpenAi;
    }
    if host == "deepseek.com" || host.ends_with(".deepseek.com") {
        return ChatReasoningAutoHost::DeepSeek;
    }
    if is_qwen_dashscope_host(&host) {
        return ChatReasoningAutoHost::QwenDashScope;
    }
    ChatReasoningAutoHost::Unknown
}

fn endpoint_host(endpoint: &str) -> Option<String> {
    reqwest::Url::parse(endpoint)
        .ok()?
        .host_str()
        .map(|host| host.to_ascii_lowercase())
}

fn is_qwen_dashscope_host(host: &str) -> bool {
    let dashscope = host
        .split('.')
        .any(|label| label == "dashscope" || label.starts_with("dashscope-"));
    dashscope && (host == "aliyuncs.com" || host.ends_with(".aliyuncs.com"))
}

pub(super) fn apply_chat_reasoning_content(
    item: &mut serde_json::Value,
    reasoning_content: Option<&str>,
    replay: bool,
) {
    if !replay {
        return;
    }
    let Some(text) = reasoning_content.filter(|text| !text.is_empty()) else {
        return;
    };
    item["reasoning_content"] = serde_json::json!(text);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ModelOptions;
    use areal_protocol::desktop::ModelCapabilityConfig;

    fn options(replay: Option<bool>, reasoning: Option<bool>) -> ModelOptions {
        ModelOptions {
            replay_chat_reasoning_content: replay,
            capabilities: reasoning.map(|reasoning| ModelCapabilityConfig {
                tools: true,
                vision: false,
                reasoning,
                reasoning_effort_options: None,
            }),
            ..ModelOptions::default()
        }
    }

    fn auto(endpoint: &str, has_tools: bool, reasoning_capability: Option<bool>) -> bool {
        should_replay_chat_reasoning_content(
            ModelProtocol::ChatCompletions,
            endpoint,
            &options(None, reasoning_capability),
            has_tools,
        )
    }

    #[test]
    fn auto_policy_requires_documented_hosts_and_outgoing_tools() {
        assert!(!auto(
            "https://api.openai.com/v1/chat/completions",
            true,
            None
        ));
        assert!(auto(
            "https://api.deepseek.com/chat/completions",
            true,
            None
        ));
        assert!(!auto(
            "https://api.deepseek.com/chat/completions",
            false,
            None
        ));
        assert!(auto(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            true,
            None
        ));
        assert!(auto(
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
            true,
            None
        ));
        assert!(!auto(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            false,
            None
        ));
        assert!(!auto(
            "https://notdashscope.aliyuncs.com/v1/chat/completions",
            true,
            None
        ));
        assert!(!auto("http://127.0.0.1:9/v1/chat/completions", true, None));
        assert!(!auto("https://example.com/v1/chat/completions", true, None));
        assert!(!auto(
            "https://api.deepseek.com/chat/completions",
            true,
            Some(false)
        ));
        assert!(auto(
            "https://api.deepseek.com/chat/completions",
            true,
            Some(true)
        ));
    }

    #[test]
    fn explicit_override_wins_over_auto_policy() {
        let deepseek = "https://api.deepseek.com/chat/completions";
        assert!(!should_replay_chat_reasoning_content(
            ModelProtocol::ChatCompletions,
            deepseek,
            &options(Some(false), None),
            true,
        ));
        assert!(should_replay_chat_reasoning_content(
            ModelProtocol::ChatCompletions,
            "https://api.openai.com/v1/chat/completions",
            &options(Some(true), Some(false)),
            false,
        ));
        assert!(should_replay_chat_reasoning_content(
            ModelProtocol::ChatCompletions,
            "http://127.0.0.1:9/v1/chat/completions",
            &options(Some(true), None),
            false,
        ));
        assert!(!should_replay_chat_reasoning_content(
            ModelProtocol::Responses,
            deepseek,
            &options(Some(true), None),
            true,
        ));
    }
}

#[cfg(test)]
mod request_body_tests {
    use crate::model::{HttpModel, Message, ModelOptions, ModelProtocol};
    use serde_json::Value;

    fn assistant() -> Message {
        let mut message = Message::text("assistant", "visible-answer");
        message.reasoning_content = Some("secret-thinking".into());
        message
    }

    async fn project(
        endpoint: &str,
        protocol: ModelProtocol,
        options: ModelOptions,
        has_tools: bool,
    ) -> Value {
        let model = HttpModel::with_protocol(endpoint.into(), "fixture".into(), None, protocol)
            .unwrap()
            .with_options(options)
            .unwrap();
        model
            .project_request_body(vec![Message::text("user", "hello"), assistant()], has_tools)
            .await
            .unwrap()
    }

    fn chat_assistant(body: &Value) -> &Value {
        body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "assistant")
            .unwrap()
    }

    #[tokio::test]
    async fn serialized_chat_bodies_follow_host_and_tool_policy() {
        let thinking = "secret-thinking";
        let openai = project(
            "https://api.openai.com/v1/chat/completions",
            ModelProtocol::ChatCompletions,
            ModelOptions::default(),
            true,
        )
        .await;
        assert!(chat_assistant(&openai).get("reasoning_content").is_none());
        assert_eq!(chat_assistant(&openai)["content"], "visible-answer");

        let deepseek_tools = project(
            "https://api.deepseek.com/chat/completions",
            ModelProtocol::ChatCompletions,
            ModelOptions::default(),
            true,
        )
        .await;
        assert_eq!(
            chat_assistant(&deepseek_tools)["reasoning_content"],
            thinking
        );
        assert_eq!(
            serde_json::to_string(&deepseek_tools)
                .unwrap()
                .matches(thinking)
                .count(),
            1
        );

        let deepseek_plain = project(
            "https://api.deepseek.com/chat/completions",
            ModelProtocol::ChatCompletions,
            ModelOptions::default(),
            false,
        )
        .await;
        assert!(
            chat_assistant(&deepseek_plain)
                .get("reasoning_content")
                .is_none()
        );

        let custom = project(
            "http://127.0.0.1:9/v1/chat/completions",
            ModelProtocol::ChatCompletions,
            ModelOptions::default(),
            true,
        )
        .await;
        assert!(chat_assistant(&custom).get("reasoning_content").is_none());

        let enabled = project(
            "http://127.0.0.1:9/v1/chat/completions",
            ModelProtocol::ChatCompletions,
            ModelOptions {
                replay_chat_reasoning_content: Some(true),
                ..ModelOptions::default()
            },
            false,
        )
        .await;
        assert_eq!(chat_assistant(&enabled)["reasoning_content"], thinking);

        let responses = project(
            "https://api.openai.com/v1/responses",
            ModelProtocol::Responses,
            ModelOptions {
                replay_chat_reasoning_content: Some(true),
                ..ModelOptions::default()
            },
            true,
        )
        .await;
        let encoded = serde_json::to_string(&responses).unwrap();
        assert!(responses.get("messages").is_none());
        assert!(encoded.contains("visible-answer"));
        assert!(!encoded.contains("reasoning_content"));
        assert!(!encoded.contains(thinking));
    }
}
