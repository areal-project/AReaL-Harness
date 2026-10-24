# 共享组件迁移

本轮按“基础控件 → 设置与决策组合 → 阅读与附件 → 工作台组合”的顺序，将现有 GUI 的共用展示实现迁入私有 workspace 包 `@areal/ui`。沿用原视觉、图标、交互和第三方来源；后续调整从包内实现及同目录 MD 开始。运行期业务页面仍是 renderer 的产品适配层。

## 迁移清单

完整组件和子组件名单以包构建的 `components.json` 为准，设计站点的“UI 包与架构”消费同一索引。下表记录职责，不维护第二套 Props 清单。

| 批次 | 包内实现 | 生产接线 |
| --- | --- | --- |
| 基础控件 | Input、Textarea、Switch、Select、Tabs、Popover、Tooltip、DropdownMenu、ContextMenu、Card、InputGroup、ActionButton、Command、Dialog、Spinner | 原 `components/ui` 路径转接同一实现；Dialog/Spinner适配本地化文案 |
| 设置与反馈 | SettingsSearchInput、SettingsSegmentedTabs、SettingsDisclosure、SettingsSelect及LockedValue/Badge/Switch/ValueAction、SettingsDialog/Toolbar/EmptySettings、FeedbackNotice | SettingsPageParts、SettingsWorkspace、common等保留翻译、值投影、保存和导航守卫；复用先前迁入的Page/Section/GroupCard/Row |
| 对话组合 | DecisionCard、CollapsibleText、CommandDetails、AttachmentCard、Attachments、MessageCodeBlock、MarkdownBlockquote/List/Table/Surface | 审批与工具状态、命令投影、附件读取/上传、链接和媒体授权继续由原renderer拥有；复用先前迁入的活动、图片、上下文、子代理和Composer组合 |
| 阅读器 | CodeViewer、DiffViewer及其纯类型/高亮与快捷键辅助 | 原路径注入已保存代码偏好、主题及Diff标记；worker池和应用主题注册仍由宿主初始化 |
| 工作台 | WorkbenchShell/WorkspaceHeader/WorkSurface/NavigationSidebar、SidePaneFrame、SidePaneLauncher、SettingsNavigation、TaskTitleOverflowText、MemoTaskItem、ResourceScope/CatalogEmpty | 原壳层注入外观/翻译；任务行注入原SidebarDragSurface；SidePane保留标签注册、拖拽、关闭守卫与资源生命周期 |
| 前序已迁入 | Button、Disclosure、NotificationToast、对话活动/图片/上下文/子代理/过程摘要、Composer表面/工具栏、设置布局、五组Worktree组合 | 继续消费同一包；本轮没有另建平行实现 |

这覆盖当前共享 UI 层，**不把每个产品控制器搬进 UI 包**。例如 Messages、TurnExecution、ToolEvent、ApprovalRequest、AskUserQuestion、ConversationComposer、SideChatPane、SidePane与具体设置页面，仍负责业务数据、身份和用户动作，通过上述组件呈现。SidePaneTabTrigger/Overview仍绑定标签模型与拖拽/恢复策略；媒体/文件/终端/浏览器面板仍绑定资源和原生生命周期。这些是产品所有者，不能为了目录集中而让包反向依赖服务。

普通操作错误经原ToastHost显示，按等级着色并默认5秒消失；App消费已提示的原通知，避免切页后累积错误卡片。含原请求核对/重连等动作的恢复状态保留操作入口，不能因短时提示消失而失去恢复能力。

## 单一实现与适配

- 包内 `src/components` 是基础层，不能导入 `conversation`、`worktree`、`workbench`。领域层不能导入renderer、Core、Node或Electron。
- 原renderer路径只转接、投影或注入宿主值；不要在旧文件中继续维护第二份共用JSX/CSS。后续发现新的共用展示职责时，按同一边界增量抽取。
- 本地化、已保存偏好、服务请求、审批/UNKNOWN判定、历史、上传与File/Blob处理、持久化及原生生命周期归原所有者。纯组件只拥有局部交互，例如展开、选择、阅读和焦点。
- 迁移样式删除旧可编辑定义，原CSS入口转接包样式；产品级覆盖继续留在原页面。`styles.css`提供控件；`settings.css`、`conversation.css`、`worktree.css`、`workbench.css`提供相应组合。不要依赖生产全量CSS才能展示独立组件。

## 组件合同与预览

每组组件同目录保留一份MD，包含用途、组成、状态、行为、内容、可访问性、规则和可操作示例。复合组件用`exports`数组声明子组件归属；例如Dialog的Trigger/Content/Title/Close共用一份合同。生成器检查公开组件恰好属于一份合同，类型/API从实际TypeScript声明读取。

包构建生成Markdown副本、API、`components.json`和`llms.txt`；设计站点展示文档与同一包的独立iframe实例。Agent从[包入口](../packages/ui/agent-guide.md)进入，先查合同再组合。包依旧private，实验导出从`@areal/ui/wip`消费，未发布到npm。

## 验证与完成边界

迁移检查分三层：包与目录生成/依赖边界；独立示例中的实际状态与键盘焦点；原产品路径中的草稿、保存、审批、工具与面板行为。相关入口：

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui design:build
node clients/gui/scripts/design-system-smoke.mjs --ui-library
node clients/gui/scripts/design-system-smoke.mjs --settings-only
node clients/gui/scripts/design-system-smoke.mjs --shared-workspace
node clients/gui/scripts/design-system-smoke.mjs --decision-exercise
node clients/gui/scripts/worktree-ui-smoke.mjs
```

原产品控制器的源码存在不表示迁移遗漏；包化和示例通过也不等于全产品视觉、真实供应商、跨平台或安装包验收。具体运行结果保存在任务证据中。稳定API、Base准入及视觉优化分别判断，不因移动文件自动升级。
