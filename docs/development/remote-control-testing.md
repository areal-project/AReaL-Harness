**中文** | [English](remote-control-testing.en.md)

# Remote Control 测试与发布门槛

这是待执行的测试计划，不是本次已通过的测试报告。

独立 Desktop Service 的新增验收见[环境服务实施计划](environment-service-plan.md)中的 ENV-01 至 ENV-15。复用本页传输与业务验证，另行验证独立 owner、真实 LaunchAgent、转换恢复和签名安装包；现有退出用例不能自动覆盖这些新增边界。

## Relay Host/PWA 源码与严格 TLS 夹具

运行 `pnpm --dir clients/gui test:remote-relay`（需 Node 24.2.0、OpenSSL 与已安装的 Relay 锁定依赖）。真实 Relay CLI/SQLite、生产 Host、wire 工厂和 Noise 经过隔离 CA 的 HTTPS/WSS，证书验证与 hostname 检查保持启用；覆盖未信任 CA、错误 SAN、过期证书拒绝、加密登记持久化、pin/room/channel、双传输共享预算、撤销、观察器、重启/替换和真实 TCP 慢读隔离。静态资源测试用实际 Remote export 并检查 CSP/内容 hash。

连续大页 history 回归必须逐次等待响应，同时检查第二设备进度，并分别使用默认和降低的服务帧/字节限额；记录外层 JSON 的滚动秒字节/帧峰值，包含 close 和实际自动 pong 余量。并行积压测试不能替代此速率用例。另保留正常关闭的类型化拒绝、队列中撤销即时丢弃、旧代际定时器清理、缺失/错误限额声明与不可用低额度的 fail-closed 用例。浏览器状态测试覆盖 root/manifest 恢复实际 wire room、同 Host 新 room 在 ready 后更新、拒绝/事务中止保持旧绑定、旧 Direct 记录、访客不打开数据库及 forget/revision 隔离。

这是源码与本机 Node TLS 层证据；Core 公共协议夹具不等于真实 Native/Core 业务验收，wire 工厂不等于生产浏览器 DOM 已运行。RC-16 必须在既有业务 suite 中选择传输后保留相同断言。严格 TLS 浏览器、真实系统钥匙串、手机、公网 443、签名安装包与组织网络仍是独立未执行门槛。

## RC-16 传输选择与证据边界

六个既有 E2E 入口接受 `AREAL_REMOTE_TRANSPORT=direct|relay`，省略时保持 Direct。其他值在启动进程或监听器前失败。`test:remote-command-e2e` 的 Relay 模式复用相同 Native 业务、故障注入与计数，只替换真实 Relay CLI/SQLite、HTTPS/WSS 入口和生产 `createRemoteWire`；首次登记后，Host 重启复用同一加密配置、身份与授权，不重复登记。Node 设备单次连接传入隔离公开 CA，Host 子进程仅在启动时通过 `NODE_EXTRA_CA_CERTS` 信任该 CA，不修改系统信任或关闭证书/主机名检查。

在同一冻结源码、原生 bundle 与独占验收租约下分别运行，例如：

```sh
AREAL_REMOTE_TRANSPORT=direct AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:remote-command-e2e
AREAL_REMOTE_TRANSPORT=relay AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:remote-command-e2e
```

其余 RC05–RC10 selector 与 100 次默认竞争要求保持不变。manifest 按用例记录 requested/completed 次数、检查层、源码/二进制身份、CA/配置 hash、实际 Host/CLI 与原生后代进程观察、正常停止错误和清理回执。T18/T19/T22/T23/T25/T30 必须在每种传输实际完成至少 100 次；不同源码的历史 Direct 结果不能补作本轮双传输通过。`fullConformance` 始终为 false：单个入口不能证明整个发布矩阵。进程不存在或强制清理不等于 Runtime UNKNOWN 已结算，停止失败使整次运行失败。

隔离生产浏览器 CA 夹具尚未提供。Relay RC10 先执行原有 Native T32/T33/T34 断言，再将生产 PWA/TLS 层标记为 `RELAY_BROWSER_TLS_UNRUN`，`passed`/`acceptance` 为 false，正常清理后退出 2；若业务或清理失败则退出 1。这三个 Native 用例不代表图片解码、布局、正文 hash 或其他浏览器子检查通过。其余五个依赖浏览器的 E2E 入口在 Relay 模式下于资源启动前输出 UNRUN manifest 并退出 2；Direct 浏览器业务断言保持执行。源码检查 `node clients/gui/scripts/remote-native-harness-contract.mjs` 验证 selector、原生计数与该限制边界，不启动原生或浏览器。

## RC-01 可重复验证

从仓库根运行：

