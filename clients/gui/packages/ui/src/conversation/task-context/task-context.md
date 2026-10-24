---
id: task-context
title: TaskContext
summary: 顶部按钮打开的任务上下文卡片，组织变更、项目、子任务和输入来源。
status: experimental
entry: wip
layer: conversation
category: context
aliases: ["任务上下文卡片"]
related: ["subagent-panel", "image-disclosure", "disclosure"]
---

# TaskContext 任务上下文

## 何时使用

需要核对当前工作涉及的对象或输入时，从对话顶部按钮打开。它是任务上下文卡片；文件、网页或子任务历史的阅读器是另一用途。

## 组成

具名 aside、标题、actions、可选返回、纵向滚动正文；Section 分区，Item 命名动作与次信息，Sources 负责三项预览/查看全部/添加入口。id、hidden 和 onKeyDown 由宿主接线。

## 状态

产品顶部卡片默认收起，组件不自行决定开关。按钮 expanded/controls 对应同一 id；打开后保留来源折叠选择。Sources 初始展开，空集合明确显示空态。

## 行为

顶部按钮切换，Escape 关闭并回到入口；非模态不锁定正文或清空草稿。进入子代理历史暂收起卡片，关闭阅读器后恢复。宽窗有限高度卡片，窄窗单独阅读。

## 内容

Changes 明确统计范围，不把工作区修改全部归 Agent。关联项目来自真实关系，子任务状态独立。来源用原 id 区分，图片/网页/文件只是引用类型，不意味着已抓取全文。

## 可访问性

宿主通过 headingRef 聚焦详情，返回原入口；标题是入口消失时的回退。Sources 提供 expanded/controls 和独立添加按钮；隐藏卡片不留可聚焦内容。

## 规则

来源默认最多三项，超过提供带总数的全部入口。onAdd可选；宿主没有合法添加动作时不渲染加号，不能用空回调伪装能力。宿主拥有数据、草稿与导航，组件不扫描项目、维护 Core 状态或读取凭据。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-task-context)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
