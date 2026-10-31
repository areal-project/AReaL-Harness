**中文** | [English](remote-control.en.md)

# Remote Control API：areal.remote.v2

除下一节明确标注的 RC-01/RC-02/RC-03/RC-04/RC-05/RC-06/RC-07/RC-08/RC-10/RC-11/RC-13 范围外，这是后续设计契约。文中的新增方法、字段和部署入口在实现并通过测试前均不可声明为已支持。Core 的既有协议继续独立版本化。视图最小字段见 C14。

## 已实现边界：RC-01/RC-02/RC-03/RC-04/RC-05/RC-06/RC-07/RC-08/RC-10/RC-11/RC-13

当前实现开发用的加密 Direct 与本地确认配对：默认关闭的独立 `127.0.0.1` 监听器、可选择记住的浏览器身份、Host pin 校验、v2 hello，以及 `host.describe` / `project.list` / `project.models` / `work.list` / `attention.list` / `session.open` / `session.history` / `subscription.close` / `session.create` / `session.send` / `turn.stop` / `attention.read` / `interaction.respond` / `task.question.read` / `task.question.reply` / `task.read` / `task.pause` / `review.read` / `artifact.read` / `command.read` / `device.push.register` / `device.push.unregister`。可信桌面已接入 Serve、可选 Funnel 范围切换和组织 HTTPS 来源配置（Funnel 公网能力未认证），具体见 C11；实际 Tailscale/组织代理、手机真机验收以及其余方法仍需后续证据；Relay 已接入同一 Host/PWA 协议，源码与本机严格 TLS 夹具覆盖见 C12。本页的完整 P0 契约不代表这些能力已经可用。

桌面生成 120 秒一次性链接（开发模式为 loopback HTTP），fragment 携带 `host` 和 `invite`。浏览器立即移除邀请，仅保留校验后的公开 `host` pin 和可选 Relay `room`，在 Noise 验证 Host 后才发送 `inviteSecret`，收到 `pairing` 后等待本地确认。可信本地 `remoteControl` 支持 `pair/cancelPair/approve/reject/updateGrant/revoke/renameDevice/forgetRevoked`；确认与更新提供设备 `id`、显式已有项目 `projects` 及 `preset: Observer|Operator`。桌面展示完整 Noise peer 指纹与项目选择，复制/粘贴链接可代替扫码。本地确认必须在截止前作出，确认后的持久写入成功才返回 ready；写入失败不授予新权限。传输建立的 15 秒期限在收到 pairing 后结束；人工确认继续由 Host 的 120 秒邀请期限及取消/拒绝结果约束。

加密 `remote.json` 保存 Host identity 与 `deviceGrants`，包含 `devicePeerId/displayName/projectIds/capabilities/revision/status`。范围更新或撤销先持久保存，再关闭该设备旧连接。当前实现的能力为 `observe`、`review`、`submit`、`interrupt`、`answer` 和 `pauseTask`，ready 与 host.describe 只返回和当前授权的交集；Operator 的既有 `pauseTask` 与 `review` 一样按当前授权交集公告；Observer 或不含该能力的旧授权不会得到它。旧 `devices` 保留身份和项目并进入 `reviewRequired`，旧写客户端只能得到升级要求；迁移保存失败保留原文件并关闭入口。安全存储不可用或使用 `basic_text` 时拒绝启用。浏览器默认仅本次使用；配对前明确选择“记住此设备”后，在已验证 Host 的 ready 后将身份、Host pin 与校验后的公开 Relay room 原子保存到该 origin 的同一 IndexedDB 记录。缺少 room 的旧记录保持 Direct 语义；根页面或 manifest 启动先恢复该 room，再选择传输。相同 Host 重新登记到新 room 时，仅在再次验证 pin 并收到 ready 后原子更新公开 room 与 revision；失败不会替换原绑定，清除此设备同时清除此路由元数据。保存失败不会宣称记住成功。

可选 Direct 入口启动失败时，后台服务继续启动，本次 `directEnabled` 回到关闭状态并尝试持久保存；若保存也失败，可信本地 `remoteControl.status.directError` 明确提示。失败的启用操作不保留监听器。Host 断开后，浏览器清除旧连接投影；瞬时故障以带抖动的 0.5–30 秒退避重连，隐藏或离线时暂停。前台恢复重新验证本地身份并建立新连接、基线和订阅；授权或协议拒绝停止自动重试。

读请求为 `{id,method,params,context?}`。`host.describe` 的 params 为空对象；`project.list` 接受可选 cursor、limit，并返回 `{projects,nextCursor}`。可选 `context.projectId` 必须指向当前已授权且已登记的项目。Host/项目响应仅包含 ProjectView 元数据，不返回桌面快照、项目根路径或服务凭据；概览另提供已授权的有界任务标题和待处理摘要。实际 capabilities 与 limits 由 ready 和 host.describe 返回；写方法仅开放下述普通会话、确切 Turn 停止、同步交互与 Task 异步回复范围。

`work.list` 必须提供 `context.projectId`，接受 `filter: all|active|attention`（默认 all）、`cursor?` 和 `limit?`，返回 `{projectId,serviceGeneration,data,nextCursor,complete}`。`attention.list` 使用同一项目上下文，接受 cursor/limit，返回有界 AttentionSummary 页并额外标注 `summariesComplete`。两者只使用当前在线且兼容的既有 Core 连接，异步读取后重新核验授权，不启动服务或修复配置。ready 与 host.describe 同时返回实际已实现的方法列表。

原生 `areal/work/overview` 在分页前按 principal/thread 范围收窄，直接读取既有 Thread/Turn、TaskRun、待处理交互、队列和 Task Channel，不展开完整历史或新增持久状态。普通已归档 Thread 不进入概览；已由 Run 表示的协调 Thread 与 worker 不重复列作普通会话，worker 在 Run 下明确归属。运行中或失败工作也可能有可读结果，结果可读不表示成功。更新时间只用来源记录，没有可证更新时间时为 null。

概览默认 30 条、最多 100 条、页面不超过 128 KiB。标题最多 512 UTF-8 字节，待处理摘要最多 256 字节；每张工作卡最多携带 32 个待处理引用和 32 个 worker，另给出实际数量、完整性及 `summaryTruncated`。原生 thread/task/run/interaction/question 身份是桌面详情引用。摘要截断不表示已加载全部待处理或 worker；此时 attention.list 明确返回 `summariesComplete: false`。不包含完整参数或 transcript。概览的 `availableActions` 仍为空；创建/发送入口根据连接能力与当前详情状态启用。

生产 Remote 页面只在可见时每 5 秒刷新，重新可见或收到 `remote-operation-complete` 时立即刷新，部分加载数量明确标注未完整。操作完成钩子重新读取 Core，不猜测操作结果；前台刷新替换当前页，加载更多须显式点击。不创建全局 Inbox 订阅。

### Session 观察与分页

`session.open` 接收 `{context:{projectId},params:{threadId}}`，响应包含 `connectionId/gatewayGeneration/serviceGeneration/subscriptionId/projectId/sequence:0/snapshot`。每个连接只保留一个详情引用；同项目、同 Thread 的多个引用共享专用只读 Core 观察。每次打开或刷新都通过 `areal/thread/observe` 重取原子基线与 Core 所有权，要求 `atomicObserve/atomicObserveOwnership/subscriptionRemoval` 三项能力，缺失返回 `CORE_INCOMPATIBLE`。归属不从 Gateway Task 扫描推断。Turn、Goal、配置事件触发归属重取；仅 Task 变动需要刷新或重新打开。

`session.updated` 带相同身份、递增 sequence 和替换用 snapshot；`session.invalidated` 带错误与 unavailable/truncated。旧身份消息不可写入当前视图，同身份缺口重新打开以替换基线，没有耐久增量回放。CoreClient 在结果分派栈内建立基线，最后发布前同步复核设备授权、Desktop client、端点与服务代际。

`session.history` 接收 `{threadId,cursor?,limit?}`，返回同一详情身份、turns、nextCursor、hasMore、truncated、unavailable、range。上限 100 Item，正文预览按 UTF-8 1024 字节截断。不可内联的正文带 `bodyDetail` 的 Thread/Turn/Item 引用及 unavailable 原因，当前完整查看仍在桌面；不提供通用文件读取。游标只绑定当前 Core 可读取范围，不是耐久 replay cursor。`subscription.close` 接收 `{subscriptionId}`，只释放调用连接的匹配引用。

最多 16 个专用项目观察连接及 16 个 Thread 订阅（包含等待建立者）；每项目串行读队列最多 16 项。只有已在线、已有授权需求的项目才连接；不 ensure/resume、配置、绑定或接管 ToolHost。每连接发送排队合计上限 2 MiB，明文输出队列与 WebSocket 发送队列各限 1 MiB；另有有界的在途 Noise 分帧，不将队列限制等同于进程总内存限制。专用观察 socket 的原生消息上限 4 MiB，超限将该项目 Remote 视图置为不可用并关闭观察连接，不关闭 Desktop ToolHost。此上限不保证 Core 历史 hydration 的 CPU/内存隔离。关闭最后引用释放专用连接，不取消 Core 工作。Web 客户端的 `session.open` 等待 15 秒后超时会关闭发起请求的连接，以释放可能已创建但尚未确认的观察订阅；其他只读请求超时不主动断开连接。

验证入口：`pnpm --dir clients/gui run test:remote-session` 与 `AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-session-e2e`。后者运行隔离 Core/Runtime、真实 Electron 与生产 Remote 页面，使用确定性模型和显式传输故障；系统钥匙串、发行包、公网及手机真机不由此验证。

### 原轮次结果与图片审查

