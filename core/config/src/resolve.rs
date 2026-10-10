use crate::{
    file::{self, Entry},
    *,
};
use std::{
    ffi::OsStr,
    path::{Component, Path},
};

const ENV: &[(&str, &str, &str)] = &[
    (
        "AREAL_HARNESS_SUMMARY_REASONING_EFFORT",
        "",
        "model.summary_reasoning_effort",
    ),
    (
        "AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS",
        "",
        "model.summary_max_output_tokens",
    ),
    (
        "AREAL_HARNESS_CONTEXT_TARGET_TOKENS",
        "",
        "limits.context_target_tokens",
    ),
    (
        "AREAL_HARNESS_RESPONSES_WEBSOCKET",
        "",
        "model.responses_websocket",
    ),
    ("AREAL_HARNESS_PERMISSION_MODE", "", "permissions.mode"),
    ("AREAL_HARNESS_LISTEN", "", "server.listen"),
    ("AREAL_HARNESS_DATA_DIR", "", "server.data_dir"),
    ("AREAL_HARNESS_TOOL_EXTENSIONS", "", "tools.extensions_file"),
    ("AREAL_HARNESS_MODEL", "AREAL_MODEL", "model.name"),
    ("AREAL_HARNESS_MODEL_PROVIDER", "", "model.provider"),
    (
        "AREAL_HARNESS_MODEL_ENDPOINT",
        "AREAL_MODEL_ENDPOINT",
        "endpoint",
    ),
    (
        "AREAL_HARNESS_MODEL_PROTOCOL",
        "AREAL_MODEL_PROTOCOL",
        "protocol",
    ),
    ("AREAL_HARNESS_API_KEY_ENV", "", "api_key_env"),
    (
        "AREAL_HARNESS_MODEL_CONCURRENCY",
        "",
        "limits.model_concurrency",
    ),
    ("AREAL_HARNESS_MAX_THREADS", "", "limits.max_threads"),
    (
        "AREAL_HARNESS_REASONING_SUMMARY",
        "",
        "model.reasoning_summary",
    ),
    (
        "AREAL_HARNESS_MAX_ACTIVE_TURNS",
        "",
        "limits.max_active_turns",
    ),
    (
        "AREAL_HARNESS_MAX_CHILDREN_PER_TURN",
        "",
        "limits.max_children_per_turn",
    ),
    (
        "AREAL_HARNESS_MAX_AGENT_DEPTH",
        "",
        "limits.max_agent_depth",
    ),
    (
        "AREAL_HARNESS_REASONING_EFFORT",
        "",
        "model.reasoning_effort",
    ),
    (
        "AREAL_HARNESS_MAX_OUTPUT_TOKENS",
        "",
        "model.max_output_tokens",
    ),
    ("AREAL_HARNESS_TEMPERATURE", "", "model.temperature"),
    ("AREAL_HARNESS_TOP_P", "", "model.top_p"),
    ("AREAL_HARNESS_TOP_K", "", "model.top_k"),
    ("AREAL_HARNESS_MIN_P", "", "model.min_p"),
    (
        "AREAL_HARNESS_PRESENCE_PENALTY",
        "",
        "model.presence_penalty",
    ),
    (
        "AREAL_HARNESS_REPETITION_PENALTY",
        "",
        "model.repetition_penalty",
    ),
    ("AREAL_HARNESS_MODEL_MAX_RETRIES", "", "model.max_retries"),
    (
        "AREAL_HARNESS_WATCHDOG_DISABLE",
        "",
        "limits.watchdog_disable",
    ),
    (
        "AREAL_HARNESS_STREAM_IDLE_TIMEOUT_SECONDS",
        "",
        "limits.stream_idle_timeout_seconds",
    ),
    (
        "AREAL_HARNESS_MAX_HISTORY_BYTES",
        "",
        "limits.max_history_bytes",
    ),
    (
        "AREAL_HARNESS_MAX_OUTPUT_BYTES",
        "",
        "limits.max_output_bytes",
    ),
    ("AREAL_HARNESS_MAX_TOOL_CALLS", "", "limits.max_tool_calls"),
    (
        "AREAL_HARNESS_MAX_TOOL_BUFFER_BYTES",
        "",
        "limits.max_tool_buffer_bytes",
    ),
    (
        "AREAL_HARNESS_CONTEXT_WINDOW_BYTES",
        "",
        "limits.context_window_bytes",
    ),
    (
        "AREAL_HARNESS_CONTEXT_COMPACTION_ENABLED",
        "",
        "limits.context_compaction_enabled",
    ),
    (
        "AREAL_HARNESS_CONTEXT_RECENT_BYTES",
        "",
        "limits.context_recent_bytes",
    ),
    (
        "AREAL_HARNESS_CONTEXT_WINDOW_TOKENS",
        "",
        "limits.context_window_tokens",
    ),
    (
        "AREAL_HARNESS_CONTEXT_OUTPUT_RESERVE_TOKENS",
        "",
        "limits.context_output_reserve_tokens",
    ),
    (
        "AREAL_HARNESS_MODEL_CONTEXT_WINDOW_TOKENS",
        "",
        "model.context_window_tokens",
    ),
    ("AREAL_HARNESS_CONTEXT_MODE", "", "limits.context_mode"),
    (
        "AREAL_HARNESS_CONTEXT_RECENT_TOKENS",
        "",
        "limits.context_recent_tokens",
    ),
    (
        "AREAL_HARNESS_CONTEXT_TARGET_TOKENS",
        "",
        "limits.context_target_tokens",
    ),
    (
        "AREAL_HARNESS_MAX_RESPONSE_TOOL_CALLS",
        "",
        "limits.max_response_tool_calls",
    ),
    (
        "AREAL_HARNESS_MAX_RESPONSE_BYTES",
        "",
        "limits.max_response_bytes",
    ),
    ("AREAL_HARNESS_LOG_FILTER", "RUST_LOG", "logging.filter"),
];

