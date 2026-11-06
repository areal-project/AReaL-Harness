# Switch 开关

## 用途

读取并改变同一个持续状态的开启或关闭值。标签说明被改变的状态。

## 不适用

`R-SWITCH-005` 单向停止、清理或导入使用 [ActionButton](action-button.md)。多个候选值使用 [Select](select.md)。没有反向操作能力时不能画成开关。

## 状态

开与关分别表达当前值。焦点、禁用与无效状态单独表达。Props 和尺寸以 [switch.tsx](./switch.tsx) 为准。调用方拥有真实值和变更结果。

## 禁用

`R-SWITCH-007` 禁用时保留当前值且不能切换。调用方在所属区域说明不可操作的原因。

## 示例

[查看真实开关与控件示例](../../../design-system.html#controls)，使用“显示底部面板”检查开关值。
