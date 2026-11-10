**中文** | [English](codex-plugins-p1-p3-acceptance.en.md)

# Codex 插件 P1/P3 验收记录

本轮补齐公开协议的 MRTR、用户文件/目录上传、便携认证，以及认证时机、App 订阅清理和 sparse marketplace。**源码评审通过；完整 P1/P3 与全部 Codex 协议验收仍开放。** 进程类失败、外部服务与分发证据不得由局部通过替代。

## 基线与候选

- Codex0.162.1：`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`；Agent Plugins1.0.0；OpenAI extensions：`0d606217705e0e71eb21fff009619b67b80611dc`，见 [pins](../../upstream/pins.json)。
- rmcp3.3.0；现代 MCP `2026-07-28`，直接旧连接 `2025-11-25`；Apps 使用官方 AppBridge。
- 本轮基础提交 `5e7def7737f3aeeab93aa4652b0a28d3ab11a216`，主要实现提交 `961c5ce827463b26b1066bcf55aff00960acb555`，分支 `codex/codex-plugins-p1-p3`；另补认证 scope 升级修复。没有 push、PR 或发布。
- 首轮原生/服务已验 Core SHA256：`2ee44d3fac1b82290263ff4fcd58452c297a6f28e30bb929cc403aae51f40b71`；最终 scope 修复候选：`cf4acd0aba51cb8e3c15b54fdde0a842421daecf632e17272f3d38524038cba3`，最终构建/MCP/Engine 与桌面认证复验绑定后者。忽略路径 `.scratch/codex-plugins/evidence/p1-p3-gap-final/manifest.json` 记录源码逐文件指纹、每次环境和原始结果；不包含浏览器档案或凭据 vault。

## 实现契约

| 能力 | 所有者与行为 |
|---|---|
| MRTR | `core/mcp` 现代 discovery/协商，工具调用和 resources/read 多轮续传；保持原参数、私有 requestState、逐轮 Core 权限/取消检查；UNKNOWN 不重放 |
| Legacy forms | 标准 simple elicitation 与 `openai/elicitation/create` 扩展保留；扩展资源 schema 不冒充标准 simple schema |
| 文件/目录选择 | Main 原生选择；Core 绑定表单/字段/调用者/世代；Runtime 逐级 NOFOLLOW 导入不可变副本；Renderer 只取得 opaque URI |
| 上传限额与寿命 | 单文件16 MiB、每逻辑调用256文件/64 MiB、目录深度16；取消、关闭、撤权和结算清理；相同 stage UUID/参数使用原收据 |
| 上传 UNKNOWN | 真正 UNKNOWN 只查询原 UUID；明确未发送或其他请求冲突可重新选择，绝不重发原未知 stage |
| 认证配置 | Main 系统安全存储 client secret/PEM/API key；Core 只持引用和 revision；摘要匹配且断开才能更改；瞬时 start/status/cancel 与持久 configure 分开 |
| OAuth | provided/public/confidential、DCR、CIMD preference；host metadata URL 缺失时 DCR 回退；声明的 endpoint/resource/OIDC/scopes，包括空 override，保留到 refresh；同绑定挑战升级与取消重试保留已授予权限，不把待授权 scope 当成 grant |
| 凭据方法 | client_secret_basic/post、private_key_jwt（RS256/ES256）、API-key bearer/basic/custom header；测试 RSA 是公开的一次性 fixture，未使用供应商私钥 |
| 认证挑战 | HTTP401/403 与工具 `_meta[mcp/www_authenticate]` 私有交接；按实际 RequestId/token 拒绝，不误删并发刷新 token，不重放 POST |
| 认证时机 | ON_INSTALL 安装后待认证，包含 mixed 门控；ON_USE 首次需要时提出需求，mixed 可匿名使用公开能力；安装/列表不启动 OAuth |
| App 订阅 | URI/世代/实例集合；首订阅、末退订，关闭不影响其他订阅者；关闭/通知串行，旧世代不投递 |
| Git sparse | Codex marketplace/add 的顶层 sparsePaths；Git cone 目录，更新保留；调用方包含目录与包路径，失败不扩大成 full checkout |
| GUI 恢复 | 同项目 Core 重连保留认证表单与原提交 ID，门控解除后只读刷新；切换项目重置，迟到返回不提交到新项目 |

