**中文** | [English](one-protocol-spec.en.md)

# 一套协议与一份界面实施规格

状态为目标设计，尚未实施。决策见 [ADR 0017](../adr/0017-one-protocol-one-ui.md)，所有权沿用 [ADR 0016](../adr/0016-shared-host.md)，现有 Host 契约见 [Host API](../api/host.md) 与 [Remote API](../api/remote-control.md)。本文中的方法名、字段和命令都是提案，实现并通过验收前不能在其他文档写成已支持能力。

## 结论

所有客户端只连 Host，只讲一套协议。GUI、网页和手机运行同一份界面构建，桌面专属能力由 Electron 外壳单独提供。手机不再有按端写死的功能限制。Electron Main 中尚未改写的业务先迁入 Host 监督的 Node 工作台服务，协议统一和界面合一不等待 Rust 改写。

对照基线：AReaL-Harness `codex/shared-host` `7611582f`；T3 Code `8760d063`（`docs/internals/connection-runtime.md`、`docs/internals/remote.md`、`packages/contracts/src/rpc.ts`）。

## 已定决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 客户端入口 | 只有 Host；TUI 直连 Core 仅作开发与排障 | 一处认证、一份清单、一套实现 |
| 本机 GUI 与浏览器怎么连 | Host 直接监听 `127.0.0.1` WebSocket，不经 Electron Main 转发 | Electron 与浏览器连法相同，Main 才能瘦下来 |
| 协议基础 | 沿用 Host 封装和 Gateway 方法表扩展，不另起协议；schema 生成 Rust 与 TS 类型 | Gateway 已有清单、会话订阅与回执，已发布客户端在用 |
| 手机默认授权 | 查看、提交、审批默认给；管理在配对时单独勾选 | 手机不做特殊限制，危险操作仍需明确同意 |
| 未改写的 Main 业务 | 迁入 Host 监督的 Node 工作台服务，之后按领域改写 | 不让 2.7 万行 Rust 改写阻塞协议与界面 |
| 手机外壳 | 继续 Capacitor，套同一份界面 | 已复用 GUI 代码，不另写原生界面 |

## 交给 Codex 的方式

按 A0 → A4 顺序连续实施，不等待 H4 验收结束：从 `codex/shared-host` 开分支，H4 合入后并入。包与包之间不等待维护者审查；每个包形成独立的本地提交，在该包的完成条件全部满足后进入下一个包。提示词引用本文对应小节，以及下文"执行纪律"。

合并分两个 PR：

1. **集成 PR**：A0–A3 与 A4 第 1 项（共享界面）。新路径全部挂在开关后，开关默认关，装上后用户看到的行为与发布前一致。合并条件是 CI 全绿且不放宽任何门槛（行数上限、IPC 冻结、协议检查、渲染层边界）；不要求安装包验收。
2. **退役 PR**：A4 第 2–4 项，删除旧页面、旧 IPC 与开关，让 TUI/CLI 改连 Host。只在发版前验收（真实数据升级、旧配对升级、登录自启与重启、升级后身份不变、签名公证的安装包，以及 OP-01 至 OP-08）通过后开，删除前先问维护者。

- 推理强度全部用 high。A3 的工作台服务设计说明写入提交，可先实施；涉及"需要停下来问的情况"时停下。
- 仓库通用规则（分层、中英文文档配对、测试分层、PR 模板）以 AGENTS.md 为准，本文不重复。
- 工作包范围内、可回退的实现选择由 Codex 决定并在 PR 说明理由；只有"需要停下来问的情况"需要先问。

## 执行纪律

上一轮共享 Host 迁移暴露的问题，在本规格中写成硬性要求。

