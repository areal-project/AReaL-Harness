**中文** | [English](shared-host-spec.en.md)

# 共享 Host 实施规格

状态为目标设计，实施中。H0 固定契约；H1 至 H4 的完成需要各自的运行证据。契约见 [Host API](../api/host.md)，所有权决策见 [ADR 0016](../adr/0016-shared-host.md)。

## 结论

每个 OS 用户只运行一个 AReaL Host。CLI、TUI、GUI、`areal web` 和手机都是连到它的客户端，没有哪个客户端拥有它。任何客户端退出或崩溃都不影响正在运行的工作。Host 由 Rust 实现，放进现有 `areal` 二进制。它负责项目登记、各项目 Core 的启停与监督、凭据、Remote Gateway 和定时任务激活；对话、Turn、Task 的权威仍在各项目 Core。

本规格取代 [独立开发环境服务设计](../design/environment-service.md) 与 [实施计划](environment-service-plan.md) 中“GUI 托管 / 后台托管”双模式及其模式转换机制。那两篇里的权威边界、Host 身份、显式启动项目、停止意图和不重放规则继续有效，下文直接沿用。

对照基线：AReaL-Harness main `62a8f02`；T3 Code `8760d063`（`apps/server/src/serverOwnership.ts`、`docs/user/background-service.md`）；ZCode `3c5b2276`（`docs/architecture/r2-server-cli-and-daemon.md`）。本文中的命令、协议方法、字段和退出码都是提案，实现并通过验收前不能在其他文档写成已支持能力。

## 已定决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| Host 用什么写 | Rust，`areal host` 子命令 | 单一二进制；owner、锁、清理证明本来就在 Rust；可直接部署到 Linux 服务器 |
| 本机客户端怎么和 Core 说话 | Host 负责找到并拉起项目，向客户端签发该项目 Core 的认证描述，客户端直连 Core | 今天 TUI 和 `areal web` 已是直连；保持每项目 Core 不变 |
| 手机怎么连 | 只经 Host 内的 Remote Gateway | 与现有 Remote v2 一致 |
| ⌘Q 的含义 | 只断开 GUI。有任务在跑时弹提示，默认按钮“退出并保持运行”，另一个按钮“停止任务并退出” | 用户不会意外留下任务，也不会意外停掉任务 |
| Host 空闲时退出吗 | 不退出，直到显式停止、注销或关机 | 与现有 service-host 一致（`docs/api/local-service.md` “服务没有闲置退出计时器”） |
| 两套登记 | 合并到 `~/.areal`，各项目数据目录原地不动 | 不移动 Core Store |

## 交给 Codex 的方式

按 H0 → H4 顺序连续实施，以各工作包的完成条件作为验证边界。每阶段形成可审查的本地提交；发布和 push 单独授权。提示词可引用本文对应小节：

```text
目标：实现 docs/development/shared-host-spec.md 的工作包 H1。
上下文：该小节的“现状”和列出的文件；仓库规则见 AGENTS.md。
约束：本文“全局约束”和该小节的“约束”“需要停下来问的情况”。
完成条件：该小节的“完成条件”全部满足，并在 PR 中给出证据。
```

- H0 的受控重启、迁移契约与连续实施策略是已确定设计，无需重新设置阶段审批。H3 按既有 Remote wire 兼容实现；重大协议变化仍需维护者确认。
- 仓库通用规则（分层、中英文文档配对、测试分层、PR 模板）以 AGENTS.md 为准，本文不重复。
- 工作包范围内、可回退的实现选择由 Codex 自行决定并在 PR 说明理由；只有“需要停下来问的情况”需要先问。

## 目标拓扑

```text
CLI / TUI ─┐
GUI ───────┼─ 本机 socket ─┐
areal web ─┘               ▼
手机 ── Relay ──▶ AReaL Host（每 OS 用户一个，持有 ~/.areal/host.lock）
                  ├ 项目登记（CLI 与 GUI 合一）
                  ├ 启停与监督 ──▶ 每项目 service-host → launcher → Core → Runtime
                  ├ 凭据（macOS 钥匙串 / Linux 0600 文件）
                  ├ Remote Gateway
                  └ 定时任务激活
本机客户端拿到 Core 描述后直连该项目 Core；手机始终经 Gateway。
```

