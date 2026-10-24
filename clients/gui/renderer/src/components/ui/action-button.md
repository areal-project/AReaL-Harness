# ActionButton 操作按钮

## 用途

设置行中的紧凑文字操作。可选图标辅助辨认，文字在等待时保持可读。

## 不适用

持续状态使用 [Switch](switch.md)。值选择使用 [Select](select.md)。需要其他按钮组合时读取 [Button](../../../../packages/ui/src/components/button/button.md) 合同。

## 状态

`pending` 显示等待图标和 `aria-busy`，同时禁用按钮。没有 `pending` 时可显示可选图标。Props 与实现以 [action-button.tsx](./action-button.tsx) 为准。等待外观不证明操作已成功。

## 键盘与焦点

沿用 Button 的 Tab、Enter、空格和可见焦点。等待时保留原文字，不能只用动画说明正在执行哪个动作。

## 禁用

`disabled` 或 `pending` 任一成立时，按钮均不可触发。未知结果由调用方保留核对入口，不能自动重新提交。

## 示例

[查看真实操作按钮与控件示例](../../../design-system.html#controls)。页面顶部的状态选择可检查等待、明确失败和结果待核对。
