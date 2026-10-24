# 桌面工作台

本页维护 AReaL Harness 桌面主路径的信息组织与设计要求。现有入口依据 [App](../../../clients/gui/renderer/src/App.tsx)及其生产组件核对。以下“要求”用于变更和验收，不能据此断言所有路径已经通过运行验证。

## 信息放在所属工作中

| 区域 | 用户来这里做什么 | 放置边界与当前所有者 |
| --- | --- | --- |
| 应用导航 | 进入首页、定时任务、插件或设置 | App 组织入口和当前位置，设置使用自己的分类导航 |
| 项目与聊天导航 | 选择工作归属，找到已有聊天或新建聊天 | 项目内与项目外聊天保留区别；选择对象不等于改变权限 |
| 主聊天 | 提交要求，阅读过程、决定和回答 | Messages 与 ConversationComposer 呈现内容，原控制器拥有提交、草稿与状态绑定 |
| 定时任务 | 管理安排，阅读每次执行及待处理决定 | 任务管理与 Run 执行记录保留身份区别，不为每个任务另建一套聊天控件 |
| 任务资源与辅助面板 | 核对文件、变更、Agent、终端、浏览器和相关信息 | 入口关联当前项目与会话。只在需要时打开，不能遮蔽所属任务及返回路径 |
| 设置 | 调整偏好，管理配置与资源 | 设置按目的分类。编辑范围、生效方式和未保存内容由原所有者处理 |

[WorkbenchShell](../../../clients/gui/renderer/src/app-shell/WorkbenchShell.tsx)提供布局，不拥有导航和持久化。[SettingsWorkspace](../../../clients/gui/renderer/src/settings/SettingsWorkspace.tsx)提供导航与内容布局，宿主仍负责当前页及未保存内容保护。业务事实不能移入这些公共布局组件。

右侧任务上下文的候选组织见[对话流设计草案](../../../clients/gui/design-system/conversation-flow.md#右侧任务上下文)：Changes、当前 Worktree 关联项目、Subagents 与可折叠的 Sources。概览与深入阅读共用原宿主，不能从参考图推断跨项目数据能力；该草案尚未迁移生产页面。

Worktree 从 Composer 配置、准备过程到侧栏身份与设置管理的布局见[Worktree 设计规范](../../../clients/gui/design-system/worktrees.md)。它沿原工作台区域组织，不迁移已有会话或新增工作区执行所有者；生产组合与代表状态已迁移，验收范围见 [Worktree 验收题](../../../clients/gui/design-system/exercises/worktrees.md)。

## 进入、深入查看与返回

从项目或聊天进入时，标题、内容和可用动作指向同一对象。读取未完成或失败时保留归属，不用另一会话的内容填补。前进与后退表达位置变化，不恢复未知执行。

从聊天打开资源时保留来源。宽度不足时可以切换主内容与面板的展示方式，原聊天与资源身份仍然明确。关闭面板只结束查看。独立 Agent、旁路讨论或后台执行的生命周期按原契约处理。

设置是独立工作区域，返回后继续原工作。涉及未保存更改时由原导航保护处理，不能因为更换外观容器而绕过。共同阅读和返回要求见[深入查看与返回](../../patterns/inspect-and-return.md)，设置行为见[设置与管理](../../patterns/settings.md)。

## 草稿与焦点保留归属

主聊天、旁路讨论、队列编辑和设置分别保留自身输入。查看资源不提交草稿。带回旁路讨论内容时遵循[上下文与证据](../../people-and-agents/context-and-evidence.md#把讨论带回主任务)，不直接启动一轮执行。

返回时优先恢复同一对象的原触发位置。触发元素已卸载时使用该工作区域的合理入口，不能聚焦旧会话。后台通知和迟到响应也不能把用户带离当前阅读。

App 已有按项目与 Thread 记录面板归属及返回焦点的处理。具体持久化、草稿恢复和导航保护仍读原实现。验收需实际执行进入、编辑、深入查看、返回与切换对象，截图不能证明输入和焦点保留。

## 预览与真实路径分别核对

[完整工作台候选](candidate.md)将提交、过程、审批、资源与设置放在同一条可操作路径中。打开 `/design-system.html?product-candidate` 评价整体体验；它使用本地演示数据，验证范围在候选说明中维护。

从仓库根运行 `pnpm --dir clients/gui design:dev` 查看已有设计预览，运行 `pnpm --dir clients/gui design:build` 检查预览构建。预览入口是 [main.tsx](../../../clients/gui/renderer/src/design-system/main.tsx)。打开[共享工作区示例](../../../clients/gui/renderer/design-system.html?shared-workspace)核对所挂载状态，生产组件接线见 [SharedWorkspacePreview](../../../clients/gui/renderer/src/design-system/SharedWorkspacePreview.tsx)。

共享工作区示例组合生产聊天、输入、侧面板与设置组件，使用本地数据和展示状态。示例可以检查所挂载状态的布局、草稿操作和焦点行为。它不连接 Core，不执行真实提交，也不能证明服务受理、权限、恢复、原生浏览器或终端生命周期。

生产接线继续经过 App、Desktop 服务和 Core。首条真实路径的验收需覆盖提交、观察过程、处理决定、查看资源、返回阅读和修改外观，并列明未知或失败状态的实际覆盖。完整候选与迁移进度见[建设计划](../../roadmap.md)。

定时任务目录使用[ScheduledWorkspace](../../../clients/gui/packages/ui/src/workbench/scheduled-workspace/scheduled-workspace.md)：按已开启、已暂停、已结束分组，默认只展示名称与计划摘要；创建入口用轻量模板。项目 UUID 与目录加载诊断不作为常规导航内容，失败保留重试，只有目录读取完成后才能显示无任务。
