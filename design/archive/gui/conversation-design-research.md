# 冻结研究与固定题目记录

2026-10-24 的参考研究与早期源码核对。后文生产接线已记录后续实现；现行活动、上下文及非模态规则归对应组件合同。

## 研究后的优化选择

<!-- rule:R-CONVERSATION-005 -->
再调研资料及事实/推断边界见[参考记录](reference-observations.md#2026-10-24-过程摘要上下文卡片与组件文档再调研)。这版是基于反馈与研究的候选改进，不代表完整或最佳Codex复刻。

| 问题 | 优化决定 | 可观察结果 |
| --- | --- | --- |
| <!-- rule:R-CONVERSATION-006 --> Thinking被误当成唯一过程内容 | 优先呈现公开模型摘要，无摘要才回退；文字更新局部过渡，扫光附着于当前文字 | 切换与推进样例可看到新文字；长摘要换行；等待/未知不冒充正在思考 |
| 上下文卡片与资源面板混为一体 | 顶部开关控制有限高度卡片；子代理历史是独立阅读区 | 初始不占右列，expanded/controls一致，Escape回入口；进入历史暂收卡片，关闭后恢复 |
| <!-- rule:R-CONVERSATION-007 --> 连续更新打断阅读或混淆权限 | 摘要不抢焦点、不定时生成、不推断执行结果；原活动记录独立保留 | 更新不提交/重试，来源/草稿/子任务选择不随文字变化重置 |
| <!-- rule:R-CONVERSATION-008 --> MD存在但像薄说明书、在站点不可见 | 实现旁MD维护完整结构与元数据；站点显示关联、原文与该组件的独立示例 | 每份目录组件可找到同目录MD、用途与状态、类型API和可操作例子，生成检查拒绝缺失结构 |

引用 [R-CONVERSATION-009](../../../clients/gui/packages/ui/src/conversation/task-context/task-context.md#非模态阅读)。

<!-- rule:R-CONVERSATION-010 -->
宿主适配位于 [ConversationSystemPreview](../../../clients/gui/renderer/src/design-system/ConversationSystemPreview.tsx)，固定数据位于 [conversationSystemScenario](../../../clients/gui/renderer/src/design-system/conversationSystemScenario.ts)。活动、图片和右侧基本外观已由私有包的实验对话组件提供；本地 CSS 仅保留页面布局与 ToolEvent/SentAttachment 适配。复用原 CommandDetails、ConversationComposer 和 WorkbenchShell。图片来自既有仓库示例，文件/网页/变更/子任务详情是本地说明，不读取真实项目、不执行命令、不连接 Core 或供应商。

| 实验组件 | 就近规范 | 预览实践 |
| --- | --- | --- |
| <!-- rule:R-CONVERSATION-011 --> ActivityGroup | [活动分组合同](../../../clients/gui/packages/ui/src/conversation/activity-group/activity-group.md) | 30项原 ToolEvent，纵向滚动、增量/完成保留展开、折叠外状态 |
| <!-- rule:R-CONVERSATION-012 --> ImageDisclosure | [图片折叠合同](../../../clients/gui/packages/ui/src/conversation/image-disclosure/image-disclosure.md) | 默认收起、原图片查看器、引用不可用仍保留反馈 |
| <!-- rule:R-CONVERSATION-013 --> TaskContext | [上下文合同](../../../clients/gui/packages/ui/src/conversation/task-context/task-context.md) | Section/Item/Sources 组合变更、项目、子任务、来源；宿主返回与草稿保留 |
| SubagentPanel | [子代理面板合同](../../../clients/gui/packages/ui/src/conversation/subagent-panel/subagent-panel.md) | 入口→分状态全部列表→子任务历史→原列表；过多完成项展开 |
| <!-- rule:R-CONVERSATION-014 --> ThinkingStatus | [思考提示合同](../../../clients/gui/packages/ui/src/conversation/thinking-status/thinking-status.md) | 左到右扫光、静态减少动效、不可见/后台停止 |

这些组件均从 `@areal/ui/experimental` 消费，独立样式为 `@areal/ui/conversation.css`。[UI 包预览](../../../clients/gui/renderer/design-system.html?ui-library)用普通活动文本、原生图片和本地动作独立消费同一组件，不加载 renderer 工作台样式。API、组件索引、Agent 索引和 Markdown 来自包构建，尚未提升为稳定入口或 Base 准入。

<!-- rule:R-CONVERSATION-015 -->
相关检查：`pnpm --dir clients/gui design:build`，然后 `pnpm --dir clients/gui test:design --conversation-system`。专项沿既有浏览器 runner 检查默认折叠、人工选择跨完成保留、纵向滚动、图片加载与查看、来源状态以及窄窗返回，保留截图与 manifest。浏览器结果不代表真实执行、完整应用生命周期、安装包或用户视觉认可；下面的目标合同仍需分别按实际覆盖验收。

## 依据与规则强度

| 依据 | 可以确定什么 | 不足以确定什么 |
| --- | --- | --- |
| <!-- rule:R-CONVERSATION-016 --> 用户提供的图一及六条标注 | 读取、运行命令、图片、子代理、编辑活动需要可辨识；活动图片与命令组默认收起；命令组可纵向滚动，不可横向滚动 | 图片实际展开过程、动效时长、精确尺寸、跨重启行为 |
| <!-- rule:R-CONVERSATION-017 --> 图二及四条标注 | 右侧包含 Changes、当前 Worktree 下关联的其他项目、Subagents、Sources；Sources 可折叠，默认列出三项并可查看全部；来源可以是图片、网页及其他输入 | 关联项目的数据合同、网页摄取与存储机制、来源删除权限 |
| <!-- rule:R-CONVERSATION-018 --> [Raft 本地源码核对](reference-observations.md#raft设计知识组件与产品分层) | 通用控件与领域组件分层；模式和产品布局分开；文档、参数、示例各有真实来源 | Raft 的聊天领域、字体和数值不自动成为 AReaL 规范 |
| <!-- rule:R-CONVERSATION-019 --> 当前生产源码 | 已有活动、详情、资源与父子对话的所有者，见下文映射 | 已有组件不代表本草案已经实现或通过验收 |

<!-- rule:R-CONVERSATION-020 -->
“用户要求”沿本轮标注执行；“设计默认”是为补齐规范提出的可调整选择。现有 [CONV 合同](../../../clients/gui/design-system/patterns.md#对话信息流)继续拥有执行、阅读、分组与返回约束；本草案补充候选形态，不复制一套规则 ID。正常完成时的过程总组收敛与这里的活动组默认收起是两个层级。

## 组件合同与实现所有者

| 设计词汇 | 当前所有者 | 本轮核实的事实与目标差异 |
| --- | --- | --- |
| <!-- rule:R-CONVERSATION-022 --> ActivityRow / ActivityGroup | [ToolEvent](../../../clients/gui/renderer/src/ToolEvent.tsx)、[TurnExecution](../../../clients/gui/renderer/src/TurnExecution.tsx)、[conversationPresentation](../../../clients/gui/renderer/src/conversationPresentation.ts) | 已有读取、编辑、命令、图片、子代理和混合摘要；单项可直接呈现，多项有展开区。默认值随轮次与结果变化，不能声称所有活动组已符合本稿 |
| <!-- rule:R-CONVERSATION-023 --> ProgressGroup / 阅读 | [Messages 合同](../../../clients/gui/renderer/src/Messages.md)、[TurnProgress](../../../clients/gui/renderer/src/TurnProgress.tsx) | 已有正常完成收敛与人工选择保护；本稿不把运行中过程总组改成默认关闭 |
| CommandDetails | [CommandDetails](../../../clients/gui/renderer/src/CommandDetails.tsx)、[workbench.css](../../../clients/gui/renderer/src/workbench.css) | 已分原命令、输出、结果与原始记录；活动列表已有高度上限，但展开命令或 Diff 时会解除上限，需后续按本稿核验滚动组合 |
| <!-- rule:R-CONVERSATION-024 --> ImageActivity | [ToolEvent](../../../clients/gui/renderer/src/ToolEvent.tsx)、[MessageAttachment](../../../clients/gui/renderer/src/MessageAttachment.tsx) | 当前 ToolEvent 图片预览在原始记录折叠区之外；“默认关闭图片”是待设计迁移项 |
| <!-- rule:R-CONVERSATION-025 --> SubagentEntry / SubagentsSection | [AgentIdentity](../../../clients/gui/renderer/src/AgentIdentity.tsx)、[AgentsPane](../../../clients/gui/renderer/src/AgentsPane.tsx)、[AgentConversationPane](../../../clients/gui/renderer/src/AgentConversationPane.tsx) | 已有父子身份、列表与子对话入口；摘要/展开形态需按本稿核对，不新增子任务生命周期 |
| <!-- rule:R-CONVERSATION-026 --> ContextSection / ChangesEntry / SourceEntry | [ConversationStatusCard](../../../clients/gui/renderer/src/ConversationStatusCard.tsx) | 当前变更读取 scope 为 unstaged；来源混列用户附件和已验证 fs_read 回执，未做本稿的三项预览与完整列表。不能把该读取范围称为全部变更 |
| <!-- rule:R-CONVERSATION-027 --> RelatedProjectEntry | 原 App 的项目/Worktree 关系与 [ConversationStatusCard](../../../clients/gui/renderer/src/ConversationStatusCard.tsx) | 本次核对的资源卡没有该区块；先明确已有关系能否提供数据，不从目录名称推断关联 |
| ContextRail / 返回 | [WorkbenchShell](../../../clients/gui/renderer/src/app-shell/WorkbenchShell.tsx)、[SidePane](../../../clients/gui/renderer/src/app-shell/SidePane.tsx)、[App](../../../clients/gui/renderer/src/App.tsx) | 沿原布局与面板归属；此处仅指定设计职责，不重构宿主或持久化 |

后续每个发生变化的组件合同按“用途/不适用 → 组成 → 有限变体 → 状态 → 打开、关闭、溢出与返回 → 内容 → 可访问性”维护；Props 从代码读，不手抄接口表。活动组合只接收原所有者的状态与合法动作，不创建新的历史 store。

## 后续样例与验收清单

<!-- rule:R-CONVERSATION-029 -->
以下是设计目录题目的输入与可观察结果。上述预览提供其中的代表状态；运行结果按实际覆盖报告，不把文档检查或单个样例算作整个矩阵通过。

| 样例 | 固定内容/动作 | 应观察到的结果 |
| --- | --- | --- |
| <!-- rule:R-CONVERSATION-030 --> 基础活动 | 两次读取、一次命令、一次编辑、一个图片活动、一个子代理；穿插助手说明 | 类型可辨、原顺序保留；连续活动才成组；图片/常规组默认收起，正文仍可读 |
| 混合长列表 | 三十项活动、超长无空格命令与路径、多批长输出 | 组可纵向滚动；无横向位移和裁字；详情可读全，复制保持原文；进入长详情不形成多层滚动陷阱 |
| <!-- rule:R-CONVERSATION-031 --> 人工展开与结算 | 运行中展开命令及图片，再追加输出、子任务完成、父任务完成 | 人工选择保留，父子状态独立，final 独立；收起父组后再开仍能找到原详情 |
| <!-- rule:R-CONVERSATION-032 --> 未决与异常 | 在已收起组内投影失败、待审批、UNKNOWN 和未退出进程 | 外层可发现准确状态与合法入口；不因 final、查看或刷新重放执行 |
| 右侧对象 | 一个当前项目、两个有真实关系的其他项目、三个不同状态子任务 | Changes 范围准确；关联项目不会混入全局最近项目，子任务数量与状态对应同一权威投影 |
| <!-- rule:R-CONVERSATION-033 --> 来源集合 | 零项、三项、四项；混合图片、网页和文件，含同名异源与不可用项 | 默认最多三项、超出可查看全部、可折叠返回；名称和归属可核对，不把生成图片误算为输入 |
| <!-- rule:R-CONVERSATION-034 --> 窄窗与返回 | 明/暗、内容/UI 大字号、长名称、打开资源后返回；键盘与减少动态效果 | 主阅读与发送可达，无页面横向溢出；草稿、阅读与合理焦点保留，不能靠缩小字体通过 |

后续先评价隔离样例，再按授权核对生产接线、真实状态与视觉差异。设计规范评审、目录预览、真实 Electron/Core 路径与安装包验收分别记录；当前生产页面保持原实现。