fn env(inputs: &ConfigInputs, name: &str) -> Result<Option<Entry>> {
    let source = ConfigSource::Env { name: name.into() };
    inputs
        .env
        .get(OsStr::new(name))
        .map(|value| {
            let value = value.to_str().filter(|v| !v.is_empty()).ok_or_else(|| {
                error(
                    ConfigErrorKind::InvalidValue,
                    name,
                    &source,
                    "expected nonempty UTF-8 text",
                )
            })?;
            Ok(Entry {
                value: value.into(),
                source,
            })
        })
        .transpose()
}

fn absolute(value: &Path, base: &Path) -> PathBuf {
    let joined = if value.is_absolute() {
        value.to_owned()
    } else {
        base.join(value)
    };
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component.as_os_str()),
        }
    }
    result
}

fn path_text(value: &Path, field: &str, source: &ConfigSource) -> Result<String> {
    value
        .to_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            error(
                ConfigErrorKind::InvalidValue,
                field,
                source,
                "expected a nonempty UTF-8 path",
            )
        })
}

pub(crate) fn valid(field: &str, entry: &Entry) -> Result<()> {
    let value = &entry.value;
    let reject = |message| error(ConfigErrorKind::InvalidValue, field, &entry.source, message);
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(reject("expected nonempty text without control characters"));
    }
    if field == "permissions.mode" {
        if !matches!(
            value.to_ascii_uppercase().as_str(),
            "YOLO" | "ASK_PERMISSIONS"
        ) {
            return Err(reject("expected YOLO or ASK_PERMISSIONS"));
        }
        return Ok(());
    }
    if matches!(
        field,
        "permissions.allow" | "permissions.ask" | "permissions.deny"
    ) {
        let rules: Vec<String> =
            serde_json::from_str(value).map_err(|_| reject("expected tool rules"))?;
        if rules.len() > 128
            || rules.iter().any(|r| {
                r.is_empty()
                    || r.len() > 128
                    || !r
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'*'))
            })
        {
            return Err(reject(
                "at most 128 tool patterns using letters, digits, underscore, hyphen and *",
            ));
        }
        return Ok(());
    }
    let leaf = field.rsplit('.').next().unwrap_or(field);
    match leaf {
        "catalog_version" if value != "1" => {
            return Err(reject("only model catalog_version = 1 is supported"));
        }
        "listen" => {
            let address: SocketAddr = value
                .parse()
                .map_err(|_| reject("expected a loopback IP address and port"))?;
            if !address.ip().is_loopback() {
                return Err(reject("only loopback listeners are supported"));
            }
        }
        "provider" => {
            if !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            {
                return Err(reject("invalid provider ID"));
            }
        }
        "endpoint" => {
            let url = url::Url::parse(value)
                .map_err(|_| reject("expected a complete HTTP(S) endpoint"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(reject(
                    "endpoint requires HTTP(S), a host, and no userinfo or fragment",
                ));
            }
        }
        "protocol" => {
            if !matches!(value.as_str(), "chat-completions" | "responses") {
                return Err(reject("expected chat-completions or responses"));
            }
        }
        "api_key_env" => {
            if !value
                .bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
            {
                return Err(reject("expected an environment variable name"));
            }
        }
        "reasoning_summary" => {
            if !matches!(value.as_str(), "auto" | "concise" | "detailed") {
                return Err(reject("unsupported reasoning summary"));
            }
        }
        "reasoning_effort" | "summary_reasoning_effort" => {
            if !matches!(
                value.as_str(),
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
            ) {
                return Err(reject("unsupported reasoning effort"));
            }
        }
        "temperature" => {
            if value
                .parse::<f64>()
                .ok()
                .is_none_or(|v| !v.is_finite() || !(0.0..=2.0).contains(&v))
            {
                return Err(reject("temperature must be finite and between 0 and 2"));
            }
        }
        "top_p" | "min_p" | "presence_penalty" | "repetition_penalty" => {
            let valid = value.parse::<f64>().ok().is_some_and(|v| {
                v.is_finite()
                    && match field.rsplit('.').next().unwrap_or(field) {
                        "top_p" | "min_p" => (0.0..=1.0).contains(&v),
                        "presence_penalty" => (-2.0..=2.0).contains(&v),
                        _ => v > 0.0,
                    }
            });
            if !valid {
                return Err(reject(
                    "invalid sampling parameter: expected finite value in documented range",
                ));
            }
        }
        "top_k" => {
            if value.parse::<i64>().ok().is_none_or(|v| v != -1 && v < 1) {
                return Err(reject("top_k must be -1 (disabled) or a positive integer"));
            }
        }
        "context_window_tokens"
        | "context_output_reserve_tokens"
        | "context_target_tokens"
        | "context_recent_tokens" => {
            if value
                .parse::<usize>()
                .ok()
                .is_none_or(|v| v > 2_000_000 || (field == "model.context_window_tokens" && v == 0))
            {
                return Err(reject(
                    "token budget must be an integer between 0 and 2000000",
                ));
            }
        }
        "context_mode" => {
            if !matches!(value.as_str(), "auto" | "manual" | "disabled") {
                return Err(reject("context mode must be auto, manual or disabled"));
            }
        }
        "watchdog_disable" | "context_compaction_enabled" | "responses_websocket" => {
            if !matches!(value.as_str(), "0" | "1" | "false" | "true") {
                return Err(reject("boolean must be 0/1 or false/true"));
            }
        }
        "max_retries" | "max_completion_retries" => {
            if !value.bytes().all(|b| b.is_ascii_digit())
                || value.parse::<usize>().ok().is_none_or(|n| n > 8)
            {
                return Err(reject("model retries must be between 0 and 8"));
            }
        }
        "max_turns" | "max_active_seconds" | "max_unreported_turns" | "turn_model_rounds" => {
            let max = if field.ends_with("turn_model_rounds") {
                1024
            } else {
                86400
            };
            let min = if field.ends_with("turn_model_rounds") {
                2
            } else {
                1
            };
            if value.parse::<u64>().ok().is_none_or(|n| {
                (n != 0 || field.ends_with("max_unreported_turns")) && (n < min || n > max)
            }) {
                return Err(reject("goal limit is out of range"));
            }
        }
        "stream_idle_timeout_seconds" => {
            if !value.bytes().all(|b| b.is_ascii_digit())
                || value
                    .parse::<u64>()
                    .ok()
                    .is_none_or(|n| n == 0 || n > 86400)
            {
                return Err(reject("timeout must be between 1 and 86400 seconds"));
            }
        }
        "model_concurrency"
        | "max_threads"
        | "max_active_turns"
        | "max_children_per_turn"
        | "max_agent_depth"
        | "max_output_tokens"
        | "summary_max_output_tokens"
        | "max_history_bytes"
        | "max_output_bytes"
        | "max_tool_calls"
        | "max_response_tool_calls"
        | "max_response_bytes"
        | "max_tool_buffer_bytes"
        | "context_window_bytes"
        | "context_recent_bytes" => {
            // Tokio semaphores and Engine capacity must never panic on user input.
            let number = value.parse::<usize>().ok().filter(|n| {
                (*n > 0
                    || matches!(
                        field.rsplit('.').next(),
                        Some(
                            "max_children_per_turn"
                                | "max_agent_depth"
                                | "max_history_bytes"
                                | "max_output_bytes"
                                | "max_tool_calls"
                                | "context_window_bytes"
                                | "context_recent_bytes"
                        )
                    ))
                    && *n <= usize::MAX >> 3
            });
            if !value.bytes().all(|b| b.is_ascii_digit()) || number.is_none() {
                return Err(reject(
                    "expected a decimal integer within capacity range; zero is allowed for optional budgets, byte guards and delegation limits",
                ));
            }
        }
        "filter" => {
            tracing_subscriber::EnvFilter::try_new(value)
                .map_err(|_| reject("invalid tracing log filter"))?;
        }
        _ => {}
    }
    Ok(())
}

