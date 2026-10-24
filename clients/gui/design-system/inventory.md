# 组件与页面目录

此目录登记拥有者和覆盖，不复制组件 API 或所有页面文件名。路径指向生产代码；“已有”表示已在源码存在，不能推导真实服务、桌面或安装包验收通过。

<!-- BEGIN GENERATED: components -->

## 生产组件（生成）

| ID | 生产所有者 | 用途 |
| --- | --- | --- |
| Button | [Button](../packages/ui/src/components/button/button.tsx) | 基础按钮与有限变体 |
| ActionButton | [ActionButton](../packages/ui/src/components/action-button/action-button.tsx) | 普通紧凑操作与 pending |
| Switch | [Switch](../packages/ui/src/components/switch/switch.tsx) | 双向布尔值 |
| Select | [Select](../packages/ui/src/components/select/select.tsx) | 多个候选中的单选 |
| SettingsPage | [SettingsPage](../packages/ui/src/settings/settings-page/settings-page.tsx) | 设置页面的生产表面、列宽与滚动边界 |
| SettingsSection | [SettingsSection](../packages/ui/src/settings/settings-section/settings-section.tsx) | 功能分区 |
| SettingsGroupCard | [SettingsGroupCard](../packages/ui/src/settings/settings-group-card/settings-group-card.tsx) | 相关行的公共外框 |
| SettingsRow | [SettingsRow](../packages/ui/src/settings/settings-row/settings-row.tsx) | 名称、说明与行内控件 |
| SettingsSelect | [SettingsSelect](../packages/ui/src/settings/settings-select/settings-select.tsx) | 二值分段或多值菜单 |
| SettingsSegmentedTabs | [SettingsSegmentedTabs](../packages/ui/src/settings/settings-segmented-tabs/settings-segmented-tabs.tsx) | 两个互斥设置值 |
| SettingsDisclosure | [SettingsDisclosure](../packages/ui/src/components/settings-disclosure/settings-disclosure.tsx) | 显式展开/收起详情 |
| SettingsDialog | [SettingsDialog](../packages/ui/src/settings/settings-dialog/settings-dialog.tsx) | 设置编辑与确认详情 |
| Feedback | [Feedback](../renderer/src/components/ui/feedback.tsx) | 错误与状态反馈 |
| EmptySettings | [EmptySettings](../packages/ui/src/settings/settings-dialog/settings-dialog.tsx) | 设置空态 |
| ConversationComposer | [ConversationComposer](../renderer/src/ConversationComposer.tsx) | 主与 Side 的输入组合 |
| ComposerSurface | [ComposerSurface](../packages/ui/src/conversation/composer-surface/composer-surface.tsx) | 输入区布局插槽 |
| DecisionCard | [DecisionCard](../packages/ui/src/conversation/decision-card/decision-card.tsx) | 决策布局插槽 |
| ApprovalRequest | [ApprovalRequest](../renderer/src/ApprovalRequest.tsx) | 具体审批交互 |
| Messages | [Messages](../renderer/src/Messages.tsx) | 共享消息投影 |
| TurnExecution | [TurnExecution](../renderer/src/TurnExecution.tsx) | 过程状态 |
| ToolEvent | [ToolEvent](../renderer/src/ToolEvent.tsx) | 工具事件 |
| CollapsibleText | [CollapsibleText](../packages/ui/src/conversation/collapsible-text/collapsible-text.tsx) | 长文本渐进展示 |
| SideChatPane | [SideChatPane](../renderer/src/SideChatPane.tsx) | 辅助会话组合 |
| TurnProgress | [TurnProgress](../renderer/src/TurnProgress.tsx) | 保留子项身份与人工选择的过程总组 |
| CommandDetails | [CommandDetails](../packages/ui/src/conversation/command-details/command-details.tsx) | 同一进程的输入、连续输出、状态与原始记录 |
| AgentConversationPane | [AgentConversationPane](../renderer/src/AgentConversationPane.tsx) | 绑定父子身份的独立子对话阅读 |
| SentAttachment | [SentAttachment](../renderer/src/MessageAttachment.tsx) | 已发送媒体的生产预览与关闭返回 |
| SettingsNavigation | [SettingsNavigation](../packages/ui/src/workbench/settings-navigation/settings-navigation.tsx) | 定位、筛选设置分类并沿原导航守卫返回 |
| SidePane | [SidePane](../renderer/src/app-shell/SidePane.tsx) | 窗口局部的面板标签、视图切换与关闭焦点；资源生命周期沿原所有者 |
| SettingsSearchInput | [SettingsSearchInput](../packages/ui/src/settings/settings-search-input/settings-search-input.tsx) | 带可读清除动作的资源搜索输入 |

<!-- END GENERATED: components -->

## 覆盖与缺口

| 范围 | 当前状态 | 后续修改时的边界 |
| --- | --- | --- |
| Composer / DecisionCard / Side / Feedback CSS | 已有 Token 检查 | 沿用当前 `verify:design`；检查范围外不能宣称自动防漂移 |
| 设置动作、Switch、二值/多值、详情 | 已有公共组件及预览 | 新增消费必须复用；页面迁移仍逐页验收 |
| 长文本、对话时间线 | 已有共享组件、静态预览与逐步投影题；目标见[信息流合同](patterns.md#对话信息流) | renderer题之外，E1已在隔离Electron/Core/Runtime覆盖命令、子代理、图片返回、阅读、完成、暂停UNKNOWN核查与GUI重开；供应商、原生视图和完整恢复矩阵仍未覆盖 |
| 资源列表与所有设置页面 | 组合规则已定义，未全量迁移 | 不虚构统一列表 API；只有本次修改触及的页面进入验收 |
| 结构化目录、页面合同、派生文档/预览目录 | 已接入 verify:design | 只核对引用、最低字段和生成一致性；不证明运行或 JSX 依从 |
| 全局 CSS、Tailwind 任意值、间接 inline style | 未全量自动覆盖 | 人工检查 owned diff；不通过增加豁免掩盖漂移 |
| Windows / Linux / Remote / 原生预览 | E4另验macOS同应用窗口往返及一个独立原生网页，保留内容/交互/隐藏证据 | 不能据此证明其它平台、跨应用/显示器、候选浮窗或原生文件预览 |

E1 真实对话、E2 指定连续动效及 E3 指定窗口/焦点/原生组合输入与新内容切片已有有界验收；E4补充原生网页与同应用窗口切片；独立候选窗口及完整 Electron 宿主、未关闭动效差异的后续覆盖按[推进计划](roadmap.md)执行；计划阶段不能写为当前已通过范围。

新增公共组件或页面模式时维护 `registry.json`，再运行 `design:sync` 更新本目录；只有一个特定页面需要的局部布局留在原所有者，避免“为了统一”增加无消费者的封装。

输入表面的几何、模型入口基本样式归 ComposerSurface.css；App 显式选择满屏资源下的 compact，Side 保持 default。SidePane 的标签/视图仍为窗口局部状态。共享路径与有界检查见[组合说明](exercises/shared-workspace.md)。
