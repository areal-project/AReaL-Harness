//! 本地服务发现契约；凭据只交给可信客户端，窗口不拥有服务进程。
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const VERSION: u32 = 1;

/// 只通过可信本地客户端交付给浏览器，不进入服务发现描述或日志。
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserBootstrap {
    pub code: String,
    pub expires_in: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserBootstrapExchange {
    pub code: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub protocol_version: u32,
    pub service_id: String,
    pub generation: String,
    pub workspace: PathBuf,
    pub data_dir: PathBuf,
    pub config_fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Service {
    #[serde(flatten)]
    pub identity: Identity,
    pub endpoint: String,
    pub web_url: String,
    pub auth_file: PathBuf,
    pub log_file: PathBuf,
    pub host_pid: u32,
    pub core_pid: u32,
    pub state: State,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Ready,
    Stopping,
    Stopped,
    Unavailable,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Status {
        version: u32,
    },
    Stop {
        version: u32,
        generation: String,
        cancel: bool,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "camelCase", deny_unknown_fields)]
pub enum Response {
    Ok { service: Box<Service> },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_roundtrip_and_strict_identity() {
        let identity = Identity {
            protocol_version: VERSION,
            service_id: "a".repeat(24),
            generation: "generation".into(),
            workspace: "/workspace".into(),
            data_dir: "/state".into(),
            config_fingerprint: "fingerprint".into(),
        };
        let service = Service {
            identity: identity.clone(),
            endpoint: "ws://127.0.0.1:1".into(),
            web_url: "http://127.0.0.1:1/ui".into(),
            auth_file: "/auth".into(),
            log_file: "/log".into(),
            host_pid: 1,
            core_pid: 2,
            state: State::Ready,
        };
        let bytes = serde_json::to_vec(&Response::Ok {
            service: Box::new(service),
        })
        .unwrap();
        let Response::Ok { service } = serde_json::from_slice(&bytes).unwrap() else {
            panic!()
        };
        assert_eq!(service.identity, identity);
        let mut value = serde_json::to_value(&identity).unwrap();
        value["token"] = "must not enter identity".into();
        assert!(serde_json::from_value::<Identity>(value).is_err());
    }
}
