use areal_config::*;
use std::{ffi::OsString, fs, path::Path};

fn inputs(root: &Path) -> ConfigInputs {
    ConfigInputs {
        cwd: root.into(),
        homedir: Some(root.into()),
        overrides: ConfigOverrides {
            model: Some("fixture".into()),
            model_endpoint: Some("http://127.0.0.1:9/v1/chat/completions".into()),
            ..Default::default()
        },
        ..Default::default()
    }
}
fn set(i: &mut ConfigInputs, name: &str, value: &str) {
    i.env.insert(name.into(), value.into());
}
fn write(i: &mut ConfigInputs, text: &str) {
    let path = i.cwd.join("config.toml");
    fs::write(&path, text).unwrap();
    i.config_file = Some(path);
}
fn failure(i: &ConfigInputs) -> ConfigError {
    match load_config(i) {
        Ok(_) => panic!("configuration unexpectedly accepted"),
        Err(e) => e,
    }
}

#[test]
fn temperature_validates_numbers_and_environment_precedence() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    for value in ["1", "0.7"] {
        write(
            &mut i,
            &format!("schema_version=1\n[model]\ntemperature={value}\n"),
        );
        assert_eq!(
            load_config(&i).unwrap().model.temperature,
            Some(value.parse().unwrap())
        );
    }
    set(&mut i, "AREAL_HARNESS_TEMPERATURE", "1.5");
    assert_eq!(load_config(&i).unwrap().model.temperature, Some(1.5));
    for value in ["NaN", "inf", "-0.1", "2.1", "bad"] {
        set(&mut i, "AREAL_HARNESS_TEMPERATURE", value);
        assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
    }
}

#[test]
fn sampling_parameters_validate_ranges_preserve_zero_and_report_overrides() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    let empty = load_config(&i).unwrap().diagnostic(false);
    for field in [
        "top_p",
        "top_k",
        "min_p",
        "presence_penalty",
        "repetition_penalty",
    ] {
        assert!(empty["model"][field].is_null());
    }
    write(
        &mut i,
        "schema_version=1\n[model]\nreasoning_effort='xhigh'\ntemperature=1.0\ntop_p=0.95\ntop_k=20\nmin_p=0.0\npresence_penalty=0.0\nrepetition_penalty=1.0\n",
    );
    let resolved = load_config(&i).unwrap().diagnostic(false);
    for (field, value) in [
        ("top_p", 0.95),
        ("min_p", 0.0),
        ("presence_penalty", 0.0),
        ("repetition_penalty", 1.0),
    ] {
        assert_eq!(resolved["model"][field], value);
    }
    assert_eq!(resolved["model"]["top_k"], 20);
    for (field, valid, invalid) in [
        ("top_p", "0", "1.01"),
        ("min_p", "1", "-0.1"),
        ("presence_penalty", "-2", "2.1"),
        ("repetition_penalty", "0.5", "0"),
        ("top_k", "-1", "0"),
    ] {
        let env_name = format!("AREAL_HARNESS_{}", field.to_uppercase());
        set(&mut i, &env_name, valid);
        let resolved = load_config(&i).unwrap();
        assert!(
            matches!(&resolved.sources[&format!("model.{field}")], ConfigSource::Env { name } if name == &env_name)
        );
        assert_eq!(
            resolved.diagnostic(false)["model"][field].as_f64(),
            Some(valid.parse().unwrap())
        );
        for bad in [invalid, "nan", "inf", "bad"] {
            set(&mut i, &env_name, bad);
            assert_eq!(failure(&i).field, format!("model.{field}"));
        }
        i.env.remove(std::ffi::OsStr::new(&env_name));
    }
    for field in ["top_k", "min_p", "presence_penalty", "repetition_penalty"] {
        write(&mut i, &format!("schema_version=1\n[model]\n{field}=1\n"));
        set(&mut i, "AREAL_HARNESS_MODEL_PROTOCOL", "responses");
        assert_eq!(failure(&i).kind, ConfigErrorKind::Conflict);
    }
    write(&mut i, "schema_version=1\n[model]\ntop_p=0.95\n");
    assert_eq!(load_config(&i).unwrap().model.top_p, Some(0.95));
}

