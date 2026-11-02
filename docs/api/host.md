**中文** | [English](host.en.md)

# 共享 Host 协议

本文包含已实现接口与后续目标契约。Host 提供认证后的项目管理、停止回执、订阅、旧服务迁移，以及 H2 的来源导入、旧秘密退役、提交 journal、固定凭据槽与 Remote 状态接口。`hello` 声明 `projects`、`stopOperations`、`subscriptions`、`legacyMigration`、`guiImport`、`submissionJournal`、`credentialVault` 和 `remoteState`，尚不提供 `updates`。普通 GUI 的项目连接、journal、凭据与 Remote 状态消费者使用 Host。完整退出语义、连接资源撤销、Remote 执行迁移和服务管理器交付仍在实施。协议定义不代表运行或安装包验收通过。另见[实施规格](../development/shared-host-spec.md)、[所有权决策](../adr/0016-shared-host.md)与[每项目服务契约](local-service.md)。

## 传输与认证

规范化服务 home 中只有一个 Host 独占 `host.lock`。H1 按 `AREAL_HARNESS_SERVICE_HOME`、`AREAL_HARNESS_HOME`、`~/.areal` 的顺序选择 home，权限为 0700。Host 描述包含 `version`、稳定 `hostId`、每次启动更新的 `generation`、`socketPath`、`authFile`、`pid` 和可执行版本。PID 仅供诊断，不作为发信号或接管依据。Unix 路径超长时沿用现有私有短路径 `control.sock` 派生规则。socket 与认证文件权限 0600，必须归相同 UID 所有，不得经不可信符号链接解析。

本机 Unix domain socket 使用逐行 UTF-8 JSON，每帧一个请求，最大 1 MiB。分发前校验 peer UID 与 Host UID 相同，并核对 `hello.params.authToken` 与当前认证文件秘密。认证失败关闭连接。token 不进入命令行参数、URL、日志、状态事件或 Remote 响应。认证前只接受 `hello`，重连重新握手。认证 token 随 Host generation 轮换。本契约授予可信本机用户访问权，不隔离该用户自己的进程。

## 消息封装与公共类型

请求使用独立 envelope，与现有 service 控制协议分开。结构字段使用 camelCase，tagged enum 值使用本文的 wire 字符串。Rust serde 可用 envelope 加按 method 标记的 payload 表达。版本 1 拒绝未知字段与无效组合。除非特别注明，可选字段省略，不写 null。

```json
{"version":1,"id":"rpc-1","method":"hello","params":{"protocolVersions":[1],"capabilities":["projects"],"authToken":"<从私有 authFile 读取>"}}
{"version":1,"id":"rpc-1","result":{"version":1,"hostId":"host-uuid","generation":"boot-uuid","capabilities":["projects","stopOperations"],"executableVersion":"build-id"}}
{"version":1,"id":"rpc-2","error":{"code":"projectAmbiguous","message":"Select a projectId","details":{"projectIds":["p1","p2"]}}}
```

`id` 是关联单次传输响应的非空字符串，不是幂等键。有副作用的写操作另带非空 UUID `requestId`，在副作用前持久化。相同 ID 不得绑定不同方法参数。`expectedGeneration` 指 Host 启动代际，`serviceGeneration` 则指项目 Core 服务代际。旧 Host 代际在新副作用前返回 `generationMismatch`；新 Host 仍允许查询旧回执。

`ProjectRegistration` 独立于运行服务描述持久化。字段为 `projectId`、规范绝对路径 `workspace` 与 `dataDir`、`source`、`defaultBinding`。`source` 为 `{kind:"cli"}` 或 `{kind:"gui",profile,legacyProjectId}`。`defaultBinding` 是布尔值，为工作区选择默认登记。`projectId` 是稳定不透明标识，不等同于工作区路径。服务描述保留 service-v1 既有字段，仅在协商后的 Host-aware 契约中增加 Host owner。

普通 GUI 登记要求 `profile` 对应唯一已提交来源，`legacyProjectId` 为 24 位小写十六进制别名。新 GUI 项目的 `dataDir` 必须为该来源的 `<coreHome>/<legacyProjectId>/state`。原导入绑定保留原 Store 路径。同一来源别名不能改绑另一个 Host 项目。Host 在现有项目登记文件中保存新别名，不改原导入 manifest。未知或歧义来源分别返回 `sourceNotFound` 或 `sourceConflict`。

