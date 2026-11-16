**中文** | [English](credential-history-independence.en.md)

# 凭据升级可靠性与历史读取独立性

状态：基础读取与执行准入分离已实现；签名实包的隔离 Keychain 覆盖验收已复现身份切换导致的访问失败。产品接受切换新版后重新配置一次 Key，之后保持签名身份和凭据命名空间稳定。

## 目标与决定

用户明确要求：供应商配置和密钥不存在，不能导致已经产生的消息无法读取；继续调查覆盖升级后凭据不可用，比较其他项目方案；错误交互提供原因和恢复入口。

建议采用：保留 Host 管理系统安全存储，修复升级身份与错误分类；在现有 Core 内拆开存储读取和执行准备，不新增历史副本、独立历史服务或客户端直读数据库。本提案不改变 Core Store 格式、迁移契约或数据目录，不实现凭据跨设备同步。供应商认证与客户端访问 Host 的认证不同：历史读取仍必须通过原有设备、项目和读取权限校验。

## 调查结论

### 报错意味着什么

`credentialsRequired: missing credential environment AREAL_CREDENTIAL_...` 来自 `core/host/src/launch.rs::prepare`。Host 从每项目保存的 `host/launch/<project digest>/inputs.json` 恢复启动参数，随后解析配置并检查凭据。缺失名称若不在当前模型配置的凭据集合里，就拒绝启动。`server.rs::ensure_inner` 对共享模型引用做追加，并将部分安全存储错误转成无凭据值。

由此可以静态确认一条失败路径：旧引用仍在启动列表 → 当前供应商目录已不包含它 → Host 没读到其值 → 旧引用被当作非模型启动依赖 → 服务无法启动，历史读取连带失败。仅凭截图不能确定用户是否命中了这条路径，也不能证明磁盘或钥匙串中的密钥已被删除。

### 覆盖升级为什么可能表现成密钥丢失

1. **访问身份变化。** `credential_io.rs` 通过当前 Core 可执行文件的子进程访问 macOS Keychain。实测旧包的 identifier 是 `areal`，新包是 `org.areal.harness.core`，团队相同。提交 `c5da41135b1e2e5a2aa5898e50f6b950953a7390` 显式改变了这个标识；不能再将这组旧包描述为“标识随构建哈希变化”。新版不满足旧版 designated requirement，读取旧条目返回 `errSecAuthFailed`（-25293），而新版新建条目可读。固定新标识不能自动继承旧条目的访问权限。
2. **命名空间变化。** Keychain service 是 `org.areal.host.v1.<canonical Host home digest>`；slot 还依赖 sourceId、reference 和 entryId。应用路径不直接进入该 service，但 Host home/Space、来源记录变化会使查询指向另一个位置。单纯替换应用、保持这些身份不变，不应使存储项消失。新 Space 的隔离本身是合理行为，不应自动跨 Space 查找密钥。
3. **旧存储导入未完成。** 旧 Electron safeStorage 密文经原 GUI 的解密入口导入 Host Vault，迁移回执、来源和 slot 必须对应。拒绝授权或导入中断需要呈现为待恢复，不能当作用户从未配置。
4. **错误信息被压缩。** `credential_io.rs` 将 item-not-found 映射成空值，其他 OSStatus 归为 `storageLocked`；`server.rs` 将 `storageLocked/storageMissing` 降为无值。工作台 `model-config.cjs::refreshCredentials` 为 locked/pending 保留状态，但 missing 没有同等明确的独立投影。最终启动错误无法说明是哪一种情况。

现有方向有合理基础：系统安全存储、Host 单所有者、版本化 slot、写入回读和操作回执均应保留。已确认的设计缺口是错误分类不足、历史与执行装配耦合，以及历史启动引用被当成当前必需依赖。尚未发现可据此认定“覆盖安装主动删除密钥”的证据。

### 签名包隔离覆盖验收

主验收从最终 ZIP 提取旧包 `a2337873` 和新包 `fbf7b732`，二者 GUI 版本均为 `0.1.19`。使用同一临时安装路径和 Host home，仅通过包内 Host 写入随机合成凭据；秘密不进入日志。系统 `HOME` 保持原值以定位登录钥匙串，AReaL 的配置、GUI、Host 和执行目录单独隔离。把系统 `HOME` 也改成临时目录会导致默认钥匙串不存在，该失败属于夹具前置条件，不能算升级故障。