#[test]
fn model_and_execution_budgets_are_validated_and_preserve_sources() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    write(
        &mut i,
        "schema_version=1\n[model]\nreasoning_effort='xhigh'\nmax_output_tokens=8192\nmax_retries=0\n[limits]\nturn_timeout_seconds=1800\nstream_idle_timeout_seconds=90\nmax_history_bytes=16777216\nmax_output_bytes=4194304\nmax_tool_calls=512\n",
    );
    let c = load_config(&i).unwrap();
    assert_eq!(c.model.reasoning_effort.as_deref(), Some("xhigh"));
    assert_eq!(c.model.max_output_tokens, Some(8192));
    assert_eq!(c.model.max_retries, 0);
    assert_eq!(c.turn_timeout_seconds, 1800);
    assert_eq!(c.stream_idle_timeout_seconds, 90);
    assert_eq!(c.max_history_bytes, 16777216);
    assert_eq!(c.max_output_bytes, 4194304);
    assert_eq!(c.max_tool_calls, 512);
    assert_eq!(c.context_window_bytes, 196608);
    assert_eq!(c.context_recent_bytes, 65536);
    set(&mut i, "AREAL_HARNESS_REASONING_EFFORT", "high");
    assert_eq!(
        load_config(&i).unwrap().model.reasoning_effort.as_deref(),
        Some("high")
    );
    for (name, value) in [
        ("AREAL_HARNESS_MODEL_MAX_RETRIES", "9"),
        ("AREAL_HARNESS_TURN_TIMEOUT_SECONDS", "0"),
        ("AREAL_HARNESS_STREAM_IDLE_TIMEOUT_SECONDS", "86401"),
        ("AREAL_HARNESS_MAX_TOOL_CALLS", "0"),
        ("AREAL_HARNESS_CONTEXT_RECENT_BYTES", "196608"),
        ("AREAL_HARNESS_CONTEXT_WINDOW_BYTES", "0"),
        ("AREAL_HARNESS_REASONING_EFFORT", "typo"),
    ] {
        let previous = i.env.insert(name.into(), value.into());
        assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue, "{name}");
        i.env.remove(std::ffi::OsStr::new(name));
        if let Some(previous) = previous {
            i.env.insert(name.into(), previous);
        }
    }
}

#[test]
fn defaults_and_home_do_not_create_files_or_read_project_config() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    fs::create_dir(temp.path().join(".areal-harness")).unwrap();
    fs::write(temp.path().join(".areal-harness/config.toml"), "broken").unwrap();
    let other = temp.path().join("separate");
    set(&mut i, "AREAL_HARNESS_HOME", other.to_str().unwrap());
    let c = load_config(&i).unwrap();
    assert_eq!(c.data_dir, other.join("state"));
    assert_eq!(c.model_concurrency, 32);
    assert!(c.config_file.is_none());
    assert!(!other.exists());
    i.homedir = None;
    i.env.clear();
    assert_eq!(failure(&i).kind, ConfigErrorKind::MissingValue);
    set(&mut i, "AREAL_HARNESS_HOME", "relative");
    assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
}

