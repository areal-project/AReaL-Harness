use anyhow::{Context, Result, bail};
use opentelemetry::{KeyValue, global, trace::TracerProvider as _};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{Resource, propagation::TraceContextPropagator};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    time::Duration,
};
use tracing_subscriber::{
    EnvFilter, Layer, filter::LevelFilter, layer::SubscriberExt, util::SubscriberInitExt,
};

// Standard OTLP transport headers/resource/batch settings remain owned by the SDK.
// Core-owned settings use the same startup snapshot as user configuration.
pub struct TelemetryConfig {
    endpoint: Option<String>,
    service_name: String,
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
        let specific = get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")?.filter(|v| !v.trim().is_empty());
        let general = get("OTEL_EXPORTER_OTLP_ENDPOINT")?.filter(|v| !v.trim().is_empty());
        let enabled = !disabled && (specific.is_some() || general.is_some());
        let mut endpoint = None;
        let mut timeout = Duration::from_secs(10);
        if enabled {
            for name in [
                "OTEL_EXPORTER_OTLP_PROTOCOL",
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
            ] {
                if get(name)?.is_some_and(|v| !v.is_empty() && v != "http/protobuf") {
                    bail!("Core OTLP exporter supports {name}=http/protobuf");
                }
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
                url.set_path(&format!("{}/v1/traces", url.path().trim_end_matches('/')));
            }
            endpoint = Some(url.into());
            let raw_timeout =
                get("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT")?.or(get("OTEL_EXPORTER_OTLP_TIMEOUT")?);
            if let Some(raw) = raw_timeout {
                let ms = raw.parse::<u64>().ok().filter(|v| *v > 0);
                anyhow::ensure!(
                    raw.bytes().all(|b| b.is_ascii_digit()) && ms.is_some(),
                    "OTLP timeout must be a positive integer in milliseconds"
                );
                timeout = Duration::from_millis(ms.unwrap());
            }
        }
        Ok(Self {
            endpoint,
            timeout,
            service_name: get("OTEL_SERVICE_NAME")?.unwrap_or("areal-core").into(),
        })
    }
}

pub struct TelemetryGuard {
    provider: Option<opentelemetry_sdk::trace::SdkTracerProvider>,
}

impl TelemetryGuard {
    pub fn init(config: TelemetryConfig, filter: &str) -> Result<Self> {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let log_filter = EnvFilter::try_new(filter).context("invalid log filter")?;
        let Some(endpoint) = config.endpoint else {
            tracing_subscriber::registry()
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(std::io::stderr)
                        .with_filter(log_filter),
                )
                .try_init()
                .context("install tracing subscriber")?;
            return Ok(Self { provider: None });
        };

        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .build()
            .map_err(|_| {
                anyhow::anyhow!(
                    "cannot build OTLP trace exporter; check standard OTEL_* transport settings"
                )
            })?;
        let resource = Resource::builder()
            .with_service_name(config.service_name)
            .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
            .build();
        let provider = opentelemetry_sdk::trace::SdkTracerProvider::builder()
            .with_resource(resource)
            .with_batch_exporter(exporter)
            .build();
        let tracer = provider.tracer("areal-core");
        global::set_tracer_provider(provider.clone());
        tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .with_filter(log_filter),
            )
            .with(
                tracing_opentelemetry::layer()
                    .with_tracer(tracer)
                    .with_filter(LevelFilter::INFO),
            )
            .try_init()
            .context("install OpenTelemetry tracing subscriber")?;
        Ok(Self {
            provider: Some(provider),
        })
    }

    pub fn shutdown(mut self) {
        if let Some(provider) = self.provider.take()
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "failed to flush OpenTelemetry traces");
        }
    }
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
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
            c.endpoint.as_deref(),
            Some("http://localhost:4318/prefix/v1/traces")
        );
        env.insert(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT".into(),
            "http://localhost:4319/custom".into(),
        );
        env.insert("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT".into(), "2000".into());
        let c = TelemetryConfig::from_env(&env).unwrap();
        assert_eq!(c.endpoint.as_deref(), Some("http://localhost:4319/custom"));
        assert_eq!(c.timeout, Duration::from_secs(2));
        env.insert("OTEL_SDK_DISABLED".into(), "true".into());
        assert!(TelemetryConfig::from_env(&env).unwrap().endpoint.is_none());
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
