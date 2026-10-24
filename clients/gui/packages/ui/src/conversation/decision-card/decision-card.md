---
id: decision-card
title: DecisionCard
summary: 审批和问答的决策表面。
status: experimental
entry: wip
layer: conversation
category: composition
aliases: ["审批和问答的决策表面"]
related: ["button"]
exports: ["DecisionCard"]
---

# DecisionCard 审批和问答的决策表面

## 何时使用

审批和问答的决策表面。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖DecisionCard；完整Props从同目录生成TS API读取。

## 状态

默认、内容增长、禁用/忙碌（由宿主提供）、明暗与不同字号；展示更新保留原身份与阅读状态。

## 行为

默认只展示关键信息：审批原因最多三行、目标一行、命令最多两行；浏览器命令与终端命令遵守同一规则。长参数和完整原文放默认折叠details，展开后在有界正文内纵向滚动，页脚位于滚动正文外。保留原实现和键盘/焦点/滚动语义。原renderer适配提供翻译、偏好与合法动作；UI包只呈现与管理本地交互。

## 内容

宿主必须把完整原因、补充说明、目的、目标和命令保留在详情中；摘要裁切不改变原请求或提交参数。提问标题和选项仍完整换行，不能直接套用审批摘要裁切。名称、原因与结果来自宿主事实；未确认不能显示为成功，短时通知不替代原始结果与恢复动作。

## 可访问性

真实控件保留label、aria、ref和键盘入口。18px字号和窄窗保持内容可读，焦点不因重新包装而丢失。

## 规则

审批、问答草稿、提交锁、UNKNOWN核对和动作合法性归原ApprovalRequest/AskUserQuestion。组件提供header/body/details/feedback/footer插槽，details默认折叠且不卸载原始参数；输入法和Esc仍沿宿主处理。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-decision-card)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
