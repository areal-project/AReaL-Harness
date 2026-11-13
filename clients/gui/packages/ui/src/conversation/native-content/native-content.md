---
id: native-content
title: NativeContent
summary: 六类受控数据内容，统一文字回退与复制，不执行模型代码。
status: experimental
entry: experimental
layer: conversation
category: content
aliases: ["原生内容", "指标", "条形图", "时间线"]
related: ["markdown-surface", "disclosure", "decision-card"]
---

# NativeContent 原生数据内容

## 何时使用

`R-NATIVECONTENT-001` 需要比较多项数据或阅读固定结构时，采用指标、键值、表格、条形图、时间线或提示。单一事实优先正文；交互应用仍使用既有Gen UI/MCP宿主。

## 组成

数据边界见[围栏、历史与跨渠道边界](#围栏历史与跨渠道边界)。

## 状态

原生内容就绪；围栏未完成时宿主提供准备占位；无效/未知版本/超限时宿主展示原文。只读内容不是审批或真实任务进度。

## 内容

`R-NATIVECONTENT-003` version固定为1。每块最多48KiB，字符串最多2000字符，列表最多100项，表格最多20列；行宽必须相同。条形图只接收有限数值，呈现绝对值长度并保留原始正负数。

## 示例

[独立合同实例](../../../../../renderer/design-system.html?ui-library#component-native-content)与[混合内容和决策预览](../../../../../renderer/design-system.html?content-system)消费同一实现。

## 围栏、历史与跨渠道边界

`R-CONTENT-029` `@areal/ui/content`提供可重建的内容投影、严格校验与`toText`；不成为第二份Core历史。`areal-ui` JSON围栏必须包含`version:1`、`type`和`title`，支持metric、key-value、table、bar-chart、timeline、callout六种只读数据。字段、长度和数量受限；额外动作/样式/URL字段、未知版本或无效数据回退到可展开的原文。普通代码围栏与嵌套示例保持文字，不执行生成脚本。未闭合原生块在流式中占位，结束后仍无效则显示原文入口。

`R-CONTENT-030` 每种原生类型登记校验、文字投影、流式策略和最小占位信息。可信React组件决定DOM，模型字符串只作转义文本。图表数据可展开、内容可复制；没有模型自定义事件、动态模块或工具权限。当前消息复制使用同一投影；Rust/TUI、导出、搜索和模型回放仍消费原始历史，尚未迁入JS注册表，不能声称全部渠道自动采用`toText`。
