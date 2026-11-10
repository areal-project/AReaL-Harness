# 按意图选择控件

`R-CONTROL-001` 先判断用户改变的是值、位置、可见信息还是执行状态，再选择控件。控件外观不能改变动作语义。具体组件、尺寸和有限变体由 GUI 实现合同决定。

| 用户意图 | 交互含义 | 选择约束 |
| --- | --- | --- |
| 执行一次操作 | 发出一个动作或打开入口 | 使用操作控件，不伪装成持续状态开关 |
| `R-CONTROL-002` 开启或关闭持续状态 | 同一个状态可双向改变并读取实际值 | 后端必须支持两个方向；单向停止、清理等仍是操作 |

`R-CONTROL-007` 同一流程的先后步骤不是互斥选项。不能为了对称外观给单向维护操作添加虚假的开启入口。操作中、已选、禁用和键盘焦点分别表达，不用视觉选中冒充已保存。

## GUI 就近合同

以下合同维护生产实现的用途、状态、键盘和焦点边界，参数与导出仍从类型读取。

| 查阅目的 | 就近合同 |
| --- | --- |
| 选择按钮变体与尺寸 | [Button 合同](../../clients/gui/packages/ui/src/components/button/button.md) |
| 表达工作台内的普通操作与提交中状态 | [ActionButton 合同](../../clients/gui/renderer/src/components/ui/action-button.md) |
| 从候选中选择一个值 | [Select 合同](../../clients/gui/renderer/src/components/ui/select.md) |
| 切换持续状态 | [Switch 合同](../../clients/gui/renderer/src/components/ui/switch.md) |
| 展示所属区域的消息与错误 | [Feedback 合同](../../clients/gui/renderer/src/components/ui/feedback.md) |
