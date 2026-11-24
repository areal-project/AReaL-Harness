# AReaL Harness 开发指引

先用一句话说明本次目标。按用户要求完成变更和验证，审阅本次 diff 后做本地提交。未经授权不推送。

从仓库根启动任务时，修改或审查 [Core](core/AGENTS.md) 或 [GUI](clients/gui/AGENTS.md) 前，读取涉及目录的指引。跨目录任务读取所有适用的指引。

## 安全与授权

- 仅停止本次启动并记录 PID 的进程，或经本次隔离目录确认归属的进程。禁止按名称、命令行或工作树路径批量杀进程。
- `~/.areal` 和 `~/Library/Application Support/AReaL Harness GUI` 是真实安装数据。可读、可复制。测试与服务使用隔离的 `AREAL_GUI_USER_DATA`、`AREAL_CORE_HOME`、`AREAL_HARNESS_SERVICE_HOME`、`AREAL_HARNESS_HOME`，真实数据只复制进隔离目录，禁止用软链或回写。
- 凭据和票据不进入日志、URL、命令行参数或提交。本机 WebSocket 地址与端口不写进构建产物。
- 发布、使用真实凭据、写外部系统、破坏性 Git 操作、大范围删除、Core Store 格式或迁移契约、移动数据目录、改 CI 必需检查或 hooks，均需明确授权。授权后直接执行范围内工作。

## 架构与交付

- 依赖从 Runtime 经 Core、Host 到客户端。Runtime 负责工具执行、隔离与清理。Core 持有项目内 Thread、Turn、Task 和回执。项目服务监督进程、锁和退出。每系统用户一个 Host，负责认证、凭据、跨项目业务和调度唤醒，是客户端的统一入口。过渡期跨项目业务可留在 Host 监督的工作台服务。
- 跨层改动先确定读写所有者、目标身份、代际及完成信号。调用方通过现有适配器消费权威状态。协议从 schema 同步到 Rust 和 TypeScript。恢复查原操作的权威回执，保留 UNKNOWN。停止受理后仍要核实退出与清理。
- 对照实际支持的入口验证行为，包括桌面、网页、CLI/TUI、移动端，以及适用的命令与快捷键、本机/中继/远程、多项目/设备、Agent 和定时任务。共享能力落在服务层，并提供可观察的状态和适用的撤销入口。
- 前期 Beta 不支持降级。需要迁移时使用一次停机导入，长期只保留一套实现。按 `make check-transitional` 为 `legacy`、`compat` 命名和过渡开关标记“过渡：到 <版本> 删”，随旧实现删除其测试。
- 职责或依赖变化查 [架构](docs/design/architecture.md) 与 [ADR 0017](docs/adr/0017-one-protocol-one-ui.md)。Host 或协议变化查 [Host API](docs/api/host.md) 与 [本地服务契约](docs/api/local-service.md)。工具、提示词、上下文、预算或调度行为改动查 [Agent 改进方法](docs/development/agent-improvement.md)。
- Agent 改进根据公开任务和可复现失败修复共享边界。保持评测隔离与隐藏评分断言，重试变更须显式、完整计量，并按 Agent 改进方法验证。不按题号、答案、基准或隐藏评分器切换策略。

## 验证与委派

- 按[测试指南](docs/development/testing.md)选能证明验收条件的入口。状态、权限、协议、持久化和竞态优先在能失败的最低层验证，能复现时先证明旧行为。运行旅程同时核对权威结果和用户可见结果，异步操作等事件或回执。故障注入确认命中本次请求。
- 使用 `make baseline-diff BASE=<基准> CMD='<测试命令>'` 归因不明的失败。新增脚本登记到 package.json、测试清单或 Makefile，由 `make check-refs` 校验。汇报按实际执行区分源码、包、服务与真机，写明阻塞或跳过的检查。
- 当工作有可独立验收的多个部分，或高影响变更需要独立复核时，按需使用子代理。为每个子任务给出范围、文件归属、验收证据和停止条件。共享状态上的连续修改、集成与最终验收由主代理负责。协调本机重型构建/测试，并清理本次启动的进程与临时资源。

## Code Review Rules

- 审查提交和恢复时，跟踪原操作的身份、代际及持久回执。若丢失响应后能重放未决副作用，或旧 owner 的迟到结果能修改新状态，指出可达路径和具体后果。
- 审查业务边界时，核对实际入口是否复用同一权威。审查门禁时，核对证据是否对应本次产物和实际执行。
- 审查按变更选读 [REVIEW.md](REVIEW.md) 的相关检查。按可达触发条件、行为、后果给出发现并定位到引入问题的变更。

## 文档与风格

- README、CONTRIBUTING、SECURITY 和 `docs/` 下的 Markdown 按现有中英文配对、首行互链，由 `python3 scripts/check-docs.py` 检查。
- 契约或用法与文档同步，按适用范围更新 [架构](docs/design/architecture.md)、[API](docs/api/)、[指南](docs/guides/)、[开发文档](docs/development/) 或 [功能](docs/features.md)。架构图遵循[图表规范](docs/design/STYLE_GUIDE.md)。
- 沿用局部格式。新注释用中文，解释代码无法表达的约束。类型优先推断，避免 `any`。