`review.read` 要求当前 `observe` 和 `review`，参数为 `{threadId,turnId,itemId?,cursor?,limit?}`，项目由 `context.projectId` 指定。它通过既有专用只读连接读取 `thread/read`，不启动、打开、恢复或配置桌面 Thread，不注册工具宿主。响应绑定 `projectId/threadId/turnId/itemId/connectionId/gatewayGeneration/serviceGeneration`；`review:{encoding:"json-utf8",offset,totalBytes,chunk}` 分页承载 JSON，`nextCursor` 是仅当前 Gateway/设备连接/原内容有效的加密游标。`limit` 为每页 UTF-8 字节预算，默认及最多 16 KiB；完整 JSON 最多 4 MiB。内容变化使旧游标失效，不拼接不同版本。

完整正文包含原 `turnStatus/error/partial`、按 Item 标识的文本、phase、工具状态和 executionOutcome，以及 `diff` 的 state、scope、base/head、notice、provenance 和按路径键组织的结构化 hunks。失败或中断 Turn 的文本明确为部分输出，不推断成功。`taskRunStatus:null` 明确表示此接口没有原 Turn 的 TaskRun 状态；协调 TaskRun 只有 Thread 绑定，没有 Turn 绑定，worker 的精确 Turn 绑定只存在于已知 TaskRun 内。当前 Task 所有权或最新 Run 不能替代历史关联；TaskRun 状态继续通过概览/Task 读取独立展示。

Diff 复用既有历史 Runtime 文件写入重建，不读取当前工作区。只采用已完成且 Runtime 明确成功的工具记录：若记录包含 `execution.effectiveArguments`，必须使用该对象；只有字段缺席时才使用 Core 已解析的 `item.arguments` 对象。显式 null、字符串、数组或其他无效覆盖不可回退，不解析 `originalArguments`，也不使用 `modelArguments`。参数路径必须与结果路径一致，写后 UTF-8 字节数及 SHA-256 必须吻合；覆盖写入和补丁还需要完整写前文本/hash 的连续版本链。创建无需既有写前文本；完整 `fs_read` 仍须 offset 为零、eof、字节数和 hash 全部验证，读取长度被收窄不放宽这些条件。Shell、重命名、删除、二进制、缺少写前版本或未完成 Turn 明确不可用。notice 保留范围限制，不能将部分可验证写入说成整个 Turn 的排他变更。每次审查仍从原记录重建文本和 diff；分页正文预算不保证 Core 历史读取或重建的 CPU/内存上限。

首页 `artifacts` 最多 16 项 `{itemId,mime,size,artifactRef}`。Host 只从原 Turn/Item 的 AgentMedia 或工具 arealMedia 生成不透明加密引用，绑定当前设备授权修订、连接、项目、服务代际、Desktop client 身份和原生 blob 元数据；不接受上传登记作为 Turn 归属。超出列表、非本机 blob、未知 MIME 或超过 16 MiB 的元数据不生成可读引用，并提示桌面查看。`artifact.read {artifactRef,offset,length}` 每次重新读取精确原记录并校验当前授权；`length` 为 1–48 KiB。响应含相同身份、artifactRef、offset、totalBytes、nextOffset、base64 和 `raster:{mime,width,height}`。资源消失返回 `RESOURCE_UNAVAILABLE`，不替换文件。

Host 仅向已验证原生端点发起带认证的 GET，拒绝重定向；流式累计检查 metadata/Content-Length/实际字节上限、SHA-256 和图片签名/尺寸，错误、撤权或超时取消流，最后重新读取所属记录并在发布前复核身份。没有正文缓存：每个块请求重新流式读取完整原 blob；既有 Core HTTP 仍会整体分配 blob，Native 分配和大图片吞吐尚不能由 Remote 分段预算保证。

PNG/JPEG/GIF/WebP 的宽高均不得超过 16384，像素乘积最多 16 Mi；动画 PNG/GIF/WebP 不提供内联预览。浏览器独立校验总量、块长、签名和尺寸，再通过浏览器解码验证后创建 blob URL；只保留一张活动图片，关闭审查/会话、切换图片、授权或连接/服务变化时清除正文并撤销 URL。文本仅使用 textContent，不执行 HTML/SVG，不自动加载外链，不缓存 API/制品或写入文件。上述源代码与 fixture 检查不等同于真实 Native、浏览器/手机解码或发行包验收。

### 普通会话命令与受理查询

源码实现 `session.create`、`session.send`、`turn.stop` 与 `command.read`；fixture 与构建检查不等同于原生 T18–T22、发行包或手机验收。新写入使用 C3 的 commandId 与完整 context；查询使用 `{context:{projectId},params:{commandId}}`，仍要求当前设备对项目有原命令的能力（初始查询要求 `observe`，找到后 create/send 要求 `submit`，stop 要求 `interrupt`，interaction.respond/task.question.reply 要求 `answer`）。已有关联可跨授权 revision 和服务代际读取，不能重派发。并发请求在异步准入预检查中遇到拒绝时，先串行核对是否已有同键关联：同语义返回原状态，异语义返回 COMMAND_CONFLICT；当前授权和连接身份校验仍然必须通过。

创建只使用 Host 的默认普通 Profile，要求原生 `threadStartAdmissionGuard`；Workflow 默认 Profile 返回 `UNSUPPORTED_PROFILE`。发送要求 `turnStartAdmissionGuard`，使用原始 threadId、text、expectedConfigRevision，且不自动入队。提交前通过现有有界只读观察所有者临时取原子归属与状态，不替换用户详情引用；Task-owned、忙碌、配置/队列改变分别返回结构化拒绝。Core 锁内再次校验普通归属、空闲与配置 revision，预检查不是最终准入。 空队列的暂停标记不阻止用户主动发起新轮次，也不会自动恢复队列；保留的 pending/running 队列项仍阻止普通新轮次准入。

Host 在原 pending/outcomes 文件持久保存作用域关联和生成的日志 UUID（create/send 同时用作原生 requestId），然后才与授权修改共用串行队列完成最后检查及同步 RPC 发起。RPC 回应不占用授权队列。终态含语义摘要、不可变授权来源、受限 Thread/Turn ID 或错误，先保存再移除 pending；不会重复保存文本或 transcript。磁盘写失败不派发，结果写失败保持 unknown，终态已保存时优先于遗留 pending。每项目最多 4096 条 pending 与 outcome 记录，单条 Remote pending 最多 72 KiB，终态最多 4 KiB，不自动淘汰去重证据；正文单独限制 64 KiB UTF-8。

CommandView 返回 `commandId/method/target/operationId/admissionState/submissionUnknown`，有原生请求键的方法还返回 `nativeRequestId`，明确终态可额外带 `threadId/turnId/error:{code,coreCode?,message}`。创建查询使用原生 receipt 的精确 threadId；发送查询使用精确 Turn 结果。查询仅加载本机日志、必要时读取已有在线连接的 `areal/request/read`；不启动 Core、不打开会话、不配置、不重放。已保存终态可在 Core 离线时读取。原生读取或提交之后发布前重新核验当前授权及连接身份。Direct 命令错误只使用固定协议文案；底层文件或网络错误（包括字符串错误码）不透传原始 message、路径或凭据，并保守提示查询原命令。

生产页面在第一次传输前于内存保留 commandId、原始参数和草稿。断线/超时只允许核对原命令，重连后自动只读查询；notFound 也不证明未执行。只有明确 accepted 才清空未被用户修改的对应草稿；拒绝/冲突保留草稿，用户显式再次发送才创建新的意图。仅本次使用的身份与命令记录仍随页面消失；记住的设备在传输前等待最小命令定位信息的 IndexedDB 事务提交。定位信息只含 Host、项目、原 commandId、方法和目标身份（审批可含参数摘要），不含正文、回答、决定或 reviewToken。刷新后全部恢复为 unknown，仅查询原 command.read；pending、unknown 和 notFound 都保留，accepted/rejected 在本地清理事务完成后才解除待核对状态。原目标不再显示时仍提供独立查询入口。

验证入口：`pnpm --dir clients/gui run test:remote-command`（磁盘故障与 RPC fixture）、`pnpm --dir clients/gui run test:remote-session`（生产页面 DOM/传输 fixture）。原生入口为 `AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`，使用独立 Host 进程、实际 Core/Runtime 与 Noise，默认 100 次确定性竞态；只有获准启动原生环境后执行，源码存在不代表已通过。`RC05_RACE_REPETITIONS` 小于 100 仅用于诊断，不满足竞态验收门槛。

`turn.stop` 只接受 `threadId` 与 `expectedTurnId`，要求 `interrupt` 能力和原生 `turnInterruptAdmissionGuard`。观察到 Task 管理会话时返回 `TASK_CONTROL_REQUIRED`，提示使用明确 Task 控制；原 Turn 已结束或换成新 Turn 时返回 `TARGET_CHANGED`。Core 锁内 guard 是最终权威；预检查后发生的目标或所有权竞态由 Core 返回冲突。原始两项 ID 同时进入语义摘要和日志目标；原样发送 `turn/interrupt {threadId,turnId:expectedTurnId,admissionGuard:{ordinarySession:true}}`，不会选取新的 Turn。

停止的 operationId 仅为预先持久化的日志 UUID；原生 interrupt 不支持 requestId，因此不传该字段，也不返回伪造的 nativeRequestId。已保存明确响应可恢复；丢失回应/保存失败保留 unknown。停止的 `command.read` 不调用 `areal/request/read`，也不重发 interrupt。未知停止关联不阻塞另一个设备停止确切目标，也不阻塞 Core 已确认空闲后的新消息；原生 guard 仍校验每次新命令。桌面 pending 控件与提交/配置/生命周期阻塞排除这类精确 Remote 停止记录与下文的同步交互记录；关联仍完整保存在原日志，create/send 的未知记录继续阻塞，不能借此宣称停止成功。

