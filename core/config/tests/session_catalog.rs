use areal_config::{ConfigInputs, ConfigOverrides, ConfigSource, SessionCatalog, load_config};

fn inputs(root: &std::path::Path) -> ConfigInputs {
    ConfigInputs {
        cwd: root.into(),
        homedir: Some(root.into()),
        overrides: ConfigOverrides {
            model: Some("fixture".into()),
            model_endpoint: Some("http://127.0.0.1:9".into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn catalog_is_explicit_validated_and_part_of_deployment_configuration() {
    let root = tempfile::tempdir().unwrap();
    let mut input = inputs(root.path());
    let defaults = load_config(&input).unwrap();
    assert_eq!(defaults.session_catalog, SessionCatalog::Memory);
    assert_eq!(
        defaults.diagnostic(false)["storage"]["session_catalog"],
        "memory"
    );
    for schema in [1, 2] {
        let path = root.path().join("config.toml");
        std::fs::write(
            &path,
            format!("schema_version={schema}\n[storage]\nsession_catalog='sqlite'\n"),
        )
        .unwrap();
        input.config_file = Some(path);
        let config = load_config(&input).unwrap();
        assert_eq!(config.session_catalog, SessionCatalog::Sqlite);
        assert_ne!(
            config.diagnostic(false)["storage"],
            defaults.diagnostic(false)["storage"]
        );
        assert!(matches!(
            config.sources["storage.session_catalog"],
            ConfigSource::File { .. }
        ));
    }
    for (name, expected) in [
        ("memory-lazy", SessionCatalog::MemoryLazy),
        ("sqlite-lazy", SessionCatalog::SqliteLazy),
    ] {
        input
            .env
            .insert("AREAL_HARNESS_SESSION_CATALOG".into(), name.into());
        let config = load_config(&input).unwrap();
        assert_eq!(config.session_catalog, expected);
        assert_eq!(config.diagnostic(false)["storage"]["session_catalog"], name);
    }
    input
        .env
        .insert("AREAL_HARNESS_SESSION_CATALOG".into(), "memory".into());
    assert_eq!(
        load_config(&input).unwrap().session_catalog,
        SessionCatalog::Memory
    );
    input.env.insert(
        "AREAL_HARNESS_SESSION_CATALOG".into(),
        "invalid-private-value".into(),
    );
    let error = load_config(&input).err().unwrap();
    assert_eq!(error.field, "storage.session_catalog");
    assert!(!error.to_string().contains("invalid-private-value"));
}
