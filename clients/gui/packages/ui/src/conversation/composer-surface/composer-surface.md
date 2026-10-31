---
id: composer-surface
title: ComposerSurface
summary: 组合编辑器、上下文与工具栏，提供一致的输入布局与阻塞说明。
status: experimental
entry: experimental
layer: conversation
category: input
aliases: ["对话输入表面"]
related: ["composer-toolbar", "button"]
---

# ComposerSurface 对话输入表面

## 何时使用

`R-COMPOSERSURFACE-001` 主聊天、Side和草稿等任务输入。普通设置值不使用此表面，仍用原Input/SettingsRow。

## 组成

editor、toolbar为必要插槽；context承载附件/引用/可读阻塞理由，overlay承载拖放提示。宿主提供原Lexical编辑器，组件不创建第二个编辑器。

## 状态

`R-COMPOSERSURFACE-002` 默认、compact、聚焦、拖放。空内容、附件、发送中、运行中和模型不可用由宿主提供内容与动作，不转为包内执行状态机。

## 行为

`R-COMPOSERSURFACE-003` 编辑区随内容增高，到局部高度上限后纵向阅读；compact在窄容器回到上下布局。同一草稿保持实例身份，换布局或收起审批不重建编辑器。

## 内容

`R-COMPOSERSURFACE-004` 占位说明输入目标；阻塞发送时呈现准确原因并保留草稿。模型、权限、附件名与引用来源来自真实目录，不能从灰按钮推断后台受理。

## 工作区文件引用

`R-COMPOSERSURFACE-007` 裸 `@` 或清空关键词时隐藏文件候选及搜索状态。关键词在 Composer 输入，菜单不另设搜索框；搜索结果中的文件组排在最后。文件引用复用 Skills 行内标识的图标、文件名与展示所有者，覆盖编辑器和已发送正文，不采用上传附件卡片或新展示组件、样式。既有 Tooltip 显示实际项目或 Worktree 根目录与规范相对引用组成的完整绝对路径；发送、排队、持久化只保存相对引用。上传文件沿用附件链路。生产接线为 `PromptMentionNode`、`promptMentionDecoration`、`UserMessageBody`、`message-response-renderer`；`Messages` 提供根目录。运行 `AREAL_COMPOSER_FILES_REGRESSION=1 pnpm --dir clients/gui test:composer` 复验标识、悬停路径、Worktree 归属和上传附件。**检查：**`clients/gui/scripts/composer-files-acceptance.mjs`

## 可访问性

`R-COMPOSERSURFACE-005` 宿主标注编辑器与图标按钮；输入、工具与发送遵循DOM顺序。submitDisabledReason在生产ChatPromptEditor中可见且关联发送按钮，不能只靠hover；中文组合输入、快捷键及提交仍由Lexical拥有。

## 规则

`R-COMPOSERSURFACE-006` 包负责通用几何，模型菜单/审批布局适配留renderer。禁止读Core、localStorage或凭据；不因模型切换、示例状态或反馈擅自发送、清空草稿。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-composer-surface)包含独立可操作样例；生产路径通过原ComposerSurface转接。模型/权限选择在独立样例中仅为固定选项，不代表真实配置写入。

### 输入区与面板组合

`R-LAYOUT-011` 审批按钮的 split 几何、Side 面板比例、Composer 紧凑布局是当前组合规则，不作为全局控件的新默认值。

`CONV-COMPOSER-01`：默认布局的 Composer 是对话的一部分。输入文字用 `--text-conversation` / `--conversation-line`（默认 14px / 20px），与发出后的用户气泡一致；外框圆角 `--radius-composer`（18px），内边距上 12、左右 12、下 8；编辑区最少 40px，空态总高约 88px，内容超过 40dvh 后在编辑区内滚动；工具栏 28px，主按钮 28px 圆。附件图片缩略图 96px。上方上下文条可见高度 34px，圆角与输入框相同，Worktree 配置收在其最右齿轮里（`WT-PICKER-01`），工具栏不放 Worktree，也不加语音输入。运行中不在输入框上方加状态栏，停止就是主按钮本身；待处理审批只以卡片出现在输入框上方（`CONV-STATUS-01`）。理由：输入区比对话正文大一号、留白更厚时，视线在“读”和“写”之间要换一次尺度；同一字号与节奏让 Composer 读起来像对话的下一行。

`R-LAYOUT-012` 桌面 Composer 的模型和思考强度使用相邻的独立 Popover。主界面模型入口只显示模型名，完整提示保留供应商身份。模型菜单左侧按供应商 ID 浏览，右侧选择模型；浏览不保存配置，选择后关闭菜单。强度菜单对每个模型提供 none、minimal、low、medium、high、xhigh、max 七档与独立的服务默认动作，不以目录能力隐藏选项。显式强度保留并提交 Core 校验，未知值原样显示。强度菜单左上角复用 Button 与 Tooltip 提供独立的 Fast 闪电开关，aria-pressed 投影已确认的 Fast 请求状态，提示开启或关闭并说明额度或费用影响。开启写 serviceTier=fast，关闭写 default，未配置继承模型及供应商默认值。用户指定的闪电入口沿用 aria-pressed 按钮，这是 R-BUTTON-001 持久值通常使用 Switch 的本地例外，仅限此入口，不增加公共变体。Fast 与思考强度互不改写，切模型保留显式 Fast 选择；主强度入口仅在请求 Fast 时显示闪电及 Fast 标记，不表示供应商已提供加速。主 Composer 的模型配置保存与消息发送反馈分开：保存期间仍可编辑草稿，不播放发送中的 Spinner，也不通过禁用滑块打断焦点。`ConversationComposer.modelPending` 只锁定模型配置动作，发送入口仍由宿主阻止；滑块保留待保存位置，完成或失败后回到 Core 确认值。未知结果继续沿原恢复路径处理，不自动重试。

`R-LAYOUT-013` `ChatPromptEditor.surfaceLayout` 透传 `ComposerSurface.layout`，仅有 default / compact。App 为满屏资源下的主 Composer / DraftComposer 选择 compact；Side 不继承工作区祖先的输入布局。变体、容器重排和模型入口基础样式归 ComposerSurface.css，不能在页面复制全屏选择器。ConversationComposer 仍理解模型目录和继承；主/Side 的草稿、来源、配置、提交及未知受理归原业务所有者。Side 的错误与带回反馈复用 Feedback。

`design-system.html?shared-workspace` 组合真实主输入、SideChatPane、SidePane 与 portal 设置；本地动作不执行任务。运行 `node clients/gui/scripts/design-system-smoke.mjs --shared-workspace` 验证代表条件；真实发送和模型隔离使用 `conversation-derivation-smoke.mjs --shared-workspace` 与已核对的 AREAL_CORE_BIN。设计裁决、规则强度与范围归[共享工作区合同](../../../../../design-system/exercises/shared-workspace.md)。
