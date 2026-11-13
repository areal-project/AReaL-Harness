---
id: worktree-status
title: WorktreeStatus
summary: 显示准备摘要、阶段、详情及宿主合法动作。
status: experimental
entry: experimental
layer: worktree
category: worktree
aliases: ["Worktree准备状态"]
related: ["worktree-picker", "worktree-workspace"]
---

# WorktreeStatus Worktree准备状态

## 何时使用

用于发送后的Worktree准备过程。现有WorktreeStatus适配器从权威事件投影为可读内容。

## 组成

摘要、可展开阶段、details插槽及controls插槽。组件拥有展开状态，宿主提供state、running、label及阶段显示模型。

## 示例

独立实例可切换运行/失败/未知/就绪、展开日志并触发本地动作；生产Messages和DraftComposer沿原适配使用。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-status)。

## 时间线：准备、取消与完成

`WT-PROGRESS-01`（WT-R04～06）：用户 Prompt → Worktree 准备记录 → 助手内容，顺序可核对。准备期间展示的是已提交意图预览，不能暗示模型已收到；真正受理后沿同一消息身份衔接，不出现两条相同 Prompt。准备记录与首条请求绑定，不浮在另一轮或另一项目的历史上方。

| 层级 | 默认形态 | 内容与动作 |
| --- | --- | --- |
| 准备摘要 | GitFork + “正在创建 Worktree”轻量行 | 当前真实阶段；必要时一行等待说明 |
| `R-WORKTREESTATUS-007` 控制行 | 左侧“展开详情 / 收起详情”，右侧“不使用 Worktree”“取消” | 动作保持具名、同一基线；窄窗可换为第二行，不能挤掉其中一个 |
| 已创建 | GitFork + “Worktree 已创建”一行 | 可进入详情核对目录与分支；随后仍在绑定 / Setup 时，另有准确等待说明 |

`WT-PROGRESS-02`：准备期间 Composer 保持原位，以“正在等待 Worktree 准备…”说明不能重复发送。停止 / 取消走原请求的取消路径。点击取消后立即显示“正在取消”，只有权威确认才显示“已取消”；已创建目录是否保留必须说明。不能因关闭详情、切换聊天或请求返回就宣称进程停止。

`R-WORKTREESTATUS-011` “不使用 Worktree”是显式改用原目录的用户意图：先确认原准备取消，再发起新的明确请求；等待期间禁止重复点击，失败或 UNKNOWN 不能自动回退。已确认失败时保留 Prompt、记录与可用恢复动作；UNKNOWN 只提供原请求核对入口。具体允许动作沿宿主，不在设计层新增“重试即可”通路。