```sh
make build
make gui-install
make gui-build
pnpm --dir clients/gui run test:remote-observation
pnpm --dir clients/gui run test:remote-observation-e2e
```

`test:remote-observation` 聚焦真实 WebSocket/Noise 的协议拒绝与资源预算；隔离依赖数据不能代替真实业务验证。`test:remote-observation-e2e` 从生产浏览器页面和加密公共入口连接真实隔离 DesktopService/Core/Runtime，使用确定性本地模型并预置测试设备授权，验证 T01–T04 的本机只读边界。脚本输出隔离目录和 manifest；必须保留失败记录并区分修复后的重跑。

E2E 还注入缺失的 Direct 静态资源，确认旧桌面服务仍可启动、失败的启用不留下监听器，并在成功连接后关闭 Host，确认页面不继续显示旧的在线状态。隔离目录中的 `remote-observation.png` 是桌面 Chrome 演示截图，不是手机真机证据。

这组检查不调用外部模型账号，不改变 VPN 或部署公网入口。系统钥匙串、真实 iOS/Android、HTTPS/WSS 反向代理、Relay、签名安装包和 GUI 退出后的完整生命周期仍需对应后续 ticket 的证据；尤其 T04 的本机路由/Origin 检查不等于公网 TLS 验收。

## RC-02 可重复验证

构建后运行 `pnpm --dir clients/gui run test:remote-pairing-e2e`。它连接真实隔离 DesktopService/Core/Runtime 与确定性本地模型，从生产 Electron 设置页和 Chrome Remote 页面执行申请、指纹核对、项目选择、Observer/Operator 确认、范围缩小和撤销，不预置活动授权。故障注入仅在安全存储、磁盘保存及 Host 时钟边界。

覆盖 T05/T06/T08/T09 的本地行为，以及 T02 的 Host pin 不匹配和 T07 的已有加密连接/项目读取范围失效。T07 的订阅与制品流仍需 RC-04/RC-10/RC-16 随功能实现验证，不能由项目列表检查替代。输出目录包含 manifest 与桌面/浏览器截图；失败运行保留原记录。系统钥匙串、真机手机、TLS、Relay 和签名安装包不在该脚本验收范围。

## RC-03 可重复验证

构建 Core 和 GUI 后运行 `pnpm --dir clients/gui run test:remote-work-overview`。脚本通过生产加密 Direct 入口、真实设备授权确认、隔离真实 Core/Runtime 与确定性模型，验证 work.list/attention.list 及生产浏览器页面。T10–T12 覆盖从未打开的运行/失败会话、同步审批/问题、仍在运行且有异步问题和两个 worker 的 Task、跨项目拒绝、分页游标、部分计数标注、有界超大摘要，以及测试专用 Core 显式崩溃/重启后的在途 Runtime UNKNOWN。工作区副作用标记检查未重放。真实 Chrome 标签可见性通过公共 CDP 验证，避开 Playwright 默认焦点模拟；不模拟 document 可见性属性。

每次运行在打印的隔离目录保留 manifest、源码 revision/diff 身份、二进制 SHA-256、断言与浏览器截图。真实本机 Chrome 可见性不等同手机挂起证据；安全存储仍是夹具边界，真实钥匙串、手机、TLS/Relay 和签名包须单独验收。原始失败与修复后运行必须分别保留。

## RC-04 可重复验证

构建 GUI 后运行 `AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-session-e2e`。生产 Remote 页面和 Electron 连接隔离的真实 DesktopService/Core/Runtime，覆盖 T13–T17 的流式基线、旧事件、缺口恢复、慢设备隔离、历史分页、工具宿主保留及重启 UNKNOWN。`node clients/gui/scripts/remote-native-observation-oracle.mjs` 仅检查取证断言的反例，不能替代原生运行。

Browser 用例先核对确切页面、URL、加载状态和原生内容，修改并读取真实页面输入。脚本只记录原生导航事件和原始 `loadURL` Promise；不更换网络安全监听器。首个 `-3` 加载失败可通过现有可见重试按钮恢复一次，manifest 分别保留首次失败和恢复动作，恢复成功不等于首次导航成功。工具宿主检查暂缓交付真实匹配的 Browser 结果，在该请求仍待回应时关闭手机详情，收到关闭确认后原样交付结果，再核对同一 Turn/call/page 的实际成功内容。这证明原生回应待交付时的保留行为，不证明 Main 此时仍在执行；本地 `describe` 回答不作为原生调用证据。

超大历史拒绝后必须产生新的 Turn，并核对新的实际 Browser 观察及原页面状态。重启用例绑定真正运行中的工具 Turn/Item/runtimeEpoch/scopeId/operationId，恢复后保留同一 UNKNOWN，不重放、不检查确认未知结果。manifest 保存原请求、代际、页面与工具记录；任一失败均保留独立证据。该入口不提供 Relay、手机、系统钥匙串、严格公网 TLS 或签名安装包验收。

