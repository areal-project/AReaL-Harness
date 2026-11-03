**中文** | [English](host.en.md)

# 共享 Host 协议

本文包含已实现接口与后续目标契约。Host 提供认证后的项目管理、停止回执、订阅、旧服务迁移，以及 H2 的来源导入、旧秘密退役、提交 journal、固定凭据槽与 Remote 状态接口。`hello` 声明 `projects`、`stopOperations`、`subscriptions`、`legacyMigration`、`guiImport`、`submissionJournal`、`credentialVault` 和 `remoteState`，尚不提供 `updates`。普通 GUI 的项目连接、journal、凭据与 Remote 状态消费者使用 Host。完整退出语义、连接资源撤销、Remote 执行迁移和服务管理器交付仍在实施。协议定义不代表运行或安装包验收通过。另见[实施规格](../development/shared-host-spec.md)、[所有权决策](../adr/0016-shared-host.md)与[每项目服务契约](local-service.md)。

## 传输与认证

规范化服务 home 中只有一个 Host 独占 `host.lock`。H1 按 `AREAL_HARNESS_SERVICE_HOME`、`AREAL_HARNESS_HOME`、`~/.areal` 的顺序选择 home，权限为 0700。Host 描述包含 `version`、稳定 `hostId`、每次启动更新的 `generation`、`socketPath`、`authFile`、`pid` 和可执行版本。PID 仅供诊断，不作为发信号或接管依据。Unix 路径超长时沿用现有私有短路径 `control.sock` 派生规则。socket 与认证文件权限 0600，必须归相同 UID 所有，不得经不可信符号链接解析。

本机 Unix domain socket 使用逐行 UTF-8 JSON，每帧一个请求，最大 1 MiB。分发前校验 peer UID 与 Host UID 相同，并核对 `hello.params.authToken` 与当前认证文件秘密。认证失败关闭连接。token 不进入命令行参数、URL、日志、状态事件或 Remote 响应。认证前只接受 `hello`，重连重新握手。认证 token 随 Host generation 轮换。本契约授予可信本机用户访问权，不隔离该用户自己的进程。


正常停止在释放 `host.lock` 前移除本代运行描述 `host/host.json` 与 socket；稳定 `host/identity.json` 和原操作回执继续保留。

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
| `host.updateStatus` | `{}` | `{restartPending,targetVersion,prepareRequestId,operation:UpdateReceipt\|null}` | 无 | 只读当前准备记录与原升级回执；不重新提交排空或重启。 |

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

受控更新只识别当前安装器的版本目录与 Homebrew 同 formula、同 tap/channel 的已安装目标。安装器稳定入口或 `opt/<formula>/bin/areal` 必须已经指向目标，完整 manifest、平台、文件清单、摘要和实际版本均校验通过；开发构建布局返回 `updateUnavailable`。执行前再次校验目标字节，按保存的规范路径执行，避免入口改变后执行另一份文件。

准备登记写入中断后，只查询原准备 ID 补齐本地登记；存在另一个准备指针时，尚未完成的原请求结算为 `blocked`，历史 `prepared` 不回退。未派发停止的 apply 在原调用退出后按原 ID 结算为 `blocked`，不重新执行停止。新 Host 必须完成必要恢复并发布可连接描述符后，才将原 apply 结算为 `completed`。

`apply` 在排空前保存原升级回执、唯一 `stopRequestId` 及派发阶段。只有该原停止请求的 `completed` 证明、当前停止意图及目标身份全部匹配才进行同 PID 受控 exec，保留受管身份与崩溃预算；新 Host 按原请求结算。忙碌的 `ifIdle` 在停止受理前返回 `blocked`。GUI 当前提供 `ifIdle`。CLI 的 `cancel` 需要显式 `--confirm-cancel`，并先核对原 `prepared` 回执、目标版本及代际；不以旧失败的 apply 重放取消。GUI 将原升级请求身份写入现有控制引用；回复丢失后只按同 `hostId`、原 ID 与原代际核查，`null` 保持 UNKNOWN。登录开关读取真实安装状态；卸载先结算原停止，再以 `--stopped-only` 注销，遇到新启动的 Host 则拒绝。

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
| `remote.read`      | `{}`                                                                          | `{revision,sourceId,config,owner?}`。`owner` 为 `legacy` 或 `native`；包含秘密的配置只返回可信本机连接。 |
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

