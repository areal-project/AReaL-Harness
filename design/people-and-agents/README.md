# 人与 Agent

本目录维护 AReaL Harness 中人、Agent 与任务之间的设计关系。设计者在这里判断谁负责工作、用户控制什么，以及结果依据什么。

## 按问题查阅

| 设计问题 | 规范归属 |
| --- | --- |
| 当前是谁、在哪个会话、为谁工作？ | [身份与所有权](identity-and-ownership.md) |
| 点击后承诺了什么，审批允许什么？ | [控制与审批](control-and-approval.md) |
| 子任务何时独立推进，何时可以接管？ | [委派与交接](delegation-and-handoff.md) |
| Agent 看到了什么，引用和用量说明什么？ | [上下文与证据](context-and-evidence.md) |

## 规范边界

Core 与 Runtime 契约定义可执行行为、权限和结算条件。字段、错误码、容量及兼容规则仍由 [桌面 API](../../docs/api/desktop.md)、[Task API](../../docs/api/tasks.md) 和 [委派设计](../../docs/design/multi-agent.md) 维护。

## 与其他设计目录的关系

[设计原则](../principles/README.md) 约束整体取舍。[基础规范](../foundations/README.md) 维护视觉表达。[交互模式](../patterns/README.md) 说明如何组织操作与反馈。
