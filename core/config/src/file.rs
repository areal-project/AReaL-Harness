use crate::{ConfigErrorKind as Kind, ConfigSource, Result, error};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
};
use toml_edit::{Document, Item};

pub(crate) struct Entry {
    pub value: String,
    pub source: ConfigSource,
}

#[derive(Default)]
pub(crate) struct FileLayer {
    pub values: BTreeMap<String, Entry>,
    pub providers: BTreeSet<String>,
    pub loaded: bool,
}

fn source(path: &Path, text: &str, offset: usize) -> ConfigSource {
    let prefix = &text[..offset.min(text.len())];
    ConfigSource::File {
        path: path.into(),
        line: prefix.bytes().filter(|b| *b == b'\n').count() + 1,
        column: prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1,
    }
}

pub(crate) fn read(path: &Path, explicit: bool) -> Result<FileLayer> {
    let at = source(path, "", 0);
    // Inspect before opening: a FIFO must never block configuration diagnostics.
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                && !explicit
                && fs::symlink_metadata(path).is_err() =>
        {
            return Ok(FileLayer::default());
        }
        Err(_) => {
            return Err(error(
                Kind::Io,
                "config_file",
                &at,
                "cannot access configuration file",
            ));
        }
    };
    if !metadata.is_file() {
        return Err(error(
            Kind::Io,
            "config_file",
            &at,
            "configuration must be a regular file",
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|_| {
            error(
                Kind::Io,
                "config_file",
                &at,
                "cannot read configuration file",
            )
        })?;
    if bytes.len() > 1024 * 1024 {
        return Err(error(
            Kind::InvalidValue,
            "config_file",
            &at,
            "configuration exceeds 1 MiB",
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        error(
            Kind::Parse,
            "config_file",
            &at,
            "configuration must be UTF-8",
        )
    })?;
    let doc = Document::parse(text.as_str()).map_err(|e| {
        error(
            Kind::Parse,
            "config_file",
            &source(path, &text, e.span().map_or(0, |v| v.start)),
            "invalid TOML (including duplicate keys)",
        )
    })?;
    let mut layer = FileLayer {
        loaded: true,
        ..FileLayer::default()
    };
    walk(doc.as_item(), &mut Vec::new(), path, &text, &mut layer)?;
    let version = layer.values.get("schema_version").ok_or_else(|| {
        error(
            Kind::MissingValue,
            "schema_version",
            &at,
            "configuration requires schema_version = 1",
        )
    })?;
    if version.value != "1" {
        return Err(error(
            Kind::UnsupportedVersion,
            "schema_version",
            &version.source,
            "only schema_version = 1 is supported",
        ));
    }
    Ok(layer)
}

fn walk(
    item: &Item,
    parts: &mut Vec<String>,
    path: &Path,
    text: &str,
    layer: &mut FileLayer,
) -> Result<()> {
    let names: Vec<&str> = parts.iter().map(String::as_str).collect();
    let key = parts.join(".");
    let at = source(path, text, item.span().map_or(0, |v| v.start));
    let table = matches!(
        names.as_slice(),
        [] | ["server"]
            | ["model"]
            | ["model", "providers"]
            | ["model", "providers", _]
            | ["limits"]
            | ["logging"]
            | ["tools"]
            | ["goals"]
            | ["permissions"]
    );
    if table {
        let values = item
            .as_table_like()
            .ok_or_else(|| error(Kind::InvalidValue, &key, &at, "expected a table"))?;
        if let ["model", "providers", provider] = names.as_slice() {
            if provider.is_empty()
                || !provider
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            {
                return Err(error(
                    Kind::InvalidValue,
                    "model.providers",
                    &at,
                    "provider IDs must use ASCII letters, digits, underscore or hyphen",
                ));
            }
            layer.providers.insert((*provider).into());
        }
        for (name, value) in values.iter() {
            parts.push(name.into());
            walk(value, parts, path, text, layer)?;
            parts.pop();
        }
        return Ok(());
    }
    if matches!(names.as_slice(), ["permissions", "allow" | "ask" | "deny"]) {
        let rules = item.as_array().and_then(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        });
        let rules = rules.ok_or_else(|| {
            error(
                Kind::InvalidValue,
                &key,
                &at,
                "expected an array of tool names",
            )
        })?;
        layer.values.insert(
            key,
            Entry {
                value: serde_json::to_string(&rules).unwrap(),
                source: at,
            },
        );
        return Ok(());
    }
    let numeric = matches!(
        names.as_slice(),
        ["schema_version"]
            | [
                "goals",
                "max_turns" | "max_active_seconds" | "max_unreported_turns" | "turn_model_rounds"
            ]
            | [
                "limits",
                "model_concurrency"
                    | "max_threads"
                    | "max_active_turns"
                    | "max_children_per_turn"
                    | "max_agent_depth"
                    | "turn_timeout_seconds"
                    | "stream_idle_timeout_seconds"
                    | "max_history_bytes"
                    | "max_output_bytes"
                    | "max_tool_calls"
                    | "max_tool_buffer_bytes"
                    | "context_window_bytes"
                    | "context_window_tokens"
                    | "context_output_reserve_tokens"
                    | "context_recent_bytes"
                    | "max_completion_retries"
            ]
            | ["model", "max_output_tokens" | "max_retries" | "top_k"]
    );
    let string = matches!(
        names.as_slice(),
        ["server", "listen" | "data_dir"]
            | [
                "model",
                "provider" | "name" | "reasoning_effort" | "reasoning_summary"
            ]
            | [
                "model",
                "providers",
                _,
                "endpoint" | "protocol" | "api_key_env"
            ]
            | ["logging", "filter"]
            | ["tools", "extensions_file"]
            | ["permissions", "mode"]
    );
    let decimal = matches!(
        names.as_slice(),
        [
            "model",
            "temperature" | "top_p" | "min_p" | "presence_penalty" | "repetition_penalty"
        ]
    );
    let boolean = matches!(
        names.as_slice(),
        ["limits", "watchdog_disable" | "context_compaction_enabled"]
    );
    if !numeric && !string && !decimal && !boolean {
        return Err(error(
            Kind::UnknownField,
            &key,
            &at,
            "unknown configuration field",
        ));
    }
    let value = if boolean {
        item.as_bool().map(|v| v.to_string())
    } else if decimal {
        item.as_float()
            .or_else(|| item.as_integer().map(|v| v as f64))
            .map(|v| v.to_string())
    } else if numeric {
        item.as_integer().map(|v| v.to_string())
    } else {
        item.as_str().map(str::to_owned)
    }
    .ok_or_else(|| {
        error(
            Kind::InvalidValue,
            &key,
            &at,
            if boolean {
                "expected a boolean"
            } else if decimal {
                "expected a number"
            } else if numeric {
                "expected an integer"
            } else {
                "expected a string"
            },
        )
    })?;
    layer.values.insert(key, Entry { value, source: at });
    Ok(())
}
