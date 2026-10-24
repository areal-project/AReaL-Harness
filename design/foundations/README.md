# 设计基础

AReaL 是围绕任务执行与结果阅读的工作台。本目录维护 GUI 基础表达的用途及后续 Web 复用边界，具体值留在生产源。

| 查阅目的 | 所有者 |
| --- | --- |
| 选择颜色、文字、空间、图标、动效和焦点角色 | [基础表达角色](roles.md) |
| 数值在哪里改、写样式用哪个变量、有哪些自动检查 | [Token 来源与使用](tokens.md)；变量清单见 [Token 速查](../../clients/gui/packages/ui/src/generated/tokens.md) |
| 命名对象、操作和反馈 | [内容与文案](../content/README.md) |

## 内容层级与表面

主次内容、选择、强调、危险与反馈的用途见[颜色与内容层级](roles.md#颜色与内容层级)。分组表达功能关系，不能用装饰代替内容组织。

## 文字、空间与形状

文字用途、字号偏好、密度和重排要求见[文字与空间密度](roles.md#文字与空间密度)。先按 GUI 确定阅读与操作层级，Web 复用时核对浏览器输入和响应式布局。

## 图标与资产

沿用 AReaL 已有应用、供应商及界面资产。GUI 图形与尺寸变体由 [interfaceIcons](../../clients/gui/renderer/src/interfaceIcons.tsx)及相关组件维护。图标的名称和命中关系见[图标、动效与焦点](roles.md#图标动效与焦点)。

## 状态、动效与可达性

动态反馈、焦点和减少动态效果的要求见[图标、动效与焦点](roles.md#图标动效与焦点)。具体状态展示归[反馈与恢复](../patterns/feedback-and-recovery.md)，人的决定与执行关系归[人与 Agent](../people-and-agents/README.md)。

## 平台接线

- [GUI 基础与布局约束](../../clients/gui/design-system/foundations.md)维护 CSS 角色、控件档位和工作台几何。
- [Token 来源与使用](tokens.md)说明每类值的唯一来源与 Web 映射。
