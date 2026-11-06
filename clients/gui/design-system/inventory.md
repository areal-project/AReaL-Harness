# 组件与页面目录

`R-CATALOG-001` 此目录登记拥有者和覆盖，不复制组件 API 或所有页面文件名。路径指向生产代码；“已有”表示已在源码存在，不能推导真实服务、桌面或安装包验收通过。

<!-- BEGIN GENERATED: components -->

## 生产组件（生成）

用途和完整事实归 [registry.json](registry.json) 的 `components`；行为归就近合同。

| 生产成员与源码 |
| --- |
| [Button](../packages/ui/src/components/button/button.tsx) |
| [ActionButton](../packages/ui/src/components/action-button/action-button.tsx) |
| [Switch](../packages/ui/src/components/switch/switch.tsx) |
| [Select](../packages/ui/src/components/select/select.tsx) |
| [SettingsPage](../packages/ui/src/settings/settings-page/settings-page.tsx) |
| [SettingsSection](../packages/ui/src/settings/settings-section/settings-section.tsx) |
| [SettingsGroupCard](../packages/ui/src/settings/settings-group-card/settings-group-card.tsx) |
| [SettingsRow](../packages/ui/src/settings/settings-row/settings-row.tsx) |
| [SettingsSelect](../packages/ui/src/settings/settings-select/settings-select.tsx) |
| [SettingsSegmentedTabs](../packages/ui/src/settings/settings-segmented-tabs/settings-segmented-tabs.tsx) |
| [SettingsDisclosure](../packages/ui/src/components/settings-disclosure/settings-disclosure.tsx) |
| [SettingsDialog](../packages/ui/src/settings/settings-dialog/settings-dialog.tsx) |
| [Feedback](../renderer/src/components/ui/feedback.tsx) |
| [EmptySettings](../packages/ui/src/settings/settings-dialog/settings-dialog.tsx) |
| [ConversationComposer](../renderer/src/ConversationComposer.tsx) |
| [ComposerSurface](../packages/ui/src/conversation/composer-surface/composer-surface.tsx) |
| [DecisionCard](../packages/ui/src/conversation/decision-card/decision-card.tsx) |
| [ApprovalRequest](../renderer/src/ApprovalRequest.tsx) |
| [Messages](../renderer/src/Messages.tsx) |
| [TurnExecution](../renderer/src/TurnExecution.tsx) |
| [ToolEvent](../renderer/src/ToolEvent.tsx) |
| [CollapsibleText](../packages/ui/src/conversation/collapsible-text/collapsible-text.tsx) |
| [SideChatPane](../renderer/src/SideChatPane.tsx) |
| [TurnProgress](../renderer/src/TurnProgress.tsx) |
| [CommandDetails](../packages/ui/src/conversation/command-details/command-details.tsx) |
| [AgentConversationPane](../renderer/src/AgentConversationPane.tsx) |
| [SentAttachment](../renderer/src/MessageAttachment.tsx) |
| [SettingsNavigation](../packages/ui/src/workbench/settings-navigation/settings-navigation.tsx) |
| [SidePane](../renderer/src/app-shell/SidePane.tsx) |
| [SettingsSearchInput](../packages/ui/src/settings/settings-search-input/settings-search-input.tsx) |
| [TaskContext](../packages/ui/src/conversation/task-context/task-context.tsx) |

<!-- END GENERATED: components -->

## 覆盖与缺口

| 范围 | 当前状态 | 后续修改时的边界 |
| --- | --- | --- |
| `R-CATALOG-002` Composer / DecisionCard / Side / Feedback CSS | 已有 Token 检查 | 沿用当前 `verify:design`；检查范围外不能宣称自动防漂移 |
| `R-CATALOG-003` 设置动作、Switch、二值/多值、详情 | 已有公共组件及预览 | 新增消费必须复用；页面迁移仍逐页验收 |
| 长文本、对话时间线 | 已有共享组件、静态预览与逐步投影题；目标见[信息流合同](patterns.md#对话信息流) | renderer题之外，E1已在隔离Electron/Core/Runtime覆盖命令、子代理、图片返回、阅读、完成、暂停UNKNOWN核查与GUI重开；供应商、原生视图和完整恢复矩阵仍未覆盖 |
| 资源列表与所有设置页面 | 组合规则已定义，未全量迁移 | 不虚构统一列表 API；只有本次修改触及的页面进入验收 |
| 结构化目录、页面合同、派生文档/预览目录 | 已接入 verify:design | 只核对引用、最低字段和生成一致性；不证明运行或 JSX 依从 |
| 全局 CSS、Tailwind 任意值、间接 inline style | 未全量自动覆盖 | 人工检查 owned diff；不通过增加豁免掩盖漂移 |
| Windows / Linux / Remote / 原生预览 | E4另验macOS同应用窗口往返及一个独立原生网页，保留内容/交互/隐藏证据 | 不能据此证明其它平台、跨应用/显示器、候选浮窗或原生文件预览 |

E1 真实对话、E2 指定连续动效及 E3 指定窗口/焦点/原生组合输入与新内容切片已有有界验收；E4补充原生网页与同应用窗口切片；独立候选窗口及完整 Electron 宿主、未关闭动效差异的后续覆盖按[推进计划](../../../design/archive/gui/roadmap.md)执行；计划阶段不能写为当前已通过范围。
