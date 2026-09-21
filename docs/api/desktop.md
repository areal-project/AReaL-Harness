**中文** | [English](desktop.en.md)

# 桌面 API：areal.core.v1

本契约扩展 [Core WebSocket](core.md)，与 Runtime JSONL 和 [CLI stdio](claude-cli.md) 分开。完整请求、响应、通知和持久类型见 [areal-core-v1.json](../../schemas/areal-core-v1.json)；请求拒绝未知字段。

## 认证与连接

产品服务监听 loopback，WebSocket 和 Blob 使用启动器认证。可信 Main 从 ready 元数据的 authFile 读取 Bearer token；Renderer 不持有该文件或模型密钥。内置 Web 通过 POST /areal/auth/session 换取 HttpOnly、SameSite=Strict cookie 并验证 Origin。

认证文件 `{version:1,principals:[{id,token,permissions,threadIds?}]}` 必须为 0600。权限为 observe/interact/manage/tools；显式 threadIds 限制观察与交互。客户端名称和 Thread ID 不等于认证。

initialize → initialized → areal/capabilities（可带 apiVersion）。请求 ID 双向独立，item/tool/call 是须应答的服务器请求。恢复用 thread/resume 替换基线；订阅、发送队列与背压见 [Core](core.md)。

## 方法目录

| 方法（省略 `areal/`） | 权限 | 行为 |
|---|---|---|
| capabilities | observe | 协商 areal.core.v1、方法、事件与实际限制 |
| profile/list/read, skill/list/read | observe | 版本化定义与按需资源读取 |
| thread/start/configure | interact；动态工具另需 tools | 持久受理、空闲时 CAS 配置 |
| plan/read/update | observe / interact | 最多 64 步，expectedRevision 条件更新 |
| interaction/list/respond | observe / interact | 追问/审批，绑定 Thread/Turn/requestId |
| provider/list/read/upsert/remove/probe | manage | 凭据引用、CAS 写入与显式连通性探测 |
| model/list | observe | providerId/modelId、能力和可用状态 |
| turn/start/enqueue, queue/list/update/remove/reorder/pause/resume | observe / interact | 持久提交、冻结配置与队列管理 |
| request/read | observe | 按当前身份找回受理收据 |
| process/start/list/get/read/wait/write/resize/closeStdin/terminate | observe / interact | 受管进程与共享终端 |
| process/acknowledgeCleanup | manage | 旧 epoch 的外部清理证据，保留 UNKNOWN |
| thread/closeResources | interact | 等待受管资源回收 |
| agent/spawn/wait, workflow/list/read/start | observe / interact | 配置化子任务或 Workgroup |
| mcp/list/read/configure/connect/disconnect | manage | 配置、连接和目录 revision 分开管理 |
| thread/inspect, context/read/compact | observe / interact | 权威执行视图、分页和空闲压缩 |
| thread/archive, blob/release | interact | 冷历史与未引用上传释放 |
| server/status/drain/gc | manage | 资源使用、收敛与 Blob 回收 |
| subscription/remove | observe | 退订观察，不撤销工具宿主 |

<a id="submissions"></a>
## 提交、配置与恢复

requestId 是持久业务键，RPC id 只关联响应。相同身份、方法、键和规范参数返回原结果；参数不同冲突。Thread 最多 1024 收据，管理日志 4096；容量满拒绝而不遗忘旧键。重启后 accepted 但无结果的管理记录为 UNKNOWN，不重新执行。

turn/start/enqueue 使用 `{requestId,threadId,input,expectedConfigRevision?}`。队列最多 128 历史项，每项冻结配置；仅成功自动推进，Stop/失败/UNKNOWN/重启/drain 暂停，必须显式恢复。超时后先 request/read 或读权威状态，不能推断没发生副作用。

thread/configure 使用 expectedRevision，仅空闲且不压缩时生效。resetModel=true 清除会话模型覆盖并回到 Profile/服务默认，不能与非空 model 同传；parameters 省略保留，`{}` 使用目标 Provider 默认。features.modelReset 声明支持。

options.readOnly 收窄 Scope 写根和网络；toolAllowlist 收窄 Profile；preapprovedTools 不能取消部署强制审批。maxModelRounds 为 1–1024，最后一轮仅交接，不等于团队请求预算。Profile/Workflow 定义使用不可变 id/revision；Skill 引用不冻结资源内容，见下文。

<a id="skills"></a>
## Skill 元信息与资源

可信部署清单的 skills 接受 `{id,revision,root,metadata?:{name,description}}`；root 相对清单目录。省略 metadata 时只解析 SKILL.md 的有界文件头，不扫描附件；显式部署和自动发现使用同一种按需读取行为。

`areal/skill/list` 的 data 条目增加 name/description，resources 统一为 null（不再返回完整资源清单），available 和 resourceRoot 保持原意。模型初始提示只注入名称和有界描述；需要正文时调用 skill_read。

`areal/skill/read` / `skill_read` 每次从当前磁盘读取，maxBytes 为 1–8192，使用 offset/nextOffset 分页；sizeBytes 表示该次打开文件时的大小。资源允许超过 256 KiB，二进制返回 dataBase64；并发修改下不保证跨页一致性。资源路径限制与发现告警见[Skill 指南](../guides/skills.md)。

兼容性：Skill revision 不再是内容不可变保证，旧 skillHashes 被忽略；现有 `{id,revision,root}` 清单仍可使用。历史引用必须由可信启动器登记，否则标为不可用。自动发现 revision 改为元信息摘要；Profile/Workflow 定义与会话历史的持久化语义不变。

## 交互与媒体

审批绑定 Thread/Turn/callId、Host generation、有效参数摘要与权限，仅 allowOnce/deny；不能扩权。问题最多 8 题/题 8 选项、答案 4096 字节、交互历史 256 项；等待不持有模型许可，Stop 优先，迟到或跨 Turn 回答拒绝。

POST `/areal/blobs?threadId=...` 上传原始字节，Content-Type 与签名一致；工具上传另带 callId/hostGeneration 并需 tools 权限。单文件 16 MiB，Thread 128 项/64 MiB，全局 16384 Blob/512 MiB。支持 PNG/JPEG/GIF/WebP、WAV/MP3、PDF、UTF-8 文本。GET 需要认证、threadId 和引用归属；摘要不是令牌。

contentItems 按顺序保存 inputText 或 arealMedia，实际字节进入模型。认证 RPC 拒绝宿主 localImage/localAudio 路径，使用上传返回的 areal://blob URI。不支持的模态明确失败。

## 进程与保留

process/start 默认 lifetime=turn；thread 生命周期需 Profile allowThreadProcesses，写服务还需部署 allow-concurrent-writes。输入归因到认证身份，输出游标与清理沿用 Runtime。PTY resize 为实际 ioctl；pipe EOF 关闭 FD，canonical PTY 使用 VEOF，raw mode 不支持。

旧 epoch 句柄为 STALE_HANDLE，不恢复活进程。Thread 进程、UNKNOWN、活动组或压缩阻止 restartSafe。归档需空闲且队列/资源结算，释放热历史并保留磁盘和去重键；GC 在 drain 完成后扫描冷热引用，不能删除历史仍引用的 Blob。

事件使用 areal/ 前缀，包括 thread/configured/archived、plan/updated、queue/updated、interaction/requested/resolved、process/updated、server/draining。各自 revision 不可与输出 cursor 混用。未知模型窗口/usage 保留 null 或缺失，不猜测。示例见[直接协议验收](../examples/desktop-api.md)。
