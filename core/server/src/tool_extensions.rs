use anyhow::{Context, Result, ensure};
use areal_config::tool_presentation::ToolPresentation;
use areal_engine::tools::ToolExtensions;
use std::{io::Read, path::Path};

pub fn load(path: Option<&Path>, presentation: &ToolPresentation) -> Result<ToolExtensions> {
    let Some(path) = path else {
        return Ok(ToolExtensions {
            presentation: presentation.clone(),
            ..Default::default()
        });
    };
    ensure!(
        std::fs::metadata(path)
            .context("cannot access tool extensions file")?
            .is_file(),
        "tool extensions must be a regular file"
    );
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1024 * 1024, "tool extensions exceed 1 MiB");
    let mut extensions: ToolExtensions =
        serde_json::from_slice(&bytes).context("invalid tool extensions JSON")?;
    let mut presentation = presentation.clone();
    if presentation.profile.is_none() && !presentation.defaults.is_empty() {
        // serde 的默认值不能区分未指定与显式 false；只查看原有呈现字段的存在性。
        let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
        if raw["policy"].as_object().is_some_and(|p| {
            [
                "compactTools",
                "programmaticTools",
                "programmaticToolsOnly",
                "programmaticDirectTools",
            ]
            .iter()
            .any(|key| p.contains_key(*key))
        }) {
            presentation.defaults.clear();
        }
    }
    extensions.presentation = presentation;
    extensions.validate()?;
    Ok(extensions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_extension_menu_wins_over_rules_but_other_extension_settings_do_not() {
        let mut presentation: ToolPresentation = serde_json::from_value(json!({
            "scene":"coding","defaults":[{"scene":"coding","model":"test","provider":"arena","protocol":"responses","profile":"compact-3"}]
        })).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("extensions.json");
        for (policy, preserved_rules) in [
            (json!({"compactTools":false}), false),
            (json!({"programmaticToolsOnly":false}), false),
            (json!({"programmaticDirectTools":[]}), false),
            (json!({"programmaticTools":false}), false),
            (json!({"parallelReadCalls":2}), true),
        ] {
            let contents = json!({"policy":policy,"hooks":[],"mcpServers":{}, "tools":[]});
            std::fs::write(&path, contents.to_string()).unwrap();
            let parsed = load(Some(&path), &presentation).unwrap();
            assert_eq!(!parsed.presentation.defaults.is_empty(), preserved_rules);
            assert_eq!(
                parsed.policy.parallel_read_calls,
                if policy["parallelReadCalls"] == 2 {
                    2
                } else {
                    1
                }
            );
        }
        std::fs::write(
            &path,
            r#"{"policy":{"programmaticTools":false,"parallelReadCalls":3}}"#,
        )
        .unwrap();
        presentation.profile = Some("compact-3".into());
        assert!(load(Some(&path), &presentation).is_err());
        presentation.profile = Some("wide".into());
        let parsed = load(Some(&path), &presentation).unwrap();
        assert!(!parsed.policy.programmatic_tools);
        assert_eq!(parsed.policy.parallel_read_calls, 3);
        assert_eq!(parsed.presentation.profile.as_deref(), Some("wide"));
    }
}
