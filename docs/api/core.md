**中文** | [English](core.en.md)

# Core API

Core 提供固定 Codex app-server 0.145.0 的子集与 AReaL 扩展，不代表官方客户端全兼容。原始基线见 [schema](../../schemas/app-server/codex-0.145.0.json)，认证与产品新增接口见[桌面 API](desktop.md)。

## 传输与会话

每个 WebSocket 文本帧是一条请求/响应/通知，上限 4 MiB。请求 `{id,method,params}`，id 为字符串或整数，params 为对象；可省略 jsonrpc，响应 result/error 二选一，不支持批处理。先请求 initialize，再发送 initialized 通知。

| 方法 | 参数 |
|---|---|
| `model/list` | `{}` |
| `thread/start` | `{cwd?,model?,dynamicTools?}` |
| `thread/list` | `{cursor?,limit?}`; 1–100, default 30 |
| `thread/read` | `{threadId,includeTurns?}` |
| `thread/resume` | `{threadId}` |
| `turn/start` | `{threadId,input}` |
| `turn/steer` | `{threadId,expectedTurnId,input}` |
| `turn/interrupt` | `{threadId,turnId}` |

Core 拥有 Thread/Turn/Item 的稳定 ID 与历史。read 不订阅，resume 原子读取快照并建立增量边界，先返回基线再发事件。每连接最多 128 订阅，发送队列 256、Thread 事件窗口 128；落后时断连，重连后重新 resume。普通观察断连不取消任务。

input 为有序 text/image/audio/file 等内容，UTF-8 文本合计最多 1 MiB，仍受历史预算约束；认证客户端上传媒体 Blob，不传宿主 localImage/localAudio 路径。模态由 adapter/模型能力校验。原有 thread/start 的 model 需匹配服务默认；产品模型选择使用 areal/thread/start/configure。

事件包括 thread/started、turn/started/completed、item/started/completed、item/agentMessage/delta；AReaL 媒体通知为 areal/item/agentMedia/available。终态 completed/interrupted/failed 在保存后发布。steer 保留已输出文本，取消当前模型请求后在同一 Turn 继续。

<a id="recovery"></a>
## 执行与恢复

工具只在完整模型流终态后执行。dynamicToolCall 保留原始 arguments、有效参数 effectiveArguments、callId、execution 后端与 running/succeeded/failed/cancelled/unknown。本地工具另记 epoch/scope/operationId；外部工具不伪造 Runtime 事实。hooks 和插件嵌套操作分别 journal，成功写入不因外层失败抹掉。

参数/schema 确定错误可返回模型修正；持久化失败或 UNKNOWN 停止自动执行。`areal/tool/acknowledge {threadId,itemId,inspection}` 只在空闲时记录 1–1024 字节检查说明，历史仍为 unknown，不重放、不扩权。

`execution.backend` 为 runtime/command/client/mcp/plugin/agent/coordination/core。可选 `modelArguments` 保存 hooks 之后、Runtime ID 展开之前的模型回放参数；`effectiveArguments` 保留真实 ID 供审计，旧记录回退使用后者。回放按 completion 保留一个 assistant 文本/工具调用批次，再接有序工具结果；不合并不同 completion。工具图像在结果批次后作为关联 callId 的 user 图像。Chat reasoning 归档但不回放，Responses 不透明上下文保持顺序。

`Limits.watchdog_disable` 默认 false，Core 对已分类的网络故障无限次重试当前模型请求，包含传输错误、HTTP 408/429/5xx、提前断流、请求/流空闲超时与明确的 SSE 限流/不可用；不把长度、空回复、鉴权、额度或参数错误当成网络故障。启动配置与关闭方式见[配置指南](../guides/configuration.md)。主 Agent、子 Agent 与独立 Workgroup Engine 继承宿主开关；嵌入式调用方显式传入 Limits，Engine 不读取进程环境。Rust `Limits`、`NativeFactory` 和 `NativeExecutor` 新增 `watchdog_disable` 字段，显式结构体初始化需同步更新；`Limits::default()` 与 `NativeExecutor::new()` 默认启用。

watchdog 保留同一请求的 messages、tools、采样参数与模型轮次，不消耗 `max_completion_retries`；重试不会再次预留 Agent 逻辑请求额度，Workgroup 仍计入每次实际请求及部署预算。250 ms 指数退避封顶 30 秒，释放失败流持有的共享模型许可后等待；取消与总期限仍能结束等待，求解请求还响应 steer。Core 审计并丢弃失败响应的文本、上下文与未执行工具调用，恢复该响应占用的输出字节额度，保留此前已执行工具和已观测 usage。发布 `areal/model/completionDiscarded`（新增 `retryKind=network|completion`）及 `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`。这里的丢弃不回滚已执行工具，也不重启整个 Turn。

`max_completion_retries` 默认 0，可为已分类的长度截断、空回复等提供有限恢复（仅 reasoning 不算最终回复）；关闭 watchdog 后，已分类网络错误也沿用此有限额度。工具仍只在完整成功流后执行；UNKNOWN、持久化错误、取消与总期限错误不重放。

上下文压缩保留原目标与近期内容，不拆 completion/工具结果或不透明 reasoning 边界。摘要最多 16 KiB，记录 throughItemId 与 checkpoint；网络故障重试相同摘要输入，不占用摘要格式校验次数；空摘要或伪工具摘要重试一次，仍失败时只有确实缩短输入才使用明确标记的 DEGRADED CONTEXT，否则 Turn 失败。取消不覆盖旧 checkpoint，压缩不删除历史、journal 或 Turn 工具状态。

模型审计写入 `data_dir/model-requests/*.json` 与 `requests.jsonl`，记录 solve/summary、参数、请求体摘要/大小、attempt、usage、stopReason、耗时与有限响应形状，不记录 header、endpoint 或 prompt。`usageObserved=true` 表示收到可解析的完整用量事件（包括 0）；缺失/false 不能视为已知零。length 终态仍收集同帧/尾帧 usage，等待受期限和取消限制，随后判定截断并禁止执行工具。

快照格式 5 可读 1–4，旧 Core 不能读取新快照。contextCheckpoint 影响模型视图，不删原始历史；modelContext 保存不透明 Responses 上下文，不投影成用户内容。缺失 usage/duration 为未知，不是 0。

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