1. **进度按真实旅程汇报。** 先回答对应环境与数据副本能否完成本包旅程，再列单测与静态检查。共享业务以 Web 与真实 Host 服务为主要验收环境，只有 Electron 专属能力才启动桌面端；GUI 打包不作为常规功能测试前置。不能用协议测试代替页面交互，也不能用 Web 证据代替原生或发行包证据。
2. **先打通，再加厚。** 每个工作包先在对应环境用隔离数据跑通最短的端到端旅程（哪怕只有一个方法），确认接线到达 Host，再补完整实现与异常路径。存量兼容使用真实数据副本验证；A0 仅做一致性与冻结检查。发行资源、签名、升级在相应发行任务中单独验收。
3. **一次只收一个包。** 当前包的完成条件全部满足之前，不开下一个包。发现属于其他包或共享 Host 的问题，记入"已知问题"并在汇报中告知维护者，不顺手修。
4. **历史事实与当前切换分开。** 本规格不迁移任何存储，不改任何历史记录。切换数据路径一律放在开关后面，可回退到旧 IPC 路径；旧路径在切换期完整保留。某条历史命令的 UNKNOWN 只影响这条命令的展示与查询，不得阻塞项目可用、开关打开或工作包完成。
5. **卡住就停，带方案回来。** 同一阻塞连续两轮排查没有新证据，停止搜索。写出"已能证明什么、不能证明什么"的表，并给出两到三个由软件承担复杂度的方案交维护者选。不得以禁用项目、跳过测试、放宽断言或删除数据绕过。
6. **测试夹具有预算。** 优先复用现有夹具与 smoke 脚本。夹具自身的问题（进程退出等待、端口冲突模拟等）累计超过半天，停下汇报，不为夹具另写框架。
7. **兼容已发布客户端。** 已发布的 iOS 与 PWA 只认原方法表。改动现有方法的语义或限制，只能通过 `hello` 的能力协商对新客户端生效。

## 目标拓扑

```text
Electron 外壳 ─┐                    ┌─ 能力：窗口、通知、文件对话框、桌面工具登记
浏览器 ───────┼─ ws://127.0.0.1 ─┐  │
Capacitor ────┘(远程走 Noise)    │  └─ 能力：钥匙串、扫码、推送
TUI / CLI ───── Unix socket ─────┤
                                  ▼
             AReaL Host（同一组方法）
             ├ 入口：认证、授权、能力协商、资源上限
             ├ 路由：按 projectId 转 Core，按需唤醒
             ├ 读模型：跨项目清单与待处理
             ├ journal 与 command.read
             ├ 工具中转：外壳登记的桌面工具
             ├ 静态界面发布
             └ 工作台服务（Node 子进程，过渡期承载 Main 业务）
                                  ▼
             每项目：项目服务 → launcher → Core + Runtime
```

| 组件 | 拥有 | 不拥有 |
| --- | --- | --- |
| Host | 唯一协议入口、授权、路由、跨项目清单、journal、凭据、定时、工具中转、界面发布 | 会话历史权威、窗口与原生 UI |
| 工作台服务 | 过渡期内尚未改写的跨项目业务（Worktree、资料库、插件/MCP 管理、供应商等），只经 Host 对外 | 公共客户端入口、凭据持久化权威、进程监督 |
| Core | Thread、Turn、Task、审批、回执、单项目文件与 Git | 设备、授权、面对客户端 |
| `@areal/client` | 每个 Host 一个连接负责人、清单与会话订阅、命令状态、离线缓存 | 业务判断、自动重发未知命令 |
| `@areal/app` | 全部页面，按能力显示入口 | 直接访问 Electron、Capacitor 或文件系统 |
| Electron 外壳 | 原生 UI 能力；以工具提供者身份登记浏览器预览、Computer Use、截图、GUI 终端 | 项目、会话、任务、凭据等业务命令 |

## 全局约束

- 不改 Core Store 格式，不移动数据目录，不改监督链与清理证明，不改共享 Host 的迁移契约。
- UNKNOWN 不重放、受理回执优先、单写者全部保留。命令由客户端生成 `commandId`，重连不自动重放写操作。
- 同步为清单订阅加单会话订阅：先快照，再按序号增量；序号缺口即关闭并重读快照；离开会话后缓存与游标保留数分钟。禁止推全量投影。
- 连接健康与数据新鲜分开表示：连接就绪不等于清单或会话已是最新。
- 本机 WebSocket 只监听回环地址，以一次性票据换会话，校验 Origin；不把地址或端口写进构建产物。
- 凭据、token、票据不进命令行参数、URL 历史、日志或诊断。
- 依赖方向保持 Runtime → Core → Clients。Host 不依赖 GUI 代码；工作台服务不依赖 Electron。
- 不支持 Windows；不做远端 SSH 部署、多 OS 用户、云账号。

