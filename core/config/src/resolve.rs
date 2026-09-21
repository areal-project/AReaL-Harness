use crate::{
    file::{self, Entry},
    *,
};
use std::{
    ffi::OsStr,
    path::{Component, Path},
};

const ENV: &[(&str, &str, &str)] = &[
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
        "AREAL_HARNESS_TURN_TIMEOUT_SECONDS",
        "",
        "limits.turn_timeout_seconds",
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
        "AREAL_HARNESS_CONTEXT_WINDOW_BYTES",
        "",
        "limits.context_window_bytes",
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

fn valid(field: &str, entry: &Entry) -> Result<()> {
    let value = &entry.value;
    let reject = |message| error(ConfigErrorKind::InvalidValue, field, &entry.source, message);
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(reject("expected nonempty text without control characters"));
    }
    let leaf = field.rsplit('.').next().unwrap_or(field);
    match leaf {
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
        "reasoning_effort" => {
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
        "context_window_tokens" | "context_output_reserve_tokens" => {
            if value.parse::<usize>().ok().is_none_or(|v| v > 2_000_000) {
                return Err(reject(
                    "token budget must be an integer between 0 and 2000000",
                ));
            }
        }
        "watchdog_disable" => {
            if !matches!(value.as_str(), "0" | "1" | "false" | "true") {
                return Err(reject("watchdog_disable must be 0/1 or false/true"));
            }
        }
        "max_retries" | "max_completion_retries" => {
            if !value.bytes().all(|b| b.is_ascii_digit())
                || value.parse::<usize>().ok().is_none_or(|n| n > 8)
            {
                return Err(reject("model retries must be between 0 and 8"));
            }
        }
        "turn_timeout_seconds" | "stream_idle_timeout_seconds" => {
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
        | "max_history_bytes"
        | "max_output_bytes"
        | "max_tool_calls"
        | "context_window_bytes"
        | "context_recent_bytes" => {
            // Tokio semaphores and Engine capacity must never panic on user input.
            let number = value.parse::<usize>().ok().filter(|n| {
                (*n > 0
                    || matches!(
                        field.rsplit('.').next(),
                        Some("max_children_per_turn" | "max_agent_depth")
                    ))
                    && *n <= usize::MAX >> 3
            });
            if !value.bytes().all(|b| b.is_ascii_digit()) || number.is_none() {
                return Err(reject(
                    "expected a decimal integer within capacity range; zero is allowed only for child count or depth",
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
    load_mode(inputs, false)
}

/// 管理启动允许完全缺失模型；部分配置和无效配置仍必须拒绝。
pub fn load_management_config(inputs: &ConfigInputs) -> Result<ResolvedCoreConfig> {
    load_mode(inputs, true)
}

fn load_mode(inputs: &ConfigInputs, management: bool) -> Result<ResolvedCoreConfig> {
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
            && !matches!(name, "AREAL_HARNESS_HOME" | "AREAL_HARNESS_CONFIG")
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
        (home.join(".areal-harness"), default.clone())
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
    let file = file::read(&selected, explicit)?;
    let mut values = BTreeMap::new();
    for (field, value) in [
        ("server.listen", "127.0.0.1:4500"),
        ("model.provider", "default"),
        ("limits.model_concurrency", "32"),
        ("limits.max_threads", "20000"),
        ("limits.max_active_turns", "256"),
        ("limits.max_children_per_turn", "64"),
        ("limits.max_agent_depth", "8"),
        ("limits.turn_timeout_seconds", "300"),
        ("limits.stream_idle_timeout_seconds", "30"),
        ("limits.max_history_bytes", "2097152"),
        ("limits.max_output_bytes", "262144"),
        ("limits.max_tool_calls", "128"),
        ("limits.context_window_bytes", "196608"),
        ("limits.context_window_tokens", "0"),
        ("limits.context_output_reserve_tokens", "0"),
        ("limits.context_recent_bytes", "65536"),
        ("model.max_retries", "2"),
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
        && !values.contains_key(&format!("{prefix}.endpoint"))
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
        home,
        config_file: file.loaded.then_some(selected),
        listen: values["server.listen"].value.parse().unwrap(),
        data_dir: PathBuf::from(&values["server.data_dir"].value),
        tool_extensions_file: values
            .get("tools.extensions_file")
            .map(|v| PathBuf::from(&v.value)),
        model: SelectedModelConfig {
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
        turn_timeout_seconds: values["limits.turn_timeout_seconds"].value.parse().unwrap(),
        stream_idle_timeout_seconds: values["limits.stream_idle_timeout_seconds"]
            .value
            .parse()
            .unwrap(),
        max_history_bytes: values["limits.max_history_bytes"].value.parse().unwrap(),
        max_output_bytes: values["limits.max_output_bytes"].value.parse().unwrap(),
        max_tool_calls: values["limits.max_tool_calls"].value.parse().unwrap(),
        context_window_bytes: values["limits.context_window_bytes"].value.parse().unwrap(),
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
    if result.max_output_bytes >= result.max_history_bytes {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.max_output_bytes",
            &result.sources["limits.max_output_bytes"],
            "output budget must be smaller than history budget",
        ));
    }
    // Validate credentials here so callers cannot accidentally skip the check.
    if result.context_recent_bytes >= result.context_window_bytes {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.context_recent_bytes",
            &result.sources["limits.context_recent_bytes"],
            "recent context budget must be smaller than context window budget",
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
    if result.context_window_tokens > 0
        && result.context_output_reserve_tokens >= result.context_window_tokens
    {
        return Err(error(
            ConfigErrorKind::InvalidValue,
            "limits.context_output_reserve_tokens",
            &result.sources["limits.context_output_reserve_tokens"],
            "output reserve must be smaller than context token window",
        ));
    }
    result.credential(inputs)?;
    Ok(result)
}
