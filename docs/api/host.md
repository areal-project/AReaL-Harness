**中文** | [English](host.en.md)

# 共享 Host 协议

本文包含 H1 实现与后续目标契约。H1 提供认证后的项目管理、停止回执、订阅与旧服务迁移。`hello` 声明 `projects`、`stopOperations`、`subscriptions` 和 `legacyMigration`，尚不提供 `updates`。GUI 生命周期、密钥库迁移、Remote 接入与服务管理器交付属于后续工作。协议定义不代表运行或安装包验收通过。另见[实施规格](../development/shared-host-spec.md)、[所有权决策](../adr/0016-shared-host.md)与[每项目服务契约](local-service.md)。

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

`ProjectStatus` 包含 `registration`、`state`、可选 `service` 和 `migration`。状态为 `stopped`、`starting`、`ready`、`stopping`、`unavailable` 或 `legacyPending`。迁移记录包含原 `serviceId`、`generation`、存在时的 owner、来源 profile 与阶段。`legacyPending` 不制造 Host owner，也不签发声称受 Host 监督的描述。等待迁移时，客户端原有旧连接可以继续运行。

监督 owner 为 `{kind:"host",hostId,generation}`，标识持有 service-host 生命期管道的进程。它与 Remote Noise peer 身份、设备授权分别建模。H1 与 H2 保留 `{kind:"gui",appRunId,profile}` 的运行支持，直到 GUI 生命周期迁移完成；之后只保留旧身份识别。旧 GUI 不能接管新 Host-owned 服务。不能静默改变严格 service-v1 的旧客户端解码行为，必须协商 Host-aware 描述或返回能力错误。

`LaunchInputs` 必须包含绝对路径 `workspace`、`cwd`、`configHome` 与 `options:LocalArgs`，另有可选绝对路径 `homedir`、`configPath`、`deploymentPath`，非秘密字符串映射 `environment` 和 `credentialNames:string[]`。外层字段使用 camelCase；`options` 保留 `core/local-service/src/spec.rs` 中的 snake_case 字段，可选参数值允许 null。它包含模型选择、权限、沙箱与 Runtime 限额、工作区/数据/配置路径，以及 `read_only_path`、`task_credential_command`、`no_deployment_mcp`。CLI 参数使用连字符。CLI 连接后通过 Core 配置 run-scoped MCP；Host 启动输入携带相应凭据名，不携带 `mcpConfigPath`。Skill 根目录属于部署条目，不另设 `skillsPaths`。

客户端发送前解析路径与启动上下文。Host 启动前校验登记一致性、绝对路径、允许的环境名与配置。秘密通过认证连接中的独立字符串映射 `project.ensure.credentials` 传递；`credentialNames` 标识所需条目，也包括生成的 MCP 秘密引用。凭据值不进入 Debug 输出、日志、状态或持久操作参数。H1 将它们保存在当前 Host generation 的项目私有内存中；缺失必要值返回 `credentialsRequired`。密钥库持久化属于 H2。

发布 ready 前，Host 将部署 JSON 和引用的 Skill 树快照到 `<home>/host/launch/<project-id-digest>/`，保留嵌套资源和可执行位。重写后的路径保存在 `inputs.json`，部署与 Skill 路径包含内容摘要。Core 对同一 `id/revision` 保留显式部署的 Skill 根目录，自动发现及刷新不会覆盖该快照；不同 revision 继续按现有发现规则处理。CLI 随后可移除自己的临时部署目录。普通 TOML 保留原路径与既有配置监听行为，配置兼容性与安全重启规则继续生效。各子进程使用提交的 cwd 和环境，Host 不修改进程全局 cwd 或环境。`configHome` 保留调用端的配置、插件与 Hook 根目录，与 Host registry home 独立；Host 仅把 `AREAL_HARNESS_SERVICE_HOME` 指向自身 registry。

`noAutoRestart` 默认为 false。设为 true 时，ensure 不会自动重启已有但不兼容的服务；它仍是显式激活，可以启动已停止项目。自动重连只读取 `host.status`，配置变更需显式重新打开或重启。

`projects.register` 可在项目身份、工作区、数据目录和来源不变时更新 `defaultBinding`。普通登记只修改 Host 项目目录，允许登记忙碌的旧服务。`bindExisting` 默认为 false；兼容命令 `areal service bind` 设为 true，由 Host 核验停止状态与 Store 工作区归属，再提交旧工作区映射和默认登记。失败保留原操作回执。

## 方法参考

所有方法均可返回 `invalidRequest`、`unsupportedVersion`、`unsupportedCapability`、`unauthorized`、`internalError`。未知方法返回 `methodNotFound`。下表列出额外错误。缺少回执、断连和超时都不证明未受理。

