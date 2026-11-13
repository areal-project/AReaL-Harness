//! 插件卡片状态只在后端算：登记层面的事实（是否安装、启用、兼容、必填配置、能否一键添加）
//! 在这里给出 state + nextAction + reason；连接与认证由项目 Core 的连接状态补充。
use crate::PluginDetail;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    /// notInstalled | disabled | blocked | configure | available
    pub state: String,
    /// install | review | enable | components | configure | none
    pub next_action: String,
    /// 机器可读原因，界面按错误码文案表展示。
    pub reason: Option<String>,
}

pub(crate) fn status(detail: &PluginDetail) -> PluginStatus {
    let result = |state: &str, next: &str, reason: Option<&str>| PluginStatus {
        state: state.into(),
        next_action: next.into(),
        reason: reason.map(str::to_owned),
    };
    if !detail.installed {
        // 已解析出包摘要的来源可一键安装；远程来源要先解析、核对后再装。
        return if detail.source_digest.is_empty() {
            result("notInstalled", "review", Some("sourceUnresolved"))
        } else {
            result("notInstalled", "install", None)
        };
    }
    if !detail.enabled {
        return result("disabled", "enable", None);
    }
    if detail
        .installed_component_support
        .as_ref()
        .is_some_and(|support| !support.allowed())
    {
        return result("blocked", "components", Some("unsupported"));
    }
    if !detail.user_configuration.missing_required.is_empty() {
        return result("configure", "configure", Some("configurationRequired"));
    }
    result("available", "none", None)
}
