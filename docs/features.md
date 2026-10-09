**中文** | [English](features.en.md)

# 当前能力与边界

本页描述已实现范围；构建通过、机制测试和真实任务收益分别验证。架构见[分层设计](design/architecture.md)。

| 能力 | 实现与入口 |
|---|---|
| 项目规则 | 按工作区根到会话 cwd 加载 `AGENTS.md`，子目录优先、每 Turn 刷新、有界且经 Runtime 读取。[客户端](guides/clients.md) |
| 会话与模型 | 持久 Thread/Turn、流式正文、Chat Completions 思考与 Responses 思考摘要/文本事件、追加输入、取消、恢复；Chat Completions / Responses，模态取决于 adapter 和模型。[客户端](guides/clients.md) |
| 文件与进程 | 条件文件写入、命令、stdin、PTY、有界输出、Scope 权限收窄及清理。[Runtime](api/runtime.md) |
| 工具结果 | 内置固定版本 rg、历史结果原文分页回取；可配置的搜索分组与精确重复行视图，默认 observe。[工具](guides/tools.md) |
| 工具扩展 | 命令工具、hooks、客户端动态工具、MCP stdio/Streamable HTTP、可信 Node 插件 Host。[工具](guides/tools.md) |
| 网络代理 | 模型、HTTP MCP、OTLP 支持 HTTP/HTTPS/SOCKS5 代理、认证与 NO_PROXY；可信 stdio MCP/插件继承代理环境。[配置](guides/configuration.md#proxies) |
| 多 Agent | 默认模型委派、独立历史、共享工作区、阶段报告和结果汇总。[Agent 设计](design/multi-agent.md) |
| Workgroup | DAG、隔离写工作区、制品检查与集成，fixed/auto/adaptive 准入；CLI 和服务接口。[使用指南](guides/workgroups.md) |
| 权限模式 | 本地默认 YOLO，可配置 ASK_PERMISSIONS；TUI/Web 审批、会话/项目精确授权与自动 Thread scratch。[配置](guides/configuration.md#permissions) |
| 桌面接口 | 认证、Profile/Skill/Plan、`--agent id@revision` 选择、Profile 绑定 Workflow 自动启动、审批/追问、提交去重与队列、共享终端、配置 CAS、模型切换、媒体 Blob、归档与 GC。[桌面 API](api/desktop.md) |
| 桌面 GUI | `clients/gui` 提供 React/Electron、原生文件/差异/终端/浏览器面板、模型与资源设置、手机配对和定时任务界面；公共服务连接使 GUI 退出不终止 Core 任务。支持独立公开依赖构建与 macOS arm64 本地包。[GUI](../clients/gui/README.md) |
| 客户端 | 统一 `areal` 命令（默认 TUI、exec、version、upgrade、app-server、config、workgroup、service、web）与本地 Web；TUI 支持 Unicode 光标编辑与常用输入快捷键、持久错误提示、默认分组折叠、鼠标/键盘展开及过程/最终正文分级；CLI 实现选定 Claude Code 非交互参数与消息。[CLI 契约](api/claude-cli.md) |
| Skills | 自动发现与显式 Profile 共用元信息登记、正文/附件按需读取；单个无效全局 Skill 告警隔离，不创建内容快照。[Skill 指南](guides/skills.md) |
| Task Mode 与独立频道 | foreground/scheduled/background、持久 TaskRun、独立 Inbox 回复、headless 无人工等待；task_spawn worker 跨协调 Turn 存活并共享预算。Web 提供任务控制、定时创建和独立收件箱。[接口](api/tasks.md) |
| Goal 持久目标 | 通过 `/goal` 等入口显式创建，无需配置开关；跨 Turn 自动推进、暂停/恢复/编辑/清除，用户输入优先；主/子 Agent、Workgroup、摘要共享预算。[客户端指南](guides/clients.md#goals) · [接口](api/core.md#goals) |
| 共享本地服务 | 多 TUI 窗口与 Web 复用 Core/Runtime；本地 Web 启动通过一次性登录码自动认证；公共 JSON 发现/控制供 Desktop Main 使用，按工作区隔离、模型配置热更新、热更新未应用时的空闲安全重启（支持继承新凭据）、显式停止与故障清理。[契约](api/local-service.md) |
| SDK | 仓库内私有 `@areal/runtime` 和 `@areal/plugins`，Node.js 22.19.0+。[SDK 契约](api/typescript-sdk.md) |
| 观测与验证 | 标准 OpenTelemetry Traces 与 Events/Logs，通过标准 OTEL 配置导出完整轨迹（OTLP HTTP/protobuf）；确定性模型回归、原生 smoke、Docker lite/pro 评测。[配置](guides/configuration.md) · [测试](development/testing.md) |
| 持久轨迹导出 | 可选 `[trajectory]` 配置、跨本地 run 的有界磁盘队列、独立 OTLP Logs 上传进程、退避与手动重试；CLI 状态和 GUI 数据飞轮设置页。上传不改变 Turn 结果；平台分析登记由接收端完成。[配置](guides/configuration.md#持久轨迹导出) |

## 支持边界

- macOS 的收窄工具执行使用 Seatbelt，并跟踪清退已观察到的后代；快速孤儿化仍可能漏检。Linux native 使用 Bubblewrap namespace 与 Runtime seccomp，要求部署提供 `/usr/bin/bwrap` 和 user namespace；Linux launcher 的 full-access 支持宿主执行。产品 Rust launcher 与 Linux Runtime 的单次执行回收不依赖 Python；后者使用随包发布的 Rust 二进制 `areal-runtime-reaper` 和可读的 `/proc`。详见 [Runtime 清理边界](api/runtime.md#输出与清理)。受控 Docker `outer-container-perf` 仍用于固定评测流程。Windows native Runtime 未提供。
- Core、stdio MCP 和插件 Host 是可信宿主，未受 Runtime OS 沙箱隔离；远程工具权限由服务负责。审批不能扩大部署授权。
- `UNKNOWN` 需要人工检查，不自动重放。没有跨 Runtime epoch 恢复、外部写入者 CAS、跨文件事务或完整逃逸后代树清理保证。
- Codex app-server 固定子集和 Claude CLI 消息适配不代表官方完整客户端兼容。DSH 仅适配选定工具/文件服务；不支持替换 Core loop。
- Workgroup 最多 64 个任务、32 个 Worker；CLI 默认 `balanced + fixed`、2 个 Worker。更宽或 adaptive 不保证更快。
- GUI 的真实供应商/账号、其他平台、签名/公证分发及生产容量仍需独立验收；本地确定性模型验收不代表这些边界。20 道 pro 题提供[公开 Dockerfile](../tests/perf/suites/pro/README.md)，历史来源镜像仅作溯源。
- Goal 不自动跨重启运行。累计执行预算仅在显式配置时生效。历史与已结算 Goal 请求使用不可变分段；未结算热账本仍有 4 MiB 资源保护，会话/资源容量与可用磁盘仍有效；clear 保留账本且无自动账本 GC。tokenBudget 使用保守准入估算，不保证供应商绝不超额计费；未知消费保留预留并停止自动推进。

发行准备支持 macOS arm64 / Linux x86_64 glibc 独立完整包、macOS Homebrew formula，含 SHA256 校验、版本化安装和搬迁读写验收。npm 与 Windows 暂不支持；发布可用性以 GitHub Release/tap 为准，详见[安装指南](guides/installation.md)。
