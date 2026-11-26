//! 只描述模型看到的本地工具；路由、权限、缓存与预算均由各自的配置负责。
use crate::{ConfigErrorKind, ConfigSource, ModelProtocolConfig, Result, error};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ToolPresentation {
    pub profile: Option<String>,
    pub scene: Option<String>,
    pub custom: BTreeMap<String, Vec<String>>,
    pub defaults: Vec<PresentationRule>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresentationRule {
    pub provider: String,
    pub model: String,
    pub protocol: ModelProtocolConfig,
    pub reasoning_effort: Option<String>,
    pub scene: String,
    pub profile: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresentationRoute<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub protocol: ModelProtocolConfig,
    pub reasoning_effort: Option<&'a str>,
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub fn valid_native_direct_tools(tools: &[String]) -> bool {
    tools.len() <= 16
        && tools.iter().collect::<BTreeSet<_>>().len() == tools.len()
        && tools.iter().all(|t| {
            !t.is_empty()
                && t.len() <= 64
                && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}

const PRESETS: [&str; 3] = ["wide", "compact-3", "compact-6"];

impl ToolPresentation {
    pub fn validate(&self, at: &ConfigSource) -> Result<()> {
        let invalid = |message| {
            error(
                ConfigErrorKind::InvalidValue,
                "tools.presentation",
                at,
                message,
            )
        };
        if self.custom.len() > 64 || self.defaults.len() > 256 {
            return Err(invalid(
                "at most 64 custom profiles and 256 presentation rules are allowed",
            ));
        }
        let known = |p: &str| PRESETS.contains(&p) || self.custom.contains_key(p);
        if self.custom.iter().any(|(id, direct)| {
            !name(id) || PRESETS.contains(&id.as_str()) || !valid_native_direct_tools(direct)
        }) {
            return Err(invalid(
                "custom profiles require a distinct non-reserved name and up to 16 unique native tool names",
            ));
        }
        if self.profile.as_deref().is_some_and(|p| !known(p))
            || self.scene.as_deref().is_some_and(|s| !name(s))
        {
            return Err(invalid("unknown presentation profile or invalid scene"));
        }
        let mut seen = BTreeSet::new();
        for rule in &self.defaults {
            if !name(&rule.provider)
                || rule.model.trim() != rule.model
                || rule.model.is_empty()
                || rule.model.len() > 256
                || rule
                    .model
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '*' | '?'))
                || !name(&rule.scene)
                || !known(&rule.profile)
                || rule.reasoning_effort.as_deref().is_some_and(|e| {
                    !matches!(
                        e,
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                    )
                })
                || !seen.insert((
                    &rule.provider,
                    &rule.model,
                    rule.protocol,
                    &rule.reasoning_effort,
                    &rule.scene,
                ))
            {
                return Err(invalid(
                    "presentation defaults require unique exact provider/model/protocol/effort/scene and a known profile",
                ));
            }
        }
        Ok(())
    }

    /// 未指定强度只匹配未指定强度。未配置场景或适配器不能证明身份时不采用模型默认。
    pub fn selected(&self, route: Option<PresentationRoute<'_>>) -> Option<&str> {
        self.profile.as_deref().or_else(|| {
            let route = route?;
            let scene = self.scene.as_deref()?;
            self.defaults
                .iter()
                .find(|rule| {
                    rule.scene == scene
                        && rule.provider == route.provider
                        && rule.model == route.model
                        && rule.protocol == route.protocol
                        && rule.reasoning_effort.as_deref() == route.reasoning_effort
                })
                .map(|rule| rule.profile.as_str())
        })
    }
}