| 组件 | 拥有 | 不拥有 |
| --- | --- | --- |
| Host | Host 身份、项目登记、Core 启停与监督链顶端、凭据、设备授权、Gateway、定时激活、停止意图、升级状态 | 会话历史、Turn、Task 状态、模型循环 |
| 每项目 Core | Thread/Turn/Task、审批、受理回执、历史 | 项目目录、设备配对、OS 服务注册 |
| GUI | 窗口、草稿、可重建投影；连接期间提供只有桌面才有的工具（浏览器预览、Computer Use、GUI 终端） | 任何进程的生存权 |
| CLI / TUI / Web | 终端或浏览器里的投影 | 任何进程的生存权 |

## 生命周期契约

| 发生的事 | 行为 |
| --- | --- |
| 第一个客户端启动，发现没有 Host | 启动一个脱离自己的 Host，然后连接 |
| 两个客户端同时启动 Host | 只有一个拿到 `host.lock`；输家以“已被占用”退出码退出，客户端改为连接赢家 |
| 关窗口、⌘Q、强退 GUI、关终端、TUI 崩溃 | 只断开连接，对任务无影响 |
| ⌘Q 时有任务在跑 | 提示“N 个任务会在后台继续”，默认“退出并保持运行”；选“停止任务并退出”时走现有 `ifIdle`/`cancel` 停止语义，需二次确认 |
| 再打开任何客户端 | 连回同一个 Host，看到正在跑的 Turn 和待审批 |
| `areal host stop`（或 GUI“停止后台”） | 记录停止意图，排空：忙时拒绝，`--cancel` 才取消任务。停止意图阻止服务管理器自动拉起 |
| 装了系统服务后登录 | 服务管理器启动 Host，只激活定时任务需要的项目 |
| Host 崩溃 | Core 链按现有 EOF 清理；装了服务时有界重启（5 分钟内最多 5 次，退避 1、2、4、8、16 秒，超出进入 crash-loop-stopped）；新 Host 等旧锁释放和清理证明 |
| 升级 | 见 H4：新版本装好后标记“待重启”，用户确认或空闲时排空并以新版本重启 Host；Core 下次用到时以新版本启动；正在跑的 Turn 不中途换版本 |
| 注销、休眠 | 不承诺可达；恢复后重新握手核对 |

## 全局约束

- 不改 Core Store 格式，不移动任何项目的数据目录，不重写 Core 或 Runtime。
- 保留现有监督链与清理证明：Host 取代 GUI Main 成为最顶端的生命期管道持有者，下面的 service-host、launcher、Core、Runtime 规则不变（`docs/api/local-service.md` 中“宿主控制 Core/Runtime 的启动和关闭”一段）。
- UNKNOWN 不重放、受理回执优先、单写者这些既有不变量全部保留。
- Remote 线协议对已发布的 iOS 与 PWA 客户端保持兼容；变化只通过能力协商加入。
- 依赖方向保持 Runtime → Core → Clients。Host 属于 Core 层，放在 `core/` 下的 crate，GUI 通过协议使用它，不反向依赖 GUI 代码。
- 凭据、token、配对密钥不进命令行参数、plist、日志或诊断。
- 不支持 Windows；不做 SSH 远端部署（`areal up`）、多用户、T3 Connect 式云账号。

## 项目与迁移契约

`ProjectRegistration` 独立持久化 `projectId`、`workspace`、`dataDir`、`source` 与 `defaultBinding`，不复用运行中服务列表。CLI 同工作区出现多个候选且无唯一默认绑定时显式返回 `projectAmbiguous`。GUI 旧 `(profile,projectId)` 映射连同 Remote 授权、Worktree 与回执定位一起提交；同工作区不同 Store 保留为独立项目。完整形状见 [Host API](../api/host.md)。

GUI 根目录的 `<projectId>-pending.json` 与 `<projectId>-outcomes.json` 不属于 Core Store。迁移必须保留旧请求 ID、语义摘要、UNKNOWN 与已受理结果。旧 writer 停止准入并完成 flush 后，Host 在独占锁下导入，写入包含来源身份和摘要的持久迁移回执，再切换为单一新 writer。中断恢复按迁移阶段核查，不重发旧请求。H2 验收必须覆盖升级前已受理但回复丢失，升级后只发生一次副作用。

Host 监督身份与 Remote Noise peer 身份独立。仅单旧 GUI profile 自动迁移配对、grants、撤销状态和 Noise 密钥；多个不同 Noise 身份明确冲突，保留各自原数据，不能覆盖或合并。Host 凭据包含 API keys、OAuth 与 provider subscription 会话。H3 必须迁移订阅传输 owner，GUI 退出后仍可刷新和流式传输。