## RC-05 可重复验证

`pnpm --dir clients/gui run test:remote-command` 使用真实临时文件和生产 Backend/Gateway，RPC 采用 fixture；检查相同业务键并发、跨设备/项目隔离、持久化故障、授权队列竞态、终态先于 pending 删除、离线读取、桌面恢复/dismiss 并发和只读观察引用保护。发送准入以 Core 原子观察的所有权优先：即使本地投影已有 inProgress，或等待观察时才变为 inProgress，Task-owned 会话仍返回 TASK_CONTROL_REQUIRED；普通活动会话返回 TURN_BUSY。这些拒绝不得新增命令日志、准入或原生派发。`test:remote-session` 通过生产页面按钮验证首次发送前保留 commandId、未知查询、冲突和草稿。这些不是原生执行证据。

在原生环境允许启动后，运行 `AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`。该脚本让独立 Node Host 进程持有真实 DesktopService/CoreBackend/RemoteControl，跨 Noise 发送命令；在真实 Core 受理后结束并重建 Host 进程，核对原收据与 Runtime 文件副作用，覆盖 T18–T22。仅故障边界和系统安全存储为 fixture，不替代原生业务结果。默认 100 次竞态；`RC05_RACE_REPETITIONS` 少于 100 的运行仅是诊断。输出保留 manifest、源码/二进制身份、迭代数及隔离服务 cleanup。未执行时保持 native-blocked，不能由脚本存在或 fixture 通过宣布验收完成。

T21 的受影响准入检查可单独运行：`RC05_PREFLIGHT_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`。此模式跳过 T18/T19/T20/T22 竞态，manifest 的 selectedSuite 为 RC05_T21，成功后 coveredCases 仅包含 T21，requestedRepetitions/completedRaceIterations 均为 0，raceAcceptanceRequired 与 acceptanceRepetitionsMet 均为 false。保留此前成功的 100 次竞态证据，并把修复后的 T21 记录为组合证据，不能覆盖原失败制品。可信夹具 Profile 控制同时更新项目实际选择，T21 断言并记录真实 native create 参数中的 flow/v1。

`node clients/gui/scripts/remote-native-harness-contract.mjs` 不启动原生进程，直接执行 harness 的模型与 worker 回调，并通过生产 Gateway 验证 Profile 派发。回归区分同一 Thread 的 A/B 用户轮次、历史工具结果与当前工具结果，防止历史标记抑制或替换新的审批。

## RC-06 可重复验证

沿用 `test:remote-command` 与 `test:remote-session`：真实文件日志/Noise 与 fixture RPC 检查严格目标、不可变语义、interrupt 能力、双设备、重复、持久化与撤权竞态、Task 拒绝、已结束 A/当前 B、unknown 不查询原生收据或重放；生产 DOM 检查草稿、受理与结算分离、目标缺失/变化和丢失回应后终态不冒充因果确认。

原生启动获准后，使用 `RC06_STOP_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`。复用原 Host/Core/Runtime/Noise harness，T23 默认 100 次：延迟已准入的 interrupt 原生发送，真实 A 结束并启动 B，再释放原 A 请求，检查 B 未受影响。T23 循环也检查双设备停止与丢失回应；T24 检查真实 Runtime 工具中断后的结算、Task-owned 拒绝及离线已保存回执。仅语法检查或 fixture 通过不能替代此运行；启动条件仍受阻时保持原生未执行。此调用默认使用 Direct；Relay 使用上文传输 selector，并保留 Relay 浏览器 UNRUN 边界。两种调用均不提供公网或真机证据。

`RC06_SETTLEMENT_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e` 只运行 T24，不重跑 T23。它与其他专用模式互斥；manifest 的 selectedSuite 为 RC06_T24，业务检查完成后的 coveredCases 仅包含 T24，requestedRepetitions/completedRaceIterations 均为 0，raceAcceptanceRequired 与 acceptanceRepetitionsMet 均为 false。已有 T23 的 100 次竞态证据与 T24 专用记录分别保留，组合评估时不覆盖原失败制品。