`ProjectStatus` 包含 `registration`、`state`、可选 `service` 和 `migration`。状态为 `stopped`、`starting`、`ready`、`stopping`、`unavailable` 或 `legacyPending`。迁移记录包含原 `serviceId`、`generation`、存在时的 owner、来源 profile 与阶段。`legacyPending` 不制造 Host owner，也不签发声称受 Host 监督的描述。等待迁移时，客户端原有旧连接可以继续运行。

监督 owner 为 `{kind:"host",hostId,generation}`，标识持有 service-host 生命期管道的进程。它与 Remote Noise peer 身份、设备授权分别建模。H1 与 H2 保留 `{kind:"gui",appRunId,profile}` 的运行支持，直到 GUI 生命周期迁移完成；之后只保留旧身份识别。旧 GUI 不能接管新 Host-owned 服务。不能静默改变严格 service-v1 的旧客户端解码行为，必须协商 Host-aware 描述或返回能力错误。

`LaunchInputs` 必须包含绝对路径 `workspace`、`cwd`、`configHome` 与 `options:LocalArgs`，另有可选绝对路径 `homedir`、`configPath`、`deploymentPath`，非秘密字符串映射 `environment` 和 `credentialNames:string[]`。外层字段使用 camelCase；`options` 保留 `core/local-service/src/spec.rs` 中的 snake_case 字段，可选参数值允许 null。它包含模型选择、权限、沙箱与 Runtime 限额、工作区/数据/配置路径，以及 `read_only_path`、`task_credential_command`、`no_deployment_mcp`。CLI 参数使用连字符。CLI 连接后通过 Core 配置 run-scoped MCP；Host 启动输入携带相应凭据名，不携带 `mcpConfigPath`。Skill 根目录属于部署条目，不另设 `skillsPaths`。

客户端发送前解析路径与启动上下文。Host 启动前校验登记一致性、绝对路径、允许的环境名与配置。秘密通过认证连接中的独立字符串映射 `project.ensure.credentials` 传递；`credentialNames` 标识所需条目，也包括生成的 MCP 秘密引用。凭据值不进入 Debug 输出、日志、状态或持久操作参数。H1 将它们保存在当前 Host generation 的项目私有内存中；缺失必要值返回 `credentialsRequired`。密钥库持久化属于 H2。

发布 ready 前，Host 将部署 JSON 和引用的 Skill 树快照到 `<home>/host/launch/<project-id-digest>/`，保留嵌套资源和可执行位。重写后的路径保存在 `inputs.json`，部署与 Skill 路径包含内容摘要。Core 对同一 `id/revision` 保留显式部署的 Skill 根目录，自动发现及刷新不会覆盖该快照；不同 revision 继续按现有发现规则处理。CLI 随后可移除自己的临时部署目录。普通 TOML 保留原路径与既有配置监听行为，配置兼容性与安全重启规则继续生效。各子进程使用提交的 cwd 和环境，Host 不修改进程全局 cwd 或环境。`configHome` 保留调用端的配置、插件与 Hook 根目录，与 Host registry home 独立；Host 仅把 `AREAL_HARNESS_SERVICE_HOME` 指向自身 registry。

`noAutoRestart` 默认为 false。设为 true 时，ensure 不会自动重启已有但不兼容的服务；它仍是显式激活，可以启动已停止项目。自动重连只读取 `host.status`，配置变更需显式重新打开或重启。

`projects.register` 可在项目身份、工作区、数据目录和来源不变时更新 `defaultBinding`。普通登记只修改 Host 项目目录，允许登记忙碌的旧服务。`bindExisting` 默认为 false；兼容命令 `areal service bind` 设为 true，由 Host 核验停止状态与 Store 工作区归属，再提交旧工作区映射和默认登记。失败保留原操作回执。

## 方法参考

所有方法均可返回 `invalidRequest`、`unsupportedVersion`、`unsupportedCapability`、`unauthorized`、`internalError`。未知方法返回 `methodNotFound`。下表列出额外错误。缺少回执、断连和超时都不证明未受理。

