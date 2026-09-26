**中文** | [English](core.en.md)

# Core API

Core 提供固定 Codex app-server 0.145.0 的子集与 AReaL 扩展，不代表官方客户端全兼容。原始基线见 [schema](../../schemas/app-server/codex-0.145.0.json)，认证与产品新增接口见[桌面 API](desktop.md)。

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
| `AGENT_RUN_TIMEOUT` | Turn 或 Goal 时间预算到期，`class=agent` |
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

watchdog 保留同一请求的 messages、tools、采样参数与模型轮次，不消耗 `max_completion_retries`；重试不会再次预留 Agent 逻辑请求额度，Workgroup 仍计入每次实际请求及部署预算。250 ms 指数退避封顶 30 秒，释放失败流持有的共享模型许可后等待；取消与总期限仍能结束等待，求解请求还响应 steer。Core 审计并丢弃失败响应的文本、上下文与未执行工具调用，恢复该响应占用的输出字节额度，保留此前已执行工具和已观测 usage。发布 `areal/model/completionDiscarded`（新增 `retryKind=network|completion`）及 `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`。这里的丢弃不回滚已执行工具，也不重启整个 Turn。

Goal 请求先检查共享预算与用量是否已知，再决定是否重试。请求失败或超时留下未知消费时，保留预留并将 Goal 置为 blocked（usageUnknown）；不进入 watchdog 退避或有限响应重试。Turn 错误同时保留 `GOAL_USAGE_UNKNOWN` 与原始请求失败原因，避免用量检查覆盖接口、鉴权或超时诊断。摘要请求同样受此约束，保留旧 checkpoint，不写入降级摘要。已计量的 HTTP 请求禁用传输层内部重试，避免同一预留隐含多次消费。

`max_completion_retries` 默认 0，可为已分类的长度截断、非法工具 index、空回复等提供有限恢复（仅 reasoning 不算最终回复）；关闭 watchdog 后，已分类网络错误也沿用此有限额度。工具仍只在完整成功流后执行；UNKNOWN、持久化错误、取消与总期限错误不重放。

Chat 工具 index 缺失、null、非整数类型、负数、超出 u64 范围或片段非对象时，使用明确的内部协议错误，只进入上述有限恢复，不进入网络 watchdog，也不作为 Workgroup 推理检查点。Core 不猜测编号或片段归属；数量、参数和缓冲预算错误不自动恢复。失败响应的模型视图被丢弃，已有确认工具、steer 和已观测 usage 保留。解析错误在已排队事件交付后立即传播；同事件或前序事件的已解析 usage 只累计一次，直接 EOF 保留原始错误类型。

Rust `Model::chat_with_limits(messages, tools, purpose, ToolCallLimits, cap)` 显式传递请求预算，内置 HTTP、共享池和 Worker 包装器均转发。可选的输出 token 上限与工具预算一起经过 Goal 计量传递。默认实现委托 `chat_limited`，保持已有自定义 Model 实现可编译，并拒绝不受支持的非空 token 上限；自定义模型自行约束内部缓冲，Engine 仍在工具执行前检查其输出。摘要使用零调用预算。`Limits` 新增 `max_tool_buffer_bytes`，`NativeFactory`/`NativeExecutor` 新增 `tool_call_limits`，显式结构体初始化需补充字段；构造器提供默认值。不增加客户端协议方法或更改快照格式。