停止逐项目保存持久回执，汇总 `partial` 保留每项目的 completed、blocked 与 UNKNOWN。Host 崩溃或响应丢失后用 `host.operation` 查询原请求；null 不证明未受理。跨项目停止没有全局原子性。原 service-host 没有 EOF 管道时只能保持 `legacyPending`，经排空、清理证明和锁释放后启动新 Host-owned generation。

## 工作包 H0：ADR 与协议契约

### 目标

在写代码前定下 Host 的边界和对外契约，并修正现有文档里与事实矛盾的描述。

### 现状

- [ADR 0008](../adr/0008-remote-host-ownership.md) 说“正常 GUI 退出仍保留后台 Remote”，但 `docs/api/local-service.md` 写的是“退出应用或 ⌘Q 则停止本应用全部 Desktop、Host、Core 和 Runtime”。代码与后者一致：`clients/gui/app/src/core/application-owner.cjs` 的 `watchApplicationLifetime` 在没有 GUI 管道时直接报错，管道 EOF 时 `service-main.cjs` 调用 `exitProcess(1)`；`main.cjs` 的 `requestQuit` 经 `startup-recovery.cjs` 的 `recoverConnectedService` 停掉整条链。
- CLI 服务登记在 `~/.areal`。GUI 项目索引和 Store 在 userData 下的 `areal-core`，运行服务发现默认在 `~/.areal/gui/<serviceHome 摘要>`。对应入口为 `core/local-service/src/lib.rs` 的 `home()` 和 `service-config.cjs` 的 `serviceOptions`。
- owner 只有一种：JS `{kind:"gui",appRunId,profile}`（`application-owner.cjs`）与 Rust `Owner::Gui`（`core/local-service/src/gui_owner.rs`、`areal_protocol::service`）。

### 要做的

1. 新 ADR：“每用户共享 Host，客户端均为投影”，取代 ADR 0008 中的所有权表述，并把 0008 标为被取代。
2. 在 `docs/api/` 新增 Host 契约（中英文），至少定义：
   - 本机传输：`~/.areal` 下的 Unix socket，目录 0700，沿用 `control.sock` 的路径长度派生规则；认证沿用同 UID 加 authFile 的现有做法。
   - 方法：`hello`（版本与能力协商）、`host.status`、`host.stop`（`ifIdle` / `cancel`）、`projects.list`、`projects.register`（仅本机）、`project.ensure`（返回该客户端可用的 Core 描述）、`project.stop`、`host.subscribe`（状态推送）、`host.update`（H4 用）。方法名可调整，语义必须覆盖这些。
   - owner：新增 `{kind:"host", hostId, generation}`，JS 与 Rust 两端同时定义；H1 与 H2 保留 `Owner::Gui` 运行支持，直到 GUI 迁移完成；之后仅用于识别旧实例，不能接管 Host-owned 服务。
   - 退出码：“home 已被另一个 Host 持有”的专用退出码；macOS 上用 0 退出（launchd `KeepAlive.SuccessfulExit=false` 不重启），Linux 用非零码并写进 systemd `RestartPreventExitStatus`。
3. 修正 `docs/api/local-service.md`、`docs/design/architecture.md`、`docs/design/remote-control.md` 中与上述矛盾的句子，标明“目标设计，实施中”。

### 约束

只改文档和 schema（如 `schemas/` 下新增 Host 描述），不改运行代码。

### 需要停下来问的情况

- 发现某个现有不变量与“客户端不拥有任何进程”冲突，且无法在 Host 内解决。

### 完成条件

- ADR、Host 契约中英文齐全，`python3 scripts/check-docs.py` 通过。
- 契约里每个方法都有请求、响应、错误和幂等说明。

## 工作包 H1：Rust Host，CLI / TUI / Web 接入

### 目标

`areal host` 可运行；终端里的 `areal`、TUI 和 `areal web` 都通过 Host 找项目，不再各自直接拉起 service-host。

### 现状

- `clients/cli/src/service.rs` 与 `core/local-service/src/client.rs` 的 `ensure*` 直接按工作区拉起 `areal service-host`，service-host 脱离 CLI 常驻。
- `core/service-host`（`lib.rs`、`launcher.rs`）已实现每项目的进程监督、锁和清理证明。
- `Cargo.lock` 已有 `fs2`（文件锁）。

### 要做的

