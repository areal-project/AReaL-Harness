**中文** | [English](environment-service-plan.en.md)

# 独立开发环境服务实施计划

状态：待实施。本文与[设计](../design/environment-service.md)共同定义交付顺序；阶段和验收项均未因文档落库而通过。当前协议继续生效，新方法、owner 和安装入口须随实现更新契约、类型与调用方。

## 1. 交付原则与依赖

按 E0 → E1 → E2 → E3 → E4 顺序推进。E1/E2 可在隔离源码环境验收，但只有 E4 通过后才可宣称正式安装包支持独立环境。E5 是按需求启动的后续扩展，不是首发前置条件。每阶段交付完整的最小纵切，不以增加一个服务入口或隐藏窗口代替真实路径。

| 阶段 | 可观察结果 | 当前状态 |
|---|---|---|
| E0：契约与现状刻画 | 可区分窗口关闭、GUI 退出、GUI 崩溃、后台退出；确定可迁移能力 | 待实施 |
| E1：独立 owner 与原地接管 | 后台不依赖 GUI 生存；同 home 不产生两个写者 | 待实施 |
| E2：登录服务与同会话接续 | 用户级服务真实启动，退出 GUI 后手机继续同一工作 | 待实施 |
| E3：手机独立发起开发 | 从未打开的已授权项目开始，完成代码修改、测试与 Review | 待实施 |
| E4：迁移、更新与发行验收 | 安装产物在登录、退出、重启、升级中保持身份和安全恢复 | 待实施 |
| E5：扩展开发操作 | 按需求补充 worktree/Git/文件/终端等明确能力 | 未纳入首发 |

实现保持 Runtime → Core → Clients 的依赖约束。只在已有所有者内增加必需的生命周期模式和 Remote 能力，不先搬迁 monorepo、不新建第二个业务数据库、不重写 Provider 执行体系。

## 2. E0：建立可验证的现状和契约

### 工作包

1. 沿 `main.cjs` → `service-client.cjs` → `service-main.cjs` → `local-service.cjs` → `core/local-service` 核对真实启动、正常退出和异常 EOF 路径。
2. 对照 ADR 0008、Remote 设计、架构说明与 `remote-gui-quit-e2e.mjs` 的预期，记录文档、测试和实际执行的差异。已有测试名或源码断言不算通过证据。
3. 盘点 GUI 退出后必须存活的工具宿主、Provider/订阅、代理、项目索引、Task 激活与通知，以及必须释放的窗口、WebContentsView 和 GUI shell。形成首发能力清单和不可用原因。
4. 在本地服务/桌面 API 定义运行模式、稳定归属与运行代际、停止抑制、转换回执、附着/启动权限；同步 Remote 能力协商的兼容策略。指定旧 GUI 遇到新 owner 的拒绝行为。

### 出口条件

四种退出操作有独立的过程证据，能定位谁持有哪个 lifetime 管道。确定 JS owner 和 Rust owner 必须一起修改的位置。对旧 GUI、旧后台、当前 GUI 的组合给出可附着、明确拒绝或需本机更新的结果。实现前不得把“独立进程”视为已满足独立生命周期。

## 3. E1：独立 owner 和单写者转换

### 工作包

| 责任边界 | 主要修改位置 | 交付内容 |
|---|---|---|
| GUI/后台 owner | `application-owner.cjs`、`core-process.cjs`、`core/local-service/src/gui_owner.rs` 及其协议类型 | 支持环境 owner；保留 GUI-owned 的 EOF 清理；后台继续监督受管执行 |
| 后台入口与发现 | `service-main.cjs`、`service-config.cjs`、`service-client.cjs` | 独立模式启动和认证附着，单实例锁，明确兼容拒绝 |
| 生命周期协调 | `service-control.cjs`、`lifecycle.cjs`、`local-service.cjs` | 转换意图/回执、停止抑制、代际核对、单写者交接 |
| GUI 退出 | `main.cjs` 与现有生命周期调用方 | 独立模式只断开客户端；显式停服仍经既有 drain |
| 恢复 | `submission-recovery.cjs`、`project-connections.cjs` | 迁移前后核对原请求，保持 UNKNOWN，不重放 |

