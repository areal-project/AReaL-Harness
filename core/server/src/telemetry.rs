mod events;

use anyhow::{Context, Result, bail};
use opentelemetry::logs::LoggerProvider as _;
use opentelemetry::{KeyValue, global, trace::TracerProvider as _};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{Resource, propagation::TraceContextPropagator};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    time::Duration,
};
use tracing_subscriber::{
    EnvFilter, Layer, filter::filter_fn, layer::SubscriberExt, util::SubscriberInitExt,
};

// 传输头、资源属性和批量队列由标准 SDK 读取；端点开关使用启动配置快照。
pub struct TelemetryConfig {
    traces: Option<SignalConfig>,
    logs: Option<SignalConfig>,
    service_name: String,
}

struct SignalConfig {
    endpoint: String,
    timeout: Duration,
}

impl TelemetryConfig {
    pub fn from_env(env: &BTreeMap<OsString, OsString>) -> Result<Self> {
        let get = |name: &str| -> Result<Option<&str>> {
            env.get(OsStr::new(name))
                .map(|value| {
                    value
                        .to_str()
                        .ok_or_else(|| anyhow::anyhow!("{name} must be UTF-8"))
                })
                .transpose()
        };
        let disabled = get("OTEL_SDK_DISABLED")?.is_some_and(|v| v.eq_ignore_ascii_case("true"));
        let signal = |kind: &str| -> Result<Option<SignalConfig>> {
            let endpoint_key = format!("OTEL_EXPORTER_OTLP_{kind}_ENDPOINT");
            let protocol_key = format!("OTEL_EXPORTER_OTLP_{kind}_PROTOCOL");
            let timeout_key = format!("OTEL_EXPORTER_OTLP_{kind}_TIMEOUT");
            let specific = get(&endpoint_key)?.filter(|v| !v.trim().is_empty());
            let general = get("OTEL_EXPORTER_OTLP_ENDPOINT")?.filter(|v| !v.trim().is_empty());
            let exporter_key = format!("OTEL_{kind}_EXPORTER");
            let exporter = get(&exporter_key)?
                .filter(|v| !v.is_empty())
                .unwrap_or("otlp");
            anyhow::ensure!(
                disabled || matches!(exporter, "none" | "otlp"),
                "{exporter_key} supports otlp or none"
            );
            let enabled =
                !disabled && exporter != "none" && (specific.is_some() || general.is_some());
            let mut endpoint = None;
            let mut timeout = Duration::from_secs(10);
            if enabled {
                if get(&protocol_key)?
                    .filter(|v| !v.is_empty())
                    .or(get("OTEL_EXPORTER_OTLP_PROTOCOL")?)
                    .is_some_and(|v| !v.is_empty() && v != "http/protobuf")
                {
                    bail!("Core OTLP exporter supports http/protobuf only");
                }
                let raw = specific.or(general).unwrap();
                let mut url =
                    url::Url::parse(raw).map_err(|_| anyhow::anyhow!("invalid OTLP endpoint"))?;
                anyhow::ensure!(
                    matches!(url.scheme(), "http" | "https")
                        && url.host_str().is_some()
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.fragment().is_none(),
                    "OTLP endpoint requires HTTP(S), host and no userinfo or fragment"
                );
                if specific.is_none() {
                    url.set_path(&format!(
                        "{}/v1/{}",
                        url.path().trim_end_matches('/'),
                        kind.to_ascii_lowercase()
                    ));
                }
                endpoint = Some(url.into());
                let raw_timeout = get(&timeout_key)?
                    .filter(|v| !v.is_empty())
                    .or(get("OTEL_EXPORTER_OTLP_TIMEOUT")?.filter(|v| !v.is_empty()));
                if let Some(raw) = raw_timeout {
                    let ms = raw.parse::<u64>().ok().filter(|v| *v > 0);
                    anyhow::ensure!(
                        raw.bytes().all(|b| b.is_ascii_digit()) && ms.is_some(),
                        "OTLP timeout must be a positive integer in milliseconds"
                    );
                    timeout = Duration::from_millis(ms.unwrap());
                }
            }
            Ok(endpoint.map(|endpoint| SignalConfig { endpoint, timeout }))
        };
        Ok(Self {
            traces: signal("TRACES")?,
            logs: signal("LOGS")?,
            service_name: get("OTEL_SERVICE_NAME")?
                .filter(|v| !v.is_empty())
                .or(get("OTEL_RESOURCE_ATTRIBUTES")?.and_then(|attrs| {
                    attrs
                        .split(',')
                        .filter_map(|a| a.trim().split_once('='))
                        .find_map(|(k, v)| {
                            (k.trim() == "service.name" && !v.trim().is_empty()).then_some(v.trim())
                        })
                }))
                .unwrap_or("areal-core")
                .into(),
        })
    }
}

