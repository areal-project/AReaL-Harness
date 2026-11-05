**中文** | [English](workbench-service.en.md)

# 工作台服务

状态：A3 进行中。Host 路由与第一个领域（使用统计）已实现，其余领域按下文顺序搬。决策见 [ADR 0017](../adr/0017-one-protocol-one-ui.md)，工作包见 [一套协议规格](../development/one-protocol-spec.md#工作包-a3工作台服务与剩余领域)。

Electron Main 里还有约 2.7 万行跨项目业务（Worktree、定时任务目录、资料库、供应商、管理页、MCP 应用等）。它们要对所有客户端开放，又暂时不值得用 Rust 重写。过渡办法是把这些代码原样搬进一个由 Host 监督的 Node 进程，叫工作台服务。单项目内的逻辑仍优先进 Core。

## 不做什么

- 不开放任何端口。客户端只连 Host。
- 不直接连 Core，不读写 Core 数据目录。
- 不持有明文凭据，不把凭据写进日志、文件或命令行。
- 不依赖 Electron API。需要原生能力的部分留在外壳，经 `tool.provide` 走 Host。

## 进程监督

沿用本机 Relay 的做法（`core/host/src/local_relay.rs`）：

- 第一次有请求时才启动。Host 用 `TrustedCommand::supervised` 启动，环境变量清空后只给 `PATH`、`HOME`、`TMPDIR` 和数据目录 `AREAL_WORKBENCH_DATA`（Host 数据目录下的 `workbench/`）。
- 桌面安装从已签名应用的 `Resources/areal-workbench` 启动，先校验签名与 `bundle.json` 清单，再用随包 Electron 加 `ELECTRON_RUN_AS_NODE=1` 运行。只装 CLI 时用系统 Node（≥ 22）还没接，目前报不可用。
- 启动后服务在私有通道上发一帧 `ready`，列出它实现的方法与版本。超时（20 秒）算启动失败。
- 异常退出后，下一次请求按 1、2、4…秒退避重启，未到时间直接报不可用；10 分钟内失败 5 次就不再重启。
- Host 停止时关闭标准输入让服务退出（服务先把数据写盘），5 秒内不退就强制结束。

## 私有通道

- 一对 Unix socket（`UnixStream::pair`），服务端那头作为子进程的标准输出、Host 写标准输入。不经文件系统路径，别的进程拿不到。
- 每行一个 JSON 帧，带 `version: 1`，上限 64 MiB：长会话的 `thread/read` 结果经反向调用回到服务，沿用桌面 Core 客户端的上限。交给客户端的结果仍受客户端协议限制。
- Host 到服务：`{id, method, params, context}`。`context` 里有已验证的主体与连接 ID，服务不自己做授权判断。
- Host 到服务的事件：`core.event`，转发共享 Core 连接上的 `turn/started`、`turn/completed`、`item/completed`。服务没运行时不为此拉起。
- 服务到 Host：结果，以及反向调用 `projects.list`、`core.request`、`vault.read`（见下）。

## 方法路由

- 方法名仍由 `schemas/areal-host-protocol-v1.json` 统一登记，客户端看不出某个方法在 Host、Core 还是工作台服务里实现。
- Host 只把 schema 里标为 `x-owner: workbench`、登记在 `core/host/src/workbench_route.rs` 且出现在 `ready` 帧里的方法转给服务；其余一律 `methodNotFound`。
- 目前这些方法只给本机桌面连接（协商了 gui-write-v1 的票据连接）。跨项目统计会越过远程设备的项目授权，开放给远程前要先定授权。
- 授权、速率与 commandId 回执都在 Host 做。写方法先在 Host 的 journal 记账，再把 `operationId` 交给服务；回复丢失时客户端照旧用 `command.read` 查原 ID，Host 向服务查该 `operationId` 的结果，不重发。目前搬来的方法都是读或可重复执行的合并，不带 commandId。
- 服务的事件经 Host 原样推给订阅了对应主题的连接。

## 取得 Core 连接

服务需要 Core 时调用 `core.request {projectId, method, params}`。Host 用它已有的共享连接（`schedule_connection`）转发，并检查服务代次，保证服务不会绕开 Host 的准入与代次检查。可调的 Core 方法按白名单放行，目前只有只读的 `thread/list`、`thread/read`。

## 凭据

`vault.read {slot}` 只返回本次方法允许的那一项，Host 按方法登记的用途限制可取的 slot。值只留在内存里，用完即弃。还没有领域需要它，目前一律拒绝。

## 缺 Node 时

相关方法返回 `CAPABILITY_UNAVAILABLE`，桌面界面退回 Main 原路径。会话、发送、审批等 Host 与 Core 的功能不受影响。

## 代码位置与迁移

- 服务代码放 `services/workbench/`，与 `services/remote-relay/` 同级，随桌面包与 CLI 包分发。
- 每个领域一个 PR：先把 Main 中的 `.cjs` 原样搬过去并接上通道，验收后再删 Main 对应文件与 IPC 命令；改写逻辑放在后续 PR。
- 领域顺序按规格：会话类（fork、side、编辑、继续、预测）→ 工作区与 Worktree → manage → 供应商与订阅、资料库、导出、反馈与诊断。会话类大多是单项目操作，先判断能否直接进 Core。

## 已搬的领域

- 使用统计（`analytics.read`、`analytics.sync`、`analytics.activity`、`analytics.import`）。代码在 `services/workbench/src/domains/analytics.cjs`。与 Main 的不同有三处：同步经 `core.request` 读，不拿 Core 地址与令牌；Core 记录了轮次开始时刻时按那天计，旧历史仍为未注明日期；活跃时间由各客户端每 5 秒上报，服务取并集。
- 界面开关 `areal.oneProtocol.domains=analytics`（需同时开 reads）。首次连上时把 Main 的每日活跃时间合并过去（按天取较大值，可重复执行）。切换期间 Main 照常写自己的文件，关掉开关就回到 Main 的数据。
- 资料库（`library.json`）先只把写入收归 Host：开关 `areal.oneProtocol.domains` 含 `library` 时，桌面后台把下一份内容写到同目录暂存文件，经本机控制通道 `library.write` 交给 Host，Host 按文件内容摘要比较后替换（`core/host/src/library_store.rs`），冲突时桌面重读再重算。文件不搬家，Host 没有该 GUI 的导航来源时退回桌面自己写。整理逻辑依赖 Worktree 分组与各项目实时摘要，随 Worktree 一起搬进服务，之后再改写进 Host。
