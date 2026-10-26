**中文** | [English](features.en.md)

# 当前能力与边界

本页描述已实现范围；构建通过、机制测试和真实任务收益分别验证。架构见[分层设计](design/architecture.md)。

| 能力 | 实现与入口 |
|---|---|
| 项目规则 | 按工作区根到会话 cwd 加载 `AGENTS.md`，子目录优先、每 Turn 刷新、有界且经 Runtime 读取。[客户端](guides/clients.md) |
| 会话与模型 | 持久 Thread/Turn、流式正文、Chat Completions 思考与 Responses 思考摘要/文本事件、追加输入、取消、恢复；Chat Completions / Responses，模态取决于 adapter 和模型。[客户端](guides/clients.md) |
| 会话名称 | 普通根会话首个成功 Turn 后异步总结名称，手动名称优先；失败保留预览，重启不重复请求。可通过 `options.automaticSessionName=false` 或 CLI `--no-session-name` 显式关闭，保留持久历史与恢复。[Core 契约](api/core.md#会话名称) |
| 文件与进程 | 条件文件写入、命令、stdin、PTY、有界输出、Scope 权限收窄及清理。[Runtime](api/runtime.md) |
| 工具结果 | 内置固定版本 rg、历史结果原文分页回取；可配置的搜索分组与精确重复行视图，默认 observe。[工具](guides/tools.md) |
| 公开多模态输入 | 原生 CLI 只读附件绑定；按需 PNG/JPEG/WebP/GIF 视图，独立模型请求字节限额。[评测输入](benchmarks/README.md#原生平台接入) |
| 工具扩展 | 命令工具、hooks、客户端动态工具、MCP stdio/Streamable HTTP、可信 Node 插件 Host。[工具](guides/tools.md) |
| 网络代理 | 模型、HTTP MCP、OTLP 支持 HTTP/HTTPS/SOCKS5 代理、认证与 NO_PROXY；可信 stdio MCP/插件继承代理环境。macOS GUI 自动读取系统静态代理，模型测试与订阅共用代理快照。[配置](guides/configuration.md#proxies) |
| 统一子任务 | 单一模型委派入口，Core 自动选择共享只读、共享独占作者或隔离执行；统一等待、取消、制品与交付投影，隔离报告带来源和分页，回执声明补充输入能力；按 Runtime 实测能力呈现创建意图，并在子模型启动前预检最终权限。[Agent 设计](design/multi-agent.md) |
| Workgroup | DAG、隔离写工作区、制品检查与集成，fixed/auto/adaptive 准入；CLI 和服务接口。[使用指南](guides/workgroups.md) |
| 权限模式 | 本地默认 YOLO，可配置 ASK_PERMISSIONS；TUI/Web 审批、会话/项目精确授权与自动 Thread scratch。[配置](guides/configuration.md#permissions) |
| 桌面接口 | 认证、Profile/Skill/Plan、`--agent id@revision` 选择、Profile 绑定 Workflow 自动启动、审批/追问、提交去重与队列、共享终端、配置 CAS、模型切换、媒体 Blob、归档与 GC。[桌面 API](api/desktop.md) |
| 桌面 GUI | `clients/gui` 提供 React/Electron、原生文件/差异/终端/浏览器面板、模型与资源设置、手机配对和定时任务界面；普通会话支持暂停后在原会话手动继续，最后一条用户消息可编辑后作为新消息发送并保留原记录。启用 Browser 的聊天可在用户授权后让 Core 读取该聊天当前原生网页的可访问性文本。人工批注支持冻结原生截图、元素/区域选择、多条 Composer 附件与含裁图和说明的消息，不要求启用模型 Browser 工具包。公共服务连接使 GUI 退出不终止 Core 任务；启动恢复支持二次确认后取消活动轮次并重启后台。支持独立公开依赖构建与 macOS arm64 本地包。[GUI](../clients/gui/README.md) |
| 生成式交互回答 | 主会话和 Side 显示 Core 发布的不可变 HTML 制品，复用 MCP Apps 沙箱。状态在同一 Desktop 配置中有界保存，后续输入只附加模型可见参数，私有状态不进入模型请求。页面后续问题经宿主确认发送。[桌面 API](api/desktop.md#生成式交互回答) |
| 桌面 Worktree | 普通新会话使用当前目录、分支与 Core，多个会话可共享目录；只有本次创建明确选择 Worktree 才创建独立 checkout 与 Core/Runtime，线程仍归原逻辑项目。创建和绑定可恢复，保留已有目录、未提交改动和旧请求身份。任务按实际宿主路由，定时任务家庭继续预约自动分配的项目外目录并核对执行锚点；共享目录与无预约的旧安排不能启用。直接 Core/CLI、原生自主任务及 full-access 外部写入的边界见[指南](guides/worktrees.md)。 |
| 会话选区与轮次导航 | 主会话划词可添加到主 Composer 或当前辅助对话，保留正文与附件。引用可逐条移除、按来源去重，最多 8 条、单条 8,000 字符、合计 16,000 字符。辅助对话使用独立临时标签和完整 Composer，继承稳定来源历史，支持工具、附件与权限交互。`/side`、`/btw` 可创建空对话或发送文字首问。主、辅会话共用独立滚动的轮次导航；Esc 按焦点所属面板停止。旧版只读 Side 保留原权限。[GUI](../clients/gui/README.md) |
| 客户端 | 统一 `areal` 命令（默认 TUI、exec、version、upgrade、app-server、config、workgroup、service、web）与本地 Web；TUI 支持 Unicode 光标编辑与常用输入快捷键、持久错误提示、默认分组折叠、鼠标/键盘展开及过程/最终正文分级；CLI 实现选定 Claude Code 非交互参数与消息。[CLI 契约](api/claude-cli.md) |
| Skills | 自动发现与显式 Profile 共用元信息登记、正文/附件按需读取；单个无效全局 Skill 告警隔离，不创建内容快照。[Skill 指南](guides/skills.md) |
| Task Mode 与独立频道 | foreground/scheduled/background、持久 TaskRun、独立 Inbox 回复、headless 无人工等待；统一委派的 TaskRun worker 跨协调 Turn 存活并共享预算。Web 提供任务控制、定时创建和独立收件箱。[接口](api/tasks.md) 计划支持显式“立即运行”，创建独立 manual Run，保留暂停和下次计划时间，使用原总预算；响应丢失时只读核对原收据。 |
| 插件组件支持 | 插件包报告按候选和已安装摘要分别列出组件解析支持、必需静态兼容及使用前提；MCP 连接、认证和 Hook 信任仍独立显示。[插件](guides/plugins.md) |
| 浏览器自动化 | 复用 ZCode 已实现命令，包括定位器、iframe、CUA、截图、alert/confirm、下载和 WebM。全部项目共享持久登录态，设置提供显式 Chrome 导入及数据清理；页面控制和审批仍绑定聊天，UNKNOWN 不重放。[Browser](api/browser.md) |
| 电脑控制 | 默认关闭的本机 macOS 原生 Helper，通过设置由用户授予辅助功能、屏幕录制及输入监控；支持应用/窗口观察、AX 与键鼠输入、停止和接管。Core 保留单次计划审批与历史。可显式选择外部 LCU，由原运行时处理 JS 与应用授权，仅用于新建普通聊天；内置浏览器保持可用。[电脑控制](api/computer.md) |
| Goal 持久目标 | 通过 `/goal` 等入口显式创建，无需配置开关；跨 Turn 自动推进、暂停/恢复/编辑/清除，用户输入优先；主/子 Agent、Workgroup、摘要共享预算。[客户端指南](guides/clients.md#goals) · [接口](api/core.md#goals) |
| 共享本地服务 | 多 TUI 窗口与 Web 复用 Core/Runtime；本地 Web 启动通过一次性登录码自动认证；公共 JSON 发现/控制供 Desktop Main 使用，按工作区隔离、模型配置热更新、热更新未应用时的空闲安全重启（支持继承新凭据）、显式停止与故障清理。[契约](api/local-service.md) |
| SDK | 仓库内私有 `@areal/runtime` 和 `@areal/plugins`，Node.js 22.19.0+。[SDK 契约](api/typescript-sdk.md) |
| 观测与验证           | 标准 OpenTelemetry Traces 与 Events/Logs，通过标准 OTEL 配置导出模型和工具轨迹（OTLP HTTP/protobuf）；确定性模型回归、原生 smoke、Docker lite/pro 评测。[配置](guides/configuration.md) · [测试](development/testing.md)                                                                        |
| 持久轨迹导出 | 可选 `[trajectory]` 配置、跨本地 run 的有界磁盘队列、独立 OTLP Logs 上传进程、退避与手动重试；CLI 状态、会话内一次异常提示和 GUI 数据飞轮启停开关与实时状态；区分模型调用、Agent 执行与上传时间。上传不改变 Turn 结果；平台分析登记由接收端完成。[配置](guides/configuration.md#持久轨迹导出) |

Remote 的 Direct 与 Relay 已接入共同 Host 授权和 PWA 协议，Direct 提供 Serve/组织 HTTPS 配置及可选 Funnel 范围切换。源码能力不等于路线或平台已认证；本机严格 TLS 夹具不代表 Native/Core、浏览器 TLS、真实手机或公网部署验收。配置、迁移与路线矩阵见 [Remote 指南](guides/remote-control.md)，独立验证要求见[测试与发布门槛](development/remote-control-testing.md)。

## 支持边界

- macOS 受限命令支持系统 Git 的工具链解析、私有 Bash here-document，以及可信启动 PATH 和 nvm/mise/fnm/Volta、Python/Rust 版本管理器接入的已安装只读工具链；用户 CLI 与必要公共 TLS 资源也在启动时发现，保留源码只读、独立 scratch 和禁网边界。完整发行包附带独立 Bash 的许可证和对应源码；嵌套硬编码系统 Bash 不被替换。见 [Runtime 工具边界](api/runtime.md#macos-受限命令的系统工具)。
- macOS 的收窄工具执行使用 Seatbelt，并跟踪清退已观察到的后代；快速孤儿化仍可能漏检。Linux native 使用 Bubblewrap namespace 与 Runtime seccomp，要求部署提供 `/usr/bin/bwrap` 和 user namespace；Linux launcher 的 full-access 支持宿主执行。产品 Rust launcher 与 Linux Runtime 的单次执行回收不依赖 Python；后者使用随包发布的 Rust 二进制 `areal-runtime-reaper` 和可读的 `/proc`。详见 [Runtime 清理边界](api/runtime.md#输出与清理)。受控 Docker `outer-container-perf` 仍用于固定评测流程。Windows native Runtime 未提供。
- Core、stdio MCP 和插件 Host 是可信宿主，未受 Runtime OS 沙箱隔离；远程工具权限由服务负责。审批不能扩大部署授权。
- `UNKNOWN` 需要人工检查，不自动重放。没有跨 Runtime epoch 恢复、外部写入者 CAS、跨文件事务或完整逃逸后代树清理保证。
- Codex app-server 固定子集和 Claude CLI 消息适配不代表官方完整客户端兼容。DSH 仅适配选定工具/文件服务；不支持替换 Core loop。
- Workgroup 最多 64 个任务、32 个 Worker；CLI 默认 `balanced + fixed`、2 个 Worker。更宽或 adaptive 不保证更快。
- GUI 的真实供应商/账号、其他平台、签名/公证分发及生产容量仍需独立验收；本地确定性模型验收不代表这些边界。20 道 pro 题提供[公开 Dockerfile](../tests/perf/suites/pro/README.md)，历史来源镜像仅作溯源。
- Goal 不自动跨重启运行。累计执行预算仅在显式配置时生效。历史与已结算 Goal 请求使用不可变分段；未结算热账本仍有 4 MiB 资源保护，会话/资源容量与可用磁盘仍有效；clear 保留账本且无自动账本 GC。tokenBudget 使用保守准入估算，不保证供应商绝不超额计费；未知消费保留预留并停止自动推进。

发行准备支持 macOS arm64 / Linux x86_64 glibc 独立完整包、macOS Homebrew formula，含 SHA256 校验、版本化安装和搬迁读写验收。npm 与 Windows 暂不支持；发布可用性以 GitHub Release/tap 为准，详见[安装指南](guides/installation.md)。

文件参考保留与连续相同失败的执行上限需要显式实验配置，默认关闭；非交互命令仍默认关闭 stdin，详见[配置指南](guides/configuration.md#参考保留与有界工具恢复)。功能存在不代表已证明业务成功率提升。

旧观察折叠与空白响应额外恢复同样默认关闭，需在冻结的实验配置中显式启用；正确性回归不能代替端到端收益验证。

## 回答评价

开启数据飞轮且接收端支持时，可为已结束回复点赞或点踩，填写理由，使用独立 Side 润色后提交冻结上下文。详见[回答评价](guides/user-feedback.md)。

可信原生只读调用支持有界并发，写入、游标和未知后端保持顺序；共享作者可在已确认资源结算的模型等待边界让出租约。隔离源码投影保留已跟踪和未忽略的脏源码，执行依赖单独提供。契约与反例见[Core](api/core.md)和[多 Agent 设计](design/multi-agent.md)。

隔离 worker 继承父纯工具策略，不继承外部工具、hooks、插件和凭据。协作回执区分制品支持与当前就绪，版本化等待跳过未变化的已结算状态，批量回执保留结构化状态、有界正文预览、分页与原文回取。App 引用变化追加为任务数据，不回写系统指令快照；Responses HTTP 路由按会话与 Turn 隔离。`completionFocus` 与独立的 `executionFocus` 均为默认关闭的显式实验策略，分别引导交付收尾与独立读取、等待和委派契约组织；不保证消除长尾或降低消费；协议与兼容边界见[Core](api/core.md)。