生产页面只对当前投影中明确 `inProgress` 的普通 Turn 启用停止。每个目标保留独立意图，后续 Turn 的停止必须是新的显式操作。受理信息与原 Turn 的只读观察并列：只在同一原 Turn 明确为 completed/interrupted/failed 时显示该终态，activeTurnId 改变、Turn 缺失或断线均不代表停止完成。unknown 不因观察到终态而变成 accepted，也不声称本设备导致停止；缺失状态可用会话刷新核对。停止始终保留消息草稿。

### 同步交互审阅与回答

源码开放 `attention.read` 与 `interaction.respond`，能力分别是 `observe` 与 `answer`；原生 T25–T27、发行包和真机验收需单独完成。AttentionSummary 中的 `threadId/turnId/interactionId` 是原目标引用，不能当作端点、路径或凭据。详情请求为 `{context:{projectId},params:{threadId,turnId,interactionId,cursor?}}`，目前仅支持工具审批与同步问题，不包含 Task Channel 问题。

详情复用 SessionObservers 的专用只读连接、连接数与待处理队列预算，调用 `areal/interaction/list`，不替换当前 Session 订阅或 Desktop ToolHost。每页异步读取后重新校验当前连接、设备授权、项目对象、Desktop client、端点、服务身份与代际，再同步发布。原生整个回应超过 4 MiB 返回不可用；不新增原生分页或读取另一服务。

响应保留 `projectId/serviceGeneration/threadId/turnId/interactionId/kind/status/expiresAt/argumentsDigest`，其中 expiresAt 为 Unix 秒。`review:{encoding:"json-utf8",offset,totalBytes,chunk}` 分页承载序列化后的 `{tool,generation,effectiveArguments,effectivePermissions,questions}`；每页 chunk 最多 16 KiB UTF-8，不拆字符，JSON 转义后的消息仍有界。单页完整内容还直接提供这些字段，多页须按连续字节 offset 拼接后解析。`complete/nextCursor` 明确本次审阅是否已完整；不能将最后一页单独当完整正文。

游标由当前 Gateway 的内存签名绑定设备连接、grant revision、项目/服务身份、原目标/digest、到期时间及完整序列化正文。后续页只接受前一页返回的游标；最终页才给出 `reviewToken`。正文、目标、授权或连接变化要求重新审阅，不把新内容套到旧凭据。`reviewToken` 证明完整内容已向此连接提供，不声称用户实际读完，也不是新的原生执行权限。

提交仍使用 C3 的完整 context 和 commandId。审批 params 为 `{threadId,turnId,interactionId,argumentsDigest,decision,reviewToken?}`，decision 只允许 `allowOnce/deny`。allowOnce 必须携带完整审阅凭据，Host 重读当前 Core 交互核对待处理、到期、原 digest 与正文；未完整时返回 `REVIEW_INCOMPLETE`。deny 不要求凭据或完整正文读取，原 IDs/digest 原样交给 Core 校验，因此已经读取过摘要绑定的原请求仍可在正文不可用时拒绝。没有取得原 digest 时需在桌面处理，不伪造摘要。问题 params 为 `{threadId,turnId,interactionId,answers,reviewToken}`；题目/选项只来自 Core，恰好包含实际题目键，最多 8 题，每个答案最多 4096 UTF-8 字节；无自由文本权限时仅接受实际选项。

Host 保留完整原意图的深快照，语义去重包含原 IDs/digest/decision/answers，但不含会在重连失效的审阅凭据。已有同键关联及异步预检查期间并发落盘的关联优先于新审阅拒绝，同键异语义返回 `COMMAND_CONFLICT`。首次派发与撤权共用同步最终校验队列，等待 RPC 回应不会阻塞撤权。最后的 pending/Turn/digest 原子裁决仍归 Core；Host 不调用会替换缓存 Turn/digest 的桌面 respond 路径。

交互的 `operationId` 是独立日志 UUID，原生 `requestId` 保持为原 interactionId，不返回虚构的原生命令收据键。明确回应先存原 outcomes 再移除 pending；accepted 只表示决定受理，不代表工具效果。回应丢失、Host 崩溃或终态保存失败后保持 unknown，不调用原生 request receipt，不重发。`command.read` 首先要求 observe；找到关联后还要求当前原命令能力（本方法为 answer），发布前再次验证。可额外返回 `observedState:{source:"interaction.read",status,expiresAt?,threadId?,turnId?,interactionId?,provesCommandAdmission:false}`，无论 answered/expired/cancelled 都不推导本命令已受理，读取不可用时 status 为 unavailable。

精确 Remote 交互 UNKNOWN 和停止记录一样保留日志，但不加入后续桌面 pending 控件、提交/配置/生命周期的未知发送阻塞；Core 的活动 Turn 和配置 guard 仍生效，未知 create/send 继续阻塞。生产页面提供原目标审阅、继续加载、仅本次允许/拒绝、Core 问题表单、原命令核对；不完整内容不能允许，冲突刷新原请求，重连只查询而不重发。受理与独立观察分开显示，打开审阅不关闭当前 Session。

### Task 异步问题与回复

源码提供 `task.question.read`（observe）和 `task.question.reply`（answer），原生 T28/T29、发行包与真机证据仍单独验收。详情参数为 `{taskId,runId,questionId}`，来自 Inbox 的原始引用；返回 `projectId/serviceGeneration`、原始标识、`kind:"asyncQuestion"`、Core `questions/status/expiresAt`、`taskPaused/taskCancelled/runStatus/complete`。expiry 为 Unix 秒或 null；不会打开或恢复协调 Thread，也不替换当前 Session 详情。

读取复用 SessionObservers 的专用只读连接、授权与排队预算，先 `areal/task/read` 校验原 Run，再最多读取 8 个 `areal/channel/read` 页，每页至多 100 条，不返回其他消息历史。正文最多 8 题、序列化题目最多 32 KiB；无法在预算内找到完整原问题则 `complete:false`，不允许回复。每次异步读取与最终发布都检查当前授权、项目对象、服务身份和连接代际。Core 原问题内容按 questionId 不可替换，不增加 Task 审阅凭据。

回复 params 严格为 `{taskId,runId,questionId,answers}`，采用 C3 的 commandId/context。发送前深拷贝答案，以原 Task/Run/question 与规范排序的答案作为语义；同键变更回答或目标返回 COMMAND_CONFLICT，已保存关联优先于新的状态预检查。新回复重新读取完整 Core 题目，严格匹配题目键、非空答案、每题 4096 UTF-8 字节和允许选项；过期、已回答、终态或取消目标拒绝，Core 锁内校验仍为最终裁决。原始标识和答案直接交给 `areal/channel/reply`，日志 operationId 作为原生 requestId，不转成 Session 文本，不暂停或恢复 Task。

原生明确回执校验后，先在既有 outcomes 保存 `receipt:{accepted:true,messageId,taskId,runId,channelSequence}`，再删除 pending。丢响应、Host 崩溃或终态落盘失败保持 UNKNOWN，不查询不存在的 Task receipt API，不重新发送、重启服务或匹配回答文本推断成功。`command.read` 先要求 observe，找到关联后要求 answer；可返回独立 `observedState:{source:"task.question.read",taskId,runId,questionId,status,expiresAt,taskPaused,complete,provesCommandAdmission:false}`。离线仅使用已保存回执；观察不可用时 status 为 unavailable。原始 UNKNOWN 关联仍保留，但不作为后续桌面 Task 控制的未知发送阻塞；新操作仍由 Core 校验。

Task Inbox 直接打开问题与 Core 选项，不要求选择协调 Session；页面说明 Agent 待答时仍可继续工作，回复已暂停 Task 不恢复运行。记住设备时，原 Host/Project/commandId/Task/Run/question 定位信息在网络发送前完成 IndexedDB 事务，绝不保存答案；恢复只查询原 command.read，不自动重发。详情、连接或身份在落盘期间改变会阻止发送，清理定位信息失败仍保留 UNKNOWN。

### 浏览器生命周期与静态页面

“清除此浏览器设备”先同步停止连接、重试和旧异步写入，再原子清除身份、Host pin 和待核对定位信息；失败明确提示未确认清除。其他标签页通过变更通知与每次连接/提交前的存储校验失效，旧页面不能重新保存已清除身份。此操作不撤销 Host 授权，需在桌面另行撤销。不同 Host 的邀请不能替换已记住的 pin。

草稿默认仅页面内存。“恢复本标签草稿”是记住设备之外的单独选择，将文本存到当前标签的 sessionStorage，刷新可恢复，关闭标签后结束；浏览器自身的会话恢复策略可能保留它。存储错误明确显示，重连从不自动发送。恢复的命令不含原文本，因此恢复查询的 accepted 不会猜测并清除草稿。IndexedDB 与 sessionStorage 都不等同于系统钥匙串；同源恶意脚本可能读取身份与内容。

构建生成 remote-assets.json、manifest、192/512 PNG 图标和独立 Service Worker。Direct 只按清单提供 Remote 入口的完整传递资源闭包，校验摘要并使用对应 MIME，不公开桌面入口或整个 dist。Worker 安装时校验静态资源摘要，按内容版本缓存精确同源 GET 路径；查询参数、API、邀请和业务内容不进入缓存。新 Worker 等待旧页面全部关闭，页面只提示更新，不 skipWaiting、接管或自动刷新提交中的页面。离线壳不代表 Host 在线。GUI 退出只断开界面，已有后台 Host 与 Core 继续按原生命周期运行；明确停止后台服务后，网页不能远程唤醒或修复 Core。Direct 将独立端口与配置持久保存，重启先绑定原端口并核对已记录映射；稳定 HTTPS 来源的实际网络可达性、安装到手机及后台运行需要分别验证。