未带目录的文件位于 `clients/gui/app/src/core/`。实施时沿调用链确定 Core 协议类型归属，不复制 owner 定义或由客户端另造 Core 状态。

先在隔离环境实现转换：旧 owner 排空并证明清理 → 同 home 启动新 owner → 发布就绪 → GUI 附着。该阶段允许通过测试管理入口启动后台，不以此宣称已完成 LaunchAgent 或安装包能力。转换不跨越活动执行强行接管；无明确取消授权时等待或拒绝。

### 出口条件

- 独立后台启动后，没有 GUI 也能通过真实 Core/Runtime 执行一个受限文件操作。
- GUI 正常退出和 GUI 被强制结束后，后台 PID/Core generation 不因 GUI 死亡变化；同一运行连接继续产出真实进度。
- 后台被结束时，受管资源按现有监督链结算；后继实例不能越过旧锁或清理未知。
- 并发启动 GUI 与独立后台只产生一个写者；错误 home、owner 和部署被拒绝。
- 原模式正常退出/异常退出继续遵守原契约；回执丢失和转换中断不会重派发执行。

## 4. E2：用户级服务与 GUI 退出后的手机接续

### 工作包

1. 复用 `desktop-executables.cjs` 的后台应用定位，增加 macOS 用户级安装、状态、启动、停止与卸载注册的受控入口。入口命名由实现确定，不在文档中提供未实现命令。
2. 固定规范 home、应用位置、配置与工具环境；不依赖 GUI 的临时环境变量或交互 shell。注册失败保持可诊断错误，不退化为无人管理的 detached 进程。
3. 持久区分用户停止、异常退出和更新排空。验证 OS 保活不会抵消显式停止，重复失败不会无限启动。
4. 验证真实后台中的凭据解密、模型认证/刷新、订阅转发、代理和 Runtime 工具宿主。补齐 capability 不可用投影，保持本机交互权限要求。
5. 用现有 Relay/Noise/Gateway 完成手机路径；GUI 仅管理配对、授权、服务状态和本机故障处理。Remote 撤销及原连接预算继续生效。
6. 让既有 schedule owner 在独立后台承担激活；核对显式项目停止、后台停服和升级期间均抑制激活。Core 继续决定触发与恢复。

### 出口条件

从真实用户级服务启动，不先打开 GUI，手机可连接已授权且可用的项目。GUI 发起任务并停在审批处，退出 GUI 后手机完成同一审批，原 Turn 继续且副作用只发生一次；GUI 重开后显示同一 Thread/Turn 和结果。再覆盖原模型请求未结束时 GUI 退出，证明不是重新创建任务模拟“继续”。

显式停止环境能够停止服务且不会被 OS 自动拉起；显式再启动后恢复同一 Host 身份。锁屏、唤醒、凭据不可用和 Relay 中断分别给出真实状态。调度不得因手机刷新重复激活，也不能由 GUI 退出改变已启用安排。

## 5. E3：手机独立发起开发任务

### 工作包

1. 扩展项目投影，区分环境可达、项目未启动、启动中、可用、配置/凭据受阻、不兼容与清理待核对。
2. 为已登记项目提供显式启动动作和单独授权；旧设备 grants 默认不获得新能力。方法 schema、上下文、回执及类型同步写入 Remote API。
3. 在后台已有生命周期所有者中关联启动 commandId，调用公共 `ensure --no-auto-restart`，在 ready 前校验认证身份和能力。不接受任意路径、不启动未授权项目、不隐式更新。
4. 手机通过现有会话/模型/队列/Goal/审批/停止能力完成开发；能力缺失或冲突明确呈现，不使用桌面私有 RPC 绕过限制。
5. 补齐 Diff、必要文件上下文和测试输出的可读闭环。先用普通消息要求进一步修改或 Git 提交；专用 Git mutation UI 留给 E5。

### 出口条件

GUI 未运行、目标项目未启动时，手机显式启动已授权项目，新建会话，在隔离真实仓库中修改代码并运行项目测试，查看 Diff 和测试证据，再继续同一会话。未授权或已显式停止而未获重新启动授权的项目拒绝操作。

