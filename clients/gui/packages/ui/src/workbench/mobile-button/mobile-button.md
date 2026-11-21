---
id: mobile-button
title: MobileButton
summary: 移动端触控按钮与底部面板，页面只传布局，触控尺寸和行外观由 kind 决定。
status: experimental
entry: experimental
layer: workbench
category: control
aliases: ["移动端按钮", "触控按钮"]
related: ["button", "dialog"]
exports: ["MobileButton", "MobileSheetContent"]
---

# MobileButton 移动端触控按钮

## 何时使用

手机网页中的按钮、Composer 胶囊、设置行、项目卡片、会话行和底部面板。桌面继续使用 Button 与 DialogContent。

## 组成

MobileButton 包装 Button，`kind` 选择 touch、icon、inline、chip、primary、stop、sheet-cancel、sheet-done、summary、setting-row、project-card、work-row。MobileSheetContent 包装 DialogContent。

`R-MOBILEBUTTON-002` 页面只能追加布局类，不再写字号、内边距、圆角或颜色；新的触控形态以 kind 加入本组件，由 restyle 检查拦截页面改写。**检查：**`clients/gui/packages/ui/src/workbench/mobile-button/mobile-button.test.tsx`

## 规则

`R-MOBILEBUTTON-001` 每种 kind 的最小高度都等于 `--size-touch-target`，触控目标不随桌面字号缩放；variant、disabled、aria 与 data 属性原样传给 Button。**检查：**`clients/gui/packages/ui/src/workbench/mobile-button/mobile-button.test.tsx`

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-mobile-button)；生产用法见手机网页的 MobileComposer 与 MobileWorkspace。
