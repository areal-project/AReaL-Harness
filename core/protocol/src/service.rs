//! 本地服务发现契约；GUI 应用持有其服务生命周期，凭据只交给可信客户端。
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

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Owner {
    Gui {
        #[serde(rename = "appRunId")]
        app_run_id: String,
        profile: PathBuf,
    },
    Host {
        #[serde(rename = "hostId")]
        host_id: String,
        generation: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Service {
    #[serde(flatten)]
    pub identity: Identity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Owner>,
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

/// 仅由显式恢复发现返回；不扩展严格 v1 Service/Capabilities 的默认形状。
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryInfo {
    pub version: u32,
    pub generation: String,
    pub eligible: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryStatus {
    pub service: Service,
    pub recovery: RecoveryInfo,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub version: u32,
    pub stop_operations: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopOperationState {
    AcceptedPending,
    Blocked,
    AdmissionUnknown,
    SettlementIncomplete,
    Completed,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopOperation {
    pub version: u32,
    pub request_id: String,
    pub service_id: String,
    pub generation: String,
    pub cancel: bool,
    pub state: StopOperationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<serde_json::Value>,
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
    Capabilities {
        version: u32,
        generation: String,
    },
    StopOperation {
        version: u32,
        generation: String,
        #[serde(rename = "requestId")]
        request_id: String,
        cancel: bool,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "result", rename_all = "camelCase", deny_unknown_fields)]
pub enum Response {
    Ok { service: Box<Service> },
    Capabilities { capabilities: Capabilities },
    Operation { operation: Box<StopOperation> },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_owner_uses_strict_host_aware_wire_shape() {
        let value = serde_json::json!({
            "kind":"host", "hostId":"host-id", "generation":"host-generation"
        });
        let owner: Owner = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            owner,
            Owner::Host {
                host_id: "host-id".into(),
                generation: "host-generation".into()
            }
        );
        assert_eq!(serde_json::to_value(owner).unwrap(), value);
        for invalid in [
            serde_json::json!({"kind":"host", "hostId":"host-id"}),
            serde_json::json!({"kind":"host", "host_id":"host-id", "generation":"g"}),
            serde_json::json!({"kind":"host", "hostId":"host-id", "generation":"g", "profile":"/gui"}),
        ] {
            assert!(serde_json::from_value::<Owner>(invalid).is_err());
        }
    }

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
            owner: None,
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
