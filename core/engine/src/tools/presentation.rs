//! 在已有原生授权目录上选择投影；不向 Registry 注册任何工具。
use super::{ToolExtensions, ToolPolicy};
use crate::{Engine, model::Model};
use areal_protocol::desktop::EffectiveConfig;

/// 明确的无副作用启动拒绝；可对客户端安全展示，不携带路径、命令或凭据。
#[derive(Debug, thiserror::Error)]
#[error(
    "TOOL_PRESENTATION_REQUIRES_PROGRAMMATIC_TOOLS: compact tool presentation requires enabled programmaticTools; choose wide or explicitly enable programmaticTools"
)]
pub struct DisabledProgrammaticPresentation;

pub(crate) struct ToolMenu {
    pub compact: bool,
    pub program_only: bool,
    pub direct: Vec<String>,
    /// 旧的低级策略只按常用原生目录筛选；新自定义列表也允许直达已授权的非常用本地工具。
    pub custom_direct: bool,
}

impl ToolMenu {
    fn legacy(policy: &ToolPolicy) -> Self {
        Self {
            compact: policy.compact_tools,
            program_only: policy.programmatic_tools_only,
            direct: policy.programmatic_direct_tools.clone(),
            custom_direct: false,
        }
    }
}

impl ToolExtensions {
    pub(crate) fn tool_menu(&self, model: Option<&dyn Model>) -> ToolMenu {
        if !self.policy.programmatic_tools && self.presentation.profile.is_none() {
            return ToolMenu::legacy(&self.policy);
        }
        let selected = self
            .presentation
            .selected(model.and_then(Model::presentation_route));
        let (direct, custom_direct) = match selected {
            None => return ToolMenu::legacy(&self.policy),
            Some("wide") => {
                return ToolMenu {
                    compact: false,
                    program_only: false,
                    direct: Vec::new(),
                    custom_direct: false,
                };
            }
            Some("compact-3") => (vec!["edit_files".into()], false),
            Some("compact-6") => (
                ["edit_files", "read_file", "run_command", "image_read"]
                    .map(str::to_owned)
                    .into(),
                false,
            ),
            Some(custom) => (self.presentation.custom[custom].clone(), true),
        };
        ToolMenu {
            compact: true,
            program_only: true,
            direct,
            custom_direct,
        }
    }
}

impl Engine {
    /// 非模型调用路径（如预览与子会话授权）只在确有待匹配的规则时解析模型。
    /// 真实请求始终从正在执行该 Turn 的不可变适配器取得身份。
    pub(crate) fn configuration_tool_menu(&self, config: &EffectiveConfig) -> ToolMenu {
        let p = &self.extensions.presentation;
        let model = (p.profile.is_none() && p.scene.is_some() && !p.defaults.is_empty())
            .then(|| self.configured_model(config).ok())
            .flatten();
        self.extensions.tool_menu(model.as_deref())
    }
}