### Rust Gateway 交接

原生 Gateway 复用同一 Noise 身份、grants、Remote revision 与 Host journal。旧执行者先关闭入口、排空已接受的工作并释放租约，再提交交接；Host 在现有状态所有者中原子核对来源、revision 和无租约条件并保存原回执。持久交接后，`remote.acquire` 与通用 `remote.replace` 返回 `nativeGatewayOwned`；设置写入只经过原生 owner。原生入口启动失败时报告不可用，不恢复旧 JS 执行者。客户端以 `remoteGatewayV1` 能力决定是否使用原生 GUI 门面，不能按版本号推断。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `remote.gateway.handoff` | `{requestId,expectedGeneration,sourceId,expectedRevision,assetRoot?}` | 包含原 `hostId`、`generation`、`sourceId`、`revision` 的 `completed` 交接回执。 |
| `remote.gateway.status` | `{}` | 原生 owner 的连接与可用状态，不含秘密。 |
| `remote.gateway.state` | `{sourceId}` | 既有 GUI `RemoteStatus` 投影，不返回私钥、Relay capability 或 push token。 |
| `remote.gateway.subscribe` | `{sourceId}` | `{subscriptionId,generation,sequence:0,state:RemoteStatus}`；在同一认证连接上建立来源状态订阅。 |
| `remote.gateway.control` | `{requestId,expectedGeneration,sourceId,request,assetRoot?}` | 沿用本机 `RemoteRequest` 与响应形状；配对二维码由 GUI Main 生成。 |
| `remote.gateway.replace` | `{requestId,expectedGeneration,expectedRevision,sourceId,config}` | 沿用 `remote.replace` 的持久回执与 CAS 语义。 |

`remote.gateway.subscribe` 需要 `remoteGatewayV1`。初始快照与订阅在同一连接中建立，后续 `remote.gateway.stateChanged` 通知使用 `{version:1,method,params:{subscriptionId,generation,sequence,state}}`，只发送实际状态变化。客户端核对原订阅 ID、Host generation 和连续递增序号后替换投影；缺口或身份变化关闭原连接并重新读取快照。断连即撤销订阅，旧投影不能接收新连接的事件。配对请求和在线状态通过该通道更新 GUI，秘密不进入通知。

`assetRoot` 由可信本机 producer 提供，指向源码 Renderer 构建目录或安装包的 `areal-gui` 目录，不是手机请求字段或新增用户设置。Direct 只发布 `remote-assets.json` 描述且摘要匹配的 Remote 闭包，保留原 Host、Origin、CSP、worker 与缓存约束。来源的原 GUI 别名由 Migration 映射解析；其他 Host 项目使用稳定 Host 别名，不因另一个 profile 复用旧 ID 而扩大授权。

控制请求复用原 Remote 回执目录，以 `controlDigest` 绑定原设置请求。该值使用当前 Host generation 的既有认证 token 做 HMAC，按方法、来源与 requestId 分域，并绑定规范化请求字节；认证 key 只留在 Host 与已认证本机 Main 客户端，不返回 Renderer 或另建密钥存储。临时配对操作的回执标记 `ephemeral:true` 并绑定原 Host 身份，不保存邀请秘密；重启、消费或取消后的查询不重建邀请。GUI 持久保留未确认请求引用，只核查原 ID。`null` 不允许重放。Remote `interaction.respond` 的原生 `requestId` 是交互领域标识；其日志 UUID 不替换该 ID，也不产生独立的 `areal/request/read` 受理证明。回复不确定时保留 journal UNKNOWN，交互当前状态作为单独观察，不据此推定本命令受理。支持原生请求回执的其他提交方法仍按原 ID 核查。

