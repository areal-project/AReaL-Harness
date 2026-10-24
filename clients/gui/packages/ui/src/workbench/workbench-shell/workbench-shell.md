---
id: workbench-shell
title: WorkbenchShell
summary: 工作台框架、页头、侧栏和面板宽度过渡。
status: experimental
entry: wip
layer: workbench
category: composition
aliases: ["工作台框架、页头、侧栏和面板宽度过渡"]
related: ["button"]
exports: ["WorkbenchShell", "WorkspaceHeader", "WorkSurface", "NavigationSidebar"]
---

# WorkbenchShell 工作台框架、页头、侧栏和面板宽度过渡

## 何时使用

工作台框架、页头、侧栏和面板宽度过渡，沿现有生产用途。

## 组成

本合同覆盖WorkbenchShell, WorkspaceHeader, WorkSurface, NavigationSidebar。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

默认、内容增长、聚焦、不可用，以及宿主提供的忙碌/失败/未确认；同一对象保留原身份与阅读状态。

## 行为

侧栏测量、拖动/键盘调整及布局动效沿原实现。reducedMotion和本地化resizeLabel由宿主提供。持久化宽度、面板身份和导航仍归原业务所有者。

## 内容

名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

## 可访问性

保留ref、aria、键盘、焦点及减少动态效果。字号增长与窄容器下动作仍须可达。

## 规则

原renderer路径保留翻译、偏好和业务适配；包只拥有UI。实验导出不代表稳定API、完整产品能力或安装包通过。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-workbench-shell)。真实业务路径沿原生产专项验证。