#[test]
fn file_selection_paths_and_precedence_keep_each_source() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    let dir = temp.path().join("configs");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("user.toml"), "schema_version = 1\n[server]\ndata_dir = 'data'\n[model]\nname = 'file'\n[limits]\nmodel_concurrency = 7\n").unwrap();
    set(&mut i, "AREAL_HARNESS_CONFIG", "missing.toml");
    i.config_file = Some("configs/user.toml".into());
    i.overrides.model = None;
    let c = load_config(&i).unwrap();
    assert_eq!(c.data_dir, dir.join("data"));
    assert_eq!(c.model.name, "file");
    assert!(matches!(
        c.sources["server.data_dir"],
        ConfigSource::File {
            line: 3,
            column: 12,
            ..
        }
    ));
    set(&mut i, "AREAL_MODEL", "old");
    set(&mut i, "AREAL_HARNESS_MODEL", "new");
    set(&mut i, "AREAL_HARNESS_DATA_DIR", "env-data");
    set(&mut i, "AREAL_HARNESS_MODEL_CONCURRENCY", "8");
    let c = load_config(&i).unwrap();
    assert_eq!(c.model.name, "new");
    assert_eq!(c.data_dir, temp.path().join("env-data"));
    assert_eq!(c.model_concurrency, 8);
    assert_eq!(c.warnings.len(), 1);
    i.overrides.model = Some("cli".into());
    i.overrides.model_concurrency = Some("9".into());
    let c = load_config(&i).unwrap();
    assert_eq!(c.model.name, "cli");
    assert_eq!(c.model_concurrency, 9);
    assert!(matches!(c.sources["model.name"], ConfigSource::Cli { .. }));
}

#[test]
fn providers_are_selected_before_overrides_and_never_borrow_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    write(
        &mut i,
        "schema_version=1\n[model]\nprovider='a'\n[model.providers.a]\nendpoint='http://localhost/a'\napi_key_env='SECRET_A'\n[model.providers.b]\nendpoint='http://localhost/b'\nprotocol='responses'\n",
    );
    i.overrides.model_endpoint = None;
    set(&mut i, "AREAL_HARNESS_MODEL_PROVIDER", "b");
    set(&mut i, "AREAL_API_KEY", "old-secret");
    let c = load_config(&i).unwrap();
    assert_eq!(c.model.endpoint, "http://localhost/b");
    assert!(c.credential(&i).unwrap().is_none());
    assert_eq!(c.model.protocol, ModelProtocolConfig::Responses);
    set(&mut i, "AREAL_HARNESS_MODEL_PROVIDER", "a");
    assert_eq!(failure(&i).kind, ConfigErrorKind::MissingValue);
    set(&mut i, "SECRET_A", "secret-a");
    let c = load_config(&i).unwrap();
    assert_eq!(c.credential(&i).unwrap().as_deref(), Some("secret-a"));
    set(
        &mut i,
        "AREAL_HARNESS_MODEL_ENDPOINT",
        "http://localhost/override",
    );
    assert_eq!(
        load_config(&i).unwrap().model.endpoint,
        "http://localhost/override"
    );
    set(&mut i, "AREAL_HARNESS_MODEL_PROVIDER", "missing");
    i.env
        .remove(&OsString::from("AREAL_HARNESS_MODEL_ENDPOINT"));
    assert_eq!(failure(&i).kind, ConfigErrorKind::MissingValue);
}

#[test]
fn legacy_auth_is_optional_but_explicit_references_are_required_and_redacted() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    assert!(load_config(&i).unwrap().credential(&i).unwrap().is_none());
    set(&mut i, "AREAL_API_KEY", "secret-value");
    let c = load_config(&i).unwrap();
    assert_eq!(c.credential(&i).unwrap().as_deref(), Some("secret-value"));
    assert!(!c.diagnostic(true).to_string().contains("secret-value"));
    i.overrides.api_key_env = Some("MISSING".into());
    assert!(failure(&i).to_string().contains("MISSING"));
    set(&mut i, "MISSING", "");
    assert_eq!(failure(&i).kind, ConfigErrorKind::MissingValue);
    set(&mut i, "MISSING", "secret\ninjected");
    assert!(!failure(&i).to_string().contains("secret"));
    i.overrides.api_key_env = None;
    write(
        &mut i,
        "schema_version=1\n[model.providers.default]\nendpoint='http://localhost/anonymous'\n",
    );
    assert!(load_config(&i).unwrap().credential(&i).unwrap().is_none());
}