`interaction.respond` 的允许操作须完成原内容审阅；其预检发现审批摘要变化或原目标不存在时返回 `TARGET_CHANGED`。问答须覆盖当前问题的全部且仅有的键，保留原选项与自由文本规则，每个答案最多 4096 UTF-8 字节。`deny` 可直接提交精确原 thread、Turn、交互 ID 与摘要，由 Core 原子核对目标、类型、状态、到期时间和摘要；它不依赖完整交互列表的读取预算。Core 明确拒绝与未收到结果分别保留 rejected 和 UNKNOWN，不据当前状态补造受理。

`session.create` 只创建普通 `ask` 会话。新会话沿用同项目保存的默认 Profile：外部部署使用保存的引用，managed 部署只选择保存目录中唯一且具有对应 base 的 `resources-` 派生版本，并核对同一 Core 目录已加载该不可变引用；缺失、歧义或尚未加载时拒绝，不生成资源或刷新目录。默认 Profile 引用 Workflow 时，保留 `UNSUPPORTED_PROFILE` 拒绝。请求将原手机命令绑定到 Core 的 `areal/thread/start`、原 `creationAdmission` 与创建受理回执；结果不确定时只核查该原请求。同一 peer 的两个连接重叠提交同一个 `commandId`，在最后一次前置异步读取后重新核对 journal，复用同一原操作。`interaction.respond` 同样在读取当前交互后核对原操作，副本不另行提交审批。

`project.models` 是仅需 `observe` 的只读方法，接受空 `params` 和仅含 `projectId` 的 `context`。返回 `{projectId,gatewayGeneration,grantRevision,serviceGeneration,models}`，最多 200 项、128 KiB；每项仅公开 `providerId,modelId,displayName,reasoningEffortOptions,available,unavailableReason`。普通模型来自当前 Core 已应用目录；ChatGPT 名称、模型与可用性来自同一 source 的 Host 订阅 owner。仅已认证且目录 `checking` 时，补入当前 Core 的 `lastAcceptedModel` 和本连接已经观察的当前会话配置；候选省略 `available`，不宣称可用。此集合不恢复旧 GUI 曾加载的全部会话或跨项目历史偏好。读取前后核对授权、Gateway/Core 代际、共享连接和订阅目录；离线返回 `CORE_UNAVAILABLE`，变化返回 `RESYNC_REQUIRED`。读取不启动项目、不创建会话、观察订阅或刷新模型目录；旧 Host 不声明该方法。

`session.send` 沿用 `{threadId,expectedConfigRevision,text,enqueue?,expectedTurnId?}`，使用当前项目、Gateway、grant 与 Core 代际的写入 `context`。文本非空且最多 64 KiB；可选字段显式 `null` 非法，省略 `enqueue` 与显式 `false` 的命令语义摘要不同。Host 先核对普通会话所有权、配置 revision、活动 Turn 与队列，再由 Core 的 `ordinarySession` 准入 guard 原子核对。直接发送只允许 idle 且无待处理队列；排队必须绑定确切的原活动 `expectedTurnId`。忙碌、目标变化与不支持的 Workflow profile 分别保留 `TURN_BUSY`、`TARGET_CHANGED`、`UNSUPPORTED_PROFILE` 语义。