pub struct TelemetryGuard {
    provider: Option<opentelemetry_sdk::trace::SdkTracerProvider>,
    logger_provider: Option<opentelemetry_sdk::logs::SdkLoggerProvider>,
    durable_provider: Option<opentelemetry_sdk::logs::SdkLoggerProvider>,
}

impl TelemetryGuard {
    pub fn init(
        config: TelemetryConfig,
        filter: &str,
        trajectory: &areal_config::TrajectoryConfig,
    ) -> Result<Self> {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let log_filter = EnvFilter::try_new(filter).context("invalid log filter")?;
        let resource = Resource::builder()
            .with_service_name(config.service_name)
            .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
            .build();
        let durable = if trajectory.enabled {
            // 用户提示统一由客户端状态入口负责，Core 不重复向继承终端输出。
            crate::trajectory::Processor::new(trajectory).ok()
        } else {
            let control = trajectory.clone();
            let _ = std::thread::Builder::new()
                .name("areal-trajectory-disable".into())
                .spawn(move || {
                    // 停用失败仅影响可选采集，由状态命令报告，不改变主服务启动结果。
                    let _ = crate::trajectory::configure_on_startup(&control);
                });
            None
        };
        let durable_enabled = durable.is_some();
        let durable_provider = durable.map(|processor| {
            opentelemetry_sdk::logs::SdkLoggerProvider::builder()
                .with_log_processor(processor)
                .build()
        });
        let logger_provider = if config.logs.is_some() {
            let mut builder = opentelemetry_sdk::logs::SdkLoggerProvider::builder()
                .with_resource(resource.clone());
            if let Some(signal) = config.logs {
                let exporter = opentelemetry_otlp::LogExporter::builder()
                    .with_http().with_protocol(Protocol::HttpBinary).with_endpoint(signal.endpoint)
                    .with_timeout(signal.timeout).build()
                    .map_err(|_| anyhow::anyhow!("cannot build OTLP log exporter; check standard OTEL_* transport settings"))?;
                builder = builder.with_batch_exporter(exporter);
            }
            Some(builder.build())
        } else {
            None
        };
        // 仅配置 Logs 时仍需本地 Span ID，关联不能依赖远端是否启用 Traces。
        let provider = if config.traces.is_some() || logger_provider.is_some() {
            let mut builder =
                opentelemetry_sdk::trace::SdkTracerProvider::builder().with_resource(resource);
            if let Some(signal) = config.traces {
                let exporter = opentelemetry_otlp::SpanExporter::builder()
                    .with_http()
                    .with_protocol(Protocol::HttpBinary)
                    .with_endpoint(signal.endpoint)
                    .with_timeout(signal.timeout)
                    .build()
                    .map_err(|_| anyhow::anyhow!("cannot build OTLP trace exporter; check standard OTEL_* transport settings"))?;
                builder = builder.with_batch_exporter(exporter);
            }
            Some(builder.build())
        } else {
            None
        };
        let trace_layer = provider.as_ref().map(|provider| {
            global::set_tracer_provider(provider.clone());
            tracing_opentelemetry::layer()
                .with_tracer(provider.tracer("areal-core"))
                .with_filter(filter_fn(|metadata| {
                    metadata.is_span() && metadata.target() == "areal::trajectory"
                }))
        });
        let logs_enabled = logger_provider.is_some();
        // Option<Layer> 不转发 on_register_dispatch，桥接层始终安装并用信号开关过滤。
        let events = events::EventLayer::<0>::new(
            logger_provider
                .as_ref()
                .map(|provider| provider.logger("areal-core")),
        )
        .with_filter(filter_fn(move |metadata| {
            logs_enabled && metadata.target() == "areal::trajectory"
        }));
        let durable_events =
            events::EventLayer::<1>::new(durable_provider.as_ref().map(|p| p.logger("areal-core")))
                .with_capture_limit(Some(trajectory.max_memory_bytes / 4))
                .with_filter(filter_fn(move |m| {
                    durable_enabled && m.target() == "areal::trajectory"
                }));
        tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .with_filter(log_filter),
            )
            .with(trace_layer)
            .with(events)
            .with(durable_events)
            .try_init()
            .context("install OpenTelemetry tracing subscriber")?;
        Ok(Self {
            provider,
            logger_provider,
            durable_provider,
        })
    }

    pub fn shutdown(mut self) {
        if let Some(provider) = self.durable_provider.take() {
            let _ = provider.shutdown();
        }
        if let Some(provider) = self.logger_provider.take()
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "failed to flush OpenTelemetry events");
        }
        if let Some(provider) = self.provider.take()
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "failed to flush OpenTelemetry traces");
        }
    }
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.durable_provider.take() {
            let _ = provider.shutdown();
        }
        if let Some(provider) = self.logger_provider.take()
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "failed to flush OpenTelemetry events");
        }
        if let Some(provider) = self.provider.take()
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "failed to flush OpenTelemetry traces");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_endpoint_and_timeout_override_general_values() {
        let mut env = BTreeMap::from([
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
                "http://localhost:4318/prefix".into(),
            ),
            ("OTEL_EXPORTER_OTLP_TIMEOUT".into(), "1000".into()),
        ]);
        let c = TelemetryConfig::from_env(&env).unwrap();
        assert_eq!(
            c.traces.as_ref().map(|s| s.endpoint.as_str()),
            Some("http://localhost:4318/prefix/v1/traces")
        );
        assert_eq!(
            c.logs.as_ref().map(|s| s.endpoint.as_str()),
            Some("http://localhost:4318/prefix/v1/logs")
        );
        env.insert(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT".into(),
            "http://localhost:4319/custom".into(),
        );
        env.insert("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT".into(), "2000".into());
        let c = TelemetryConfig::from_env(&env).unwrap();
        assert_eq!(
            c.traces.as_ref().map(|s| s.endpoint.as_str()),
            Some("http://localhost:4319/custom")
        );
        assert_eq!(c.traces.unwrap().timeout, Duration::from_secs(2));
        env.insert("OTEL_SDK_DISABLED".into(), "true".into());
        assert!(TelemetryConfig::from_env(&env).unwrap().traces.is_none());
    }

    #[test]
    fn standard_signal_switches_and_resource_service_name() {
        let mut env = BTreeMap::new();
        let config = TelemetryConfig::from_env(&env).unwrap();
        assert!(config.traces.is_none() && config.logs.is_none());
        env.insert(
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT".into(),
            "http://localhost:4318/custom-logs".into(),
        );
        let config = TelemetryConfig::from_env(&env).unwrap();
        assert!(config.traces.is_none() && config.logs.is_some());
        env.insert(
            "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
            "http://localhost:4318".into(),
        );
        env.insert("OTEL_TRACES_EXPORTER".into(), "none".into());
        let config = TelemetryConfig::from_env(&env).unwrap();
        assert!(config.traces.is_none() && config.logs.is_some());
        env.insert("OTEL_LOGS_EXPORTER".into(), "none".into());
        let config = TelemetryConfig::from_env(&env).unwrap();
        assert!(config.traces.is_none() && config.logs.is_none());
        env.insert(
            "OTEL_RESOURCE_ATTRIBUTES".into(),
            "service.name=resource-name,service.namespace=test".into(),
        );
        assert_eq!(
            TelemetryConfig::from_env(&env).unwrap().service_name,
            "resource-name"
        );
        env.insert("OTEL_SERVICE_NAME".into(), "explicit-name".into());
        assert_eq!(
            TelemetryConfig::from_env(&env).unwrap().service_name,
            "explicit-name"
        );
        env.insert("OTEL_SDK_DISABLED".into(), "true".into());
        env.insert("OTEL_TRACES_EXPORTER".into(), "otlp".into());
        env.insert("OTEL_LOGS_EXPORTER".into(), "otlp".into());
        let config = TelemetryConfig::from_env(&env).unwrap();
        assert!(config.traces.is_none() && config.logs.is_none());
    }

    #[test]
    fn bad_transport_configuration_is_rejected_without_echoing_it() {
        for (key, value) in [
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://user:secret@host/"),
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "secret"),
            ("OTEL_EXPORTER_OTLP_TIMEOUT", "secret"),
        ] {
            let mut env = BTreeMap::from([(
                "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
                "http://localhost:4318".into(),
            )]);
            env.insert(key.into(), value.into());
            let Err(error) = TelemetryConfig::from_env(&env) else {
                panic!("accepted invalid setting")
            };
            assert!(!format!("{error:?}").contains("secret"));
        }
    }
}