fn insert(
    values: &mut BTreeMap<String, Entry>,
    field: &str,
    mut entry: Entry,
    cwd: &Path,
) -> Result<()> {
    valid(field, &entry)?;
    if matches!(field, "server.data_dir" | "tools.extensions_file") {
        let base = match &entry.source {
            ConfigSource::File { path, .. } => path.parent().unwrap(),
            _ => cwd,
        };
        entry.value = path_text(
            &absolute(Path::new(&entry.value), base),
            field,
            &entry.source,
        )?;
    }
    values.insert(field.into(), entry);
    Ok(())
}

pub fn load_config(inputs: &ConfigInputs) -> Result<ResolvedCoreConfig> {
    load_mode(inputs, false, None)
}

/// 管理启动允许缺失模型或选中模型的凭据；配置结构仍必须有效。
pub fn load_management_config(inputs: &ConfigInputs) -> Result<ResolvedCoreConfig> {
    load_mode(inputs, true, None)
}

pub(crate) fn load_mode(
    inputs: &ConfigInputs,
    management: bool,
    supplied_file: Option<file::FileLayer>,
) -> Result<ResolvedCoreConfig> {
    let default = ConfigSource::Default;
    if !inputs.cwd.is_absolute() {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "cwd",
            &default,
            "caller must supply an absolute startup cwd",
        ));
    }
    for key in inputs.env.keys() {
        if let Some(name) = key.to_str()
            && name.starts_with("AREAL_HARNESS_")
            && !matches!(
                name,
                "AREAL_HARNESS_HOME" | "AREAL_HARNESS_CONFIG" | "AREAL_HARNESS_SERVICE_HOME"
            )
            && !ENV.iter().any(|(key, _, _)| *key == name)
        {
            return Err(error(
                ConfigErrorKind::UnknownField,
                "environment",
                &ConfigSource::Env { name: name.into() },
                "unknown Core configuration variable",
            ));
        }
    }
    let Location {
        home,
        home_source,
        selected,
        selected_source,
        explicit,
    } = location(inputs)?;
    let file = match supplied_file {
        Some(file) => file,
        None => file::read(&selected, explicit)?,
    };
    let catalog = file.catalog.clone();
    let catalog_managed = file.values.contains_key("model.catalog_version");
    let mut values = BTreeMap::new();
    for (field, value) in [
        ("permissions.mode", "YOLO"),
        ("permissions.allow", "[]"),
        ("permissions.ask", "[]"),
        ("permissions.deny", "[]"),
        ("server.listen", "127.0.0.1:4500"),
        ("model.provider", "default"),
        ("limits.model_concurrency", "32"),
        ("goals.max_turns", "0"),
        ("goals.max_active_seconds", "0"),
        ("goals.max_unreported_turns", "3"),
        ("goals.turn_model_rounds", "0"),
        ("limits.max_threads", "20000"),
        ("limits.max_active_turns", "256"),
        ("limits.max_children_per_turn", "64"),
        ("limits.max_agent_depth", "8"),
        ("limits.stream_idle_timeout_seconds", "30"),
        ("limits.max_history_bytes", "0"),
        ("limits.max_output_bytes", "0"),
        ("limits.max_tool_calls", "0"),
        ("limits.max_response_tool_calls", "128"),
        ("limits.max_response_bytes", "4194304"),
        ("limits.max_tool_buffer_bytes", "4194304"),
        ("limits.context_window_bytes", "0"),
        ("limits.context_compaction_enabled", "true"),
        ("limits.context_window_tokens", "65536"),
        ("limits.context_target_tokens", "0"),
        ("limits.context_output_reserve_tokens", "8192"),
        ("limits.context_recent_bytes", "0"),
        ("limits.context_recent_tokens", "8192"),
        ("limits.context_mode", "auto"),
        ("model.max_retries", "2"),
        ("model.responses_websocket", "false"),
        ("limits.max_completion_retries", "0"),
        ("limits.watchdog_disable", "false"),
        ("logging.filter", "info"),
    ] {
        insert(
            &mut values,
            field,
            Entry {
                value: value.into(),
                source: default.clone(),
            },
            &inputs.cwd,
        )?;
    }
    insert(
        &mut values,
        "server.data_dir",
        Entry {
            value: path_text(&home.join("state"), "server.data_dir", &home_source)?,
            source: default.clone(),
        },
        &inputs.cwd,
    )?;
    for (field, entry) in file.values {
        insert(&mut values, &field, entry, &inputs.cwd)?;
    }
    if let Some(mut entry) = env(inputs, "ASK_PERMISSIONS")? {
        entry.value = match entry.value.as_str() {
            "1" | "true" => "ASK_PERMISSIONS",
            "0" | "false" => "YOLO",
            _ => {
                return Err(error(
                    ConfigErrorKind::InvalidValue,
                    "permissions.mode",
                    &entry.source,
                    "ASK_PERMISSIONS must be 1, 0, true or false",
                ));
            }
        }
        .into();
        insert(&mut values, "permissions.mode", entry, &inputs.cwd)?;
    }
    let mut provider_overrides = BTreeMap::new();
    let mut warnings = Vec::new();
    for (name, alias, field) in ENV {
        for name in [*alias, *name].into_iter().filter(|s| !s.is_empty()) {
            if let Some(entry) = env(inputs, name)? {
                if name == *alias && name.starts_with("AREAL_MODEL") {
                    warnings.push(format!(
                        "{name} is deprecated; use {}",
                        ENV.iter().find(|(_, a, _)| *a == name).unwrap().0
                    ));
                }
                let map = if field.contains('.') {
                    &mut values
                } else {
                    &mut provider_overrides
                };
                insert(map, field, entry, &inputs.cwd)?;
            }
        }
    }
    let o = &inputs.overrides;
    let data_dir = o
        .data_dir
        .as_ref()
        .map(|v| {
            path_text(
                v,
                "server.data_dir",
                &ConfigSource::Cli {
                    flag: "--data-dir".into(),
                },
            )
        })
        .transpose()?;
    for (field, flag, value) in [
        ("permissions.mode", "--permissions", &o.permissions),
        ("server.listen", "--listen", &o.listen),
        ("server.data_dir", "--data-dir", &data_dir),
        ("model.name", "--model", &o.model),
        ("model.provider", "--model-provider", &o.model_provider),
        ("endpoint", "--model-endpoint", &o.model_endpoint),
        ("protocol", "--model-protocol", &o.model_protocol),
        ("api_key_env", "--api-key-env", &o.api_key_env),
        (
            "limits.model_concurrency",
            "--model-concurrency",
            &o.model_concurrency,
        ),
        ("limits.max_threads", "--max-threads", &o.max_threads),
        (
            "limits.max_active_turns",
            "--max-active-turns",
            &o.max_active_turns,
        ),
        (
            "limits.max_children_per_turn",
            "--max-children-per-turn",
            &o.max_children_per_turn,
        ),
        (
            "limits.max_agent_depth",
            "--max-agent-depth",
            &o.max_agent_depth,
        ),
        ("logging.filter", "--log-filter", &o.log_filter),
    ] {
        if let Some(value) = value {
            let map = if field.contains('.') {
                &mut values
            } else {
                &mut provider_overrides
            };
            insert(
                map,
                field,
                Entry {
                    value: value.clone(),
                    source: ConfigSource::Cli { flag: flag.into() },
                },
                &inputs.cwd,
            )?;
        }
    }
    let provider = values["model.provider"].value.clone();
    // 参数按全局显式值、模型默认值、供应商默认值逐层补齐；环境和 CLI 已在上方覆盖。
    if let Some(entry) = catalog.iter().find(|p| p.id == provider) {
        let model = values
            .get("model.name")
            .and_then(|name| entry.models.iter().find(|m| m.id == name.value));
        let parameters = model.map_or_else(
            || entry.parameters.clone(),
            |m| m.parameters.overlay(&entry.parameters),
        );
        for (field, value) in parameters.values() {
            let source = file::source(&selected, &file.text, 0);
            values
                .entry(format!("model.{field}"))
                .or_insert(Entry { value, source });
        }
    }
    let prefix = format!("model.providers.{provider}");
    values.entry(format!("{prefix}.protocol")).or_insert(Entry {
        value: "chat-completions".into(),
        source: default.clone(),
    });
    for (key, entry) in provider_overrides {
        values.insert(format!("{prefix}.{key}"), entry);
    }
    // Only legacy ad-hoc default providers inherit the historical optional key.
    let legacy_endpoint =
        values
            .get(&format!("{prefix}.endpoint"))
            .is_some_and(|entry| match &entry.source {
                ConfigSource::Cli { flag } => flag == "--model-endpoint",
                ConfigSource::Env { name } => name == "AREAL_MODEL_ENDPOINT",
                _ => false,
            });
    if legacy_endpoint
        && provider == "default"
        && !file.providers.contains(&provider)
        && !values.contains_key(&format!("{prefix}.api_key_env"))
        && let Some(value) = inputs.env.get(OsStr::new("AREAL_API_KEY"))
        && !value.is_empty()
    {
        values.insert(
            format!("{prefix}.api_key_env"),
            Entry {
                value: "AREAL_API_KEY".into(),
                source: ConfigSource::Default,
            },
        );
    }
    if management
        && !values.contains_key("model.name")
        && (!values.contains_key(&format!("{prefix}.endpoint"))
            || (matches!(values["model.provider"].source, ConfigSource::Default)
                && values
                    .get(&format!("{prefix}.endpoint"))
                    .is_some_and(|e| matches!(e.source, ConfigSource::File { .. }))))
    {
        values.insert(
            "model.name".into(),
            Entry {
                value: String::new(),
                source: ConfigSource::Default,
            },
        );
        values.insert(
            format!("{prefix}.endpoint"),
            Entry {
                value: String::new(),
                source: ConfigSource::Default,
            },
        );
        values.remove(&format!("{prefix}.api_key_env"));
    }
    // 账号模型由可信桌面传输装配；独立命令行仍拒绝没有 endpoint 的账号引用。
    if management
        && provider == "areal_openai"
        && !values.contains_key(&format!("{prefix}.endpoint"))
    {
        values.insert(
            format!("{prefix}.endpoint"),
            Entry {
                value: String::new(),
                source: default.clone(),
            },
        );
    }
    for field in ["model.name".to_owned(), format!("{prefix}.endpoint")] {
        if !values.contains_key(&field) {
            return Err(error(
                ConfigErrorKind::MissingValue,
                &field,
                &values["model.provider"].source,
                "required model configuration is missing",
            ));
        }
    }
    let mut sources: BTreeMap<_, _> = values
        .iter()
        .map(|(key, entry)| (key.clone(), entry.source.clone()))
        .collect();
    sources.insert("home".into(), home_source);
    sources.insert("config_file".into(), selected_source);
    let result = ResolvedCoreConfig {
        model_catalog: catalog,
        model_catalog_managed: catalog_managed,
        permissions: PermissionConfig {
            mode: if values["permissions.mode"]
                .value
                .eq_ignore_ascii_case("YOLO")
            {
                PermissionMode::Yolo
            } else {
                PermissionMode::AskPermissions
            },
            allow: serde_json::from_str(&values["permissions.allow"].value).unwrap(),
            ask: serde_json::from_str(&values["permissions.ask"].value).unwrap(),
            deny: serde_json::from_str(&values["permissions.deny"].value).unwrap(),
        },
        goals: GoalConfig {
            max_turns: values["goals.max_turns"].value.parse().unwrap(),
            max_active_seconds: values["goals.max_active_seconds"].value.parse().unwrap(),
            max_unreported_turns: values["goals.max_unreported_turns"].value.parse().unwrap(),
            turn_model_rounds: values["goals.turn_model_rounds"].value.parse().unwrap(),
        },
        home,
        config_file: file.loaded.then_some(selected),
        listen: values["server.listen"].value.parse().unwrap(),
        data_dir: PathBuf::from(&values["server.data_dir"].value),
        tool_extensions_file: values
            .get("tools.extensions_file")
            .map(|v| PathBuf::from(&v.value)),
        model: SelectedModelConfig {
            context_window_tokens: values
                .get("model.context_window_tokens")
                .map(|v| v.value.parse().unwrap()),
            summary_reasoning_effort: values
                .get("model.summary_reasoning_effort")
                .map(|e| e.value.clone()),
            summary_max_output_tokens: values
                .get("model.summary_max_output_tokens")
                .map(|e| e.value.parse().unwrap()),
            responses_websocket: matches!(
                values["model.responses_websocket"].value.as_str(),
                "true" | "1"
            ),
            provider,
            name: values["model.name"].value.clone(),
            endpoint: values[&format!("{prefix}.endpoint")].value.clone(),
            protocol: match values[&format!("{prefix}.protocol")].value.as_str() {
                "responses" => ModelProtocolConfig::Responses,
                _ => ModelProtocolConfig::ChatCompletions,
            },
            api_key_env: values
                .get(&format!("{prefix}.api_key_env"))
                .map(|e| e.value.clone()),
            reasoning_summary: values
                .get("model.reasoning_summary")
                .map(|e| e.value.clone()),
            reasoning_effort: values
                .get("model.reasoning_effort")
                .map(|e| e.value.clone()),
            temperature: values
                .get("model.temperature")
                .map(|e| e.value.parse().unwrap()),
            top_p: values.get("model.top_p").map(|e| e.value.parse().unwrap()),
            top_k: values.get("model.top_k").map(|e| e.value.parse().unwrap()),
            min_p: values.get("model.min_p").map(|e| e.value.parse().unwrap()),
            presence_penalty: values
                .get("model.presence_penalty")
                .map(|e| e.value.parse().unwrap()),
            repetition_penalty: values
                .get("model.repetition_penalty")
                .map(|e| e.value.parse().unwrap()),
            max_output_tokens: values
                .get("model.max_output_tokens")
                .map(|e| e.value.parse().unwrap()),
            max_retries: values["model.max_retries"].value.parse().unwrap(),
        },
        model_concurrency: values["limits.model_concurrency"].value.parse().unwrap(),
        max_threads: values["limits.max_threads"].value.parse().unwrap(),
        max_active_turns: values["limits.max_active_turns"].value.parse().unwrap(),
        max_children_per_turn: values["limits.max_children_per_turn"]
            .value
            .parse()
            .unwrap(),
        max_agent_depth: values["limits.max_agent_depth"].value.parse().unwrap(),
        stream_idle_timeout_seconds: values["limits.stream_idle_timeout_seconds"]
            .value
            .parse()
            .unwrap(),
        max_history_bytes: values["limits.max_history_bytes"].value.parse().unwrap(),
        max_output_bytes: values["limits.max_output_bytes"].value.parse().unwrap(),
        max_tool_calls: values["limits.max_tool_calls"].value.parse().unwrap(),
        max_response_tool_calls: values["limits.max_response_tool_calls"]
            .value
            .parse()
            .unwrap(),
        max_response_bytes: values["limits.max_response_bytes"].value.parse().unwrap(),
        max_tool_buffer_bytes: values["limits.max_tool_buffer_bytes"]
            .value
            .parse()
            .unwrap(),
        context_window_bytes: values["limits.context_window_bytes"].value.parse().unwrap(),
        context_auto_compaction: values["limits.context_mode"].value == "auto"
            && matches!(
                values["limits.context_compaction_enabled"].value.as_str(),
                "1" | "true"
            ),
        context_recent_tokens: values["limits.context_recent_tokens"]
            .value
            .parse()
            .unwrap(),
        context_compaction_enabled: values["limits.context_mode"].value != "disabled"
            && matches!(
                values["limits.context_compaction_enabled"].value.as_str(),
                "1" | "true"
            ),
        context_target_tokens: values["limits.context_target_tokens"]
            .value
            .parse()
            .unwrap(),
        context_window_tokens: values["limits.context_window_tokens"]
            .value
            .parse()
            .unwrap(),
        context_output_reserve_tokens: values["limits.context_output_reserve_tokens"]
            .value
            .parse()
            .unwrap(),
        context_recent_bytes: values["limits.context_recent_bytes"].value.parse().unwrap(),
        max_completion_retries: values["limits.max_completion_retries"]
            .value
            .parse()
            .unwrap(),
        watchdog_disable: matches!(
            values["limits.watchdog_disable"].value.as_str(),
            "1" | "true"
        ),
        log_filter: values["logging.filter"].value.clone(),
        sources,
        warnings,
    };
    if result.max_history_bytes > 0 && result.max_output_bytes >= result.max_history_bytes {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.max_output_bytes",
            &result.sources["limits.max_output_bytes"],
            "output budget must be smaller than history budget",
        ));
    }
    // Validate credentials here so callers cannot accidentally skip the check.
    if result.model.responses_websocket && result.model.protocol != ModelProtocolConfig::Responses {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "model.responses_websocket",
            &result.sources["model.responses_websocket"],
            "responses_websocket requires responses protocol",
        ));
    }
    if result.context_window_bytes > 0 && result.context_recent_bytes >= result.context_window_bytes
    {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.context_recent_bytes",
            &result.sources["limits.context_recent_bytes"],
            "recent context budget must be smaller than context window budget",
        ));
    }
    if result.model.protocol != ModelProtocolConfig::Responses
        && let Some(entry) = values.get("model.reasoning_summary")
    {
        return Err(error(
            ConfigErrorKind::Conflict,
            "model.reasoning_summary",
            &entry.source,
            "reasoning summary requires responses protocol",
        ));
    }
    if result.model.protocol == ModelProtocolConfig::Responses {
        for field in ["top_k", "min_p", "presence_penalty", "repetition_penalty"] {
            let key = format!("model.{field}");
            if let Some(entry) = values.get(&key) {
                return Err(error(
                    ConfigErrorKind::Conflict,
                    &key,
                    &entry.source,
                    "sampling parameter requires chat-completions protocol",
                ));
            }
        }
    }
    let window = result
        .model
        .context_window_tokens
        .unwrap_or(result.context_window_tokens);
    let reserve = result
        .context_output_reserve_tokens
        .max(result.model.max_output_tokens.unwrap_or(0) as usize);
    if result.context_target_tokens > 0
        && (window == 0 || result.context_target_tokens >= window.saturating_sub(reserve))
    {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.context_target_tokens",
            &result.sources["limits.context_target_tokens"],
            "compaction target must be below the selected model input trigger",
        ));
    }
    if window > 0 && reserve >= window {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.context_output_reserve_tokens",
            &result.sources["limits.context_output_reserve_tokens"],
            "output reserve must be smaller than the selected model context window",
        ));
    }
    if !matches!(result.sources["limits.context_mode"], ConfigSource::Default)
        && !matches!(
            result.sources["limits.context_compaction_enabled"],
            ConfigSource::Default
        )
    {
        return Err(error(
            ConfigErrorKind::Conflict,
            "limits.context_mode",
            &result.sources["limits.context_mode"],
            "context.mode and legacy context_compaction_enabled cannot both be specified",
        ));
    }
    if !management {
        result.credential(inputs)?;
    }
    Ok(result)
}