验证入口：先 `pnpm --dir clients/gui build`，再 `pnpm --dir clients/gui run test:remote-browser` 与 `pnpm --dir clients/gui run test:remote-static`。这些是存储/生产页面合同及实际构建 HTTP 边界检查，不代表手机、系统钥匙串或公开部署验收。

## C1. 传输、身份与版本

业务协议运行在既有 libp2p Noise 安全通道内。握手库负责身份、随机数、nonce、AEAD 和重放防护，不自行实现加密。保留现有安全通道的 `areal.remote.v1` prologue 兼容标记；**它不是本文应用版本**。加密后的首条 hello 明确提出 `apiVersion: "areal.remote.v2"`，不支持时返回 PROTOCOL_UNSUPPORTED，不回退旧写协议。hello 接受可选 `clientKind: "web" | "ios" | "android"`，其他值返回 `INVALID_PARAMS`。这是客户端声明的展示元数据，只在本地批准配对时保存，不提供授权。设置将缺省值显示为 Web 浏览器，重连不更新已保存的类型。

Android hello 需要支持 `android` 的桌面版本。旧 Host 拒绝此值，其配置解析器也拒绝已保存的 Android grant，批准后不支持直接降级。Android `https://localhost` 应加入 Relay `allowedClientOrigins`；iOS `capacitor://localhost` 属于 `allowedAppOrigins`。见 [Android 开发指南](../development/android-development.md)。

Direct 使用专用 WebSocket `/remote/socket`；同一低权限监听器只提供 PWA 静态文件、非敏感健康信息和该加密入口。Relay 复用 room/channel 的字节承载语义，外层 `areal.relay.v1` 不解释业务方法。生产只允许 HTTPS/WSS，开发仅允许 loopback HTTP/WS。

Hello 包括 `apiVersion`、客户端版本、显示名称，以及首次配对所需 inviteSecret；恢复设备不再次发送邀请。Host 身份必须与 QR/已保存身份匹配后，Client 才发送秘密。身份来自 Noise 已认证 peer，不能接受请求体提供的 deviceId 作为调用者。

ready 返回 `hostId, gatewayGeneration, connectionId, apiVersion, grantRevision, capabilities, limits`。连接、Gateway 进程及 Core 服务的 generation 分开。Host 私钥、Core/桌面 Bearer、服务 authFile、项目绝对根路径和 Provider/MCP 凭据不得出现在该响应中。

## C2. 配对与授权

邀请是 Host 生成的 256 位随机秘密、120 秒期限、一次性使用。二维码内容升级为可打开的 HTTPS 链接，邀请放在 fragment；页面在发起应用网络请求前移除邀请 fragment 字段，仅保留公开 Host pin 与可选 room，秘密不写日志、analytics、localStorage 或 Service Worker cache。提供复制链接和粘贴邀请的可访问性兜底。期限由 Host 判断。

配对状态为 created → claimed → awaitingLocalApproval → approved，或 expired/rejected/cancelled。claim 原子消费邀请，攻击者抢先 claim 最多造成拒绝服务，不能自动获得授权。桌面确认设备名、指纹、已有项目与能力后，先持久保存授权再返回 ready。名称是用户可伪造的描述，指纹才用于身份核对。

DeviceGrant 包含 `devicePeerId, displayName, projectIds, capabilities, revision, status` 和可选 `clientKind: "web" | "ios" | "android"`、`pairedAt`、`revokedAt`（毫秒时间戳）。确认配对时，与其他未撤销设备同名的 displayName 会加序号（如 `Chrome · macOS (2)`）；浏览器默认上报“浏览器 · 系统”。`renameDevice` 只改桌面展示名，不增加 revision、不断开连接；`forgetRevoked` 删除全部已撤销设备记录及其推送命令。状态接口另给出运行时字段 `online` 与 `lastSeenAt`（本次运行内的最近连接时间，不持久化）。projectIds 是当前已保存项目的显式集合，不默认包含未来项目。状态 active/reviewRequired/revoked。两个预设：

| 预设 | 能力 |
|---|---|
| Observer | observe、review |
| Operator | observe、review、submit、interrupt、answer、pauseTask |

Host 的远程管理、配对批准、配置、终端与权限记忆不属于这两个预设。授权是整个项目范围；不是自然人账号系统或 OS 级隔离。

每次命令准入、结果序列化、投影发布和制品分段都读取当前授权，不使用配对时捕获的旧对象。grant revision 改变后关闭相关连接并清除其投影/流；重新认证后下发新范围。撤销阻止新读取和新命令，不撤回已下载数据。Host必须在持久关联写入后、交付Core前再次在授权串行点检查当前grant；此前撤销则不交付。已越过最终准入并发往Core的请求可能在撤销后才收到受理回执，不承诺追回已发出的操作。持久化撤销失败则报告失败，不能宣称已撤销。

## C3. 消息封装与受理

每条应用消息为一个有界 JSON 对象。未知方法/字段拒绝；客户端遇到未知事件可忽略并重新读基线。以下是设计示例，不是当前实现：

```json
{
  "id": "rpc-12",
  "method": "session.send",
  "commandId": "6bb6eaba-5240-4313-86d4-99c9782e42e1",
  "context": {
    "gatewayGeneration": "gateway-generation",
    "grantRevision": 3,
    "projectId": "project-a",
    "serviceGeneration": "core-generation"
  },
  "params": {"threadId": "thread-a", "expectedConfigRevision": 7, "text": "继续实现验收测试"}
}
```

`id` 是本连接响应关联键，1–64 字符；写方法必须有 UUID commandId，由 Client 首次提交前生成并保存。同一用户意图的网络查询/重连不更换 commandId。Gateway 不直接把不可信 commandId 当作共享 Core principal 的原生 requestId。

受理关联键为 Host + 已认证 devicePeerId + Project + commandId。Gateway 在已有 pending/outcomes 持久机制中记录该关联、操作类型、规范语义摘要、日志 operationId、支持时的原生 Core requestId、原始目标及授权 revision。operationId 为预先生成并持久保存的 UUID，create/send 同时将它作为 Core requestId；成功创建 Thread 的返回 ID 也保存，供崩溃后恢复。

对相同关联键：语义参数相同则返回原状态；参数变化返回 COMMAND_CONFLICT。语义摘要不包含 RPC id 或新连接代际，但包含动作、目标、文本/回答与用户审阅条件。查询原收据可跨连接/Core 重启；它仍受当前设备授权约束。新命令必须匹配当前连接/服务代际。相同 commandId 的已受理旧命令只被查询，不因代际改变重新派发。

持久关联必须先于 Core 调用。复用现有提交日志，不新增执行账本；只保存必要请求恢复数据与收据引用，不复制 transcript。遵守现有 Core/journal 容量限制；满额拒绝而不悄悄遗忘去重键。P0 不增加不安全的收据自动清理。

受理状态为 `pending | accepted | rejected | unknown`；accepted 仅表示 Core 已接受请求或明确返回相应操作结果，不等于执行成功。`command.read` 还可返回 `notFound`，但客户端不能据此断言在途工作没有发生。已发送后的超时显示 unknown 并查询；不自动重发副作用。客户端确定尚未调用发送时才可标记 notSent。

对于没有公开原生收据查询的交互/Task 操作，优先返回已保存的明确响应；只能观察到目标状态变化时，另返回 `observedState`，不要伪造该设备命令的成功回执。无法确认则保留 unknown；不按相似正文猜测归属。

## C4. 方法目录与原生映射

所有项目范围方法都必须有 context.projectId。Host 解析项目到已绑定服务，Client 不提供 endpoint、cwd 或 token。下表的 requestId 指由 Gateway 关联的 Core 原生键；interactionId 与 questionId 是另外的领域标识。

| Remote 方法 | 能力 | params 与语义 | 原生能力/扩展 |
|---|---|---|---|
| host.describe | observe | 无敏感 Host 信息与连接能力 | Gateway 元数据 |
| project.list | observe | cursor?, limit?；仅授权已有项目 | 桌面 Project 登记投影 |
| project.models | observe | 空 params；context.projectId | 已在线项目的模型目录投影，不创建会话或订阅 |
| work.list | observe | filter: all/active/attention, cursor?, limit? | 新只读 areal/work/overview |
| attention.list | observe | cursor?, limit?；不带完整工具参数 | overview attention 投影 |
| attention.read | observe | threadId, turnId, interactionId, cursor?；原同步交互 | 有界 interaction/list 与审阅凭据 |
| session.list | observe | cursor?, limit? | thread/list |
| session.open | observe | threadId | areal/thread/observe；返回有界原子基线、归属并订阅 |
| session.history | observe | threadId, cursor?, limit? | thread/read 可取得历史的有界投影分页；不假定已有原生分页方法 |
| session.create | submit | 无路径/模型设置参数；仅普通 Session | areal/thread/start + Host 默认 Profile |
| session.send | submit | threadId, expectedConfigRevision, text | areal/turn/start；仅空闲准入，新增可选 admissionGuard 原子条件 |
| turn.stop | interrupt | threadId, expectedTurnId | turn/interrupt 指定 turnId |
| interaction.respond | answer | threadId, turnId, interactionId，审批还需 argumentsDigest + decision；allowOnce/问题还需完整 reviewToken，问题需 answers | areal/interaction/respond |
| task.question.read | observe | taskId, runId, questionId；原异步问题完整性 | 有界 areal/task/read 与 areal/channel/read |
| task.question.reply | answer | taskId, runId, questionId, answers | areal/channel/reply |
| task.pause | pauseTask | taskId, expectedRunId, expectedRevision | areal/task/pause，增加可选 expectedRunId 原子校验 |
| review.read | review | threadId, turnId, itemId?, cursor?, limit? | 专用 thread/read + 既有历史 Runtime 写入重建 |
| artifact.read | review | artifactRef, offset, length | 只读取已授权所属 Thread/Turn 的 blob |
| device.push.register | observe | platform: apns, token, environment；无 context | Host 加密设备授权中的推送注册 |
| device.push.unregister | observe | 空 params；无 context | 删除本设备推送注册 |
| command.read | 原命令能力；设备推送为 observe | commandId；项目操作带 context，设备推送不带 | 已有关联 + 原生收据；设备推送读 Host 收据 |
| subscription.close | observe | subscriptionId | 仅释放本客户端观察 |

