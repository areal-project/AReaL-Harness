---
id: automation-template-dialog
title: AutomationTemplateDialog
summary: 定时任务模板预览与重置确认弹窗，含只读指令预览、调度摘要与影响提醒。
status: stable
entry: compositions
layer: workbench
category: overlay
aliases: ["模板预览弹窗", "AutomationTemplateDialog"]
related: ["dialog", "callout", "badge", "scheduled-workspace"]
exports: ["AutomationTemplateDialog"]
---

# AutomationTemplateDialog 定时任务模板预览

## 何时使用

`R-AUTOMATIONTEMPLATE-001` 用户选用预设定时任务模板或重置已有自定义配置前，展示完整只读指令与周期摘要，并在覆盖自定义内容时用 `Callout` 明确提示。

## 可访问性

`R-AUTOMATIONTEMPLATE-002` 基于共享 `Dialog` 承载焦点陷阱与 `Escape` 关闭，指令预览区可键盘聚焦滚动。**检查：**`clients/gui/packages/ui/src/workbench/automation-template-dialog/automation-template-dialog.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-scheduled-workspace)配合使用。