T24 在 Stop 前读取原 Turn 与工具并确认 inProgress；Core 原子 guard 的 accepted 结果见证准入时目标仍为该原活动 Turn。网络回执后的独立读取可以观察到原 Turn 仍 inProgress，也可以已经 failed；后者及最终结算均须保持同一原始工具 Item/runtimeEpoch/scopeId/operationId、UNKNOWN、工具状态 failed、success=false，且没有 inspection 确认。这不保证网络回执早于物理清理。带 scope.waitClosed 门控的 Engine 测试单独表达原生准入不等待清理；将精简 Direct/Relay 快照重放至实际 T24 断言仅是源码证据，不等于执行该 Engine 测试或证明 Native 清理顺序。重复命令与收据查询不增加 native 派发，Runtime 标记使用追加且必须只出现一次。failed+UNKNOWN 不证明工具或资源已清理；manifest 保留资源不确定性与 service drain 错误，不自动 ACK。T21/T24 的 Task 拒绝使用新的 held 普通 Turn，等待实际同 Thread queued Run，并在发送前记录 Core atomic ownership、Task/Run、队列、配置版本和完整响应；未来排程本身不作为 Task 所有权证据。清理先取消并等待 queued Run/worker 结算，再中断 held Turn；取消或结算未确认时保持 held Turn，记录资源不确定性并交由外层服务清理，不释放 queued Task。

## RC-07 可重复验证

`pnpm --dir clients/gui run test:remote-interaction` 使用生产 Gateway、SessionObservers、真实磁盘日志和实际 Noise/Direct，Core RPC 为确定性 fixture。覆盖原生 interactionId 与独立 operationId、顺序分页审阅凭据、部分/伪造/陈旧页面、4 MiB 读取上限、拒绝不依赖完整正文、原 Turn/digest/interaction 绑定、永久决定拒绝、Core 题目集合与 4096/4097 UTF-8 边界、双设备、最终撤权和服务替换、响应丢失/保存失败/Host 重启后的 UNKNOWN、延迟重复优先、活跃 Session 与读队列预算。未知回答后原 Turn 已结算，后续桌面配置/发送可进行，原未知关联不变；未知 create/send 仍阻塞。`test:remote-session` 从生产页面按钮验证分页、不可完整审阅时禁用允许、Core 表单、深快照、原命令核对与独立观察。

原生租约获准后，运行 `RC07_INTERACTIONS_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`。T25 默认 100 次确定性竞态：延迟原 A 回答到真正 Core 调用前，另一设备拒绝或 Stop 使 A 结算，再启动 B，释放旧决定并检查 A/B 均没有 Runtime 文件副作用。T26 对精确 64 KiB 原始/有效参数验证完整分页、digest、错误 IDs、部分审阅与恶意永久决定后拒绝，确认没有 Runtime 效果；另用 48 KiB 多页参数检查仅本次允许的唯一实际文件效果、再次审批与 lost-response UNKNOWN。每次伪造 allowSession/allowProject 前后读取原 Thread 的 `areal/permissions/read`，精确比较 session 与 project 授权集合未变；强制审批 Profile 即使存在授权也会提示，pending 不能证明未记忆。原 Thread 再次提交相同 64 KiB 命令与约束，仅检查新 Turn 自身的交互 ID 和新 digest 绑定，使用该新交互拒绝并确认没有效果，不复用旧 digest/token。模型参数上限与 Runtime 编码请求信封上限不同，64 KiB 审阅不声称该大小可执行。T27 验证真实 Core 题目、精确键、选项、UTF-8 边界、两设备唯一原生回答和过期问题。

`RC07_SETTLEMENT_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e` 仅运行 T26/T27，跳过已有 T25 竞态。该模式与其他专用模式互斥；selectedSuite 为 RC07_T26_T27，requestedRepetitions/completedRaceIterations 均为 0，raceAcceptanceRequired/acceptanceRepetitionsMet 均为 false，coveredCases 只记录实际完成的 T26/T27。保留先前 100 次 T25 与原失败制品，分别评估补跑结果。

`RC07_RACE_REPETITIONS` 少于 100 仅用于诊断。manifest 分开记录 requestedRepetitions 与 completedRaceIterations；只有所选 suite 成功且实际完成至少 100 轮时 acceptanceRepetitionsMet 才为 true。启动失败或零完成轮数不能满足门槛。此调用默认覆盖本机 Direct；Relay 使用上文传输 selector，并保留 Relay 浏览器 UNRUN 边界。公网、手机、系统钥匙串、发行包需各自证据。脚本语法检查、fixture 与 DOM 通过均不等同于原生 T25–T27 完成；受阻时保留原失败制品与未执行状态。

## RC-08 可重复验证

`pnpm --dir clients/gui run test:remote-task-question` 通过生产 Gateway/SessionObservers/Backend、真实临时日志和 Noise/Direct 检查 Task 原始身份、完整性与分页预算、Core 选项、UTF-8 答案、深拷贝、同键语义冲突、双设备冲突、回执保存与 UNKNOWN、不重放、授权和服务替换。`test:remote-browser` 驱动生产页面验证 Task Inbox 可达、无需 Session、原定位信息先落盘、详情改变不发送以及恢复仅查询原命令。`node clients/gui/scripts/remote-native-harness-contract.mjs` 检查原生 harness 的 Task 模型序列和选择器计数，不启动原生进程。