`session.control` 支持 `configure`、`goalCreate/goalPause/goalResume/goalClear`、`queueUpdate/queueRemove/queueReorder/queuePause/queueResume/queueSteer` 和 `steer`，参数为 `{threadId,operation,expectedRevision,values}`，使用同样的写入 `context` 与 `submit` 授权。其中 `configure` 的 `values` 仅接受 `model`、仅含 `reasoningEffort` 的 `parameters`，及原 Remote 白名单 `options`。Host 核对普通会话、空闲轮次及预期配置 revision，并从同一 Core 的权威 `thread/inspect` 配置合并参数和选项，保留 Fast 等未改字段；Core 原子核对配置 revision。新命令摘要使用固定外层字段顺序与按键排序的 `values`，不依赖客户端 JSON 属性顺序；原操作写入现有 journal 后只派发一次。重复命令与 `command.read` 读取原结果，丢回复仅核查同存储、同 principal 与原 typed 摘要的 Core 回执。旧 JS configure 的原 `command.read` 保留原 semanticDigest；旧 pending 仅在已提交 source/migration/project/dataDir 与原 typed Core 回执一致时结算，不重新配置或补造派发绑定。手机恢复只查询原命令，不重新提交旧控制。目标控制除原生根会话条件外，还要求当前 Goal 来自同 Host、设备、项目的 accepted `goalCreate` 回执；观察投影与准入使用同一 journal 归属。队列编辑保留原队列 revision 和项目身份，拒绝改写有附件或已截断的排队正文；steer 绑定确切活动 Turn。Goal 与 queueSteer 使用原 typed Core 摘要，普通队列编辑使用去掉 requestId 的 management 摘要；旧 pending 同样只读相应原回执，保留 goalCreate 的 goalId/revision。`steer` 沿旧映射不添加原生 requestId，仅明确 Core 回答可结算；丢回复保持 UNKNOWN，原命令查询和副本都不再次追加输入。

| operation | values | expectedRevision |
| --- | --- | --- |
| configure | model?, parameters?, options? | 当前配置 revision |
| goalCreate | objective, inferLimits? | 当前 Goal revision |
| goalPause / goalResume / goalClear | goalId | 当前 Goal revision |
| queueUpdate | queueItemId, text | 当前队列 revision |
| queueRemove | queueItemId | 当前队列 revision |
| queueReorder | queueItemIds | 当前队列 revision |
| queuePause / queueResume | 空对象 | 当前队列 revision |
| queueSteer | queueItemId, expectedTurnId | 当前队列 revision |
| steer | text, expectedTurnId | 保留非负安全整数输入，Core 依据确切 Turn 判定 |


`review.read` 的历史文件 diff 仅使用同一已完成 Turn/Item 中已确认成功的 Runtime 原生文件结果，核对路径、完整 before/after 字节及 SHA-256 链。它在隔离临时目录生成 Git hunks；当前工作区后续编辑不参与重建，临时路径不进入响应。缺少完整历史或确认来源时返回 `diff.state:unavailable`，不使用当前磁盘内容补齐。

`review.read` 首页面包含最多 16 个原生媒体引用；`artifactRef` 是绑定原 Thread/Turn/Item、连接、grant、Gateway 和 Core scope 的认证不透明选择器。`artifact.read` 要求 `review` 及 `{artifactRef,offset,length}`，重新核对原媒体，只读取获权 Core blob，校验完整长度与 SHA-256，每次返回最多 48 KiB 的 base64 分片。图片最多 16 MiB，沿用静态 PNG/JPEG/GIF/WebP 的 raster 预算。不接受任意 URL 或文件路径，不启动项目；连接或授权变化使原引用失效。

`task.read` 只读取原 `{taskId,runId?}`，分别投影暂停可用性、当前 Run/revision 和 worker 结算状态，不证明命令受理。`task.pause` 要求 `pauseTask`、原 `{taskId,expectedRunId,expectedRevision}` 和正常写入 context；Core 原子核对该 Run 与版本，accepted 暂停回执不代表 worker 已清理。`task.question.read` 接受 `{taskId,runId,questionId}`，只读该 Task 和独立 Channel，不打开或替换前台会话观察；最多读取八页、每页 100 条、累计 4 MiB，完整题目最多八题、32 KiB。`task.question.reply` 要求 `answer`、同一目标与 `answers`：键和选项对应原问题，每个 UTF-8 答案非空且最多 4096 字节，问题仍待回复、未过期且 Run 未终结。暂停的 Task 仍可回复原问题；回复不恢复 Task 或新建 Run。

