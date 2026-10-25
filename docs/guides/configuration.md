**中文** | [English](configuration.en.md)

# 配置

`core/config` 统一解析启动配置，由 server 注入各组件；本地产品默认 YOLO，审批策略和 Runtime 执行边界分别管理。完整示例见 [config.toml](../../core/config/examples/config.toml)，字段类型见[配置源码](../../core/config/src/lib.rs)。

## 文件与优先级

`显式 CLI > 已登记环境变量 > 选定 TOML > 默认值`。默认配置为 `~/.areal/config.toml`，数据为同目录 `state/`。`AREAL_HARNESS_HOME` 指定非空绝对 home；`--config` 优先于 `AREAL_HARNESS_CONFIG`，替代默认文件，不叠加。不自动读取项目 TOML 或 `.env`。

GUI 默认使用同一配置文件和 Core 读写接口；服务登记与运行数据保持隔离。`AREAL_HARNESS_SERVICE_HOME` 只选择共享服务登记及默认实例数据的非空绝对目录，不改变配置位置；省略时沿用 `AREAL_HARNESS_HOME` 或 `~/.areal`。GUI 自动选择自己的服务目录，无需为共享默认配置设置环境变量；路径覆盖见 [GUI 指南](../../clients/gui/README.md)。

通过“设置 > 模型设置”配置模型。供应商导航只显示名称，已启用与未启用分组以间距和分隔线区分，凭据及可用状态显示在右侧详情。GUI 的模型设置可以在任务运行时保存供应商、API Key 和模型列表，也允许先保存没有模型的连接。连接字段填写完整后，页面使用未保存的地址和密钥自动获取模型；获取失败时可手动添加。文件保存使用版本检查，运行中的任务保留原模型与凭据，空闲 Core 随后自动应用。页面分别显示“已保存”和生效状态，应用失败不会回滚这次保存，结果未知时只核查原请求。普通模型配置与 API Key 保存不重启 Core 或 Runtime。“备用默认模型”可选择已保存且启用的供应商模型，以及当前账号目录中的 ChatGPT 模型。更改备用默认和删除供应商仍要求空闲并确认应用，已确认失败时尝试按版本回滚。ChatGPT 默认选择使用既有 `areal_openai` 模型引用，账号授权仍由桌面管理。显式 Profile 模型优先于最近使用偏好和备用默认。

新草稿在发送前显示具体模型和将要提交的思考强度。优先使用受支持的已选或最近受理强度，再依次使用模型配置默认、受支持的 medium、首个可选值。`none` 是具体强度，显示“无”；不支持推理的模型不显示或提交强度。已有会话未指定或已不支持的强度显示“未指定”，打开菜单不会改写配置；通过滑块或未指定时的档位选择后保存具体值。强度名称仅在悬停、聚焦或选择时提示，顶部保留当前值。显式切换模型时使用目标模型的配置默认或上述回退。Composer 不提供恢复默认或配置链接，没有可选模型时显示单行“暂无可用模型”，完整引导保留在提示中。新会话沿用用户主会话最后一次受理的供应商、模型和实际思考强度，跨项目及桌面/Core 重启保留。Core 在用户消息或继续请求受理时记录，排队消息在入队时记录；模型执行失败不会撤销已经受理的选择。未发送的选模/强度修改、打开历史、Side、子代理及后台调度不更新这项偏好。显式选过模型或强度的草稿保留本次选择。没有记录时使用备用默认；上次模型不可用时提示并显示备用默认，不支持的强度提示后按上述顺序选择支持的值。偏好只保存模型身份和强度，不修改供应商配置或服务默认，也不复制凭据。修改备用默认不会改写已有会话；会话中切换模型或强度会立即保存，重开及重启后沿用该选择，过去的 Turn 快照保持不变。

共享 TUI/Web 入口使用按工作区隔离的默认数据目录；显式 dataDir 仍遵循上述优先级。历史迁移与配置兼容性见[本地服务契约](../api/local-service.md)。

默认文件不存在可继续；显式文件不存在、未知字段、类型/版本错误或已设置为空的值均拒绝。文件限普通 UTF-8、1 MiB，接受 `schema_version=1` 或 `2`。TOML 相对路径以配置文件目录为基准，CLI/env 相对路径以启动 cwd 为基准，不展开 `~`、变量或 glob。即使字段被高层覆盖，低层格式错误仍拒绝。

<a id="permissions"></a>
## 权限模式

桌面与 Remote 新聊天默认使用“请求审批”，Composer 还提供“帮我审批”和“完全访问”。前两档的受管命令及文件工具限制在工作区和任务 scratch，命令默认不能联网；工作区内的常规编辑和命令无需逐次审批。需要额外权限时，“请求审批”交给用户，“帮我审批”发起独立、无工具的模型审核；审核无法完成或无法确定时交给用户。明确拒绝与强制人工审批仍优先。

“完全访问”使用部署允许的完整资源范围并省略常规审批。受限部署不会因切换菜单而扩权。计划模式独立叠加只读限制。设置仅影响当前聊天的新提交；已入队消息保留入队时的权限快照。旧聊天未设置新预设时保留原语义，不自动升级为完全访问。客户端必须确认 Core 公布 `features.permissionPresets` 后才能提交新预设。

读取项目 `AGENTS.md` 使用与工具相同的受限 base Scope，不改变本轮可信 authority 上限。追加权限仍必须通过 `run_command.permissionRequest` 及相应审批，只作用于该次操作；规则文件的存在不应阻止申请，也不会授予工作区外权限。

这些资源限制覆盖 Runtime 受管执行，不表示 Core、MCP、插件 Host 或浏览器共享命令沙箱。浏览器使用独立页面控制与逐次目标校验；详见[权限架构](../design/permissions.md)。

以下部署级配置仍适用于未选择新聊天预设的入口，并为所有聊天提供显式工具规则。

本地 TUI、Web、CLI 和 `scripts/launch.py` 默认 **YOLO**：普通任务可读写当前用户有权访问的文件（含工作区外和 `/tmp`），命令可联网，不逐次询问。无需再传 `--allow-write` / `--allow-network`。操作系统自身权限仍有效；显式 Profile、只读 Turn、工具拒绝规则和受限 Runtime 不能被 YOLO 覆盖。

全局配置 `~/.areal/config.toml`：

```toml
schema_version = 1
[permissions]
mode = "ASK_PERMISSIONS"
# 规则只匹配工具 ID，支持 *；不是 shell 命令模式。
# deny = ["mcp__untrusted__*"]
# ask = ["run_command"]
# allow = ["read_file"]
```

已有文件只添加 `[permissions]`，不要重复 `schema_version`。省略此表或设置 `mode = "YOLO"` 恢复默认。也可使用环境变量或单次启动参数：

```sh
ASK_PERMISSIONS=1 make tui
AREAL_HARNESS_PERMISSION_MODE=ASK_PERMISSIONS target/debug/areal web
make tui ARGS='--permissions ASK_PERMISSIONS'
```

优先级：`--permissions` > `AREAL_HARNESS_PERMISSION_MODE` > `ASK_PERMISSIONS` > TOML > YOLO。`ASK_PERMISSIONS` 接受 `1/true`（询问）、`0/false`（YOLO）。权限模式在服务启动时固定；已有共享服务需显式执行 `ASK_PERMISSIONS=1 target/debug/areal service restart`，带回原有自定义部署参数。重启默认拒绝忙碌服务。`--endpoint` 使用远端服务的策略。

ASK_PERMISSIONS 自动允许内置工作区/scratch 读取、搜索和内部状态操作；命令、文件修改、工作区外读取、外部工具进入审批。它是工具调用审批，不是 shell 静态分析；允许一次命令即允许该命令在当前 Scope 内执行其子操作。TUI 弹窗和 Web 面板提供拒绝、允许一次、记住本会话/当前项目相同请求；强制审批与无法核验代际的 MCP 工具仅单次回答。当前不提供命令前缀规则或按域名联网授权。

规则优先级固定为 `deny > ask > allow > mode`，每组最多 128 个、每个最多 128 字节的工具 ID glob。显式 ask 与 Profile/客户端追加的审批不能被授权记忆覆盖；allow 不能覆盖只读 Scope。批准绑定实际参数摘要；取消、过期、重复或摘要不符的回答不执行工具。

记忆绑定工具、规范化参数、Host 代际、工作区与权限边界；修改命令或策略会重新询问。会话记忆随 Thread 持久化；项目记忆位于该部署的 `dataDir/desktop/permissions.json`，同工作区不同 dataDir 不共享。每组最多 64 条、128 KiB；文件含获批参数，应与会话数据一起管理。TUI `/permissions` 显示模式来源、Runtime 权限与记忆，`/permissions clear-session`、`/permissions clear-project` 撤销后续复用，不撤销已经受理的副作用。撤销要求目标 Thread 空闲。

launcher 自动创建与 dataDir 同级的 `scratch/`，为每个 Thread 设置独立 `TMPDIR`；可用 `--scratch` 指定现有目录。目录与工作区/dataDir 不重叠，保留至部署数据被人工清理。只读/研究任务仍可写自己的 scratch。直接嵌入 Core 或运行 Runtime daemon 的默认边界保持受限；部署显式 `--sandbox-profile native` 可继续使用原有 write/network 开关，见 [Runtime 部署](runtime.md)。

## 自动协作与兼容验收策略

普通 Agent 协作无需额外功能开关，也无需用户指定共享或隔离模式。Core 根据任务要求及有效权限选择共享分析、共享独占写入或隔离候选执行。自动隔离还要求可用的独立 Runtime/文件助手以及满足快照约束的工作区；普通修改不具备隔离条件时可在启动前采用共享独占写入。明确要求候选补丁或可信验收的任务不能降低要求。

宿主使用现有写授权和父任务限制构造内部执行边界。YOLO 不覆盖只读 Profile、工具拒绝或 Runtime 上限，项目里的说明或模型提供的计划不能新增授权。未配置可信检查时，自动隔离不宣称验收通过；现有 `--workgroup-policy` 继续表示由部署方提供的严格写范围和最终 checks，用于兼容 Workflow、显式工作组和要求可信验收的委派。普通使用不需要维护第二份策略 JSON，详见[执行选择](../design/multi-agent.md)与[兼容 Workgroup 配置](workgroups.md)。

## 分析子任务的权限策略

工作职责与执行权限分别表达：`intent="inspect", delivery="report"` 要求分析报告，不会授权修改；部署配置决定是否额外强制源码只读。

```toml
[delegation]
inspection_permissions = "read-only" # 默认，强制只读
# inspection_permissions = "inherit" # 显式候选，继承父任务有效权限
```