项目启动响应丢失只能核对同一操作。配置不兼容时不能自动杀旧 Core。手机和桌面同时发送、改配置、审批或停止时，由 Core 返回合法受理/冲突，停止不波及后来轮次。另一项目仍可使用，证明单项目失败不会拖垮环境。

## 6. E4：迁移、升级与安装包验收

### 工作包

1. 在既有生命周期入口中完成可恢复的启用/停用转换，保留项目、worktree、会话、密文凭据、Host pin、grants、pending/outcomes 和原始回执。
2. 在停止前、旧后台退出后、新后台启动前后及完成回执返回前注入中断；恢复只查询原转换，严格遵守单写者和兼容规则。
3. 把后台纳入应用更新协调。排空并证明退出后再替换主包，核对注册路径、签名、部署身份和新握手；活跃任务默认阻止破坏性升级。
4. 明确降级边界；新格式不可被旧版本读取时拒绝回退，不还原旧备份覆盖新历史。停用登录服务保留数据，卸载与撤销设备由独立操作控制。
5. 更新安装/使用/Remote/测试文档和对应 ADR 状态；只将已实现且有证据的能力写入功能清单。

### 出口条件

使用 Developer ID 签名且完成公证、staple 与 Gatekeeper 校验的 app 和 DMG，验证安装后登录启动、GUI 退出/重开、显式停服、真实手机经 Relay 发起任务，以及应用更新后的同身份附着。开发启动测试不能代替固定安装位置、钥匙串访问或 LaunchAgent 生存能力。

每项产物记录实际测试版本、系统、设备、网络、模型和结果；公网/真实供应商/真机/安装包未执行时分别保留未验证状态。构建与验收不包含自动发布或 push 授权。

## 7. E5：按需求扩展开发能力

后续可按用户路径分别增加 worktree 创建、结构化 Git 操作、文件查看/编辑、交互终端和浏览器接管。每项先定义资源所有者、授权、审阅版本、命令回执、断线语义与实际需求，再复用已有模块。终端和浏览器控制权是资源级协议，不推广成普通会话全局锁。

SSH/WSL/Docker 远端环境、跨环境委派和云端发现需要独立设计，不随本计划扩张。环境身份与连接线路的分离为它们保留边界，不预先交付通用 Transport 框架。

## 8. 验收矩阵与证据

| 编号 | 最小场景 | 独立断言 | 阶段 |
|---|---|---|---|
| ENV-01 | 无 GUI 的受管后台执行 | 真实 Core/Runtime 操作与退出清理可确认 | E1/E2 |
| ENV-02 | GUI 退出和崩溃 | 原 Turn/模型连接继续，后台不随 GUI 退出 | E1/E2 |
| ENV-03 | 手机审批后 GUI 重开 | 同一 Thread/Turn，审批和副作用各一次 | E2 |
| ENV-04 | 两个启动者及转换中断 | 同 home 单写者；无锁释放/清理证明不替代 | E1/E4 |
| ENV-05 | 后台崩溃或 Core 崩溃 | 正确故障域；保留 UNKNOWN，不重放工具 | E1/E4 |
| ENV-06 | 登录、锁屏、休眠/唤醒 | 状态真实；不把离线表示为执行失败 | E2/E4 |
| ENV-07 | 用户停服与更新排空 | 不被 OS、GUI、手机重连或调度自动拉起 | E2/E4 |
| ENV-08 | Relay 断线与慢客户端 | 任务继续；快照恢复；另一客户端可前进 | E2/E3 |
| ENV-09 | 写入/启动回执丢失 | 查询原请求；不重发，不以空回执清除 UNKNOWN | E1/E3 |
| ENV-10 | 跨端配置/发送/审批/停止竞争 | Core 准入/revision/确切 Turn 保证成立 | E3 |
| ENV-11 | 撤权及未授权项目启动 | 新操作和内容立即受限；无自动权限提升 | E2/E3 |
| ENV-12 | 凭据、工具环境或单项目失败 | 无 secret 泄露；故障归因准确；其他项目独立 | E2/E3 |
| ENV-13 | 已登记离线项目完整开发 | 手机启动、改代码、跑测试、Review、桌面接续 | E3 |
| ENV-14 | 签名安装包升级/停用/重开 | 身份、数据和回执保留；注册路径有效 | E4 |
| ENV-15 | GUI 退出后的调度 | Core 独占触发；项目停止抑制和恢复规则有效 | E2/E4 |