1. 新 crate（建议 `core/host`）和 `areal host run|status|stop` 子命令。`run` 取得 `~/.areal/host.lock`，失败按 H0 的退出码退出。
2. 项目登记：在 `~/.areal` 持久化独立 `ProjectRegistration`，现有运行服务 registry 仅保存实例发现事实；`project.ensure` 内部复用 `core/local-service` 的 `ensure_with_lifetime`，由 Host 持有各 service-host 的生命期管道写端。
3. 对旧无 owner 的 CLI service-host 执行受控重启迁移。旧进程无法补接启动时未继承的 EOF 管道，登记为 `legacyPending`；原工作继续运行。空闲或显式 `cancel` 排空后，核对持久停止回执、Runtime 清理证明、服务锁和 Store 锁释放，再以 Host owner 启动新 generation。
4. 所有普通本地入口接入 Host，包括 `areal exec`、旧 `-p`、headless TUI，以及交互 TUI 和 Web。CLI 生成的 deployment、MCP、skills 输入移入 Host 持久 launch inputs；临时客户端目录不能成为运行任务的生命期依赖。客户端解析绝对路径和配置上下文，Host 在边界校验；禁止通过改变 Host 全局 cwd 或环境模拟客户端。
5. 客户端发现：`areal`、TUI、`areal web` 先连 Host，没有就启动一个脱离自己的 Host 再连；拿到 Core 描述后直连 Core。保留 `areal service ...` 命令作为兼容入口，内部改走 Host。
6. `host.stop` 复用 Core `drain(ifIdle|cancel)`。逐项目保存持久回执并汇总 `partial`，记录停止意图。响应丢失后仅查询原操作，不重放 UNKNOWN；跨项目没有全局原子停止。

### 约束

- 不改 GUI 代码。H1 期间 GUI 仍按旧方式运行在自己的 home 上，两者互不影响。
- 不改 Core 与 service-host 的协议，除非 H0 契约要求。

### 需要停下来问的情况

- 受控重启需要改变现有锁、代际或清理证明语义。
- 需要让 Host 转发 Core 流量才能让 TUI 工作。

### 完成条件

- 集成测试（隔离 `AREAL_HARNESS_HOME`）：两个进程并发 `areal host run`，只有一个持锁，另一个以约定退出码退出。
- 在终端 A 用 TUI 开会话并发起 Turn，强杀 TUI，终端 B 重开 TUI，看到同一 Turn 仍在运行或已完成，副作用只发生一次。
- `areal host stop` 在有活动 Turn 时拒绝；`--cancel` 后进程、锁全部释放，清理证明齐全。
- 旧 CLI service-host 有活动任务时保持原 generation 并报告 `legacyPending`；排空和清理后新 generation 带 Host owner。杀 Host 能触发新监督链 EOF 清理；旧 pending 进程不宣称具备此保证。

## 工作包 H2：GUI 变客户端

### 目标

GUI 不再启动 Desktop Service 管项目生命周期，而是连 Host；⌘Q 采用新语义；GUI 旧登记和凭据迁入 Host。

### 现状

- `service-client.cjs` 以 `AREAL_GUI_DESKTOP_LIFETIME_FD=3` 拉起 Desktop Service；`service-main.cjs` 装配 `CoreBackend`、`RemoteControl`、通知、电源。
- 凭据用 Electron `safeStorage` 加密（`backend.cjs` 的 `encryption`、`remote.cjs` 的 `RemoteEncryption`）。
- Desktop Service 中直接调用 Electron 的只有 `safeStorage`、`Notification`、`powerSaveBlocker`、`crashReporter`（`service-main.cjs:10–13`）。

### 要做的

1. GUI Main 连 Host（没有就拉起）。项目列表、打开项目、停止项目都改走 Host；Renderer 与 Core 的连接方式不变，只是 Core 描述来自 Host。
2. 登记合并：首次连接时 GUI 把自己的 userData 路径告诉 Host，Host 导入 GUI registry 中的项目与 Worktree 映射，按原 `dataDir` 登记，不移动 Store。激活前持久化旧项目 ID、授权和回执映射；Remote 身份按上文单 profile 冲突规则迁移，Host 监督 ID 独立。写持久迁移回执，中断恢复逐阶段核查。同一工作区不同 dataDir 保留独立项目，等价同源导入复用已保存绑定。
3. 凭据迁移：Host 提供密钥库（macOS 用钥匙串，`security-framework` 已在 `Cargo.lock`；Linux 用 0600 文件）。GUI 用 `safeStorage` 解密旧密文，经本机 socket 交给 Host 写入，确认后才删除旧密文。失败保留旧密文，提示重新登录，不用空凭据启动。
4. ⌘Q：按“生命周期契约”实现提示与两个选项；没有任务在跑时直接退出，不提示。GUI 菜单栏或设置里显示“后台运行中，N 个任务”，并提供“停止后台”。
5. 桌面专属工具：GUI 连接期间按现有动态 ToolHost 语义向对应 Core 发布浏览器预览、Computer Use、GUI 终端；断开即撤销并报告不可用。
6. 过渡：Remote Gateway、定时激活、通知暂时仍由 Desktop Service 承载，但 Desktop Service 改为 Host 的客户端，不再持有任何 Core 的生命期管道。H3 完成前，手机和定时任务仍需要 GUI 开着，需在 PR 中写明。