所有写方法必须 commandId。session.create 默认创建空闲普通会话；Host 默认 Profile 绑定 Workflow 时不自动启动该 Workflow，应返回 UNSUPPORTED_PROFILE 并提示本地选择可用普通 Profile。项目未在线/不兼容时不通过远程 create 隐式启动服务。

`session.send` 最多 64 KiB UTF-8，非空文本。已有活动 Turn、Task 所有权或待结算未知提交时拒绝；不调用桌面 send 的自动排队分支。Core 的同 Thread 原子准入决定并发结果，Gateway 的预检查仅用于友好提示。已有暂停/待执行队列显示状态；不通过此接口解除队列暂停或绕过 Core 队列规则。

Task-owned Thread 的普通 send 和 turn.stop 均拒绝，返回 TASK_CONTROL_REQUIRED，避免 Task 的下一轮自动续跑被当作停止失败。Task 暂停走明确的 task.pause。

普通发送新增可选原生 `admissionGuard: {configRevision, ordinarySession: true}`；Core 在同一Thread准入锁内检查配置版本及当前执行所有权，再冻结本轮配置。ordinarySession按现有引擎所有权判断，不按“历史上是否出现过Task”判断；历史已结算Task本身不是新的执行所有者。旧本地调用可省略。新Remote使用该guard，Core声明 `features.turnStartAdmissionGuard`；缺失时禁止新Remote发送，不用Gateway预读冒充原子条件。既有busy、队列、权限、归档与UNKNOWN检查照常执行。

`project.models` 为加法只读方法，由 `ready.methods` 与 `host.describe.methods` 声明。返回 `{projectId,gatewayGeneration,grantRevision,serviceGeneration,models}`，只使用现有在线项目与 provider 目录，复用 `session.open` 的模型裁剪。最多返回 200 项，仅包含 `providerId,modelId,displayName,reasoningEffortOptions,available,unavailableReason`，不含 provider 配置或凭据，响应超过 128 KiB 返回 `LIMIT_EXCEEDED`。离线返回 `CORE_UNAVAILABLE`，不启动 Core、不创建 Thread、不改变订阅。读取与发布时均检查当前项目授权和服务代际；该目录不代表新会话的默认配置，创建后仍须 `session.open` 获取配置 revision。旧 Host 不声明此方法，客户端不能自行推断模型目录。

### 设备推送注册与通知

`device.push.register` 与 `device.push.unregister` 是 Host 范围写入，必须带 UUID `commandId`，不能带项目 context。注册参数为 `{platform:"apns",token,environment:"production"|"development"}`；token 为 64 至 200 位十六进制。注册要求当前 Relay 公告推送能力，否则返回 `RESOURCE_UNAVAILABLE`。注销使用空 `params:{}`。结果为 `{registered:true|false}`。注册不改变 grantRevision，更新授权保留 token，撤销设备删除 token。token 随既有 `remote.json` 加密保存，公开 Host 状态显示 `pushSupported`，设备投影只显示 `pushRegistered`。

Host 将注册结果与设备授权在同一次加密保存中提交，并以设备身份、commandId 和语义摘要保存推送收据。同键同语义返回原结果，异语义返回 `COMMAND_CONFLICT`。无 context 的 `command.read {params:{commandId}}` 仅查询当前认证设备的推送收据，并重新检查当前 observe 授权。已知结果返回 `{commandId,method,admissionState:"accepted",submissionUnknown:false,receipt:{registered}}`，未找到返回 `{commandId,admissionState:"notFound",submissionUnknown:true}`。丢失响应或本地清理失败只核对原命令，不重发；notFound 不证明未执行。Host 最多保留 4096 条收据，容量满拒绝新的设备推送写入，包括注销，不驱逐待核对记录。项目操作继续使用带 context 的既有 Core journal。

通知发送器复用 RemoteControl 与原生会话观察。只为已注册推送设备获授权的在线项目工作，每 5 秒扫描 attention，每项目每轮最多 8 次有界读取，每次最多读取 4 页原生概览。第一次完整扫描只建立基线，原生 attentionRef 去重上限 4096。仅审批、同步问题、Task 异步问题触发通知；不完整基线、容量耗尽或不可用读取可能遗漏通知。第一条立即投递，同项目 30 秒内继续使用相同 collapse ID 并更新计数。发送时重新核对项目、能力、token 和连接状态，设备有活动 Direct 或 Relay 连接时不推送。

轮次通知只跟踪本设备既有 session.send journal 中精确的 threadId/turnId 或 queueItemId。最多 16 个推送观察占用既有原生订阅预算，UI 观察关闭后仍可等待原轮次终态，重开 UI 重新取得基线。队列只按同一 queueItemId 绑定的 turnId 跟踪，不推断最新轮次。已经终态的启动基线不补发，旧轮次不在有界基线、队列项已移除、观察容量满或服务代际改变时可能遗漏。撤销、离线或关闭会释放观察。Relay 不可用、限流或发送预算不足时丢弃本次通知，不排队重试。真实 APNs 与锁屏投递尚需设备验收，Relay 边界见 C12。

## C5. 概览的最小 Core 扩展

新增只读 `areal/work/overview {filter?,cursor?,limit?}`，observe 权限，遵循原 principal/threadIds 限制。每实例返回 `{data,nextCursor,complete}`，数据从现有 Thread/Turn、Task/Run、同步 Interaction、Task Channel 和队列状态投影。没有新持久 Task/WorkItem 状态机。

WorkItem 至少包括 `kind: thread|taskRun`、原生 threadId 或 taskId/runId、标题、有据可查的更新时间、`executionState`、`attentionReasons`、`resultAvailable` 和可用操作。运行状态与注意原因独立；TaskRun 协调 Thread 不重复计数。返回当前授权对象的摘要，不依赖 GUI 曾打开过该 Thread。标题、preview 和错误信息脱敏/有界；不返回路径和完整参数。

默认每页 30、最多 100；序列化目标上限 128 KiB，下一页游标由服务端产生。超大单条投影返回有界摘要和详情引用，不以“完整数据”名义静默截断。分页期间允许状态变化，complete 只代表本次分页扫描完成，不代表跨项目一致事务。不能把部分加载计数当成全量精确计数。

无全局订阅时，前台概览每 5 秒刷新，操作完成立即刷新；页面隐藏时停止主动轮询。已有本地事件可触发提前刷新，但不要求订阅全部 Thread 历史。Inbox 异步问题仍遵循 Core 授权，不能合成不存在的全局 Inbox 推送接口。

## C6. 快照与增量

session.open 在 Core areal/thread/observe 的原子基线后建立 Remote 有界投影。Gateway 对同一投影的基线截取与增量排队串行，先发送快照再发其后的事件；不能先读快照、后监听而丢失中间事件。

观察消息含 `connectionId, gatewayGeneration, serviceGeneration, subscriptionId, sequence`。每个订阅在该连接中单调 sequence；事件窗口仅内存使用，不接受“永久 cursor 续传”承诺。旧连接、旧服务代际的异步结果没有写入新投影的资格。

发现 sequence 缺口、落后、重启或协议不一致时停止应用增量并重新打开，**替换**基线，不再次 append 快照正文。支持文本增量、Item 完成/替换、Turn 状态及交互失效；最终状态只从 Core 确认。大正文用有界预览和 history 分页，不让单个 Item 突破消息预算。

Client 每次只激活一个详情 Session；Gateway 可共享现有 Core 订阅并引用计数，释放 Client 观察不移除桌面工具 Host。不要通过大量 remote 客户端耗尽 Core 每连接 128 订阅上限；必要时使用专门的只读观察连接，但不得注册第二套工具宿主。

## C7. 停止、审批和 Task 的并发条件

**停止 Turn：** client 必须携带用户看到的 expectedTurnId。Gateway 原样传给 Core；不查到新 Turn 后改写目标。原 Turn 已结束/改变返回 TARGET_CHANGED 或明确的已结束状态；停止请求返回不等于停止完成，界面等该 Turn terminal。另一设备终止了目标只表示状态已改变，不伪造本次请求的确认。

**同步交互：** 审批展示完整工具名、有效参数的有界内容、截断说明和 argumentsDigest。参数超过可展示预算时允许分页；未能取得完整可审阅内容时手机拒绝“允许”并提示桌面处理，仍可拒绝。发送原 threadId/turnId/interactionId/digest；Host 与 Core 都校验当前绑定。只有 allowOnce/deny；不注入 allowSession/allowProject。问题答案恰好覆盖实际题目与选项，每项最多 4096 UTF-8 字节，最多 8 题。迟到/已回答/跨轮次返回冲突并刷新，不改写为最新请求。

