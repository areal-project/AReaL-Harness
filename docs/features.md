**中文** | [English](features.en.md)

# 当前能力与边界

本页描述已实现范围；构建通过、机制测试和真实任务收益分别验证。架构见[分层设计](design/architecture.md)。

| 能力 | 实现与入口 |
|---|---|
| 会话与模型 | 持久 Thread/Turn、流式正文、Chat Completions 思考与 Responses 思考摘要/文本事件、追加输入、取消、恢复；Chat Completions / Responses，模态取决于 adapter 和模型。[客户端](guides/clients.md) |
| 文件与进程 | 条件文件写入、命令、stdin、PTY、有界输出、Scope 权限收窄及清理。[Runtime](api/runtime.md) |
| 工具结果 | 内置固定版本 rg、历史结果原文分页回取；可配置的搜索分组与精确重复行视图，默认 observe。[工具](guides/tools.md) |
| 工具扩展 | 命令工具、hooks、客户端动态工具、MCP stdio/Streamable HTTP、可信 Node 插件 Host。[工具](guides/tools.md) |
| 网络代理 | 模型、HTTP MCP、OTLP 支持 HTTP/HTTPS/SOCKS5 代理、认证与 NO_PROXY；可信 stdio MCP/插件继承代理环境。[配置](guides/configuration.md#proxies) |
| 多 Agent | 默认模型委派、独立历史、共享工作区、阶段报告和结果汇总。[Agent 设计](design/multi-agent.md) |
| Workgroup | DAG、隔离写工作区、制品检查与集成，fixed/auto/adaptive 准入；CLI 和服务接口。[使用指南](guides/workgroups.md) |
| 权限模式 | 本地默认 YOLO，可配置 ASK_PERMISSIONS；TUI/Web 审批、会话/项目精确授权与自动 Thread scratch。[配置](guides/configuration.md#permissions) |
| 桌面接口 | 认证、Profile/Skill/Plan、`--agent id@revision` 选择、Profile 绑定 Workflow 自动启动、审批/追问、提交去重与队列、共享终端、配置 CAS、模型切换、媒体 Blob、归档与 GC。[桌面 API](api/desktop.md) |
| 客户端 | 统一 `areal` 命令（默认 TUI、exec、app-server、config、workgroup、service、web）与本地 Web；TUI 支持 Unicode 光标编辑与常用输入快捷键、持久错误提示、默认分组折叠、鼠标/键盘展开及过程/最终正文分级；CLI 实现选定 Claude Code 非交互参数与消息。[CLI 契约](api/claude-cli.md) |
| Skills | 自动发现与显式 Profile 共用元信息登记、正文/附件按需读取；单个无效全局 Skill 告警隔离，不创建内容快照。[Skill 指南](guides/skills.md) |
| Task Mode 与独立频道 | foreground/scheduled/background、持久 TaskRun、独立 Inbox 回复、headless 无人工等待；task_spawn worker 跨协调 Turn 存活并共享预算。Web 提供任务控制、定时创建和独立收件箱。[接口](api/tasks.md) |
| Goal 持久目标 | 通过 `/goal` 等入口显式创建，无需配置开关；跨 Turn 自动推进、暂停/恢复/编辑/清除，支持显式重新打开已完成目标以修复验收缺陷且保留计量，用户输入优先；主/子 Agent、Workgroup、摘要共享预算。[客户端指南](guides/clients.md#goals) · [接口](api/core.md#goals) |
| 共享本地服务 | 多 TUI 窗口与 Web 复用 Core/Runtime；本地 Web 启动通过一次性登录码自动认证；公共 JSON 发现/控制供 Desktop Main 使用，按工作区隔离、模型配置热更新、空闲安全重启、显式停止与故障清理。[契约](api/local-service.md) |
| SDK | 仓库内私有 `@areal/runtime` 和 `@areal/plugins`，Node.js 22.19.0+。[SDK 契约](api/typescript-sdk.md) |
| 观测与验证 | 标准 OpenTelemetry Traces 与 Events/Logs，通过标准 OTEL 配置导出完整轨迹（OTLP HTTP/protobuf）；确定性模型回归、原生 smoke、Docker lite/pro 评测。[配置](guides/configuration.md) · [测试](development/testing.md) |

## 支持边界

- macOS 的收窄工具执行使用 Seatbelt；Linux native 使用 Bubblewrap namespace 与 Runtime seccomp，要求部署提供 `/usr/bin/bwrap` 和 user namespace；Linux launcher 的 full-access 支持宿主执行，受控 Docker `outer-container-perf` 仍用于固定评测流程。Windows native Runtime 未提供。
- Core、stdio MCP 和插件 Host 是可信宿主，未受 Runtime OS 沙箱隔离；远程工具权限由服务负责。审批不能扩大部署授权。
- `UNKNOWN` 需要人工检查，不自动重放。没有跨 Runtime epoch 恢复、外部写入者 CAS、跨文件事务或完整逃逸后代树清理保证。
- Codex app-server 固定子集和 Claude CLI 消息适配不代表官方完整客户端兼容。DSH 仅适配选定工具/文件服务；不支持替换 Core loop。
- Workgroup 最多 64 个任务、32 个 Worker；CLI 默认 `balanced + fixed`、2 个 Worker。更宽或 adaptive 不保证更快。
- 真实 GUI 联调、签名/公证安装包、第三方服务及生产容量仍需独立验收。20 道 pro 题提供[公开 Dockerfile](../tests/perf/suites/pro/README.md)，历史来源镜像仅作溯源。
- Goal 不自动跨重启运行。每目标账本最多 4096 请求/4 MiB，历史与 Thread 容量仍有限；clear 保留账本且无自动账本 GC。tokenBudget 使用保守准入估算，不保证供应商绝不超额计费；未知消费保留预留并停止自动推进。

发行准备支持 macOS arm64 Homebrew formula 与 Linux x86_64 glibc 完整包，含 SHA256 校验、版本化 Linux 安装和搬迁读写验收。发布可用性以 GitHub Release/tap 为准；详见[安装指南](guides/installation.md)。