### 约束

- 保留旧 GUI 数据目录。登记快照只读导入；journal 切换通过独占 writer 和持久迁移回执进行，旧 writer 必须先停写。
- 旧版 GUI 遇到 Host 持有的 Core 时必须拒绝接管（`Owner::Gui` 不匹配），不能停止它。

### 需要停下来问的情况

- 钥匙串访问需要用户反复授权，或签名身份变化导致无法读取旧条目。
- 不同工作区或不同旧授权身份指向同一 `dataDir`，且无法通过已保存的同源映射核对。冲突项目保留原状态，不自动合并。

### 完成条件

- GUI 发起任务并停在审批，强退 GUI，从 TUI 完成审批，重开 GUI 看到同一 Turn，副作用一次。
- 终端里用 `areal` 开的会话出现在 GUI 项目里，反之亦然。
- ⌘Q 两个选项分别验证：保持运行后 `areal host status` 仍显示任务；停止任务后任务结算、Core 退出。
- 凭据迁移中断（迁移中杀 GUI）后重开，凭据可用或明确提示重新登录。
- 升级前已受理但回复丢失的创建请求跨升级仍核查原回执，副作用一次；迁移中断后旧、新 journal 不同时写入。

## 工作包 H3：Gateway、定时激活、推送与订阅传输迁入 Host

### 目标

手机和定时任务不再依赖 GUI。Desktop Service 删除。

### 现状

- Gateway：`core/host/src/gateway/`、`remote_state.rs` 与 `journal.rs`；原 JS 行为对照位于 `clients/gui/app/src/core/remote*.cjs`，Noise 与线格式对照位于 `clients/gui/packages/remote`（`channel.mjs`、`wire.mjs`、`relay-codec.mjs`）。
- 定时激活与准备：`core/host/src/schedules.rs`、`schedule_connection.rs`、`schedule_admission.rs` 与 `schedule_resources.rs`；Core 侧触发不变。
- 订阅来源 owner：`core/host/src/subscription/`；原账号与传输行为对照位于 `clients/gui/packages/chatgpt-provider/`。
- 现有端到端测试：`pnpm --dir clients/gui test:remote-relay`、`test:remote-command-e2e`、`test:remote-interaction`、`test:remote-review`、`test:mobile-command`、`test:mobile-workspace-state`、`test:remote-gui-quit`、`test:schedule-reliability-lifecycle`。

### 要做的

1. 在 Host 中用 Rust 实现 Gateway：配对、设备授权、Relay 与 Direct 两种传输、命令关联与 journal、撤权即时生效、推送。线协议与现有实现逐字节兼容。
2. 把上面列出的 JS 端到端测试改为可对 Rust Host 运行（以测试为行为对照），全部通过后再删除 JS 实现。
3. 定时激活迁入 Host：登录后或 Host 启动后只拉起定时任务需要的项目；尊重项目停止意图与 Host 停止意图。
4. 迁移 provider subscription transport owner，包括 ChatGPT 订阅登录、刷新、账户切换、注销、Core 重连凭据注入，以及正在使用的流式连接。凭据迁移覆盖 API keys、OAuth token 与订阅会话；Core 保留模型执行权威。GUI 退出后这些传输继续，由 Host 监督，身份或凭据版本不匹配不得恢复旧账户。
5. 删除 Desktop Service 进程及 `AREAL_GUI_DESKTOP_LIFETIME_FD` 路径；通知改为 GUI 在线时由 GUI 弹，GUI 不在时只发手机推送。防休眠由 Host 在有活动任务时启动 `caffeinate -w <host pid>`（macOS）或 `systemd-inhibit`（Linux）。

### 约束

- 在隔离环境并行对照后切换。生产身份、grant 与 journal 始终只有一个 writer；Rust Gateway 通过对照前保留 JS 实现，不让两个 Gateway 同时承接同一身份。
- 单旧 profile 的已配对设备、Remote Noise 身份与授权原样保留，无需重新配对。多个 profile 的不同身份报告冲突，不能覆盖或伪装为同一个 peer。

