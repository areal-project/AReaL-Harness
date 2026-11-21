---
id: activity-row
title: ActivityRow
summary: 对话时间线里的一条活动事实：图标、动作与对象、必要状态和展开箭头。
status: stable
entry: compositions
layer: conversation
category: activity
aliases: ["活动行", "工具调用行"]
related: ["activity-group", "image-disclosure"]
exports: ["ActivityRow", "ActivityRowButton", "ActivityRowText", "ActivityRowStatus", "ActivityRowChevron", "ActivityRowHint"]
---

# ActivityRow 活动行

## 何时使用

读取、命令、编辑、工具调用和思考摘要在对话时间线里各占一行时使用。整行只做一件事（展开自己的详情）用 `ActivityRowButton`；一行里有多个独立动作（打开文件、看差异、看原始记录）用 `ActivityRow`，动作各自是按钮。多条连续活动的折叠交给 [ActivityGroup](../activity-group/activity-group.md)。

## 组成

以部件组合代替 `kind` 开关：`ActivityRow` / `ActivityRowButton` 是行本身，`icon` 放行首图标；`ActivityRowText` 放动作和对象；`ActivityRowStatus` 放完成以外的结果；`ActivityRowChevron` 放展开箭头；`ActivityRowHint` 给被缩短的对象（含文件链接按钮）加完整值提示。新增一种行就是新增一种组合。

## 状态

常态、悬停、键盘焦点、展开、运行中（`ActivityRowText running`）、失败或待确认（`ActivityRowStatus` 可见）。已完成和运行中的状态文字只给读屏（`hidden`）。

## 行为

`R-ACTIVITYROW-001` 动作完整显示，对象在宽度不够时先省略；完整对象由详情或原资源阅读器提供。**为什么：**动作说明发生了什么，对象只是定位用；先截动作会让一列活动无法扫读。**推广：**新增的文字部件也遵循“动词不截、宾语可截”。**检查：**人工 review。

## 内容

动作和对象来自宿主的真实投影（`conversationPresentation.ts`）；组件只负责排版。

`R-ACTIVITYROW-005` 读取和编辑行说明是哪个文件，打开文件、查看本次差异和查看原始记录是各自独立的按钮；文件当前内容与当时的读取回执来源不同，分开呈现。**为什么：**同一对象的不同动作合成一个按钮时，用户无法预期点击结果。**推广：**一行里出现第二个动作时改用 `ActivityRow`，每个动作一个按钮。**检查：**人工 review。

`R-ACTIVITYROW-006` 文件和目录行只写末段名称，完整路径和完整命令放在 `detailHint` 悬停提示里；展开详情仍给出完整值。**为什么：**一列活动要能扫读，全路径挤占宽度；但用户需要随时确认动的是哪一个文件。**推广：**任何被缩短的对象都给出完整值提示。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

## 可访问性

`R-ACTIVITYROW-002` 箭头只在悬停、键盘焦点或展开时出现，方向表达开合；开合状态由宿主按钮的 `aria-expanded` 表达，不靠图形。**为什么：**一列活动里常驻箭头是噪音，但键盘用户要能看到焦点所在行可以展开。**推广：**行内其他次要控件也按“悬停或焦点出现”处理。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

## 规则

`R-ACTIVITYROW-003` 尺寸、间距、字号和颜色只引用 Token（`activity-*`、`text-conversation`、`conversation-line`、`color-*`），组件 CSS 不写像素字面量。**为什么：**数值曾在 md、组件 CSS、应用 CSS 和外部画布四处各写一份，来回改了两次。**推广：**需要新数值时先在 `tokens.json` 增加 Token，再引用。**检查：**`clients/gui/design-system/verified-components.json`

`R-ACTIVITYROW-004` 宿主不覆盖 `.areal-activity-*` 内部样式；需要不同外观时给组件增加部件或 Token。**为什么：**宿主覆盖会让同一组件在主聊天、子任务历史和预览里长得不一样。**推广：**适用于 `clients/gui/design-system/verified-components.json` 登记的所有组件。**检查：**`clients/gui/design-system/verified-components.json`

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-activity-row)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。生产消费者是 `renderer/src/ToolEvent.tsx` 与 `renderer/src/ReasoningGroup.tsx`。
