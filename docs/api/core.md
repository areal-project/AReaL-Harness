**中文** | [English](core.en.md)

# Core API

Core 提供固定 Codex app-server 0.145.0 的子集与 AReaL 扩展，不代表官方客户端全兼容。原始基线见 [schema](../../schemas/app-server/codex-0.145.0.json)，认证与产品新增接口见[桌面 API](desktop.md)。

`Turn` 包含可缺省的 `startedAt`、`completedAt`（Unix 秒）和 `durationMs`（毫秒）。开始时间在准入时保存，结束时间与最终时长随终态保存并发布；`durationMs` 使用单调时钟，覆盖激活后的模型、工具、审批等待和清理，不包含尚未准入的排队时间。客户端只刷新运行显示，不把工具时长相加或从打开窗口时重新计时。旧记录与异常重启后无法确认的结束时间/时长保持缺省，不能当作零或用重启时间填补。正常停止和失败结算也保存最终时间。

## 传输与会话

每个 WebSocket 文本帧是一条请求/响应/通知，上限 4 MiB。请求 `{id,method,params}`，id 为字符串或整数，params 为对象；可省略 jsonrpc，响应 result/error 二选一，不支持批处理。先请求 initialize，再发送 initialized 通知。

| 方法 | 参数 |
|---|---|
| `model/list` | `{}` |
| `thread/start` | `{cwd?,model?,dynamicTools?}` |
| `areal/thread/start` | `{requestId,agentProfile:{id,revision},cwd?,model?,parameters?,dynamicTools?}`；自动启动 Profile 绑定的 Workflow |
| `thread/list` | `{cursor?,limit?}`; 1–100, default 30 |
| `thread/read` | `{threadId,includeTurns?}` |
| `thread/resume` | `{threadId}` |
| `turn/start` | `{threadId,input}` |
| `turn/steer` | `{threadId,expectedTurnId,input}` |
| `turn/interrupt` | `{threadId,turnId}` |

Core 拥有 Thread/Turn/Item 的稳定 ID 与历史。read 不订阅，resume 原子读取快照并建立增量边界，先返回基线再发事件。每连接最多 128 订阅，发送队列 256、Thread 事件窗口 128；落后时断连，重连后重新 resume。普通观察断连不取消任务。

input 为有序 text/image/audio/file 等内容，UTF-8 文本合计最多 1 MiB，仍受历史预算约束；认证客户端上传媒体 Blob，不传宿主 localImage/localAudio 路径。模态由 adapter/模型能力校验。原有 thread/start 的 model 需匹配服务默认；产品模型选择使用 areal/thread/start/configure。

事件包括 thread/started、turn/started/completed、item/started/completed、item/agentMessage/delta；AReaL 媒体通知为 areal/item/agentMedia/available。终态 completed/interrupted/failed 在保存后发布。steer 保留已输出文本，取消当前模型请求后在同一 Turn 继续。

### 结构化终止原因

`Turn.error` 保留 `message`，增加可选 `outcome:{code,class,source,details?}`。Core 在错误产生处保留类型，在 Turn 结算时生成 outcome；`turn/completed`、`thread/read`、持久化及重启恢复使用同一对象。旧记录没有 outcome 时按原样读取；消费者不能通过 message 猜测分类。Rust 构造旧 `TurnError` 时需填写 `outcome: None`。

| code | 含义 |
|---|---|
| `LLM_CONTEXT_WINDOW_EXCEEDED` | 本地 context 预算超限（`source=core_context_budget`，附字节/估算 token 与限额），或 Provider 明确返回 `context_length_exceeded`（`provider_http` / `provider_stream`） |
| `LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED` | Provider 报告 length/max_tokens/max_output_tokens；不证明实际生成量达到客户端请求上限 |
| `LLM_RESPONSE_TIMEOUT` | 模型请求或响应流超时，`class=timeout`；网络重试策略保持原样 |
| `AGENT_MAX_TURNS_EXCEEDED` | 配置的 `maxModelRounds` 已耗尽，或收尾轮仍请求工具；`class=agent`、`source=core_model_round_budget`，details 包含轮数和上限；正常收尾不算失败。未配置上限时不启用此限制 |
| `AGENT_RUN_TIMEOUT` | 显式 Goal 或研究 worker 时间预算到期，`class=agent` |
| `LLM_RESPONSE_FAILED` | 其他已识别模型故障，具体原因由 details 表达；413 为 `request_body_too_large`，非法 tool index 保留 `invalid_tool_call_index`，两者不归为 context overflow 或 invalid tool JSON |
| `HARNESS_INTERNAL_ERROR` | 未分类 Core 错误、持久化失败或恢复到 UNKNOWN 工具结果，`class=infrastructure` |

Provider HTTP 错误体最多读取 64 KiB、等待 2 秒，仅保留白名单 code/type/reason；原始响应体、Provider message、鉴权信息不写入 outcome。HTTP 状态码保留在 `details.httpStatus`。错误分类不启用重试、不将失败转换为成功、不自动续轮或评分；未识别的 code 应保留为未知原因。

EnvArena [runner](../../integrations/envarena/runner.py) 将 Core outcome 复制到 `harness_result.raw.outcome` 并添加 `schema=areal.envarena-outcome.v1`。runner 自己触发的进程期限使用 `AGENT_RUN_TIMEOUT`，收到外部信号使用 `HARNESS_INTERRUPTED`，适配/收集失败使用 `HARNESS_INTERNAL_ERROR`，正常完成使用 `AGENT_COMPLETED`；失败仍输出 ERROR 并非零退出。主线程原因优先，旧 Core 缺字段时不借子线程错误补猜。

适配或收集失败仍以 `raw.outcome=HARNESS_INTERNAL_ERROR` 作为主要故障，防止基础设施失败被当作模型零分样本；`raw.adapter_error` 保存适配错误。若 Core 已失败，`raw.core_outcome` 和 `raw.core_errors` 同时保留原始分类、消息与 thread/turn ID；若 runner 已超时或收到信号，`raw.runner_outcome` 保留该原因。结果文件、native receipt 和轨迹 result 均保留这些诊断，重复结算不会累加重复记录。

