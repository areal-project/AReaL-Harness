---
id: question-card
title: QuestionCard
summary: 聚焦一个问题的选择卡；选中与提交分离，长选项完整可读。
status: experimental
entry: wip
layer: conversation
category: decision
aliases: ["Ask User", "问题卡片", "追问"]
related: ["decision-card", "textarea", "button"]
---

# QuestionCard 问题卡片

## 何时使用

展示当前需要回答的问题及选项。是否必答、自由回答、导航、提交与核对均沿宿主真实契约。

## 组成

DecisionCard、聚焦标题、原生radio列表、宿主提供的头部/页脚/反馈插槽。titleRef供宿主按题目切换恢复焦点。

## 状态

未选、已选、禁用/处理中；业务未确认和已受理由宿主投影，不能显示为已完成。

## 行为

选择只触发onSelect，不自动提交。发送由宿主明确动作完成。收起保留草稿，不伪造Core不支持的跳过答案。

## 内容

问题和选项完整换行；一个视图聚焦一题，多题进度与导航由宿主提供。必要操作留在正文滚动区外。

## 可访问性

fieldset引用当前标题，radio保留键盘行为。状态不只依赖颜色，数字为辅助显示。长内容、18px和窄容器保持可达。

## 规则

实验入口采用conversation.css；不包含Core类型、请求或已保存偏好。与审批共享展示外壳，合法动作和回答状态继续由AskUserQuestion拥有。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-question-card)与[决策预览](../../../../../renderer/design-system.html?content-system)使用同一包内组件。
