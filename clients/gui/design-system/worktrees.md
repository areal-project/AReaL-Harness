# Worktree 设计系统：配置、准备与管理

## 依据与取舍

| 截图能力 | AReaL 的采纳边界 |
| --- | --- |
| Variables 入口 | 只解释当前三个受支持变量；不借截图新增自定义变量、密钥或注入能力 |
| `R-WORKTREE-008` 目录行中的第二个小图标 | 单帧不能证明用途；本期只定义查看详情与删除，不猜测归档、恢复或打开系统目录能力 |

实际创建、取消、清理与恢复语义继续归[Worktree 指南](../../../docs/guides/worktrees.md)和[桌面宿主合同](../../../docs/api/desktop.md#桌面宿主-worktree-契约)。这里规定如何呈现事实，不重建状态机。

## 在现有系统中的位置

| 层级 | Worktree 的职责 | 唯一来源 |
| --- | --- | --- |
| Foundations | 表面、字号、字重、间距、图标、焦点、动效 | [foundations](foundations.md)、[Token 来源与使用](../../../design/foundations/tokens.md)、生产 CSS 与外观偏好 |
| 产品布局 | Composer 上下文条、时间线、侧栏、设置导航 | 原 App / Messages / TaskListItem / SettingsWorkspace |

## 视觉基础与几何

以下尺寸是**后续实现的局部候选值**，不是从截图实测得出的事实，也不是对全局 Token 的修改。若大字号或长文案迫使调整，先保持列关系、对齐与可达性，再在原组件所有者记录差异。

| 对象 | 目标规则 |
| --- | --- |
| 设置内容列 | General、项目列表、环境编辑共用一条居中阅读列；候选最大宽度 41rem，窄窗占可用宽度。沿 SettingsWorkspace 外边距，不给各区块单独设置宽度 |
| 行结构 | 图标 / 主标签 / 弹性空间 / 当前值 / 尾部动作；名称列 `min-width: 0`，尾部动作不收缩。同类行共享左右边缘与图标列 |
| 控件密度 | 配置菜单与资源行采用紧凑列表密度，最小行高沿 `--spacing-control-lg`，文字增长时自然增高；设置输入与开关仍沿原交互类型尺寸，不缩成截图位图大小 |
| 组内与组间 | 图标、标签和值用 `--spacing-inline`；字段之间用 `--spacing-field`；页面区块之间用 `--spacing-section`；容器内边距用 `--spacing-panel` |
| `R-WORKTREE-015` 圆角与边线 | 外浮层沿 `--radius-overlay`，输入/按钮/列表高亮沿 `--radius-control`；组内分隔使用原边线角色。不得从截图采样 hex 或新增相近灰色 |
| 文字 | 页面标题沿 SettingsPage；普通标签、项目/会话名使用 regular；说明、当前值与状态摘要用 UI caption / 次级前景；正文沿内容字号；代码和日志用 `--font-mono` |
| `R-WORKTREE-016` 状态 | 运行使用已有状态色及文字；正常完成降低强调；失败用错误角色；未知用明确文字。禁用、次级、完成是不同语义，不能共用一层低透明度 |

`WT-VISUAL-01`：先核对轮廓、阅读宽度、对齐和层级，再核对局部细节。禁止以加粗所有标签、每段套边框、显示完整 UUID 或缩字号弥补信息组织问题。明暗主题沿同一语义角色，不能仅在深色截图中成立。

## Composer：上下文条与配置菜单

组件专属合同由[WT-PICKER-01 等规则](../packages/ui/src/worktree/worktree-picker/worktree-picker.md#composer上下文条与配置菜单)维护。

### 分支与环境子页

见[组件合同](../packages/ui/src/worktree/worktree-picker/worktree-picker.md#分支与环境子页)。

## 时间线：准备、取消与完成

组件专属合同由[WT-PROGRESS-01 等规则](../packages/ui/src/worktree/worktree-status/worktree-status.md#时间线准备取消与完成)维护。

## 侧栏与会话工作区身份

侧栏身份见 [WT-IDENTITY-01](../packages/ui/src/workbench/task-list-item/task-list-item.md#worktree-身份)；会话入口与操作位置见 [WorktreeWorkspace](../packages/ui/src/worktree/worktree-workspace/worktree-workspace.md#会话入口与操作位置)。

## 设置：页面骨架与 General

组件专属合同由[WT-SETTINGS-01 等规则](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#设置页面骨架与-general)维护。

### General

见[组件合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#general)。

### 按项目管理目录

见[组件合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#按项目管理目录)。

## 设置：Environments 与环境编辑

组件专属合同由[WT-ENV-01 等规则](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#设置environments-与环境编辑)维护。

### Action 的有限形态

见[组件合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#action-的有限形态)。

## 状态、内容与可访问性

`WT-STATE-01`：可见文本取决于权威状态与用户动作。以下补齐截图未覆盖的状态，是设计决定；不得将其写成 Codex 已观察行为。

| 状态 | 必须看见 | 不可出现 |
| --- | --- | --- |
| 加载 / 刷新 | 所属项目、已有值、局部忙碌说明 | 把暂未读到当成没有分支或环境 |
| 无匹配 / 无资源 | 区分搜索无匹配、环境为空、目录为空 | 一律用同一句“暂无数据” |
| 创建 / 绑定 / Setup | 当前确认阶段、等待发送、可用取消入口 | 伪百分比、模型已开始回答的暗示 |
| 已创建但未 ready | 创建事实与剩余准备说明 | 解除发送等待或显示完整成功 |
| 取消中 / 已取消 | 正在核对终止 / 已确认取消；目录与草稿去向 | 点击即显示已终止、静默改用原目录 |
| ready / 正常聊天 | 一行创建标识、真实工作区身份、普通 Composer | 成功大卡片长期占据主阅读列 |
| UNKNOWN | 结果待核对、原请求核对入口 | 自动重跑、自动删除或回退 |
| 保存 / 删除 / Action 忙碌 | 所属对象与重复操作限制 | 只显示全页 spinner 丢失上下文 |

- `R-WORKTREE-028` 齿轮、返回、刷新、添加、删除、工作区标识均有对象相关的可访问名称。tooltip 是补充，不能承担唯一说明。
- `R-WORKTREE-029` 主配置不是 `menu` 内嵌不可达表单：含开关的浮层沿 Popover 的普通焦点序列；分支和环境列表采用单选列表语义，选中状态可读，不只显示勾。
- `R-WORKTREE-030` 键盘可打开、切换、选择、返回、关闭；关闭回到原触发器。进入设置再返回时保留同项目草稿；不存在的旧触发器不能抢焦点。
- 平台标签具备 tab / tabpanel 关系与键盘切换；输入关联标签、说明与错误。折叠区暴露 expanded / controls，隐藏内容退出焦点序列。
- `R-WORKTREE-031` 状态摘要使用适度的 live region；原始日志不逐字播报。失败与未知在详情收起时仍可发现。后台任务不能因增量抢当前窗口焦点。

## 实现落点与保留差异

下表记录生产落点。精确参数与状态投影以源码为准，已实现的展示不代表所有宿主和平台均经过验收。

| 目标 | 当前落点与边界 | 原所有者 |
| --- | --- | --- |
| 配置行与单浮层子页 | 三行主菜单、同浮层分支 / 环境子页、搜索和焦点返回。宿主只提供分支字符串，因此使用真实分支列表，不伪造本地 / 远端元数据分组 | [WorktreeStarter](../renderer/src/WorktreeStarter.tsx)、[DraftComposer](../renderer/src/DraftComposer.tsx) |
| 准备 / 完成层级 | 默认关闭日志，取消控制同排，ready 收敛为轻量事实。创建记录只绑定完整本地历史的首轮 Prompt，不挂在继承或分页后的其他消息下 | [WorktreeStatus](../renderer/src/WorktreeStatus.tsx)、[Messages](../renderer/src/Messages.tsx) |
| 侧栏单标识 | 名称为主，尾部分叉图标与具名状态，不显示 UUID 第二行 | [TaskListItem](../renderer/src/TaskListItem.tsx) |
| 设置导航层级 | General 一个主设置组与紧凑目录；项目列表、环境列表、独立编辑页分开。高级前缀与安全删除提示保留 AReaL 能力边界 | [WorktreesSettings](../renderer/src/settings/WorktreesSettings.tsx)、[SettingsWorkspace](../renderer/src/settings/SettingsWorkspace.tsx) |
| 脚本与 Actions | 独立平台标签、只读 Variables、单行 Action 展开编辑；语义表面与边框使用既有角色 | [WorktreesSettings](../renderer/src/settings/WorktreesSettings.tsx)、原 Settings 控件 |

`R-WORKTREE-038` 局部几何与样式落在 [Worktree.css](../renderer/src/Worktree.css) 和 [WorktreesSettings.css](../renderer/src/settings/WorktreesSettings.css)；状态从已有服务读取。Dirty 刷新保留原 revision，版本冲突后需放弃再重新编辑，不能静默推进 revision 覆盖其他配置。

## 固定样例与后续验收

见[冻结原文](../../../design/archive/gui/worktree-design-exercise.md#固定样例与后续验收)。