同机 stdio 可读取被接受的文件副本。公开标准未定义本宿主可用的 HTTP 文件上传通道，远端选择返回 `RESOURCE_UPLOAD_UNSUPPORTED`，仍可选择服务器提供的资源；没有虚构 multipart/下载授权协议。旧 App 在 Core 重启后仍需重新打开。

## 最终证据

| 检查 | 实际结果 |
|---|---|
| workspace build | 通过 |
| package/source | 28通过；含 sparse 更新/重启/过滤/拒绝路径 |
| MCP | 最终候选40通过、0失败、2显式忽略；真实 GitHub 单独验收 |
| Engine | 最终候选32通过、0失败；原先3处 TaskControl test literal 编译缺字段已永久修复 |
| Runtime snapshot | 1通过，覆盖文件/目录、链接和预算边界 |
| Core CLI / Codex wire | 8 / 7通过；wire 包含实际 Git sparse snapshot 与无效输入拒绝 |
| 真实 GitHub MCP | 5通过；单次只读 get_me，经普通 Core 日志，无 GitHub 写入 |
| 原生 Electron/Core | 首轮 Apps8、扩展5、API-key认证6、legacy上传8、现代 MRTR上传9，共36项通过；scope 修复后最终 Core 的认证6项复验通过，各候选 SHA 分别记录 |
| GUI与文档 | typecheck、public verify、renderer build及中英文链接检查通过 |
| 独立源码评审 | 全量风险、GUI 恢复及最终 scope 升级复核均为 SHIP；只代表源码评审边界 |

原生文件选择和目录确认返回值由夹具脚本提供，真实 Main/Core/Runtime、沙箱页面、系统加密与 MCP 读取均执行；不代表物理 OS 选择器或签名安装包验收。现代上传路径实际经历两轮人工表单，最后确认之前服务器不读副本，原参数保持且每轮请求 ID 更新。

失败先保留再修复：上传明确拒绝卡 UNKNOWN、scope/challenge 交接、同 scope 被拒 token 恢复、GUI 重连丢失表单，以及 HTTP403 后丢失既有授权范围均有 RED/GREEN。最后一项以真实 HTTP 夹具验证 read → read write、取消重试、新绑定隔离和原 POST 不重放，8项便携认证检查通过。两处验收夹具错误也保留：内部 nullable 存储字段误作桌面请求；legacy 扩展资源 schema 误作标准 simple request。修正请求契约，没有放宽产品校验。

## GitHub 真实接入补充验收

独立工作树 `codex/plugins-acceptance` 从保留的 `ef0f8edf` 继续；主目录后续撤回插件集成的决定保持不变。固定槽位 `/Users/sailfish/CodeProject/AReaL-Harness/.local/dev-bin/plugins-acceptance` 的 Core SHA256 为 `7d046b1c31bf5d7eb01bd427432fd178b64ba33a6bcd5cf7cc3b5467fe0fbe4b`，部署回执 `/private/tmp/plugin-acceptance-deployment-candidate.json`，运行期间未替换。

`/private/tmp/areal-plugin-github-L8ywBV/manifest.json` 记录9项通过：安装无执行、原始 Connector ID 保留且先明确映射、真实远端初始化、普通 Core Turn 单次只读 `get_me`、断开撤销连接、重连产生新世代、禁用后撤销与拒绝重连、确认 Core 重启后凭据引用/映射恢复，以及确认清理与凭据不进入磁盘/模型的检查。既有 `gh` 凭据仅在内存读取和受控子进程环境传递；没有 GitHub 写入。模型是本地确定性夹具，GitHub HTTP 服务与工具调用是真实的。初始同源码基线5项通过保留在 `/private/tmp/areal-plugin-github-CidiVn/manifest.json`。

