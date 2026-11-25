//! Arena 通知事件翻译与线程选项辅助函数。
use super::arena::{ArenaError, ArenaNotification};
use super::pool::{BotConnectionState, BotService, PERSONAL_AGENT_BASE_PROMPT};
use super::store::{BotRecord, SystemPromptMode, truncate_preview};
use anyhow::anyhow;
use serde_json::{Value, json};

/// 处理单条 Arena 通知；返回 `true` 表示连接已结束，应退出事件泵循环。
pub(super) fn handle_arena_notification(
    service: &BotService,
    bot_id: &str,
    workspace: &str,
    connection_id: &str,
    notif: ArenaNotification,
) -> bool {
    match notif.method.as_str() {
        "areal/server/draining" => {
            // 沙箱正常闲置回收：平滑切回 Sleeping，不记错。
            service.drop_session_if_current(bot_id, connection_id);
            service.set_state(bot_id, workspace, BotConnectionState::Sleeping);
            return true;
        }
        "host/connectionClosed" => {
            if service.drop_session_if_current(bot_id, connection_id) {
                // 无论是沙箱回收、Host 主动断开还是网络闪断，都回到 Sleeping 以便下次发消息自动重连唤醒。
                service.set_state(bot_id, workspace, BotConnectionState::Sleeping);
            }
            return true;
        }
        "turn/started" => {
            let turn_id = notif.params["turn"]["id"]
                .as_str()
                .or_else(|| notif.params["turnId"].as_str())
                .map(str::to_owned);
            service.set_active_turn(bot_id, turn_id);
            service.emit_bot_event(
                "turnStarted",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "turn/completed" => {
            let turn_id = notif.params["turn"]["id"]
                .as_str()
                .or_else(|| notif.params["turnId"].as_str());
            service.mark_turn_completed(bot_id, turn_id);
            service.emit_bot_event(
                "turnCompleted",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "item/started" => {
            service.emit_bot_event(
                "itemStarted",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "item/completed" => {
            if notif.params["item"]["type"].as_str() == Some("agentMessage")
                && let Some(text) = notif.params["item"]["text"].as_str()
            {
                service.update_last_preview(bot_id, text);
            }
            service.emit_bot_event(
                "itemCompleted",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "item/agentMessage/delta" => {
            service.emit_bot_event(
                "messageDelta",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "areal/item/agentMedia/available" => {
            service.emit_bot_event(
                "mediaAvailable",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "areal/interaction/requested" => {
            service.emit_bot_event(
                "interactionRequested",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "areal/interaction/resolved" => {
            service.emit_bot_event(
                "interactionResolved",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        "areal/context/compacted" => {
            service.emit_bot_event(
                "contextCompacted",
                bot_id,
                workspace,
                connection_id,
                notif.params,
            );
        }
        _ => {}
    }
    false
}

pub(super) fn build_thread_options(bot: &BotRecord) -> Value {
    let mut options = serde_json::Map::new();
    options.insert("interactionMode".into(), json!("interactive"));
    if bot.system_prompt_mode == SystemPromptMode::PersonalAgent {
        options.insert("systemPrompt".into(), json!(PERSONAL_AGENT_BASE_PROMPT));
    }
    if !bot.preferences.trim().is_empty() {
        options.insert("appendInstructions".into(), json!(bot.preferences));
    }
    Value::Object(options)
}

pub(super) fn extract_input_preview(input: &[Value]) -> String {
    for item in input {
        if item["type"].as_str() == Some("text")
            && let Some(text) = item["text"].as_str()
            && !text.trim().is_empty()
        {
            return truncate_preview(text);
        }
    }
    "[附件]".into()
}

pub(super) fn map_arena_error(err: ArenaError) -> anyhow::Error {
    match err {
        ArenaError::Rpc { message, .. } => anyhow!(message),
        ArenaError::Transport(message) => anyhow!(message),
    }
}
