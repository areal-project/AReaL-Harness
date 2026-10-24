# 设置组合合同

纯布局实现与完整合同已迁入私有UI包，原路径保留转接；字段适配、导航守卫和配置保存继续归renderer。

本组记录已准入的 GUI 切片。Props 与数值设计定义仍归源码所有者。目录列明的有限变体限定准入范围，不复制所有可用 Props。

## SettingsPage

[包内SettingsPage](../../../packages/ui/src/settings/settings-page/settings-page.md) 拥有生产设置表面、居中列与唯一滚动所有者；[SettingsWorkspace.tsx](SettingsWorkspace.tsx)转接并保留原导航。页面区域可通过键盘聚焦；有标题时以标题提供可读名称。[App.tsx](../App.tsx) 挂载真实页面。准入范围为普通设置工作区的有标题、无标题及宽窄条件，不拥有保存、处理中、错误或结果未知状态。

## SettingsSection

[包内SettingsSection](../../../packages/ui/src/settings/settings-section/settings-section.md)组织正文与可选的标题、说明和动作。只有正文时不添加空标题。组件不增加键盘焦点或业务状态。[DisplaySettings.tsx](DisplaySettings.tsx) 提供生产内容与动作控件。

## SettingsGroupCard

[包内SettingsGroupCard](../../../packages/ui/src/settings/settings-group-card/settings-group-card.md)按 default 或 compact 密度分组设置行，不增加交互或禁用状态。继承样式会影响分组，因此仍须保留生产页面上下文。DisplaySettings 使用两种密度。

## SettingsRow

[包内SettingsRow](../../../packages/ui/src/settings/settings-row/settings-row.md)对齐标签、说明、控件与可选详情。默认详情位于行下方；wide 控件布局将详情放在控件旁边。窄窗换行沿用现有 CSS。`disabled` 仅在行上设置 `aria-disabled`，调用方必须另外禁用实际子控件。处理中、失败与未知说明归调用方及 Feedback，不由行状态推断。

## SettingsSelect

同一源码将恰好两个选项映射为手动激活的 SettingsSegmentedTabs，其余数量使用共享 Select 与 secondary/sm 触发器。当前值与变更是否受理归调用方。禁用选项与禁用控件不能选择新值。缺失选项不证明值已成功改变。Tab、方向键、Enter、Space 与 Escape 沿用所选基础控件语义。DisplaySettings 使用二值与多值两种形式。

## SettingsSegmentedTabs

[SettingsSegmentedTabs.tsx](SettingsSegmentedTabs.tsx) 保持一个选中值与可移动的键盘焦点。自动激活跟随焦点；存在导航守卫或用于值选择的消费者采用手动激活。整体或单项禁用会禁用对应触发器。组件不拥有持久化、处理中或结果未知状态。DisplaySettings 使用此生产组合。

## SettingsDisclosure

[SettingsDisclosure.tsx](SettingsDisclosure.tsx) 保留原生 details/summary 语义、明确的展开收起文字与受控内容关系。Tab 可到达摘要，Enter 或 Space 可切换。折叠与展开是本地阅读状态，不表示业务成功或失败。组件不提供专用禁用、处理中或错误状态。DisplaySettings 提供其生产子内容。

## 证据与边界

[E-SETTINGS](../../../design-system/base-evidence.md#e-settings) 分别映射可重复检查与已完成运行。本地设置夹具覆盖列明条件，不证明原生桌面焦点、供应商保存或全部主题与变体组合。
