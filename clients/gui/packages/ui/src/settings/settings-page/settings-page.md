---
id: settings-page
title: SettingsPage
summary: 设置页面的唯一纵向滚动区、居中内容列与可选标题。
status: experimental
entry: compositions
layer: settings
category: settings
aliases: ["设置页面"]
related: ["settings-section", "settings-group-card"]
---

# SettingsPage 设置页面

## 何时使用

`R-SETTINGSPAGE-001` 用于完整设置工作区。对话、弹窗和小型内嵌表单保留各自已有容器。

## 组成

外层settings-workspace承载滚动与键盘焦点；内层settings-page承载标题、subtitle和children。className添加在内容列，业务宽列适配由宿主提供。

## 状态

有标题、无标题，宽窗、窄窗。加载、保存、失败、结果待核对是宿主内容，不属于页面容器状态。

## 示例

组件目录提供同一设置组合的独立实例，可切换反馈并保留本地输入。生产通过原SettingsWorkspace路径转接，不创建第二条设置路由。

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-page)。

## 设置组合布局

### 设置控件与反馈

`R-SETTINGSPAGE-008` 本节是新增、修改和评审客户端 UI 必须遵循的约束。设置页通过外框表达功能分组，行内展示简短名称和当前状态，控件按交互语义选择；不能只统一圆角而保留错误的交互。

#### 按功能分组并保持对齐

- 使用 `SettingsRow`：名称和必要的一行说明在左，当前值与控件在右；同组的内容边缘、控件右边缘保持一致。窄窗口空间不足时，控件移到说明下方，不截断或挤出边界。

#### 按交互类型选择控件

| 用户意图 | 控件 | 规则与现有所有者 |
|---|---|---|
| `R-SETTINGSPAGE-011` 点击执行一次操作、打开管理界面 | 文字按钮 | 复用 `Button` / `ActionButton`，如“导入”“更改”“查看”“管理空间”；默认不加装饰图标，不做成开关 |
| `R-SETTINGSPAGE-012` 开启 / 关闭一个状态 | 左右滑动开关 | 复用 `Switch` / `SettingsSwitch`；以真实状态驱动，操作中禁用并显示简短反馈，失败后保留或恢复已确认状态 |
| `R-SETTINGSPAGE-013` 三个及以上候选值中选择一个 | 下拉按钮与菜单 | 复用 `Select`；收起时显示当前值和右侧小箭头，展开后显示候选项与选中标记；不把选项摊成一排按钮 |
| `R-SETTINGSPAGE-014` 两个互斥值中选择一个 | 并排的两个选项 | 复用 `SettingsSegmentedTabs`，如“底部 / 右侧”；全部可见，选中项高亮，不再套下拉菜单 |

`R-SETTINGSPAGE-015` 设置行默认使用 `Switch` 的 default 尺寸（`SettingsSwitch` 同样默认）；三项及以上沿用 `SettingsSelect` 当前公共 sm 变体；具体尺寸、形状由组件决定，页面不得自行改档。尺寸与水平留白归公共实现，不在页面覆盖。

`R-SETTINGSPAGE-016` 此处“多项选择”指多个候选值的单选，不等于一次选择多个值。真正允许多值选择时沿用支持复选语义的现有控件，不能假装成单选菜单。导航 Tab 与设置值选择也不能混为一谈。

值、动作、导航与步骤的区分统一见[控件选择](../../../../../../../design/components/controls.md)。本表维护 GUI 的具体映射；关闭服务、清理资源等操作继续绑定已有确认与拒绝入口。

#### 用状态反馈代替大段操作说明

- 按[设置与管理](../../../../../../../design/patterns/settings.md#值动作与生效范围)说明实际影响；GUI 使用所属确认或管理面板呈现。

[设置迁移题](../../../../../../../design/archive/gui/exercises/settings-reflow.md)固定内容和反证，用于探索这两条规则；题目不自行创建新设计值。

## 生产上下文

`R-BASE-009` 设置组合必须包含生产 SettingsPage 上下文。孤立 SettingsGroupCard 的库默认与挂载页面的变体可能不同；预览应复用实际组合，避免用 preview CSS 模拟生产上下文。