runner 的 summary 和 stdout 同时保留 `GAMEAGENT_OUTCOME_CODE=... GAMEAGENT_OUTCOME_CLASS=...`，兼容 AReaL 已有的 marker fallback；该名称是历史消费协议，不表示底层运行 GameAgent。平台若截断或丢弃失败 summary/log，仍需从结果制品读取 raw.outcome，不能保证仅凭 Task 顶层 raw 即可获取。已识别的模型 code 复用 AReaL 统计白名单，新增基础设施 code 在未更新的消费端归为 OTHER。

`integrations/envarena/runner.py`、`outcomes.py`、`graybox_inputs.py` 和 `graybox_collect.py` 是原生发布包的覆盖文件（runner.py 在包内名为 runner）；其余 launcher、模型设置和资源沿用匹配的发布包。必须用同次源码重新构建目标 Linux 原生二进制，不能只替换 Python 就宣称支持 Core outcome。部署需要新的不可变 Harness 版本；本地测试不表示已经上线。

<a id="agent-message-phase"></a>
### Agent 消息阶段

`agentMessage` 增加可选 `phase`：`commentary` 或 `final_answer`。Core 创建流式消息时标为 commentary，在 `item/completed` 中提交最终阶段。工具调用前、steer 前或还需消费子任务/Workgroup 结果的正文保留 commentary；确认模型轮次无需继续后才标为 final_answer。这是执行元数据，不依赖正文关键词或供应商思考字段，不改变上下文回放与计费。客户端替换完成 Item 时需接收阶段变化，是否成功仍以 Turn 终态为准。

```json
{"type":"agentMessage","id":"message-id","text":"Observed result","phase":"final_answer"}
```

失败或取消可能留下部分 commentary；TUI 保留最后一条非空部分回复并标记未完成。旧记录缺失阶段时正常反序列化并保留正文；快照和事件只增加可选字段，不提升版本。忽略字段的客户端保持原行为。Rust 调用方构造 `Item::AgentMessage` 时需为未分类旧消息填写 `phase: None`，或填写适用阶段。

### 思考进度

模型适配器将可展示的思考转换为独立的 `reasoning` Item，不等待正文或完整流终态。Item 生命周期为 `item/started` → 思考增量 → `item/completed`；开始时 `summary: []`、`content: []`。客户端按索引补齐空字符串，再将增量追加到对应段：

| 模型协议数据 | 客户端事件与位置 |
|---|---|
| Chat Completions `delta.reasoning_content` | `item/reasoning/textDelta`，`contentIndex=0` |
| Responses `response.reasoning_summary_text.delta` | `item/reasoning/summaryTextDelta`，`summary[summaryIndex]` |
| Responses `response.reasoning_text.delta` | `item/reasoning/textDelta`，`content[contentIndex]` |

Responses 按供应商 item ID 在每次请求内映射为稳定的 Core Item ID，保留多个 Item 和各自的 summary/content 索引，不拼成一个无边界字符串。`*.done`、`reasoning_summary_part.added/done`、`output_item.done` 及 `response.completed.output` 中的全文只补尚未透传的后缀；重复快照不重复追加，不一致快照判为协议错误。每段索引小于 64，解码器最多保留 128 个思考段、1 MiB 思考文本，Core 每次模型请求最多 64 个思考 Item，且受 Turn 输出限额约束。

```json
{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"THREAD_ID","turnId":"TURN_ID","itemId":"REASONING_ITEM_ID","summaryIndex":0,"delta":"检查依赖关系"}}
```