pub(crate) struct Location {
    pub home: PathBuf,
    pub home_source: ConfigSource,
    pub selected: PathBuf,
    pub selected_source: ConfigSource,
    pub explicit: bool,
}

pub(crate) fn location(inputs: &ConfigInputs) -> Result<Location> {
    let default = ConfigSource::Default;
    let (home, home_source) = if let Some(entry) = env(inputs, "AREAL_HARNESS_HOME")? {
        if !Path::new(&entry.value).is_absolute() {
            return Err(error(
                ConfigErrorKind::InvalidValue,
                "home",
                &entry.source,
                "AREAL_HARNESS_HOME must be absolute",
            ));
        }
        (absolute(Path::new(&entry.value), &inputs.cwd), entry.source)
    } else {
        let home = inputs
            .homedir
            .as_ref()
            .filter(|p| p.is_absolute())
            .ok_or_else(|| {
                error(
                    ConfigErrorKind::MissingValue,
                    "home",
                    &default,
                    "cannot locate user directory; set AREAL_HARNESS_HOME",
                )
            })?;
        (home.join(".areal"), default.clone())
    };
    let env_file = env(inputs, "AREAL_HARNESS_CONFIG")?;
    let explicit = inputs.config_file.is_some() || env_file.is_some();
    let (selected, selected_source) = if let Some(path) = &inputs.config_file {
        let source = ConfigSource::Cli {
            flag: "--config".into(),
        };
        path_text(path, "config_file", &source)?;
        (absolute(path, &inputs.cwd), source)
    } else if let Some(entry) = env_file {
        (absolute(Path::new(&entry.value), &inputs.cwd), entry.source)
    } else {
        (home.join("config.toml"), default.clone())
    };
    Ok(Location {
        home,
        home_source,
        selected,
        selected_source,
        explicit,
    })
}