| 方法                | 请求 params                                                                                                      | result                                                                                                      | 额外错误                                                                              | 幂等规则                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`             | `protocolVersions:number[]`、`capabilities:string[]`、`authToken:string`                                         | `{version,hostId,generation,capabilities,executableVersion}`                                                | `versionMismatch`                                                                     | 只读握手。重连后重做，不按可执行版本推断能力。                                                                                                                                                       |
| `host.status`       | `{}`                                                                                                             | `{hostId,generation,state,projects:ProjectStatus[],restartPending,stopIntent,capabilities}`                 | 无                                                                                    | 只读快照，不激活项目。                                                                                                                                                                               |
| `host.activity` | `{}` | `{complete,projects:ProjectActivity[],totalActiveTasks}` | 无 | 需要 `activity` 能力。只读观察全部登记项目，不启动或停止 Core。 |
| `projects.list`     | `{}`                                                                                                             | `{projects:ProjectRegistration[]}`                                                                          | 无                                                                                    | 只读持久登记，包含已停止项目。                                                                                                                                                                       |
| `projects.register` | `{requestId,expectedGeneration,registration:ProjectRegistration,bindExisting?:boolean}`                          | `{registration,created:boolean}`                                                                            | `projectConflict`、`dataDirConflict`、`defaultBindingConflict`、`migrationConflict`、`aliasConflict`、`sourceNotFound`、`sourceConflict`   | 在 Host 锁下持久化键、规范参数与结果。同键同参数返回原结果，参数变化返回 `requestConflict`。仅本机。                                                                                                 |
| `project.ensure`    | `{requestId,expectedGeneration,projectId,launchInputs?:LaunchInputs,credentials?:object,noAutoRestart?:boolean,resumeScheduling?:boolean}` | `{project:ProjectStatus,service?:Service}`                                                                  | `projectNotFound`、`configurationConflict`、`migrationBlocked`、`credentialsRequired` | 显式用户激活。定时激活抑制仅在 `resumeScheduling:true` 时解除。同键返回原受理或结果。同一绑定的并发 ensure 收敛到一个服务。只有核验后的 ready Host-owned 服务返回 `service`。`legacyPending` 只返回状态，不声称已接管。 |
| `project.stop`      | `{requestId,expectedGeneration,projectId,serviceGeneration,strategy:"ifIdle"\|"cancel",suppressScheduling?:boolean}`                         | `StopReceipt`                                                                                               | `projectNotFound`、`generationMismatch`、`requestConflict`                            | drain 前持久化。重复键读取同一操作，不重复 drain。忙碌或结算未知用回执状态表达。                                                                                                                     |
| `host.stop`         | `{requestId,expectedGeneration,strategy:"ifIdle"\|"cancel"}`                                                     | `HostStopReceipt`                                                                                           | `requestConflict`                                                                     | 分发前冻结目标代际并持久化逐项目子操作 ID。重复键返回原汇总，不存在全局事务。                                                                                                                        |
| `host.operation`    | `{requestId}`                                                                                                    | `{operation:ProjectMutationReceipt\|StopReceipt\|HostStopReceipt\|UpdateReceipt\|ClientStateReceipt\|null}` | 无                                                                                    | 跨 Host 重启只读核查。`null` 是缺少证据，不授权重放。                                                                                                                                                |
| `host.subscribe`    | `{}`                                                                                                             | `{subscriptionId,generation,sequence:0,status:<host.status result>}`                                        | 无                                                                                    | 每次请求在当前连接建立观察，断连释放，不停止工作。                                                                                                                                                   |
| `host.update`       | `{requestId,expectedGeneration,action:"prepare"\|"apply",targetVersion,strategy?:"ifIdle"\|"cancel"}`            | `UpdateReceipt`                                                                                             | `updateUnavailable`、`invalidUpdateTarget`、`requestConflict`、`generationMismatch`   | `prepare` 登记已在本机安装且验证的目标。`apply` 必须携带 strategy，且目标与准备记录匹配，排空前持久化。回复丢失后只查询。不下载或执行客户端任意路径。                                                |

`host.status.state` 为 `running`、`stopping`、`stopped` 或 `crashLoopStopped`。`restartPending` 与 `stopIntent` 均为布尔值。能力是可加性的字符串，包括 `projects`、`activity`、`stopOperations`、`subscriptions`、`updates`、`legacyMigration`，只声明已实现的契约。缺少 `updates` 的 Host 在副作用前拒绝 `host.update`。Host socket 关闭后，本机发现层通过 `areal host operation` 读取持久终态回执，不启动或恢复停止操作。

状态事件为 `{version:1,method:"host.statusChanged",params:{subscriptionId,generation,sequence,status}}`，不带 RPC `id`。sequence 在单订阅内严格递增，每个事件都包含完整快照。代际变化、序号缺口或断流后重新握手并订阅，不持久重放事件，不自动重试写操作。

自动重连只读取 `host.status` 中经验证的现存服务描述，不调用 `project.ensure`，不清除停止意图。需要重新激活时由用户显式打开项目。`ProjectMutationReceipt` 包含 `version:1`、`requestId`、`method:"projects.register"|"project.ensure"`、`hostId`、`generation`、`projectId`、`state`，以及可选 `result` 与 `error`。状态为 `acceptedPending`、`blocked`、`admissionUnknown` 或 `completed`。查询返回原操作结果；旧 ready 结果不证明该服务当前存活，连接前仍核验实时身份。回执不包含凭据值。

## 定时项目激活与准备

`scheduledPreparation` 表示 Host 通过常驻认证连接注册 Core 调度宿主并处理 `areal/task/prepare`。普通 GUI 工具连接和调度连接可以不同，但必须属于同一认证身份；来源会话和执行锚点仍校验原连接与目录归属。Core 保留 Task、Run、准备结果及触发权威。Host 不为缺席的 Main 发布浏览器、计算机或 JavaScript 工具。

GUI 在线时通过 Core `areal/task/tools/ready` 发布当前 Browser/Computer bundle。Run 的调度生命期绑定 Host，桌面工具绑定实际 GUI 连接；退出 GUI 不终止纯模型执行，旧工具调用也不转发给后来的连接。注册是连接级状态，不迁入 Host 的持久任务记录。

`scheduledActivation` 能力表示 Host 承担定时项目激活。`host.status.projects` 的 `scheduleActivationSuppressed:boolean` 与可选 `scheduleActivationError:string` 是 GUI 的只读投影来源。错误仅包含领域错误码，不公开子进程 stderr 或秘密。

Host 启动后及登记、迁移、启动输入变化后读取已发布任务目录。只有目录证明存在启用任务且已有保存的启动输入时才请求原项目启动；Core 继续拥有到期触发、漏执行和重叠准入。`requiresCore` 或无法证明完整性的目录返回错误，不据此启动项目。两路扫描并发，失败从 5 秒退避到最多 300 秒；受理未知时先核查原 requestId。

显式 `project.stop` 在原生命周期请求中持久化定时激活抑制。维护停机传 `suppressScheduling:false`，只跳过新增抑制，不解除已有用户抑制；该字段默认 true。Host 重启、状态读取和普通 `project.ensure` 不解除抑制；显式恢复使用 `resumeScheduling:true`，与启动操作共享项目锁及回执。`host.stop` 保留全局停止意图，不把所有项目改为独立停止。旧 GUI 的 lifecycle 目标抑制通过来源与项目映射导入一次；后续状态由 Host 管理。

GUI 的 `LaunchInputs.schedulePreparation` 显式选择 `managed` 或 `external`。`managed` 携带绝对路径 `resourceStatePath`、`userManagedSkillsRoot`、`projectManagedSkillsRoot`，以及 `projectResourceScope` 和 `defaultProfile:{id,revision}`。Host 按现有用户/项目优先级及启停偏好生成部署，并保留历史 Skill revision。Skill revision 沿用 GUI 的目录、名称与描述摘要；只修改正文或附属文件不会生成新 revision，同一 `id/revision` 继续使用已保留的快照。`external` 只携带可选 `defaultProfile`，使用原部署和 Core 默认配置。CLI 可省略此字段；GUI 缺失准备描述时不推断资源来源。

启动准备核对当前 Task、Run、来源线程、旧独立目录预约和工作区作者记录。资源 profile 变化时，Host 保存原重启请求 ID、MCP 及可信 plugin 连接，确认 `restartSafe` 后执行 drain 和受控重启。重连核对原回执并恢复精确连接后才注册调度宿主。原 Core 回调不返回新代际的 profile；`resume` 保留已冻结的执行配置。GUI 后续启动也合并 Host 已保存的 managed Skill 版本，避免旧 profile 引用丢失。

## 全局活动

`host.activity` 返回全部已登记项目，包括由 CLI 或 TUI 启动且 GUI 尚未连接的项目。`ProjectActivity` 是以下两种结果之一：

- `{projectId,state:"observed",activeTasks,activeTurns,activeGoals,pendingQueueItems,idleAllowed}`。计数来自认证 Core 的 `areal/server/status`。`idleAllowed` 使用 Core 的 `lifecycle.ifIdle.allowed`，不能仅根据任务数推断。
- `{projectId,state:"unavailable"}`。正在迁移或启动、身份不匹配、无法核查锁或清理回执、状态查询失败均保留为不可用，不填零。

尚未启动且没有服务记录、生命期不确定性或占用锁的项目返回空闲零计数。已停止项目还必须有匹配原代际的清理回执及释放的服务与 Store 锁。查询不创建锁文件、Store 或服务记录，也不清除停止意图。

`complete` 仅在每个项目都可观察时为 true。`totalActiveTasks` 只合计已观察项目的 `activeTasks`，不叠加轮次、目标或队列；不完整时只是已知任务数。结果是逐项目观察，不是跨项目原子快照，不能作为后续停止操作的授权。停止仍由 `host.stop` 在执行时核查。

## 停止回执与部分结算

`StopReceipt` 包含 `version:1`、`requestId`、`projectId`、`serviceId`、`serviceGeneration`、`strategy`、`state`，以及可选 `message`、`lifecycle`。状态沿用既有服务停止语义，即 `acceptedPending`、`blocked`、`admissionUnknown`、`settlementIncomplete`、`completed`。

`HostStopReceipt` 包含 `version:1`、`requestId`、`hostId`、`generation`、`strategy`、`state`、`projects:StopTarget[]`。`StopTarget` 包含 `projectId`、`serviceId`、`serviceGeneration`、子操作 `requestId`、`dispatch:"notStarted"|"started"` 和可选 `receipt:StopReceipt`。`notStarted` 只表示 Host 尚未下发，不能伪装 Core 已受理。Host 在发送前持久化 `started`；崩溃后没有下层回执时按 UNKNOWN 对账，不假定未发送。汇总状态为 `acceptedPending`、`blocked`、`partial`、`admissionUnknown`、`settlementIncomplete` 或 `completed`。`partial` 表示至少一个目标完成且至少一个未完成；每个目标保留精确状态。`completed` 要求所有目标完成，且 Host 退出交接已持久化。已知忙碌拒绝为 `blocked`，不算 UNKNOWN。`admissionUnknown` 表示尚不能判定受理。UNKNOWN 只能用原 ID 查询，不能重放或自动改成新请求。

Host 在排空前保存并 fsync 汇总目标集合与各子操作身份。停止意图禁止停止过程中的新激活。Core drain 仍负责权威空闲检查、取消与结算。Host 在冻结项目准入后取得目标集合，不承诺跨 Core 原子 drain。一个项目可能已结算，另一个才报告忙碌；Host 保持可查询并返回部分结果。空闲停止被拒绝后，只有所有已受理目标核查完成才可解除激活屏障。显式 Host 停止成功后保留耐久停止意图，防止服务管理器重启；后续显式本机启动可清除该意图。

完成要求现有 Runtime 清理证明以及服务锁和 Store 锁释放，或在这些锁下核验后继代际。PID 退出和 socket 消失不足以证明。回执位于私有 home 中，不随代际清理。已知拒绝或已结算的不完整操作后可显式发起新意图；不能靠重发解决前次受理未知。

`UpdateReceipt` 包含 `version:1`、`requestId`、`hostId`、`generation`、`targetVersion`、`action`、`state`，以及可选 `stopRequestId`、`message`。状态为 `prepared`、`acceptedPending`、`blocked`、`partial`、`admissionUnknown`、`settlementIncomplete` 或 `completed`。apply 沿用逐项目停止回执与证明要求。新 Host 保留稳定 `hostId`、更新 `generation`，并暴露原升级回执。运行中的 Turn 不原地切换二进制。

## 项目登记与迁移

CLI 提供显式 `projectId` 时按该 ID 解析。否则先按规范工作区和显式 `dataDir` 匹配，再选择唯一默认绑定。存在多个候选且没有唯一默认项时返回 `projectAmbiguous` 与候选 ID，不能按显示名、目录顺序或首条登记选择。同一工作区、不同数据目录保留独立项目。同一规范 dataDir 不得产生第二写者。等价重复导入使用已保存的来源映射，不兼容绑定返回 `dataDirConflict`。

GUI 导入持久化 `(profile,legacyProjectId) -> projectId`，同时保存 Worktree 绑定、授权范围、回执定位、来源与默认绑定。旧 GUI ID 无冲突时原样保留；碰撞时分配新 ID，并在激活前提交完整映射。Remote grants 与旧请求定位沿该映射解析，不能因 ID 复用扩大授权。

GUI 根目录中的 `<projectId>-pending.json` 与 `<projectId>-outcomes.json` 提交 journal 位于 Core Store 外。必须保留原生 Core request ID、语义摘要、已受理结果、UNKNOWN 定位、原服务身份与全部 Remote 命令关联。先关闭旧 writer 准入、flush 并取得 journal 快照，再在 Host 锁下导入，fsync 绑定来源身份与 journal 摘要的迁移回执。回执耐久后才切换 writer，并通过新 owner 重新开放准入。恢复按回执阶段继续，不能产生第二写者。Core Store 和 dataDir 原地保留。升级前已受理但回复丢失的请求，升级后必须用原回执核对，副作用恰好一次。

旧无 owner 服务有活动任务时保持 `legacyPending`，原连接继续。迁移先空闲排空或显式授权取消，再核查持久停止回执、清理证明和锁，最后启动新的 Host-owned generation。修改登记元数据不能转交管道或进程所有权。旧 GUI-owned 服务同样要求原生命周期 owner 排空并结算后再替换。

只自动迁移一个具有兼容 Remote 身份的旧 GUI profile。稳定 Host 监督 ID 与 Remote Noise 密钥独立。保留 profile 的 Noise 密钥、设备 pin、grants、撤销记录与 journal 关联。第二个具有不同 Noise 身份的 profile 返回 `migrationConflict`，保留原状态，要求显式选择身份或隔离 home；禁止覆盖、合并或静默重新生成 Noise 身份。凭据迁移覆盖 API keys、OAuth refresh/access tokens 与 provider subscription transport 会话。密钥库成功写入回执必须先于旧密文退役。

## GUI 来源与提交 journal 接口

这些接口仅供经过认证的本机客户端使用。`GuiSource` 包含规范绝对路径 `profile`、`coreHome` 和 `legacyServiceHome`。Electron adapter 在持有原 Desktop singleton、停止旧 writer 并完成 flush 后绑定来源。连接断开释放来源 guard，不授权另一客户端重放未决请求。

| 方法               | 请求 params                                                                   | result                                                                            |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `gui.attachSource` | `{source:GuiSource}`                                                          | 当前连接的来源 guard。                                                            |
| `gui.source` | `{source:GuiSource}` | `{sourceId,migrationId,source,bindings,credentials}` 或 null。只读查询精确来源的原导入别名及当前 GUI 登记。 |
| `gui.import`       | `{requestId,expectedGeneration,source:GuiSource}`                             | 来源迁移状态，包括 `migrationId`、待提交秘密与已完成导入回执。                    |
| `gui.importStatus` | `{migrationId}`                                                               | 原迁移状态，不推进来源写入。                                                      |
| `gui.importSecret` | `{requestId,expectedGeneration,migrationId,slot,sourceDigest,value}`          | 密钥库写入并读回核验后的回执。`slot` 必须来自原 manifest，秘密不进入操作日志。    |
| `gui.retirementPrepare` | `{requestId,expectedGeneration,migrationId}` | 建立或恢复原退役计划，校验凭据持久性后返回下一个固定文件目标。 |
| `gui.retirementConfirm` | `{requestId,expectedGeneration,migrationId,planId}` | 核验文件摘要并保存退役进度。使用原 prepare 的 requestId。 |
| `gui.retirementStatus` | `{migrationId}` | 只读退役进度，尚无计划时返回 null。 |
| `journal.read`     | `{projectId}`                                                                 | `{projectId,revision,sha256,byteLength,snapshotPath}`。固定私有槽位中的完整快照。 |
| `journal.prepare`  | `{requestId,expectedGeneration,projectId,expectedRevision,sha256,byteLength}` | `{requestId,state:"prepared",slotId,writePath}` 或 blocked 回执。                 |
| `journal.commit`   | `{requestId,expectedGeneration,slotId}`                                       | 原提交的 completed 或 blocked 回执。必须使用 prepare 的连接与 requestId。         |
| `remote.read`      | `{}`                                                                          | `{revision,sourceId,config}`。包含秘密的配置只返回可信本机连接。                  |
| `remote.acquire`   | `{sourceId}`                                                                  | `{leaseId,sourceId}`。执行租约绑定当前连接，断连释放。                            |
| `remote.replace`   | `{requestId,expectedGeneration,expectedRevision,sourceId,config}`             | 持久替换回执，以 revision 校验写入冲突。执行租约不限制本机配置写入。              |

导入先保存固定 manifest 和原字节备份，再保存秘密与回执，核验旧服务清理证明和锁。Host 随后安装非 JSON 来源启动哨兵及每项目 journal 哨兵，最后发布 committed marker。未发布来源占用的项目不能激活或访问 journal，包括复用的 CLI 登记。导入保留原 Store、scratch 路径和 `(profile,legacyProjectId)` 别名。原 registry 与非秘密备份保留。原导入回执中的 `retirement:"pending"` 记录导入提交时的事实，后续退役结果由独立接口查询。

`gui.source` 按规范化的完整 `GuiSource` 查询，仅返回已提交来源。同一 profile 对应多个已提交来源时返回 `sourceConflict`，不混合新登记的别名。查询不取得来源 guard，不启动导入，不读取凭据，也不创建目录。`bindings` 中保留导入时复用的 CLI 项目别名，并加入该 profile 的新 GUI 登记。新绑定的 scratch 路径为 `<coreHome>/<legacyProjectId>/scratch`。Host 重启后从原导入回执和现有项目登记重建结果。

GUI 初始化或重连 Host 后，为 `ready` 的外来项目建立只观察连接并加载会话目录。发现项目不启动已停止的 Core，也不覆盖 CLI 的配置。同代际重发现保留正在建立的观察连接。历史配置解码接受 Core 的 `automaticSessionName` 字段；GUI 创建命令的输入字段限制不因此扩展。

`credentials` 仅含非秘密迁移元数据。`references` 合并原 provider 引用与该来源后续创建的 vault 槽，保留已撤销引用；值仍由 `vault.read` 决定。`migratedConfigPaths` 保留原配置迁移标记。`legacyProviders` 去除密文，仅对原 providers manifest 中有秘密的条目附加 `apiKeyEnv`。读取会核对原备份摘要或退役计划的派生摘要，不读取已封存的凭据源文件。

### 旧秘密退役

Host 在 `retirement.json` 保存独立计划与回执，不改原 manifest、凭据导入回执或 committed marker。Electron adapter 持有原 Desktop singleton，按计划替换原文件及对应备份。退役仅移除 manifest 覆盖的 provider 密文、订阅账户密文、Remote 密文及订阅传输明文 token。非秘密配置和未知字段保留。重复 JSON 键或不支持的来源格式会阻止退役，保留未处理文件。provider 启动哨兵、journal 哨兵、原 journal 备份、Store 和 `cloud.json` 不进入替换清单。

进度为 `{requestId,migrationId,planId,state,next}`，`state` 为 `applying` 或 `completed`。只有 prepare 返回下一个目标 `{site,relativeName,backupId,beforeDigest,afterDigest,byteLength}`。`site` 为 `source` 或 `backup`。status、confirm 和操作回执的 `next` 均为 null，不返回文件内容。Host 将派生内容保存在固定私有文件 `host/imports/<migrationId>/retirement/<planId>/<backupId>.bytes`，避免控制帧限制截断大文件。adapter 校验文件所有者、权限、类型、长度和摘要后，使用临时文件、fsync、rename 及目录 fsync 替换目标。备份路径沿用 `host/imports/<migrationId>/backups/<backupId>.bytes`。

prepare 要求原导入已提交、来源 guard 有效，且原 manifest 的每项秘密都有 completed 回执和可读的原 vault entry。缺失或锁定 entry 阻止后续替换。退役不使用当前凭据版本补种旧值，因此后续撤销不会复活旧账户。每个文件替换前重新 prepare，替换后 confirm。Host 独立读取并核验目标，只接受原摘要或计划中的派生摘要。完成前还会核验原启动及 journal 哨兵。

中断恢复读取原计划与派生文件，不再解析已退役的密文。rename 完成而 confirm 未完成时，Host 根据派生摘要记录进度。连接断开后重新绑定来源，并使用 status 返回的原 requestId。同一计划不能换 requestId 重建。status 和离线操作查询不访问密钥库，不推进退役。原 manifest 的摘要仍描述历史原字节；已退役的备份是由独立计划记录的派生副本。未被当前 committed manifest 引用的旧备份不在本计划内。

没有已导入或新建 Remote 配置时，`remote.read` 返回 `{revision:0,sourceId:null,config:null}`，不访问密钥库。已发布来源可用 `expectedRevision:0` 首次写入；一旦存在 Noise identity，后续替换不能改变它。待完成的首次写入也保留来源选择，不能由另一来源导入覆盖。授权范围包含该来源的原别名、新 GUI 登记和其他 Host 项目的稳定本地别名。GUI 的 Gateway 使用独立租约连接，连接失效关闭入口，迟到的 Direct listener 也会关闭。

### journal 与操作回执

journal 快照为 `{version:1,pending:object[],outcomes:object}`，保留条目内的未知字段。固定文件槽位承载大于 1 MiB 的快照，控制帧仍受传输上限约束。prepare 或 commit 的 CAS 冲突通过 `result.state:"blocked"` 与 `result.error.code:"revisionConflict"` 表达，不是顶层 RPC error。只有该明确冲突允许重读并重新计算修改。断连、超时或未决 commit 只允许查询原 requestId，不重新执行修改 closure 或 Core 派发。

已发布普通项目首次 `journal.read` 或 `journal.prepare` 时，Host 仅在记录缺失时创建 revision 0 的空快照。这也适用于先由 CLI 登记的项目。已有导入数据、revision 与操作回执保留。损坏记录不会被空快照覆盖。未知项目及未提交迁移保留项目在初始化前被拒绝；离线回执查询不初始化 journal。

在线 `host.operation` 与离线 `areal host operation <request-id>` 都查询生命周期、来源导入、秘密写入、秘密退役、journal、vault 与 Remote 替换回执。退役回执的方法为 `gui.retirementPrepare`，未完成时为 `acceptedPending`。离线查询不启动 Host、不访问 Keychain、不写入或修复状态文件。缺失 home 不会创建目录。

`ClientStateReceipt` 是这些 H2 领域回执的并集。每项包含原 `requestId`、`method` 和 `state`，以及对应接口的结果字段；`gui.import` 与 `gui.importSecret` 将领域结果放在 `result` 中。回执不包含秘密值。

离线查询优先使用已持久化的提交证据，包括原子 journal、vault 槽和 Remote 状态内的最终回执。独立回执文件缺失或仍为 pending 时，已存在的最终证据仍可返回 completed。只写入秘密 entry 而未提交状态的操作保持 acceptedPending，等待在线 owner 核查。未提交 journal slot 保持 prepared，不因离线查询而过期。`null` 始终表示缺少证据，不证明未受理，也不授权重放。Remote 状态在线恢复仍依据原稳定 vault entry 与 revision 核查，不使用新 requestId。

## 固定凭据槽

`credentialVault` 只服务已发布 GUI 来源。槽位为 `{kind:"providerCredential",sourceId,reference}`、`{kind:"subscriptionAccount",sourceId,providerId}` 或 `{kind:"subscriptionTransport",sourceId}`。`reference` 使用原 `AREAL_CREDENTIAL_*` 名称。不同来源的同名引用独立。Remote 身份仍归 `remote.read/replace`；通过 vault 访问 `remoteIdentity` 返回 `remoteStateRequired`。

| 方法            | 请求 params                                                  | result                                                                                                          |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `vault.read`    | `{slot}`                                                     | `{revision,value}`。已发布来源中尚无值的槽返回 revision 0 与 null。                                             |
| `vault.replace` | `{requestId,expectedGeneration,slot,expectedRevision,value}` | 原写入回执，包含 `requestId`、`method`、`slot`、`previousRevision`、`entryId`、`state`，完成时包含 `revision`。 |

provider 值是非空字符串或 null；subscription 值是完整记录对象或 null。null 是持久撤销值，并增加 revision。原导入回执只初始化尚不存在的槽，不覆盖后续替换或撤销。过期 expectedRevision 在写入前返回顶层 `revisionConflict` 错误，客户端不得重做远端 OAuth refresh。

写入先保存非秘密 acceptedPending 回执，再保存稳定 vault entry 并读回验证，最后原子提交槽版本和 completed 回执。恢复根据原 entry 与版本结算；系统存储锁定仍返回 `storageLocked`，不推断为缺失。明确缺失的 entry 可结算为 `blocked/storageWriteNotApplied`。操作回执不含秘密值或秘密的普通哈希。丢失响应只查询原 requestId。

每次激活已导入项目或已提交来源的新 GUI 项目时，Host 从该来源的当前 vault 获取固定 provider 引用。撤销会移除 Host 的旧缓存值，客户端提交的旧值不能覆盖 vault。缺失或歧义 GUI 来源返回错误，不回退到客户端旧值。普通 CLI 项目与非固定引用沿用既有按启动输入提供凭据的方式。GUI 设置与订阅消费者通过这些槽位读取和保存凭据。固定引用 `AREAL_CREDENTIAL_areal_openai` 取该来源 `subscriptionTransport` 的 token；其他环境凭据通过独立的 `project.ensure.credentials` 传入，不写进启动环境快照。撤销不会自动移除已注入运行中 Core 的凭据。

## 退出与服务管理器契约

`areal host run` 全生命周期持有 `host.lock`。并发竞争的输家在 macOS 退出 0，在 Linux 退出 73，systemd 配置 `RestartPreventExitStatus=73`。正常显式停止退出 0；异常失败退出非零并消耗有界重启预算。macOS 使用 `KeepAlive.SuccessfulExit=false`。持久显式停止意图禁止自动重启，新的显式本机启动可清除它。五分钟最多自动重启五次，退避 1、2、4、8、16 秒；用尽后持久化 `crashLoopStopped`。

Host 崩溃关闭它持有的生命期管道，既有 service-host、launcher、Core、Runtime 清理链仍是权威。后继等待清理证明与旧锁。上述保证仅适用于 Host-owned generation，不适用于 `legacyPending`。注销、关机与休眠不保证可达。安装包、launchd、systemd、真机验收均需独立证据。