Responses 摘要通过可选 `reasoning_summary` / `reasoningSummary` 显式开启，见[配置](../guides/configuration.md)与[桌面参数](desktop.md#submissions)。默认不附加摘要请求参数，避免改变现有模型/兼容端点的请求要求；端点未返回可展示文本时，客户端仍显示通用等待提示。其他供应商自定义字段或原生协议不在此适配范围。

`thread/read` 和 `thread/resume` 的快照包含已收到的思考前缀；resume 后以快照替换客户端基线，再接增量，不能把快照再次追加。停止或 steer 保留已收到内容；失败响应被重试时，`areal/model/completionDiscarded.itemIds` 同时移除其思考与正文。`item/completed` 只表示该 Item 不再更新，成功与否以 Turn 终态为准。

思考文本计入现有 Turn 文本输出字节上限，不拼入 `agentMessage`，不算最终答案；仅有思考而没有正文、媒体或工具调用仍按空回复处理。展示用 `reasoning` Item 不回放为模型输入。Chat 原有不回放思考的行为保留；旧 `modelContext.value.type=chat_reasoning` 继续可读，新 Chat 请求不再重复归档这份内部上下文。Responses 原始 reasoning 对象仍独立存入 `modelContext` 并完整回放一次，保留 summary、encrypted_content 等供应商字段；客户端只展示明文段，不解密或显示加密内容。

这是新增的 Item 类型和通知，客户端须识别或忽略 `reasoning`，Rust 的 `Item` / `ModelEvent` 穷尽匹配需增加对应分支，`ModelOptions` / `ModelParameters` / `SelectedModelConfig` 新增可选摘要字段。字段见 [Core schema](../../schemas/areal-core-v1.json)，本地客户端显示行为见[客户端指南](../guides/clients.md)。

<a id="recovery"></a>
## 执行与恢复

工具只在完整模型流终态后执行。dynamicToolCall 保留原始 arguments、有效参数 effectiveArguments、callId、execution 后端与 running/succeeded/failed/cancelled/unknown。本地工具另记 epoch/scope/operationId；外部工具不伪造 Runtime 事实。hooks 和插件嵌套操作分别 journal，成功写入不因外层失败抹掉。

参数/schema 确定错误可返回模型修正；持久化失败或 UNKNOWN 停止自动执行。`areal/tool/acknowledge {threadId,itemId,inspection}` 只在空闲时记录 1–1024 字节检查说明，历史仍为 unknown，不重放、不扩权。

`execution.backend` 为 runtime/command/client/mcp/plugin/agent/coordination/core。可选 `modelArguments` 保存 hooks 之后、Runtime ID 展开之前的模型回放参数；`effectiveArguments` 保留真实 ID 供审计，旧记录回退使用后者。回放按 completion 保留一个 assistant 文本/工具调用批次，再接有序工具结果；不合并不同 completion。工具图像在结果批次后作为关联 callId 的 user 图像。Chat reasoning 归档但不回放，Responses 不透明上下文保持顺序。

`Limits.watchdog_disable` 默认 false，Core 对已分类的网络故障无限次重试当前模型请求，包含传输错误、HTTP 408/429/5xx、提前断流、请求/流空闲超时与明确的 SSE 限流/不可用；不把长度、空回复、鉴权、额度或参数错误当成网络故障。启动配置与关闭方式见[配置指南](../guides/configuration.md)。主 Agent、子 Agent 与独立 Workgroup Engine 继承宿主开关；嵌入式调用方显式传入 Limits，Engine 不读取进程环境。Rust `Limits`、`NativeFactory` 和 `NativeExecutor` 新增 `watchdog_disable` 字段，显式结构体初始化需同步更新；`Limits::default()` 与 `NativeExecutor::new()` 默认启用。

watchdog 保留同一请求的 messages、tools、采样参数与模型轮次，不消耗 `max_completion_retries`；重试不会再次预留 Agent 逻辑请求额度，Workgroup 仍计入每次实际请求及部署预算。250 ms 指数退避封顶 30 秒，释放失败流持有的共享模型许可后等待；取消与显式任务预算仍能结束等待，求解请求还响应 steer。Core 审计并丢弃失败响应的文本、上下文与未执行工具调用，恢复该响应占用的输出字节额度，保留此前已执行工具和已观测 usage。发布 `areal/model/completionDiscarded`（新增 `retryKind=network|completion`）及 `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`。这里的丢弃不回滚已执行工具，也不重启整个 Turn。

SSE 错误 `server_is_overloaded` 和 `service_unavailable_error` 保留为可重试的过载/暂不可用分类；鉴权、额度等明确永久错误仍优先禁止重试。分类只决定网络 watchdog 的候选范围，不绕过 Goal 的未知消费检查。

Goal 请求先检查共享预算与用量是否已知，再决定是否重试。请求失败或超时留下未知消费时，保留预留并将 Goal 置为 blocked（usageUnknown）；不进入 watchdog 退避或有限响应重试。Turn 错误同时保留 `GOAL_USAGE_UNKNOWN` 与原始请求失败原因，避免用量检查覆盖接口、鉴权或超时诊断。摘要请求同样受此约束，保留旧 checkpoint，不写入降级摘要。已计量的 HTTP 请求禁用传输层内部重试，避免同一预留隐含多次消费。

Goal 的根线程与子线程共享账本。子模型失败后缺失最终用量，会阻止其他线程继续提交模型或工具；根线程诊断保留已观察到的子请求终止分类、账本请求 ID 和所属 thread/turn，避免把上游错误误报为无来源的内部故障。账本只新增可选的脱敏分类字段，兼容旧记录；旧记录可能无法还原失败来源。检查失败请求后，可在 TUI 使用 `/goal-resume` 确认未知消费的保守预留并继续；不会自动重放失败工具或将未知用量改为零。

`max_completion_retries` 默认 0，可为已分类的长度截断、非法工具 index、空回复等提供有限恢复（仅 reasoning 不算最终回复）；关闭 watchdog 后，已分类网络错误也沿用此有限额度。工具仍只在完整成功流后执行；UNKNOWN、持久化错误、取消与显式任务预算错误不重放。

Chat 工具 index 缺失、null、非整数类型、负数、超出 u64 范围或片段非对象时，使用明确的内部协议错误，只进入上述有限恢复，不进入网络 watchdog，也不作为 Workgroup 推理检查点。Core 不猜测编号或片段归属；数量、参数和缓冲预算错误不自动恢复。失败响应的模型视图被丢弃，已有确认工具、steer 和已观测 usage 保留。解析错误在已排队事件交付后立即传播；同事件或前序事件的已解析 usage 只累计一次，直接 EOF 保留原始错误类型。

Rust `Model::chat_with_limits(messages, tools, purpose, ToolCallLimits, cap)` 显式传递请求预算，内置 HTTP、共享池和 Worker 包装器均转发。可选的输出 token 上限与工具预算一起经过 Goal 计量传递。默认实现委托 `chat_limited`，保持已有自定义 Model 实现可编译，并拒绝不受支持的非空 token 上限；自定义模型自行约束内部缓冲，Engine 仍在工具执行前检查其输出。摘要使用零调用预算。`Limits` 新增 `max_tool_buffer_bytes`，`NativeFactory`/`NativeExecutor` 新增 `tool_call_limits`，显式结构体初始化需补充字段；构造器提供默认值。Rust Limits 同时区分可选累计预算与单响应资源保护。

Checkpoint 的 `retainedInputs: [{itemId, content}]` 保存有界的真实用户原文，`evidence: string[]` 保存有界回执。优先首个任务与最近修订，排除自动 Goal 续轮输入；后续用户指令优先于冲突摘要。旧原文可通过 `read_history` 回取，不删除、不提升为 system 指令。旧 checkpoint 未含 retainedInputs 时保留原重放语义，直到下一次压缩。子任务保留自己的输入，父任务需显式传递有关修订。工具/结果保持完整配对，未确认副作用不能移入冷历史。摘要输入按模型窗口减摘要输出预留预检，过大证据会明确标记省略；无效摘要最多一次验证重试，再退回有界的已记录证据。没有合法前缀时不付费摘要。取消保留旧 checkpoint，并保守结算已观察用量。压缩事件包含前后字节与估算 token、targetTokens/targetMet、摘要预算、degradationReason、retainedUserMessages，以及 trigger（manual/tokens/bytes/storage）。压缩后完整求解请求再次预检，无法容纳时返回结构化上下文错误；自动模式下在任何输出/工具调用之前遇到明确的提供方上下文溢出，可恢复一次，仍受 Goal 计量约束。

压缩后的求解上下文还包含 Core 从成功文件操作回执提取的历史路径、完整 SHA-256 与读取范围（最多 24 项、8 KiB）；不复制失效的 fileVersion 句柄，也不把分页读取推断为全文覆盖。摘要模型不再负责复述哈希。

若 checkpoint 覆盖整个已结算尾轮，下一次求解追加明确标记的内部恢复控制，避免把历史摘要误作当前 Turn 的最终答复；该控制不构成新的用户任务，也不要求重读未变化文件或重复已完成验证；证据已满足任务时应报告并收尾。

字节阈值触发且配置 token 压缩目标时，边界选择也考虑字节窗口的 75% 目标；按保留上下文所剩空间建议 1–8 KiB 摘要，减少紧邻的重复压缩。建议长度不硬截断有效摘要，原有净缩减检查仍生效。

`limits.context_compaction_enabled=false` 时自动阈值超限使 Turn 失败，显式 `areal/context/compact` 返回错误，不写入 checkpoint；配置见[上下文限额](../guides/configuration.md#模型与限额)。

模型审计写入 `data_dir/model-requests/*.json` 与 `requests.jsonl`，记录 solve/summary、参数、请求体摘要/大小、attempt、usage、stopReason、耗时与有限响应形状，不记录 header、endpoint 或 prompt。`usageObserved=true` 表示收到可解析的完整用量事件（包括 0）；缺失/false 不能视为已知零。length 终态仍收集同帧/尾帧 usage，等待受期限和取消限制，随后判定截断并禁止执行工具。

SSE 流式 Provider 错误另写入 `data_dir/model-requests/errors/<requestId>.json`，普通审计的 `errorDetailFile` 指向该文件。目录 0700、文件 0600，保存错误对象原文（包括未进入白名单的 code/type/message）；序列化原文超过 16 KiB 时保存 UTF-8 安全截取的 `rawJsonPrefix` 并标记 `truncated=true`。这些私有排障制品可能包含上游回显内容，不进入 `requests.jsonl`、TurnOutcome 或遥测；旧请求未保存的原文无法回取。

诊断制品采用固定保留上限，检查时达到年龄、数量或总容量任一条件即回收最旧的已完成记录：

| 制品（每个目录独立计数） | 最长保留 | 最多文件/容量 |
|---|---|---|
| `model-requests/*.json`、`model-requests-child/*.json` | 30 天 | 4096 份 / 64 MiB |
| 两个请求目录下的 `errors/*.json` | 7 天 | 512 份 / 8 MiB |
| `audit/*.json`（压缩、丢弃响应等 Core 诊断） | 30 天 | 1024 份 / 16 MiB |
| 两个请求目录下的 `requests.jsonl`、`requests.jsonl.1` | 30 天 | 两份，各 8 MiB |

升级后已有诊断也应用这些规则，旧大 JSONL 会缩减；不提供永久保留开关。服务启动后立即检查，此后每分钟检查；请求写入也会触发检查（最多每分钟一次）。嵌入式调用方可调用 `areal_engine::diagnostics::collect(data_dir)`。在途请求用文件锁租约保护，不计入已完成记录的容量上限；请求结束后释放，崩溃租约在下次检查回收。原始错误详情可先于普通审计到期，`errorDetailFile` 不保证永远可读；父请求审计被删除时也删除孤立详情。需要长期排障时应在到期前导出私有制品。

JSONL 的 30 天期限按文件最后修改时间计算，不逐条检查行的年龄；文件容量在写入时轮转。逐请求 JSON 与错误详情按各自文件的最后修改时间回收。数量和总容量上限在清理检查时执行，检查间可短暂超过。

普通单条审计超过 1 MiB 时只保留身份、状态和 `auditTruncated=true` / `originalBytes`；不截断权威历史。JSONL 写入与轮转共享跨进程锁，旧大文件只保留有界尾部完整记录，异常退出留下的未换行记录会丢弃。读取汇总时同时检查当前文件和 `.1`，更早记录只在尚未过期的逐请求 JSON 中。诊断目录为 0700，文件为 0600；清理只识别已知命名的普通文件，不跟随符号链接。诊断原子写临时文件保留最多一天；Store 的原子写遗留文件在取得独占所有权后清理。

这些上限不适用于会话历史、Goal 账本及请求归档、Workgroup 制品或用户 scratch，它们用于恢复与审计，不能按诊断 TTL 删除；Blob/冷历史仍按引用 GC。

未设置 tokenBudget 表示不限 token，仍维护 Goal 计量和未知消费检查。合法 usage 对象中输入/输出计数均为 0，且终态确认时，按已知零结算；裸数值 `usage: 0`、缺失计数或非法值不能视为已知零。普通 error 事件中的 usage 即使为 0，也不替代最终用量确认。提供方伪造零计数会导致低估，Harness 不据此推断实际计费。

开始消费响应流前的传输失败、HTTP 错误状态和非 SSE 响应也记为 `outcome=failed`，`error` 保存脱敏诊断；非 SSE 响应提示检查完整 API endpoint，不记录错误页正文或原始响应 header。取消或未完成的请求仍记为 `interrupted_or_unfinished`。

工具错误审计新增 `errorCode` 与 `toolCallError`：`invalid_tool_call_index` 附固定原因、协议、字段路径、从 1 开始的 SSE 数据事件序号、index JSON 类型及已缓冲调用数量；`tool_call_budget_exceeded` 附预算类别、上限和观测值。字段只含固定标签和有界数值，诊断不复制 SSE、参数、reasoning 或非法字段值，使用同一记录的本地 `requestId` 关联。`responseShape.toolArgumentBytes` 沿用旧名称，实际累计通过校验的 id/name/arguments 字节。

快照写入格式 12，可读取 1–12；旧二进制不能读取新快照。可选 `historyArchive` 引用 `history/` 中的不可变 SHA-256 分段，包含 head、throughItemId、completedTurns、items、bytes；单分段最多 32 MiB。先同步分段，再提交引用它的快照。热快照保留近期条目和 checkpoint；完整 thread 读取还原原始 Turn/Item，并省略存储清单。`read_history` 按 item ID 分页，无需加载全部归档。GC 同时追踪热快照与冷分段引用。工具意图持久化与 UNKNOWN 恢复不变，不重放归档副作用。usage/duration 缺失表示未知，不是 0。

`ToolExecution` 新增可选 `resultSnapshot: MediaRef` 与 `outputProjection` 度量对象，旧记录默认缺省。原文回取是模型 Core 工具 `read_tool_result`，不是新的 Runtime RPC；边界见[工具指南](../guides/tools.md)。模型请求审计另记 messageBlocks 的摘要/字节数、toolSchemaSha256 和 instructionsSha256，用于离线比较稳定前缀；不记录提示词正文，也不将前缀相同直接视为提供方缓存命中。`usageDetails` 记录提供方可选的缓存输入和推理 token；缺失时为 null，预算用量结构不变。

<a id="dynamic-tools"></a>
## 动态工具回调

thread/start.dynamicTools 为 `{name,description,inputSchema,outputSchema?}[]`，定义持久化且生命周期内不可变。Core 保存 intent 后向注册连接请求：

```json
{"id":"REQUEST_ID","method":"item/tool/call","params":{"threadId":"THREAD_ID","turnId":"TURN_ID","callId":"CALL_ID","tool":"lookup","arguments":{"key":"answer"}}}
```

客户端原样回传请求 id：

```json
{"id":"REQUEST_ID","result":{"success":true,"contentItems":[{"type":"inputText","text":"42"}],"structuredContent":42}}
```

success/contentItems 必填；结构化成功结果按 outputSchema 校验，产品媒体扩展见[桌面 API](desktop.md)。success=false 为确定失败；RPC error、无效/超限结果、断连、超时或取消记 UNKNOWN。Core 不重试。areal/tool/cancelled 只是尽力通知，不保证回滚。

恢复的定义没有宿主绑定；旧宿主断开且 Thread 空闲时，由实现回调的客户端 resume 接管。执行宿主断连停止对应 Turn；TUI/Web 对任意回调返回 method-not-found。注册/预算见[工具指南](../guides/tools.md)。

<a id="agent-tools"></a>
## Agent 工具

| 工具 | 参数 |
|---|---|
| `agent_spawn` | `{prompt,maxModelRounds?}` |
| `agent_read` | `{threadId,offset?:0}` |
| `agent_wait` | `{threadId,timeoutMs?:10000}` |
| `agent_wait_any` | `{threadIds,timeoutMs?:10000}` |
| `agent_report` | `{summary,evidence,remaining}` |
| `agent_send_input` | `{threadId,prompt}` |
| `agent_cancel` | `{threadId,mode?:"graceful"}` |

prompt 非空，最多 32000 字符且受输入字节预算约束。maxModelRounds 为 1–1024，不能扩大父上限；最后一轮仅交接。wait 超时 0–60000 ms 不取消子任务；wait_any 接受 1–16 个不同直接子任务。report 仅限子 Agent：summary 最多 4096 字符，两个数组各 16 项/项 512 字符，总参数最多 16 KiB。

`agent_send_input` 持久化补充说明，并在同一子 Turn 重启生成。已发出的旧请求先只排空计量，过时工具不执行；因此它适合纠偏，可能废弃数分钟已生成工作，普通非紧急提醒宜在阶段交接时处理。等待响应头沿用该请求原有空闲期限，排空流按每次活动刷新 `stream_idle_timeout_seconds`，没有额外的 180 秒总截止。显式取消、原 Goal 剩余时间和研究 worker 期限仍可结束等待；真正空闲、断流或缺失用量仍保留 UNKNOWN，不自动清账或重试。

快照含 status、settled、text、offset/nextOffset、source/sourceItemId、partial 和错误；text 每页最多 2048 UTF-8 字节，内容来源变化从 0 重读。settled 才表示任务和清理结算，失败状态不会被阶段报告改成成功。目标绑定父 Turn，禁止跨根/兄弟/祖先控制。

模型派发正常结束前自动 join；`areal/agent/spawn {parentThreadId,input}` 的手工路径在父 Turn 结束时取消后代。`areal/agent/list` 分页观察。默认深度/扇出为 8/64；任一设 0 禁用工具。完整准入见[设计](../design/multi-agent.md)。

可选研究模式使用 `delegate_tasks`、`read_agent` 和 `cancel_agent` 替换默认模型 Agent 工具；配置、异步返回和报告契约见[研究工具](../guides/tools.md#research-agents)。它不改变客户端 `spawn_child` RPC。恢复时 `source=nativeResearchAgent` 重新应用只读源码权限与内置工具限制。

嵌入式 `RuntimeConfig.command_scratch` 可指定独立目录，但不能包含 workspace 或 Core data；Runtime 必须显式授予 `workspace://scratch`。共享研究预算只覆盖一个 Engine 生命周期，重启开始新的预算周期。

<a id="workgroups"></a>
## Workgroup 与嵌入式接口

服务提供 `areal/workgroup/policy/start/list/read/wait/cancel/revise/artifact`。start 使用 `{requestId,plan,workers?,admission?}`；wait 使用 `{id,afterRevision,timeoutMs}`；revise 使用 `{id,requestId,expectedRevision,plan}`；artifact 使用 `{id,path?,offset?}`。字段见 [schema](../../schemas/areal-core-v1.json)，策略与产物见[指南](../guides/workgroups.md)。

状态 revision 与计划 planRevision 分开。修改只影响未启动任务或追加节点，保留原检查与授权。owner/requestId 相同参数返回原组，不同参数冲突。模型只能控制本 Turn 的组。等待上限 60 秒，不阻塞同连接取消；16 在途中保留 4 个控制额度。仅已通过且清理确认的制品可读取。

Rust 接口见 [Engine](../../core/engine/src/lib.rs)、[并发原语](../../core/engine/src/concurrency.rs)和 [Workgroup](../../core/engine/src/workgroup/mod.rs)。宿主拥有 Runtime、MCP Connections、PluginHost 和 Service 生命周期；先等待 Engine shutdown，再关闭宿主资源，不以 Drop 代替异步清理。Service 的父 Engine 与 Factory 应共享 SharedModel pool。

Rust 启动器调用 `areal_config::skills::discover(workspace, homedir)` 获得 `SkillDiscovery { skills, warnings }`，须展示逐 Skill 告警；每个条目包含 id/revision/root/metadata。Engine 的 `SkillLocation` 可接收可选 metadata，省略时复用文件头解析器；新增字段会影响 Rust 结构体字面量调用方，原部署 JSON 可继续省略。正文和附件不进入启动目录缓存，详情见[桌面 Skill 契约](desktop.md#skills)。

## 错误

标准 -32700/-32600/-32601/-32602/-32603 分别表示解析/请求/方法/参数/内部错误；-32000 关闭，-32001 容量，-32003 认证，-32004 不存在，-32009 冲突。传输 id 不是业务去重键，旧 turn/start 或 spawn 断线后先读状态，不自动重放。产品 requestId 语义见[桌面提交](desktop.md#submissions)。

<a id="goals"></a>
## Goal 模式

Goal 无需部署开关；`areal/capabilities.features.goals` 固定为 true，表示服务支持此能力。只有显式创建 Goal 后才会自动续轮。使用与恢复见 [客户端说明](../guides/clients.md#goals)，预算限制见 [配置规范](../guides/configuration.md#goals)。协议保留 Codex 0.145.0 协议基线，使用 AReaL 扩展，不声明支持上游 `thread/goal/*`。

### 客户端控制

所有修改需要 interact 权限及对应 Thread 授权；查询需要 observe。修改携带 `requestId`、`threadId`、`expectedRevision`，修改现有目标还需 `goalId`。同身份、方法和 requestId 的同参数重试返回原受理结果，不同参数冲突。去重命中先于 revision 校验；客户端收到冲突后读取新快照，不盲目重试写入。

| 方法 | 专有参数 | 语义 |
|---|---|---|
| `areal/goal/get` | `threadId` | 返回目标投影；没有目标时 goal=null，仍返回控制 revision |
| `areal/goal/create` | `objective, tokenBudget?, maxTurns?, maxActiveSeconds?, interactionMode?, inferLimits?` | 根 Thread 空闲且无待处理用户队列时创建目标并原子受理首轮；已有未清除目标时冲突 |
| `areal/goal/update` | `goalId, objective?, tokenBudget?, maxTurns?, maxActiveSeconds?, inferLimits?` | 在目标停止且清理完毕后编辑；保留目标 ID 和全部用量，不隐式启动 |
| `areal/goal/pause` | `goalId` | 持久化 paused、暂停用户队列并请求活动 Turn 取消；响应不保证清理已经完成 |
| `areal/goal/resume` | `goalId` | 校验预算、UNKNOWN 和宿主后恢复；活动容量不足时等待；队列因 Goal pause/Stop 暂停时一并恢复，其他原因的队列暂停需单独处理 |
| `areal/goal/clear` | `goalId` | 仅目标停止、无活动 Turn、无待处理用户队列或未清理资源时清除；控制 revision 递增，既有 Turn 归因、证据和计量记录保留 |

objective 为 1–4000 个 Unicode 字符且不能全空白。显式预算为正整数，maxTurns 包含首次根 Turn，maxActiveSeconds 统计活动时间。创建省略任一限制表示该项不限，不自动采用部署默认值；投影中未设限制为 null。更新省略字段保留原值，显式 null 移除相应限制。部署 max_turns/max_active_seconds 只校验显式提交的限制。update 必须至少修改一个字段，completed 目标只读。

已设置跨 Run Token 总预算的周期 Task 不允许通过目标文本重新推断预算，继续由 Task 控制接口维护。

GUI 仅提交目标文本及 inferLimits=true，不展示预算输入。create 的 inferLimits 不可和显式限制同时提交；update 的 inferLimits 要求 objective，清除旧限制并重新等待确认，保留 ID 和全部用量、不隐式启动。根 Agent 在执行工作前调用 goal_set_limits，解释用户明确指定的 token、轮次与活动时间（换算为秒）；没有指定的项不设限，任务正文中的数字不作为预算。推断请求及耗时也计入实际用量。模型至少需要三轮、allowlist 必须允许 goal_set_limits。旧数据中的数字限制保持原值；读取格式 1–12，旧 Core 不能读取格式 12。

resume 保留计量，不能使已经达到的限额失效；completed 不可恢复。resume 同时确认此前未知模型消费的保守预留，但不删除该预留，不将 accountingComplete 改回 true；工具 UNKNOWN 仍需独立检查与 acknowledge。普通 `thread/resume` 仍只恢复订阅和快照，不恢复 Goal 执行。暂停时保存原因，只有属于该次 Goal 暂停的队列暂停才可被 Goal resume 自动撤销。

投影包含 `threadId`、`revision`、`eventSequence` 和 `goal`。goal 包括 `id`、`threadId`、`objective`、`status`、`reason`、预算及计量、`activeTurnId`、`settling`、`waitingForInput`、`waitingForAgents`、`waitingForCapacity` 和最近报告 `report`、`reportTurnId` 和连续未报告计数 `unreportedTurns`。status 使用 `active / paused / blocked / completed / budgetLimited / failed`。`revision` 只随控制状态变化，eventSequence 随持久投影变化；get 和原子 resume 返回当前计量，流式用量不逐 token 发布 Goal 事件。持久状态和受理结果保存后发布；保存失败时仅发布内存中的 failed/SystemError，重启以保守恢复为准。

Token 准入不足的 Turn 终态为 `GOAL_TOKEN_BUDGET`，source 为 `core_goal_token_budget`；活动时间截止使用 `AGENT_RUN_TIMEOUT` 和 `details.goalDeadlineReached=true`。客户端以此显示目标停止原因，不将预算停止展示为内部错误。

goal.usage 包含 `inputTokens`、`cachedInputTokens`、`outputTokens`、`tokensUsed`、`reservedTokens`、`unknownRequests`、`timeUsedSeconds`、`turnsStarted` 和 `accountingComplete`。tokensUsed 仅包含已确认输入与输出，reservedTokens 单独展示且参与准入；未知统计不补零。timeUsedSeconds 包含根 Turn 内的执行和等待，不叠加子任务时长；崩溃窗口或缺失 usage 时 accountingComplete=false。该口径不保证 provider 计费绝对不超过 tokenBudget。

创建 Goal 示例：

```json
{
  "id": 20,
  "method": "areal/goal/create",
  "params": {
    "requestId": "goal-migration-1",
    "threadId": "THREAD_ID",
    "expectedRevision": 0,
    "objective": "完成指定模块的迁移，保持公共 API 兼容，并通过对应行为测试。",
    "tokenBudget": 200000,
    "maxTurns": 20,
    "maxActiveSeconds": 3600
  }
}
```

create 返回目标投影及首轮 turnId。事件 `areal/goal/updated` / `areal/goal/cleared` 携带 threadId、revision、eventSequence 及目标投影；clear 还携带被清除的 goalId。现有 `turn/started`、`turn/completed` 不改名也不改变 Turn 终态含义。Thread 新增可选 `goals:{revision,eventSequence,goal}`，子 Thread 使用 `goalOwner:{threadId,goalId}`；Turn 新增 `goal:{goalId,sequence,origin,predecessorTurnId}`，origin 为 initial/user/continuation。无 Goal 的旧数据按原方式读取，clear 保留控制 revision 以拒绝旧请求。

Goal 事件纳入现有 snapshot-and-subscribe 边界、权限过滤和背压规则。重新连接后使用完整快照替换客户端状态，再消费增量；不能以只读 get 与单独 subscribe 拼接而假设没有事件缺口。请求、响应和事件 schema 由 Rust 类型生成至 `schemas/areal-core-v1.json`。

### 模型状态工具

| 工具 | 参数 | 权限和行为 |
|---|---|---|
| `goal_read` | `{}` | 从调用上下文读取当前目标、状态、预算和剩余工作；子 Agent 仅获得只读投影 |
| `goal_set_limits` | `{expectedRevision, sources, tokenBudget?, maxTurns?, maxActiveSeconds?}` | 仅根 Agent 在 limitsPending=true 时确认一次；每个显式值的 sources 必须逐字引用 objective，没有限制时传空 sources |
| `goal_update` | `{expectedRevision, status, summary, evidence, remaining, blocker?}` | 仅当前 Goal 的根 Turn；status 为 continue/complete/blocked；仅报告进展或提交结算申请 |

`goal_update` 接受 complete/blocked 报告后返回 `nextAction`，明确要求输出不带工具的最终答复；当前 Turn 结算前保持 active 属于预期状态，无需轮询或重复提交。压缩后的动态 Goal 指令同样保留这条待收尾状态，后续用户修订仍须处理。

goalId 和根线程身份由 Core 绑定，模型不能自报其他目标。summary 非空、最多 4096 字符；evidence 和 remaining 各最多 16 条、每条最多 1024 字符，总参数最多 32 KiB。complete 要求 remaining 为空且 evidence 非空；blocked 要求非空 blocker 描述具体障碍及解除条件。evidence 是模型提交的文字报告，可引用工具 Item、检查回执或产物；它不是独立的语义验收器。Core 校验报告结构、未消费的验证句柄、待处理输入、子任务和 Workgroup 结算状态；业务正确性仍依赖实际检查和模型报告。

`goal_update` 返回受理后的控制 revision，complete 在当前 Turn 正常结算前只是待处理申请。用户修改状态、steer 或排队追加输入会使旧申请失效；资源清理、持久化或子任务失败不得发布 completed。限制待确认时 Core 拒绝工作工具与完成报告；暂停、过期 revision、子 Agent、重复限制确认均被拒绝。引文只证明来源，预算数值的自然语言含义仍由模型判断，Core 不使用正则解释。模型不能通过工具创建目标、解除暂停、在确认后提高预算、清除目标或绕过审批；自然语言“完成”及普通 Turn completed 也不能直接改变 Goal 状态。

Rust 嵌入式调用使用 `Limits.goals: goals::Policy` 及 `Engine::goal_get/goal_create/goal_control`。自定义 Model 的 `chat_limited` 必须显式接受逐请求输出上限，`share_context` 保留预算归因；内置 HTTP adapter 已支持。自定义 Workgroup Factory 需实现 `executor_for_goal` 并保留传入 Budget；默认实现对有 Goal 的调用明确报错。普通 Turn 和独立 Workgroup 沿用原行为。

Goal 请求账本位于 `goals/<goal-id>.json`，发送前持久预留；主/子 Agent、原生 Workgroup、活动 Turn 摘要共享计量。确认结算的请求滚入不可变 `goals/requests/` 分段并汇总累计用量；热账本保留在途与未知请求，仍有 4 MiB 资源保护。默认没有累计请求次数预算。滚动不重置用量、不释放未知消费预留。clear 保留账本及归档，不提供自动账本 GC。API 仍为 areal.core.v1；快照格式 12 保存冷历史引用与有界 checkpoint 原文。

Task Mode 在 Goal 之上提供 foreground/scheduled/background 任务、TaskRun、独立 Channel 与 Inbox。Goal create 同时返回 taskId/runId；Goal 内的 ask_user_question 可选 mode=async，headless 不等待用户。接口、预算与恢复语义见 [Task 契约](tasks.md)。timeUsedSeconds 包含协调 Turn 与 TaskRun worker 活动时间的并集，纯异步用户等待不计入。

普通 Turn 不设组合总时限。`thread/configuration/read` 的 `limits` 仅返回 `historyBytes`、`contextBytes`；已移除 `turnTimeoutMs`。模型、工具及显式任务预算继续独立生效。

模型请求将固定指令与历史放在前缀，将轮次、Goal/Task 当前状态、子任务结果和预算提示作为 system 消息放在完整历史之后，保持工具调用与结果相邻。动态提示在请求前以 `modelContext.value.type=areal_request_context` 持久化，按原顺序保留在对应输出之前；最新快照替代旧快照的状态含义，但不删除旧输入。最后一轮禁用工具或上下文压缩仍可能改变缓存前缀。缓存命中还取决于供应商与路由，不能由消息顺序保证。

`thread/read {threadId,includeTurns:true}` 返回持久化 Turn/Item 历史；`areal/thread/inspect` 返回执行配置与工具视图；`areal/context/read {threadId,offset,limit}` 返回分页历史投影（limit 为 1–32）与指令快照，并省略不透明 provider context。该投影包含持久化的请求状态快照；旧版本未保存的提示无法恢复。它仍不是过去某次 HTTP 请求的精确重放。每次模型调用在预算预检和摘要裁剪后提交的 Engine 消息通过 `areal::trajectory` 的 `gen_ai.input.messages` 记录；查询已导出的轨迹需使用部署的遥测后端。它仍是协议适配前的逻辑消息：适配器可以合并 system、转换内部状态角色、注入固定说明或读取媒体内容，不包含完整工具 schema、采样参数与最终 HTTP 字节。因此不能仅凭该字段宣称训练输入精确重放。

工具执行记录新增可选 `originalArguments`，旧记录可继续读取。参数语义未被 hook 改写时，历史保留原始 JSON 字节。Responses `function_call` 原始 item 作为 `modelContext` 保存，匹配未改写调用时保留其 item ID 与原始字段；Chat 投影不发送 Responses 元数据。上下文压缩将请求快照和关联输出作为同一保留单元，压缩后重新建立缓存前缀。

Chat Completions 的 HTTP 适配会把所有纯文本 system 消息按原有相对顺序合并到请求开头，以兼容只接受首条 system 的聊天模板。非 system 消息的先后顺序保持不变；这不会修改持久历史，也不会改变 Responses 的消息及 encrypted reasoning 回放。动态状态变化因此可能降低 Chat 协议的缓存前缀复用率。

摘要超过 16 KiB 时，Core 在既有空闲期限和取消规则内继续读取流到结束，收集尾部用量后再拒绝摘要并执行原有有限格式重试。不会仅因摘要超长而丢弃已到达的用量；确实缺失的用量仍保留为 UNKNOWN，不自动恢复 Goal。

新请求状态使用内部 `areal_context` 角色持久化。Chat 将其按原位置投影为 user 状态数据，并在开头加入固定解释规则；这些状态不构成新增用户授权，权限和预算仍由 Core 强制执行。真正的 system 规则继续合并到开头以兼容仅支持首条 system 的模板。Responses 将内部状态角色映射回 system。旧历史中的 system 快照不自动迁移，因此旧会话可能直到压缩或新建会话后才能完全获得稳定前缀。仅完全相同的 headless 静态提示在可见历史中去重，动态状态回到旧值仍追加事件。

Goal 提示投影不携带 eventSequence 或逐请求累计用量/时钟，只保留 usage.turnsStarted；完整账本仍通过 goal_read 和 Goal API 读取。相同的最近 Goal 快照不重复注入；revision、报告或状态变化会追加新快照，A→B→A 不会误删最后一次变化。该裁剪仅影响模型提示，持久 Goal 账本与预算执行不变。

HTTP 模型收尾轮保留当前可见工具 schema，通过 `tool_choice=none` 禁用调用，同时将解码和执行额度设为零；供应商若仍返回调用会被拒绝。工具定义和固定委派指令不因正常收尾而删除，从而保留可复用前缀。无 `tool_choice` 能力的自定义 Model 适配器继续接收空工具列表。权限变化仍即时调整工具可见性，缓存不覆盖授权。

Goal 的 steer（包括向计量子任务发送 `agent_send_input`）立即持久化，但不丢弃在途模型请求。Core 等待该响应结算，再于工具派发前处理待接收修订；旧响应的工具调用被丢弃，已知消费仍准确计入一次。既有 idle、显式 Goal 期限及取消保持有效，真正缺失的用量仍为 UNKNOWN。普通无 Goal 计量的 Turn 保持即时 steer 行为。

### 子任务停止与计量收尾

`agent_cancel` 接受 `{threadId,mode?:"graceful"|"force"}`，默认 graceful。两种模式立即停止继续执行当前响应的工具和启动下一请求；graceful 为已发请求保留最多 60 秒结算，force 为 1 秒，均受原 Goal/研究 worker 剩余期限约束。重复取消不延长期限；收尾中改为 force 会缩短期限。它不保证生成交接报告，也不保证 provider 返回 usage。`agent_send_input` 可先要求作者提交交接。外层 Turn 在期限内继续驱动取消中的生成循环，不能先丢弃响应 future；首包前的已发请求也遵守此规则。截止仍缺最终用量时，原账本保留 UNKNOWN 和预留，不补零、不追加预算。崩溃后的未结算请求仍按原恢复契约保留未知，不声明支持 provider 用量补查。

`agent_read/wait/cancel` 返回 `stopRequested`、`resourcesReleased`，并在 Goal 子线程上附 `accounting.{usageSettled,pendingRequests,unknownRequests,scope}`。这是当前 child turn 的计量状态，不能代替整棵 Goal 的账本。快照 `activity` 提供已记录 item/tool 数及最后工具身份/状态；它不是心跳时间。取消请求返回成功不等于 settled；只有清理完成后才能接管文件。短 wait 超时、源码 SHA 不变或旧交接文字都不能单独证明线程卡死。

### 压缩后的精确工作片段

checkpoint 恢复最多保留 8 组接口导向文件片段，序列化内容总计不超过 4096 本地估算 tokens；每组最多 40 行，超长行不保留。保留已观察的路径、SHA、行号和事件引用，不保留编辑句柄。当前实现优先接口文档及源码声明附近的精确文本，不声称完整覆盖或经过语义验证。后续回执中的新 SHA 使旧版本片段失效；没有新回执不代表磁盘未被外部改动。原需求仍权威，摘要与片段只作为历史证据。

`contextCompactionCandidate` 持久记录压缩切点、保留 item 数、前后估算、固定开销、usage 校准、targetMet 及 wholeLatestRound。它在 checkpoint 提交前保存，不能单凭该 audit 声称安装成功；须核对实际 checkpoint 的 throughItemId。文件视图在首次工具结果记录时生成，历史回放不追溯重写旧 provider 上下文。

摘要请求已观察的 usage 立即累计到 Turn；即使取消或拒绝摘要而不提交 checkpoint，也保留已知消费。取消收尾的新 usage 仅追加一次；缺少最终用量仍保留 UNKNOWN。

未收到 usage 事件时 Turn usage 保持缺省，CLI 不输出伪造的零消费；提供方明确返回全零 usage 时仍保留该记录。

嵌入式 Rust 宿主显式构造 NativeFactory/NativeExecutor 时需提供 `worker_limits: Limits`，把累计预算和上下文策略传给 worker Engine。NativeExecutor::new 提供预算无限的默认值；单请求工具保护仍由 tool_call_limits 指定。

`ModelCapabilities` 和 `ModelOptions` 增加可选窗口/输出元数据；自定义 Rust 结构体字面量需补齐新字段或使用默认值。客户端协议中的 `ModelParameters.contextWindowTokens` 为新增可选字段。

项目指令由 Engine 在每个 Turn 首次模型请求前加载，并保存为 `instructionSnapshot`。按工作区根到 Thread `cwd` 的目录链读取 `AGENTS.md`，来源路径随正文写入快照；不新增 API 字段，已有仅根文件项目保持兼容。正文合计超过 32 KiB、无效 UTF-8、符号链接或超过 64 层的目录链使 Turn 在请求模型前失败，不截断规则。作用域、优先级与 cwd 路径别名见[客户端指南](../guides/clients.md#历史恢复与观测)。
