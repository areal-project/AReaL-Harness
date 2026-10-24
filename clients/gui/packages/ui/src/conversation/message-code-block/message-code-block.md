---
id: message-code-block
title: MessageCodeBlock
summary: Markdown代码块与复制/换行操作。
status: experimental
entry: wip
layer: conversation
category: composition
aliases: ["Markdown代码块与复制/换行操作"]
related: ["button"]
exports: ["MessageCodeBlock"]
---

# MessageCodeBlock Markdown代码块与复制/换行操作

## 何时使用

Markdown代码块与复制/换行操作，沿现有生产用途。

## 组成

本合同覆盖MessageCodeBlock。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

默认、内容增长、聚焦、不可用，以及宿主提供的忙碌/失败/未确认；同一对象保留原身份与阅读状态。

## 行为

preview插槽由宿主提供已完成图形，默认预览并可切换完整源码；原始复制和换行不变。切换保留两种视图挂载和本地选择。只读取props与浏览器布局，不请求Core，不访问保存配置。

## 内容

Mermaid预览由renderer复用既有Streamdown插件，保持strict安全配置；不完整流式只显示代码，解析失败提供状态提示与源码入口。主题由宿主传入，图形约束在容器内。名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

## 可访问性

保留ref、aria、键盘、焦点及减少动态效果。字号增长与窄容器下动作仍须可达。

## 规则

原renderer路径保留翻译、偏好和业务适配；包只拥有UI。实验导出不代表稳定API、完整产品能力或安装包通过。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-message-code-block)。真实业务路径沿原生产专项验证。
