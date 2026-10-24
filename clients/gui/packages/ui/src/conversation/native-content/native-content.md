---
id: native-content
title: NativeContent
summary: 六类受控数据内容，统一文字回退与复制，不执行模型代码。
status: experimental
entry: wip
layer: conversation
category: content
aliases: ["原生内容", "指标", "条形图", "时间线"]
related: ["markdown-surface", "disclosure", "decision-card"]
---

# NativeContent 原生数据内容

## 何时使用

需要比较多项数据或阅读固定结构时，采用指标、键值、表格、条形图、时间线或提示。单一事实优先正文；交互应用仍使用既有Gen UI/MCP宿主。

## 组成

共享content入口提供数据类型、严格校验、围栏投影、注册表与toText。组件只接收已校验数据，不接受模型组件名、HTML、样式、事件或执行回调。

## 状态

原生内容就绪；围栏未完成时宿主提供准备占位；无效/未知版本/超限时宿主展示原文。只读内容不是审批或真实任务进度。

## 行为

复制使用注册表同一toText。条形图可查看文字数据；表格仅内容内部横滚。字符串由React转义，不将SVG/HTML插入宿主。

## 内容

version固定为1。每块最多48KiB，字符串最多2000字符，列表最多100项，表格最多20列；行宽必须相同。条形图只接收有限数值，呈现绝对值长度并保留原始正负数。

## 可访问性

标题为区域命名，表格保留表头语义，图形带原值和文字数据入口。键盘可复制/展开，18px与窄容器可读。

## 规则

实验入口使用conversation.css；模型只输出areal-ui JSON围栏。原文仍是历史权威，本组件不发模型、工具或网络请求。新类型须在同一注册表提供校验和文字回退，不引入动态模块加载。

## 示例

[独立合同实例](../../../../../renderer/design-system.html?ui-library#component-native-content)与[混合内容和决策预览](../../../../../renderer/design-system.html?content-system)消费同一实现。
