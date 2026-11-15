**中文** | [English](credential-history-independence.en.md)

# 凭据升级可靠性与历史读取独立性

状态：基础读取与执行准入分离已实现；覆盖升级的真实 Keychain 验收仍待完成。本文区分源码修复与尚未确认的用户安装包根因。

## 目标与决定

用户明确要求：供应商配置和密钥不存在，不能导致已经产生的消息无法读取；继续调查覆盖升级后凭据不可用，比较其他项目方案；错误交互提供原因和恢复入口。

建议采用：保留 Host 管理系统安全存储，修复升级身份与错误分类；在现有 Core 内拆开存储读取和执行准备，不新增历史副本、独立历史服务或客户端直读数据库。本提案不改变 Core Store 格式、迁移契约或数据目录，不实现凭据跨设备同步。供应商认证与客户端访问 Host 的认证不同：历史读取仍必须通过原有设备、项目和读取权限校验。

## 调查结论

### 报错意味着什么

`credentialsRequired: missing credential environment AREAL_CREDENTIAL_...` 来自 `core/host/src/launch.rs::prepare`。Host 从每项目保存的 `host/launch/<project digest>/inputs.json` 恢复启动参数，随后解析配置并检查凭据。缺失名称若不在当前模型配置的凭据集合里，就拒绝启动。`server.rs::ensure_inner` 对共享模型引用做追加，并将部分安全存储错误转成无凭据值。

由此可以静态确认一条失败路径：旧引用仍在启动列表 → 当前供应商目录已不包含它 → Host 没读到其值 → 旧引用被当作非模型启动依赖 → 服务无法启动，历史读取连带失败。仅凭截图不能确定用户是否命中了这条路径，也不能证明磁盘或钥匙串中的密钥已被删除。

### 覆盖升级为什么可能表现成密钥丢失

1. **访问身份变化。** `credential_io.rs` 通过当前 Core 可执行文件的子进程访问 macOS Keychain。旧签名脚本没有显式固定 Core identifier；提交 `c5da41135b1e2e5a2aa5898e50f6b950953a7390` 已改成 `org.areal.harness.core` 等稳定标识，并隔离开发 Host。旧构建衍生标识随二进制变化，是升级后访问授权变化的具体风险。它仍需升级前后实包的 designated requirement、TeamIdentifier、Identifier 和系统状态码确认，不能由修复提交反推该用户根因。固定新标识也不自动修复旧条目的授权。
2. **命名空间变化。** Keychain service 是 `org.areal.host.v1.<canonical Host home digest>`；slot 还依赖 sourceId、reference 和 entryId。应用路径不直接进入该 service，但 Host home/Space、来源记录变化会使查询指向另一个位置。单纯替换应用、保持这些身份不变，不应使存储项消失。新 Space 的隔离本身是合理行为，不应自动跨 Space 查找密钥。
3. **旧存储导入未完成。** 旧 Electron safeStorage 密文经原 GUI 的解密入口导入 Host Vault，迁移回执、来源和 slot 必须对应。拒绝授权或导入中断需要呈现为待恢复，不能当作用户从未配置。
4. **错误信息被压缩。** `credential_io.rs` 将 item-not-found 映射成空值，其他 OSStatus 归为 `storageLocked`；`server.rs` 将 `storageLocked/storageMissing` 降为无值。工作台 `model-config.cjs::refreshCredentials` 为 locked/pending 保留状态，但 missing 没有同等明确的独立投影。最终启动错误无法说明是哪一种情况。

现有方向有合理基础：系统安全存储、Host 单所有者、版本化 slot、写入回读和操作回执均应保留。已确认的设计缺口是错误分类不足、历史与执行装配耦合，以及历史启动引用被当成当前必需依赖。尚未发现可据此认定“覆盖安装主动删除密钥”的证据。

### 用户问题的下一步取证

先收集应用旧/新版本及安装渠道，保留出问题的两个安装包。仅采集脱敏元数据：Core 签名标识与 designated requirement、Host home 身份摘要、sourceId、reference、slot revision、entry 是否登记、OSStatus、迁移阶段及原回执。禁止输出秘密值、token、完整环境或未过滤配置。

在隔离 home 和合成密钥上执行真实旧包写入 → 覆盖新包 → 非交互读取。失败后显式授权一次交互读取，判断是否为访问权限变化；另测旧引用脱离配置、来源缺失和导入中断。不得通过自动重写、删除条目或重放未决操作掩盖原因。真实用户数据只读，用户解锁动作由明确交互发起。

## 外部项目对比

以下是固定源码快照的静态比较，不是运行验收，也不代表对项目整体安全性的评价。