## 工作包 A0：ADR、协议 schema 与冻结

### 目标

固定一份协议定义，所有后续方法都从这里生成；冻结桌面 IPC。

### 现状

- Host 封装见 `core/host/src/wire.rs`（`{version,id,method,params}`，单帧 1 MiB）；本机方法见 [Host API](../api/host.md)。
- Gateway 方法在 `core/host/src/gateway/`，契约见 [Remote API](../api/remote-control.md)；快照上限 192 KiB（`projection.rs`），正文 64 KiB（`controls.rs`），不支持附件、仅普通 ask 会话。
- 桌面 IPC 合同在 `clients/gui/packages/workbench/client/desktop-contract.cjs`（48 个命令），Renderer 平台接口在 `clients/gui/renderer/src/services.ts`。
- 已有 schema：`schemas/areal-core-v1.json`、`schemas/native-host-v2.json`。

### 要做的

1. 新增 `schemas/areal-host-protocol-v1.json`，覆盖全部现有本机方法与 Gateway 方法，不改语义。两种现有封装分别如实记录：本机 `{version,id,method,params}`（`core/host/src/wire.rs`），Remote `{id,method,context,params,commandId}`（`core/host/src/gateway/session.rs`），包括两者对未知字段的严格拒绝。统一封装与 `hello` 扩展放在 schema 中单独标注的"提案"部分，A0 不宣称当前实现接受它们。
2. 生成 Rust 与 TS 类型，放在各自的 `generated/` 目录，暂不接入运行时；提供确定性生成与 `--check`。一致性测试复用真实 wire 实现与现有 Host/Relay 夹具，核对实际收发的消息、非法字段与资源边界。Host 与 `@areal/remote-client` 改用生成类型放到 A1 第一步，避免与 H3–H4 验收中的 Host 代码冲突。
3. 提案部分写明 `hello` 扩展：协议版本、方法列表、授权范围（observe/submit/approve/manage）、资源上限（单帧、分页、上传分块）、传输类型。
4. 去向表保留 48 个顶层命令为行；混合职责的命令按 operation 或参数细分。分类原则：原生交互（选择框、确认框、退出界面、登录窗口）留外壳，业务处理归 Host、工作台服务或 Core，组合操作拆开说明。Gateway 只部分覆盖的行为标为"已有方法部分覆盖"，不当作可直接替换的别名，不改旧语义。表格写入本文附录。
5. 冻结检查同时覆盖顶层命令名和业务 operation 集合（如 `manage` 下的操作），以 PR 基线为准只删不增，新增时 CI 失败。外壳原生 bridge 不在 A0 冻结范围内。

### 约束

- 已发布 iOS 与 PWA 的方法和字段不改名、不改限制。
- 只写文档、schema、生成脚本与检查，不改运行时行为。

### 需要停下来问的情况

- 现有 Gateway 方法与桌面命令语义冲突，必须改其一。
- 某个桌面命令无法归类到 Host、工作台服务、Core 或外壳之一。

### 完成条件

- schema 如实描述两种现有封装与全部现有方法，生成物 `--check` 通过，一致性测试通过，现有 Remote 测试不变通过。
- 48 个命令（含细分的 operation）的去向表完整，维护者确认。
- 注入一个新命令和一个新业务 operation 时 CI 均失败，附原始输出。
- PR 的目标分支已包含整合基线，diff 只有 A0 的改动；合并上游主干等整合工作单独进 `codex/shared-host`，不混进 A0 PR。

## 工作包 A1：本机 WebSocket、共享数据层与 GUI 读路径

### 目标

GUI 的项目清单与会话详情改从 Host 读；浏览器打开同一地址看到同样内容。

### 现状

- Renderer 经 `preload.cjs` 的 `requestProjection`/`onProjection` 接收 Main 拼好的全量投影（`packages/workbench/client/state-projection.cjs`），由 `renderer/src/desktop-services.ts` 读取。
- 远程网页用 `@areal/remote-client`（`RemoteConnection`、`acceptSessionMessage`、`SessionBodyReader`），只走 Noise。
- Electron 窗口加载 `areal-ui://app/`。

### 要做的