环境变量 `AREAL_HARNESS_INSPECTION_PERMISSIONS` 接受 `read-only` / `inherit`，覆盖 TOML；该部署策略启动时固定，修改后须安全重启服务。脱敏配置诊断的 `delegation.inspection_permissions` 和模型工作区事实 `inspectionPermissions` 显示实际选择。

`read-only` 保留原行为：源码只读、独立 scratch 可写，受限 Scope 不可用则在子模型启动前拒绝。`inherit` 不因普通分析自动增加只读/禁网限制，原有父权限、Profile、工具拒绝和审批规则仍有效；父任务本就受限时仍需要可用的相应沙箱。它不承诺子任务无法修改源码，不能把行为指令当成 OS 保护。旧显式 `workspaceMode="sharedReadOnly"` 与研究 Agent 不受该配置影响。

继承模式与共享作者在首次副作用前申请工作区独占租约。在无 hooks/未受管副作用且 Runtime 确认本轮进程已结算的模型等待边界让出，再次写入时重新申请；活动进程、UNKNOWN 与查询失败不让出。文件版本约束、权限、取消和递归限制保持生效，详细边界见[多 Agent 设计](../design/multi-agent.md)。

该选项是显式部署候选，不因局部回归通过而替换默认值。两种模式及反例见[委派设计](../design/multi-agent.md)。

## 模型与限额

普通 Turn 没有组合墙钟超时；模型请求/流空闲、工具执行和清理沿用各自的超时，显式 Goal、研究 worker 和 Workgroup 预算仍有效。迁移时删除 `limits.turn_timeout_seconds`（旧 TOML 字段会被拒绝）和 `AREAL_HARNESS_TURN_TIMEOUT_SECONDS`（旧环境变量也会被拒绝）。`thread/configuration/read` 的 `limits` 不再包含 `turnTimeoutMs`。手动上下文压缩也只受模型超时与关闭取消约束。

```toml
schema_version = 1
[server]
listen = "127.0.0.1:4500"
[model]
provider = "example"
name = "your-model-id"
# context_window_tokens = 131072
# max_output_tokens = 16384
max_retries = 2
max_request_bytes = 16777216
[model.providers.example]
protocol = "responses"
endpoint = "https://model.example.com/v1/responses"
api_key_env = "AREAL_API_KEY"
[context]
mode = "auto"
# target_tokens = 0                 # 0: automatic target
# output_reserve_tokens = 8192

[budget]
# Omitted or 0: unlimited cumulative budget.
# max_tool_calls = 0
# max_output_bytes = 0
# max_history_bytes = 0

[resources]
model_concurrency = 32
max_threads = 20000
max_active_turns = 256
max_side_turns_per_source = 2
max_side_turns_per_deployment = 8
max_side_model_rounds = 8
max_side_tool_calls = 16
max_side_turn_seconds = 300
max_children_per_turn = 64
max_agent_depth = 8
max_response_tool_calls = 128
max_response_bytes = 4194304
max_tool_buffer_bytes = 4194304

[network]
retry_mode = "persistent"
model_request_timeout_seconds = 300
stream_idle_timeout_seconds = 30
[logging]
filter = "info"
```

endpoint 是完整 HTTP(S) 请求 URL；Core 只支持 `chat-completions` / `responses`，不自动补路径。配置只写密钥变量名；普通启动时，显式引用必须解析为非空且可用于 HTTP header 的值；未选中 provider 不要求密钥。省略引用为匿名，不从其他应用读取凭据。`--management` 允许选中模型的凭据暂不可用，以便启动管理和 Workspace 入口；该模型的请求会明确报 `MODEL_CREDENTIAL_UNAVAILABLE`，不会匿名发送或改用其他模型。模型名称、端点和协议仍须有效；通过外部进程环境补充凭据后需重启服务；GUI 保存的加密 API Key 使用受保护的热应用接口，无需重启。