**异步问题：** Task/Run/Question 必须对应当前 pending、未过期问题；答案走 channel/reply，不注入普通聊天。回答可能不暂停或立即打断 Agent，按真实 TaskRun 状态展示。

**暂停 Task：** 操作前确认“暂停当前任务及后续调度”。Core 在 Task 锁内同时校验 expectedRevision 和可选 expectedRunId；本功能新增后者以阻止 Gateway 检查与 Core 写入之间换 Run 的竞态，旧本地调用可省略。Task pause 持久受理后等待 Run 与 worker 结算；不把协调 Turn completed 当 Task 完成。P0 不开放 task.cancel/resume 或调度修改。

## C8. Review 与制品

Review 绑定明确 threadId/turnId，不把“查看最新”作为含糊变更目标。保留 Core 的 notice、变更范围和来源说明；除非 Core 保证，不宣称所有 Diff 都由该 Turn 单独造成。文件以路径键匹配 patch，不按两个数组的相同下标猜测对应。

artifactRef 必须是 Host 从已验证 Thread/Turn/Item 或 Review 记录产生的引用。读取时重新校验所属项目/Thread/Turn，拒绝客户端 URI、绝对路径、外部 URL 或跨项目 blob 猜测。制品消失返回 RESOURCE_UNAVAILABLE，不替换成其他文件。

图片仅允许签名校验的 PNG/JPEG/GIF/WebP，单件最多 16 MiB，通过有界分段传输；不内联执行 SVG/HTML。文本/Markdown禁用原始 HTML和第三方资源自动加载；外链只在明确用户动作下打开。大图显示尺寸保护，超出解码预算提示桌面查看。审查不执行代码、不改文件、不确认 Agent 工具授权。

## C9. 资源预算与错误

下列是 P0 默认上限；生产可收紧，增大须通过背压测试。

| 项 | 上限/行为 |
|---|---|
| 配对 | 120 秒；Host 最多一个活跃邀请，最多 8 个待处理握手 |
| Noise/hello 等待 | 15 秒；本地审批等待不超过邀请截止 |
| 活跃设备连接 | Host 最多 16；单设备最多 2（页面切换可重连） |
| 应用 JSON 消息 | 256 KiB；超大历史或制品必须分页/分段 |
| 原始传输帧 | 最多 512 KiB；base64 转发需计入膨胀，客户端正确拆帧 |
| 发送积压 | 每连接 2 MiB；超限发 RESYNC_REQUIRED 或断连，不阻塞 Core |
| 收取积压 | 每连接 2 MiB；超限关闭 |
| 制品块 | 原始字节最多 48 KiB，JSON 中 base64；按请求拉取 |
| 概览 | 默认 30/页，最多 100；目标 128 KiB/页 |
| 详情 | 一个前台 Session；每页最多 100 个有界 Item |
| 请求速率 | 每个已认证连接的全部业务请求合计每秒最多 20 次（固定窗口）；其中写请求每秒补充 5 次额度，初始/最多 burst 10 |
| 心跳 | 间隔 15 秒，连续 45 秒不可达标记连接不可用；不宣称任务停止 |

`ready` 与 `host.describe` 的 `limits` 保留 `readRequestsPerSecond:20` 字段以兼容现有客户端；此值实际约束读写合计。新增 `writeRequestsPerSecond:5` 与 `writeBurst:10` 如实声明连接级写令牌桶。`session.create`、`session.send`、`turn.stop`、`interaction.respond`、`task.question.reply` 与 `task.pause` 共用写额度，`command.read` 只计入合计请求窗口。额度由 Host 时间连续补充，不能超过 10；Direct/Relay 共用此检查路径，各连接独立，重连建立新桶。当前设备授权检查先于速率检查；写额度不足在 journal、观察准入与 Core 派发前返回脱敏 `LIMIT_EXCEEDED`，不保存 pending、不自动重放，也不因该拒绝关闭健康连接。

限制保护 HTTP/WebSocket/Noise 和投影各层，不只保护最后的业务处理。安全通道长度前缀解码器在JSON解析前就必须应用256 KiB上限，不能保留旧24 MiB解码上限后才做业务校验；外层帧与base64大小也在解码前受限。慢消费者不能拖慢桌面或其他设备。Limits 回传真实有效值，UI 禁止按更大限制提交。

错误为 `{id,error:{code,message,coreCode?,commandId?,submissionUnknown,observedState?}}`。message 脱敏，Client 按 code 行为，不解析文字。核心 code：PROTOCOL_UNSUPPORTED、FORBIDDEN、GRANT_CHANGED、AUTH_REVOKED、PAIRING_EXPIRED、PAIRING_USED、CORE_UNAVAILABLE、CORE_INCOMPATIBLE、TURN_BUSY、TASK_CONTROL_REQUIRED、TARGET_CHANGED、INTERACTION_EXPIRED、COMMAND_CONFLICT、SUBMISSION_UNKNOWN、INVALID_PARAMS、LIMIT_EXCEEDED、CAPACITY_EXCEEDED、RESOURCE_UNAVAILABLE、UNSUPPORTED_PROFILE、RESYNC_REQUIRED。

## C10. 网络/进程恢复

transport 断开：所有未确认写标记 unknown，保留 commandId；采用 500 ms 至 30 秒带 jitter 退避。恢复安全通道、重新验证设备/能力，重新取 overview 和当前 Session，再只读查命令收据。禁止调用原先默认 reconcile 中会修复配置的路径；Remote 使用 observeOnly，不执行配置屏障。

Core 重启：本机适配器验证运行中服务的新 generation；旧事件作废，UNKNOWN 工具保持原样，不能替用户 acknowledge。新服务未启动或不兼容就展示状态，不远程 ensure/restart。GUI 关闭不停止独立适配器；Relay 重启/网络切换也不取消已受理任务。操作系统睡眠不由本协议解决。

## C11. 本地配置与迁移

### 已实现的 Direct 网络配置

唯一配置所有者是可信桌面后台 `RemoteControl`，沿用系统安全存储加密的 `remote.json`。Direct 使用实际存活的 `127.0.0.1` server 推导目标，不接收 renderer 指定的 listener、target 或 executable，也不转发 Core/桌面管理接口。网络操作复用现有本地 `remoteControl` 命令，不属于手机 Remote API。

| operation | 精确参数 | 结果与约束 |
|---|---|---|
| `networkInspect` | 无 | 返回状态投影；只读检查 CLI 与映射，不执行配置变更 |
| `networkPropose` | 可选 `httpsPort`，默认 443 | 返回 `proposalId/publicOrigin/confirmation`，不返回 CLI 配置或目标 |
| `networkApply` | `proposalId`, `confirmed: true` | ID 必须属于当前 listener 与配置版本；消费后不可重放 |
| `networkProposeScope` | `scope: private\|public` | 从本应用 owned 映射生成新 `proposalId/publicOrigin/sourceScope/scope/confirmation`；不改变配置 |
| `networkChangeScope` | `proposalId`, `confirmed: true`；公网还需独立 `publicConfirmed: true` | 绑定当前配置、存活 listener 和原/目标范围；每次新方案使用独立 ID，确认消费后不可重用 |
| `networkConfigureOrganization` | `publicOrigin`, `visibility: private\|public`, `confirmed: true`，公开范围还需 `publicConfirmed: true` | 只保存应用接受的 HTTPS 来源与二维码，不配置组织代理/证书/ACL |
| `networkRecover` | `confirmed: true` | 核对已记录的 pending/owned 映射；范围中断按原/目标/缺失状态保存核对结果，不重复 CLI |
| `networkRemove` | `confirmed: true` | 仅移除精确所有权匹配的映射；组织模式仅清除应用来源 |

未知参数拒绝。HTTPS origin 必须规范且不带路径、凭据、查询或 fragment。Serve 的私人范围不因失败自动切到 Funnel。`status.network` 仅投影 `kind/scope/reconciliation/publicOrigin/diagnostic/policy/phoneAccess/inspection`；`inspection` 仅含可用性、版本、持久 Serve 能力、登录、HTTPS、策略状态与 `funnelPorts`（未知为 null，无授权为 []）。原始 CLI config、账号/设备元数据、目标和持久日志不发给 renderer。策略及手机可达性始终为 unknown。

后台保存 `directPort` 和 `network`。Serve 的 `network` 为 `{kind:'tailscale',mapping}`，mapping 保留 schema、owner、id、state、operation、publicOrigin、target、httpsPort 和 scope；范围操作还保存 sourceScope，旧 schema1 无 scope 记录视为 private；组织模式为 `{kind:'organization',publicOrigin,visibility}`。首次映射前固定实际 Remote 端口。CLI 使用有界的 `execFile`、参数数组和 `shell:false`；pending 日志必须先持久保存，再变更并核对精确映射，最终保存成功后才发布 HTTPS 来源。最终保存失败保留 pending，恢复按实际所有权核对，不重放；不存在或被更改的映射不广告为可用。

Funnel 只切换本应用精确持有的映射，不创建另一个配置所有者。发布前确认稳定 CLI 版本、登录、证书域和本机 `Self.CapMap` 的 HTTPS/Funnel 与唯一端口授权；只支持 443、8443、10000。缺失、格式未知或多条歧义端口能力拒绝，不调用 Funnel 探测能力。使用 `funnel --bg --https=P --set-path=/ TARGET` 切换公网；恢复私人使用同范围 `serve`，不要求仍有 Funnel 授权。正常 Serve 前置条件仍适用。移除仅处理精确匹配的端口/Host，并核对其他 TCP/Web/AllowFunnel/Foreground 配置未改动。

