---
id: shortcut-capture
title: ShortcutCapture
summary: 设置页快捷键录制控件，支持按键捕获、清除与恢复默认。
status: stable
entry: compositions
layer: settings
category: input
aliases: ["快捷键录制", "ShortcutCapture"]
related: ["kbd", "button", "settings-row"]
exports: ["ShortcutCapture"]
---

# ShortcutCapture 快捷键录制

## 何时使用

`R-SHORTCUTCAPTURE-001` 在设置页自定义全局或会话快捷键时使用本组件，点击进入监听态、按 `Escape` 取消、按 `Backspace/Delete` 清空。

## 可访问性

`R-SHORTCUTCAPTURE-002` 使用原生按钮暴露 `aria-label` 与 `aria-pressed` 录制态，恢复默认按钮配有 `TitleTooltip`。**检查：**`clients/gui/packages/ui/src/settings/shortcut-capture/shortcut-capture.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-settings-row)配合使用。