### 需要停下来问的情况

- 任何对照测试需要修改断言才能通过。
- 需要改变 Relay 服务端（`services/remote-relay`）的协议。

### 完成条件

- 上述端到端测试全部对 Rust Host 通过，PR 中附运行记录。
- GUI 完全退出后，手机经 Relay 连上并完成一次审批；定时任务按时触发。
- 单旧 profile 的已配对真机升级后无需重新配对；第二个不同 Noise 身份的 profile 导入失败且保留原授权。GUI 退出后 ChatGPT 订阅任务继续，刷新和重连不恢复已注销账户。

## 工作包 H4：系统服务与升级

### 目标

登录后无需打开任何客户端即可使用；升级不依赖“退出再打开”。

### 要做的

1. `areal host install|uninstall`：macOS 写用户级 LaunchAgent（`KeepAlive.SuccessfulExit=false`、`ThrottleInterval`），Linux 写 systemd 用户服务（`RestartPreventExitStatus` 填 H0 退出码；按需提示 `loginctl enable-linger`）。可执行路径、`AREAL_HARNESS_HOME` 固定写入，不依赖交互 shell 环境。卸载服务不删除数据。
2. 崩溃预算：5 分钟内最多 5 次，退避 1、2、4、8、16 秒，超出进入 `crash-loop-stopped` 并在 `areal host status` 显示。
3. 升级：新版本装到版本化目录后，Host 标记 `restartPending`，所有客户端显示“新版本已就绪，重启后台生效”。用户确认后走排空：有任务在跑就等待或拒绝，取消需二次确认；然后以新版本重启 Host。各项目 Core 下次用到时以新版本启动。可选“空闲时自动重启”。
4. 版本兼容：新客户端连旧 Host、旧客户端连新 Host 都按能力协商工作，缺失功能隐藏，不按版本号推断。
5. GUI 设置里提供“登录时启动后台”开关，对应 install/uninstall。

### 需要停下来问的情况

- 签名或公证要求改变包结构，导致 LaunchAgent 指向的路径在应用更新后失效。

### 完成条件

- 登录后不开任何客户端，手机能连，定时任务按时触发。
- `areal host stop` 后服务管理器不会自动拉起；`areal host run` 或任一客户端可重新启动。
- 升级流程：有任务时被拒绝；空闲时升级完成，`host.status` 显示新版本，Host 身份和配对不变。
- 签名安装包上的验收单独记录，开发构建的结果不能替代。

## 验收场景汇总

| 编号 | 场景 | 工作包 |
| --- | --- | --- |
| HOST-01 | 并发启动只有一个 Host | H1 |
| HOST-02 | 强杀客户端后同一 Turn 继续，副作用一次 | H1、H2 |
| HOST-03 | 终端与 GUI 看到同一份项目和会话 | H2 |
| HOST-04 | ⌘Q 两个选项行为正确 | H2 |
| HOST-05 | 凭据迁移中断可恢复 | H2 |
| HOST-06 | GUI 退出后手机与定时任务可用 | H3 |
| HOST-07 | 已配对设备无需重新配对 | H3 |
| HOST-08 | 登录自启、停止意图不被自动拉起 | H4 |
| HOST-09 | 升级有任务时拒绝、空闲时成功、身份不变 | H4 |
| HOST-10 | Host 崩溃后有界重启，不越过旧锁 | H1、H4 |
| HOST-11 | 旧服务忙碌时 pending，清理后才启动新 Host-owned generation | H1 |
| HOST-12 | 已受理回复丢失请求跨 journal 迁移副作用一次 | H2 |
| HOST-13 | 不同旧 Noise 身份冲突，不覆盖 grants | H2、H3 |
| HOST-14 | GUI 退出后 provider subscription 流式传输与刷新继续 | H3 |
| HOST-15 | 部分停止与回复丢失只核查，不重放 UNKNOWN | H1、H4 |
| HOST-16 | exec、旧 -p、headless TUI 在客户端退出和临时输入清理后继续 | H1 |

## 不在本规格内

- `areal up` 式 SSH 部署到远端 Linux、GUI 连远端 Host。H1–H4 完成后 Host 已可在无桌面的 Linux 上运行，另写规格。
- 手机启动从未打开过的项目（原计划 E3）、Windows、多 OS 用户共享、云账号与托管隧道。