取得原生运行租约后执行 `RC08_TASK_QUESTIONS_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`。复用现有 Host/Core/Runtime/Noise pipeline：T28 在原生问题待答时检查实际 Runtime 副作用与运行中状态，再回复同一 Run 并检查继续执行；覆盖暂停后回复不恢复、原标识/跨项目拼接、过期/取消/终态/已回答与双设备竞争。T29 保存已知回执后重启 Host，并分别丢失原生回应、失败 outcome 保存、在 Core 受理后结束 Host 进程，要求 UNKNOWN 加独立观察、无重放、原 Channel 仅一条回复和仅一次实际 Runtime 后续副作用。pending 落盘失败不得派发。

该模式与其他专用模式互斥，selectedSuite 为 RC08_T28_T29；requestedRepetitions/completedRaceIterations 均为 0，raceAcceptanceRequired/acceptanceRepetitionsMet 均为 false，coveredCases 只记录实际完成的 T28/T29，不改变 RC05–RC07 的 100 次竞态入口。保留原始失败、源码/二进制身份及清理结果。源码、语法、fixture 和 DOM 通过不能代替原生运行；Relay、公网、真机手机、系统钥匙串和发行包仍需独立证据。

## RC-10 可重复验证

`pnpm --dir clients/gui run test:remote-review` 覆盖生产历史审查/SessionObservers、真实 Noise/Direct/CoreClient 与 HTTP 原生边界 fixture，以及生产 Remote DOM。检查失败 Turn 的部分输出和独立 TaskRun 状态、乱序元数据的路径键 hunks、不可重建历史、UTF-8 分页、原 Turn/Item 媒体归属、同 blob 跨 Turn/连接拒绝、逐块撤权、服务变化、资源消失、流取消、签名/尺寸/像素预算，以及关闭/异步解码后禁止恢复 URL。原生边界 fixture 不启动 Core/Runtime，DOM fixture 不代表实际浏览器解码；生产 Desktop CoreClient 回调不被只读观察接管。

源码契约同时通过共享 `reviewTurnFiles` 和 Remote `review.read` 检查原生形状的参数记录：缺席有效参数覆盖的创建及完整读取→覆盖写入→补丁链、有效覆盖优先、显式无效覆盖不回退、缺失/原始参数不替代、路径/字节数/hash 不符、缺少写前版本和 UNKNOWN/失败记录。当前工作区包含不同文本时仍返回原版本且不修改文件；既有 NUL 二进制拒绝保留。这些 fixture 不改变 T32 的原生 available 断言，也不证明原生重跑或历史读取/重建的 CPU/内存隔离。

实际 Noise 的 ready 与 host.describe 同时检查 Operator、Observer 和不含 pauseTask 的旧授权能力交集；把这些实际响应及原生边界 Task 读取结果送入生产页面，验证明确审阅后只有 Operator 的暂停按钮可达。该检查覆盖既有 pauseTask 公告遗漏造成的 RC-09 界面阻塞，不改变设备预设或授权所有权。

取得独占原生租约并审查冻结版本后，运行 `AREAL_REMOTE_NATIVE_ALLOWED=1 RC10_REVIEW_ONLY=1 AREAL_CORE_BIN=/absolute/reviewed/areal pnpm --dir clients/gui run test:remote-command-e2e`。该模式与 RC05–RC09 模式互斥，selectedSuite 为 RC10_T32_T33_T34，不执行竞态循环。T32 使用实际 Runtime 文件写入，修改当前工作区后仍检查原历史 diff，并制造 provider 失败保留部分输出；T33 使用 Responses 图片事件持久化原生 AgentMedia，经可信 blob HTTP 读取并检查跨设备/项目/引用和同字节不同 Turn；T34 检查原生记录中的 HTML 字节和超限 PNG 尺寸被拒绝。manifest 仅记录实际完成用例、源码/二进制和清理结果。该入口随后启动实际 Chromium，使用生产 Remote 页面经邀请/Noise 配对，由可信 RemoteControl fixture 确认 Observer 授权，检查原历史 diff、失败部分输出、真实图片解码和 A→B→A 选择，保存截图、页面错误、静态清单身份及浏览器关闭结果；安全存储和桌面确认仍为 fixture，不代表 Electron/系统钥匙串验收。失败加载后的重试仍只由源码 DOM fixture 验证。流取消、资源消失及超限元数据的源码 fixture 不算原生用例。

