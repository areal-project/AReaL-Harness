# T3 Code 输入、对话流与 Thread 面板源码调研

本材料用于评审借鉴范围与验收指标。结论来自本地 T3 Code 与 AReaL 源码阅读；候选优化尚未实施，性能指标尚未实测。重点是三块工作如何连成可操作的路径：**引用文件/目录 → 发送并阅读对话 → 点击文件链接 → 右侧阅读/定位 → 从树中再次加入输入；同时从 Thread details 处理工作区与 Git。**

## 阅读导航

- 先看“截图与功能边界”，明确两个右侧区域以及引用/附件的区别。
- “T3 源码清单”逐项列出功能、交互、条件与代码证据。
- “AReaL 源码对照与借鉴边界”标出现有基础和需要核查的差异。
- “UI 与交互验收清单”及“性能指标”用于确定验收方式。
- 最后用 R1–R5 决定采纳范围与顺序；所有建议均待评审。

## 截图与功能边界

| 用户截图 | 可直接观察的 UI | 需要用源码补全的行为 |
| --- | --- | --- |
| 图 1：新 Thread 输入 | 居中的新任务状态、图片附件缩略图及移除、文件夹引用、附件入口、模型/推理设置、发送按钮；输入区下方工作区/分支和权限 | 文件/目录如何插入与序列化、附件如何上传、键盘/IME、发送与排队条件、草稿保存和恢复 |
| 图 2：对话与右侧文件 | 消息中的文件/行号链接、右侧标签与面包屑、带行号的内容、目标行选中、树/搜索/选中行 | 点击链接的路径解析与工作区归属、行/范围定位、标签复用、预览/固定、树揭示、搜索与大文件策略 |
| 图 3：Thread details | 右上操作卡显示机器、Open in Cursor、Actions、分支、Commit & push、Changes 和增删行数 | 每个菜单的真实项目、启用条件与结果、快捷键、Git/工作区操作状态、与文件面板的关系 |

**Thread details 操作卡**与**右侧文件/Changes 阅读面板**分别列举；它们可以同时显示。截图中的左侧 Thread 列表只在其订阅与流式性能相关时作为背景，避免把本轮扩大成整个应用导航重做。

截图里的聊天正文含对性能的解释，但正文不是测量记录。本报告中的事实要回到源码；不能凭该正文断言 T3 已达到某个耗时、缓存或刷新指标。

证据标记：**源码事实**表示读到明确实现；**截图观察**表示仅限所展示状态；**建议**表示供采纳的产品/工程选择；**待测**表示需要运行采样。本轮未操作桌面 UI。

## T3 源码清单

### 证据范围

本清单仅供 AReaL 设计 review；没有实现产品改动，没有运行 T3、截图验收、性能压测或供应商请求。所有“机制”均为静态源码观察，不能据此声称更快、无卡顿、无竞态或端到端可用。

- 源仓库：`/Users/sailfish/CodeProject/t3code`。
- 读取时 HEAD：`c8a606c7b73e1e3586d5c06f76c69525f2d4c679`。
- 读取时 `git status --short`：仅 ` M pnpm-lock.yaml`。本任务只读源仓库，没有修改它。
- 范围为 `apps/web`（Electron 包装使用的 Web 界面）和直接依赖的 shared/client-runtime/contracts；不能外推 React Native 移动端完全一致。
- 以下路径全部指向此本地 checkout 的真实绝对路径，行号对应上述读取版本。

### 1. 输入区：编辑、引用与真实附件

“文件引用”和“上传附件”必须在设计 review 中分开。`@` 选择工作区文件 / 文件夹、文件树 Add to chat / Copy mention，以及本地目录拖入，插入的是序列化路径引用；普通文件与图片粘贴 / 拖入进入附件 staging、上传、失败重试和保留生命周期。UI chip 并不能证明文件内容已上传或递归读取。