#[test]
fn malformed_layers_fail_even_when_overridden_without_echoing_values() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    for (text, kind) in [
        ("schema_version=1\nschema_version=1", ConfigErrorKind::Parse),
        ("[model]\nname='x'", ConfigErrorKind::MissingValue),
        ("schema_version=2", ConfigErrorKind::UnsupportedVersion),
        ("schema_version='1'", ConfigErrorKind::InvalidValue),
        (
            "schema_version=1\n[model]\nendpoint='secret'",
            ConfigErrorKind::UnknownField,
        ),
        (
            "schema_version=1\n[model]\nname=3",
            ConfigErrorKind::InvalidValue,
        ),
        (
            "schema_version=1\n[model.providers.p]\nprotocol='secret'",
            ConfigErrorKind::InvalidValue,
        ),
        (
            "schema_version=1\n[model.providers.p]\nendpoint='https://user:secret@host/'",
            ConfigErrorKind::InvalidValue,
        ),
        (
            "schema_version=1\n[limits]\nmax_threads=0",
            ConfigErrorKind::InvalidValue,
        ),
        (
            "schema_version=1\n[server]\nlisten='0.0.0.0:4500'",
            ConfigErrorKind::InvalidValue,
        ),
    ] {
        write(&mut i, text);
        let e = failure(&i);
        assert_eq!(e.kind, kind, "{e}");
        assert!(!format!("{e:?}").contains("secret"));
    }
    write(&mut i, "schema_version=1");
    for value in ["", "0", "-1", "3.1", " 7", "1e3", "18446744073709551615"] {
        set(&mut i, "AREAL_HARNESS_MAX_THREADS", value);
        assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
    }
    i.env.clear();
    set(&mut i, "AREAL_HARNESS_MODLE", "secret");
    assert_eq!(failure(&i).kind, ConfigErrorKind::UnknownField);
    i.env.clear();
    set(&mut i, "AREAL_MODEL", "");
    assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
}

#[test]
fn diagnostics_remove_query_and_credential_while_preserving_file_location() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    write(
        &mut i,
        "schema_version=1\n[model]\nname='测试'\n[model.providers.default]\nendpoint='http://localhost/path?token=hidden'\napi_key_env='KEY'\n",
    );
    i.overrides.model_endpoint = None;
    set(&mut i, "KEY", "secret");
    let c = load_config(&i).unwrap();
    let out = c.diagnostic(true).to_string();
    assert!(!out.contains("hidden"));
    assert!(!out.contains("secret"));
    assert!(out.contains("http://localhost/path"));
    assert!(out.contains("KEY"));
    assert!(matches!(
        c.sources["model.providers.default.endpoint"],
        ConfigSource::File { line: 5, .. }
    ));
}

#[cfg(unix)]
#[test]
fn file_symlink_base_and_non_utf8_environment_are_explicit() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    fs::create_dir(temp.path().join("real")).unwrap();
    fs::write(
        temp.path().join("real/file.toml"),
        "schema_version=1\n[server]\ndata_dir='state'\n",
    )
    .unwrap();
    symlink(
        temp.path().join("real/file.toml"),
        temp.path().join("link.toml"),
    )
    .unwrap();
    i.config_file = Some("link.toml".into());
    assert_eq!(load_config(&i).unwrap().data_dir, temp.path().join("state"));
    i.env
        .insert("AREAL_HARNESS_MODEL".into(), OsString::from_vec(vec![255]));
    assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
    i.env.clear();
    i.config_file = Some(temp.path().join("missing"));
    assert_eq!(failure(&i).kind, ConfigErrorKind::Io);
    i.config_file = Some(temp.path().into());
    assert_eq!(failure(&i).kind, ConfigErrorKind::Io);
}

#[test]
fn default_file_is_loaded_and_shipped_example_resolves() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    let home = temp.path().join(".areal-harness");
    fs::create_dir(&home).unwrap();
    fs::write(
        home.join("config.toml"),
        "schema_version=1\n[model]\nname='from-home'\n",
    )
    .unwrap();
    i.overrides.model = None;
    assert_eq!(load_config(&i).unwrap().model.name, "from-home");
    fs::write(home.join("config.toml"), "broken TOML").unwrap();
    assert_eq!(failure(&i).kind, ConfigErrorKind::Parse);
    i.config_file = Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/config.toml"));
    i.overrides = ConfigOverrides::default();
    set(&mut i, "COMPANY_MODEL_API_KEY", "fixture-secret");
    let c = load_config(&i).unwrap();
    assert_eq!(c.model.provider, "company");
    assert_eq!(c.model.name, "your-model-id");
    assert_eq!(c.data_dir, home.join("state"));
}