| 方法 | 请求 params | result | 额外错误 | 幂等规则 |
| --- | --- | --- | --- | --- |
| `hello` | `protocolVersions:number[]`、`capabilities:string[]`、`authToken:string` | `{version,hostId,generation,capabilities,executableVersion}` | `versionMismatch` | 只读握手。重连后重做，不按可执行版本推断能力。 |
| `host.status` | `{}` | `{hostId,generation,state,projects:ProjectStatus[],restartPending,stopIntent,capabilities}` | 无 | 只读快照，不激活项目。 |
| `projects.list` | `{}` | `{projects:ProjectRegistration[]}` | 无 | 只读持久登记，包含已停止项目。 |
| `projects.register` | `{requestId,expectedGeneration,registration:ProjectRegistration,bindExisting?:boolean}` | `{registration,created:boolean}` | `projectConflict`、`dataDirConflict`、`defaultBindingConflict`、`migrationConflict` | 在 Host 锁下持久化键、规范参数与结果。同键同参数返回原结果，参数变化返回 `requestConflict`。仅本机。 |
| `project.ensure` | `{requestId,expectedGeneration,projectId,launchInputs?:LaunchInputs,credentials?:object,noAutoRestart?:boolean}` | `{project:ProjectStatus,service?:Service}` | `projectNotFound`、`configurationConflict`、`migrationBlocked`、`credentialsRequired` | 显式用户激活，可清除该项目已结算的停止意图。同键返回原受理或结果。同一绑定的并发 ensure 收敛到一个服务。只有核验后的 ready Host-owned 服务返回 `service`。`legacyPending` 只返回状态，不声称已接管。 |
| `project.stop` | `{requestId,expectedGeneration,projectId,serviceGeneration,strategy:"ifIdle"\|"cancel"}` | `StopReceipt` | `projectNotFound`、`generationMismatch`、`requestConflict` | drain 前持久化。重复键读取同一操作，不重复 drain。忙碌或结算未知用回执状态表达。 |
| `host.stop` | `{requestId,expectedGeneration,strategy:"ifIdle"\|"cancel"}` | `HostStopReceipt` | `requestConflict` | 分发前冻结目标代际并持久化逐项目子操作 ID。重复键返回原汇总，不存在全局事务。 |
| `host.operation` | `{requestId}` | `{operation:ProjectMutationReceipt\|StopReceipt\|HostStopReceipt\|UpdateReceipt\|null}` | 无 | 跨 Host 重启只读核查。`null` 是缺少证据，不授权重放。 |
| `host.subscribe` | `{}` | `{subscriptionId,generation,sequence:0,status:<host.status result>}` | 无 | 每次请求在当前连接建立观察，断连释放，不停止工作。 |
| `host.update` | `{requestId,expectedGeneration,action:"prepare"\|"apply",targetVersion,strategy?:"ifIdle"\|"cancel"}` | `UpdateReceipt` | `updateUnavailable`、`invalidUpdateTarget`、`requestConflict`、`generationMismatch` | `prepare` 登记已在本机安装且验证的目标。`apply` 必须携带 strategy，且目标与准备记录匹配，排空前持久化。回复丢失后只查询。不下载或执行客户端任意路径。 |

`host.status.state` 为 `running`、`stopping`、`stopped` 或 `crashLoopStopped`。`restartPending` 与 `stopIntent` 均为布尔值。能力是可加性的字符串，包括 `projects`、`stopOperations`、`subscriptions`、`updates`、`legacyMigration`，只声明已实现的契约。缺少 `updates` 的 Host 在副作用前拒绝 `host.update`。Host socket 关闭后，本机发现层通过 `areal host operation` 读取持久终态回执，不启动或恢复停止操作。

状态事件为 `{version:1,method:"host.statusChanged",params:{subscriptionId,generation,sequence,status}}`，不带 RPC `id`。sequence 在单订阅内严格递增，每个事件都包含完整快照。代际变化、序号缺口或断流后重新握手并订阅，不持久重放事件，不自动重试写操作。

自动重连只读取 `host.status` 中经验证的现存服务描述，不调用 `project.ensure`，不清除停止意图。需要重新激活时由用户显式打开项目。`ProjectMutationReceipt` 包含 `version:1`、`requestId`、`method:"projects.register"|"project.ensure"`、`hostId`、`generation`、`projectId`、`state`，以及可选 `result` 与 `error`。状态为 `acceptedPending`、`blocked`、`admissionUnknown` 或 `completed`。查询返回原操作结果；旧 ready 结果不证明该服务当前存活，连接前仍核验实时身份。回执不包含凭据值。

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

## 退出与服务管理器契约

`areal host run` 全生命周期持有 `host.lock`。并发竞争的输家在 macOS 退出 0，在 Linux 退出 73，systemd 配置 `RestartPreventExitStatus=73`。正常显式停止退出 0；异常失败退出非零并消耗有界重启预算。macOS 使用 `KeepAlive.SuccessfulExit=false`。持久显式停止意图禁止自动重启，新的显式本机启动可清除它。五分钟最多自动重启五次，退避 1、2、4、8、16 秒；用尽后持久化 `crashLoopStopped`。

Host 崩溃关闭它持有的生命期管道，既有 service-host、launcher、Core、Runtime 清理链仍是权威。后继等待清理证明与旧锁。上述保证仅适用于 Host-owned generation，不适用于 `legacyPending`。注销、关机与休眠不保证可达。安装包、launchd、systemd、真机验收均需独立证据。