| 项目 | 源码可确认的行为 / 限制 | 一手证据 |
| --- | --- | --- |
| 编辑器所有者 | Composer 使用 Tiptap 编辑器；键处理先照顾 IME composition、输入字段、代码围栏、列表 / task item，再把 Enter 委托 Composer。不能只复制 textarea Enter 逻辑。 | [apps/web/src/components/ComposerPromptEditorTiptap.tsx:1233](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/ComposerPromptEditorTiptap.tsx#L1233) |
| @ 候选 | path trigger 合并近期 thread、可链接机器以及 workspace file/folder；候选有 basename、父目录、pathKind、搜索目标。agent 问题回答不附机器候选。 | [apps/web/src/components/chat/useComposerMenuItems.ts:181](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerMenuItems.ts#L181) |
| @ 读取成本 | 仅 path trigger 激活工作区 path search；thread 搜索使用 titlesOnly；thread recency 的 now 在 Composer mount 时固定。 | [apps/web/src/components/chat/useComposerMenuItems.ts:90](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerMenuItems.ts#L90) |
| 路径搜索常量 | path debounce120ms、Composer limit80；内容搜索 debounce120ms / limit500；thread search debounce120ms；这些是请求策略，未测耗时。 | [apps/web/src/state/queries.ts:42](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/state/queries.ts#L42) |
| 菜单状态 | 文件 / 目录无匹配文案、搜索 pending、PR 项目不可用与读取失败分别表达。 | [apps/web/src/components/chat/useComposerMenuItems.ts:352](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerMenuItems.ts#L352) |
| / 与 skill | /model、条件支持的 /plan /default，加 provider slash commands 与 skills；compact 按可用性过滤，非起始位置有命令过滤规则。 | [apps/web/src/components/chat/useComposerMenuItems.ts:212](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerMenuItems.ts#L212) |
| PR 引用 | PR 文本和精确编号查询均180ms debounce；先已有列表匹配，必要时详情查询；候选保留标题、URL、head/base、state、draft。 | [apps/web/src/components/chat/useComposerMenuItems.ts:123](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerMenuItems.ts#L123) |
| 菜单方向键 | 候选 ArrowUp/ArrowDown 循环移动高亮，保留当前 item identity。 | [apps/web/src/components/chat/ChatComposer.tsx:2000](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L2000) |
| 树到输入区 | Copy mention 使用 serializeComposerFileLink；Add to chat 插入引用文本并保证 leading boundary；Composer 不可用时显示明确错误。 | [apps/web/src/components/files/FileBrowserPanel.tsx:175](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L175) |
| 内部拖动引用 | Composer capture 阶段先处理 mention / PR 拖拽，交给专属控制器处理传播和 move，插入失败有提示。 | [apps/web/src/components/chat/ChatComposer.tsx:2552](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L2552) |
| 外部文件拖入 | DataTransfer.items 分离 file / directory；不支持 items 时退回 files；drag enter/leave/drop 维护高亮并分别调用 addFiles/addFolders。 | [apps/web/src/components/chat/workspaceFileDrop.ts:34](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/workspaceFileDrop.ts#L34) |
| 目录拖入限制 | 只支持 local desktop environment，需 desktopBridge.getPathForFile；取不到路径提示手输 @；插入路径引用而非递归上传。 | [apps/web/src/components/chat/ChatComposer.tsx:2468](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L2468) |
| 粘贴路由 | 先分离 clipboard 文件/目录；附件合适时 preventDefault，分别处理；已有 composer context clipboard 交给 editor；其余尝试大文本附件化。 | [apps/web/src/components/chat/ChatComposer.tsx:2507](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L2507) |
| 附件接收条件 | 无 activeThread、revert checkpoint 时拒绝；agent question 按 supportsQuestionAttachments、allowCustomAnswer、responding 状态限制。 | [apps/web/src/components/chat/useComposerAttachmentIntake.ts:123](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerAttachmentIntake.ts#L123) |
| 异步归属 | 压缩前捕获 threadId；附件槽同步预留避免并发 paste 超额；重新选择 needs-reattach 标记替换原槽，不多算一个。源码表达意图，未做竞态验收。 | [apps/web/src/components/chat/useComposerAttachmentIntake.ts:136](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerAttachmentIntake.ts#L136) |
| 附件上限 | contracts：输入120000字符、每条100附件、图片10MiB、全部图片80MiB、普通文件50MiB；具体 provider/fileStagingLimit 能进一步收紧。 | [packages/contracts/src/chatAttachment.ts:13](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/packages/contracts/src/chatAttachment.ts#L13) |
| 大文本粘贴 | 阈值32KiB，兼顾字符串长度与 UTF-8 字节；bypass、超输入上限与 canAttach 参与 disposition。 | [packages/client-runtime/src/textPaste.ts:1](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/packages/client-runtime/src/textPaste.ts#L1) |
| 大文本边界 | literal pending answer 不折叠；槽、revert、问题支持、stagingLimit 均影响能否附件化；无法附件且超输入上限时给明确错误。 | [apps/web/src/components/chat/useComposerAttachmentIntake.ts:359](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerAttachmentIntake.ts#L359) |
| 文本附件来源 | 生成命名文本 File，检查 stagingLimit，再带 source=pasted-text 走统一附件 intake。 | [apps/web/src/components/chat/useComposerAttachmentIntake.ts:412](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useComposerAttachmentIntake.ts#L412) |
| 图片呈现 | 图片预览、上传状态、retry、remove、本地草稿不能持久化标记；媒体与非媒体分列。 | [apps/web/src/components/chat/ComposerAttachmentStrip.tsx:150](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerAttachmentStrip.tsx#L150) |
| 视频附件 | 本地视频 thumbnail / 播放预览，或按已上传 attachment id 打开；受 provider 上传能力和字节上限约束。 | [apps/web/src/components/chat/ComposerAttachmentStrip.tsx:327](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerAttachmentStrip.tsx#L327) |
| 普通文件 | 单独列表呈现上传 / reattach 状态及预览、移除动作；不能把每个 chip 等同可发送。 | [apps/web/src/components/chat/ComposerAttachmentStrip.tsx:406](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerAttachmentStrip.tsx#L406) |
| 发送等待 | preparing images 与 pendingDraftWork 会阻止过早提交；submission 由独立逻辑处理。 | [apps/web/src/components/chat/ChatComposer.tsx:2043](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L2043) |
| 模型入口 | provider/model picker，draft 可按支持条件多模型选择；空选择会阻止发送。 | [apps/web/src/components/chat/ChatComposer.tsx:893](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L893) |
| 模型浏览 | 搜索、provider instance rail、favorites，跨 provider 搜索 / favorites 混排时保留 provider 行信息。 | [apps/web/src/components/chat/ModelPickerContent.tsx:378](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ModelPickerContent.tsx#L378) |
| 多模型 | toggle 处理 provider instance 与模型 identity，多模型为 draft 路径，受 supportsMultipleModels 限制。 | [apps/web/src/components/chat/ComposerFooterControls.tsx:357](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerFooterControls.tsx#L357) |
| 模型 traits | 由 provider 描述符决定 effort/reasoningEffort、boolean fastMode 和其他 trait；UI 选择器支持 label/glyph。不能假设所有 provider 都支持同套参数。 | [apps/web/src/components/chat/TraitsPicker.tsx:150](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/TraitsPicker.tsx#L150) |
| 速度标签 | Fast/Ultrafast 图标从 fastMode 或 descriptor options 推导，仅代表参数选择；不证明真实供应商延迟。 | [apps/web/src/components/chat/TraitsSpeed.tsx:8](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/TraitsSpeed.tsx#L8) |
| 模式与权限 | Plan/build interaction mode 与 runtime permissions 独立；当前 access 与默认一致时可隐藏权限 chip；有方向键选权限选项。 | [apps/web/src/components/chat/ComposerFooterControls.tsx:43](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerFooterControls.tsx#L43) |
| 自适应控件 | controls bar 有 resting blocks / 隐藏项计数和 compact 入口；布局所有者分离，模型 picker 与 traits 自适应。 | [apps/web/src/components/chat/ComposerControlsBar.tsx:214](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerControlsBar.tsx#L214) |
| 主动作 | 停止生成、发送、队列、alternate dispatch、resume、compact-before-send；disabled 汇合 thread 操作权限、sendDisabledReason 和 environment 状态。 | [apps/web/src/components/chat/ComposerPrimaryActions.tsx:113](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L113) |
| 快捷键命令 | 打开模型、升降 effort、host/mode/workspace/branch、previous worktree 都有命令路由；过滤 key repeat。具体组合键来自设置，不能从命令名猜键。 | [apps/web/src/components/chat/composerShortcuts.ts:13](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/composerShortcuts.ts#L13) |
| 流式隔离 | paste callback 用 useStableCallback，源码特别说明 editor memo 化，fresh closures 会随 parent delta 重渲染；这是机制约束，未测 render 次数。 | [apps/web/src/components/chat/ChatComposer.tsx:2534](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatComposer.tsx#L2534) |

### 2. 对话流、文件链接与渲染性能

| 项目 | 源码可确认的行为 / 限制 | 一手证据 |
| --- | --- | --- |
| 文件链接主动作 | 普通点击优先文件 preview panel；有 threadRef+panelPath 时传 path 与 line；否则媒体预览，再退外部编辑器。条件浏览器主动作可优先 integrated browser。 | [apps/web/src/components/chat/MarkdownFileLink.tsx:110](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownFileLink.tsx#L110) |
| 修饰点击与菜单 | 修饰点击由 shouldOpenMarkdownFileLinkInEditor 决定 editor；右键可按能力显示媒体预览、editor、integrated browser、reveal、复制相对 / 完整路径。 | [apps/web/src/components/chat/MarkdownFileLink.tsx:244](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownFileLink.tsx#L244) |
| 可操作性 | canOpenInEditor/browser/panel/media 共同决定 chip 是否有 primary action；文件名图标、文档类型和 tooltip 分开。 | [apps/web/src/components/chat/MarkdownFileLink.tsx:309](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownFileLink.tsx#L309) |
| 复制异步约束 | ClipboardItem promise 尽早发起写入，源码说明保留 Safari user gesture；无 clipboard API / 写失败有错误。 | [apps/web/src/components/chat/MarkdownFileLink.tsx:198](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownFileLink.tsx#L198) |
| 重复打开定位 | openFile 按 file:path 复用 surface，打开 panel 并 activate；每次 revealRequestId +1；请求路径为 `.` 时打开 files，过滤 standalone explorer，保留每个 file tab。 | [apps/web/src/rightPanelStore.ts:729](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/rightPanelStore.ts#L729) |
| 树定位联动 | 外部选择先 load ancestors，再展开祖先、选择、center scroll/focus；已处理 reveal 不重放，树自己选择不清搜索。 | [apps/web/src/components/files/FileBrowserPanel.tsx:411](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L411) |
| 消息虚拟列表 | LegendList，estimatedItemSize90、key/type extractor、alwaysRender pins、dataVersion、初始尾部或 remembered position；无全量 DOM 展示的承诺。 | [apps/web/src/components/chat/MessagesTimeline.tsx:1301](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L1301) |
| 尾随开关 | liveFollow、citation、find、恢复历史位置、fullscreen、折叠 settle 影响 maintainScrollAtEnd / visibleContentPosition；threshold1，reduced motion 控制 animated。 | [apps/web/src/components/chat/MessagesTimeline.tsx:1318](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L1318) |
| 布局尾随原因 | dataChange/itemLayout/layout 会触发尾随，footerLayout=false；working 状态另用 animated 版本。 | [apps/web/src/components/chat/MessagesTimeline.tsx:184](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L184) |
| 用户导航状态 | viewport 集中识别 wheel/touch/key 导航，following/released 状态机；不靠每个消息组件自行抢 scroll。 | [apps/web/src/components/chat/timelineViewport.ts:62](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/timelineViewport.ts#L62) |
| Composer 与滚动 | Composer inset 变高时仅在 following 下 scrollToEnd；page up/down、导航 release 和 footer growth 由统一 follow hook 协调。 | [apps/web/src/components/chat/useTimelineFollow.ts:350](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useTimelineFollow.ts#L350) |
| 恢复位置 | rememberPosition 按 row anchor 与 scrollOffset 记忆；follow release 即使没有新 scroll 也记住状态。 | [apps/web/src/components/chat/MessagesTimeline.tsx:894](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L894) |
| minimap | 按语义 rows 生成定位项、当前可见项；scroll 更新用 rAF 合并并避免未变 strip 属性写入；点击 scrollToIndex viewOffset24。 | [apps/web/src/components/chat/MessagesTimeline.tsx:838](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L838) |
| 测量频率 | lane width ResizeObserver 按宽度变化测，不因每个 streamed content frame 测；content size 通知另用 rAF 合并。 | [apps/web/src/components/chat/MessagesTimeline.tsx:978](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L978) |
| 行身份 | 增量计算 rows、复用 stable rows；run status/timestamp 每 delta 变化被排除 shared row context；row content memo。 | [apps/web/src/components/chat/MessagesTimeline.tsx:668](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L668) |
| 历史折叠 | run / attempt fold，搜索和 citation 可展开对应项；deferred work 展开后加载 earlierHistory，失败显示 retry。 | [apps/web/src/components/chat/MessagesTimeline.tsx:1575](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MessagesTimeline.tsx#L1575) |
| Markdown总入口 | ChatMarkdown memo；renderer context 与不断增长 text context 分离；checkbox 按 source offset 查 marker，避免每 token 改全部 list item。 | [apps/web/src/components/ChatMarkdown.tsx:923](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/ChatMarkdown.tsx#L923) |
| Markdown能力 | 共享 components 覆盖 headings、links、inline code、code blocks、table、details、math/media/thread/context/citation；是否 raw HTML 与 math 有条件开关。 | [apps/web/src/components/ChatMarkdown.tsx:951](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/ChatMarkdown.tsx#L951) |
| 增量 Markdown开启条件 | 仅 streaming=true、无额外 remark plugins 且有 fence 模式时启用；其他文本走普通 parser，不能宣称所有 Markdown 增量解析。 | [apps/web/src/components/ChatMarkdown.tsx:1642](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/ChatMarkdown.tsx#L1642) |
| 增量解析缓存边界 | 只缓存已闭合且后接空行 code fence 前缀；非 startsWith、CR/BOM、definition/footnote 回全量解析；clone 节点以避 remark mutation，恢复 parse 不复用文档缓存。 | [apps/web/src/markdown-incremental.ts:33](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/markdown-incremental.ts#L33) |
| 代码高亮缓存 | LRU 最多500条 / 50MiB，key包含 code/language/theme；只有完成 block 缓存。 | [apps/web/src/components/chat/MarkdownCodeBlock.tsx:32](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownCodeBlock.tsx#L32) |
| 流式代码高亮 | preserveLines 走 incremental highlighter，结束后保持逐行 renderer，避免切 cached HTML 清 selection；失败退纯文本，dispose on unmount。 | [apps/web/src/components/chat/MarkdownCodeBlock.tsx:277](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownCodeBlock.tsx#L277) |

### 3. Thread details：工作区、Git 与信息密度

Thread details 卡片和右侧 workspace surfaces 是不同所有者。卡片可能内联或 popover；“Changes”动作打开独立 Diff surface。不能把卡片里的 Git 行误当固定右边栏的唯一内容。

| 项目 | 源码可确认的行为 / 限制 | 一手证据 |
| --- | --- | --- |
| 卡片布局 | 宽280、gap12；保留 chat lane minWidth / clearance；可用高度不足160时回 popover；容器/浮窗位置参与判断。 | [apps/web/src/components/chat/threadDetailsCardLayout.ts:4](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/threadDetailsCardLayout.ts#L4) |
| 卡片密度 | 按 full/compact 实测内容高度选择 full、compact、essential；测量 key 含环境/thread/宽度/显示项；列表扩展高度从 fitting height 扣除。 | [apps/web/src/components/chat/ThreadDetailsCard.tsx:50](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ThreadDetailsCard.tsx#L50) |
| 显示项 | Environment、Open editor、scripts、branch/PR、git actions、changes、servers、automations、lineage 默认开，Usage 默认关；设置只存偏离默认项。 | [apps/web/src/components/chat/threadDetailsItems.ts:4](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/threadDetailsItems.ts#L4) |
| 右键定制 | 卡片空白右键显示选择项；input、链接、editable 和选中文本保留自身菜单；全部隐藏时有 Choose what to show。 | [apps/web/src/components/chat/ThreadDetailsPanel.tsx:127](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ThreadDetailsPanel.tsx#L127) |
| 密度降级规则 | essential 隐藏 Open；environment 仅 full；Git branch 要 gitCwd+isGitRepo；scripts 需实际配置。 | [apps/web/src/components/chat/ThreadDetailsPanel.tsx:146](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ThreadDetailsPanel.tsx#L146) |
| Open in | 菜单提供可用 editor / file manager，主按钮使用 preferredEditor，成功后记 preference；远程打开路径有独立模式判断。 | [apps/web/src/components/chat/OpenInPicker.tsx:232](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/OpenInPicker.tsx#L232) |
| Open 显示边界 | 无 project 隐藏；主环境可用；远程 local-exec 模式隐藏。 | [apps/web/src/components/chat/OpenInPicker.logic.ts:5](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/OpenInPicker.logic.ts#L5) |
| 工作区选择 | 当前 workspace、local / new worktree / previous worktree；forceNewWorktree、envLocked、server thread 已有 worktree 影响可选状态；多模型有 each own worktree 文案。 | [apps/web/src/components/BranchToolbar.tsx:191](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/BranchToolbar.tsx#L191) |
| previous worktree | 只有非 server thread、未锁定、非 forceNewWorktree 才查询 project shells 推导 seed；复用 branch/path/envMode。 | [apps/web/src/components/BranchToolbar.tsx:632](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/BranchToolbar.tsx#L632) |
| branch所有者 | BranchToolbarBranchSelector 负责 branch picker；卡片把 environment/workspace 与 branch 两 section 复用同一 toolbar props，避免两个状态源。 | [apps/web/src/components/chat/ThreadDetailsPanel.tsx:89](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ThreadDetailsPanel.tsx#L89) |
| Git菜单可用性 | Commit需 changes+非busy；Push需 branch、非behind、ahead>0、upstream或primaryRemote；Create PR另需无 open PR、有 default delta；无 remote 只给 Commit。 | [apps/web/src/components/GitActionsControl.logic.ts:108](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.logic.ts#L108) |
| Git主动作选择 | busy/status缺失/detached 禁用带 hint；有 changes 时 Commit / Commit&push / Commit,push&PR；无 changes 依据 upstream、ahead/behind、open PR、default delta 选 Publish/Pull/Push/PR。 | [apps/web/src/components/GitActionsControl.logic.ts:177](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.logic.ts#L177) |
| Git分叉限制 | clean upstream diverged 为 Sync ref disabled，要求先 rebase/merge；只有 behind 可 Pull；完全同步且无 PR delta 显示 disabled Commit。dirty 路径优先级在此判断之前，不应概括为所有 diverged 状态统一禁用。 | [apps/web/src/components/GitActionsControl.logic.ts:269](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.logic.ts#L269) |
| Git UI运行状态 | 权限 canWriteSourceControl 与 running 再约束主 / 菜单动作；status错误、detached、落后提示独立呈现；disabled reason tooltip。 | [apps/web/src/components/GitActionsControl.tsx:1390](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.tsx#L1390) |
| 默认分支对话框 | 支持 continue default branch 或创建 feature branch；没有 working tree changes 时 feature branch 命名不可用；创建与写操作有独立权限限制。 | [apps/web/src/components/GitActionsControl.logic.ts:329](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.logic.ts#L329) |
| Git结果状态 | progress/result presentation 与 elapsed 分离；success 结果可见10000ms。 | [apps/web/src/components/GitActionsControl.logic.ts:50](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.logic.ts#L50) |
| Changes行 | 有repo且非quietEmptyDraft；计数取 branchChanges 优先否则 workingTree；点击需 onOpenChanges；具体文件列表另有选择与 editor 动作。 | [apps/web/src/components/GitActionsControl.tsx:1625](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/GitActionsControl.tsx#L1625) |
| Changes跳转范围 | addDiffSurface 需 activeThreadRef+serverThread+isGitRepo；主动选 branch scope 再 open diff，不能误读为默认 working-tree-only。 | [apps/web/src/components/chat/useRightPanelActions.ts:131](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useRightPanelActions.ts#L131) |
| 更多详情 | Servers、automations、lineage 仅 full+非draft；Usage 按可见配置呈现。 | [apps/web/src/components/chat/ThreadDetailsPanel.tsx:237](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ThreadDetailsPanel.tsx#L237) |

### 4. 右侧 tabs、文件树、预览 / 行定位与 resize

| 项目 | 源码可确认的行为 / 限制 | 一手证据 |
| --- | --- | --- |
| surface种类 | Browser、Terminal、Files、Diff、Pull request、Linked PR、Device；可用条件逐项判断，不保证任意环境都出现。launcher B/T/F/D/P/L/M 仅为该菜单内快捷键。 | [apps/web/src/components/RightPanelTabs.tsx:318](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/RightPanelTabs.tsx#L318) |
| 标签交互 | Close、Close others、Close right、Close all；file可Copy path，device可rename，browser可mute；横向滚动tabs箭头，激活surface由store统一。 | [apps/web/src/components/RightPanelTabs.tsx:1080](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/RightPanelTabs.tsx#L1080) |
| panel状态 | byThreadKey 按 environment/thread 隔离；local storage key t3code:right-panel-state:v2 / schema version14，surface与visibility分开。持久化的tab状态不等于文件内容缓存。 | [apps/web/src/rightPanelStore.ts:79](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/rightPanelStore.ts#L79) |
| 响应式panel | max-width980px 是 inline布局media query；ChatRightPanel 选择 inline或sheet；宽度状态放局部避免带动ChatView。 | [apps/web/src/components/chat/ChatRightPanel.tsx:14](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ChatRightPanel.tsx#L14) |
| 外层尺寸 | 默认540、min360、max viewport70%，并在container留 sibling360；窗口 / row resize重新clamp。 | [apps/web/src/hooks/usePreviewPanelInlineSize.ts:13](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/hooks/usePreviewPanelInlineSize.ts#L13) |
| resize写入 | pointer期间写 --resizable-width DOM custom property，结束才 commit React state/localStorage；中途切storageKey仍提交到起始key；取消复原。 | [apps/web/src/hooks/useResizableWidth.ts:69](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/hooks/useResizableWidth.ts#L69) |
| 文件树内部宽度 | 默认256，min160/max560，内容区至少256；storage=t3code.fileExplorerWidth；方向键16px步进，Home/End极值且separator可focus/aria数值。 | [apps/web/src/components/files/FileExplorerPane.tsx:8](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileExplorerPane.tsx#L8) |
| 重型panel懒加载 | Preview、Diff、Device、FilePreviewPanel 经 React.lazy；这说明加载边界，不能推断所有后台panel卸载或内存上限。 | [apps/web/src/components/chat/RightPanelSurfaceContent.tsx:26](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/RightPanelSurfaceContent.tsx#L26) |
| 文件surface参数 | 文件 / files统一 FilePreviewPanel；workspaceRoot或attachment id是key；传 relativePath/revealLine/revealRequestId/selected pending/文件导航回调。 | [apps/web/src/components/chat/RightPanelSurfaceContent.tsx:184](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/RightPanelSurfaceContent.tsx#L184) |
| 文件树基础 | Pierre tree compact、flattenEmptyDirectories、initialExpansion closed、hide-non-matches；selected file 打开预览，拖动时不误开；禁止drop改树。 | [apps/web/src/components/files/FileBrowserPanel.tsx:270](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L270) |
| 按目录加载 | root mount读取、展开目录时load；每目录loaded集合 / in-flight promise合并；最多4并行；刷新只请求曾请求且可达目录，最多4workers。 | [apps/web/src/components/files/useDirectoryEntries.ts:11](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/useDirectoryEntries.ts#L11) |
| 断线恢复 | environment session generation 变化后重新读错误目录；unmount 后忽略晚到结果。未做跨环境切换竞态实测。 | [apps/web/src/components/files/useDirectoryEntries.ts:97](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/useDirectoryEntries.ts#L97) |
| 搜索限制 | query slice256，path结果limit200，实际debounce120ms在queries；搜索补齐祖先；hostFolder只搜loaded folders，不递归遍历host。 | [apps/web/src/components/files/FileBrowserPanel.tsx:152](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L152) |
| 展开所有 | 跳过ignored目录，手动仍可展开；host folder 禁止全量expand；避免node_modules之类全目录主动遍历。 | [apps/web/src/components/files/FileBrowserPanel.tsx:129](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L129) |
| 搜索键盘 | search input Escape清理并blur；无匹配单独状态，绕过Pierre无匹配时还原未过滤树的行为。 | [apps/web/src/components/files/FileBrowserPanel.tsx:80](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L80) |
| 增量树同步 | 第一次resetPaths，随后buildFileTreePathUpdates+model.batch；mutationId触发目录和活跃search refresh。 | [apps/web/src/components/files/FileBrowserPanel.tsx:376](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L376) |
| 外部定位防干扰 | 按path+revealId去重；未处理的外部定位清search、展开祖先、选中并center；refresh不反复抢焦点。 | [apps/web/src/components/files/FileBrowserPanel.tsx:411](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FileBrowserPanel.tsx#L411) |
| 行定位算法 | 等待contents/metrics，clamp line；用Pierre line position+DOM几何算scroll；最多30frame尝试，随后20frame guard，2px tolerance；wheel/touch/pointer取消guard。 | [apps/web/src/components/files/FilePreviewPanel.tsx:408](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FilePreviewPanel.tsx#L408) |
| 预览与行定位优先级 | Markdown/Mermaid/HTML/table渲染偏好仅在 revealHandled 后满足；带行号链接会先走source定位，避免被富预览吞掉。 | [apps/web/src/components/files/FilePreviewPanel.tsx:1080](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FilePreviewPanel.tsx#L1080) |
| 源码虚拟化 | file-preview-virtualizer overscrollSize600；wordWrap影响wrap/scroll；tokenize是否允许按DEFAULT_TOKENIZE_MAX_LENGTH判断；超大文本另lazy LargeTextViewer。 | [apps/web/src/components/files/FilePreviewPanel.tsx:856](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FilePreviewPanel.tsx#L856) |
| 文档种类 | files目录含Markdown、Mermaid、PDF、Office/OpenXML、notebook、delimited tables、image/audio/font/binary等独立preview模块；存在模块不证明所有格式都成功解析。 | [apps/web/src/components/files/FilePreviewPanel.tsx:155](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/FilePreviewPanel.tsx#L155) |
| 未保存所有者 | projectFilesQueryState 有 optimistic file atom / unsaved mounts / save coordination；path_not_file 的folder错误覆盖 isFile 判定，即使失败refresh还保留缓存contents；一般错误不意味着清空全部旧data。 | [apps/web/src/components/files/projectFilesQueryState.ts:37](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/files/projectFilesQueryState.ts#L37) |


### 5. 补充：Actions / 分支 / Changes 与消息用户动作

| 项目 | 源码可确认的行为 / 限制 | 一手证据 |
| --- | --- | --- |
| Actions 的含义 | Actions 是 project-scoped shell commands，和Git actions分开；支持preferred/primary action一键运行、所有脚本子菜单、Add action、每项Edit、快捷键标签。无onRunScript即禁用。 | [apps/web/src/components/ProjectScriptsControl.tsx:177](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/ProjectScriptsControl.tsx#L177) |
| 脚本导入 | 项目file scripts可导入，按同command或不区分大小写同name去重；导入保留worktree/setup/settle/preview等配置。 | [apps/web/src/components/ProjectScriptsControl.tsx:107](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/ProjectScriptsControl.tsx#L107) |
| 脚本配置 | Name、Command、icon、快捷键、worktree create时执行、wait for setup、settle时执行、Preview URL / autoOpen；快捷键environment-wide；删除需确认，权限影响编辑。 | [apps/web/src/components/projectScriptEditor.tsx:269](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/projectScriptEditor.tsx#L269) |
| 运行脚本 | 要求terminal operate scope+activeThread/project；记录该project最后执行脚本；cwd优先options再gitCwd再workspaceRoot；找可复用drawer terminal，排除panel-owned/running等，由helper决定。 | [apps/web/src/components/chat/useChatTerminalActions.ts:197](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useChatTerminalActions.ts#L197) |
| 终端关联 | launchTerminal先放入drawer，带cwd/worktree/env；等待open成功后write command，再可选打开preview URL；失败写入thread error。运行语义是终端命令输入，非专用job panel。 | [apps/web/src/components/chat/useChatTerminalActions.ts:242](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useChatTerminalActions.ts#L242) |
| 停止脚本的证据限制 | ProjectScriptsControl静态入口只发现Run/Edit/Add/Import，未发现独立Stop action；通用closeTerminal需operate权限，调用closeTerminalSession并清理UI。终端Ctrl+C对具体脚本的信号/子进程效果本轮未核实。 | [apps/web/src/components/chat/useChatTerminalActions.ts:191](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/useChatTerminalActions.ts#L191) |
| 分支搜索/创建 | useDeferredValue文本，sanitize后分页查refs（queries的单页limit100）；精确匹配已有name时隐藏Create；选择new worktree base时禁止Create；能解析PR reference时可Checkout PR。 | [apps/web/src/components/BranchToolbarBranchSelector.tsx:217](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/BranchToolbarBranchSelector.tsx#L217) |
| 分支选择细节 | 选worktree base只设置draft branch，不立即checkout；branch在已有worktree时复用；其他路径switchRef，远程ref派生local name；乐观显示失败还原并toast，结束刷新refs/status。 | [apps/web/src/components/BranchToolbarBranchSelector.tsx:383](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/BranchToolbarBranchSelector.tsx#L383) |
| 分支创建细节 | createRef输入switchRef=true；需canChangeThreadBranch+cwd+非pending；失败回原optimistic branch，成功更新thread branch/worktree关联。 | [apps/web/src/components/BranchToolbarBranchSelector.tsx:444](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/BranchToolbarBranchSelector.tsx#L444) |
| Diff scopes | Changes=branch，Uncommitted=unstaged，Latest turn/历史Turn=checkpoint相邻range；Tool call有独立selection；collapse key含environment/thread/section。不能把Uncommitted字面外推其所有Git索引行为。 | [apps/web/src/components/DiffPanel.tsx:298](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/DiffPanel.tsx#L298) |
| Diff筛选/导航 | scope dropdown、base-ref可搜索选择；文件树点击revealDiffFile；可隐藏test files、单文件/全部collapse；未载入目标先requestFile再定位，重复reveal有requestId。 | [apps/web/src/components/DiffPanel.tsx:598](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/DiffPanel.tsx#L598) |
| Diff显示 | stacked映射unified、split映射split；用户可切换；主viewer AnnotatableCodeView支持搜索match reveal展开文件、header复制path、失败/截断状态与retry。 | [apps/web/src/components/DiffPanel.tsx:1192](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/DiffPanel.tsx#L1192) |
| Diff懒加载 | preview source truncated且有files目录时走lazySource；首批indices0..3，之后4个一批；点击任意文件可单独请求；pending file保留元信息占位；scope含cwd/sourceKind/diffHash/baseRef/ignoreWhitespace。 | [apps/web/src/components/diffs/useReviewFilePatches.ts:19](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/diffs/useReviewFilePatches.ts#L19) |
| Diff内容身份 | WeakMap按FileDiffMetadata记identity/version；old/new contents cacheKey带diffHash与path，由loader交给Pierre。该loader本身每次调用RPC，不应误称其实现LRU；Git RPC缓存TTL/容量本轮未核实。 | [apps/web/src/components/DiffPanel.tsx:109](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/DiffPanel.tsx#L109) |
| Diff worker与虚拟化 | StyledDiffCodeView包装Pierre CodeView与DiffWorkerPoolProvider，显式header32/hunk24/spacing0/paddingBottom8度量；共享worker数=clamp(floor(cores/2),2,6)，无人消费30s后terminate。未测吞吐或内存。 | [apps/web/src/components/DiffWorkerPoolProvider.tsx:20](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/DiffWorkerPoolProvider.tsx#L20) |
| Diff刷新 | workspaceMutationId与preview刷新路径；隐藏panel仍mount，重新显示才revalidate；read floor10000ms，intervalMs=null，明确不timer持续重算Git diff；另有手动Refresh按钮。 | [apps/web/src/components/DiffPanel.tsx:522](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/DiffPanel.tsx#L522) |
| Git大Diff边界 | GitVcsDriverCore review preview patch120000 bytes、metadata16MiB、untracked上限5000、单文件输出1MiB；range summary19000/patch59000是其他用途，不应混同review阈值。 | [apps/server/src/vcs/GitVcsDriverCore.ts:68](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/server/src/vcs/GitVcsDriverCore.ts#L68) |
| 源码可见消息动作 | user message有复制正文/Copy prompt link；Edit from here调用onRevertToTurnCount，working或revert时禁用。它涉及回到turn语义，不应当普通原地文本编辑。 | [apps/web/src/components/chat/TimelineUserMessageRow.tsx:790](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/TimelineUserMessageRow.tsx#L790) |
| 助手分叉 | Fork from this response受projected item、provider session capabilities、runId与callback可用性限制，busy时禁用；copyStreaming/showCopyButton由timeline row传入。未核实独立Resend按钮，不能宣称具备。 | [apps/web/src/components/chat/TimelineAssistantRows.tsx:79](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/TimelineAssistantRows.tsx#L79) |
| 过程与工具 | run/attempt/work group折叠、find/citation自动展开、deferred earlier history加载见前表；审批卡保留detail/appName/reason、responding状态与provider options，决定动作由options驱动。 | [apps/web/src/components/chat/TimelinePendingApprovalRow.tsx:51](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/TimelinePendingApprovalRow.tsx#L51) |
| 提问与查找 | ComposerPendingUserInputPanel呈现多问题选择/自定义输入/disabled或responding；ThreadFindBar有previous/next、Enter前进、Shift+Enter后退；minimap见前表独立定位。 | [apps/web/src/components/chat/ThreadFindBar.tsx:26](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ThreadFindBar.tsx#L26) |
| 代码操作 | Copy code与Copied反馈；符合shell命令检测且有onRunShellCommand时Run in terminal；非所有代码块都可执行。 | [apps/web/src/components/chat/MarkdownCodeBlock.tsx:154](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownCodeBlock.tsx#L154) |
| 表格操作 | 横向ScrollArea；菜单复制Markdown或CSV；复制反馈timeout1200ms，失败上报；本轮未发现独立导出文件按钮。 | [apps/web/src/components/chat/MarkdownTable.tsx:16](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/MarkdownTable.tsx#L16) |
| 图片操作 | message附件与Markdown媒体经独立组件，ExpandedImageDialog/ZoomableImage提供扩大预览，输入区strip也支持图片预览；具体下载/缩放手势/失败重试状态需UI验收，不在本清单外推。 | [apps/web/src/components/chat/ExpandedImageDialog.tsx:1](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/web/src/components/chat/ExpandedImageDialog.tsx#L1) |

## 补充：切换聊天的缓存与订阅成本

T3 把订阅存活和恢复缓存分开：`packages/client-runtime/src/state/threadRetention.ts:1` 定义 5 分钟 idle TTL；`state/threads.ts:1069` 将其用于 resume cache atom。Web 界面中的桌面 keep-alive 实现见 `apps/web/src/state/threads.ts:75`、`:89`、`:127`：preparing/queued/starting/running Thread 被额外保留，停止后还要等独立 detail stream 已 live 且追上停止状态才释放。平台适用范围及“隐藏但仍挂载的消费者也计入订阅”见 `docs/internals/connection-runtime.md:100`。

这解释了热切换可能复用状态与游标的机制，同时意味着运行中聊天会有额外常驻成本。5 分钟是空闲过期参数，不能写成总内存上限，也不能证明任意冷打开都会命中缓存。AReaL 是否需要类似保留策略，应结合现有历史分页、订阅所有者和 P05/P13 的真实结果决定。


## AReaL 源码对照与借鉴边界

以下是源码具备的入口，不代表这些路径已完成本轮运行验收。AReaL 基线为 `0d340cfc95fd5727defeab3b88cb2db4ff05d24e`，调研开始时工作区干净。

| 范围 | AReaL 当前入口与已读代码 | 本轮建议 review 的差异 |
| --- | --- | --- |
| 输入文件与目录 | `clients/gui/renderer/src/lib/workspaceFileComposer.ts:11` 插入引用、`:40` 校验当前工作区文件/目录、`:95` 搜索适配；`mentions/mentionMarkdown.ts:49` 保留目录语义 | 已有引用基础。对齐插入位置、路径提示、文件/文件夹图标、原子删除、复制粘贴与消息回显的整条链路，先核查再列具体缺项 |
| 外部附件与拖拽 | `clients/gui/renderer/src/prompt-editor/ChatPromptEditor.tsx:438` 区分工作区引用和外部附件；`:460` 对外部目录给出不支持反馈；`Composer.tsx:1080` 处理粘贴附件 | 将工作区目录引用、外部文件上传、外部目录处理明确区分；截图中的文件夹 chip 无法证明支持递归上传文件夹。是否扩展外部目录是独立产品选择 |
| 消息文件链接 | `clients/gui/renderer/src/components/ai-elements/message-response-renderer.tsx:212` 区分文件与外链；`Messages.tsx:766` 处理文件打开；`state/useWorkspaceDocuments.tsx:20` 转项目相对路径后打开面板 | 已有消息→文件面板路径。重点核查 T3 式行/列/范围定位、工作区归属、文件树揭示与返回阅读，不能仅比较链接颜色 |
| 标签与阅读上下文 | `clients/gui/renderer/src/state/useWorkspacePanels.ts:211` 按项目/Thread 恢复面板；`:249` 预览标签替换；`:130` 固定预览；`state/useWorkspaceDocuments.tsx:47` 修改后固定 | 复用现有面板和文档所有者，评审预览/固定语义、标签关闭、未保存内容保护及切换聊天后的归属；避免复制另一套标签状态 |
| 右侧文件树 | `clients/gui/renderer/src/workspace-file-tree/WorkspaceFileTree.tsx:43` 记忆展开/搜索/选择；`:59` 随活动文件展开父目录；`:70` 获取已展开目录；`:103` 搜索有 180ms 延迟 | 已有树与定位基础；展开目录集合变化会重读根及已展开目录，先测目录请求数/字节和热路径，再决定是否需要增量缓存；核查巨大树的实际 DOM 数与键盘操作 |
| Git 与 changes | `clients/gui/renderer/src/GitPane.tsx:152` 审查范围、`:301` 按需分支读取、`:431` 比较读取；`GitActions.tsx:77` gitState、`:130` 携带 token 执行 stage/unstage/commit/push | 已有 Git 事实与审查能力。候选工作是把常用上下文和操作收拢到 Thread details 入口；分支“比较”与“切换”应单独核查，不根据一个下拉框推定能力等同 |
| 工作区上下文 | `clients/gui/renderer/src/ComposerWorkspaceContext.tsx:43` 绑定项目/Thread/root/连接，`:142` 展示 worktree 与分支 | 机器/项目、执行工作区、当前分支需要可辨认；沿现有工作区信息与 action 路径组织，不将 T3 服务器或 Provider 生命周期搬入 Renderer |
| 流式阅读与资源 | `clients/gui/renderer/src/Messages.tsx:97` 语义锚点、`:527` 阅读状态、`:641` 历史加载、`:799` 助手正文；就近合同 `Messages.md` 的 CONV-READ-01 / CONV-DISCLOSURE-01 | 已有阅读保持与历史机制。任何渲染优化须保留回看、人工展开、选择文本、复制、子面板返回及权威状态；性能问题需要本仓测量后归因 |

当前规范入口：[工作台](../../../clients/gui/design-system/workbench.md)、[输入与对话组件目录](../../../clients/gui/design-system/inventory.md)、[Messages 合同](../../../clients/gui/renderer/src/Messages.md)。这里的建议是调研候选，不改变现行规范与准入。

## UI 与交互验收清单

下面用于后续 review 和验收设计，并非已发现的 AReaL 缺陷。每个状态以真实用户动作进入；能完成动作、能返回和状态真实是独立于视觉相似度的检查项。

| 区域 | UI 检查 | 交互检查 | 必须覆盖的状态 |
| --- | --- | --- | --- |
| Composer | chip、附件、编辑区、模型/推理设置、工作区信息的层级；一行/多行与紧凑布局 | @ 搜索、方向键选择、Enter/Tab/Esc、中文 IME、删除/撤销、拖入/粘贴、发送后恢复 | 空草稿、长路径/同名文件、文件夹、多个附件、上传中/失败、模型不支持图像、运行中、断线 |
| 对话流 | 用户消息、过程、工具活动、最终回答、文件引用和变更摘要的层级 | 文件链接→正确标签/行→树中定位→加入输入→关闭返回；滚动回看与流式输出同时发生 | 冷打开长历史、正文流式更新、展开/收起、代码/表格/图片、失效链接、切换聊天、资源读取失败 |
| Thread details | 当前机器/项目/工作区、Open、Actions、branch、Git、Changes 的分组与信息密度 | 展开/关闭、键盘导航、Open 目标选择、动作进度/失败、分支搜索/切换、Git 结果读回 | 非 Git 项目、detached HEAD、dirty、无远端、处理中、不可用、切换 Thread、远程环境 |
| 右侧面板 | 标签、面包屑、文件/目录图标、树和编辑区域比例、选中/悬停/聚焦区分 | 单击预览/固定标签、关闭与恢复、树折叠/搜索/刷新、调整宽度、快捷键、返回焦点 | 侧栏展开/关闭、窄窗口、缩放/大字体、深浅色、reduced motion、大文件/二进制/图片、未保存编辑 |

视觉 review 应统一平台、窗口、DPR、缩放、主题、字号及内容，分别观察主聊天全宽、侧面板打开、树打开、详情卡打开和窄窗口。截图尺寸是参考采样，不能直接当作本产品固定 token。图标/无障碍名称、Tab 顺序、焦点可见、tooltip、菜单关闭后焦点归还均需真实交互验证。

## 性能指标：怎么测、以什么判定

源码里的 debounce、分页大小和缓存时间是实现参数；它们不能替代输入延迟、首屏时间、内存或吞吐测量。本轮不提供 T3 或 AReaL 的实测性能排名。以下预算是供 review 的初始候选，最终按相同机器上的基线分布确定；其中等待服务端、磁盘和 Provider 的时间须分段记录。

| ID | 指标与计时边界 | 工作负载/采集方式 | 候选目标或判断方式 |
| --- | --- | --- | --- |
| P01 | 输入反馈：keydown/input → 下一帧显示编辑内容；IME 单独采样 | 连续输入、长草稿、多个引用，同时后台流式输出；event timing + RAF + 长任务 | 本地编辑 p95 ≤50ms，记录 p50/p95/max 与样本数；候选目标，非 T3 实测 |
| P02 | @ 搜索：输入 → 请求发出 → 首批可选结果呈现 | 冷/热搜索、快速改词、无匹配、10k/100k 路径；记录去抖等待/服务耗时/绘制 | 交互状态即时反馈；热路径首批 p95 ≤250ms 为候选；旧查询结果覆盖新查询次数为 0 |
| P03 | 引用插入/删除：确认选择/放下 → chip 出现及光标就绪 | 单个/20/100 个 chip、长路径、撤销重做与中英文混排 | 本地操作 p95 ≤100ms 为候选；引用数量与正确性一致 |
| P04 | 附件准备：拖入/粘贴 → 预览 → 上传完成/失败 | 小图/大图/多文件；记录读取、编码、上传、缩略图各阶段和峰值内存 | UI 不因准备任务阻塞；大小/数量上限、错误、取消分别可见；不把网络时延归因给 UI |
| P05 | 打开聊天：选择 Thread → 首屏可读/可输入；冷/热分开 | 短/长历史、混合工具与代码，记录请求、反序列化、提交、布局与绘制 | 先报基线；热切换候选 p95 ≤200ms，冷路径另定；草稿和阅读状态正确 |
| P06 | 流式开销：每秒增量处理量、React commit 次数/时长、重复 Markdown 处理字节 | 10/30/60 事件每秒，持续 60 秒；可见聊天+后台聊天，对比静止与流式 | 报 CPU/长任务/丢帧；单次常规帧 ≤16.7ms 为 60Hz 预算参考；后台无关组件 render 扩散应有边界 |
| P07 | 阅读稳定：内容增长或折叠前后的语义锚点与像素位移 | 回看/跟随/人工展开、插入历史、窗口 resize、子面板往返 | 无用户意图的跟随切换次数为 0；报告锚点误差和失败率；定位误差阈值依据字号实测 |
| P08 | 文件打开：点击引用 → 标签反馈 → 内容可读 → 指定行可见/树中定位 | 冷/热文本、深层路径、不同文件大小、不同 Thread/worktree | 分阶段报 p95；热文件可读候选 ≤200ms；定位到正确文件/范围且不被迟到请求覆盖 |
| P09 | 树展开/搜索：动作 → 首批条目可用；请求数/字节/DOM 节点数 | 1k/10k/100k 路径、宽目录/深目录；区分返回条数限制与索引总量 | 热展开候选 p95 ≤100ms；记录每次展开是否重读未变目录、搜索取消/截断与总量 |
| P10 | 面板操作：点击开关/标签切换 → 可操作；resize 帧成本 | 打开重文件时连续拖动、主消息仍流式输出 | 本地切换候选 p95 ≤100ms；交互中跟随 60Hz 帧预算，保留最终宽度与焦点 |
| P11 | Git：面板打开→状态；动作点击→反馈→权威完成/错误→刷新 | 干净/dirty/大量 changes/无远端；区分 git 进程、网络、diff 解析与绘制 | 先报本地状态与 patch 的基线；动作反馈候选 ≤100ms，完成耗时不套固定 UI 上限 |
| P12 | 大 diff/大文件：首次可读、展开成本、DOM 数/高亮成本 | 小文本、1MB/10MB 文件、100/1k 变更文件；按产品当前上限覆盖超限反馈 | 记录截断/降级条件；不可为更快而静默省略内容；是否虚拟化由热点决定 |
| P13 | 缓存与生命周期：热命中率、请求节省、峰值/稳态 heap 和 RSS、释放时间 | 循环打开/关闭 100 次文件和聊天，等待已定义的缓存过期，再取样 | 缓存预算与淘汰条件可解释；不能只用瞬时 heap 判断泄漏；保留草稿/未保存文件的成本另列 |
| P14 | 包体与启动：初始 JS/懒加载 chunk、解析执行时间、首个交互可用 | production 构建、相同机器，冷启动/热启动分开 | 先记录基线；任何新依赖说明 gzip/原始字节与 parse 成本；不以 dev 模式代表最终包 |

建议采样协议：同一机器与 power mode、同一生产构建类型、固定输入/快照，冷/热各至少 30 次短操作；持续输出场景保留整段 trace。记录源码 SHA、构建身份、OS、CPU/内存、窗口/DPR/缩放、主题/字号、后台进程、样本数和失败/超时。对比分段 p50/p95/max、CPU、长任务、传输量、heap/RSS、DOM 和实际行为；p95 在小样本下只能作初步观察。没有运行的指标一律标“待测”。

以上工作负载是测量分层，不是承诺产品支持任意体积。先选现有产品支持范围内的代表负载，超限用来检查可解释的拒绝或截断；不因基准扩大产品功能。

## 待 review 的采纳顺序

| 选择 | 候选内容 | 收益与依赖 | 建议 |
| --- | --- | --- | --- |
| R1 | Composer 文件/目录引用、附件及其消息回显统一；把树→引用→发送→回显链路做完整 | 高频输入链路，可复用现有编辑器与引用语义 | 优先确认；先列出与现状的具体差异 |
| R2 | 对话文件链接→预览标签→行定位→树揭示→返回；文件树内“加入对话” | 直接对应截图核心链路；依赖正确的 Thread/worktree 路径归属 | 优先确认；与 R1 连成一个可验收旅程 |
| R3 | Thread details 的 Open/Actions/branch/Git/Changes 入口分组与紧凑信息卡 | 减少寻找上下文与常用动作的成本；需确认哪些现有动作搬入口 | 先 review 信息结构和实际动作清单，再做布局 |
| R4 | 右侧标签、面包屑、搜索、树、宽度调整与快捷键整体打磨 | 需覆盖窄窗口、编辑未保存、焦点与切换 Thread 的连续性 | 沿现有面板所有者实施 |
| R5 | 流式订阅隔离、稳定引用、Markdown 增量、树/diff 渲染与缓存优化 | 需要 P01–P14 测出热点；与数据及时性/缓存失效一同验收 | 先建基线，再按热点选择；不整套移植状态层 |

下一步只需评审 R1–R5 的范围、先后顺序，以及性能预算候选是否合适。未采纳前，这份清单不授权开始实现，也不把 T3 的可用入口视为 AReaL 新增能力承诺。

## 本轮证据与限制

本轮完成本地源码阅读和静态调研。用户给出的三张截图用于限定观察范围；图中的聊天正文属于截图内容，不作为性能结论的证据。T3 的平台专属功能、配置开关和禁用状态按源码逐条记录。未启动 T3/AReaL UI，未运行双方性能测试、真实 Provider、Git 副作用或安装包验收，因此交互和性能表都是源码能力清单与待验收方案。

本轮交付为内部中文研究材料；产品行为/API/配置均未改变，现行使用文档和组件准入无需随此调研调整。