范围操作 pending 先持久化，再撤下 HTTPS 广告、取消旧邀请并关闭已有连接，即使 HTTPS 来源未变。现有设备授权、Host pin 与逐操作校验保持不变。重启对 pending scope 只读记录 `reconciliation: destination|source|absent|changed`，保留 pending 且不广告 HTTPS；本地 `networkRecover` 才保存实际目标/原范围或缺失记录，漂移保持待核对。无自动重放、公开回退或权限推断。私人恢复及精确撤销在 Funnel 授权消失后仍可用；中断后的撤销先只读确定实际范围，不能误删外部映射。公网手机、证书、策略和关闭可达性未认证，本地夹具不是公开部署验收。

HTTP 仅接受当前 loopback 或已配置 HTTPS 来源的精确 Host；WebSocket 必须同时匹配该 Host 对应的精确 Origin。两组来源不能混用，不信任转发身份头。CSP 只允许当前来源及其精确 WS/WSS 来源。更改来源会取消邀请并断开旧连接；`pair` 使用已核对的活动 HTTPS 来源，否则返回明确的本机开发链接。

`disableDirect` 先持久关闭，再取消邀请并关闭监听器，随后等待仅撤销本应用的精确映射。关闭状态保存失败则拒绝操作并保留旧状态；后续清理失败保留 pending/诊断，监听器不重开。进程 `close()` 同步关闭入口、保留映射，不启动异步 CLI 清理；现有服务停止流程拒绝仍有在途本地操作时退出。重启先绑定固定端口并复核 owned/pending 记录，之后才广告 HTTPS；端口碰撞时停用入口并尝试撤销精确映射，撤销失败保持诊断。保留映射不等于退出时已清理，实际网络与手机证据仍独立验收。

### 已实现的加密配置与旧身份迁移

可信桌面后台 `RemoteControl` 是唯一配置所有者，通过 Electron `safeStorage` 加密整个配置对象，再由既有 Backend 以临时文件替换方式保存为 `remote.json` 的 `{encrypted}` 信封。它不是 Core 配置，也不是可供手机修改的 JSON 接口。安全存储不可用或后端为 `basic_text` 时拒绝启用。

| 实际字段 | 含义与边界 |
|---|---|
| `identity`, `deviceGrants` | Host 身份和设备授权；授权字段见 C2，不向浏览器发送 Host 私钥 |
| `enabled`, `relay`, `relayProtocol`, `room`, `capability` | Relay 开关、HTTPS origin、协议和登记；`enabled` 仅控制 Relay，长期 capability 留在加密配置中 |
| `directEnabled`, `directPort`, `network` | 独立 Direct 开关、固定 loopback 端口与上文网络记录；来源及 private/public 范围保存在 network 内 |
| `schemaVersion`, 旧 `devices` | 旧设备迁移写入 schemaVersion 2；原配置内容保留，授权判断使用 deviceGrants |

两种传输共用身份和授权，分别显式启用；网络来源、范围确认和恢复仍遵循上文接口。

迁移保留 Host identity 与旧设备身份、显示名、项目范围，为尚无对应授权的旧设备创建 `capabilities: []`、`revision: 1`、`status: reviewRequired` 的 deviceGrants，并关闭 Direct 与 Relay。设备须经本地显式复核项目和 v2 预设，保存成功后才获得权限。迁移保存失败时原文件不被替换，本次入口保持关闭并显示诊断；修复安全存储后再处理，不能用删除身份或放宽授权恢复连接。

旧 Relay 登记不会自动转换成 v2 登记，需管理员 code 重新确认。hello 的 `apiVersion` 不为 `areal.remote.v2` 时返回 `PROTOCOL_UNSUPPORTED` 并关闭连接；升级客户端后重新连接，不降级到旧写协议。

## C12. Relay 的最低服务契约

可信本地 `remoteControl` 的 `enable` 接受 `{relay, code?, confirmed: true}`：`relay` 必须为精确 HTTPS origin；首次登记和更换 origin 必须提供管理员 code，同一已登记 origin 可以不提供 code 重新启用。Host 使用系统 TLS 校验、无 Origin 的 `POST /enroll`，拒绝重定向，取得 capability/room 后先持久化到既有加密 `remote.json`，再出站连接 WSS。`disable` 关闭 Relay，保留加密登记供显式重新启用；旧版 Relay 配置不自动升级登记。可信状态只投影公开 origin/room/pin、连接状态与脱敏错误，不返回 capability。

`pair` 可选 `transport: "direct" | "relay"`（默认 Direct）；Relay 需要已连接。链接只包含公开 origin、Host pin、room 和 120 秒邀请。生产 PWA 先通过统一 wire 工厂完成 Relay client 注册与 ready-channel，再进入相同 Noise、hello、授权和业务路径。Host 只拥有一个 session acceptor、观察器和设备/握手预算；撤销与缩小范围同时关闭两种传输。共享上限为 16 个连接、8 个未完成握手、每设备 2 个连接，以及各 8 MiB 的 Host 收发积压；Relay 每通道发送积压 1 MiB、每块原始字节最多 49152，含 base64 的外层 JSON 不超过 512 KiB。通道公平排出，慢设备只关闭自身通道。

Host 的 Relay `ready` 必须携带精确 `limits: {framesPerSecond, bytesPerSecond, maxFrameBytes, heartbeatIntervalMs}`，并可加 `push:boolean` 表示 APNs 能力。缺少 `push` 的旧服务按不支持处理；Client 的 ready-channel 格式不变。旧服务缺少 limits、限额声明无效或额度不足以保留心跳并承载数据时，Host 停止自动重试并报告限额/协议不可用，不猜测默认上限；管理员调整服务后在桌面显式重新启用。服务仍接受原有低额度配置，不为 Host 自动放宽运营策略。

Host 在登记后跨过一秒窗口，再由同一有界队列按实际 JSON/base64 字节平滑排出 data 与 close；每块不超过服务字节额度的四分之一、总发送速率至多其四分之三，帧速率额外保留自动 pong 和窗口边界余量。通道轮转与 close 交替，缓冲计数包含关闭中的已接受字节和待发送 close。正常 close 只排出已接受的有界字节并在 15 秒内结束；接收端先按序交付已接收的有界字节，再报告读取结束，确保与 close 同批到达的拒绝响应仍可读取；撤销、授权缩小、网络来源/连接代际变化、积压超限和非法入站数据立即 terminate 丢弃，不能在失效后发送队列。

Relay 或 Host 重连关闭旧通道，重新建立应用 connection 与读取基线，不重放业务命令。同一登记被新 Host 连接替换时，旧连接停止自动重试，必须在可信桌面显式重新启用。Relay 只承载字节与存活/背压，Direct 继续拥有 HTTP、静态资源、精确 Host/Origin 和 heartbeat。


单实例 Relay 配置公开 origin、允许 Web origins、数据卷与本地管理入口。管理命令在服务器本地生成 256 位一次性 Host enrollment code，10 分钟过期，服务端只存 hash；不存在公开无认证的管理 HTTP 页面。Host 用 HTTPS 登记一次，获得/登记自己的 capability；长期凭据保留 Host 安全存储，不进入 QR。

Relay 的 `allowedClientOrigins` 继续只接受 Web origin。可选 `allowedAppOrigins` 默认为 `[]`；原生 App 部署可显式设为 `["capacitor://localhost"]`。每项必须是精确的 `scheme://host`，scheme 不能是 `http`、`https`、`ws`、`wss`；拒绝空 host、凭据、端口、路径（含结尾斜杠）、查询、fragment、空白与百分号编码。WebSocket upgrade 和 client 注册都要求 Origin 精确命中两份列表之一；无 Origin 只允许证明登记凭据的 Host，不能注册为 Client。自定义 scheme 的 `URL.origin` 可以是 `null`，因此按已验证的完整字符串比较。原生 App 可以伪造 Origin，Origin 不提供身份或执行授权；Host 身份仍由 Noise pin 验证，权限仍由 Host DeviceGrant 决定。

保留既有 room = SHA-256(capability) 方案。Relay 数据库存允许 room、登记状态与限额；Host 出站连接以 capability 证明可占有该 room，新连接必须替换同一合法 Host 的旧连接而非允许其他 room 劫持。Client 仅提供不可枚举的 room，Relay 不把它当执行授权。Noise pin 和 Host DeviceGrant 决定最终权限。

Relay 外层处理 host/client 注册、ready/open/data/close/error，以及可选的 Host push/pushResult。Host 的 data 必须属于该 Host 的 room/channel；Client 只能收发自身 channel。Host 离线返回明确不可用，不排队保存业务命令。并发/字节/握手限流同样作用于尚未完成 Noise 的连接；错误不泄露其他 room 是否存在。

SQLite 只保存登记元数据和消费过的 enrollment hash；连接映射在内存，正常重启由端点重连恢复。备份恢复流程则默认禁用所有恢复的Host登记，要求管理员重新登记/复核，不把过旧撤销记录当最新授权。TLS 反向代理、Relay 和静态 PWA均提供源码和可重建发布物；P0 不需要 Redis、集群、SSO 或计费服务。日志只留时间、随机 route ID、字节计数、错误类型，不记录 payload、token、邀请、项目名或 prompt。

### Relay APNs 转发

支持推送的 Host 在 WebSocket upgrade 中发送 `X-Areal-Relay-Capabilities: push`。只有这些 Host 收到可选 ready `push` 字段与 `pushResult`，旧 Host 保持原消息结构。旧 Relay 忽略请求头并省略 `push`，表示不可用。请求头仅声明解码能力，不替代已登记的 Host capability。

