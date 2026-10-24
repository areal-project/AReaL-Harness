---
id: side-pane-frame
title: SidePaneFrame
summary: 面板框架、标题区、内容与辅助资源区。
status: experimental
entry: wip
layer: workbench
category: composition
aliases: ["面板框架、标题区、内容与辅助资源区"]
related: ["button"]
exports: ["SidePaneFrame"]
---

# SidePaneFrame 面板框架、标题区、内容与辅助资源区

## 何时使用

面板框架、标题区、内容与辅助资源区，沿现有生产用途。

## 组成

Frame、Header、Layout、Content、Auxiliary与Retained组合真实DOM；不引入多余布局盒。标签与资源生命周期由宿主提供。

## 状态

默认、内容增长、聚焦、不可用，以及宿主提供的忙碌/失败/未确认；同一对象保留原身份与阅读状态。

## 行为

保留原实现、原生语义和交互动线。只读取props与浏览器布局，不请求Core，不访问保存配置。

## 内容

名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

## 可访问性

保留ref、aria、键盘、焦点及减少动态效果。字号增长与窄容器下动作仍须可达。

## 规则

原renderer路径保留翻译、偏好和业务适配；包只拥有UI。实验导出不代表稳定API、完整产品能力或安装包通过。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-side-pane-frame)。真实业务路径沿原生产专项验证。