结果审查容器对正文、错误和 diff 文本保留原文与换行，长行自动折行，每个 `pre` 以有限高度独立滚动。RC10 在每张完整页面截图之前读取公开 DOM 的页面宽度、文本块计算样式和滚动尺寸，断言页面宽度不超过视口、文本块折行且高度有界，并将每块文本的字符数、UTF-8 字节数和 SHA-256 与原生审查结果逐块核对；布局证据不记录正文。未通过布局核对时不进行失败页面截图，避免巨型位图分配。源码 oracle 验证这些断言能拒绝宽度失控、缺少容器、未折行、无限高度及正文改变，不能替代实际浏览器几何与滚动验收。

源检查只证明这些调用和状态路径，不替代 T32–T34 的实际 Host/Core/Runtime、浏览器或真机证据。既有 Core blob HTTP 整体分配、每个 Remote 块重新读取完整 blob 的成本，必须在原生验收中单独记录。无 API/正文/制品缓存或文件写入权限。

## RC-11 可重复验证

构建 GUI 后运行 `pnpm --dir clients/gui run test:remote-network`。它包含现有网络适配器 CLI 协议检查、真实本地 Direct 监听器的 Host 集成测试，以及生产 React 设置组件的源码渲染检查。所有可执行 CLI 都是独占临时目录内的 fixture，不调用真实 Tailscale，不改变账号、VPN、组织配置或公网。

Host 测试通过现有可信 `remoteControl` 边界，覆盖脱敏方案与确认、renderer 目标/可执行文件注入拒绝、仅实际 Remote 端口可映射、陈旧方案与监听器消失、pending/final 保存失败、固定端口重启/冲突、owned/pending 日志恢复不重放、映射漂移、关闭前持久保存及关闭后等待精确所有权撤销。CLI smoke 另覆盖缺失/旧版本、登录/HTTPS 状态、未知 schema、超时/输出上限与保留外部配置。系统安全存储是 fixture 边界，不能作为真实钥匙串证据。

本地 HTTPS 代理保留原 Host/Origin，验证精确同源 WSS、真实 Noise 配对与一个授权项目的读取，同时拒绝 Core/管理路径与管理方法。TLS 使用仓库 `tests/fixtures/proxy` 的公开测试证书，仅在单次 Node 请求中传入 CA；无 CA 与错误主机名均必须失败，不关闭证书校验、不安装系统信任。HTTP/WS 混合来源及伪造转发头被拒绝，来源变化取消邀请并断开连接。

这些是源码与本地协议证据。React 检查只验证源码渲染，不证明真实点击、浏览器 CSP/TLS 行为或视觉可用性；本地 TLS/Noise 也不证明真实 Tailscale CLI、tailnet/组织 ACL、iOS/Android、扫码、手机切网、Electron/钥匙串、包安装或公开部署。T35 的真实手机与网络门槛保持独立，不能因 fixture 通过标为全部完成。

现有 `test:remote-pairing-e2e` 还通过生产 Electron 设置页 → 私有 DesktopService → RemoteControl 执行网络检测、绑定方案、明确同意、应用和关闭移除，再恢复本机入口继续原有配对/迁移检查。只在测试 Node Host 的既有构造器中注入独占 fake CLI，验证确认前无配置变更以及精确目标/端口的应用和移除；不向生产 Main 或系统 PATH 增加可执行文件配置。同一向导还分别检查只确认范围、只确认公网均不能执行 CLI，双确认后才切换 fake Funnel 映射；恢复私人入口的方案必须重新确认，再关闭并移除。此路径不认证公网 T44。manifest 的 `networkWizard` 单独记录该层和实际执行情况。脚本存在不代表点击已验收，该 fixture 也不证明真实 Tailscale、组织 ACL、系统钥匙串或手机链路。

## V1. 主测试入口

从真实 Web/PWA 的 Remote 公共契约进入现有 DesktopService，再连接隔离 Core/Runtime 与确定性本地模型。模型生成固定的工具调用、同步审批、异步问题和结算序列；不调用付费模型。用隔离工作目录记录唯一副作用标记，检查真实执行次数，而不是只检查 RPC 调用次数。

复用现有连接恢复与架构 smoke 的隔离方法。网络故障代理可以 mock，但被测授权、Core 准入、持久日志、审批和恢复不能由 mock 替代。Direct 和 Relay 通过同一 suite 的 transport 参数运行，业务断言相同。

在 macOS 上运行 `pnpm --dir clients/gui run test:architecture` 时，需要可交互且已解锁的桌面，并独占窗口焦点。测试通过生产 preview `show` 路径绑定展示页的 project/thread owner，再要求窗口可见、未最小化且有焦点，才执行首次导航；保留这些 guard，不用 mock 焦点替代 Native 证据。合成对话框夹具不认证真实人类同意。桌面条件不可用时，已尝试运行的 guard 超时保留实际 FAIL 与已执行范围；未尝试的验收保持 UNRUN，等待桌面条件变化后再运行。

