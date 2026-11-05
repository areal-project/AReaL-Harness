**中文** | [English](workbench-service.en.md)

# 工作台服务

状态：A3 设计说明，尚未实现。决策见 [ADR 0017](../adr/0017-one-protocol-one-ui.md)，工作包见 [一套协议规格](../development/one-protocol-spec.md#工作包-a3工作台服务与剩余领域)。

Electron Main 里还有约 2.7 万行跨项目业务（Worktree、定时任务目录、资料库、供应商、管理页、MCP 应用等）。它们要对所有客户端开放，又暂时不值得用 Rust 重写。过渡办法是把这些代码原样搬进一个由 Host 监督的 Node 进程，叫工作台服务。单项目内的逻辑仍优先进 Core。

## 不做什么

- 不开放任何端口。客户端只连 Host。
- 不直接连 Core，不读写 Core 数据目录。
- 不持有明文凭据，不把凭据写进日志、文件或命令行。
- 不依赖 Electron API。需要原生能力的部分留在外壳，经 `tool.provide` 走 Host。

## 进程监督

沿用本机 Relay 的做法（`core/host/src/local_relay.rs`）：

- Host 用 `TrustedCommand::supervised` 启动，环境变量清空后只给 `PATH`、`HOME`、`TMPDIR`。桌面安装用随包 Electron 二进制加 `ELECTRON_RUN_AS_NODE=1`；只装 CLI 时用系统 Node（≥ 22）。
- 启动后服务在私有通道上发一帧 `ready`，列出它实现的方法与版本。超时（20 秒）算启动失败。
- 异常退出按 1、2、4…最多 60 秒退避重启；10 分钟内失败 5 次就停止重启，并把能力报告为不可用，等用户在设置里重试。
- Host 停止时先停止接新请求，等进行中的请求结束或超时，再关闭标准输入让服务退出。

## 私有通道

- 一对 Unix socket（`UnixStream::pair`），服务端那头作为子进程的标准输出、Host 写标准输入。不经文件系统路径，别的进程拿不到。
- 每行一个 JSON 帧，带 `version: 1`。帧大小与客户端协议同为 1 MiB 上限。
- Host 到服务：`{id, method, params, context}`。`context` 里有已验证的主体（本机桌面或设备 ID 与授权版本）和 `projectId`，服务不自己做授权判断。
- 服务到 Host：结果、事件，以及两类反向调用 `core.request` 和 `vault.read`（见下）。

## 方法路由

- 方法名仍由 `schemas/areal-host-protocol-v1.json` 统一登记，客户端看不出某个方法在 Host、Core 还是工作台服务里实现。
- Host 只把 schema 里标为 `x-owner: workbench` 且出现在 `ready` 帧里的方法转给服务；未登记的一律 `methodNotFound`。
- 授权、速率与 commandId 回执都在 Host 做。写方法先在 Host 的 journal 记账，再把 `operationId` 交给服务；回复丢失时客户端照旧用 `command.read` 查原 ID，Host 向服务查该 `operationId` 的结果，不重发。
- 服务的事件经 Host 原样推给订阅了对应主题的连接。

## 取得 Core 连接

服务需要 Core 时调用 `core.request {projectId, method, params}`。Host 用它已有的共享连接（`schedule_connection`）转发，并检查服务代次，保证服务不会绕开 Host 的准入与代次检查。

## 凭据

`vault.read {slot}` 只返回本次方法允许的那一项，Host 按方法登记的用途限制可取的 slot。值只留在内存里，用完即弃。

## 缺 Node 时

`host.describe` 与 `hello` 的能力列表里不出现 `workbench`，相关方法返回 `CAPABILITY_UNAVAILABLE`。界面按能力隐藏对应入口，会话、发送、审批等 Host 与 Core 的功能不受影响。

## 代码位置与迁移

- 服务代码放 `services/workbench/`，与 `services/remote-relay/` 同级，随桌面包与 CLI 包分发。
- 每个领域一个 PR：先把 Main 中的 `.cjs` 原样搬过去并接上通道，验收后再删 Main 对应文件与 IPC 命令；改写逻辑放在后续 PR。
- 领域顺序按规格：会话类（fork、side、编辑、继续、预测）→ 工作区与 Worktree → manage → 供应商与订阅、资料库、导出、反馈与诊断。会话类大多是单项目操作，先判断能否直接进 Core。
