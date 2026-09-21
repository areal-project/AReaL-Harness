**中文** | [English](features.en.md)

# 当前能力与边界

本页描述已实现范围；构建通过、机制测试和真实任务收益分别验证。架构见[分层设计](design/architecture.md)。

| 能力 | 实现与入口 |
|---|---|
| 会话与模型 | 持久 Thread/Turn、流式事件、追加输入、取消、恢复；Chat Completions / Responses，模态取决于 adapter 和模型。[客户端](guides/clients.md) |
| 文件与进程 | 条件文件写入、命令、stdin、PTY、有界输出、Scope 权限收窄及清理。[Runtime](api/runtime.md) |
| 工具扩展 | 命令工具、hooks、客户端动态工具、MCP stdio/Streamable HTTP、可信 Node 插件 Host。[工具](guides/tools.md) |
| 多 Agent | 默认模型委派、独立历史、共享工作区、阶段报告和结果汇总。[Agent 设计](design/multi-agent.md) |
| Workgroup | DAG、隔离写工作区、制品检查与集成，fixed/auto/adaptive 准入；CLI 和服务接口。[使用指南](guides/workgroups.md) |
| 桌面接口 | 认证、Profile/Skill/Plan、审批/追问、提交去重与队列、共享终端、配置 CAS、模型切换、媒体 Blob、归档与 GC。[桌面 API](api/desktop.md) |
| 客户端 | CLI、TUI、本地 Web；CLI 实现选定 Claude Code 非交互参数与消息。[CLI 契约](api/claude-cli.md) |
| Skills | 自动发现与显式 Profile 共用元信息登记、正文/附件按需读取；单个无效全局 Skill 告警隔离，不创建内容快照。[Skill 指南](guides/skills.md) |
| SDK | 仓库内私有 `@areal/runtime` 和 `@areal/plugins`，Node.js 22.19.0+。[SDK 契约](api/typescript-sdk.md) |
| 观测与验证 | tracing、可选 OTLP；确定性模型回归、原生 smoke、Docker lite/pro 评测。[测试](development/testing.md) |

## 支持边界

- 完整本地工具执行使用 macOS Seatbelt；Linux 仅有受控 Docker `outer-container-perf` profile。通用生产 Linux 和 Windows native Runtime 未提供。
- Core、stdio MCP 和插件 Host 是可信宿主，未受 Runtime OS 沙箱隔离；远程工具权限由服务负责。审批不能扩大部署授权。
- `UNKNOWN` 需要人工检查，不自动重放。没有跨 Runtime epoch 恢复、外部写入者 CAS、跨文件事务或完整逃逸后代树清理保证。
- Codex app-server 固定子集和 Claude CLI 消息适配不代表官方完整客户端兼容。DSH 仅适配选定工具/文件服务；不支持替换 Core loop。
- Workgroup 最多 64 个任务、32 个 Worker；CLI 默认 `balanced + fixed`、2 个 Worker。更宽或 adaptive 不保证更快。
- 真实 GUI 联调、签名/公证安装包、第三方服务及生产容量仍需独立验收。20 道 pro 题提供[公开 Dockerfile](../tests/perf/suites/pro/README.md)，历史来源镜像仅作溯源。
