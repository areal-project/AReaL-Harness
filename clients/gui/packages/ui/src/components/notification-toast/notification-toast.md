---
id: notification-toast
title: NotificationToast
summary: 顶部短时提示，以颜色和图标区分信息、成功、警告与错误。
status: experimental
entry: experimental
layer: core
category: feedback
aliases: ["短时等级提示"]
related: ["button"]
---

# NotificationToast 短时等级提示

## 何时使用

`R-NOTIFICATIONTOAST-001` 用于需要用户决策或采取行动的短时通知，须提供明确且必要的处理入口。普通成功与系统自行处理的状态不通知。正文、字段帮助和需要处理的任务状态仍由其原页面拥有。

## 组成

等级图标、message、可选actions和关闭按钮。requestId仅用于关联原请求。ToastHost提供顶部居中viewport，NotificationToast拥有倒计时与可读交互。

## 状态

info/success/warning/error；正常计时、悬停或键盘聚焦暂停、手动关闭、自动关闭。

## 示例

组件目录可触发四个等级、手动关闭、悬停暂停和自动消失。生产ToastHost与通用Feedback错误入口采用同一组件。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-notification-toast)。
