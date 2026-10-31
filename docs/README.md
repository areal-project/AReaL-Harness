**中文** | [English](README.en.md)

# 文档

从[快速开始](guides/quickstart.md)进入。当前支持范围集中维护在[功能与边界](features.md)。所有命令默认从仓库根目录运行。

[产品术语](../GLOSSARY.md) · [桌面端迁移决策（待实施）](adr/0001-desktop-client-module.md)

[普通会话暂停与继续](adr/0014-conversation-pause-and-continue.md) · [定时消息的会话目标（设计中）](adr/0015-scheduled-conversation-target.md)

| 分类 | 文档 |
|---|---|
| 使用指南 | [快速开始](guides/quickstart.md) · [CLI、TUI 与 Web](guides/clients.md) · [配置](guides/configuration.md) · [Runtime 部署](guides/runtime.md) · [桌面 Worktree](guides/worktrees.md) |
| 扩展与协作 | [工具与 hooks](guides/tools.md) · [MCP](guides/mcp.md) · [Skill](guides/skills.md) · [Workgroup](guides/workgroups.md) |
| API 契约 | [Core](api/core.md) · [桌面 API](api/desktop.md) · [Task Mode 与频道](api/tasks.md) · [Browser](api/browser.md) · [电脑控制](api/computer.md) · [Runtime](api/runtime.md) · [TypeScript SDK](api/typescript-sdk.md) · [Native Host](api/native-host.md) · [Claude CLI](api/claude-cli.md) · [本地服务](api/local-service.md) |
| 架构设计 | [分层与目录](design/architecture.md) · [上下文管理](design/context-management.md) · [Agent 委派](design/multi-agent.md) · [Workgroup](design/workgroups.md) · [插件](design/plugins.md) · [TUI](design/tui.md) · [图表规范](design/STYLE_GUIDE.md) |
| 可运行示例 | [桌面 API 与发行验收](examples/desktop-api.md) · [DSH 编辑器](examples/dsh-editor-plugin.md) |
| 开发维护 | [开发指南](development/README.md) · [Agent 改进目标与方法](development/agent-improvement.md) · [测试](development/testing.md) · [Cordis 升级](development/cordis.md) |
| 基准测试 | [运行与恢复](benchmarks/README.md) · [统计方法](benchmarks/methodology.md) · [历史报告](benchmarks/reports/README.md) · [复杂协作修复与复测](benchmarks/reports/complex-workflow-repair.md) · [收尾结果消费修复](benchmarks/reports/child-result-consumption.md) · [原生工具优化实测](benchmarks/reports/tool-optimization.md) · [委派权限与验证](benchmarks/reports/inspection-permissions-v2.md) |

每篇维护文档使用同目录的 `.md`（中文）和 `.en.md`（英文）配对，顶部可切换。两种语言同时更新；机器 schema、代码及共享图表只保留一份。API 参数以契约和链接的类型/schema 为准，使用指南不重复整套接口。

- [安装与升级](guides/installation.md) · [发行流程](development/releasing.md)

Remote v2 设计与实施边界：[架构](design/remote-control.md) · [API](api/remote-control.md) · [连接与部署](guides/remote-control.md) · [验收计划](development/remote-control-testing.md) · [Host 所有权](adr/0008-remote-host-ownership.md) · [iOS v1 实施规格](development/ios-remote-v1-spec.md)。各专题区分已实现的切片与后续设计，不代表完整 P0 已交付。

客户端 UI 实现与设计约束：[设计规则 v1](../clients/gui/design-system/README.md) · [@areal/ui 组件与 Token](../clients/gui/packages/ui/README.md)。

- [回答评价](guides/user-feedback.md)