| 检查 | 结果 |
| --- | --- |
| 旧包写入、非交互读取、重启再读 | 成功，值摘要一致 |
| `a2337873` → `fbf7b732`，`areal` → `org.areal.harness.core` | 旧条目读取返回 -25293 |
| 升级前后 Host/source/slot | Host ID、sourceId、entryId、revision 与旧 slot 文件摘要保持一致；迁移仍为 completed |
| 新版写入并读取新条目 | 成功，证明登录钥匙串并非整体不可用 |
| 新版满足旧 designated requirement | 不满足；旧版自身满足 |
| 同标识对照 `a2337873` → `ebeafdf4`，不同二进制、均为 `areal` | 覆盖后旧条目直接可读，revision 不变 |

这组实包已证实签名身份切换触发旧条目的 Keychain 授权失败，未发生条目删除或迁移记录丢失。尚不能仅凭原截图确定报障用户使用了同一组构建。两包严格签名及 stapler 票据校验通过；本机 Gatekeeper 评估返回 `Unnotarized Developer ID`，因此本验收不作为完整分发安装验收。交互读取未在当前桌面出现可操作授权窗口，并在客户端超时，不能承诺解锁按钮已经验证可恢复此情形。测试 Host 均通过停止协议清理，合成 Keychain 条目按精确 service/account 删除。

### 新版固定身份的专项验收

复用 `a2337873` 与 `ebeafdf4` 的两份不同 Core 二进制，在临时副本上用同一 Developer ID 和 `org.areal.harness.core` 重新签名，均带 hardened runtime 与 Apple 时间戳，严格签名验证通过。后版满足前版 designated requirement。通过真实 Host → Keychain 链路，在同一临时安装路径和隔离 Host home 下完成前版写入、前版重启、覆盖后读取、后版重启再读取；所有读取均为非交互，值摘要一致，revision 保持 1，原 slot 文件摘要与 sourceId 不变。后版另建条目也可读。

签名后的两份 Core SHA-256 分别为 `f8ac6b0f8da208046fbf97ac2b3898af7402ae91296c56b85bae3cbe34806064` 和 `32692b049a25e3e468540d2f9bec85e7eee33fd9a1a3b9bbeb7472bc2bf779a7`。四次测试 Host 均通过停止协议退出，两条合成 Keychain 条目按精确 service/account 删除并确认不存在。本专项验证新版签名身份下的凭据连续性；使用的是重新签名的 Core 副本，不代表当前源码、完整 GUI 安装包、公证或自动更新验收。

### 已接受的升级边界

切换到 `org.areal.harness.core` 后允许用户在供应商设置中重新配置一次 Key。后续发行保留该 identifier 和同一签名团队，不能回退为 `areal`、按构建生成新标识，或让开发构建接管发行 Host。普通覆盖升级保持当前 Host home/Space、sourceId、reference 和 slot；新 Space 属于显式隔离操作，不承诺继承其他 Space 的密钥。

后续签名包覆盖验收应在前版写入合成 Key，用后版在相同安装路径和数据身份下非交互读回并核对值摘要、revision 和原回执。应用版本、源码 revision 和二进制摘要变化不得改变凭据访问身份。确需变更团队、签名身份或数据命名空间时，应作为明确的迁移变更验收，不按普通覆盖升级放行。

### 原报障用户的版本关联

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

不切换 Keychain 后端，不改变现有 service 命名空间。保留每 Space 隔离和持久 source/slot 身份；应用版本、构建哈希不能参与身份选择。发布链保留当前固定 Core identifier。旧 `areal` 身份到新版的切换允许重新配置一次 Key；不为此新增自动读取旧身份或跨 Space 搜索秘密的机制。

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

已完成源码、签名变更和三个外部项目的静态调查。Host 不再以保存的凭据列表阻断项目启动；配置或部署不可用时，Core 按已登记的数据目录开放历史读取并关闭执行准入。共享界面保留草稿编辑，展示恢复入口；单个模型或凭据不可用时保留配置控制器，通过具体请求准入拒绝执行；配置修复复用原修订与热应用回执。只有部署未装配的基础读取服务沿原生命周期回执重建，不重放旧提交。部署失败保留原启动记录，凭据失败保留原 slot。

确定性测试覆盖配置损坏、旧凭据引用、迁移中的凭据、历史读取与发送拒绝、恢复配置及共享界面状态。签名实包覆盖与同身份对照的范围见上文；系统授权恢复、手机完整旅程和原报障用户的版本关联仍未完成。未读取真实密钥或修改真实 AReaL 数据。