#[cfg(unix)]
#[test]
fn unreadable_default_file_is_not_treated_as_missing() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let i = inputs(temp.path());
    let home = temp.path().join(".areal-harness");
    fs::create_dir(&home).unwrap();
    let path = home.join("config.toml");
    fs::write(&path, "schema_version=1").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    // Root can read mode-000 files; do not claim to exercise EACCES there.
    if fs::File::open(&path).is_err() {
        assert_eq!(failure(&i).kind, ConfigErrorKind::Io);
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn agent_limits_follow_precedence_and_validate_independently() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    write(
        &mut i,
        "schema_version=1\n[limits]\nmax_active_turns=12\nmax_children_per_turn=3\nmax_agent_depth=2\n",
    );
    let c = load_config(&i).unwrap();
    assert_eq!(
        (
            c.max_active_turns,
            c.max_children_per_turn,
            c.max_agent_depth
        ),
        (12, 3, 2)
    );
    set(&mut i, "AREAL_HARNESS_MAX_ACTIVE_TURNS", "7");
    set(&mut i, "AREAL_HARNESS_MAX_CHILDREN_PER_TURN", "0");
    set(&mut i, "AREAL_HARNESS_MAX_AGENT_DEPTH", "0");
    let c = load_config(&i).unwrap();
    assert_eq!(
        (
            c.max_active_turns,
            c.max_children_per_turn,
            c.max_agent_depth
        ),
        (7, 0, 0)
    );
    i.overrides.max_active_turns = Some("5".into());
    i.overrides.max_children_per_turn = Some("4".into());
    i.overrides.max_agent_depth = Some("1".into());
    let c = load_config(&i).unwrap();
    assert_eq!(
        (
            c.max_active_turns,
            c.max_children_per_turn,
            c.max_agent_depth
        ),
        (5, 4, 1)
    );
    assert_eq!(c.diagnostic(false)["limits"]["max_active_turns"], 5);
    for invalid in ["0", "-1", "1.5", "18446744073709551615"] {
        i.overrides.max_active_turns = Some(invalid.into());
        assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
    }
}

#[test]
fn tool_extensions_path_is_explicit_and_relative_to_its_config_source() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    assert!(load_config(&i).unwrap().tool_extensions_file.is_none());
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).unwrap();
    let config = config_dir.join("settings.toml");
    fs::write(
        &config,
        "schema_version=1\n[tools]\nextensions_file='tools.json'\n",
    )
    .unwrap();
    i.config_file = Some(config);
    assert_eq!(
        load_config(&i).unwrap().tool_extensions_file,
        Some(config_dir.join("tools.json"))
    );
    set(&mut i, "AREAL_HARNESS_TOOL_EXTENSIONS", "other.json");
    let c = load_config(&i).unwrap();
    assert_eq!(c.tool_extensions_file, Some(temp.path().join("other.json")));
    assert_eq!(
        c.sources["tools.extensions_file"],
        ConfigSource::Env {
            name: "AREAL_HARNESS_TOOL_EXTENSIONS".into()
        }
    );
}

#[test]
fn token_window_reserve_is_validated_and_env_can_override() {
    let temp = tempfile::tempdir().unwrap();
    let mut i = inputs(temp.path());
    write(
        &mut i,
        "schema_version=1\n[limits]\ncontext_window_tokens=200000\ncontext_output_reserve_tokens=40000\n",
    );
    let c = load_config(&i).unwrap();
    assert_eq!(c.context_window_tokens, 200000);
    set(
        &mut i,
        "AREAL_HARNESS_CONTEXT_OUTPUT_RESERVE_TOKENS",
        "200000",
    );
    assert_eq!(failure(&i).kind, ConfigErrorKind::InvalidValue);
}
