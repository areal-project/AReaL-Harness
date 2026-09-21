//! 本地可信启动器交付身份；客户端名称、Thread ID 和工具 owner 均不构成认证。
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path, sync::Arc};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Observe,
    Interact,
    Manage,
    Tools,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Principal {
    pub id: String,
    pub token: String,
    pub permissions: BTreeSet<Permission>,
    /// 缺省表示同一部署下的共享工作区，显式列表限制可见会话。
    #[serde(default)]
    pub thread_ids: Option<BTreeSet<String>>,
}

impl Principal {
    pub(crate) fn embedded() -> Arc<Self> {
        Arc::new(Self {
            id: "trusted-embedded-host".into(),
            token: String::new(),
            permissions: [
                Permission::Observe,
                Permission::Interact,
                Permission::Manage,
                Permission::Tools,
            ]
            .into(),
            thread_ids: None,
        })
    }
    pub fn allows(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }
    pub fn sees(&self, thread: &str) -> bool {
        self.thread_ids
            .as_ref()
            .is_none_or(|ids| ids.contains(thread))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Authentication {
    pub version: u32,
    pub principals: Vec<Principal>,
}

impl Authentication {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= 64 * 1024,
            "authentication file must be a regular file of at most 64 KiB"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "authentication file must not be accessible to group or other users"
            );
        }
        let config: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        anyhow::ensure!(
            config.version == 1 && !config.principals.is_empty() && config.principals.len() <= 32,
            "invalid authentication configuration version or principal count"
        );
        let mut ids = BTreeSet::new();
        let mut tokens = BTreeSet::new();
        for principal in &config.principals {
            anyhow::ensure!(
                !principal.id.is_empty() && principal.id.len() <= 128 && ids.insert(&principal.id),
                "authentication principal IDs must be unique and 1..128 bytes"
            );
            anyhow::ensure!(
                (32..=256).contains(&principal.token.len())
                    && principal
                        .token
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                    && tokens.insert(&principal.token),
                "invalid or duplicate authentication token"
            );
        }
        Ok(config)
    }

    pub(crate) fn authenticate(&self, headers: &HeaderMap) -> Option<Arc<Principal>> {
        let bearer = headers
            .get("authorization")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "));
        let cookie = headers
            .get("cookie")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| {
                s.split(';')
                    .find_map(|s| s.trim().strip_prefix("areal_session="))
            });
        let supplied = bearer.or(cookie)?;
        self.principals
            .iter()
            .find(|p| equal_token(p.token.as_bytes(), supplied.as_bytes()))
            .cloned()
            .map(Arc::new)
    }
}

fn equal_token(expected: &[u8], supplied: &[u8]) -> bool {
    if expected.len() != supplied.len() {
        return false;
    }
    expected
        .iter()
        .zip(supplied)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

pub(crate) fn permission(method: &str) -> Permission {
    if method == "areal/process/acknowledgeCleanup"
        || method.starts_with("areal/provider/")
        || method.starts_with("areal/account/")
        || method.starts_with("areal/mcp/")
        || method.starts_with("areal/server/")
    {
        Permission::Manage
    } else if method.starts_with("areal/tool/fs") || method.starts_with("areal/tool/process") {
        Permission::Tools
    } else if matches!(
        method,
        "initialize"
            | "areal/capabilities"
            | "model/list"
            | "thread/list"
            | "thread/read"
            | "thread/resume"
            | "areal/subscription/remove"
    ) || method.ends_with("/list")
        || method.ends_with("/read")
        || method.ends_with("/inspect")
        || method.ends_with("/status")
        || method.ends_with("/get")
        || method.ends_with("/wait")
        || method.ends_with("/policy")
        || method.ends_with("/artifact")
    {
        Permission::Observe
    } else {
        Permission::Interact
    }
}
