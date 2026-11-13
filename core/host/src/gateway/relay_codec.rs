use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub(crate) const FRAME_BYTES: usize = 512 * 1024;
pub(crate) const DATA_BYTES: usize = 49152;

/// 只有通过 Relay 边界校验的消息才能进入后续路由。
pub(crate) struct RelayMessage(Value);

impl RelayMessage {
    pub(crate) fn into_value(self) -> Value {
        self.0
    }
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}

fn channel(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn base64_shape(data: &str) -> bool {
    let plain = data.trim_end_matches('=');
    let padding = data.len() - plain.len();
    !data.is_empty()
        && data.len().is_multiple_of(4)
        && padding <= 2
        && plain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

fn valid(message: &Value) -> bool {
    match message["type"].as_str() {
        Some("ready") if message.get("channel").is_some() => {
            exact(message, &["type", "channel"]) && message["channel"].as_str().is_some_and(channel)
        }
        Some("ready") => {
            let limits = &message["limits"];
            exact(message, &["type", "limits", "push"])
                && message.get("push").is_none_or(Value::is_boolean)
                && exact(
                    limits,
                    &[
                        "framesPerSecond",
                        "bytesPerSecond",
                        "maxFrameBytes",
                        "heartbeatIntervalMs",
                    ],
                )
                && [
                    ("framesPerSecond", 80.0),
                    ("bytesPerSecond", 2097152.0),
                    ("maxFrameBytes", FRAME_BYTES as f64),
                ]
                .into_iter()
                .all(|(key, ceiling)| {
                    limits[key].as_f64().is_some_and(|value| {
                        value > 0.0 && value <= ceiling && value.fract() == 0.0
                    })
                })
                && limits["heartbeatIntervalMs"]
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value > 0.0 && value <= 15000.0)
        }
        Some("open" | "close") => {
            exact(message, &["type", "channel"]) && message["channel"].as_str().is_some_and(channel)
        }
        Some("data") => {
            exact(message, &["type", "channel", "data"])
                && message["channel"].as_str().is_some_and(channel)
                && message["data"]
                    .as_str()
                    .is_some_and(|data| data.len() <= FRAME_BYTES - 128 && base64_shape(data))
        }
        Some("error") => {
            exact(message, &["type", "code"])
                && message["code"].as_str().is_some_and(|code| {
                    [
                        "UNAVAILABLE",
                        "REPLACED",
                        "CAPACITY_EXCEEDED",
                        "LIMIT_EXCEEDED",
                        "INVALID_FRAME",
                        "TIMEOUT",
                    ]
                    .contains(&code)
                })
        }
        Some("pushResult") => {
            exact(message, &["type", "token", "status"])
                && message["status"] == "unregistered"
                && message["token"].as_str().is_some_and(|token| {
                    (64..=200).contains(&token.len())
                        && token.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        }
        _ => false,
    }
}

pub(crate) fn decode_message(text: &str, binary: bool) -> Result<RelayMessage> {
    ensure!(!binary && text.len() <= FRAME_BYTES, "Relay 帧无效");
    let message: Value = serde_json::from_str(text)?;
    ensure!(valid(&message), "Relay 帧无效");
    Ok(RelayMessage(message))
}

pub(crate) fn decode_data(data: &str) -> Result<Vec<u8>> {
    let Ok(decoded) = STANDARD.decode(data) else {
        bail!("Relay 编码无效")
    };
    ensure!(STANDARD.encode(&decoded) == data, "Relay 编码无效");
    Ok(decoded)
}

pub(crate) fn encode_data(id: &str, bytes: &[u8]) -> Result<String> {
    ensure!(
        channel(id) && !bytes.is_empty() && bytes.len() <= DATA_BYTES,
        "Relay 数据超过传输上限"
    );
    // serde_json::Map 的默认排序不等于协议既有的 type/channel/data 顺序。
    let text = format!(
        "{{\"type\":\"data\",\"channel\":{},\"data\":{}}}",
        json!(id),
        json!(STANDARD.encode(bytes))
    );
    ensure!(text.len() <= FRAME_BYTES, "Relay 帧超过传输上限");
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_envelope_and_canonical_base64_boundary() {
        let id = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            encode_data(id, b"f").unwrap(),
            format!("{{\"type\":\"data\",\"channel\":\"{id}\",\"data\":\"Zg==\"}}")
        );
        assert!(
            decode_message(
                &format!("{{\"type\":\"data\",\"channel\":\"{id}\",\"data\":\"Zh==\"}}"),
                false
            )
            .is_ok()
        );
        assert!(decode_data("Zh==").is_err());
        assert!(decode_data("Zg").is_err());
        assert_eq!(decode_data("Zg==").unwrap(), b"f");
        let limits = json!({"framesPerSecond":12,"bytesPerSecond":524288,"maxFrameBytes":131072,"heartbeatIntervalMs":0.5});
        let message = json!({"type":"ready","limits":limits});
        assert_eq!(
            decode_message(&message.to_string(), false)
                .unwrap()
                .into_value(),
            message
        );
        assert!(
            decode_message(
                &json!({"type":"ready","channel":id,"limits":limits}).to_string(),
                false
            )
            .is_err()
        );
    }
}