| 项目 | 已查看的实现 | 本项目取舍 |
| --- | --- | --- |
| VS Code | `EncryptionMainService` 使用 Electron safeStorage；SecretStorage 把加密和持久存储分开并串行处理同 key；所查看版本的 `get` 捕获读取/解密异常后会删除对应加密记录 | 借鉴存储接口分层；不复制失败即删策略，不把秘密所有权迁回 Electron，因为无 GUI 的 Host 仍需运行 |
| Zed | 发布渠道使用 KeychainCredentialsProvider，开发渠道默认独立 development credentials；ThreadStore 的 load_thread 直接调用 ThreadsDatabase | 借鉴开发/发行隔离，以及历史加载不依赖凭据的模块边界；不照搬开发明文文件方案 |
| OpenCode | Credential 管理独立 credential ID、选择和更新；Session Store 的服务依赖 Database，凭据逻辑在另一模块 | 借鉴配置选择、凭据与持久会话的分离；该观察不证明整个 UI 路径都不依赖 provider，也不作为改变本项目秘密加密方式的依据 |

来源：

- [VS Code encryption](https://github.com/microsoft/vscode/blob/a389cd7c5195662c3e3998d4ba10604ff5cdaa70/src/vs/platform/encryption/electron-main/encryptionMainService.ts)、[secret storage](https://github.com/microsoft/vscode/blob/a389cd7c5195662c3e3998d4ba10604ff5cdaa70/src/vs/platform/secrets/common/secrets.ts)。
- [Zed credentials](https://github.com/zed-industries/zed/blob/703b5ac3f4ffe1e87a073123ae56e22f72f095c4/crates/zed_credentials_provider/src/zed_credentials_provider.rs)、[thread store](https://github.com/zed-industries/zed/blob/703b5ac3f4ffe1e87a073123ae56e22f72f095c4/crates/agent/src/thread_store.rs)。
- [OpenCode credentials](https://github.com/anomalyco/opencode/blob/38bd73789a43bf043599d6196af96583228035d7/packages/core/src/credential.ts)、[session store](https://github.com/anomalyco/opencode/blob/38bd73789a43bf043599d6196af96583228035d7/packages/core/src/session/store.ts)。

## 重新定义依赖边界

```text
客户端 → Host 身份/权限/项目路由 → Core Store、历史、回执读取
                                  └→ 执行准入 → 当前配置解析 → 凭据解析 → Runtime / Provider
```

历史读取只依赖项目和存储身份、访问授权、存储版本和读取资源限制。不能要求供应商存在、默认模型可解析、Keychain 可用、模型联网成功或 MCP/工具部署完整。`load_management_config` 目前仍验证配置结构，不能只增加“缺 Key 豁免”就声称达成目标。

保留同一个 Core 进程和单写者。基础启动先打开 Store、暴露历史/回执及配置诊断；执行装配单独形成 readiness。把目前混合配置中的存储定位和读取限制与执行字段分开解析：读取路径不解析供应商段，也不因供应商 TOML 无效而退出；存储定位使用已登记项目身份，读取限制使用固定安全默认值/独立受控参数，不以任意执行配置错误替换整份配置。配置损坏必须仍显示诊断，执行继续被阻止。

实际工程修改所有者：

- Host `launch.rs/server.rs`：项目基础启动不枚举/读取所有凭据，不快照执行部署；保存的 credential_names 不再作为历史服务准入条件。执行请求才按当前或已冻结配置求实际依赖。
- Core `server/config/engine`：拆开基础 Store 装配和执行准备；不能通过跳过错误伪装可执行。历史、回执、已有制品读取不创建模型客户端或加载插件。停止/取消已受理任务保持可用，不要求重新解析已删除的供应商。
- 工作台 `model-config.cjs`、历史观察和连接模块：目录读取、配置诊断、凭据状态分别可失败，历史入口只等待基础服务；移除依赖全局 provider 初始化的前置等待。
- 协议与客户端：复用既有 project 状态和错误 envelope，补充读能力与执行 readiness 的独立投影。具体字段由实施者按现有 schema 扩展，同时生成 Rust/TS，不能用“项目 unavailable”替代“执行暂不可用”。

已产生消息里的 model/provider ID 是历史事实，不是指向当前目录的强依赖。展示优先使用持久记录已有名称/ID；旧记录字段不足就显示已有 ID 或“原供应商已移除”，不回填猜测，不改写历史，不要求保留假供应商配置。制品自身不存在与模型配置不存在分别报告。

读取就绪不自动触发队列、Goal 或定时任务执行。新发送/继续/调度沿原执行准入检查依赖；已受理任务保留冻结配置及原身份，缺凭据就报告阻塞，不偷偷切换供应商。配置恢复后先核对原回执，再按现有恢复语义继续；UNKNOWN 不能换 requestId 自动重发。

## 凭据状态与升级策略

内部需要表达 available、notConfigured、missingEntry、interactionRequired、accessDenied、migrationPending、referenceUnresolved、storageError 等不同原因，复用已有错误码并按必要范围扩充结构化细节。OSStatus 分类由系统 API 的明确含义决定；未知错误保留为 storageError，不能猜测用户拒绝或条目丢失。客户端只接收状态、provider/reference 关联和允许的恢复动作，不接收秘密。

推荐本次不切换 Keychain 后端、不改变现有 service 命名空间。保留每 Space 隔离和持久 source/slot 身份；应用版本、构建哈希不能参与身份选择。发布链沿用已加入的固定 Core identifier，并验证新旧包的实际 designated requirement 可延续访问。若旧版本已使用不稳定身份，提供用户主动触发的系统授权入口；读取成功后恢复同一 slot，不自动删除或生成替代引用。

后台读取保持非交互；用户点击“解锁凭据”才允许系统授权。缺失条目时在正确 provider 下重新录入；引用失效时选择有效供应商，只改变后续执行配置。任何读取失败都不删除旧密文/slot，也不能把缓存空值保存为用户清空操作。迁移沿用原事务与回执；新增升级验收，不另造迁移机制。

## 用户交互

打开旧对话先展示消息。仅当当前执行配置确有问题时，在 Composer 附近提示“当前模型不可用，历史仍可查看”，并禁用相关发送操作；旧消息引用的供应商被删除，不必在可正常发送的会话里持续报警。详情保留诊断码，普通文案不暴露内部环境变量名。

| 状态 | 用户动作 |
| --- | --- |
| 需要系统授权 | 解锁凭据，交互读取成功后刷新 readiness |
| 当前 Key 未配置/条目缺失 | 前往对应供应商设置，重新保存 |
| 当前供应商已删除/引用失效 | 选择有效供应商或模型，保留历史 |
| 旧凭据导入待完成 | 查看导入状态并继续原操作 |
| 未知存储错误 | 查看脱敏诊断，提供支持信息 |

GUI、网页、手机共用 Host 的状态与历史能力；远程设备无凭据管理权限时显示“请在主机处理”，不索取或展示密钥。所有入口修复后只重试安全读取；继续执行遵循原操作回执。无需用户手工设置随机 AREAL_CREDENTIAL 名称、删除项目或清空数据。

## 验收与实施顺序

先完成可失败的隔离行为测试，再改对应共享边界：

1. 保存含多页消息和制品引用的会话，删除所有供应商配置与凭据；重启原项目，仍能分页读到完全相同的消息，联网模型调用数为零。
2. 模型配置语法损坏、默认模型删除、旧引用残留、Keychain locked/missing、插件执行凭据缺失时，历史和回执均可读；真实 Store 损坏或权限拒绝仍正确失败。
3. 有效供应商恢复后，显式新发送成功；无效配置发送明确拒绝。读取历史不启动定时任务，不重放未决提交，不改变正在运行任务的冻结配置。
4. 真实签名旧/新包的合成凭据覆盖升级：固定身份正常读取；旧身份不能静默读取时，经明确授权恢复；拒绝授权不删除凭据。主机无 GUI 时仍可读取历史。
5. GUI/网页/手机对应的共同旅程证明消息可见和权威读取结果；本机与远程权限、重新连接和取消路径保持一致。

实施顺序建议：先补安全诊断与升级证据；再解开基础启动/历史读取与执行配置；最后接状态投影和恢复入口。真实用户原因未确认不妨碍独立修复已证明的历史依赖缺陷，但不得将此修复宣称为解决所有升级丢 Key 问题。

## 本次证据范围

已完成源码、签名变更和三个外部项目的静态调查。Host 不再以保存的凭据列表阻断项目启动；配置或部署不可用时，Core 按已登记的数据目录开放历史读取并关闭执行准入。共享界面保留草稿编辑，展示恢复入口；配置恢复沿原生命周期回执重建服务，不重放旧提交。部署失败保留原启动记录，凭据失败保留原 slot。

确定性测试覆盖配置损坏、旧凭据引用、迁移中的凭据、历史读取与发送拒绝、恢复配置及共享界面状态。真实签名旧/新包覆盖升级、系统授权弹窗、手机与中继完整旅程仍需独立验收；源码测试不证明该用户的钥匙串条目已恢复。未读取真实密钥或修改真实数据。
