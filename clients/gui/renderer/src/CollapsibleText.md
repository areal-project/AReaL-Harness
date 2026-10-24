# CollapsibleText 合同

[CollapsibleText.tsx](CollapsibleText.tsx) 按实际内容与生产预览行数角色测量。短内容不显示展开控件。长内容初始折叠，原文始终保持挂载。展开与收起只改变本地阅读状态，不编辑或截断源内容，也不改变调用方拥有的复制动作。

需要展开控件时，Tab 可到达有名称的 Button，Enter 与 Space 可切换。焦点进入被裁切的子内容时，视口会展开，保证焦点内容可读。从底部收起时，通过原有滚动所有者将预览与控件带回最近可见位置。该组件没有处理中、错误、结果未知或操作禁用状态。

生产消费者是 [Messages.tsx](Messages.tsx)。[E-DECISION](../../design-system/base-evidence.md#e-decision) 映射可重复的长内容检查与已完成运行证据。本次有限合同覆盖实测预览、短内容、折叠、展开与键盘可达性，不包含所有可能的子内容。