两种写入在派发一次 Core 请求前持久化原命令关联。暂停使用 typed `TaskControl`，回复使用 typed `ChannelReply`。结果不确定时，以原 requestId、不带 thread scope 读取原 Task 回执，核对 method、typed 摘要、principal、持久存储和 Task 目标。导入的旧 pending 另需已提交的 source/migration/project/dataDir 证明；保留原 Remote semanticDigest，不补造派发绑定。新回复的语义摘要按答案键排序。 旧回复重试遇到原 JSON 键序不同，须核对原 typed pending 参数或已验证的原 Task 回执/证明后才复用结果；本次重试无法核实时返回 UNKNOWN，已保存的 accepted 历史和原 semanticDigest 不变。原回执或来源无法确认时继续 UNKNOWN，不重派；确证同一命令 ID 对应不同内容时返回 `COMMAND_CONFLICT`。保存结果可离线 `command.read`；独立 `observedState` 仅描述当前 Task/问题状态，标注 `provesCommandAdmission:false`，不能从已回答或 worker 已结算推断本操作受理。

`turn.stop` 接受 `{threadId,expectedTurnId}` 与同样的写入 `context`，要求 `interrupt` 授权。Host 核对普通会话及确切活动 Turn，再由 Core 的 `turn/interrupt` 与 `ordinarySession` guard 原子核对原目标。命令先写入现有 journal；同 peer、同 `commandId` 的副本复用原操作。仅明确的 Core 回应确认 accepted 或 rejected；连接丢失继续 UNKNOWN，原 `command.read` 和重复命令都不再次停止。该 Core 方法没有独立受理回执，结果不暴露 `nativeRequestId`，不以 Turn 已结束推断本次停止已受理。项目离线仍可读取已保存的原结果；受理停止不代表 Runtime UNKNOWN 工具已经得到成功结算。

`session.send` 直接或排队发送时，Host journal 在派发前保存原 `operationId`、typed Core 请求摘要、来源项目/设备/手机 `commandId` 与 Core 存储绑定。同设备并发副本在最后一次前置异步读取后核对原关联，只派发一次；错误分支也以已存在的原关联为准。直接发送的受理结果保留原 `threadId`/`turnId`；排队结果保留原 `receipt.queueItemId`，不猜测将来的 Turn。`command.read` 在项目离线时仍能读取原日志；UNKNOWN 恢复只读原 `areal/request/read`，核对请求、方法、typed 摘要、目标与原存储身份。相同 serviceId、principal identity 与持久 journalEpoch 可跨 Core 代际查询原回执；存储不符、没有回执或证据不完整继续 UNKNOWN，不重新派发。同一会话还有未结算的非控制提交且无对应 outcome 时，即使 Core 当前 idle，新命令也返回 `SUBMISSION_UNKNOWN` 与 `submissionUnknown:true`；精确停止/交互控制按原关联识别，已结算 outcome 优先。原发送仍在等待回复时，只读查询可显示 `pending`；进程退出不将这项临时等待状态当作受理证明。

原生记录按原 typed 请求摘要和 Core 存储绑定恢复。旧 JS `session.send` 记录仅在 `nativeDigest` 与 `coreScope` 两字段都缺席时进入旧格式核查，显式 null、混合字段或校验失败不降级。Host 使用已提交来源的 sourceId、migrationId、manifest 摘要、canonical project/dataDir 与当前来源映射，核对同一认证 Core 的原请求回执，并在既有 journal CAS 保存单条 `legacyReceiptProof`。这同时适用于初次导入记录及导入后旧 JS 经 Host journal 写入的记录。旧 pending 必须有原 params/requestId、关联及 typed 摘要一致的受理回执，才转为 accepted；旧 accepted 保留原结果，仅在原 Turn 或 queueItem 与回执一致时添加观察证明，不补造原派发摘要或 coreScope。证明写入前重新核对完整原记录、来源与 Core 连接身份；缺回执、错误来源、摘要或结果冲突继续保留原 UNKNOWN 或 accepted 历史，不重新派发。

旧记录的完成观察在证明落盘前获取现有 CoreObservation 的快照、屏障和监听，落盘后转交现有完成队列。首份快照已经终结的历史结果不补发；首份快照仍进行中，随后完成则按原 Turn/queueItem 推送。来源或连接失效释放监听；证明失败不占用完成观察去重。该观察证明描述当前原回执核查所得的存储身份，不冒充旧 JS 派发时未保存的绑定，也不保证旧 owner 关闭到首个新观察之间的通知连续性。

