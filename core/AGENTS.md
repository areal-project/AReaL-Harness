# Core、项目服务与 Host

- 改写入、协议或生命周期时，先找 [Host API](../docs/api/host.md)、[Core API](../docs/api/core.md) 或 [本地服务契约](../docs/api/local-service.md) 中的权威。Host 的跨项目职责、项目服务的进程/锁职责与 Core 的项目执行职责分别验收。
- 有副作用的命令在执行前完成持久准入。恢复键绑定原主体、项目、操作和代际。用权威证据结算原请求，历史缺证据时只把对应记录标为 UNKNOWN，保留安全的历史和回执读取。
- 变更 Agent 工具、提示词、预算或恢复时，从失败证据提出可证伪假设。整体能力提升需要开发集对照和隔离来源确认。验收方法见 [Agent 改进方法](../docs/development/agent-improvement.md)。
- 用最接近权威的行为测试核对新状态、旧数据、失败和可重试路径。涉及调用方时，继续核实实际协议与用户结果。

## Code Review Rules

- 查持久准入之前可执行的副作用、换代后可以继续写入的旧 owner，以及停止受理后仍占用资源或并行执行的旧 run。相关路径见 [REVIEW.md](../REVIEW.md)。
