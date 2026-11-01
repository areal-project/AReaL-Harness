**中文** | [English](0016-shared-host.en.md)

# 0016：每用户共享 Host，客户端均为投影

状态为已接受的目标设计，实施中。本文取代 [ADR 0008](0008-remote-host-ownership.md) 的生命周期所有权叙述。当前 GUI-owned 后台受应用生命期管道约束，关闭窗口与退出应用的保证不同，独立进程本身不保证 ⌘Q 后存活。

每 OS 用户由一个 Rust Host 持有项目服务监督链顶端。CLI、TUI、GUI、Web 与手机都是客户端；Core 保留 Thread、Turn、Task 与执行收据权威。采用单一 owner，避免 GUI 托管和后台托管转换产生两套生命周期。Electron 仍拥有原生窗口与桌面专属工具，Host 不依赖 GUI 模块。

旧无 owner 服务无法在启动后继承未传入的 EOF 管道，因此采用受控重启。活跃旧服务保持 `legacyPending`；空闲或显式取消排空后，以既有停止回执、清理证明与锁释放核验，再启动新 Host-owned generation。修改登记不能宣称接管。

项目登记独立于运行服务发现，Store 原地保留。旧 GUI ID 的授权与回执映射、Store 外 submission journal 和单 writer 切换属于同一迁移事务。Host 监督身份与 Remote Noise 身份分开；不同旧 profile 的 Noise 身份冲突必须显式处理。逐项目停止汇总部分结果，UNKNOWN 只查询，不重放。

外部契约见 [Host API](../api/host.md)，阶段与验收见[实施规格](../development/shared-host-spec.md)。文档接受不代表运行、真机或安装包验收通过。