`enable` 沿用原 Relay origin、一次性 `code` 与 `confirmed` 输入。非法 origin、无效 code 或缺少必要登记信息在受理前返回 `invalid-origin`、`invalid-code` 或 `enrollment-required`。Host 在唯一 HTTPS `/enroll` POST 前持久化原 `remote.gateway.control` 的 `outcomeUnknown` 回执，绑定来源、Host 身份、代际、原 revision 与 HMAC，不保存登记码。禁用客户端重试和重定向。可证明拒绝授权的 403/429 响应，以及发送阶段明确发生在 TLS 连接建立前的未知签发者、过期或域名不匹配证书错误，结算为原 `blocked` 回执。证书分类仅接受 typed TLS 校验原因，并返回不含凭据的 HTTPS 诊断；其他连接错误不据此认定未受理。断流、超时、异常状态或无法解析的成功响应保持 UNKNOWN。确定成功后，只有当前内存延续可以将同一原 ID 转入既有 Remote CAS/Vault 提交链；不从 UNKNOWN 查询触发另一次登记。GUI 仅按原 ID 核查已确认拒绝；未知结果保留原引用。

`remote.gateway.state` 在 Relay Host 被替换或服务声明的协议/传输预算不可用时，提供白名单诊断，要求用户显式重新启用。其他不可用原因使用通用说明，不回传原始网络错误。重新连接及 ready 状态清除该终态诊断；诊断不改变原重试和代际规则。

`device.push.register` 与 `device.push.unregister` 是无项目 `context` 的设备命令，仍需有效 `observe` 授权，并共用写入速率预算。登记参数为 `{platform:"apns",token,environment:"production"|"development"}`；token 为 64–200 位十六进制，保存为小写。注销参数为空对象。原 `commandId` 是 UUID；加密 Remote 配置中的 `pushCommands` 按设备保存原语义摘要与 `{registered}` 回执，同 ID 不同参数返回 `COMMAND_CONFLICT`，容量为 4096 条。token 更新不改变 grant revision。内部保存操作另按来源、设备与原命令 ID 关联；保存结果未知时返回 `submissionUnknown:true`，只查询原命令，不重新提交。无项目 `context` 的 `command.read({commandId})` 即使项目离线也可返回原设备回执；找不到时为 `notFound` 且 `submissionUnknown:true`。公开快照和错误不包含 token 或内部存储路径。

Relay 的实际 `Ready.push` 决定 `pushSupported` 与连接描述中的 `push` 能力。Host 使用既有 Core 连接扫描审批和问题提醒，完整分页及摘要就绪后建立基线；Core 连接代际改变时重新建立基线。在线设备的提醒被抑制且计入已观察集合，离线后不补发这些历史提醒。离线提醒经原 Relay 通道发送，并在实际出队前重新核对 grant、token、项目映射、Core 连接与 Gateway 代际；帧只含不透明定位 ID、类别、计数和合并 ID，不含正文。Relay 注销通知只移除当前仍匹配的 token，保留轮换后的新 token 和原命令回执。完成提醒绑定原 `session.send` 的受理结果：直接发送只观察原 Turn，排队只从原 queueItemId 的权威条目解析 Turn。新受理后的首份快照已终结时仍发送提醒；历史受理恢复的首份终态快照不补发。观察归现有 Host Core 连接，浏览器关闭不释放该观察；完成提醒只要求 `observe`，审批提醒仍要求 `answer`。终态为 completed 时发送 `turnCompleted`，failed、interrupted、cancelled 时发送 `turnFailed`，每条原命令只有一个固定合并 ID。

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

## 原生订阅来源 owner

