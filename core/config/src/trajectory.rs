use crate::{ConfigErrorKind, Result, error, file::Entry};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

/// 轨迹导出属于部署配置；这里只保存凭据引用，不读取或序列化凭据值。
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectoryConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub spool_dir: PathBuf,
    pub max_disk_bytes: u64,
    pub max_memory_bytes: usize,
    pub max_batch_bytes: usize,
    pub max_records: usize,
    pub max_retries: u32,
    pub retry_initial_seconds: u64,
    pub retry_max_seconds: u64,
    pub request_timeout_seconds: u64,
    pub upload_interval_ms: u64,
    pub headers_env: Option<String>,
    pub headers_file: Option<PathBuf>,
}

pub(crate) const DEFAULTS: &[(&str, &str)] = &[
    ("trajectory.enabled", "false"),
    ("trajectory.endpoint", ""),
    ("trajectory.max_disk_bytes", "268435456"),
    ("trajectory.max_memory_bytes", "16777216"),
    ("trajectory.max_batch_bytes", "4194304"),
    ("trajectory.max_records", "2000"),
    ("trajectory.max_retries", "6"),
    ("trajectory.retry_initial_seconds", "5"),
    ("trajectory.retry_max_seconds", "300"),
    ("trajectory.request_timeout_seconds", "10"),
    ("trajectory.upload_interval_ms", "1000"),
];

pub(crate) fn validate(field: &str, entry: &Entry) -> Result<()> {
    let invalid = |message| error(ConfigErrorKind::InvalidValue, field, &entry.source, message);
    let leaf = field.strip_prefix("trajectory.").unwrap_or(field);
    match leaf {
        // 地址和认证的运行时错误只能关闭采集，不能阻断主服务。
        "endpoint" | "headers_env" => {
            if entry.value.len() > 4096 {
                return Err(invalid("trajectory text exceeds 4096 bytes"));
            }
        }
        "spool_dir" | "headers_file" => {
            if entry.value.trim().is_empty() || entry.value.chars().any(char::is_control) {
                return Err(invalid(
                    "expected a nonempty path without control characters",
                ));
            }
        }
        "enabled" => {
            if !matches!(entry.value.as_str(), "true" | "false") {
                return Err(invalid("expected a boolean"));
            }
        }
        _ => {
            let (min, max) = match leaf {
                "max_disk_bytes" => (1, 1_u64 << 40),
                "max_memory_bytes" => (1, 1 << 30),
                "max_batch_bytes" => (1, 64 << 20),
                "max_records" => (1, 10_000),
                "max_retries" => (0, 100),
                "retry_initial_seconds" | "retry_max_seconds" | "request_timeout_seconds" => {
                    (1, 86400)
                }
                "upload_interval_ms" => (1, 86_400_000),
                _ => return Err(invalid("unknown trajectory field")),
            };
            if entry
                .value
                .parse::<u64>()
                .ok()
                .is_none_or(|value| value < min || value > max)
            {
                return Err(invalid("trajectory limit is outside its supported range"));
            }
        }
    }
    Ok(())
}

impl TrajectoryConfig {
    pub(crate) fn resolve(values: &BTreeMap<String, Entry>) -> Result<Self> {
        let get = |field: &str| &values[&format!("trajectory.{field}")].value;
        let config = Self {
            enabled: get("enabled") == "true",
            endpoint: get("endpoint").clone(),
            spool_dir: get("spool_dir").into(),
            max_disk_bytes: get("max_disk_bytes").parse().unwrap(),
            max_memory_bytes: get("max_memory_bytes").parse().unwrap(),
            max_batch_bytes: get("max_batch_bytes").parse().unwrap(),
            max_records: get("max_records").parse().unwrap(),
            max_retries: get("max_retries").parse().unwrap(),
            retry_initial_seconds: get("retry_initial_seconds").parse().unwrap(),
            retry_max_seconds: get("retry_max_seconds").parse().unwrap(),
            request_timeout_seconds: get("request_timeout_seconds").parse().unwrap(),
            upload_interval_ms: get("upload_interval_ms").parse().unwrap(),
            headers_env: values
                .get("trajectory.headers_env")
                .map(|v| v.value.clone()),
            headers_file: values
                .get("trajectory.headers_file")
                .map(|v| v.value.clone().into()),
        };
        if config.headers_env.is_some() && config.headers_file.is_some() {
            return Err(error(
                ConfigErrorKind::Conflict,
                "trajectory.headers_file",
                &values["trajectory.headers_file"].source,
                "choose either headers_env or headers_file",
            ));
        }
        for (field, invalid, message) in [
            (
                "trajectory.max_batch_bytes",
                config.max_batch_bytes > config.max_memory_bytes
                    || config.max_batch_bytes as u64 > config.max_disk_bytes,
                "trajectory batch limit must fit within memory and disk limits",
            ),
            (
                "trajectory.retry_max_seconds",
                config.retry_max_seconds < config.retry_initial_seconds,
                "maximum retry delay must cover the initial delay",
            ),
        ] {
            if invalid {
                return Err(error(
                    ConfigErrorKind::InvalidValue,
                    field,
                    &values[field].source,
                    message,
                ));
            }
        }
        Ok(config)
    }

    pub fn diagnostic(&self) -> serde_json::Value {
        use sha2::{Digest, Sha256};
        let mut value = serde_json::to_value(self).expect("trajectory configuration");
        let endpoint = if self.endpoint.is_empty() {
            String::new()
        } else if let Ok(mut url) = url::Url::parse(&self.endpoint) {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
                url.to_string()
            } else {
                "<invalid>".into()
            }
        } else {
            "<invalid>".into()
        };
        value["endpoint"] = endpoint.into();
        // 脱敏不能让原始地址变化绕过共享服务的部署兼容性检查。
        value["endpoint_fingerprint"] =
            format!("{:x}", Sha256::digest(self.endpoint.as_bytes())).into();
        value
    }
}
