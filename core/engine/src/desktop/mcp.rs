//! 回合可用的 MCP 工具：部署声明的服务与已启用插件的服务。用户直接添加的 MCP 也是插件。
use super::*;
impl Engine {
    pub(crate) fn managed_registry(
        &self,
        thread: &Thread,
        research: bool,
    ) -> anyhow::Result<crate::tools::Registry> {
        let config = desktop(thread).configuration;
        let tools = if !thread.is_read_only_side()
            && !research
            && config.allow_plugin_skills
            && !config.read_only
        {
            self.desktop.plugin_mcp.tools()
        } else {
            Vec::new()
        };
        let mut registry = self.registry.clone();
        // 报告能力只接入可信隔离 worker；禁用委派的普通 Engine 保留外部同名工具兼容。
        if (self
            .desktop
            .worker_model
            .load(std::sync::atomic::Ordering::Acquire)
            || thread.source == "workgroupWorker")
            && registry.get("agent_report").is_err()
        {
            registry = registry.with_agents(false, true)?;
        }
        let registry = registry
            .with_mcp(tools)?
            .with_dynamic(&thread.dynamic_tools)?;
        let registry = if !thread.is_read_only_side()
            && !research
            && config.allow_plugin_skills
            && !config.read_only
        {
            self.page_registry(registry, thread)?
        } else {
            registry
        };
        Ok(if thread.is_read_only_side() {
            registry.side_only(thread.side_workspace_read())
        } else if research {
            registry.research_only()
        } else {
            registry
        })
    }
}