0. Host 与 `@areal/remote-client` 改用 A0 生成的类型，行为不变。
1. Host 新增回环 WebSocket 监听：随机端口、写入 Host 描述；一次性票据接口（本机 socket 认证后签发，短时有效，只能使用一次）；Origin 白名单为 `areal-ui://app` 与 Host 自身地址。
2. 新增 `shell.subscribe`：跨项目清单（项目、会话摘要、待处理数），快照加序号增量；打开清单不启动已停止的 Core。会话详情复用 `session.open`，按传输与授权放宽 192 KiB 上限为分页。
3. 以 `@areal/remote-client` 为底建 `@areal/client`：一个 Host 一个连接负责人（重连带抖动退避，前台与网络变化时探测），清单库与会话库，传输可选 WebSocket 或 Noise。
4. Renderer 的读路径在开关后切到 `@areal/client`；开关关闭时保持旧投影。Electron preload 只负责向 Main 取票据。
5. Host 发布与 Electron 同一份 Renderer 构建；`areal web` 打开它（只读即可）。

### 约束

- 不动任何写路径；写操作仍走旧 IPC。
- 开关默认关闭，维护者验收后再默认打开。

### 需要停下来问的情况

- 票据或 Origin 校验需要在构建中写死地址。
- 清单需要启动 Core 才能拿到摘要。

### 完成条件

- 真实安装包加真实数据副本：开关打开后 GUI 显示的项目、会话与旧路径一致（逐项对照记录），浏览器打开 Host 地址看到同样内容。
- 断网、Host 重启、Core 重启后清单与会话自动恢复，无重复条目；序号缺口触发重读。
- 打开清单不拉起任何已停止的 Core（以进程观察为证）。
- 开关关闭后行为与改动前一致。

## 工作包 A2：已覆盖的写操作切到 Host，去掉手机限制

### 目标

Gateway 已有的写操作，GUI 也走协议；删掉 Main 的重复实现；手机获得同等能力。

### 现状

Gateway 已有 `session.create`、`session.send`、`session.control`（配置、目标、队列、steer）、`turn.stop`、`interaction.respond`、`task.read`/`task.pause`/`task.question.*`、`command.read`。Main 中对应实现分布在 `backend.cjs`、`submission-recovery.cjs`、`history-observation.cjs` 等。

### 要做的

1. 按授权与资源上限放开：去掉"仅普通 ask""Workflow 拒绝""不支持附件"；附件改为分块上传方法，单块大小由 `hello` 告知。
2. 设备授权分四级，配对界面默认勾选查看、提交、审批；管理单独勾选。已配对设备保持原授权，不自动扩大。
3. GUI 的上述写操作切到协议（同一开关或子开关）。切换期的未结算提交按原 journal 与原 ID 核查，不重发。
4. 开关验收后删除 Main 中的重复实现与对应 IPC 命令。

### 约束

- 已发布客户端对旧限制的理解不变：放宽只对声明新能力的客户端生效。
- 历史 UNKNOWN 不阻塞本包完成；它们只在对应命令上显示为未知。

### 需要停下来问的情况

- 某个写操作在 Main 与 Gateway 的语义不同，无法合并而不改变用户可见行为。
- 去掉某项手机限制需要改变 Core 的准入规则。

### 完成条件

- 真实安装包：GUI 与手机分别完成新建、发送（含附件）、排队、停止、审批、回答、任务暂停；强杀 GUI 后在手机完成审批，副作用一次。
- 回复丢失时只查原 ID，不重发（复用现有恢复测试）。
- Main 中对应实现与 IPC 命令已删除，CI 拦截恢复。

## 工作包 A3：工作台服务与剩余领域

### 目标

Main 中其余业务迁入 Host 监督的 Node 工作台服务或 Core，经协议对所有客户端开放；桌面工具改为经 Host 中转。

### 现状

- Main 业务约 2.7 万行（`worktrees.cjs`、`task-catalog.cjs`、`schedule-admission.cjs`、`library.cjs`、`providers.cjs`、`management.cjs`、`mcp-apps.cjs` 等）。
- Host 已用同样方式监督本机 Relay 的 Node 子进程（`core/host/src/local_relay.rs`）。
- 桌面工具当前由 Main 直接发布给 Core。

### 要做的