## V2. 覆盖矩阵

类型 auto 为自动化，hybrid 需要自动化加真实系统/网络，manual 为真机/公网人工验收。所有用例初始状态为“未执行”。

| ID | 操作/故障 | 必须观察到 | 类型 |
|---|---|---|---|
| T01 | 已授权设备读取真实Host/Project，检查响应与静态资源 | 观察成功；无Core Bearer/配置凭据结构字段 | auto |
| T02 | 中间人替换Host Noise身份 | pin验证失败；邀请秘密未发送 | auto |
| T03 | 不支持版本/旧写客户端/未知方法与字段 | 结构化拒绝；无自动降级 | auto |
| T04 | 从Remote公网入口探测Core与桌面管理接口 | 管理接口不可达；错误Origin被拒绝 | auto |
| T05 | 邀请超时、取消后再扫码 | Host按期限拒绝，允许重新创建邀请 | auto |
| T06 | 两台设备同时claim同一邀请 | 只有一个claim有效；仍需桌面确认 | auto |
| T07 | 授权缩小/撤销时已有订阅、查询和制品流 | 后续输出与命令被阻断；旧闭包权限无效 | auto |
| T08 | 持久保存授权或撤销时注入磁盘失败 | 不宣称成功；不先授予未保存权限 | auto |
| T09 | 从旧remote配置迁移，模拟中途失败 | 保留identity/项目，需复核；失败不启用公网 | auto |
| T10 | GUI从未打开的Thread处于运行/审批/失败 | 概览仍完整反映状态与待处理 | auto |
| T11 | Task异步提问后继续工作、多个worker | 运行与待回答共存，协调Thread不重复 | auto |
| T12 | 大量项目条目与超大单项的分页 | 页面有界、cursor正确、部分计数不冒充总数 | auto |
| T13 | 在Session基线截取期间产生模型增量 | 基线与后续输出无丢失/重复 | auto |
| T14 | 旧连接延迟事件在新连接完成后到达 | 旧代际不能改变新投影 | auto |
| T15 | 序号缺口、慢设备与积压超限 | 单设备resync/断开；Core与其他设备不被阻塞 | auto |
| T16 | Core执行工具中重启并恢复UNKNOWN | 保持UNKNOWN，不重放/acknowledge未知工具 | auto |
| T17 | 手机关闭详情/页面，桌面保持工具调用 | 工具宿主绑定与Core工作继续 | auto |
| T18 | 同command重复create，Core受理后丢回应并重启Host | 只创建一个Thread；原ID可核对 | auto |
| T19 | 同send包反复到达；不同设备复用相同UUID | 同意图最多一次；命名空间相互隔离 | auto |
| T20 | 已用commandId变更text/target/answers | COMMAND_CONFLICT，原语义不改变 | auto |
| T21 | 忙碌/Task-owned/未知提交/旧配置/Workflow Profile/离线项目 | 保留草稿并明确拒绝，无enqueue/ensure/配置扩权 | auto |
| T22 | 日志写入前、Core受理后、回应前分别断线/失败 | 持久记录先于执行；未知只读查询，不修配置 | auto |
| T23 | Turn A结束、B启动后到达停止A请求 | B不被中止；显示目标已改变 | auto |
| T24 | 原生 interrupt 非阻塞准入，双设备同时 Stop | 原子准入绑定原活动目标；独立观察 terminal，不保证网络回执早于清理、不伪造本设备确认 | auto |
| T25 | 用户审阅后替换审批参数/Turn/digest | 拒绝旧决定，展示需重新审阅 | auto |
| T26 | 伪造allowProject/allowSession，审批参数未完整加载 | 不允许永久授权；不完整内容只能拒绝/桌面处理 | auto |
| T27 | 同步题目过期/另一端回答/UTF-8超限 | Core裁决一次，严格题目与字节校验 | auto |
| T28 | Task/Run/Question跨项目拼接、过期、终态后回复 | 按原Channel语义拒绝，不创建普通聊天 | auto |
| T29 | Task回答已接受但响应丢失且无公开receipt查询 | 只报保存回执/观察状态，不能猜测因果成功 | auto |
| T30 | Gateway预检后Task更换Run，再提交pause | Core原子Run/revision guard拒绝迟到暂停 | auto |
| T31 | Task暂停中协调Turn结束但worker尚未settled | 不提前报Task已暂停完成，后续调度确实暂停 | auto |
| T32 | 失败部分正文与并发工作区Diff、文件顺序差异 | 结果/来源如实，patch按路径对应 | auto |
| T33 | 猜测blob/路径、跨Thread制品、撤销后继续拉取 | 逐块授权，拒绝越权及未知引用 | auto |
| T34 | 恶意HTML/SVG/外链与超大图片/长Diff | 无主动内容执行或自动外传，预算生效 | auto |
| T35 | 真实Serve/组织HTTPS手机接入，私网缺失与证书失败 | 诊断正确，无公网自动fallback，持久映射可撤销 | hybrid |
| T36 | Relay伪造room/channel/Host占位和重复连接 | 所有权逐帧校验，合法Host可安全替换旧连接 | auto |
| T37 | Relay重启/Host离线时发消息，恢复网络 | 无离线执行队列，重新配对/基线恢复按契约 | auto |
| T38 | 未认证握手洪泛、超帧、慢消费者与日志检查 | 受限资源，无payload/token日志或跨room泄漏 | auto |
| T39 | 记住设备/guest/清站点数据、Service Worker升级 | 身份策略明确，不缓存敏感数据，不自动重发草稿 | hybrid |
| T40 | GUI正常退出后手机观察/审批，随后系统睡眠 | 后台继续；睡眠如实失联，不假装运行 | hybrid |
| T41 | 真实iOS/Android扫码、IME输入、挂起与Wi-Fi/蜂窝切换 | 界面可用，重连无重复副作用，未知状态可核对 | manual |
| T42 | 干净环境从公开源码部署Direct与Relay | 不需要私有服务、厂商账号或Core token拷贝 | hybrid |
| T43 | 备份恢复、撤销记录过旧和协议回滚 | 恢复默认禁用Host登记；核对/重登记，不降低认证 | hybrid |
| T44 | 可选Funnel公开入口启用、配对、撤销与恢复private | 明确许可，只暴露Remote，无证书绕过 | manual |

