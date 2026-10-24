---
id: feedback-notice
title: FeedbackNotice
summary: 带恢复动作与详情的持久状态。
status: experimental
entry: wip
layer: core
category: composition
aliases: ["带恢复动作与详情的持久状态"]
related: ["button"]
exports: ["FeedbackNotice"]
---

# FeedbackNotice 带恢复动作与详情的持久状态

## 何时使用

带恢复动作与详情的持久状态。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖FeedbackNotice；完整Props从同目录生成TS API读取。

## 状态

默认、内容增长、禁用/忙碌（由宿主提供）、明暗与不同字号；展示更新保留原身份与阅读状态。

## 行为

保留原实现和键盘/焦点/滚动语义。原renderer适配提供翻译、偏好与合法动作；UI包只呈现与管理本地交互。

## 内容

名称、原因与结果来自宿主事实；未确认不能显示为成功，短时通知不替代原始结果与恢复动作。

## 可访问性

真实控件保留label、aria、ref和键盘入口。18px字号和窄窗保持内容可读，焦点不因重新包装而丢失。

## 规则

这是底层纯展示表面，不用于新的操作通知。生产renderer适配默认经ToastHost显示统一短时NotificationToast，包含核对动作；真正的任务事实由原专用状态组件呈现。组件不核对请求、不重试未知操作。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-feedback-notice)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
