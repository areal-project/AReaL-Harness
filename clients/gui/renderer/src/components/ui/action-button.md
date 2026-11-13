# ActionButton 操作按钮

## 用途

设置行中的紧凑文字操作。可选图标辅助辨认，文字在等待时保持可读。

## 键盘与焦点

`R-ACTIONBUTTON-007` 沿用 Button 的 Tab、Enter、空格和可见焦点。等待时保留原文字，不能只用动画说明正在执行哪个动作。

## 禁用

`R-ACTIONBUTTON-008` `disabled` 或 `pending` 任一成立时，按钮均不可触发。未知结果由调用方保留核对入口，不能自动重新提交。
