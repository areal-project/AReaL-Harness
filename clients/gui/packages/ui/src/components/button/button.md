---
id: button
title: Button
summary: 发出一次动作或打开入口，外观不代表业务已经受理。
status: stable
entry: index
layer: core
category: actions
aliases: ["按钮"]
related: ["disclosure"]
---

# Button 按钮

## 何时使用

| 场景 | 选择 |
| --- | --- |
| 提交、打开或执行一次动作 | Button |
| 按需展开阅读 | [Disclosure](../disclosure/disclosure.md) |
| `R-BUTTON-001` 持续状态/取值选择 | 原 Switch / Select，不用按钮模拟 |

## 组成

`R-BUTTON-002` Base UI Button 与现有 cva recipe。保留 variant、size、render 接口；Props、默认值和联合类型以生成的 TypeScript API 为准。

## 状态

`R-BUTTON-003` 默认、hover、按下、focus-visible、disabled、aria-invalid；业务控制等待或忙碌时能否点击。按下时缩放到 0.97 作即时反馈，带 `aria-haspopup` 的菜单触发器不缩放。样式并不证明命令已被受理。

## 行为

`R-BUTTON-004` Tab 进入可用按钮，Enter/Space 触发；disabled 不执行。调用方处理打开、关闭、提交、返回和结果未知，不在控件内重试。

## 内容

`R-BUTTON-005` 可见文字命名动作；纯图标按钮提供 aria-label。普通动作使用原有限变体，不用 className 补齐基本外观。

## 可访问性

`R-BUTTON-006` 沿 Base UI 按钮语义及键盘。图标辅助文字；运行状态不只靠颜色，调用方提供状态反馈。

## 规则

`R-BUTTON-007` 沿包内语义 Token，保留既有视觉。

`R-BUTTON-008` 变体只表达通用动作层级：`default`、`secondary`、`outline`、`ghost`、`link`、`destructive`、`destructive-subtle`、`warning`。某个产品区域专用的外观放在所属组合里，例如输入区主动作用 conversation 层的 `ComposerActionButton`，不新增 Button 变体。

`R-BUTTON-009` `unstyled` 保留 Base UI 的原生按钮、键盘、disabled、ref 和 `render` 组合行为，不应用 recipe、variant 或 size 样式。仅用于已有完整外观的组合，例如需要自然换行的 Markdown 链接、网页预览卡片动作和工作台资源入口。组合负责布局、hover、focus-visible 和 disabled 外观；普通文字或图标动作仍使用现有 variant 和 size。

`R-BUTTON-010` 尺寸：文字按钮 `xs`/`sm`/`default`/`lg`；纯图标按钮 `icon-xs`/`icon-sm`/`icon`/`icon-lg`。一个尺寸只对应一种高度，不增加同高的别名。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-button)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
