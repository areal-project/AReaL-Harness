---
id: feedback-notice
title: FeedbackNotice
summary: 带恢复动作与详情的持久状态。
status: experimental
entry: experimental
layer: core
category: composition
aliases: ["带恢复动作与详情的持久状态"]
related: ["button"]
exports: ["FeedbackNotice"]
---

# FeedbackNotice 带恢复动作与详情的持久状态

## 何时使用

`R-FEEDBACKNOTICE-001` 带恢复动作与详情的持久状态。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖FeedbackNotice；完整Props从同目录生成TS API读取。

## 状态

引用 [R-UI-COMMON-005](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-014](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-006](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-007](../../../README.md#共同合同)。

## 规则

`R-FEEDBACKNOTICE-002` 这是底层纯展示表面。生产 renderer 适配默认在所属输入项或面板显示；仅跨页面故障或需要立即处理的事实显式传入 transient，经 ToastHost 显示短时 NotificationToast。恢复入口留在原流程，不能仅凭错误等级决定通知。系统自行处理的进度和普通成功不调用通知。组件不核对请求、不重试未知操作。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-feedback-notice)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