例如 Chat Completions 通常填写 `https://model.example.com/v1/chat/completions`，Responses 填写 `https://model.example.com/v1/responses`，以供应商实际接口为准。仅填 `/v1` 可能得到 HTTP 200 的 HTML 网页，触发 `model response must use text/event-stream`；Goal 模式还会因未知用量显示 `GOAL_USAGE_UNKNOWN`，并保留原始错误。修改非模型启动配置后须[停止并重新启动共享服务](../api/local-service.md#公共入口)，只重开客户端不会重新加载配置。

`reasoning_effort` 可为 none/minimal/low/medium/high/xhigh/max，供应商需支持；`model.max_output_tokens` 默认 16384（16k），映射到协议对应字段；这是单次请求的可覆盖默认值，需大于零，不是整个 Turn 的累计预算。全局显式值、模型和供应商默认参数、环境变量仍按既有优先级覆盖；省略值（含旧模型快照中的空值）使用新默认。OpenAI 推理模型的额度包含推理与可见输出，复杂任务可按模型调大，例如 32768，并确保窗口留有输入空间。`max_retries` 为 0–8，控制接受流之前的有限 HTTP 重试，涵盖传输错误、HTTP 408/429 和全部 5xx。该额度耗尽后，默认启用的 Core watchdog 仍会继续网络恢复。

可选 `model.reasoning_summary = "auto"`（也可为 `concise` / `detailed`）仅适用于 `responses`，映射到请求的 `reasoning.summary`；环境变量为 `AREAL_HARNESS_REASONING_SUMMARY`。默认省略，不向 Chat Completions 或未选择此功能的模型附加摘要参数。端点/模型必须支持所选摘要模式；是否返回摘要取决于供应商，不保证始终有思考文本。

可选采样参数不配置时省略，显式 0 保留。`temperature` 为有限数 [0,2]，`top_p` / `min_p` 为 [0,1]，`top_k` 为正整数或 -1，`presence_penalty` 为 [-2,2]，`repetition_penalty` 大于 0。Chat 与 Responses 均接受 temperature/top_p；其余四项只支持 Chat，Responses 配置时拒绝。参数发送不证明供应商实际采纳。摘要默认继承求解采样/推理配置并禁用工具。可单独设置 `model.summary_reasoning_effort` 和 `model.summary_max_output_tokens`（环境变量 `AREAL_HARNESS_SUMMARY_REASONING_EFFORT` / `AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS`），不会修改后续求解参数。摘要输出上限为全局输出上限、摘要专用上限、Goal 剩余额度与 16384 中的最小值；专用上限需大于零。未配置时兼容原行为；例如可在求解 high 时显式选择摘要 low/4096，需验证供应商支持和任务保留效果。

`model.context_window_tokens` 设置当前模型的用户工作预算（1–2000000），Provider/模型默认参数及 `parameters.contextWindowTokens` 同样支持。服务报告窗口与用户预算分开解析，工作窗口取两者较小值。订阅账号缺少报告时使用全局 131072-token 兜底；其他端点缺少报告与预算时查完整型号默认表，再使用全局兜底。诊断分别显示报告来源、用户预算与实际窗口。输出预留取 `context.output_reserve_tokens`（默认 8192）与当前模型输出上限的较大值；默认 HTTP 模型因此预留 16384 token，完整输入最多为 114688 token（其中还需容纳动态指令与工具 schema）。显式输出配置优先，用户工作预算受服务报告窗口约束；省略字段采用默认值；不会按供应商名称推测实际能力，小窗口模型应同时调低输出上限和必要的预留。每次求解请求在发送前检查完整消息、动态指令和工具 schema 是否落在窗口减预留以内。估算按 ASCII 约 3 字节/token、非 ASCII 约 2 token/字符及媒体代理成本计算；已结算完整输入用量（含缓存）加 10% 余量校准追加历史，压缩后重置。估计不等于供应商 tokenizer 精确计数。

常规使用只需设置模型窗口、输出上限和 `context.mode`。`context.target_tokens=0` 自动选择可用输入窗口的 60%；正数必须小于输入上限。`context.recent_tokens` 默认改为 0（自动），正数和旧 `context_recent_bytes` 仍作为兼容边界偏好，诊断保留配置来源；常用示例不再固定近期额度。Core 使用同一完整请求预算分配近期完整轮次、用户原文、摘要和历史证据，删除用户原文/证据各自的固定 8192 软配额，也不再永久优先首问。最新真实用户请求及附件必须完整保留；其他原文从近到远分配，旧附件超额时可保留其文字并明确标记附件省略。未完成或 UNKNOWN 工具操作不得纳入压缩前缀。旧原文与完整附件仍在磁盘，可通过 `read_history` 查回。

求解先构造实际动态提示，再用共享计量入口计算固定指令、完整历史、工具 schema 和协议余量；压缩候选与最终请求使用同一预算。候选须净缩减、满足完整输入硬上限、保持前缀身份及工具配对，才原子提交。摘要等待期间的新 steer 被纳入重新规划，求解重建实际请求后再次预检。目标不能达到但硬上限可满足时，事件中 `targetMet=false`，不为软目标无限压缩。

摘要请求独立预检并有 16 KiB 文本资源保护。HTTP 400 等永久请求错误不作为摘要验证错误重试；已收到但空、过长或包含工具调用的摘要最多验证重试一次。请求失败、验证耗尽或无法净缩减时保留原 checkpoint 与历史，不提交降级摘要；已观察用量仍持久保存。原完整请求仍能容纳时继续，否则返回 `LLM_CONTEXT_WINDOW_EXCEEDED` 并保留摘要失败原因。仅存储滚动可直接归档不可回放的推理并保留历史摘录，不用它替代失败的模型摘要。取消与 Goal 未知消费不允许继续。具体分配与迁移规则见[上下文管理](../design/context-management.md)。

`areal/context/read` 的 `budget` 提供窗口、输出预留/上限、历史估算、含已记录指令与当前工具的输入估算、窗口来源及保留策略；它是下一次请求的历史投影诊断，不包含尚未构造的动态控制。`areal/context/compactionFailed` 提供失败分类与 `checkpointPreserved=true`，不表示整个 Turn 必然失败。自动模式下，提供方在任何输出/工具调用之前返回明确的上下文溢出错误时，最多压缩恢复一次，仍受 Goal 计量约束，不重放工具副作用。

`context.mode` 可为 `auto`（默认）、`manual`（仅显式压缩）或 `disabled`（自动/手动均关闭）。后两者在请求超限时停止。Schema 1 与旧 `[limits]` 显式值仍可使用：`context_compaction_enabled=false` 对应 disabled；`context_window_bytes` 与 `context_recent_bytes` 作为旧字节保护选项保留，默认均为 0。旧 `context_window_tokens=0` 只关闭全局 token 兜底，模型窗口优先。不要同时配置新旧别名，或同时配置旧压缩开关与 `context.mode`，冲突会拒绝。关闭委派可设置资源中的子任务数/深度为 0；显式开启研究扩展时需要非零子任务限额。

网络 watchdog 默认启用，网络错误没有重试次数上限。设置 `AREAL_HARNESS_WATCHDOG_DISABLE=1` 关闭，删除该变量或设为 `0` 恢复默认；也接受 `true`/`false`，对应 TOML `limits.watchdog_disable`。环境变量覆盖 TOML。watchdog 覆盖连接/传输失败、请求与流空闲超时、提前断流、HTTP 408/429/5xx，以及 SSE 明确报告的限流/服务不可用。求解、子 Agent 与上下文摘要采用同一策略，250 ms 指数退避、最长 30 秒；取消、显式 Goal/研究 worker 时间预算及显式 Workgroup 实际请求预算仍有效。401/403、无效请求、额度不足、长度上限和空回复不进入无限重试。

求解和摘要的 HTTP 请求共用 Engine 与共享模型池容量；外层恢复和 HTTP 内部重试均先释放失败请求的全部许可，再退避、排队并重新计入请求额度。退避不计入模型池活动占用，活跃流仍持有许可。已准入但在取消时未观察到最终用量的尝试保持 UNKNOWN，不假设为零。`network.retry_mode="bounded"` 对每个当前求解或摘要请求最多执行五次 Core 网络恢复，再报告失败；`persistent` 仍保留持续恢复。五次额度耗尽后不借 `max_completion_retries` 继续网络重放；接受完整响应后新的逻辑请求重新计数。HTTP `model.max_retries` 仍独立存在，所有实际准入都参与原请求/任务预算。未知用量和已执行工具不因恢复而清零或重放。本地部署可以显式选择 bounded；这不宣称其在所有可用性条件下优于 persistent。

`bounded` 不再等价于 `limits.watchdog_disable=true`：前者有限恢复断流和暂时网络失败，后者保留显式关闭 Core 网络恢复的旧语义。两者可以分别配置；关闭开关优先，环境变量 `AREAL_HARNESS_WATCHDOG_DISABLE=0` 恢复所选模式，而 `AREAL_HARNESS_NETWORK_RETRY_MODE` 可覆盖模式。默认仍为 persistent。持续模式和有限模式都在退避前释放求解/摘要容量，取消、Goal 未知用量及未结算工具仍禁止自动重放；次数上限不等于整个任务的墙钟期限。


Goal 的共享预算与未知用量约束优先于重试配置。Goal 请求禁用 HTTP 内部重试；失败或超时产生未知消费时保留预算预留并停止自动推进，watchdog 与有限重试额度均不能绕过此限制。

`limits.max_completion_retries` 默认为 0、范围 0–8，是每 Turn 的有限未完成响应恢复额度，与 HTTP `max_retries` 和网络 watchdog 分开；关闭 watchdog 不关闭已有的有限重试。恢复条件与审计见 [Core API](../api/core.md#recovery)。HTTPS 使用公开根证书和宿主系统信任库；私有 CA 应安装到信任库。工具调用仅来自协议结构化字段，正文中的 XML/JSON 不作为调用执行。

`resources.max_tool_buffer_bytes` 默认 4 MiB，约束每个响应缓冲的工具 id、name、arguments；单调用参数仍最多 64 KiB。`resources.max_response_tool_calls` 默认 128，有效值取该保护与显式 Turn 剩余调用预算的较小者。`resources.max_response_bytes` 默认 4 MiB，约束单响应的文本、推理、provider context 和模型二进制输出。这些保护独立于累计执行预算。Chat/Responses 共用工具缓冲检查，重复的 Responses 终态条目不重复计数。新增环境变量后缀为 `MAX_RESPONSE_TOOL_CALLS`、`MAX_RESPONSE_BYTES`、`CONTEXT_MODE`、`CONTEXT_RECENT_TOKENS`、`CONTEXT_TARGET_TOKENS`、`MODEL_CONTEXT_WINDOW_TOKENS`；旧环境变量保留。

`[budget]` 中 `max_tool_calls`、`max_output_bytes`、`max_history_bytes` 默认 0（无限）；正数分别显式限制每 Turn 调用数/累计输出和每 Thread 存储历史，压缩不会重置这些预算。历史计入热快照和引用的冷分段。旧配置中的显式有限值保持原意，两个 schema 版本中省略字段均采用新的无限默认。资源容量仍需正数，子任务数/深度可为 0。`max_threads=20000` 是部署会话容量，不是单会话长度预算。空闲超时用于检测停滞请求，不是整个任务的运行时长。`[network] retry_mode` 默认 persistent，也可为 bounded（当前请求最多五次 Core 网络恢复）。`config show` 展示新分组并保留旧 `limits` 诊断对象；旧别名来源键继续归一化，`network.retry_mode` 保留独立来源。

`network.model_request_timeout_seconds` 默认 300，限制每次模型请求到首个成功事件的总等待时间，包括共享模型许可等待、请求准备与 HTTP 重试。收到响应头不会重置该期限。首个事件之后，`network.stream_idle_timeout_seconds` 默认 30，限制相邻事件间的空闲时间。Activity 和用量事件即使没有可见文本也会刷新空闲期限。两项配置均接受 1–86400 秒，对求解与压缩摘要请求生效，也可使用 `[limits]` 下的同名字段。超时保留 `LLM_RESPONSE_TIMEOUT` 分类及现有 watchdog 恢复策略。这些限制不约束整个 Turn 的运行时长。

| 环境变量（前缀 `AREAL_HARNESS_`） | 对应配置 |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | 模型名称、provider、完整 URL、协议与凭据引用 |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | 模型参数 |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | 采样参数 |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_COMPACTION_ENABLED` | 可选上下文 token 预算与压缩开关 |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | server、扩展文件与日志 |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | 并发与任务容量 |
| `MODEL_REQUEST_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | 首个模型事件期限与后续流空闲期限 |
| `NETWORK_RETRY_MODE` | `network.retry_mode`；persistent 或 bounded，默认 persistent |
| `WATCHDOG_DISABLE` | `limits.watchdog_disable`；`1` 关闭，默认 `0` |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `MAX_TOOL_BUFFER_BYTES`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | 历史、工具与上下文预算 |

未知 `AREAL_HARNESS_*` 报错。旧 `AREAL_MODEL*` 与 `RUST_LOG` 为低优先级兼容别名。无 provider 文件记录的旧模型入口可使用可选 `AREAL_API_KEY`；显式文件 provider 不隐式继承它。

### 桌面加载与执行限制

传输限制与模型执行预算分别生效。提高其中一个不会放宽其他通道的限制。大小按编码后的字节计算，MiB 为 1,048,576 字节。

| 边界 | 当前限制 | 达限后的行为 |
|---|---|---|
| Core 入站请求 / 出站消息 | 4 MiB / 64 MiB | 超大响应返回 `RESPONSE_TOO_LARGE`，其他聊天仍可读取，失败的缓存视图禁止发送新任务；超大通知关闭连接，停止被动重连。历史未被删除，也不会自动重放提交 |
| 桌面共享服务聚合投影 | 256 MiB 接收；发送前缓冲检查为 32 MiB | 多个大聊天仍可能超出聚合传输能力；64 MiB 单消息限制不保证整体内存有界 |
| Core RPC / 桌面后台 RPC | 默认 30 秒 / 150 秒 | 等待失败不表示后台已停止。只读失败不标记提交结果未知；写入结果未知时查询原 requestId，不自动重发 |
| 每条 Core 连接的观察订阅 | 128 个，聊天与 Task 共用 | 达限拒绝新订阅。已缓存聊天全部恢复时仍可能耗尽容量；不是磁盘历史数量上限 |
| 连接测试 / 模型目录获取 | 30 秒，响应 1 MiB | 探测失败不等于 Core 退出。API 目录最多返回 64 个模型，ChatGPT 目录最多 256 个，当前没有截断提示 |
| ChatGPT 本地代理模型请求 | 16 MiB | 即使提高 `model.max_request_bytes`，此代理仍会拒绝更大的请求 |

Core 发送队列为 256 条，聊天事件窗口为 128 条，单次 socket 写入限时 5 秒。队列过载或慢消费者会断开连接以防止不完整投影继续使用。桌面自动重连退避从 500 ms 增至最多 30 秒；明确的消息大小错误需要用户操作，不反复重连。

这些桌面限制不可通过 `[budget]` 调整。历史加载目前仍会在编码前完整物化，尚未提供分页恢复。Core 协议和超大结果的处理见 [Core API](../api/core.md#传输与会话)。模型输出、上下文、网络重试和 Runtime 子进程预算继续按各自配置生效。

<a id="proxies"></a>
## 出站网络代理

Core 的模型请求（含摘要、子 Agent 与 Workgroup）、Streamable HTTP MCP 和可选 OTLP HTTP 导出支持 `http://`、`https://`、`socks5://`、`socks5h://` 代理。代理协议与目标 URL 协议独立：例如 HTTPS 模型接口可通过 HTTP CONNECT 或 SOCKS 代理访问。HTTPS 代理和 HTTPS 目标都保持证书校验；私有 CA 须受对应 HTTP 客户端的信任库信任。

使用启动 Core 时的标准环境变量；无需在 TOML 中重复配置：

| 环境变量 | 用途 |
|---|---|
| `HTTP_PROXY` / `http_proxy` | HTTP 目标的代理 |
| `HTTPS_PROXY` / `https_proxy` | HTTPS 目标的代理 |
| `ALL_PROXY` / `all_proxy` | 未设置对应协议代理时的回退 |
| `NO_PROXY` / `no_proxy` | 绕过代理的域名、IP 或 CIDR，逗号分隔；`*` 绕过全部 |

Core HTTP 客户端优先读取大写变量，再读取小写变量；第三方工具的优先级由其 HTTP 库决定，建议大小写值保持一致。`socks5` 在本地解析目标域名，`socks5h` 交给代理解析。HTTP(S) Basic 和 SOCKS5 用户名/密码可通过代理 URL 的 userinfo 配置；该 URL 可能包含凭据，不应写入仓库或共享诊断。

macOS GUI 后台启动时通过系统 `scutil --proxy` 读取活动网络的静态 HTTP、HTTPS 和 SOCKS 代理，转换成上述环境变量后传给 Core；模型设置的模型发现、连接测试及 ChatGPT 订阅请求使用同一代理快照。系统 HTTPS 代理使用 HTTP CONNECT，系统 SOCKS 使用 `socks5h`，由代理解析目标域名。macOS 的 SOCKS 连接先经 GUI 后台的 loopback TCP 转接，再连接配置的上游代理，以兼容原生 Core 无法直接完成部分系统代理握手的情况；认证、SOCKS 数据和 TLS 原样透传。后台以权限 0600 保存转接端口和上游地址摘要，重启复用端口，不保存代理密码；代理 URL 及绕过规则的含义不变。优先级为对应协议的显式环境变量、显式 `ALL_PROXY`、系统对应协议代理、系统 SOCKS；大小写值统一为 Core 的大写优先规则。系统域名、IP 和 CIDR 绕过条目与已有 `NO_PROXY` 合并，`*.example.com` 转换为包含根域名的 `.example.com`；localhost、其子域、127.0.0.0/8 和 ::1 始终绕过。此路径不执行终端启动脚本、不修改系统设置；不解析 PAC、自动发现、仅排除简单主机名的选项或任意位置的通配符。其他系统沿用代理环境变量。更改系统代理后，等待任务完成，在 GUI“后台服务”中停止后台服务并重新连接，以重新读取并应用设置；只关闭窗口不会刷新后台环境。显式启用的 Responses WebSocket 仍遵循本页说明的直接连接限制。

例如使用 SOCKS5 远端 DNS，并保留已有绕过条目：

```sh
export ALL_PROXY='socks5h://127.0.0.1:1080'
export all_proxy="$ALL_PROXY"
export NO_PROXY="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"
areal service restart --workspace /absolute/workspace --json
```

已有 `HTTP_PROXY` / `HTTPS_PROXY` 及其小写值会覆盖对应目标的 `ALL_PROXY`；统一走 SOCKS 时需同步调整这些变量。共享服务保留启动环境，修改变量后必须在新环境中显式 restart，只重开 TUI/Web 不会刷新后台进程环境。自定义配置或部署参数按[共享服务契约](../api/local-service.md)传给 restart。本地服务发现和登录 HTTP 请求固定直连，避免将 loopback 认证发送到外部代理。

可信 stdio MCP 与插件 Host 自动继承上述八个代理变量，包括代理 URL 中的认证信息；其他环境仍按各自白名单处理。`web_search` 等外部工具须使用支持相应代理协议与环境变量的 HTTP 库；Core 不拦截其自建 socket，也不替远程 MCP 服务配置它到搜索供应商的网络。Runtime 命令环境及网络授权保持独立，代理不扩大 Scope 权限。具体边界见 [MCP](mcp.md) 和[插件](../design/plugins.md)。

## 桌面通用设置

设置页的“终端”提供“继承系统终端 Profile”和字体覆盖。继承默认开启，尝试读取当前用户的 iTerm2、macOS Terminal 或 Kitty 外观配置。字体覆盖优先；清空后恢复自动选择。字体、字号和 ANSI 配色对新建或重新打开的终端生效，现有终端不重启。应用仍管理终端基础背景与文字颜色。检测失败使用默认外观。登录 shell 保留原有启动方式，受限 Runtime 的 HOME 和权限不会因此扩大。

“网络”可保存 HTTP(S) 代理、逗号分隔的绕过地址和 PEM 根证书文件绝对路径。显式代理覆盖环境和系统代理；清空后恢复原有发现规则。应用代理字段不接受凭据，需认证的代理继续使用前述环境变量入口。绕过地址支持主机名、域名后缀、IP 和 CIDR。本机控制连接始终直连。自定义证书增加可信根，不关闭主机名、有效期或证书链校验。文件只接受自签名 CA 的 PEM bundle，最多 1 MiB、128 张证书。Chromium 的附加信任校验支持关键的基本约束、密钥用途、扩展密钥用途和主机名扩展，拒绝其他关键扩展。设置由 Desktop 保存，不修改系统代理或系统证书库。

代理和证书供 Core HTTP 模型、模型连接测试、订阅连接、可信 MCP 与插件宿主使用。完整访问权限下允许联网的 Runtime 命令也接收代理与证书环境；第三方命令仍需支持相应环境变量。网络权限不会扩大。显式 Responses WebSocket 的直连限制保持不变。Chromium 主会话和共享内置浏览器也使用显式代理与证书；代理留空时浏览器跟随系统代理及其绕过规则，应用中的绕过列表只在显式代理下用于 Chromium。

修改网络设置或“Chromium 硬件加速”后，等待活动任务完成，再完整退出并重新启动应用。保存不会自动重启任务。硬件加速默认开启，关闭可用于排查显卡驱动导致的渲染异常。

“任务通知”是完成、权限审批和提问通知的总开关，关闭时保留分类和声音偏好。重新开启不补发关闭期间的旧通知。“交互行为”复用现有排队和调整方向功能。排队等当前运行结束后发送；调整方向请求中断当前输出并在同一轮继续，不承诺立即停止工具。⌘/Ctrl+点击发送临时反转所选行为。

`pnpm --dir clients/gui run test:desktop-settings` 验证隔离 Electron/Core 设置保存、终端外观和重启行为；`pnpm --dir clients/gui run test:desktop-network` 验证本地代理与 TLS 边界。这些专项不代表安装包、真实供应商或其他平台验收。

## 诊断与运行时目录

```sh
target/debug/areal config validate --config /absolute/config.toml
target/debug/areal config show --sources --config /absolute/config.toml
```

诊断不监听、不创建数据、不启动 Runtime/MCP/插件，也不探测模型；输出有效值和来源并脱敏。共享本地服务支持下述模型配置热更新；启动凭据不进入 Runtime 环境。`OTEL_*` 由 server 的 telemetry 装配处理。

桌面运行时 provider 目录使用 `areal/provider/*` 和 `AREAL_CREDENTIAL_<ref>`；只支持 chatCompletions/responses。TOML 中的供应商在启动时装配，运行时目录是执行投影；配置管理的 ID 拒绝 upsert/remove。`--desktop-config` 装配版本化 Profile/Skill/Workflow；使用 `--agent code-agent@v2` 启动 TUI、headless 或 `exec` 时选择 Profile，Profile 绑定的 Workflow 会随 Thread 自动启动，不再额外传 Workflow 参数。会话显式配置按 revision 更新，见[桌面契约](../api/desktop.md)。

```sh
target/debug/areal --desktop-config deployment.json --agent code-agent@v2
target/debug/areal --desktop-config deployment.json --agent code-agent@v2 --prompt "检查当前改动"
target/debug/areal exec --desktop-config deployment.json --agent code-agent@v2 "运行测试"
```

`deployment.json` 中让 Profile 绑定工具与 Workflow；同一文件可保留不带 Workflow 的 Agent：

```json
{
  "profiles": [
    {"id":"tool-agent","revision":"v1","displayName":"Tool agent","instructions":"检查并报告结果。","toolAllowlist":["fs_read","run_command"]},
    {"id":"code-agent","revision":"v2","displayName":"Code agent","instructions":"按阶段完成并验证任务。","toolAllowlist":["fs_read","run_command","fs_apply_patches"],"workflow":{"id":"code-flow","revision":"v1"}}
  ],
  "workflows": [
    {"id":"code-flow","revision":"v1","displayName":"Code flow","plan":{"objective":"修改并验证代码","tasks":[{"id":"implement","instruction":"修改 src/main.rs 并运行测试","writes":["src/main.rs"],"configuration":{"agentProfile":{"id":"code-agent","revision":"v2"}}}]}}
  ]
}
```

此示例是显式绑定 Workflow 的兼容部署：`tool-agent@v1` 可直接使用允许的工具；`code-agent@v2` 需要可信 `--workgroup-policy` 和 `--allow-write`，策略须授权 `src/main.rs` 并提供最终检查，详见 [Workgroup 指南](workgroups.md)。Workflow 计划由绑定 Profile 自动启动，`--prompt` 或 `exec` 的普通 Turn 是独立的用户交互。

### GUI 与 CLI 共享模型目录

`areal config models read [--config /absolute/config.toml]` 输出 JSON：`path`、文件内容 revision、`data`（供应商目录）、`defaultModel`（文件值）、`credentialStates`（供应商 ID 到凭据状态的映射）、`credentialSources`（凭据来源）和 `effective`（经过 CLI／环境覆盖的诊断，含 sources）。读取不创建文件、缺少密钥不阻止管理读取。`credentialStates` 使用 `notRequired`、`available`、`unavailable`，由 Core 按当前可信环境和解析后的凭据引用判断；不包含密钥，不影响文件 revision，也不代表远端认证或推理已通过。`areal config models write` 从 stdin 接收 `{ "expectedRevision": "...", "data": [...], "defaultModel": { "providerId": "local", "modelId": "one" } }`；传 `null` 清除默认值。接口完整替换模型目录，保留其他配置和注释，输出新快照。两个入口必须使用同一文件才共享；环境覆盖不会写回文件。

`credentialSources` 使用 `none`（无需认证）、`environment`（环境变量凭据）、`stored`（已保存凭据）。可信适配器调用 read/write 时可重复传 `--stored-credential-env NAME`，声明由安全存储注入的环境变量名；Core 根据实际解析的引用判定来源，并独立校验该值是否就绪。此来源信息不持久化、不改变 revision、不使缺少值的引用变为可用。独立 CLI 不传此参数，其凭据来源为环境变量。GUI 的“认证方式”可选择“无需认证”：保存时通过 Core 移除该供应商的 `api_key_env`，应用后新模型选择不发送认证头；旧任务仍保留原凭据引用。API Key 输入留空保留已有引用；没有引用和新密钥时不能保存为 API Key 模式。GUI 不读取终端启动脚本，环境凭据按应用／后台启动时的环境提供。

```toml
schema_version = 1
[model]
catalog_version = 1
provider = "local"
name = "one"
[model.providers.local]
name = "Local model service"
endpoint = "http://127.0.0.1:8000/v1/chat/completions"
protocol = "chat-completions"
enabled = true
api_key_env = "LOCAL_MODEL_KEY"
parameters = { temperature = 0.2 }
models = [
  { id = "one", display_name = "Primary", enabled = true, parameters = { reasoning_effort = "low" } },
  { id = "two", enabled = false, parameters = {} },
]
```

JSON 使用 camelCase（`apiKeyEnv`、`displayName`、`maxOutputTokens`、`reasoningEffort`），协议仍为 `chat-completions` / `responses`。最多 32 个供应商，每个最多 64 个模型。供应商与模型都支持启停、名称和参数；参数按显式会话、模型、供应商默认值叠加。全局 TOML／环境／CLI 参数仍遵循原优先级。文件默认引用必须指向启用的供应商与模型。旧单模型 TOML 无需立即改写，选中的名称作为目录项；首次共享保存会添加 `catalog_version = 1`。仅含原有字段的旧供应商表可以省略 endpoint，由环境变量或 CLI 补齐，仍遵循 CLI > 环境变量 > 文件的优先级。共享目录读写要求供应商在文件中提供完整 endpoint；未补齐时读取明确失败，不丢弃供应商，也不将临时覆盖写回文件。

普通配置只保存密钥环境变量名。共享接口拒绝带查询参数的 endpoint，避免把 URL 中的认证信息送入 GUI；旧配置诊断仍脱敏查询参数。桌面安全存储不向独立 CLI 暴露，CLI 自行提供引用变量。`areal_openai` 为桌面动态账号目录保留，允许作为默认引用，禁止写为静态供应商；独立 CLI 缺少账号传输端点时明确失败。

写入先校验、检查整个文件 revision，再使用同目录临时文件、fsync 和原子替换；合作写入者通过锁串行，过期请求失败。默认缺失文件可以首次创建，显式缺失文件和写入符号链接拒绝。非合作编辑器不参与锁，多次摘要校验不等于文件系统原子 CAS。


自定义模型可设置 `capabilities = { tools = true, vision = false, reasoning = true, reasoning_effort_options = ["low", "high"] }`。这些字段只声明该模型支持的工具、图片输入和推理；不增加媒体生成能力。省略能力声明保留旧协议行为。GUI 新添加的模型默认开启工具和推理；没有明确的能力声明时预选低、中、高、极高四档。模板已声明的能力、用户显式关闭、自定义强度及模型／供应商默认参数保持不变；已知默认强度超出四档时也保留为可选值。新草稿按上述顺序选择并提交受支持的具体强度，不凭模型名称猜测供应商行为；已有会话不自动改写。已有模型不自动迁移；编辑时主动清空强度列表仍沿用原有六档。`max` 可作为显式允许值，仍须远端支持。关闭推理时不发送遗留的推理参数。

共享目录采用保存／应用分离。仅写入 `catalog_version = 1` 文件不会改变运行实例；GUI 保存后通过[模型配置热应用接口](../api/desktop.md#模型配置热应用)把精确文件版本应用到已连接 Core，并由其重新读取和校验权威文件。新增的安全存储凭据通过受保护的本机请求注入，只追加不可变引用，不改变进程环境；Core、Runtime 和现有连接保持原代际。未启动实例下次加载。已有历史、活动请求和已受理队列保留原快照。旧会话的新请求可在端点、协议与凭据引用一致时刷新容量报告和模型能力；其他参数继续遵守会话覆盖规则；轮换后不得删除旧任务所需的凭据。旧 Core 不支持热应用时，GUI 在写入前提示更新后台。非模型部署变化仍要求显式安全重启。

多个项目各自原子应用，不构成跨进程事务。只有全部确认目标版本且文件版本仍匹配时才完成保存。已确认的部分失败先对文件做 CAS 补偿，再应用实际产生的恢复版本；外部写入、活动任务或未知请求阻止恢复时保留“待应用”和草稿，不宣称全部恢复，不自动取消任务或重启。

GUI 设置页分别显示 Core 已保存的启用状态、凭据来源与就绪状态、配置应用状态；未保存的开关或密钥输入保留为草稿。桌面适配器把安全存储中的凭据提供给 Core 诊断，Renderer 只接收状态。当前文件 revision 与项目已加载 revision 不一致时显示“待应用”；安全应用成功后刷新项目的 Core 模型目录。Composer 模型目录只显示已启用且可用的模型。停用或缺少凭据的模型不显示为选项，诊断保留在设置中。历史模型身份保留在入口，不自动切换。GUI 数据目录隔离意味着共享配置中的凭据引用可能在另一个 GUI 实例中不可用，状态按当前实例诊断。

## 模型配置热更新

共享 TUI/Web 服务每秒读取选定 TOML，连续两次读到同一有效配置后应用。默认模型、端点、协议、凭据引用和采样/推理参数变更用于后续新提交；显式 CLI/环境覆盖仍有更高优先级。非法编辑保留旧配置，TUI/Web 显示错误。独占 launcher 和独立 Core 仍只读取启动配置。

活动 Turn、其子任务、摘要和已入队请求保持原模型版本；会话显式选择的模型保持不变。Goal 自动续轮在下次提交边界使用当时的默认值。默认模型版本保存在私有 `dataDir/desktop/default-models.json` 中，供队列跨重启恢复，最多 128 个版本、1 MiB；不保存环境凭据值。退役凭据缺失时拒绝对应队列项执行，不替换成其他模型。迁移历史时需同时保留此文件。

其他配置需要重启。TUI 等待 Turn、Goal、队列和资源结算后重启；`areal service ensure` 也会为空闲服务应用 TOML 或二进制更新。权限/部署变化和模型 CLI/环境覆盖变化需带目标参数执行 `areal service restart`。模型文件变更在 3 秒内未完成热更新时，共享入口会尝试空闲安全重启；解析、归档或持久化错误保留旧服务并报告具体原因。若新凭据引用不在旧服务环境中，服务同时报告错误和 `restartRequired=true`；在持有新凭据的终端重新打开 TUI/Web 或执行 `areal service ensure`，客户端先校验配置和凭据，再自动安全重启。忙碌时拒绝本次应用，工作结算后重试。新终端环境变量不能直接更新现有进程；仅修改同名凭据的值或代理环境、不改变模型配置时仍需显式重启。默认重启拒绝忙碌服务；`--cancel` 才显式取消并结算工作。

<a id="tui"></a>
## TUI 偏好

`${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`，可用 `--tui-config` / `AREAL_TUI_CONFIG` 替代。字段为 `theme=dark|light|terminal`、`color=auto|always|never`、`no_logo=false`、`ascii=false`、`mouse=true`。优先级 CLI > `AREAL_TUI_*` > 文件 > 默认；非空 `NO_COLOR` 强制关闭颜色。`--prompt` 和 `--goal` 不读此文件。

可用 `--mouse=false`、`AREAL_TUI_MOUSE=false` 或文件中的 `mouse = false` 关闭鼠标捕获。默认开启；关闭后历史仍可通过键盘完整操作。

Skill 自动发现见[Skill](skills.md)，工具配置见[工具](tools.md)，部署权限见[Runtime](runtime.md)。

<a id="goals"></a>
## Goal 执行策略

Goal 通过 `/goal <目标>`、Web 面板、`--goal` 或 API 显式创建，无需额外开关。下面的可选 TOML 配置只调整执行限制；省略整个 `[goals]` 表时使用默认值。

```toml
[goals]
max_turns = 0
max_active_seconds = 0
max_unreported_turns = 3
turn_model_rounds = 0
```

示例数字为默认值。`max_turns`、`max_active_seconds`、`turn_model_rounds` 的 0 表示无部署上限；正数分别接受 1–86400、1–86400、2–1024。显式请求/会话限制仍生效，并与正数部署上限取交集。未设置的 Goal token/轮次/时间预算保持无限。GUI 用 inferLimits 请求模型解释目标中的显式限制；需允许 goal_set_limits，有轮次限制时至少三轮。有上限的根 Turn 至少两轮，最后一轮禁用工具以交接。`max_unreported_turns` 仍默认 3（1–86400），属于进度完整性保护：连续根 Turn 未提交 goal_update 时暂停为 progressUnreported。

活动时间包括根 Turn 的模型排队、执行、工具、交互等待和清理，子任务时间不叠加，轮次间容量等待、暂停和离线时间不计入。显式研究 worker 预算和 Runtime 硬限额继续生效；普通 Turn 没有总时限。Goal 请求禁用 HTTP 层隐式重试，以保留逐次消费的归因；未知消费会停止自动推进。使用与恢复见 [Goal 模式](clients.md#goals)。

连续内置只读工具的并发候选也使用该 JSON：`{"policy":{"parallelReadCalls":4}}`。范围为 1–4，默认 1；显式选择 4 允许有界并发，不扩大模型、工具或输出总预算。未知后端和有状态工具保留屏障，匹配的 hooks 与有限输出等条件下保持串行，见[Core 契约](../api/core.md#工具并发与执行进度)。未经来源隔离确认，不作为全局性能默认值推广。

`ToolPolicy.completionFocus`（JSON `completionFocus`）是默认 false 的显式行为实验。启用后提示 Agent 先完成用户要求的交付与必要验证，仅为具体未解问题增加复查，子任务按自身边界及时交接，空闲时使用较长等待与回执游标。计划应提前明确有限验收证据，让文档、检查准备与实现并行；后期集成验证须观察已应用输入，不能把隔离快照中准备的脚本当成最终验收。必需交付、相关验收及资源结算完成后及时答复，不把可选截图、额外检查或反复更新计划追加为收尾条件。它不强制 final、不免除验收、不扩大预算，也不推断题目要求。示例：`{"policy":{"parallelReadCalls":4,"completionFocus":true}}`。隔离 worker 继承纯工具策略；缺少未见来源证据时不推广为全局默认。

`ToolPolicy.executionFocus`（JSON `executionFocus`）是默认 false 的独立行为实验。启用后，Core 提示 Agent 在同一回复批量请求已知且独立的读取；对下一步必须等待结果的有限命令，优先使用工具已声明的等待默认值；仅在交互、明确期限或实际独立工作需要时选择短等待。依赖读取、写入、进程游标及 UNKNOWN 保持原有顺序和语义。该策略不改写模型指定的 yieldMs/waitMs，不改变预算、验证要求或取消行为；隔离 worker 继承纯工具策略。示例：`{"policy":{"executionFocus":true,"parallelReadCalls":4,"resultViews":{"mode":"on"}}}`。这是一组显式组合实验，不可把组合效果归因于单项，也不能以机制测试替代真实任务及未参与调优来源的效果确认。

工具结果视图通过 `[tools] extensions_file` 指向的 JSON 配置，在 `policy.resultViews` 下设置 `mode: off|observe|on`（默认 observe）及 `searchGroups`、`repeatLines` 开关。大结果快照与内置 rg 不依赖该开关；额度和回取行为见[工具指南](tools.md)。

## 持久轨迹导出

`[trajectory]` 为本地 TUI、GUI、`exec` 和服务提供可选的数据采集模式，默认关闭。启用后，Core 将轨迹 Events/Logs 放入有界内存缓冲，由后台线程保存到用户级磁盘队列；独立上传进程通常等待所属 Turn 的终态记录后，逐条发送标准 OTLP HTTP/protobuf 到接收端。生产进程结束或崩溃时也允许补传已落盘的不完整记录。为避免终态丢失造成永久积压，单条记录入队满 5 分钟后，即使生产进程仍存活也允许上传；因此超长 Turn 可能先同步部分轨迹，随后追加终态。接收端须将缺少终态的内容视为不完整，不能据此推断成功。Agent 返回和关闭流程不等待网络上传；独占 CLI 退出后，上传进程仍可处理已经落盘的数据。此功能不依赖特定接收平台或对象存储：接收端负责归档、索引、分析来源登记和后续训练数据管理，配置一个 OSS 对象地址不能代替 OTLP 接收服务。

```toml
[trajectory]
enabled = true
endpoint = "https://collector.example.com"
# headers_env 与 headers_file 二选一，均为凭据引用。
headers_file = "/absolute/private/trajectory-headers.txt"
# 默认用户配置使用 <AREAL_HARNESS_HOME>/trajectory；独立配置文件自动隔离队列。
max_disk_bytes = 268435456
max_memory_bytes = 16777216
max_batch_bytes = 4194304
max_records = 2000
max_retries = 6
retry_initial_seconds = 5
retry_max_seconds = 300
request_timeout_seconds = 10
upload_interval_ms = 1000
```

`endpoint` 是 HTTP(S) 基地址，自动追加 `/v1/logs`，已带该后缀时不重复追加；禁止用户名、密码、查询参数和片段。凭据采用标准 OTEL 逗号分隔的 `key=percent-encoded-value` 格式，例如 `authorization=Bearer%20TOKEN`。`headers_env` 指向独立上传进程启动时继承的环境变量快照，重启 Core 不保证刷新已经存活的上传进程；需要持久配置或轮换凭据时推荐 `headers_file`。该文件须为权限 0600、不超过 16 KiB 的普通私有文件，发送前重新读取。两者不能同时设置。相对文件路径基于 TOML 所在目录。凭据值不写入配置诊断、CLI 状态或 GUI。

| 字段 | 默认值与约束 |
|---|---|
| `enabled` | `false`；仅显式启用才采集 |
| `spool_dir` | 默认用户配置使用 `<AREAL_HARNESS_HOME>/trajectory`；其它配置文件使用 `<AREAL_HARNESS_HOME>/trajectory-sources/<source_id>`，同一配置的跨工作区 Core 与 CLI run 共用 |
| `max_disk_bytes` | 256 MiB，1 MiB–1 TiB；只限制遥测副本，不计入权威会话历史 |
| `max_memory_bytes` | 16 MiB，1–1 GiB；采集缓冲字节预算 |
| `max_batch_bytes` | 4 MiB，1–64 MiB，且不超过内存和磁盘预算；单条 OTLP 发送内容上限，当前逐条保存和发送 |
| `max_records` | 2000，1–10000；保留的发送记录数量上限 |
| `max_retries` | 6，0–100；首次发送以外的自动重试次数 |
| `retry_initial_seconds` / `retry_max_seconds` | 5 / 300 秒，1–86400；最大值不小于初始值 |
| `request_timeout_seconds` | 10 秒，1–86400；单次网络请求超时 |
| `upload_interval_ms` | 1000 毫秒，1–86400000；单 worker 发送间隔 |

网络故障与 OTLP 可重试状态码 429、502、503、504 按指数退避处理，其它 4xx/5xx 保留为失败而不自动重试。支持秒数及 HTTP-date 两种 `Retry-After`；`retry_max_seconds` 只限制本地退避，不截短接收端要求的等待时间。同一地址重启保留已保存的等待下限；切换地址不继承旧地址的全局退避，也不改写旧记录自身的重试时间。被标记 `destination_changed` 的旧记录须切回原地址并显式 `retry` 才重新排队，此操作重置该记录的重试预算和等待时间。只有 HTTP 200、`application/x-protobuf` 响应类型和有效 protobuf ACK 才确认送达，部分拒收不自动重试。耗尽重试后保留失败记录供人工重试。内存缓冲满或单条内容超限时丢弃该遥测副本并累计计数；磁盘/记录额度不足时按顺序回收旧副本并记录淘汰。事件在进入队列前因身份、序号竞争或内存限制被整体丢弃，也计入 `dropped_memory`，由后台尽力保存；单个字段截断使用轨迹中的截断标记，不重复计为整事件丢弃。上传成功后释放本地正文，保留有界状态元数据。这些策略不删除 Core 的权威会话历史，也不改变 Turn 成败。此路径不提供零丢失保证：强杀前尚未落盘的事件和诊断计数可能丢失，正常退出时采集处理器最多等待 200 ms 完成本地落盘，上传重试可能产生重复记录，接收端应按记录身份去重。采集处理器的 200 ms 等待上限不代表整个 Core 退出有统一硬超时；现有后台诊断遇到不可中断的磁盘 I/O 时，可能延后进程退出，但不改变已经完成的响应。

安装标识读取、队列初始化、历史清理及 JSON 结构化均在后台执行。消息和工具内容在共享内存、节点数及 32 层深度预算内转换为嵌套 OTLP 值；结构化超出预算时保留完整原 JSON 字符串并标记 `areal.capture.json_fallback=true`，不代表内容丢失；只有采集字段确实丢失才标记 `areal.capture.truncated=true`。非法 JSON 或无法无损表示的值保留原文，不保证所有内容都成功结构化。内存额度约束新增采集缓冲，不能等同于整个 Core 进程的 RSS 上限。

队列归属由有效配置文件的规范绝对路径派生，内部 `source_id` 不接受 TOML 设置；内容更新、同一文件的路径别名不会改变身份。同一配置的多个 Core 可共享队列，不同配置默认隔离，避免另一份配置的关闭开关或接收地址覆盖当前采集。显式指定同一个 `spool_dir` 不会合并配置所有权：已有不同归属时报告配置冲突，不覆盖控制或读取其它配置的轨迹。删除 `spool_dir` 配置可恢复默认隔离路径，旧队列保持原位。后台初始化在队列锁内校验原配置文件的内部版本摘要，防止延迟启动的旧快照覆盖新控制；直接修改 TOML 仍会在下一次启动时应用。切换接收地址或队列前，应先对原配置执行 `trajectory suspend`，待原上传器停止后再修改配置；旧队列中的数据不会自动迁移或改发到新地址。

通过用户配置中的 `[trajectory]` 持久启用或关闭导出。配置文件选择顺序为命令行 `--config`、`AREAL_HARNESS_CONFIG`、home 下的 `config.toml`；home 来自 `AREAL_HARNESS_HOME` 或 `~/.areal`。修改前备份原文件，保留模型等无关配置。将 `enabled` 设为 `true` 启用，设为 `false` 关闭；接收端地址、认证和部署参数由使用方管理，不属于产品默认配置或发行依赖。

`headers_env` 引用启动 Core 时的环境变量；`headers_file` 引用仅当前用户可读的 OTEL 编码头文件，二者不能同时设置。认证头使用 `key=percent-encoded-value` 格式。切换接收地址时应显式更换或清除原认证引用，避免将旧接收端凭据转交给新地址。不要把秘密写入源码、命令行或日志。

修改文件后执行 `trajectory sync-config` 应用本地上传控制，并安全重启已经运行的 Core 以装配新的采集参数。命令成功只证明本地控制已应用；远端接收、归档和展示仍须通过实际执行、`trajectory status` 和接收端回读核验。停用控制阻止后续入队和发送，在途 HTTP 请求最多等待当前超时；部署指纹包含轨迹配置，已有共享服务不会静默忽略更改。


已配置接收地址后，可在 GUI“数据飞轮”页通过开关启停：就绪开启显示浅绿，关闭、采集待应用或异常显示浅橙，并提供文字状态。开关只修改当前配置的 `enabled`，保留地址、凭据引用与队列；CLI 对应 `trajectory set-enabled true` / `trajectory set-enabled false`，可用 `--expected-revision` 传入 `status.config_revision` 防止覆盖并发编辑。从关闭变开启会恢复仍保留的失败副本，保留接收端 Retry-After；重复开启不重置已有重试预算。`sync-config --resume-retained` 供外部配置工具显式恢复失败副本，普通 `sync-config` 不重置它们。

GUI 自动在 Core 空闲且其它配置没有变化时，复用 `ifIdle` 排空和安全应用流程装配采集。运行中任务、终端和排队消息阻止自动重启，显示待应用；存在其它配置变化或应用失败时显示原因，由后台服务原有安全应用入口处理。CLI 只应用上传控制，现有 Core 的采集设置仍需安全重启。关闭不会删除缓存或原会话；已超出容量被淘汰的副本、关闭期间未采集的事件不能通过重新开启恢复。

```sh
target/debug/areal trajectory status --config /absolute/config.toml
target/debug/areal trajectory retry --config /absolute/config.toml
target/debug/areal trajectory sync-config --config /absolute/config.toml
```

这些命令均输出 JSON。`status` 不启动 Agent 或上传，显示当前文件配置、上传进程、队列数量/字节、丢弃/淘汰计数、安全错误类别及最近 100 条发送记录。记录可包含 Turn、事件名称、模型、Harness 版本和事件发生时间；模型名索引保留最多 1024 字节的 UTF-8 前缀，超长时追加省略号，原始轨迹正文保持完整；旧记录缺少这些字段时保持未知，不补造值。

采集初始化失败使用 `capture_initialization_failed`，采集线程创建失败使用 `capture_thread_unavailable`；这些安全类别与上传统计分开保存，上传成功或重试不会清除采集故障，成功重新初始化才会清除本进程或已退出进程的旧故障；共用同一配置的其它存活 Core 的故障继续保留。诊断最多保存 64 个失败进程；超出上限时保留 `capture_diagnostic_capacity`，需要更改有效 trajectory 设置后重新启动并检查全部 Core。诊断文件损坏或不可读时报告 `capture_diagnostic_unavailable`，不覆盖为健康状态。Core 本进程的状态查询优先读取内存故障。初始化后台直接尝试保存，线程创建失败则复用已有诊断后台：首次立即检查，之后每 60 秒补写，慢磁盘与锁竞争可能延迟；不为诊断阻塞 Agent 启动或事件采集。独立 CLI/GUI 读取已保存状态。spool 完全不可写或 Core 在补写前退出时，不能保证保存故障历史；状态读取本身失败时由客户端显示检查不可用，不能据此声称采集成功。故障身份绑定配置归属与有效 trajectory 设置（含目的地），不随模型或注释修订变化。已有相同配置的控制快照时，失败诊断可以跨文件修订补写，但不修改控制；成功清理和没有控制快照的写入仍校验原文件版本。若线程创建失败尚未建立控制快照，文件先被修订会阻止旧 Core 补写，需重启完成初始化。快照不包含底层错误文本、凭据或请求内容。

模型事件的 `model_call_duration_ms` 是客户端逻辑模型调用耗时，包含请求准备、网络、服务端排队、流式响应与内部重试，不包含后续工具执行，不能视为纯服务端推理耗时。Turn 终态的 `execution_duration_ms` 是 Agent 执行耗时，包含模型、工具及等待。`model_call_summary` 仅统计同一最近 100 条记录窗口内具有有效耗时的模型事件，返回调用数、总耗时、平均值与最大值；没有有效值时耗时为 `null`。上传重试不增加模型调用数，模型内部 HTTP 重试也不拆成独立调用。该窗口不代表完整历史或单个 Turn 的全量统计。`created_at` / `uploaded_at` 分别表示本地记录创建和上传成功时间，与事件的 `occurred_at` 分开；两者之差还包含队列等待和重试，不能当成纯上传网络耗时。

`retry` 只重新排队并唤醒发送器，不等待远端成功。`sync-config` 应用导出控制，不重新装配现有 Core。显式 `retry` 和启用状态下的 `sync-config` 不受自动启动的 5 秒节流限制，可在快速停用再启用或上传器退出后立即唤醒；自动恢复仍保留节流，并通过跨进程租约保持单一上传器。单次子进程启动握手最多等待 5 秒，只确认本地租约，不等待远端上传；队列和启动锁的等待另计。若仍有积压，通过 `status` 查看上传进程和错误类别。

GUI 的「设置 → 数据飞轮」在页面可见且连接正常时每 2.5 秒自动刷新，保留手动刷新和重试。GUI 会话可见时每 15 秒只读检查异常，以设置入口提示点展示；恢复正常后清除，异常不写入聊天内容。只读上报状态查询不占用正常操作的准入计数，可与模型或资源配置应用并行；不会因后台查询而拒绝应用配置，也不会因配置应用而把上报误报为失败。手动重试仍遵守原有配置应用与退出限制。两种读取共享单一在途请求，隐藏、离开页面或断线后停止相应轮询，过期响应不能覆盖当前状态。本地 TUI/exec 在进程存活期间由单一后台线程检查：首次立即检查，每次完成后间隔 5 秒，发现异常最多提示一次。慢检查不会阻塞启动、推理或退出，其结果在进程仍存活时送达；短命 exec 可能在检查结束前退出，下次启动可继续发现持久失败。exec 提示只写 stderr，TUI 使用独立状态提示，不改写聊天记录。普通远端 `--endpoint` 连接不检查本机队列；由本地启动器创建的 TUI 使用其真实配置文件身份。

非法地址、认证不可用或上报失败只影响采集/导出状态；字段类型、容量范围和冲突由配置校验拒绝。数据内容范围与下方 OpenTelemetry 轨迹相同，包含实际输入、推理、工具参数和结果；开启前应选择适合这些内容的接收端。持久导出与标准 `OTEL_*` 观测配置可分别使用，重复配置同一目的地时需考虑重复数据。

磁盘额度按当前 spool 中受管理的 payload 与状态元数据的逻辑字节数计算，另预留 64 KiB 控制开销；不包含文件系统块分配开销、无关文件或权威会话历史，也不是全机所有配置的总配额。低于 1 MiB 的配置会被拒绝；设置小于默认 4 MiB 的磁盘额度时，也须同步降低 `max_batch_bytes`。旧的低于 1 MiB 的配置需要显式提高额度，包括关闭状态的配置。

单条事件同时受内存预算和发送上限约束：后台为副本和编码保守预留八倍空间，默认配置下可进入队列的单条内容约小于 1 MiB（含逻辑输入、最终请求、输出及元数据）。`max_batch_bytes=4 MiB` 不是保证可捕获 4 MiB 事件；长上下文可显式提高 `max_memory_bytes`（例如 64 MiB）后观察丢弃和完整性状态，预算仍为所有并发请求共享。

采集内存分为 Engine 内容构造四分之一、事件字段四分之一、后台副本和编码二分之一。流式输出、摘要及输入序列化都在分配前取得共享额度；超限停止该副本的采集，业务流继续。最终模型请求包含工具 schema 与有效参数，并保留构建提交和响应模型身份。事件序号和终态清单用于检测整条事件丢失；字段、摘要和训练边界见[持久轨迹协议](../api/core.md#持久轨迹协议)。仅设置 `RUST_LOG=info` 不会启用原始轨迹采集或把内容写到终端。

### 通过标准 Collector 同时发送到多个接收端

Harness 的采集与持久上传不依赖任何平台 SDK、域名或认证头。传输使用标准 OTLP HTTP/protobuf；`areal.*` 是公开的 Harness 轨迹语义扩展，不是接收平台的私有传输协议。通用 OTLP 后端可以接收和保存这些字段，理解 Turn 完整性或生成训练样本仍需使用[轨迹契约](../api/core.md#持久轨迹协议)。当前持久上传配置只有一个目的地；多目的地使用 **Harness → OpenTelemetry Collector → 各后端**，无需在 Harness 中加入平台路由代码，也不靠重复开启两个语义不同的 `OTEL_*` / 持久通道模拟可靠扇出。

[中立配置](../../examples/telemetry/collector-fanout.yaml)针对官方 `otelcol-contrib 0.143.0`，版本、官方来源和发行归档 SHA256 固定在 [collector-pins.json](../../examples/telemetry/collector-pins.json)。将 Collector 置于用户本机或受信任的单用户 sidecar，通过环境提供两个完整 Logs 地址和私有存储目录：

```sh
export OTEL_FANOUT_STORAGE=/absolute/private/collector-storage
export OTEL_BACKEND_A_LOGS_ENDPOINT=https://backend-a.example/v1/logs
export OTEL_BACKEND_B_LOGS_ENDPOINT=https://backend-b.example/custom/logs
/path/to/otelcol-contrib --config examples/telemetry/collector-fanout.yaml
```

在 Harness 的 `[trajectory]` 中设置 `enabled = true`、`endpoint = "http://127.0.0.1:4318"`，移除不适用于该本地接收端的 `headers_env` / `headers_file`，然后应用 `trajectory sync-config` 并安全重启 Core。接收器默认仅监听 `127.0.0.1:4318`。

各后端的 `headers`、TLS/客户端证书在对应的 Collector exporter 中独立配置，并引用受保护的环境变量或认证扩展。Harness 不转发它们。共享 Collector 使用单一后端 token 时，后端看到的是 Collector 的认证账号；不会自动保留各发送者的用户归属。需要按人隔离时，使用每用户 Collector/出口身份，或经过审计的认证与租户路由，不把生产端自报的属性当作认证身份。

两个 exporter 分别持久排队、独立 ACK/重试；示例单请求上限 4 MiB、每出口待发送队列按序列化字节计 8 MiB（`sizer: bytes`，不是请求数）、单消费者、有限 10 分钟重试。存储开启 `fsync` 和启动/回落压缩。队列字节限制**不是**文件存储数据库的硬磁盘配额，压缩临时文件、数据库空间和日志仍需独立 volume/quota、容量监控及保留策略；内存限制器也不是进程 RSS 的硬上限。队列满、永久拒收、重试期限耗尽或磁盘故障仍可能丢数据；队列满时上游重试还可能让已成功后端收到重复事件，须按事件身份去重。Harness 原有内存/磁盘预算独立生效。

Harness 的 `uploaded` 只证明直接接收端 Collector 已 ACK，不证明所有最终后端已存储。末端状态由 Collector 队列指标和各接收端确认；不要把多跳 OTLP 宣称为跨后端原子提交或零丢失。上述行为遵循 [OTLP 多目的地建议](https://opentelemetry.io/docs/specs/otlp/#multi-destination-exporting)与 [Collector 持久队列](https://opentelemetry.io/docs/collector/resiliency/)。

可用仓库的有界本地互通检查验证官方实现。先从固定 release 下载当前平台归档；脚本不自动下载或安装，启动前验证 pins 中的 SHA256：

```sh
AREAL_OTELCOL_ARCHIVE=/absolute/otelcol-contrib_0.143.0_darwin_arm64.tar.gz \
AREAL_COLLECTOR_SMOKE_OUTPUT=/absolute/collector-evidence \
  node scripts/trajectory-collector-smoke.mjs
```

该检查使用隔离 Core、真实本地模型与官方 Collector；两个中立 HTTP 接收端分别正常接收和返回 503，正常后端先收齐、Agent 返回后再强杀/重启 Collector，验证故障后端从持久队列补传。入站保持 Harness 原生 protobuf，经只保存字节的回环代理取证；Collector 用标准 OTLP JSON 编码输出，以核对两端完整资源、事件身份、序号清单和实际模型请求 SHA256。输出目录可保存原始 protobuf、实际模型请求和回读内容，不包含真实用户凭据。此检查独立运行，不要求普通构建安装 Collector。

## OpenTelemetry 轨迹上报

Core 使用开源 OpenTelemetry SDK，通过标准 OTLP HTTP/protobuf 导出 Traces 和 Events/Logs。未配置 endpoint 时不启用，上报失败不改变 Turn 结果。配置在 Core 启动时读取，修改后需重启服务。

```bash
export OTEL_SERVICE_NAME=areal-core
export OTEL_RESOURCE_ATTRIBUTES='service.namespace=research,deployment.environment.name=development'
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

通用 endpoint 自动追加 `/v1/traces` 和 `/v1/logs`。也可以分别设置完整地址；信号专用配置优先于通用配置：

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20your-token'
export OTEL_EXPORTER_OTLP_TIMEOUT=10000
```

| 标准配置 | 行为 |
|---|---|
| `OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES` | 服务名和自定义 Resource 属性；服务名默认 `areal-core`，显式服务名优先于 Resource 中的 `service.name` |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_ENDPOINT` | 对应信号的完整接收地址；只设置一个信号的地址时只导出该信号 |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_PROTOCOL` | 覆盖通用协议；当前仅支持 `http/protobuf` |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_HEADERS` | 覆盖通用认证头，由 SDK 按标准格式解析 |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_TIMEOUT` | 覆盖通用超时，单位为毫秒，默认 10000 |
| `OTEL_TRACES_EXPORTER`、`OTEL_LOGS_EXPORTER` | `otlp` 或 `none`；可分别关闭信号 |
| `OTEL_TRACES_SAMPLER`、`OTEL_TRACES_SAMPLER_ARG` | 使用 SDK 的标准 Trace 采样配置 |
| `OTEL_BSP_*`、`OTEL_BLRP_*` | 使用 SDK 的标准 Trace/Log 批量队列和调度配置 |
| `OTEL_SDK_DISABLED=true` | 关闭标准 OTEL 导出通道；`trajectory.enabled` 独立控制持久轨迹 |

轨迹记录 Turn、每次模型请求、工具调用和上下文压缩。模型请求使用 `gen_ai.*` 属性与 `gen_ai.client.inference.operation.details` 事件，消息按 OpenTelemetry GenAI 的 `role` / `parts` 结构记录，Span 中为 JSON 字符串，Logs 中为结构化属性。模型输入（含系统指令）、输出、推理文本、工具参数与结果均保留实际内容，没有脱敏逻辑或脱敏开关；媒体保留 Engine 收到的引用或内联数据。重试按独立请求记录，取消时保留已收到的输出并标记未完成。

本项目扩展字段和事件使用 `areal.*` 命名空间。Logs 通过标准 Trace ID 和 Span ID 关联调用，优雅关闭时刷新批量导出。只有 Logs 时也生成本地关联 ID；Traces 和 Logs 的导出开关相互独立。当前不导出 Metrics。GenAI 语义约定仍处于开发状态，参见[官方约定](https://github.com/open-telemetry/semantic-conventions-genai)。

自动压缩使用上述有效模型 token 窗口与输出预留。已完成的历史前缀保存为不可变 SHA-256 分段，当前快照保留近期条目与 checkpoint。自动模式下，热历史原始数据超过 max(1 MiB, 8 × 窗口 token 数) 也触发滚动；只有存储压力时使用有界的已记录证据。原文保留使磁盘用量持续增长，仍受可用磁盘和单记录保护约束。兼容的完整历史读取会物化全部请求历史；有界回取使用分页 `read_history`。压缩会重建缓存前缀，应同时观察未缓存输入与任务正确性。

## 缓存诊断

使用 `python3 scripts/cache-report.py /absolute/Core-state --output cache-report.json` 汇总 `model-requests` 和 `model-requests-child`。报告按线程、协议、模型参数及请求用途比较 wire 消息块，展示完整前缀保留、工具定义变化、输入/缓存/未缓存 token 和未返回用量的请求。`usageDetails.cachedInputTokens=null` 或旧审计缺少该字段时计为未知，不补零；网络失败的未知用量不计入命中率分母。报告的字节前缀不等于供应商 tokenizer 前缀，不能证明缓存驻留。新审计在供应商返回规范 ID 时记录 `usageDetails.providerResponseId`，并记录显式返回的 `cacheWriteTokens`；它们用于关联上游日志，不推断缺失的后端路由。缓存百分比必须同时结合成功率、总输入与未缓存输入评估，不能通过填充历史或删除必要 reasoning 提升比例。

审计另外记录首次响应字节、首个非空正文 delta、首个非空思考 delta 的毫秒耗时（仅发生时才有字段）。三者口径不同，不以总请求 duration 代替首 token 延迟；加密 reasoning 无可见 delta 时保持未知。

HTTP 审计在响应返回规范、长度受限的关联 ID 时保留 `httpRequestId`（x-request-id）和 `gatewayTraceId`（x-cpa-trace-id），用于关联供应商/网关日志。不收集认证头、cookie 或粘性路由 token，也不将 trace ID 推断为后端实例。

## Responses 增量传输（实验）

`[model] responses_websocket = true` 或 `AREAL_HARNESS_RESPONSES_WEBSOCKET=true` 显式启用；默认 false，仅适用于 `protocol="responses"`。endpoint 仍填写完整 HTTP(S) Responses 地址，连接时映射到 WS(S)。服务需支持 Responses WebSocket beta 协议；此路径直接连接，不使用 HTTP 代理环境变量，也不自动降级 HTTP。

连接按模型实例、Thread 和 Turn 隔离。只有前一响应完整结束并返回完整 output 数组、非 input 参数完全一致、当前输入严格扩展前次输入与输出时，才携带 previous_response_id 发送增量；否则关闭旧连接，在新连接发送完整输入。新 Turn、凭据/模型实例变更、取消、失败、连接断开不会沿用旧续接状态。发送后失败不在传输层自动重放；Goal 用量与 Engine 重试规则继续有效。最多保留 16 个空闲会话、32 MiB 请求/输出引用，120 秒空闲后清理；长工具任务可能需要重新建立完整上下文。连接中断后已执行的工具不能自动重跑。

审计中的 body/messageBlocks 表示完整逻辑输入，transport=responses-websocket、incremental、wireInputItems 和 wireBodyBytes 表示实际传输。减少传输字节不等于减少供应商计费输入或保证 KV 命中；请同时观察缓存、延迟、失败与任务结果。摘要使用独立连接，不污染同 Turn 的求解连接。

WebSocket 求解连接携带 Core 线程 ID 作为 session-id/thread-id，以便兼容网关维持会话亲和；这不表示供应商一定采用该路由提示，也不保证跨连接缓存保留。摘要与未绑定线程的直接调用不携带求解身份。

模型配置登记表保留与 revision 绑定的原始编码；新增可选默认值不会使历史 revision 失效，也不重写排队 Turn 的引用，摘要不匹配仍拒绝篡改。不要手动格式化或编辑 Core 所有的 `desktop/default-models.json`。

`model.max_request_bytes` 独立限制媒体物化后的完整 HTTP JSON / Responses WebSocket 发送封套，包含工具定义与历史重放，默认 16 MiB、范围 1024–134217728 字节。也可通过 `AREAL_HARNESS_MODEL_MAX_REQUEST_BYTES` 设置。它是本地有界保护值，不宣称网关支持相同大小；部署需使用已核验的服务限额。编码前检查累计媒体下界，完整序列化流式计数后才分配发送缓冲；WebSocket 续接按实际增量封套检查发送限额，候选完整历史另有 128 MiB 物化保护，退回完整请求时重新检查发送限额；超限不发请求、不做网络重试，返回 `MODEL_REQUEST_TOO_LARGE`，记录阶段、实际字节/下界及限额。HTTP 413 使用相同类别并标记请求已发送。token 预算、工具展示预算和自动压缩策略保持独立；此限额不自动丢弃历史图片或任务要求。

### 参考保留与有界工具恢复

旧观察折叠、文件参考保留、重复失败硬上限和空白响应额外恢复尚无来源隔离的泛化收益结论，均默认关闭。现有配置键和 schema 1/2 别名保留；省略这些字段不再隐式启用旧候选值，显式配置的正数仍按原意生效。Engine 直接调用与 server 配置加载采用相同默认值。

| 实验配置 | 默认 | 显式候选示例 | 范围 |
|---|---:|---:|---|
| `context.observation_tokens` | 0 | 8192 | 0–2000000 |
| `context.reference_tokens` | 0 | 8192 | 0–2000000 |
| `limits.max_repeated_tool_failures` | 0 | 2 | 0–8 |
| `limits.max_empty_completion_retries` | 0 | 2 | 0–8 |

`context.observation_tokens` 是默认 0 的实验性每请求软预算，仅在 auto 压缩模式且允许回取时生效。Core 可将较早的成功文本回执折叠为首尾摘要与精确原文引用，不改写权威历史或调用参数；最近两个结果、失败、UNKNOWN、媒体、无法回取的内容和绑定不透明推理的会话保持原样。软预算不保证达成，实际发送仍经过完整请求硬预算预检。

示例是历史候选值，不是性能推荐值。仅在独立的实验 TOML 中显式设置待验证项，冻结源码、模型、根预算和比较方案；不要同时开启多项后将组合结果归因于其中一项。参考保留需要允许 `read_history`；请求索引与保护还需要同时启用 auto 观察投影及 `read_tool_result`；检查点参考证据由显式 `reference_tokens` 单独控制。未启用这些策略时，原文存储/回取、真实用户修订保留、UNKNOWN 停止、不重放副作用及失败提示继续有效。`command_stdin_closed` 属于 stdin 契约及兼容开关，仍默认 true。

`context.reference_tokens`（对应 `limits.context_reference_tokens`）是默认 0（关闭）的实验性文件保留预算。在观察投影启用的普通会话中，Core 按最近读取顺序为 `read_file` / `fs_read` 的整个已观察文本分配预算，不按文件名猜测重要性；预算不超过可用输入窗口的四分之一。最多索引 32 个读取范围，未入选的记录保留 `itemId` 和路径，可用 `read_history` 回取。分页未读部分必须继续读取。检查点也在共享请求分配器的剩余额度内优先保留这些参考，以便前缀移入冷历史后继续使用；预算不足仍可能省略。新版本的文件回执使旧读失效；shell 或外部写入无法由历史证明，使用前仍需判断是否过时。文件始终是不可信历史数据，不新增授权。原用户约束按既有输入保留规则处理，摘要要求明确列出未完成义务；这不保证模型理解或完成它们。

`limits.command_stdin_closed=true` 使 `run_command` 的非 PTY stdin 默认关闭。需要后续输入时显式使用 `stdinOpen:true`，再通过 `write_process` 的 `text` 输入，`close:true` 在输入后发送 EOF。shell 重定向照常有效，PTY 仍用控制字符。兼容旧行为可设 `command_stdin_closed=false`；命令仍受 Runtime 期限、取消和 Turn 回收约束。静默本身不代表输入阻塞，不自动杀死静默构建。

`limits.max_repeated_tool_failures` 是默认 0（关闭）、范围 0–8 的实验性执行上限，必须显式设为正数。当前 Turn 连续相同工具及解析后参数的确认失败达到阈值后，下一次调用记录为拒绝且不执行；再次不变地调用则结束 Turn。只读检查不清零；不同操作或不同参数中断连续序列。失败可能已有部分副作用，不能把拒绝或重试提示当作事务回滚。UNKNOWN 仍停止且不自动重放。此机制限制重复执行，不保证修复失败原因。

消融可使用环境变量 `AREAL_HARNESS_CONTEXT_OBSERVATION_TOKENS`、`AREAL_HARNESS_MAX_EMPTY_COMPLETION_RETRIES`、`AREAL_HARNESS_CONTEXT_REFERENCE_TOKENS`、`AREAL_HARNESS_COMMAND_STDIN_CLOSED`、`AREAL_HARNESS_MAX_REPEATED_TOOL_FAILURES`。实际新增输入与恢复费用仍记入根预算，不能将估算压缩量当作实际节省。

## Hooks 配置

`[features]` 接受 `hooks` 布尔开关与旧别名 `codex_hooks`（同时设置时 `hooks` 优先）；省略时启用发现，仍须独立信任每份当前定义。用户 `hooks=false` 禁止配置与包 hooks，项目开关不能覆盖它。顶层 `[hooks]` 交给插件 hooks 解析器，其他模型/权限配置仍按原严格规则解析。项目 `.codex/config.toml` 仅在 hooks 发现中读取，不改变本页的全局配置优先级。

```toml
[features]
hooks = true

[[hooks.UserPromptSubmit]]
hooks = [{ type = "command", command = "python3 /absolute/path/hook.py", timeout = 30 }]
```

有效来源、显式审阅、执行与剩余限制见 [插件指南](plugins.md)。