`subscriptionOwnerV1` 提供按已发布 GUI 来源隔离的账号、OAuth、刷新与本机流式传输。Core 保留模型执行权威，GUI 只消费安全状态与登录 URL。`accountEpoch` 标识账户生存期，独立于 vault revision；普通 token 刷新或保存未激活的新账户不会取消当前账户的流。切换或注销撤销旧 epoch，迟到的刷新和回调不能恢复旧账户。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `subscription.read` | `{sourceId}` | 来源 owner、安全账户状态、目录、模型 catalog 与传输 endpoint，不含 OAuth 或 loopback Bearer token。 |
| `subscription.handoff` | `{requestId,expectedGeneration,sourceId,migrationId,expectedAccountRevision,expectedTransportRevision,network}` | 原交接操作回执。校验同一已提交且已退役来源、两个槽 revision 和原端口可绑定后才持久接管。 |
| `subscription.command` | `{requestId,expectedGeneration,sourceId,expectedAccountEpoch,action}` | 原命令回执；后台完成后按原 ID 查询。 |

`subscription.read.owner` 为 `legacy` 或 `nativeV1`，始终包含 `sourceId`、`generation`、`accountRevision` 与 `transportRevision`。原生状态另含 `accountEpoch`、既有账户状态、`accounts`、`catalog` 与 `endpoint`。`login` 中的 `{loginId,authUrl}` 供本机 UI 打开授权流程。`applied` 按 Host projectId 记录 `{accountEpoch,serviceId,generation,connectionId,providerRevision}`；来源已就绪不表示每个 Core 已应用成功。

action 为 `begin`（`target:{kind:"current"|"newAccount"|"saved",accountId?}`）、`cancel`（`loginId`）、`select`（`accountId`）、`logout`、`forget`、`refreshCatalog`（`force?`）、`probe`（`model`）或 `configureNetwork`（`network,expectedTransportRevision`）。新账号授权可在 Core 忙碌时保存为未激活账户，保留原流。切换与注销沿用每个原 Core 的实时空闲检查，不承诺跨 Core 原子预留。

`network` 为 `{proxies,extraCaPem,proxyUnavailable}`。`proxies` 仅接收 `HTTP_PROXY`、`http_proxy`、`HTTPS_PROXY`、`https_proxy`、`ALL_PROXY`、`all_proxy`、`NO_PROXY`、`no_proxy` 与 `AREAL_CHATGPT_SYSTEM_PROXY`。这些来源网络输入只保存在加密 transport 槽，不进入状态或普通操作日志。订阅意图同样使用当前 Host 认证 key 的分域 HMAC，操作文件不保存带代理密码等秘密的普通 SHA 摘要。OAuth 和模型目录有请求期限，推理 SSE 沿 Core、来源与账户 epoch 取消，没有覆盖整个推理的全局短时限。

交接前先排空旧来源的活动流、刷新与原槽写入。Host 复用原 token 和端口以保持已有 Core 的 transport 引用；新 Core 的保留凭据引用由 Host 从精确来源解析，GUI 不传回旧秘密。接管后通用 `vault.replace` 对该来源的账户与 transport 槽返回 `subscriptionOwnerRequired`，已受理的原回执仍先于 fence 返回。原生私有 CAS 继续使用原 vault revision、immutable entry 与请求 ID，不另建凭据账本。

交接和命令回执的 `method` 为 `subscription.handoff` 或 `subscription.command`，状态为 `acceptedPending`、`completed` 或 `blocked`，终态带 `result` 或 `error:{code,message}`。丢回复只查询原 `host.operation`；不重做 OAuth exchange、推理 POST 或不确定的 Core 提交。

重启恢复在原交接 marker 的请求 ID 匹配且来源恢复成功时确认交接完成。交接受理前持久关联 `migrationId`、原 transport CAS 请求 ID 与原端口 CAS 请求 ID。缺少 marker 时，Host 只有核验原 Vault 回执、精确槽 revision 和 immutable entry、旧来源退役及原端口绑定后，才继续同一原交接的本地步骤；端口最初为零时同时核验原端口写入链，不重做 OAuth exchange 或推理 POST。证据不全的旧记录继续保留未知及不可用的只读来源投影。