上下文压缩保留原目标与近期内容，不拆 completion/工具结果或不透明 reasoning 边界。摘要最多 16 KiB，记录 throughItemId 与 checkpoint；网络故障重试相同摘要输入，不占用摘要格式校验次数；空摘要或伪工具摘要重试一次，仍失败时只有确实缩短输入才使用明确标记的 DEGRADED CONTEXT，否则 Turn 失败。取消不覆盖旧 checkpoint，压缩不删除历史、journal 或 Turn 工具状态。
`limits.context_compaction_enabled=false` 时自动阈值超限使 Turn 失败，显式 `areal/context/compact` 返回错误，不写入 checkpoint；配置见[上下文限额](../guides/configuration.md#模型与限额)。

模型审计写入 `data_dir/model-requests/*.json` 与 `requests.jsonl`，记录 solve/summary、参数、请求体摘要/大小、attempt、usage、stopReason、耗时与有限响应形状，不记录 header、endpoint 或 prompt。`usageObserved=true` 表示收到可解析的完整用量事件（包括 0）；缺失/false 不能视为已知零。length 终态仍收集同帧/尾帧 usage，等待受期限和取消限制，随后判定截断并禁止执行工具。

开始消费响应流前的传输失败、HTTP 错误状态和非 SSE 响应也记为 `outcome=failed`，`error` 保存脱敏诊断；非 SSE 响应提示检查完整 API endpoint，不记录错误页正文或原始响应 header。取消或未完成的请求仍记为 `interrupted_or_unfinished`。

工具错误审计新增 `errorCode` 与 `toolCallError`：`invalid_tool_call_index` 附固定原因、协议、字段路径、从 1 开始的 SSE 数据事件序号、index JSON 类型及已缓冲调用数量；`tool_call_budget_exceeded` 附预算类别、上限和观测值。字段只含固定标签和有界数值，诊断不复制 SSE、参数、reasoning 或非法字段值，使用同一记录的本地 `requestId` 关联。`responseShape.toolArgumentBytes` 沿用旧名称，实际累计通过校验的 id/name/arguments 字节。

快照写入格式 9，可读取 1–9，旧 Core 不能读取新快照。contextCheckpoint 影响模型视图，不删原始历史；modelContext 保存不透明 Responses 上下文，不投影成用户内容。缺失 usage/duration 为未知，不是 0。

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
| `agent_cancel` | `{threadId}` |

prompt 非空，最多 32000 字符且受输入字节预算约束。maxModelRounds 为 1–1024，不能扩大父上限；最后一轮仅交接。wait 超时 0–60000 ms 不取消子任务；wait_any 接受 1–16 个不同直接子任务。report 仅限子 Agent：summary 最多 4096 字符，两个数组各 16 项/项 512 字符，总参数最多 16 KiB。

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
| `areal/goal/create` | `objective, tokenBudget?, maxTurns?, maxActiveSeconds?, interactionMode?` | 根 Thread 空闲且无待处理用户队列时创建目标并原子受理首轮；已有未清除目标时冲突 |
| `areal/goal/update` | `goalId, objective?, tokenBudget?, maxTurns?, maxActiveSeconds?` | 在目标停止且清理完毕后编辑；保留目标 ID 和全部用量，不隐式启动 |
| `areal/goal/pause` | `goalId` | 持久化 paused、暂停用户队列并请求活动 Turn 取消；响应不保证清理已经完成 |
| `areal/goal/resume` | `goalId` | 校验预算、UNKNOWN 和宿主后恢复；活动容量不足时等待；队列因 Goal pause/Stop 暂停时一并恢复，其他原因的队列暂停需单独处理 |
| `areal/goal/clear` | `goalId` | 仅目标停止、无活动 Turn、无待处理用户队列或未清理资源时清除；控制 revision 递增，既有 Turn 归因、证据和计量记录保留 |

objective 为 1–4000 个 Unicode 字符且不能全空白。预算为正整数，maxTurns 包含首次根 Turn，maxActiveSeconds 统计根 Turn 的模型排队、执行、工具、交互等待和清理时间，不叠加子任务时间，不计入轮次间容量等待、暂停和离线时间。创建省略 tokenBudget 表示不设置目标 token 限额；更新省略字段表示保留原值，显式 null 可移除目标 token 限额，仍受部署上限限制。提高限额需要用户控制接口，模型不能执行。update 必须至少修改一个字段，completed 目标只读；执行新目标先 clear/create。

resume 保留计量，不能使已经达到的限额失效；completed 不可恢复。resume 同时确认此前未知模型消费的保守预留，但不删除该预留，不将 accountingComplete 改回 true；工具 UNKNOWN 仍需独立检查与 acknowledge。普通 `thread/resume` 仍只恢复订阅和快照，不恢复 Goal 执行。暂停时保存原因，只有属于该次 Goal 暂停的队列暂停才可被 Goal resume 自动撤销。

投影包含 `threadId`、`revision`、`eventSequence` 和 `goal`。goal 包括 `id`、`threadId`、`objective`、`status`、`reason`、预算及计量、`activeTurnId`、`settling`、`waitingForInput`、`waitingForAgents`、`waitingForCapacity` 和最近报告 `report`、`reportTurnId` 和连续未报告计数 `unreportedTurns`。status 使用 `active / paused / blocked / completed / budgetLimited / failed`。`revision` 只随控制状态变化，eventSequence 随持久投影变化；get 和原子 resume 返回当前计量，流式用量不逐 token 发布 Goal 事件。持久状态和受理结果保存后发布；保存失败时仅发布内存中的 failed/SystemError，重启以保守恢复为准。

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
| `goal_update` | `{expectedRevision, status, summary, evidence, remaining, blocker?}` | 仅当前 Goal 的根 Turn；status 为 continue/complete/blocked；仅报告进展或提交结算申请 |

goalId 和根线程身份由 Core 绑定，模型不能自报其他目标。summary 非空、最多 4096 字符；evidence 和 remaining 各最多 16 条、每条最多 1024 字符，总参数最多 32 KiB。complete 要求 remaining 为空且 evidence 非空；blocked 要求非空 blocker 描述具体障碍及解除条件。evidence 是模型提交的文字报告，可引用工具 Item、检查回执或产物；它不是独立的语义验收器。Core 校验报告结构、未消费的验证句柄、待处理输入、子任务和 Workgroup 结算状态；业务正确性仍依赖实际检查和模型报告。

`goal_update` 返回受理后的控制 revision，complete 在当前 Turn 正常结算前只是待处理申请。用户修改状态、steer 或排队追加输入会使旧申请失效；资源清理、持久化或子任务失败不得发布 completed。模型不能通过工具创建目标、解除暂停、提高预算、清除目标或绕过审批；自然语言“完成”及普通 Turn completed 也不能直接改变 Goal 状态。

Rust 嵌入式调用使用 `Limits.goals: goals::Policy` 及 `Engine::goal_get/goal_create/goal_control`。自定义 Model 的 `chat_limited` 必须显式接受逐请求输出上限，`share_context` 保留预算归因；内置 HTTP adapter 已支持。自定义 Workgroup Factory 需实现 `executor_for_goal` 并保留传入 Budget；默认实现对有 Goal 的调用明确报错。普通 Turn 和独立 Workgroup 沿用原行为。

Goal 请求账本位于 `goals/<goal-id>.json`，发送前持久预留；主/子 Agent、原生 Workgroup 和活动 Turn 的摘要共享计量，cachedInputTokens 是 inputTokens 的子集、不重复累加。每账本最多 4096 请求/4 MiB；clear 保留账本且不回收历史。快照格式 10 保存 Goal、Turn 归因、思考 Item 与 Task 交互策略，旧二进制不能读取；API 版本仍为 areal.core.v1。

Task Mode 在 Goal 之上提供 foreground/scheduled/background 任务、TaskRun、独立 Channel 与 Inbox。Goal create 同时返回 taskId/runId；Goal 内的 ask_user_question 可选 mode=async，headless 不等待用户。接口、预算与恢复语义见 [Task 契约](tasks.md)。timeUsedSeconds 包含协调 Turn 与 TaskRun worker 活动时间的并集，纯异步用户等待不计入。
