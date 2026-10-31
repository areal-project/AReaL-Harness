**中文** | [English](codex-plugins-plan.en.md)

# Codex 插件实施任务与验收

本计划按已确认方案实施纵切。P0 已有独立的本地验收证据。P1/P3 以 GitHub 为首个真实服务；当前继续实施 P2 hooks，并保留完整兼容的逐项要求。每个阶段只依据该阶段自己的证据验收。

## 基线与边界

固定 Codex 0.162.1（`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）、Agent Plugins 1.0.0 与 OpenAI MCP Extensions `0d606217705e0e71eb21fff009619b67b80611dc`。Core 拥有安装与选择状态，现有 Skill/MCP/Runtime 路径执行组件。私有服务接入仍需合法外部条件。

发现/安装不执行包代码；显式 Profile 不自动扩权；活动 Turn 不替换版本；UNKNOWN 不重放；Renderer 不取得秘密。现有独立 Skills/MCP 与 Native Host 保持原契约。

## 多格式导入演进

本节执行[多格式导入决策](../design/architecture.md#多格式插件导入决策)，不替代下方 P0 至 P3 的历史证据。每阶段独立验收，不将格式识别升级为完整宿主兼容。

| 阶段 | 范围与所有者 | 完成条件 |
|---|---|---|
| I1 · MCP 声明 | 收拢既有 Portable/legacy MCP 声明解释；包选择归 `core/plugins`，配置与连接归 `core/mcp`，Engine 组合运行状态 | 支持报告、预览与执行共享声明；两格式等价用例与原覆盖规则通过；无包执行或秘密泄露；静态 envelope 与运行时校验仍分开 |
| I2 · Commands | 将受支持的 Markdown 提示词、参数和命名空间接入普通提交路径 | 发现、显式调用及参数保留通过；未实现的模型、工具和 Hook 语义明确拒绝 |
| I3 · 用户配置 | 配置所有者持有值与秘密引用；导入器解释声明与替换位置 | 缺失值可诊断；敏感值只在获授权边界解析，不进入普通展示或模型字段 |
| I4 · 插件依赖 | 安装所有者维护版本、来源、缺失、循环及跨市场规则 | 审阅完整依赖计划，失败不产生部分有效激活；不把包依赖与 Skill 工具依赖混为一体 |
| I5 · Agents 与 Hooks | 复用 Profile 和既有 Hook 所有者，逐项映射模型、工具、事件与权限 | 父任务限制、独立信任、撤权、取消和恢复通过；不借格式兼容自动授权 |

I1 是行为保持的首个切片。先固定 Portable 与 legacy 的服务器发现、占位符、路径、headers、坏服务隔离及脱敏行为，再迁移消费者。保留 Claude 默认与显式定义的覆盖规则、来源位置，以及候选和已安装定义的区别。静态报告继续只检查 MCP envelope；认证、连接和真实供应商验收单独记录。

I1 不新增安装状态、缓存、连接重试、schema 兼容范围、用户配置或依赖执行。文档级错误、每服务失败与重复服务的原处理边界均保持。实现后运行包/配置集成检查、实际 Core/MCP 路径和公共文档检查，再按真实证据更新本节状态。

当前状态：I1 已实现，相关包、MCP 和 Engine 集成检查及固定产物 Core CLI/wire 验收通过。[导入集成用例](../../core/engine/tests/plugin_mcp_import.rs) 在实现前固定行为，并实际观察 stdio 参数、环境、工作目录和 HTTP 请求头。认证时机、CLI 与 wire 的旧验收夹具改用既有准入摘要契约，保留身份与认证断言。全仓 Rust 格式检查仍命中未修改文件的既有差异；本任务文件的定向格式检查通过。

使用同次构建、隔离 home/workspace 及真实二进制复验；对照不同源码树时分别使用独立的 `CARGO_TARGET_DIR`。

```sh
make build
cargo test --locked -p areal-plugins --test component_support --test ecosystem --test remote
cargo test --locked -p areal-mcp --test plugin --test substrate --test portable_auth
cargo test --locked -p areal-engine --test plugin_mcp_import --test plugin_mcp_runtime
AREAL_TEST_BIN_DIR=/absolute/same-build/bin node scripts/plugin-cli-p1-smoke.mjs
AREAL_TEST_BIN_DIR=/absolute/same-build/bin node scripts/plugin-wire-smoke.mjs
```

I2 支持固定安装快照内的受限 Markdown Commands，命名空间与参数沿普通 Message/Edit 提交和原回执处理。I3 支持 string、number、boolean 配置，敏感 string 只保存私有引用，并限定在 MCP env/header 消费。I5 的 Agents 子集复用真实 Profile 与父任务约束；未支持的模型、工具或权限语义明确诊断。I4 依赖与其它 I5 语义仍开放。详见[插件指南](../guides/plugins.md)。

离线 snapshot/doctor、GUI 状态投影和确认交互、开发链接新快照及独立 Skill 元信息刷新沿现有所有者实现。`ToolPolicy.lazyMcpSchemas` 是默认关闭的按需 schema 投影实验，保留发现、连接和执行预算。源码与确定性契约检查、桌面验收、真实模型效果和安装包证据分别记录；实现不代表所有性能目标或全生态兼容已经通过。

## P0 · 本地插件包与 Skills

| 任务 | 所有者/入口 | 工作 | 可观察验收标准 |
|---|---|---|---|
| P0-01 | `upstream/pins.json`、设计/任务文档 | 固定兼容基线、来源和能力声明 | 固定 Codex0.162.1 / Agent Plugins1.0.0；MCP/hooks/apps 的未支持项可见 |
| P0-02 | `core/plugins/src/package.rs` | 两种 manifest 与 overlay 解析 | 原包不改写；空内联 overlay 不与旧文件合并；未知 schema 不降级 |
| P0-03 | `core/plugins/src/lib.rs` | 本地 marketplace 发现和添加 | 固定路径优先级；条目错误隔离；根路径来源 . / ./ 有效 |
| P0-04 | `core/plugins` 安装 Store | 安装事务、摘要、CAS 与重启 | 绑定选中 source/digest；不执行脚本；缓存不可变；并发冲突可见 |
| P0-05 | `core/engine/src/desktop/{skills,catalog}.rs` | 插件 Skills 与资源读取 | 现有普通会话可选；显式 Profile 不扩权；同包资源可读，跨包拒绝 |
| P0-06 | Engine Turn/queue 与 Store | 调用策略、Turn 版本与停用 | 隐式禁止仍可显式选；活动版本固定；停用后新读取被拒绝 |
| P0-07 | Engine plugins 与现有提交账本 | 显式 onboarding 与受理恢复 | setup 使用普通聊天；双击/断连不重复；UNKNOWN 只查收据 |
| P0-08 | app-server、CLI plugins、GUI PluginsSettings | Core/CLI/GUI 管理与验收 | 同一安装状态；真实桌面安装→setup→停用；权限与重启路径有证据 |

P0 执行依赖：01 固定基线，02/03 建立格式与目录边界，04 完成安装事务，05/06 接入 Skills 与生命周期，07/08 完成 setup、客户端和组合验收。P1 使用 P0 的不可变包与状态所有者；P2 接入现有 Engine/Runtime 权限和事件；P3 在 MCP/认证/生命周期就绪后接入桌面与托管服务。

## 当前 P1/P3 批次

沿用现有 Core 所有者完成来源获取、包绑定 MCP 连接、认证、元信息/资源和桌面 Apps。GitHub 是首个真实远程服务验收目标；GitHub token 路径通过不代表 DCR 或 OpenAI 私有服务已通过。公开桌面扩展仍须逐 capability 验收，新增 forms 或 App handler 不代表 P2 已实现。

[P1/P3 验收记录](codex-plugins-p1-p3-acceptance.md)分别记录源码、集成、真实服务、原生桌面和分发证据。GitHub 首批交付已有集成及原生证据，完整阶段验收仍开放。

## P1 · 来源、MCP 与连接生命周期

| 任务 | 工作 | 可观察验收标准 |
|---|---|---|
| P1-01 | Git marketplace 与 source pin | ref 解析到 commit；子目录受限；失败保留旧安装 |
| P1-02 | npm source 与完整性 | 版本解析与 integrity 固定；不运行 lifecycle scripts |
| P1-03 | 便携和 legacy MCP adapter | env/cwd/header/transport 归一化符合各格式，保留诊断 |
| P1-04 | OAuth 与安全凭据 | provided/DCR/CIMD、refresh、取消/失败；秘密不进入 renderer/日志 |
| P1-05 | 认证和工具策略 | ON_INSTALL/ON_USE、enabled_tools 与审批状态区分 |
| P1-06 | 元信息、结果与版本目录 | instructions/structured/media 保留；活动 schema 不被替换 |
| P1-07 | 升级、撤权、排空和恢复 | 旧 generation 不污染新会话；清理未确认可见；UNKNOWN 不重放 |
| P1-08 | 真实 MCP 与跨实例验收 | 原包 stdio/HTTP；同时连接/升级/停用与服务重启 |

## P2 · 完整公开 hooks 执行语义

| 任务 | 工作 | 可观察验收标准 |
|---|---|---|
| P2-01 | 配置、信任摘要与平台 shell | 默认发现/覆盖、regex/alias、秒 timeout、Windows override |
| P2-02 | 全部 Session/Turn 生命周期布点 | 固定公开事件；多客户端 attach 不重复；顺序与归属明确 |
| P2-03 | 工具拦截和权限裁决 | deny/参数修改/approval/post反馈独立；不突破部署权限 |
| P2-04 | 后台 command 与 MCP handler | 安全点投影；不递归；结束取消；晚响应隔离 |
| P2-05 | 输出、错误与不支持语义 | exit2/JSON/stderr/未知字段按固定基线处理 |
| P2-06 | 对照、故障与恢复验收 | 相同自有插件在固定 Codex/AReaL 跑关键行为；不重放副作用 |

## P3 · 桌面扩展、Connector 与完整验收

| 任务 | 工作 | 可观察验收标准 |
|---|---|---|
| P3-01 | MCP Apps 资源与隔离宿主 | 保留 _meta；initialize/bridge/CSP 与窗口归属真实可验 |
| P3-02 | OpenAI 桌面扩展 | 固定清单的入口/设置/mentions/文件/上下文更新逐项验收 |
| P3-03 | Connector resolver 与合法服务接入 | 原 ID 保留；认证/无访问/未支持分开；指定服务真实连接 |
| P3-04 | Codex 实验管理 wire adapter | 固定 RPC 类型；共享 handlers；未支持 remote 服务不伪造 |
| P3-05 | 原包兼容语料、跨平台和分发 | 包/执行/UI/服务/安装包证据分开；源与版本绑定 |
| P3-06 | 最终兼容声明 | 所有必需 capability 及服务清单通过或明示条件；无静默缺项 |

## 验证与状态

实现前先定义实际边界的失败断言，优先集成与 E2E。源码检查、本地确定性模型、真实供应商、原生桌面和安装分发是独立证据。开发期间只跑受影响检查，收尾运行相关端到端验收。

已独立验收的历史状态：P0 源码实现与本地组合验收通过。48 项包/Engine 集成、真实 Core/CLI 权限与丢失响应恢复、GUI 类型/公开契约/构建、真实 Electron 安装/setup/停用/卸载和显式收据恢复均通过，独立评审为 SHIP。证据及未覆盖范围见[P0 验收记录](codex-plugins-p0-acceptance.md)。这不代表整个 Codex 插件协议已经兼容。

当前状态：公开 MRTR、原生 stdio 文件/目录上传、便携认证、ON_INSTALL/ON_USE、App 订阅清理与 sparse checkout 已实现。来源28项通过；最终候选 MCP40/Engine32通过，历史4项进程失败此次均通过且原因仍未知；这是 P1/P3 历史候选证据；当前 schema 的标准 Make 已通过，历史 SIGKILL 原因仍未知。CLI8/wire7/GitHub5和首轮原生36项通过，最终 Core 认证6项复验通过；HTTP403 权限升级/取消重试保留既有 grants 的修复有8项认证集成与独立 SHIP 复核。既有3处库测试编译缺字段已修复；跨平台、真实 OAuth、分发/私有服务证据仍开放。P1/P3与最终兼容尚未关闭，逐项见验收记录。

P3 验收前须明确桌面扩展集合、必须运行的服务/Connector 与支持平台。格式解析不会赋予托管服务权限，未解决要求必须保留在最终矩阵中。

当前 P2 候选已落地解析、独立信任、Core/Runtime 执行、生命周期、MCP 活跃时间与 GUI 审阅。已批准的有界 Runtime 写入组通过56项 Runtime 检查与21项默认实际 Core/Runtime 场景（另行同意的普通只读 command hooks）。限定子任务实现另有文件/网络/私有数据边界、过期/撤销信任与桌面独立同意流程验收。只读 MCP、自定义角色和平台/全部固定 Codex 对照仍开放；新出现的直接 Rust 子进程 SIGKILL 独立列为未通过。具体证据、失败和后续验收见 [P2 矩阵](codex-plugins-p2-acceptance.md)，不能据局部通过关闭最终兼容。
