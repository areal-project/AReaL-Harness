# 界面术语

| 对象 | 界面称呼建议 | 避免歧义 | 详细来源 |
| --- | --- | --- | --- |
| `R-TERM-002` Project | 项目 | 不用项目名称暗示授权，也不将项目外聊天称为无效会话 | [工作台](../products/workbench/README.md)、[身份与所有权](../people-and-agents/identity-and-ownership.md) |
| `R-TERM-003` Thread | 聊天；核对技术身份时用会话 | 一段聊天不等于一次执行。标题、头像不能替代 Thread 身份 | [身份与所有权](../people-and-agents/identity-and-ownership.md#会话身份与执行职责) |
| `R-TERM-004` Turn | 轮次 | 用户输入、过程与回答按所属轮次组织，不能将每个工具调用称为一次聊天 | [任务推进与过程阅读](../patterns/task-progress.md)、[Core API](../../docs/api/core.md) |
| `R-TERM-007` Goal | 目标 | 不把用户一句目标描述当作已经创建 Goal，不把轮次结束当作目标完成 | [身份与所有权](../people-and-agents/identity-and-ownership.md#会话身份与执行职责)、[Task API](../../docs/api/tasks.md#所有权与模式) |
| Fork | 分支聊天 | 历史来源不表示父子 Agent 关系或继承正在执行的工作 | [身份与所有权](../people-and-agents/identity-and-ownership.md#三种关系分别表达) |
| Side Chat | 旁路讨论 | 查看参考内容与执行主任务分开，带回内容只追加主聊天草稿 | [上下文与证据](../people-and-agents/context-and-evidence.md) |
| `R-TERM-009` Approval | 审批 | 区分允许一次与记住授权范围，不用“确认”覆盖不同承诺 | [控制与审批](../people-and-agents/control-and-approval.md#审批针对明确的操作) |
| Context | 上下文 | 预计输入占用与已经发生的实际用量分开 | [上下文与证据](../people-and-agents/context-and-evidence.md#上下文容量与实际用量) |

## 同一位置保持同一称呼

`R-TERM-010` 导航、标题、按钮和反馈中的对象称呼保持一致。操作需要限定范围时直接带上对象，如“暂停安排”或“停止本次执行”。单独的“停止”只有在上下文已明确目标时使用。

本页是用词建议，不重命名协议字段或要求批量替换现有字符串。修改具体入口时，核对该入口的真实对象、现有翻译与合法动作，再采用一致称呼。
