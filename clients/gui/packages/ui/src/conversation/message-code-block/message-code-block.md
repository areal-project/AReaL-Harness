---
id: message-code-block
title: MessageCodeBlock
summary: Markdown代码块与复制/换行操作。
status: experimental
entry: experimental
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

引用 [R-UI-COMMON-009](../../../README.md#共同合同)。

## 行为

`R-MESSAGECODEBLOCK-001` preview插槽由宿主提供已完成图形，默认预览并可切换完整源码；previewActions插槽承载带文字的放大入口。原始复制和换行不变。切换保留两种视图挂载和本地选择。只读取props与浏览器布局，不请求Core，不访问保存配置。

## 内容

`R-MESSAGECODEBLOCK-002` Mermaid预览由renderer复用既有Streamdown插件，保持strict安全配置；未闭合围栏只显示代码，闭合后可在后续正文仍生成时预览。解析失败提供状态提示与源码入口。时间线中的放大阅读器由对话宿主持有，不随流式解析器切换或完成后的消息投影重挂卸载；复用Dialog，提供适应窗口、原始尺寸、缩放、滚动/拖动、SVG下载和失败重试，关闭回到触发入口。主题由宿主传入，内联图形约束在容器内。名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-013](../../../README.md#共同合同)。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-message-code-block)。真实业务路径沿原生产专项验证。
