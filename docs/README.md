**中文** | [English](README.en.md)

# 文档

从[快速开始](guides/quickstart.md)进入。当前支持范围集中维护在[功能与边界](features.md)。所有命令默认从仓库根目录运行。

| 分类 | 文档 |
|---|---|
| 使用指南 | [快速开始](guides/quickstart.md) · [CLI、TUI 与 Web](guides/clients.md) · [配置](guides/configuration.md) · [Runtime 部署](guides/runtime.md) |
| 扩展与协作 | [工具与 hooks](guides/tools.md) · [MCP](guides/mcp.md) · [Skill](guides/skills.md) · [Workgroup](guides/workgroups.md) |
| API 契约 | [Core](api/core.md) · [桌面 API](api/desktop.md) · [Runtime](api/runtime.md) · [TypeScript SDK](api/typescript-sdk.md) · [Native Host](api/native-host.md) · [Claude CLI](api/claude-cli.md) |
| 架构设计 | [分层与目录](design/architecture.md) · [Agent 委派](design/multi-agent.md) · [Workgroup](design/workgroups.md) · [插件](design/plugins.md) · [TUI](design/tui.md) · [图表规范](design/STYLE_GUIDE.md) |
| 可运行示例 | [桌面 API 与发行验收](examples/desktop-api.md) · [DSH 编辑器](examples/dsh-editor-plugin.md) |
| 开发维护 | [开发指南](development/README.md) · [测试](development/testing.md) · [Cordis 升级](development/cordis.md) |
| 基准测试 | [运行与恢复](benchmarks/README.md) · [统计方法](benchmarks/methodology.md) · [历史报告](benchmarks/reports/README.md) |

每篇维护文档使用同目录的 `.md`（中文）和 `.en.md`（英文）配对，顶部可切换。两种语言同时更新；机器 schema、代码及共享图表只保留一份。API 参数以契约和链接的类型/schema 为准，使用指南不重复整套接口。
