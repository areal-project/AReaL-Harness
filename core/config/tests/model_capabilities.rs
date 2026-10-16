use areal_config::{ConfigInputs, load_config, models};
use std::fs;

#[test]
fn shared_model_capabilities_round_trip_and_reject_unknown_efforts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("config.toml");
    fs::write(&path, r#"schema_version=1
[model]
catalog_version=1
provider="fixture"
name="sol"
[model.providers.fixture]
name="Fixture"
protocol="responses"
endpoint="http://127.0.0.1:9/responses"
models=[{id="sol", reasoning_effort_options=["low","medium","high","xhigh","max","ultra"], default_reasoning_effort="low", parameters={reasoning_effort="max"}}]
"#).unwrap();
    let inputs = ConfigInputs {
        cwd: root.path().into(),
        homedir: Some(root.path().into()),
        config_file: Some(path.clone()),
        ..Default::default()
    };
    load_config(&inputs).unwrap();
    let current = models::read(&inputs, &[]).unwrap();
    assert_eq!(
        current.data[0].models[0]
            .reasoning_effort_options
            .as_ref()
            .unwrap()
            .last()
            .map(String::as_str),
        Some("ultra")
    );
    let expected = current.data.clone();
    models::write(&inputs, serde_json::from_value(serde_json::json!({"expectedRevision":current.revision,"data":current.data,"defaultModel":current.default_model})).unwrap(), &[]).unwrap();
    assert_eq!(models::read(&inputs, &[]).unwrap().data, expected);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("reasoning_effort_options"));
    fs::write(&path, text.replace("ultra", "future_effort")).unwrap();
    assert!(load_config(&inputs).is_err());
}
