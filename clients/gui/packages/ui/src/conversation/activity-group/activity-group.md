---
id: activity-group
title: ActivityGroup
summary: 默认收起连续活动，纵向阅读原记录，关键状态始终可见。
status: experimental
entry: experimental
layer: conversation
category: activity
aliases: ["活动组"]
related: ["activity-row", "disclosure", "image-disclosure", "thinking-status"]
---

# ActivityGroup 活动分组

## 何时使用

`R-ACTIVITYGROUP-001` 同一轮、同一项目内连续工具活动的按需阅读；单条活动用 `presentation="inline"` 直接呈现，数量增长后切回 `collapsible`，保持同一实例和子记录身份。不跨用户消息、助手说明或最终回答合并，不混合不同轮次或项目。

分段规则与标题文字由宿主投影决定，唯一来源是 [CONV-ACTIVITY-01](../../../../../renderer/src/Messages.md#对话信息流) 及其行为表；本组件只负责呈现。

## 组成

`R-ACTIVITYGROUP-002` 具名摘要、可聚焦的有界滚动区、折叠外的 status 插槽。children 是 [ActivityRow](../activity-row/activity-row.md) 或图片入口，保留原顺序；实际分组与事件身份归宿主投影。

`R-ACTIVITYGROUP-032` 摘要与活动行同为一行对话文字高（`--text-conversation` × `--conversation-line`），相邻活动组之间隔 `--conversation-gap`。摘要不加底色，展开与否只由箭头方向表达。展开后子项与摘要左缘对齐，子项之间隔 `--spacing-inline`；每个子项保留自己的行首图标，混合的读取、搜索与命令靠图标区分。

`R-ACTIVITYGROUP-033` 行首图标使用 `ActivityIcon` 活动图形集，尺寸为 `--activity-icon-size`，箭头为 `--activity-chevron-size`。没有语义类别的插件或 MCP 工具使用通用工具图形，名称仍显示真实工具名。

## 状态

`R-ACTIVITYGROUP-003` 默认收起；手动选择在同一实例中保留，追加输出、完成事件或父组收起都不重置展开。切换项目、会话或轮次时读取该对象自身的状态。收起只是阅读动作，不停止、重试或恢复执行。open 与 onOpenChange 交给宿主管理选择，可在历史页卸载后按同一活动组身份恢复；不传 open 时保留本实例的默认行为。

`R-ACTIVITYGROUP-024` 待审批、失败、UNKNOWN 和未结算的状态与合法入口放在 status 插槽，收起时仍可发现。**为什么：**关键决定不能藏在待展开的日志里。**推广：**任何需要用户处理的结果都放在折叠之外。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

## 行为

`R-ACTIVITYGROUP-004` 列表只纵向滚动，高度上限为 `--activity-list-max-height`，摘要不随列表滚走。每个区域只有一个滚动所有者；长命令和输出按需进入既有详情区域，不再套多层滚动。

`R-ACTIVITYGROUP-028` 活动摘要可截断，展开详情必须能读全；长命令、路径、URL 和无空格输出在可用宽度内换行。**为什么：**截断是为了扫读，不能以丢失内容为代价。**推广：**新增的详情部件同样只纵向增长。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

`R-ACTIVITYGROUP-029` 不能仅隐藏横向滚动条而裁掉内容；活动列表及其内嵌命令正文不产生横向滚动，也不撑宽主聊天。**为什么：**隐藏滚动条会让超出部分永远读不到。**推广：**适用于活动组内的所有嵌套内容。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

## 内容

`R-ACTIVITYGROUP-005` 摘要使用真实类型和数量（如“已探索 · 4 个文件，1 个目录”“已运行 3 条命令”），没有准确计数就省略那一项。模型过程摘要使用 [ThinkingStatus](../thinking-status/thinking-status.md)，不替代执行结果。

## 可访问性

`R-ACTIVITYGROUP-006` 沿 Disclosure 键盘语义，Enter/Space 切换并暴露 expanded；滚动区可聚焦。**为什么：**活动组是最常用的阅读入口，键盘用户与鼠标用户要有同样的路径。**推广：**新增的展开入口都使用 Disclosure 或原生按钮。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

## 规则

`R-ACTIVITYGROUP-007` 使用原事件 ID 作 key；对象切换重建，状态更新保持身份。尺寸只引用 Token，宿主不覆盖 `.areal-activity-*` 内部样式。**为什么：**同一组件在主聊天、子任务历史和预览里要长得一样。**推广：**需要不同外观时给组件加部件或 Token。**检查：**`clients/gui/design-system/verified-components.json`

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-activity-group)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
