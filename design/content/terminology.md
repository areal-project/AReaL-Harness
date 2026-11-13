# 界面术语

| 对象 | 界面称呼建议 | 避免歧义 | 详细来源 |
| --- | --- | --- | --- |
| `R-TERM-003` Thread | 聊天；核对技术身份时用会话 | 一段聊天不等于一次执行。标题、头像不能替代 Thread 身份 | [身份与所有权](../people-and-agents/identity-and-ownership.md#会话身份与执行职责) |
| `R-TERM-004` Turn | 轮次 | 用户输入、过程与回答按所属轮次组织，不能将每个工具调用称为一次聊天 | [任务推进与过程阅读](../patterns/task-progress.md)、[Core API](../../docs/api/core.md) |
| Fork | 分支聊天 | 历史来源不表示父子 Agent 关系或继承正在执行的工作 | [身份与所有权](../people-and-agents/identity-and-ownership.md#三种关系分别表达) |
| Side Chat | 旁路讨论 | 查看参考内容与执行主任务分开，带回内容只追加主聊天草稿 | [上下文与证据](../people-and-agents/context-and-evidence.md) |
| Context | 上下文 | 预计输入占用与已经发生的实际用量分开 | [上下文与证据](../people-and-agents/context-and-evidence.md#上下文容量与实际用量) |

## 同一位置保持同一称呼

本页是用词建议，不重命名协议字段或要求批量替换现有字符串。修改具体入口时，核对该入口的真实对象、现有翻译与合法动作，再采用一致称呼。
