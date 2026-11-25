# 界面术语

> 机器检查词典唯一真源：[terminology.json](../../clients/gui/design-system/terminology.json)（由 `clients/gui/scripts/terms-lint.mjs` 在 CI 中强制校验，包含禁用同义词与 UX Writing 铁律）。

| 对象 | 界面称呼建议 | 避免歧义 | 详细来源 |
| --- | --- | --- | --- |
| `R-TERM-003` Thread | 会话 | 一段会话不等于一次执行。标题、头像不能替代 Thread 身份 | [身份与所有权](../people-and-agents/identity-and-ownership.md#会话身份与执行职责) |
| `R-TERM-004` Turn | 轮次 | 用户输入、过程与回答按所属轮次组织，不能将每个工具调用称为一次会话 | [任务推进与过程阅读](../patterns/task-progress.md)、[Core API](../../docs/api/core.md) |
| Fork | 分支会话 | 历史来源不表示父子 Agent 关系或继承正在执行的工作 | [身份与所有权](../people-and-agents/identity-and-ownership.md#三种关系分别表达) |
| Side Chat | 侧边聊天 | 查看参考内容与执行主任务分开，带回内容只追加主会话草稿 | [上下文与证据](../people-and-agents/context-and-evidence.md) |
| Schedule | 定时任务 | 定时发起的工作安排，与自动化、定时安排区分 | [GLOSSARY](../../GLOSSARY.md) |
| Subagent | 子代理 | 主执行者委派的子代理，与子智能体区分 | [GLOSSARY](../../GLOSSARY.md) |
| Skill | Skills | 使用英文 Skills 称呼，与中文“技能”区分 | [GLOSSARY](../../GLOSSARY.md) |
| Bot | Bot | 使用英文 Bot 称呼，与 Personal Agent、私人助理区分 | — |
| Context | 上下文 | 预计输入占用与已经发生的实际用量分开 | [上下文与证据](../people-and-agents/context-and-evidence.md#上下文容量与实际用量) |

## 同一位置保持同一称呼

本页是用词建议，不重命名协议字段或要求批量替换现有字符串。修改具体入口时，核对该入口的真实对象、现有翻译与合法动作，再采用一致称呼。
