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

editor、toolbar为必要插槽；editor承载正文和行内引用，context承载附件及可读阻塞理由，overlay承载拖放提示。宿主提供原Lexical编辑器，组件不创建第二个编辑器。

## 状态

`R-COMPOSERSURFACE-002` 默认、compact、聚焦、拖放。空内容、附件、发送中、运行中和模型不可用由宿主提供内容与动作，不转为包内执行状态机。

## 内容

`R-COMPOSERSURFACE-004` 占位说明输入目标；阻塞发送时呈现准确原因并保留草稿。输入、附件读取、上传与发送错误统一使用顶部反馈弹窗，不在输入框内或上方重复展示错误条。错误摘要保持简短，技术原因按需展开；附件不展示上传状态文字。重试保留成功上传回执，结果未知仍先核对原请求。模型、权限、附件名与引用来源来自真实目录，不能从灰按钮推断后台受理。

## 工作区文件引用

`R-COMPOSERSURFACE-007` 符号分工：`@` 引用文件、插件与 MCP 资源，裸 `@` 也列出项目根目录，输入关键词后搜索；`$` 只选 Skill；`/` 放命令与功能，不再混入 Skill；“+”菜单仍列出全部。关键词在 Composer 输入，菜单不另设搜索框；搜索结果中的文件组排在最后。引用与正文保持同一层级。文件、文件夹、Skill、插件和会话引用使用正文内的紧凑行内标识，与文字共享字号、行高和自然换行；仅实际上传的附件进入正文上方附件区。文件和文件夹复用 Skills 行内标识的图标、名称与展示所有者，覆盖编辑器和已发送正文，不采用独立引用行、大卡片或新展示组件、样式。既有 Tooltip 显示完整路径。工作区树和搜索引用按实际项目或 Worktree 根目录解析相对路径；原生拖入或粘贴的本机目录允许位于工作区外，保留绝对路径。发送、排队、持久化及恢复保留各自路径语义。目录与普通文件混合输入分别进入引用和附件链路；引用本身不修改 Agent 执行权限。上传文件沿用附件链路。生产接线为 `PromptMentionNode`、`promptMentionDecoration`、`UserMessageBody`、`message-response-renderer`；`Messages` 提供根目录。运行 `AREAL_COMPOSER_FILES_REGRESSION=1 pnpm --dir clients/gui test:composer` 复验标识、悬停路径、Worktree 归属和上传附件。**检查：**`clients/gui/scripts/composer-files-acceptance.mjs`

## 可访问性

`R-COMPOSERSURFACE-005` 宿主标注编辑器与图标按钮；输入、工具与发送遵循DOM顺序。submitDisabledReason在生产ChatPromptEditor中可见且关联发送按钮，不能只靠hover；中文组合输入、快捷键及提交仍由Lexical拥有。

## 规则

`R-COMPOSERSURFACE-006` 包负责通用几何，模型菜单/审批布局适配留renderer。禁止读Core、localStorage或凭据；不因模型切换、示例状态或反馈擅自发送、清空草稿。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-composer-surface)包含独立可操作样例；生产路径通过原ComposerSurface转接。模型/权限选择在独立样例中仅为固定选项，不代表真实配置写入。

### 输入区与面板组合

`CONV-COMPOSER-01`：默认布局的 Composer 是对话的一部分。输入文字用 `--text-conversation` / `--conversation-line`（默认 14px / 20px），与发出后的用户气泡一致；外框圆角 `--radius-composer`（18px），内边距上 12、左右 12、下 8；编辑区最少 40px，空态总高约 88px，内容超过 40dvh 后在编辑区内滚动；工具栏 28px，主按钮 28px 圆。附件缩略卡尺寸由 `R-ATTACHMENTCARD-001` 定义。上方上下文条可见高度 34px，圆角与输入框相同，Worktree 配置收在其最右齿轮里（`WT-PICKER-01`），工具栏不放 Worktree，也不加语音输入。运行中不在输入框上方加状态栏，停止就是主按钮本身；待处理审批只以卡片出现在输入框上方（`CONV-STATUS-01`）。理由：输入区比对话正文大一号、留白更厚时，视线在“读”和“写”之间要换一次尺度；同一字号与节奏让 Composer 读起来像对话的下一行。

`R-LAYOUT-013` `ChatPromptEditor.surfaceLayout` 透传 `ComposerSurface.layout`，仅有 default / compact。App 为满屏资源下的主 Composer / DraftComposer 选择 compact；Side 不继承工作区祖先的输入布局。变体、容器重排和模型入口基础样式归 ComposerSurface.css，不能在页面复制全屏选择器。ConversationComposer 仍理解模型目录和继承；主/Side 的草稿、来源、配置、提交及未知受理归原业务所有者。Side 的错误与带回反馈复用 Feedback。

`design-system.html?shared-workspace` 组合真实主输入、SideChatPane、SidePane 与 portal 设置；本地动作不执行任务。运行 `node clients/gui/scripts/design-system-smoke.mjs --shared-workspace` 验证代表条件；真实发送和模型隔离使用 `conversation-derivation-smoke.mjs --shared-workspace` 与已核对的 AREAL_CORE_BIN。设计裁决、规则强度与范围归[共享工作区合同](../../../../../../../design/archive/gui/exercises/shared-workspace.md)。
