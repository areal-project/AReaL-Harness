# GUI 组件与实现指南

新增或修改页面、组件、布局、样式、动效或 UI 文案前，先读[设计规则 v1 的开工顺序](design-system/README.md)。默认按[证据驱动设计流程（B路线）](design-system/structured-flow.md#执行顺序与每步完成条件)先核查差异，再沿现有所有者实现与重放验收。规则目录负责页面模式、基础约束、覆盖和证据；本指南继续维护 Token 角色、控件合同与生产预览入口。

共享设计含义从[设计地图](../../design/README.md)进入；本指南维护 GUI 的具体组件与接线，默认中文。设计数值归生产 CSS，组件变体归现有公共组件；新增功能按角色组合，不复制另一套样式。执行、权限、历史和草稿继续由原业务所有者管理。

## 设置与管理界面的交互规范

本节是新增、修改和评审客户端 UI 必须遵循的约束。设置页通过外框表达功能分组，行内展示简短名称和当前状态，控件按交互语义选择；不能只统一圆角而保留错误的交互。

### 按功能分组并保持对齐

- 使用 `SettingsSection` 标记功能组、`SettingsGroupCard` 的外框包住相关设置；同组行以细分隔线连接。一个卡片只表达一个功能关系，不按实现模块机械堆叠信息。
- 使用 `SettingsRow`：名称和必要的一行说明在左，当前值与控件在右；同组的内容边缘、控件右边缘保持一致。窄窗口空间不足时，控件移到说明下方，不截断或挤出边界。
- 对普通用户无帮助的完整目录、实例编号与实现说明移入明确的详情入口。主页面保留完成当前操作所需的信息。

### 按交互类型选择控件

| 用户意图 | 控件 | 规则与现有所有者 |
|---|---|---|
| 点击执行一次操作、打开管理界面 | 文字按钮 | 复用 `Button` / `ActionButton`，如“导入”“更改”“查看”“管理空间”；默认不加装饰图标，不做成开关 |
| 开启 / 关闭一个状态 | 左右滑动开关 | 复用 `Switch` / `SettingsSwitch`；以真实状态驱动，操作中禁用并显示简短反馈，失败后保留或恢复已确认状态 |
| 三个及以上候选值中选择一个 | 下拉按钮与菜单 | 复用 `Select`；收起时显示当前值和右侧小箭头，展开后显示候选项与选中标记；不把选项摊成一排按钮 |
| 两个互斥值中选择一个 | 并排的两个选项 | 复用 `SettingsSegmentedTabs`，如“底部 / 右侧”；全部可见，选中项高亮，不再套下拉菜单 |

设置行默认使用 `Switch` 的 default 尺寸（`SettingsSwitch` 同样默认）；三项及以上沿用 `SettingsSelect` 当前公共 sm 变体；具体尺寸、形状由组件决定，页面不得自行改档。尺寸与水平留白归公共实现，不在页面覆盖。

此处“多项选择”指多个候选值的单选，不等于一次选择多个值。真正允许多值选择时沿用支持复选语义的现有控件，不能假装成单选菜单。导航 Tab 与设置值选择也不能混为一谈。

值、动作、导航与步骤的区分统一见[控件选择](../../design/components/controls.md)。本表维护 GUI 的具体映射；关闭服务、清理资源等操作继续绑定已有确认与拒绝入口。

### 用状态反馈代替大段操作说明

- 常驻信息按[设置与管理](../../design/patterns/settings.md)组织。普通开关不配“开启 / 关闭”文字按钮，不在控件下堆叠连接、恢复和实现流程说明。
- 共享状态与动作见[反馈与恢复](../../design/patterns/feedback-and-recovery.md)。GUI 沿用“已开启”“已关闭”“处理中”“待确认”等本端文案，绑定所属业务状态。
- 按[设置与管理](../../design/patterns/settings.md#值动作与生效范围)说明实际影响；GUI 使用所属确认或管理面板呈现。
- 普通操作按钮采用紧凑圆角矩形、轻填充和克制的边框；危险操作通过文字及语义色区别。尺寸、圆角和明暗填充由公共 Token 及组件变体统一管理。图标仅用于有明确识别价值的独立图标操作，不给每个文字按钮机械配图标。

### 不使用左侧三角展开符号

客户端界面禁止使用左侧三角作为展开 / 折叠入口，包括原生 `details/summary` 的默认三角标记和手写的同类符号。优先使用“查看详情”按钮打开已有详情面板或对话框；确需原地展开时使用明确的“展开 / 收起”文字按钮并保留键盘与 `aria-expanded` / `aria-controls` 语义。不能只隐藏标记而留下无提示、不可访问的交互。下拉选择控件右侧的小箭头不属于此禁用项。

评审时必须确认：功能分组合理、控件语义正确、反馈来自真实结果、没有冗长常驻说明或左侧三角、明暗与窄窗口均可用。新公共状态必须进入现有组件预览，不另外建立平行规范。

## Token 选择

首批基础值与纯调色板已移入私有 [@areal/ui](packages/ui/README.md)。修改包内 Token/控件前读 [Agent 指南](packages/ui/agent-guide.md)；实际成员、生成 API 与独立示例见 [UI 包与架构](renderer/design-system.html?ui-library)。以下角色表继续描述用途，已迁入值以包内源为准，旧路径仅转接同一实现。

基础值与默认调色板的唯一来源是 [tokens.json](packages/ui/tokens.json) 与 [theme.ts](packages/ui/src/theme.ts)，完整清单见生成的 [Token 速查](packages/ui/src/generated/tokens.md)；[styles.css](renderer/src/styles.css) 只放产品专用主题别名。用户外观覆盖由 [applicationSettings.ts](renderer/src/settings/applicationSettings.ts) 和 [applicationPreferences.ts](renderer/src/settings/applicationPreferences.ts) 提供。以下表格说明用途，不复制数值。

| 角色 | Token | 使用约定 |
|---|---|---|
| 输入与强调文字 | `--text-ui-lg` | 编辑器、较突出标题 |
| 正文 | `--text-ui-base` | 卡片内容、普通反馈 |
| 控件标签 | `--text-ui-caption` | 按钮、菜单及紧凑标签 |
| 过程与结果附注 | `--text-content-caption` | 执行摘要、状态和失败次数，跟随内容字号；不替代按钮的 UI 字号 |
| 说明 | `--text-ui-sm` | Side 标题、上下文说明、次要反馈 |
| 辅助信息 | `--text-ui-xs` | 来源细节；不用于主要正文 |
| 公共行高 | `--line-height-ui`、`--line-height-ui-sm` | 决策正文与紧凑说明，随 UI 字号增长 |
| 设置说明 | `--color-settings-secondary` | 活跃设置标签的说明；独立于禁用透明度及已完成过程信息，偏好派生归 applicationSettings.ts |
| 文字层级 | `--color-foreground`、`--color-foreground-subtle/subtlest` | 主内容、说明、低强调信息；不能只用颜色表达状态 |
| 表面 | `--color-background`、`--color-composer`、`--color-composer-catalog` | 页面、输入区、相关浮层；明暗由主题提供 |
| 主要动作 | `--color-primary`、`--color-primary-foreground` | 审批主动作与发送动作共用配对；`--color-composer-action` 及其前景是同一配对的别名，强调色继续用于链接与焦点 |
| 按钮填充 | `--color-button-surface`、`--color-button-hover` | 普通操作与下拉按钮的默认 / 悬停表面 |
| 边框与错误 | `--color-border`、`--color-destructive` | 边界与错误反馈 |
| 控件尺寸 | `--spacing-control` 及 `--spacing-control-xs/sm/lg/form`，对应 Tailwind 的 `h-control-*` | 根据控件用途选尺寸，跟随用户字号 |
| 间距 | `--spacing-inline/field/section/panel` | 相邻内容、内容块、分区与面板；具体组合可以使用这些角色的倍数 |
| 对话阅读列 | `--reading-width` | 消息列与输入停靠区使用同一宽度上限，内侧留白采用 `--spacing-field`；嵌入式对话保留宿主宽度 |
| 圆角 | `--radius-button/control/overlay/composer/panel/dialog` | 按表面角色选择，不能为“看起来差不多”任意互换 |
| 内嵌与动作形状 | `--radius-inset`、`--radius-pill` | 表面内的预览内容、胶囊或圆形动作 |
| 焦点与动效 | `--focus-width/offset`、`--motion-fast/normal/slow` | 复用 focus-visible、ui-control/ui-popup；遵守 reduced motion |

Tailwind 的 `text-ui-sm`、`rounded-overlay` 等直接消费同一套 Token。独有宽度、滚动上限或定位属于具体组件，可以保留局部数值；共同角色才进入公共 Token。不得把字号与不相关布局尺寸绑定。

## 公共组件与试点组合

| 所有者 | 使用方式 | 业务边界 |
|---|---|---|
| [Button](renderer/src/components/ui/button.tsx) | 复用 default/outline/secondary/ghost/destructive/destructive-subtle/warning/link；选择既有 size | 是否可操作由调用方决定 |
| [ActionButton](renderer/src/components/ui/action-button.tsx) | 紧凑文字操作；图标可选，pending 保留标签并禁止重复点击 | 只表达状态，不拥有业务请求或结果 |
| [Switch](renderer/src/components/ui/switch.tsx)、[Select](renderer/src/components/ui/select.tsx)、[SettingsSegmentedTabs](renderer/src/settings/SettingsSegmentedTabs.tsx) | 按上述交互规则选择，不互相替代 | 实际值与提交结果归调用方 |
| [SettingsSection / SettingsGroupCard / SettingsRow](renderer/src/settings/SettingsPageParts.tsx) | 组合设置组、分组卡片及默认 / wide 行；compact 由卡片声明，共同展示归相邻 [SettingsPageParts.css](renderer/src/settings/SettingsPageParts.css)，独立、页面、弹窗使用同一规则 | props 与实际控件保持原有组合，值、请求和权限归调用方；Mobile 保留直接 card-content 插槽与专用 padding |
| [SettingsSelect](renderer/src/settings/SettingsPageParts.tsx)、[SettingsDisclosure](renderer/src/settings/SettingsDisclosure.tsx) | 设置值自动按两个候选 / 多个候选选择公共控件；详情使用“展开 / 收起”，不显示三角 | 值、请求、权限和草稿归调用方；详情保留原生展开语义 |
| Button `variant="composer"` | 主和 Side 发送外观，共用禁用及文本角色；一般配合 `size="icon-md"` | 不决定 send、enqueue、steer 或清理草稿 |
| [ConversationComposer](renderer/src/ConversationComposer.tsx) | 主与 Side 的编辑器、工具栏及模型目录入口 | 调用方拥有输入、提交、配置和能力 |
| [ComposerSurface](renderer/src/prompt-editor/ComposerSurface.tsx) | editor/toolbar/context/overlay 插槽；样式在组件旁 [ComposerSurface.css](renderer/src/prompt-editor/ComposerSurface.css) | 只拥有布局；紧凑状态保持编辑器挂载 |
| [DecisionCard](renderer/src/DecisionCard.tsx) | label/icon/正文/反馈/footer 插槽，复用 [DecisionCard.css](renderer/src/DecisionCard.css) | 审批/提问拥有提交、核对与请求身份 |
| [Feedback](renderer/src/components/ui/feedback.tsx) | error 或 message；保留 alert/status 语义 | 文案和恢复动作归调用方 |
| 菜单、Popover、Tooltip、Input/Textarea | 从 [components/ui](renderer/src/components/ui) 选择既有组件 | 不在功能文件复制公共控件样式 |
| [CollapsibleText](renderer/src/CollapsibleText.tsx) | 渲染高度检测、有界预览与展开/收起，样式在 [CollapsibleText.css](renderer/src/CollapsibleText.css) | 只拥有展示状态；原文与复制/发送仍由调用方管理 |
| [SideChatPane](renderer/src/SideChatPane.tsx) | 组合共享 Composer 与 Side 上下文，样式在 [SideChat.css](renderer/src/SideChat.css) | 保留服务/来源/Side 草稿隔离与独立执行 |

审批按钮的 split 几何、Side 面板比例、Composer 紧凑布局是当前组合规则，不作为全局控件的新默认值。

主 Composer 的模型配置保存与消息发送反馈分开：保存期间仍可编辑草稿，不播放发送中的 Spinner，也不通过禁用滑块打断焦点。`ConversationComposer.modelPending` 只锁定模型配置动作，发送入口仍由宿主阻止；滑块保留待保存位置，完成或失败后回到 Core 确认值。未知结果继续沿原恢复路径处理，不自动重试。

## 长文本统一采用渐进展示

共享阅读方式、全文与原文关系由[深入查看与返回](../../design/patterns/inspect-and-return.md)维护。本节定义 GUI 的组件、测量、焦点与例外接线。

- **按实际布局折叠**：根据渲染高度判断，覆盖 Markdown、多行与自动换行；宽度、字号或字体变化后重新测量，不只按字符数判断。短文本完整展示，不出现无效展开入口。
- **预览与全文可逆切换**：默认保留开头预览，提供始终可见的“展开全文 / 收起”按钮；按钮位于裁剪区域之外，不能只在 hover 时出现。聊天默认预览约 8 行，数值归 [CollapsibleText.css](renderer/src/CollapsibleText.css)。新消费者优先复用 [CollapsibleText](renderer/src/CollapsibleText.tsx)，不要另写字符截断或折叠状态机。
- **全文完整可达**：按[共享阅读规则](../../design/patterns/inspect-and-return.md#长内容与全文)处理原文；GUI 将附件和独立操作放在正文预览之外。展开后使用所属页面滚动，不再嵌套纵向滚动；收起时保持阅读位置与按钮焦点可达。
- **可访问且稳定**：原生按钮支持键盘、可见焦点、`aria-expanded` 与 `aria-controls`；聚焦裁剪正文内的操作时先展开。每条消息独立保存当前挂载期间的展开状态，流式刷新或尺寸变化不覆盖人工选择，换到其他消息不继承旧状态。不依赖动画表达状态，遵守 reduced motion。
- **按任务设定例外**：正在编辑的输入、流式主要回复、需要完整核对的审批关键信息以及专用文件/日志阅读器，保留其现有阅读机制；不能为了统一外观隐藏完成当前任务必需的信息。未来长文本设计评审必须说明所选机制与可达全文的路径。

已发送消息在共享 `Messages` 中应用此规则，主聊天、Side 与 Remote 复用同一展示路径。验收至少覆盖长/短文本、连续长段落、Markdown、明暗、窄宽面板、字号变化、展开再收起，以及原文复制。生产组件预览与脚本见下文；它们不代替真实服务或安装包验收。

对话时间线以 Core 的 `commentary` / `final_answer` 为边界，不按文字内容猜测思考或工具事件。耗时位于过程顶部并控制整段过程的展开与折叠；已完成过程默认折叠，最终回答及交付内容不在折叠范围。工具分组独立默认折叠，展开后列表限高 224px 并支持上下滚动。长过程仍在六行高度内滚动，当前流式正文完整展示。过程和活动区域支持键盘聚焦与滚动；打开单条命令或文件比较时，列表取消限高，避免与具体输出同时形成双层滚动。这是过程阅读的专用机制，不改变已发送用户长消息的展开行为。执行中活动文字复用左向右亮色扫光，终态及 reduced motion 下不播放。成功图片结果、可打开的子对话保留轻量入口，原始记录按需查看；文件变更默认显示前五条，多余部分可展开或收起，行数继续取自 Core 本轮比较。Markdown 图片仅通过现有会话授权的 Core blob 读取直接显示；不自动读取任意本机路径或远端图片。普通链接直接打开，独立本地网页链接显示预览卡片，点击仍经过现有 Main 导航策略，不探测服务状态。`design-system.html?conversation` 提供同一生产组件的隔离预览，不连接用户 Core。

对话时间线的分组、完成收敛、工具层级与阅读状态统一遵循[信息流合同](design-system/patterns.md#对话信息流)。共享Messages已统一带phase与旧快照的过程总组；实现及未覆盖项见该合同，不由业务页面重新设计。`design-system.html?conversation`仍是静态状态fixture；`?conversation-exercise`串接命令分批输出、并行子代理、真实图片预览组件、独立子对话和最终收敛，可自动播放或暂停逐事件检查。该复合题保留生产回复占位及阅读逻辑，逐状态对照方法见[场景说明](design-system/exercises/conversation-flow.md)。二者均不连接用户Core，不能代替真实执行或桌面发送验收。文件变更摘要与行数继续取自Core本轮比较。

## 新增或修改页面

按[设计系统开工顺序](design-system/README.md#开工顺序)执行；步骤与完成条件只在[结构化流程](design-system/structured-flow.md#执行顺序与每步完成条件)维护。调用方用内容、动作和有限变体表达业务差异；公共控件、数值与状态归原所有者。常规修改复用适用证据和既有验收，不要求新建设计提案或全量E2E。CSS使用组件语义与真实状态，不根据翻译文案猜测操作含义。

界面文案变更同时完成简体中文和英文词条、无障碍名称及受影响路径的双语检查。调用与校验合同见[界面语言与文案开发](README.md#界面语言与文案开发)。

## 开发预览

从仓库根运行：

```sh
pnpm --dir clients/gui design:dev
```

打开 Vite 地址的 `/design-system.html`。这是独立开发入口，挂载生产 ConversationComposer、ApprovalRequest 与 SideChatPane，可切换明暗、UI 字号、宽窄面板，查看提交中、失败和未知结果。审批状态通过选择状态后点击审批动作呈现；Side 保留实际入口并明确拒绝真实操作。设置组合额外挂载真实 `SettingsPage`、portal `SettingsDialog` 和 `GeneralSettings`。`/design-system.html?settings` 聚焦此组合。常规设置使用实际浏览器偏好路径；服务操作不可用。紧凑、宽控件、长中英文及外部禁用、处理中、明确失败、结果待确认属于独立展示 fixture，不表示 `GeneralSettings` 支持未知提交。

预览不读取桌面 bridge，不连接 Core/供应商。业务动作使用本地 fixture；常规设置会读写当前 origin 的 localStorage，验收使用隔离浏览器上下文。状态预览不证明业务恢复或权限执行通过。

`design:build` 输出到 `clients/gui/dist/design-system/`；普通 renderer 构建不包含预览 HTML 或预览模块，安装包继续使用 `renderer/dist/`。

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
# 开发期间仅检查设置组合
pnpm --dir clients/gui test:design --settings-only
```

`test:design` 使用隔离 Chrome，保存截图、计算样式与 manifest；可用 `AREAL_GUI_TEST_BROWSER` 指定已有浏览器。检查编辑器草稿保留、模型菜单、实际审批状态、明暗、字号及宽窄布局。设置检查比较独立部件、真实页面与弹窗的计算样式，并验证紧凑密度、分隔线、容器窄宽、键盘控件值、常规偏好重挂载与重载保留、Mobile 插槽几何及实际 CSSOM 规则重排。字体、平台、缩放不同的截图分别评估，不要求跨平台像素一致。

## 增量检查与验证边界

普通 `verify` 执行目录、完整迁移清单和[增量设计检查](design-system/automation.md#增量设计检查)；`verify:design` 另运行目录与增量审计回归。`verify:design` 的单一清单覆盖已迁移的 DecisionCard、ComposerSurface、SideChat、Feedback、SettingsPageParts 完整 CSS，以及 `SettingsPageParts.tsx`。CSS 检查阻止局部硬编码字号和颜色，并检查 Token 存在。TSX 使用现有 TypeScript AST 检查 JSX `className` 的直接字符串、`cn`、条件与模板中的字符串，以及直接对象 `style` 的字面量；拒绝 Tailwind 固定字号和标准色板，允许布局数字。检查器内的正反例验证目标写法。动态间接值和变量传递的 style 不在静态覆盖范围内；其他生产 UI 文件按 Git 基线检查新增问题，具体范围见增量设计检查。

目录与页面合同另外由[单源目录](design-system/automation.md)校验；目录变化后运行 `design:sync` 同步派生物。

生产样式改变需查看相关组件和原消费者；变体变化看默认、焦点、禁用和提交状态。Composer、审批、Side 的业务兼容继续使用已有 `test:composer`、`test:interactions`、`test:conversation-derivation`，它们与组件预览各自提供不同证据。物理 IME、真实供应商及安装包需单独验收。

新增或重构页面先读[用户交互模式](design-system/interactions.md)，按 must/default/explore 约束选已有组合。设置首阶段的设计输入与实际Electron验证合同见[迁移题](design-system/exercises/settings-stage1.md)。

## 共享输入与面板组合

`ChatPromptEditor.surfaceLayout` 透传 `ComposerSurface.layout`，仅有 default / compact。App 为满屏资源下的主 Composer / DraftComposer 选择 compact；Side 不继承工作区祖先的输入布局。变体、容器重排和模型入口基础样式归 ComposerSurface.css，不能在页面复制全屏选择器。ConversationComposer 仍理解模型目录和继承；主/Side 的草稿、来源、配置、提交及未知受理归原业务所有者。Side 的错误与带回反馈复用 Feedback。

`design-system.html?shared-workspace` 组合真实主输入、SideChatPane、SidePane 与 portal 设置；本地动作不执行任务。运行 `node clients/gui/scripts/design-system-smoke.mjs --shared-workspace` 验证代表条件；真实发送和模型隔离使用 `conversation-derivation-smoke.mjs --shared-workspace` 与已核对的 AREAL_CORE_BIN。设计裁决、规则强度与范围归[共享工作区合同](design-system/exercises/shared-workspace.md)。
