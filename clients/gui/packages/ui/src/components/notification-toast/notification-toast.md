---
id: notification-toast
title: NotificationToast
summary: 顶部短时提示，以颜色和图标区分信息、成功、警告与错误。
status: experimental
entry: wip
layer: core
category: feedback
aliases: ["短时等级提示"]
related: ["button"]
---

# NotificationToast 短时等级提示

## 何时使用

用于操作后的短时通知。正文、字段帮助和需要处理的任务状态仍由其原页面拥有。

## 组成

等级图标、message、可选actions和关闭按钮。requestId仅用于关联原请求。ToastHost提供顶部居中viewport，NotificationToast拥有倒计时与可读交互。

## 状态

info/success/warning/error；正常计时、悬停或键盘聚焦暂停、手动关闭、自动关闭。

## 行为

默认5秒后调用onDismiss；悬停/焦点暂停剩余计时，两者都离开才恢复。新通知以独立key重建计时。ToastHost按原requestId去重：同一请求的顶部和局部反馈只显示一个提示，动作更新不重置计时，已消失的提示不因普通快照更新重新出现。宿主消除原状态时关闭对应提示。

## 内容

一句话说明发生了什么及可用下一步。提示消失只关闭通知，不代表失败已修复或未知操作已完成。详细原因由原任务记录保留，不再堆叠成默认展开的大卡片。原状态仍阻塞时，可由Composer小标识再次检查；核对沿原请求身份，不自动重放。

## 可访问性

错误为alert，其余为status；同时使用图标与文字，关闭按钮由宿主提供本地化名称。减少动态效果时移除进入动画。

## 规则

使用notifications.css与既有语义颜色。UI包不派发全局业务事件；ToastHost仍是应用通知所有者。duration仅用于明确宿主需求/实例验证，默认值不按等级偷偷改变。

## 示例

组件目录可触发四个等级、手动关闭、悬停暂停和自动消失。生产ToastHost与通用Feedback错误入口采用同一组件。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-notification-toast)。