断言来自上述目标，不通过共用实现推导“正确答案”。计数工具副作用、检查实际 Thread/Turn、模型请求与子进程/清理回执，不能只观察 UI 文案或缓存。故障注入只在隔离 home/workspace/Relay 内执行，保留失败、UNKNOWN、重试和清理未确认记录。

### 复用现有测试入口

以下命令从仓库根运行，是可扩展的现有入口，不表示已覆盖新 owner 或 LaunchAgent。执行前遵循[测试指南](testing.md)及本机固定产物路径要求；正式包遵循发行与签名流程。

| 范围 | 现有入口 |
|---|---|
| 类型与公开边界 | `pnpm --dir clients/gui typecheck`、`pnpm --dir clients/gui run verify` |
| 连接、生命周期、重开 | `pnpm --dir clients/gui test:service-connection`、`pnpm --dir clients/gui test:lifecycle`、`pnpm --dir clients/gui test:service-reopen` |
| Remote 命令、审批、审阅 | `pnpm --dir clients/gui test:remote-command-e2e`、`pnpm --dir clients/gui test:remote-interaction`、`pnpm --dir clients/gui test:remote-review` |
| 退出后接续 | `pnpm --dir clients/gui test:remote-gui-quit`；必须补独立 owner 和真实 OS 注册场景 |
| Relay 与手机状态 | `pnpm --dir clients/gui test:remote-relay`、`pnpm --dir clients/gui test:mobile-command`、`pnpm --dir clients/gui test:mobile-workspace-state` |
| Provider 与调度 | `pnpm --dir clients/gui test:provider-hot-apply`、`pnpm --dir clients/gui test:schedule-reliability-lifecycle` |
| Core/Runtime 与文档 | 按实际 Rust 改动选 `make test-core`、`make test-protocol`、`make verify-runtime`；`python3 scripts/check-docs.py` |

支持切换传输的 E2E 按[Remote 测试计划](remote-control-testing.md)分别使用 Direct 与 Relay，不能把所有脚本都假定支持同一环境变量。E1 新 owner、E2 OS 注册及 E4 转换/升级用例须补入合适的现有 runner；若没有入口，再增加窄场景脚本及 package 命令，不假定已有测试自动涵盖。

证据记录源码 commit/owned diff、构建产物、macOS/设备版本、隔离目录、运行模式、传输、模型种类、场景编号、预期与实际、日志和清理结果。确定性模型用于故障和重复副作用验证；真实 Provider、Runtime、桌面视觉、手机和包体分别列出结果，不相互替代。

## 9. 同步文档与阶段完成条件

| 文档所有者 | 必须更新的变化 |
|---|---|
| `docs/api/local-service.*` | owner、启动/附着、停止抑制、清理和恢复兼容 |
| `docs/api/desktop.*` | GUI detach 与停服区别、环境管理、转换回执 |
| `docs/api/remote-control.*` | 项目状态、启动权限与方法、能力协商、回执及拒绝语义 |
| `docs/design/architecture.*` / `remote-control.*` | 已实现的运行拓扑和职责，消除与生命周期事实矛盾的描述 |
| `docs/adr/0008-remote-host-ownership.*` | 独立模式验收后记录被细化的 owner 决策与代价 |
| GUI/移动端指南、安装指南、`docs/features.*` | 仅发布已验收入口、限制与用户操作 |
| Remote 测试计划及本文 | 实际 runner、证据位置和剩余门槛；不把设计自动改为通过 |

阶段完成需：owned diff 检查、相关契约/双语文档同步、相称测试及明确的未验证边界、隔离服务清理结果、仅本任务本地提交。只有新改动、失败或未解决疑点才扩大验证。首发完成意味着 E0–E4 的必要门槛均有证据，且手机真实完成指定开发路径；E5 不阻塞首发。