这关闭本宿主指定 GitHub Connector 的 bearer 凭据接入验收；不代表 GitHub OAuth 浏览器流程、其他托管 Connector、远程用户文件上传或完整 P1/P3 均通过。本轮标准 `make desktop-schemas` 已通过，历史失败不覆盖，详情及 hooks 的后续证据见 [P2 矩阵](codex-plugins-p2-acceptance.md)。固定路径的人工安全提示复用未取得用户观察，不能从功能成功推断；没有签名或防护设置变更。

## 历史失败与剩余边界

- 首轮 Engine 重启探针与 OAuth 跨进程 fixture 明确收到 SIGKILL9，stdout/stderr 为空；两个 proxy fixture 只有子进程失败/空输出，未记录 signal。scope 修复后的最终候选使用原构建环境和标准测试命令，四项均通过；旧失败和诊断保留，原因仍 UNKNOWN，不能将其归因于 scope 修复。
- 标准 `make desktop-schemas` 仍未通过：首轮 Core generator 命令 killed9/137；最终候选 Core schema 生成成功且与已提交结果一致，但 local-service generator 命令 killed9/137，其截断文件从原提交恢复。native-host 生成暴露既有 search 快照漂移，差异只保留在证据中；本任务未改变该契约。不能把局部生成成功写成 Make 通过。
- 失败诊断时所查测试/示例二进制签名校验正常；OS 记录只有 scan/provenance，没有可归因的 kill 决策。最终通过结果绑定新的源码与二进制，不覆盖旧失败记录。缺失 libLLVM.dylib 解释 rust-objcopy 的独立 SIGABRT 警告，不能据此解释 SIGKILL。原因 UNKNOWN，未证明 EDR、Gatekeeper、内存压力或源码回归；没有安全控制绕过。
- Legacy SSE 保留显式未支持，与固定 Codex 实现一致；不宣称全部 Agent Plugins transport。
- P2 hooks、私有 OpenAI catalog/sharing/注册服务、跨平台、真实供应商 OAuth与模型、物理选择器、原生 writable文件/CAS竞态及签名/公证分发未接受。GitHub通过不关闭这些要求。

## 重复执行

从仓库根使用同次构建的 Core/runtime 二进制及隔离 home/workspace。所有原生脚本串行；GitHub脚本只在内存读取既有授权凭据。

```sh
cargo build --locked --workspace
cargo test --locked -p areal-plugins --tests
cargo test --locked -p areal-mcp --tests
cargo test --locked -p areal-engine --test plugin_mcp_runtime --test plugin_mcp_subscriptions --test codex_plugins --test admission_guards
cargo test --locked -p areal-engine --test plugin_mcp_runtime connectors_resolve_from_marketplace
cargo test --locked -p areal-runtime-fs --test import
make desktop-schemas
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui run verify
pnpm --dir clients/gui build
node scripts/plugin-wire-smoke.mjs
node scripts/plugin-cli-p1-smoke.mjs
node clients/gui/scripts/plugin-p1-auth-smoke.mjs
node clients/gui/scripts/plugin-p3-uploads-smoke.mjs
AREAL_MCP_FORM_PROTOCOL=modern node clients/gui/scripts/plugin-p3-uploads-smoke.mjs
node clients/gui/scripts/plugin-p1-p3-smoke.mjs
node clients/gui/scripts/plugin-p3-extensions-smoke.mjs
python3 scripts/check-docs.py
```

这些命令包含仍未通过的 schema Make 检查；不承诺当前环境全绿。所有剩余契约与真实环境证据完成后，才能关闭完整兼容声明。