1. 先写设计说明并提交：工作台服务的进程监督、与 Host 的私有通道、方法命名空间路由、如何取得 Core 连接、缺 Node 时的能力降级。
2. 先把现有 `CoreBackend` 与 `DesktopService` 整体交给 Host 监督，Main 走已有 attach 路径，原生能力留外壳；避免逐领域重建后台依赖。随后按资料库与 Worktree → 定时任务目录 → 轨迹与反馈（接凭据）→ manage 与供应商 → MCP 应用接通领域协议。Gen-UI 上下文和浏览器工具进入 Host 后再切发送、steer、新建；后续按需把单项目逻辑下沉 Core、跨项目逻辑改写进 Host。
3. 新增 `tool.provide`：Electron 外壳连上 Host 后登记桌面工具，Host 转给需要的 Core；断开即撤销并报告不可用。
4. 每迁完一个领域，删除 Main 中对应文件与 IPC 命令。

### 约束

- 公共客户端只连 Host；后台私有认证 attach 通道仅供外壳连接。工作台服务不依赖 Electron，系统加密经外壳或 Host vault 提供，解密值仅在运行内存使用，不持久化明文。
- 迁移代码以搬运为主，不在同一 PR 内重写逻辑。

### 需要停下来问的情况

- 某领域依赖只有 Electron 才有的 API 且无法移入外壳。
- 某领域在跨项目与单项目之间无法清楚划分。

### 完成条件

- 每个领域：共享业务在 Web 与真实 Host 服务上完成主要旅程及数据副本兼容验收，原生能力另在 Electron 验证，必要时补手机；对应旧实现验收后删除，Main 行数门禁通过。
- 手机发起的会话在 GUI 开着时能用浏览器预览，GUI 关闭后明确报告不可用。

## 工作包 A4：界面合一与退役

### 目标

只剩一份界面；客户端入口只剩 Host。

### 要做的

1. 网页、远程网页、手机都使用 `@areal/app` 同一份构建，靠响应式布局适配窄屏。
2. 退役 `clients/web`、`renderer/remote-web`、`renderer/src/remote/RemoteWorkbench.tsx` 与 `renderer/src/mobile/` 中的独立页面；Core 不再内嵌网页。
3. TUI 与 CLI 改连 Host 协议；直连 Core 只保留为显式的开发选项。
4. 删除旧 IPC 投影与开关；Main 只剩外壳代码。

### 需要停下来问的情况

- 已发布 iOS 版本依赖将被删除的页面或方法。

### 完成条件

- 集成 PR：共享界面在开关打开时可用，开关关闭时与发布前一致；CI 全绿。
- 退役 PR：仓库中只有一份界面构建；Electron Main 中不再有业务命令；真实安装包、浏览器与手机分别完成验收场景 OP-01 至 OP-08。

## 验收场景汇总

| 编号 | 场景 | 工作包 |
| --- | --- | --- |
| OP-01 | GUI 与浏览器打开同一 Host，看到相同项目与会话 | A1 |
| OP-02 | 打开清单不启动已停止的 Core | A1 |
| OP-03 | 断网、Host 重启、Core 重启后自动恢复，无重复，缺口重读 | A1 |
| OP-04 | 手机发送附件、使用 Workflow 配置的会话 | A2 |
| OP-05 | 强杀 GUI 后手机完成审批，副作用一次 | A2 |
| OP-06 | 回复丢失只查原 ID，不重发 | A2 |
| OP-07 | 手机会话在 GUI 开着时用桌面工具，关闭后报告不可用 | A3 |
| OP-08 | 已发布 iOS/PWA 在新 Host 上按原方法表工作 | A0–A4 |

## 不在本规格内

- 远端 Linux 部署、GUI 连远端 Host、多 OS 用户、云账号。
- 把工作台服务改写为 Rust 的完成时间；本规格只要求它经协议对外。
- 手机原生界面重写。


## 附录：A0 桌面命令去向

现有方法只提供部分覆盖，均不是直接替换。提案标识操作族，并非已实现方法。保留已发布 Gateway 的语义与限制。Host 路由至 Core，不增加并行 Runtime。仅外壳的原生交互不在冻结范围。依据 `clients/gui/packages/workbench/client/desktop-contract/transport.cjs`、`app/src/core/main.cjs`、`backend.cjs`、`workspace.cjs`、`plugin-archives.cjs` 和 `core/host/src/gateway/session.rs`。