## V3. 证据与量化要求

每个用例保留 transport、Host/Core/Client版本、测试命令、隔离配置、执行记录和断言结果；敏感业务正文不进入公共报告。未知副作用测试检查未再次执行。对T18/T19/T22/T23/T25/T30的确定性竞态，每个transport运行至少100次，零重复/错目标/越权才通过；这不是生产故障概率保证。

慢设备故意不消费输出直至预算触发；同时让第二设备完成观察与一条合法操作，确认没有全局阻塞。记录overview/page、WS帧和buffer高水位，所有限额按真实字节计，不按字符数。模型等待/网络延迟不应被计作Agent已经停止。

现有仓库命令见[开发指南](README.md)与[GUI 指南](../../clients/gui/README.md)。Remote 专用conformance/安全脚本由实现票新增，并登记在真实包脚本中。报告必须区分命令不存在、环境不满足、未运行、失败和通过。

## V4. 发布门槛

Direct私网与Relay为必需路线；Funnel可选，启用则T44必需。两条必需路线的自动化用例、真实macOS后台/钥匙串、iOS Safari与Android Chrome、真实HTTPS/WSS配对都必须有证据。仅模拟网络或桌面尺寸截图不足以认证手机体验。

阻止发布的失败包括：重复副作用、跨项目/设备/room数据泄露、过期审批被接受、旧Stop取消新Turn、Task换Run被误暂停、Core凭据出现在客户端/日志、撤销不生效、未知状态被自动重放、可到达高权限本地接口。

上线由维护者明确批准。未跑真实平台时可交付受控测试构建，但不得在功能清单声明对应公网写控制已认证。已知限制写进指南：Host必须在线、浏览器发布源受信、无后台push/自动唤醒/移动ADE、忙碌消息不自动排队。

`pnpm --dir clients/gui run test:remote-task-pause` 验证生产 Gateway、Task 观察和真实临时 journal：当前 Run/版本、缺失 guard、已知回执落盘、旧命令去重、队列中新 Run、撤权和 UNKNOWN 与独立 worker 观察。`test:remote-browser` 检查原 Run 审阅、显式确认与负向控制；harness 模型检查不启动原生进程。

独占原生窗口运行 `AREAL_REMOTE_NATIVE_ALLOWED=1 RC09_TASK_PAUSE_ONLY=1 RC09_RACE_REPETITIONS=100 AREAL_CORE_BIN=/absolute/reviewed/areal pnpm --dir clients/gui run test:remote-command-e2e`。T30 必须记录 100 次实际完成原 Run 后、Gateway 暂停请求持有期间创建下一 Run 的竞态；T31 要求真实 Runtime worker、已完成协调 Turn、暂停后的 worker 清理和未来调度抑制。manifest 分别记录 requestedRepetitions/completedRaceIterations，只有实际达到 100 次才满足竞态验收。源码 fixture、模型测试和少量诊断运行不能替代此证据。