可选 `apns` 配置包含 `teamId`、`keyId`、`keyFile`、`bundleId` 和 `maxPerHostPerMinute`。team/key ID 为 10 位大写字母或数字，Bundle ID 为最多 255 字符的点分标识。服务启动从配置路径读取 P-256 `.p8` 密钥；管理命令不读取密钥。省略 `apns` 时，已声明推送能力的 Host ready 返回 `push:false`，不发起 APNs 连接。配置示例和密钥只读挂载见 [Relay README](../../services/remote-relay/README.md)。

已证明登记凭据并拥有当前 room 的 Host 可以发送 `{"type":"push","token":"…","environment":"production","collapseId":"…","kind":"attention","count":1,"target":{"projectId":"…","threadId":"…","attentionRef":"…"}}`。token 为 64 至 200 位十六进制，environment 只接受 `production` 或 `development`，collapseId 非空且最多 64 UTF-8 字节，count 为正安全整数。kind 只接受 `attention`、`turnCompleted`、`turnFailed`。可选 target 只含可选 projectId、threadId、attentionRef，各为非空且最多 256 UTF-8 字节的不透明字符串。未知字段、非法参数和 Client push 按 `INVALID_FRAME` 关闭连接。既有帧大小、字节与速率预算先于 push 路由执行。

Relay 生成标题 `AReaL`，attention 正文为“电脑上有 N 项需要你确认”，完成为“你在手机上发起的会话已完成”，失败为“你在手机上发起的会话没有完成”。Host 不能提供通知文案。APNs JSON 只含固定 `aps.alert`、默认提示音和可选顶层 target，不含项目名、会话标题、提示词或工具参数。配置的 bundleId 成为 `apns-topic`，请求使用 `apns-push-type:alert`、优先级 10 和 collapse ID。生产端点为 `https://api.push.apple.com`，开发端点为 `https://api.sandbox.push.apple.com`；TestFlight 使用生产端点。ES256 JWT 缓存 50 分钟。

每个已登记 room 每分钟默认最多 60 条推送，可配置 1 至 600，Host 重连不重置当前分钟计数。最多同时 32 个请求，每个请求有 10 秒绝对截止。Relay 不排队或重试。超额返回已有 `error LIMIT_EXCEEDED`，未配置返回 `error UNAVAILABLE`，均保留健康 Host 连接。APNs `410 Unregistered` 回给当前 Host `{"type":"pushResult","token":"…","status":"unregistered"}`；其余投递状态仅记脱敏日志。日志只含时间、随机 route ID、kind 与状态码，不含 token、target、原始请求或 APNs 错误正文。关闭服务会关闭所有 APNs 会话。

`services/remote-relay` 的 `npm test` 使用临时生成密钥、本机 TLS HTTP/2、真实 WebSocket 和 CLI 登记验证转发边界。真实 APNs 投递与 iOS 锁屏行为需另外验收。

## C13. Web 信任与存储

生产 UI 只能由用户明确选择的 Host/组织 HTTPS origin 提供。设置严格 CSP、frame-ancestors、Referrer-Policy、权限策略，禁用第三方运行脚本；WS 验证明确 Origin，Origin 不是替代 Noise 的身份机制。Host 角色无 Origin 但必须证明登记凭据；首发浏览器 Client 必须符合允许 origin。

浏览器“记住此设备”明确 opt-in，将设备身份保存在该 origin 的 IndexedDB，不放 localStorage/URL；仅本次使用则存内存。浏览器存储不是系统钥匙串，恶意同源代码仍可能获取身份和正文。共享设备提醒用户不要记住；清除站点数据意味着需重新配对，不得自动导入旧私钥。

Service Worker 仅缓存版本化静态 shell，不缓存邀请、正文、审批、API 或制品。草稿默认仅当前浏览器会话保存；重连不自动发送。P0 不依赖推送或后台常驻。协议不兼容时要求刷新静态客户端而不是放宽校验；更新不得在一次用户提交中途替换运行上下文。

## C14. 最小视图 DTO 与能力声明

这些是Remote专属展示DTO，不直接复用包含敏感配置的完整Core/Backend对象。结构可以增加只读可选字段，但不得减少授权/目标绑定条件。

| 视图 | 必需字段与含义 |
|---|---|
| ProjectView | projectId、name、connectionState（online/offline/incompatible/recovering）、serviceGeneration；不包含root/auth信息 |
| WorkItemView | kind、原生threadId或taskId/runId、title、sourceUpdatedAt（未知为null）、execution（保留原Turn/Run状态）、attentionRefs、resultAvailable、availableActions |
| AttentionSummary | attentionRef、kind（approval/syncQuestion/asyncQuestion/submissionUnknown/executionUnknown）、原目标标识、summary、status；无完整工具参数 |
| AttentionDetail | 上述身份，问题questions/有效参数effectiveArguments、argumentsDigest（审批）、expiresAt、nextCursor、complete；分页前后目标/digest必须相同 |
| SessionSnapshot | threadId、title、configRevision、ownership（ordinary或task及taskId/runId）、activeTurnId、受限turns/items、attentionRefs、queue的pendingCount/paused、history的nextCursor/hasMore/truncated |
| ReviewPage | projectId/threadId/turnId/itemId/connectionId/gatewayGeneration/serviceGeneration；review 的 UTF-8 JSON 分块与 nextCursor，首页 artifacts；正文含原 turnStatus/error/partial、独立 taskRunStatus、notice、scope/provenance 和路径键 files |
| CommandView | commandId、method、目标身份、admissionState、native结果的受限字段/引用、observedState；只返回当前设备有权查询的关联 |

输出Item最少保留id/type/phase和已授权正文片段；不传回不透明模型内部数据。Item大于页面预算时携带preview与正文分页引用。session.history只分页Core实际可取到的历史范围；上游受限时明确truncated/unavailable，不声称已返回全部旧历史，不为此悄悄重建另一套历史库。

`availableActions` 必须同时满足当前DeviceGrant、Core已实现能力和对象状态。新增overview能力由实际methods目录声明；新增Task原子Run guard由 `features.taskPauseRunGuard` 声明；普通发送原子条件由 `features.turnStartAdmissionGuard` 声明。缺失所需能力时显示明确不可用/升级原因，不能退化成不受约束的调用。未实现全量未打开会话概览的构建不能声称完整P0。

过滤禁止自动泄露的配置元数据，与用户已经授权阅读的任务正文是两回事：用户消息、模型输出或有效工具参数可能主动包含路径、代码或秘密。不得声称系统能自动消除所有此类内容；配对必须提示设备可看到项目内授权会话内容。无论正文如何，日志与静态构建都不应收集它。

### Task 暂停

源码提供 `task.read`（observe）与 `task.pause`（pauseTask）。读取 `{taskId,runId?}` 复用有界 Task 观察，返回当前 `revision/currentRunId`、原 Run 状态、`workersSettled/settled` 和 `available`；首次 Run 之前不可暂停。页面审阅原 Task/Run 后，明确勾选暂停当前工作和未来调度。历史 Run 不会自动改指当前 Run。已知受理的暂停在桌面本地恢复同一 Run 后，必须重新读取可暂停状态并明确确认，才会生成新的 commandId；pending/UNKNOWN 仍阻止新提交。

暂停参数严格为 `{taskId,expectedRunId,expectedRevision}`，要求 Core 发布 `taskPauseRunGuard` 和 `areal/task/pause`；原生 requestId 使用既有 journal 的 operation UUID。已有关联先于新准入条件，同 commandId 改目标或版本返回 COMMAND_CONFLICT。Core 原子校验最后一个 Run 与版本，本地省略可选 expectedRunId 的调用保持兼容。

已知原生响应保存有界 `receipt:{taskId,runId,revision,paused:true}` 后才移除 pending。无公共 Task 回执查询，丢响应仍为 UNKNOWN；`command.read` 不重放，可返回独立 `observedState`（source 为 task.read，provesCommandAdmission 为 false）。当前 observe 与原 pauseTask 授权始终必须有效。受理只是暂停意图：观察 Task paused、原 Run paused 或 completed/failed/cancelled、全部 worker settled 后才显示结算；paused 不属于终态。serverRestarted 的暂停仅观察，不恢复、不重放。Remote 不提供 resume/cancel/排程修改。观察不可用或暂停/结算字段缺失时显示未知，不推断为未暂停或已结算。源码与 DOM 检查不等同于原生 T30/T31 验收。

## 当前 GUI 复用入口

项目下的 Session 列表来自 `project.list` / `work.list`，不使用示例数据或 GUI 已打开列表。会话详情复用 GUI 消息与 Composer；附件入口不提供。模型与权限、目标创建/暂停/恢复/清除、运行中 Follow up 队列与引导均使用真实 Core；完整目标编辑与模型目录/凭据设置仍在桌面完成。

`session.send` 可附带 `enqueue: true, expectedTurnId`，映射 `areal/turn/enqueue`，要求 `turnEnqueueAdmissionGuard`；Core 在锁内确认普通归属与配置版本。`session.control {threadId, operation, expectedRevision, values}` 使用 submit 能力和既有 commandId journal，仅支持 configure、goalCreate/goalPause/goalResume/goalClear、queueUpdate/queueRemove/queueReorder/queuePause/queueResume/queueSteer、steer。字段严格限定；不接受路径、原生方法名、连接信息或凭据。Task 归属拒绝这些普通会话控制。

快照包含脱敏模型目录、配置、目标与队列显示投影；队列至多 128 项，每项文本 1024 UTF-8 字节，含附件或截断项不可在 Remote 编辑。模型目录至多 200 项。发送和控制共享 Session 未确认门；结果未知只查原 commandId，不重发。配置/目标/队列及 enqueue 使用原生持久收据核对。直接 `turn/steer` 无可查询原生请求键，回应丢失时保持 UNKNOWN，不将消息回显当作受理证明。