丢失后台任务的原命令以 `blocked/outcomeUnknown` 表示历史效果未知，保留原 `acceptedPending` 回执、身份与恢复证据；它不表示未执行。GUI 保留原请求并展示未知结果，连接与账号读取仍可用，当前状态不能证明旧动作的受理或效果。存在未知请求时不自动交接、配置网络或重发该来源命令。刷新重新查询原操作；已获证明的终态可以解除对应限制，当次只读取来源状态，不附带目录刷新、网络配置或旧动作提交。

## Host 休眠保护

`powerV1` 提供只读 `host.power({sourceId})`，返回 `{enabled,active,error}`。来源必须已提交。Host 读取该来源原 `core_home/library.json` 的 `settings.preventSleep`，默认启用；保存的 `false` 在 GUI 退出后继续生效。GUI 保存原 library 设置后读取此接口确认；不提交任务活动布尔值，也不创建第二份偏好。

Host 仅通过已存在的共享 Core 连接读取 `areal/server/status`。活动 Turn、Goal、上下文压缩或 `running` workgroup 需要保护；未来定时 Task、队列项与持久终端本身不算活动。已有服务的状态暂不可用时保留保护并报告诊断，读取不会启动或重新激活项目。来源偏好按既有项目绑定生效，未绑定 GUI 来源的 CLI 项目使用默认启用策略。

macOS 由 Host 持有 `caffeinate -i -w <HostPID>`，Linux 使用 `systemd-inhibit` 与随 Host 关闭的标准输入租约。没有受保护活动或来源关闭该选项时释放对应保护；正常 Host 停止关闭并等待 helper，Host 崩溃时通过进程或管道生命期释放。helper 不可用只更新保护诊断，不停止 Core 业务。GUI 的通知仍仅在 GUI 在线时通过 Main 显示；此接口不负责手机推送。

## 退出与服务管理器契约

`areal host install` 在没有活动 Host 时注册当前 home 的用户级服务；已有 Host 持锁时先拒绝，要求显式停止后再安装。服务名为 `org.areal.host.<home摘要前16位>`，macOS 描述位于用户 `Library/LaunchAgents`，Linux 位于用户配置目录的 `systemd/user`。描述固定可执行入口和两个 Host home 环境变量。安装器或 Homebrew 的稳定 `bin/areal` 符号链接保留为启动入口，不固化它当前指向的版本目录。安装回执保存描述路径及摘要；不覆盖或删除无法与原回执匹配的描述。

安装本身保留已有停止意图。普通 `areal host run` 检测到已安装服务时，在原锁内确认显式启动、清除崩溃预算，再请求原管理器任务启动；既有 CLI/GUI 的主动连接启动复用此入口。管理器使用 `areal host run --managed`，该入口及状态读取均不清除停止意图。`areal host uninstall` 先按原 Host 身份执行空闲停止；原停止未确认完成或锁未释放时保留服务登记。退注册只移除该安装回执覆盖的描述，不删除 home、身份或操作回执。

Host 离线时，`areal host status` 读取持久服务状态，标记 `live:false`。尚未结算的活动记录显示 `unavailable`，耗尽预算显示 `crashLoopStopped`；离线视图不证明旧进程或未知操作已完成。版本升级能力仍由 `updates` 单独协商。

`areal host run` 全生命周期持有 `host.lock`。并发竞争的输家在 macOS 退出 0，在 Linux 退出 73，systemd 配置 `RestartPreventExitStatus=73`。正常显式停止退出 0；异常失败退出非零并消耗有界重启预算。macOS 使用 `KeepAlive.SuccessfulExit=false`。持久显式停止意图禁止自动重启，新的显式本机启动可清除它。五分钟最多自动重启五次，退避 1、2、4、8、16 秒；用尽后持久化 `crashLoopStopped`。

Host 崩溃关闭它持有的生命期管道，既有 service-host、launcher、Core、Runtime 清理链仍是权威。后继等待清理证明与旧锁。上述保证仅适用于 Host-owned generation，不适用于 `legacyPending`。注销、关机与休眠不保证可达。安装包、launchd、systemd、真机验收均需独立证据。