| 命令 | 协议去向：现有部分覆盖 / 提案 | 目标所有者及拆分 |
| --- | --- | --- |
| `cloud` | 提案 `cloud.*` | Host 账户配置（`status`、`save`） |
| `cloudSession` | 提案 `cloudSession.*` | 工作台云会话（`open`、`create`、`reconnect`、`send`、`stop`）；Core 执行与历史 |
| `connect` | 现有 `project.ensure`（部分）; 提案 project subscription | Host 监督；Core 项目订阅 |
| `list` | 现有 `work.list`（部分）; 提案 session listing | Core 项目会话；工作台只聚合跨项目结果 |
| `open` | 现有 `session.open`（部分）; 提案 desktop subscription | Core 快照；Host 订阅传输；客户端投影 |
| `history` | 现有 `session.history`, `session.body`（部分）; 提案 history subscription | Core 历史负责 `acquire`、`loadOlder`、`loadItem`；Host 订阅和客户端投影/缓存负责 `retain`、`ensureAnchor`、`release` |
| `create` | 现有 `session.create`（部分）; 提案 desktop creation | Core 创建和回执 |
| `prepareCreator` | 提案 creator preparation | Core 项目准备 |
| `fork` | 提案 session fork | Core 分支和回执 |
| `side` | 现有 `session.create`, `session.send`（部分）; 提案 side-session operations | Core 的 `recover`、`context`、`list`、`start`、`send`、`create`、`close` 及回执 |
| `prediction` | 提案 session prediction | Core 上下文预测 |
| `send` | 现有 `session.send`（部分）; 提案 desktop submission | Core 提交和回执 |
| `editMessage` | 提案 session edit | Core 编辑和回执 |
| `continue` | 提案 session continuation | Core 继续执行和回执 |
| `stop` | 现有 `turn.stop`（部分）; 提案 desktop stop | Core 停止和回执 |
| `attachBrowser` | 提案 browser attachment | Core 执行绑定；外壳原生浏览器 |
| `respond` | 现有 `interaction.respond`（部分）; 提案 desktop response | Core 交互回复 |
| `reconcile` | 现有 `command.read`（部分）; 提案 desktop receipt query | Core 权威回执；不重放不确定提交 |
| `configure` | 现有 `session.control`（部分）; 提案 desktop configuration | Core 会话配置 |
| `queue` | 提案 session queue read | Core 队列 |
| `queueEdit` | 现有 `session.control`（部分）; 提案 desktop queue edits | Core 的 `update`、`remove`、`reorder`、`pause`、`resume`、`steer` |
| `library` | 提案 `library.*` | 工作台跨项目目录与偏好：`dropSidebar`、`renameProject`、`renameThread`、`pinThread`、`pinProject`、`createSection`、`renameSection`、`removeSection`、`orderSection`、`moveThread`、`moveProject`、`readThread`、`markAllRead`、`orderSidebarThread`、`hideProject`、`orderProject`、`orderThread`、`settings`；`computerControlEnabled`、`computerControlProvider`、`computerControlExecutable` 由外壳协调桌面工具 |
| `manage` | 现有 `session.control`, `task.read`, `task.pause`, `task.question.read`, `task.question.reply`, `artifact.read`（部分）; 提案 project management operations | Core 项目管理操作，包括插件、MCP、provider、进程、目标、计划、权限、执行、agent、工作流、工作组和任务。Host 拥有凭据。外壳负责 `pluginArchivePick`、解析 `pluginArchiveImport` 选择令牌、确认 `archive` 和原生浏览器/对话框。工作台只保留跨项目或过渡目录业务；`pluginInstall` 和导入仍是业务操作 Core 项目操作集合：`pluginComponents`、`pluginHooks`、`pluginMcp`、`mcpApps`、`genUiSource`、`mcpForms`、`mcpToolResult`、`plugins`、`plugin`、`providers`、`mcp`、`profile`、`skills`、`skill`、`inspect`、`context`、`inheritedHistory`、`plan`、`processes`、`process`、`processWait`、`goal`、`permissions`、`interactions`、`processOutput`、`executions`、`execution`、`executionTrace`、`executionTraceResult`、`executionArtifact`、`executionWait`、`agents`、`agentWait`、`workflows`、`server`、`workflow`、`workgroupPolicy`、`workgroups`、`workgroup`、`workgroupWait`、`workgroupArtifact`、`workgroupArtifactStatus`、`workgroupCapabilities`、`workgroupSubmission`、`pluginCapabilities`、`pluginReadiness`、`pluginSubmission`、`processSubmission`、`agentSubmission`、`mcpFormResourceSubmission`、`tasks`、`task`、`taskInbox`、`taskChannel`、`taskDraftHistory`、`taskDraftRead`、`taskSchedulePreview`、`taskScheduleContext`、`taskHistoryCapabilities`、`taskRuns`、`taskRun`、`taskWatch`、`taskUnwatch`、`pluginUserConfigSave`、`pluginDevelopmentLink`、`pluginDevelopmentUnlink`、`pluginArchiveImport`、`mcpFormResourceStage`、`pluginHooksConfigure`、`hookAcknowledge`、`marketplaceAdd`、`marketplaceAddGit`、`marketplaceRemove`、`marketplaceUpdate`、`pluginResolve`、`pluginAuthConfigure`、`pluginConnection`、`connectorConfigure`、`connectorCredential`、`pluginInstall`、`pluginConfigure`、`pluginComponentConfigure`、`pluginUninstall`、`pluginSetup`、`providerSave`、`providerRemove`、`mcpSave`、`mcpConnect`、`mcpDisconnect`、`archive`、`unarchive`、`processCloseStdin`、`processStart`、`processWrite`、`processResize`、`processTerminate`、`goalCreate`、`goalUpdate`、`goalPause`、`goalResume`、`goalClear`、`workgroupStart`、`workflowStart`、`workgroupRevise`、`agentSpawn`、`taskCreate`、`taskUpdate`、`taskRunNow`、`taskPause`、`taskResume`、`taskStopRun`、`taskResumeRun`、`taskCancel`、`taskDelete`、`taskReply`、`taskDraftSend`、`pluginCredentialsReload`、`pluginAuth`、`pluginAuthCredential`、`mcpAppOpen`、`mcpAppOpenFromResult`、`mcpAppRequest`、`mcpAppClose`、`mcpExtensionCall`、`mcpFormRespond`、`mcpFormPreview`、`mcpFormResourcePrepare`、`mcpFormResourceRelease`、`executionCancel`、`executionApply`、`serverDrain`、`serverGc`、`workgroupApplyArtifact`、`workgroupCancel`、`closeResources`、`planUpdate`、`toolAcknowledge`、`contextCompact`、`permissionsForget`、`providerProbe`、`taskDraftConfirm`、`taskDraftStart`。工作台拥有用户范围的 `pluginStoreSnapshot`、`pluginStoreDoctor`；项目范围由 Core 拥有。秘密字段、`pluginAuthCredential`、`connectorCredential` 经过 Host 凭据边界。外壳处理原生 MCP 视图/资源及 `pluginAuth` start 的外部浏览器。 |
| `workspace` | 现有 `review.read`, `artifact.read`（部分）; 提案 project files/Git and worktree operations | Core 的 `list`、`search`、`localDirectoryReference`、`read`、`save`、`review`、`reviewCommits`、`reviewBranches`、`turnReview`、`status`、`info`、`gitState`、`gitStage`、`gitUnstage`、`gitCommit`、`gitPush`；工作台跨项目 `worktreeList`、`worktreeSettings`、`worktreeOptions`、`worktreeEnvironmentSave`、`worktreeEnvironmentDelete`、`worktreeCancel`、`worktreeAction`、`worktreeDelete`、`worktreeCreate`、`worktreeRead`、`worktreeOpen`（登记工作区） |
| `media` | 提案 session media operations | Core 的 `list`、`read`、`upload`、`release` 及会话引用 |
| `steer` | 现有 `session.control`（部分）; 提案 desktop steer | Core 执行调整 |
| `dismissRecovery` | 提案 recovery dismissal | Core 项目恢复状态 |
| `providers` | 现有 `vault.read`, `vault.replace`（部分）; 提案 provider operations | Host 凭据负责 `revealKey`、`save`、`saveAndApply`、`remove`、`removeAndApply`；Core provider 配置及 `list`、`discover`、`probe`、`apply`、`default`、`defaultAndApply` |
| `chatgpt` | 现有 `vault.read`, `vault.replace`（部分）; 提案 account operations | Host 的 `status`、`login`、`forget`、`logout`、`selectAccount`、`cancel`、`probe`；外壳为 `login` 打开外部浏览器 |
| `analytics` | 提案 analytics operations | 工作台跨项目 `read`、`sync`；Core 项目用量 |
| `resources` | 提案 resource operations | Core 的 `hooks`、`builtinSkill`、`skills`、`mcp`、`skillRead`、`hooksSave`、`skillToggle`、`skillSave`、`mcpSave`、`mcpConnect`、`mcpDisconnect`；Host 凭据 |
| `projectless` | 现有 `project.ensure`（部分）; 提案 projectless operations | 工作台的 `catalog`、`directory`、`prepare`；Host 项目监督 |
| `tasks` | 现有 `task.read`（部分）; 提案 cross-project task operations | 工作台聚合 `list`、`inbox`、`preview`、`observe`；Core 项目任务权威 |
| `trajectory` | 提案 trajectory operations | 工作台的 `status`、`retry`、`setEnabled` |
| `feedback` | 提案 feedback operations | 工作台的 `status`、`read`、`preference`、`prepare`、`draft`、`refine`、`submit`、`close` |
| `serviceLifecycle` | 现有 `host.status`, `host.stop`, `host.updateStatus`, `host.update`（部分）; 提案 recovery | Host 的 `check`、`stop`、`recover`、`update`；外壳的 `quitInterface`、确认和通知；`stopAndQuit` 拆为 Host 停止和外壳退出 |
| `hostInstallation` | 提案 installation operations | Host 的 `status`、`install`、`uninstall`；外壳本机交互与停止协调 |
| `hostUpdate` | 现有 `host.updateStatus`, `host.update`（部分）; 提案 update preparation | Host 的 `status`、`check`、`prepare`、`apply` |
| `serviceStatus` | 现有 `host.status`（部分）; 提案 desktop status | Host 状态 |
| `stopService` | 现有 `host.stop`（部分）; 提案 desktop stop | Host 停止；外壳确认 |
| `recoverResources` | 提案 resource recovery | Host 恢复；外壳通知 |
| `browserData` | 仅外壳 | 外壳的 `status`、`importChrome`、`clearCache`、`clearAll` |
| `computerControl` | 仅外壳; 提案 configuration coordination | 外壳的 `status`、`requestAccess`、`openSettings`、`restart`、`stop`；工作台协调配置 |
| `bugReport` | 提案 bug report operations | 工作台的 `prepare`、`list`、`read`、`save`、`delete`、`export` 数据；外壳选择位置并保存导出 |
| `exportDiagnostics` | 提案 diagnostics export | 工作台诊断数据；外壳保存对话框 |
| `connectService` | 现有 `host.subscribe`, `host.status`（部分）; 提案 discovery | Host 服务发现和连接 |
| `export` | 现有 `session.history`, `session.body`（部分）; 提案 export | Core 历史和导出数据；外壳选择位置并保存 |
| `remoteControl` | 现有 `remote.read`, `remote.replace`, `remote.gateway.state`, `remote.gateway.status`, `remote.gateway.control`（部分）; 提案 pairing/configuration | Host 远程配置及配对 |

## Rust 收口验收边界

资料库、执行与连接、定时任务、Worktree 四组实现可以并行开发，完整集成后统一验收。先登记协议与递减预算，再迁移权威行为；执行迁移必须先列逐函数等价实现与差异处置。功能实现、编译、真实服务、页面旅程和 CLI-only 环境分别给出证据。旧路径删除单独确认，回退不能重放 UNKNOWN。所有权与开关见[工作台服务](../design/workbench-service.md#rust-领域实现与回退)。

统一验收覆盖原资料库回执逐字段一致、后台冒烟、`node clients/gui/scripts/seed-host-copy.mjs` 生成的真实数据副本旅程，以及无 GUI 环境的 CLI 定时任务和 Worktree 生命周期。未运行的平台保留待验收，不用单测替代。
