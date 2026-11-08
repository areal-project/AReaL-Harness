<!-- Generated from tokens.json and src/theme.ts. Run pnpm --dir clients/gui --filter @areal/ui generate. -->
# @areal/ui Token 速查

写样式时按用途选这里的变量，不写字面量。数值与派生公式只在 [tokens.json](../../tokens.json) 修改；[theme.ts](../theme.ts) 保留公开调用与 WCAG 算法，[palette.ts](palette.ts) 是构建时生成的普通 TypeScript。

## 字号

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--ui-font-size` | `14px` | 界面默认字号；用户偏好可覆盖 |
| `--ui-font-weight` | `400` | 界面常规字重 |
| `--text-conversation` | `var(--content-font-size, 14px)` | 对话时间线字号：正文、活动行、子代理行与过程状态共用，跟随内容字号偏好 |
| `--text-ui-xl` | `calc(var(--ui-font-size) + 4px)` | 区块标题 |
| `--text-page-title` | `calc(var(--ui-font-size) + 8px)` | 页面标题、空态大标题 |
| `--text-ui-lg` | `calc(var(--ui-font-size) + 2px)` | 输入框文字、卡片标题等较突出内容 |
| `--text-ui-base` | `var(--ui-font-size)` | 界面正文、卡片内容、普通反馈；在消息正文内被重映射为内容字号 |
| `--text-ui-caption` | `max(12px, calc(var(--ui-font-size) - 1px))` | 按钮、菜单与紧凑标签 |
| `--text-content-caption` | `max(12px, calc(var(--content-font-size, 14px) - 1px))` | 执行摘要、状态等过程附注，跟随内容字号而非界面字号 |
| `--text-content-h1` | `calc(var(--content-font-size, 14px) + 10px)` | 阅读内容一级标题（文件阅读器、长文档），跟随内容字号；14px 时 24px |
| `--text-content-h2` | `calc(var(--content-font-size, 14px) + 6px)` | 阅读内容二级标题，跟随内容字号；14px 时 20px |
| `--text-content-h3` | `calc(var(--content-font-size, 14px) + 4px)` | 阅读内容三级标题，跟随内容字号；14px 时 18px |
| `--text-content-h4` | `calc(var(--content-font-size, 14px) + 2px)` | 阅读内容四级标题，跟随内容字号；14px 时 16px |
| `--text-ui-sm` | `max(12px, calc(var(--ui-font-size) - 2px))` | 说明文字、次要反馈、表格辅助列 |
| `--text-ui-xs` | `max(11px, calc(var(--ui-font-size) - 3px))` | 来源细节、元信息；最小 11px，不用于正文 |
| `--text-ui-2xs` | `calc(var(--ui-font-size) - 5px)` | 仅限工作流图轴面的例外刻度 |
| `--text-mobile-input-safe` | `16px` | 移动端聚焦输入的安全字号下限 |
| `--text-fixed-metadata` | `10px` | 标注编号、图表刻度与固定几何元信息。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-caption` | `12px` | 固定几何的紧凑说明与代码预览字号。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-label` | `13px` | 固定尺寸控件标签、附件文字和远程连接说明。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-body` | `14px` | 现有固定布局的正文与默认字号回退。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-control` | `15px` | 固定高度队列和远程设置控件文字。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-emphasis` | `16px` | 固定布局的强调文字。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-section-title` | `20px` | 固定布局的任务、远程和用量分区标题。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-dialog-title` | `22px` | 远程配对和连接卡片标题。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-fixed-page-title` | `28px` | 现有页面标题和新建任务提示。该角色固定像素，保持原行为；支持随用户字号变化的正文继续使用 text-ui/content 系列。 |
| `--text-ui-fine` | `calc(var(--ui-font-size) - 3px)` | 插件次要标记，保留原 ui-font-size 减 3px，不额外加最小字号。 |
| `--text-ui-section` | `calc(var(--ui-font-size) + 6px)` | 界面分区标题，跟随界面字号增加 6px。 |
| `--text-ui-hero` | `calc(var(--ui-font-size) + 10px)` | 界面大标题，跟随界面字号增加 10px。 |
| `--text-ui-display` | `calc(var(--ui-font-size) + 12px)` | 插件详情展示标题，跟随界面字号增加 12px。 |
| `--text-compact-caption` | `0.75rem` | 紧凑说明与元信息，保持既有 text-xs 的 rem 缩放。 |
| `--text-compact-caption--line-height` | `1rem` | 紧凑说明行高，保持既有 text-xs 的 1rem。 |
| `--text-compact-body` | `0.875rem` | 紧凑正文，保持既有 text-sm 的 rem 缩放。 |
| `--text-compact-body--line-height` | `1.25rem` | 紧凑正文行高，保持既有 text-sm 的 1.25rem。 |
| `--text-user-message-heading` | `1.5em` | 用户消息 Markdown 一级标题相对于该消息正文的字号关系。 D2 保留 renderer/src/workbench.css 原几何。 |

## 行高与字重

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--line-height-ui` | `max(20px, calc(var(--ui-font-size) + 6px))` | 界面正文行高，随界面字号增长 |
| `--line-height-ui-sm` | `max(18px, calc(var(--ui-font-size) + 4px))` | 紧凑说明行高 |
| `--tracking-wf-label` | `0.09em` | 工作流图大写等宽微标签字距 |
| `--line-height-code-example` | `22px` | 主题 Diff 缩略图代码行高，保留原固定 22px。 |
| `--tracking-conversation` | `0.025em` | Agent 正文与过程文字的字距；用户气泡、状态行、过程标题与输入框不用 |
| `--line-height-relaxed` | `1.625` | 按钮与工具栏入口文字的宽松行高倍数 |
| `--line-height-toolbar` | `1.5` | 输入框工具栏里模型与强度入口的行高倍数 |
| `--line-height-title` | `1.2` | 首页迎宾标题等大标题的行高倍数 |
| `--tracking-heading-tight` | `-0.02em` | 首页迎宾大标题与页面主标题的紧凑负字距 |

## 间距与尺寸

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--reading-width` | `768px` | 消息与Composer共用的阅读宽度上限 |
| `--spacing-control-xs` | `max(20px, calc(var(--ui-font-size) + 6px))` | 超紧凑控件高度（h-control-xs），随界面字号增长 |
| `--spacing-control-sm` | `max(24px, calc(var(--ui-font-size) + 10px))` | 紧凑控件高度（h-control-sm），设置行内按钮与选择器 |
| `--spacing-control` | `max(28px, calc(var(--ui-font-size) + 14px))` | 默认控件高度（h-control / size-control），按钮、图标按钮 |
| `--spacing-control-lg` | `max(32px, calc(var(--ui-font-size) + 18px))` | 较大控件高度（h-control-lg） |
| `--spacing-control-form` | `max(38px, calc(var(--ui-font-size) + 24px))` | 表单输入框高度 |
| `--spacing-inline` | `8px` | 同行相邻内容的间距 |
| `--spacing-field` | `16px` | 内容块与内侧留白 |
| `--spacing-section` | `24px` | 分区间距 |
| `--spacing-panel` | `16px` | 面板内留白 |

## 圆角

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--radius-control` | `var(--radius-lg)` | 输入框、选择器、设置卡片等控件外框 |
| `--radius-button` | `var(--radius-md)` | 文字按钮与按钮式入口 |
| `--radius-inset` | `var(--radius-md)` | 容器内部的内嵌块：列表项、引用、图片视口 |
| `--radius-pill` | `999px` | 胶囊形：发送等主动作、标签、计数徽标 |
| `--radius-overlay` | `var(--radius-3xl)` | 大浮层与独立工作区：Worktree 设置、目录列表、定时任务 |
| `--radius-navigation` | `var(--radius-md)` | 导航项、侧栏行与拖拽预览 |
| `--radius-composer` | `var(--radius-2xl)` | 输入区外框 |
| `--radius-panel` | `var(--radius-xl)` | 面板与分组卡片 |
| `--radius-dialog` | `var(--radius-2xl)` | 对话框 |
| `--radius-message` | `var(--radius-2xl)` | 用户消息气泡圆角 |
| `--radius-compact` | `var(--radius-sm)` | 紧凑工具按钮与小型输入的既有圆角。 D3 保留原几何，不改变数值。 |
| `--radius-micro` | `var(--radius-xs)` | 微型工具、缩略图内部和细粒度选择区圆角。 D3 保留原几何，不改变数值。 |
| `--radius-compact-row` | `var(--radius-sm)` | 紧凑队列和菜单行圆角。 D3 保留原几何，不改变数值。 |
| `--radius-inline` | `var(--radius-sm)` | 嵌入式输入和紧凑标注工具圆角。 D3 保留原几何，不改变数值。 |
| `--radius-card` | `var(--radius-2xl)` | 中型资源列表与提示卡片圆角。 D3 保留原几何，不改变数值。 |
| `--radius-choice` | `var(--radius-2xl)` | 选择菜单和主题预览卡片圆角。 D3 保留原几何，不改变数值。 |
| `--radius-attachment` | `var(--radius-lg)` | 图片附件与紧凑批注圆角。D3 保留原几何。 |
| `--radius-feedback` | `var(--radius-xl)` | 输入反馈与提示卡片圆角。D3 保留原几何。 |
| `--radius-full` | `9999px` | 全圆角胶囊，保留原最大半径。D3 保留原几何。 |
| `--radius-composer-large` | `var(--radius-4xl)` | 大输入区外框圆角。D3 保留原几何。 |
| `--radius-status-dot` | `99px` | 供应商状态点的原固定圆角。 D2 保留 renderer/src/workbench.css 原几何。 |
| `--radius-composer-queue-menu` | `var(--radius-2xl)` | 输入器队列菜单的原圆角。 D2 保留 renderer/src/workbench.css 原几何。 |
| `--radius-turn-marker` | `var(--radius-2xs)` | 轮次导航细标记的原圆角。 D2 保留 renderer/src/workbench.css 原几何。 |
| `--radius-inspection-dialog` | `var(--radius-4xl)` | Hook 统计检查对话框的原圆角。 D2 保留 renderer/src/workbench.css 原几何。 |
| `--radius-context-category-dot` | `var(--radius-2xs)` | 上下文组成类别标记的原圆角。 D2 保留 renderer/src/workbench.css 原几何。 |
| `--radius-2xs` | `calc(2px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：微型指示器与进度条圆角 |
| `--radius-xs` | `calc(4px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：行内代码与微型徽章圆角 |
| `--radius-sm` | `calc(6px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：紧凑按钮与小型标签圆角 |
| `--radius-md` | `calc(8px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：侧栏导航行、常规按钮与菜单项圆角 |
| `--radius-lg` | `calc(10px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：内嵌容器、附件卡片与回合文件改动汇总卡圆角 |
| `--radius-xl` | `calc(12px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：设置分组卡片、Popover 浮层与面板圆角 |
| `--radius-2xl` | `calc(16px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：用户消息胶囊、紧凑态 Composer 与对话框圆角 |
| `--radius-3xl` | `calc(20px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：大浮层与复合输入容器圆角 |
| `--radius-4xl` | `calc(24px * var(--corner-radius-scale))` | Codex 9 档圆角阶梯：主输入台（Composer）外框与大型模态面板圆角 |

## 阴影

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--shadow-menu` | `0 0 0 0.5px var(--color-menu-border, var(--color-border)), 0 8px 16px -4px rgb(0 0 0 / 12%)` | 下拉菜单与右键菜单 |
| `--shadow-overlay` | `0 4px 12px rgb(0 0 0 / 10%), 0 14px 40px rgb(0 0 0 / 8%)` | Popover 与悬浮面板 |
| `--shadow-dialog` | `0 12px 32px rgb(0 0 0 / 20%)` | 对话框 |
| `--shadow-inset-control` | `0 1px 1px rgba(0, 0, 0, 0.04)` | 微型设置按钮的轻投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-raised-control` | `0 1px 2px rgba(0, 0, 0, 0.06)` | 设置控件的轻投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-tooltip` | `0 5px 18px #00000014` | 时间线与更新提示的浮层投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-large-overlay` | `0 16px 64px #0005` | 大预览浮层的投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-menu-wide` | `0 8px 28px #0003` | 宽目录菜单的投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-dark-control` | `0 8px 18px rgb(15 23 42 / 20%)` | 暗色快捷入口的投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-menu-double-stroke` | `0 0 0 .5px color-mix(in srgb, var(--color-foreground) 8.2%, transparent), 0 0 0 .5px color-mix(in srgb, var(--color-foreground) 8.2%, transparent), 0 8px 16px -4px #0000001f` | 双层细描边菜单投影，保留既有重复描边和前景比例。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-floating-toolbar` | `0 8px 24px #0002` | 浮动工具条投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-elevated-chip` | `0 1px 4px #0003, 0 0 0 1px #0000000d` | 悬浮小控件投影与外描边。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-leading-panel` | `-8px 0 16px -8px #0000002e` | 侧面板起始边投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |
| `--shadow-compact-overlay` | `0 3px 12px #0003` | 紧凑浮层投影。来源为迁移前对应 CSS 声明，保持原阴影几何与颜色。 |

## 状态色与语义色

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--color-button-surface` | `color-mix(in srgb, var(--color-foreground) 10%, var(--color-card))` | secondary 按钮的底色 |
| `--color-button-hover` | `color-mix(in srgb, var(--color-foreground) 14%, var(--color-card))` | secondary 按钮的悬停底色 |
| `--color-destructive` | `#e03131（暗色 #ff5c5c）` | 危险操作与错误；AReaL 明暗主题值 |
| `--color-destructive-foreground` | `var(--color-foreground-inverse)` | 危险底色上的文字 |
| `--color-warning` | `#e07b00（暗色 #ff8a30）` | 警告反馈；AReaL 明暗主题值 |
| `--color-warning-foreground` | `#000000` | 警告橙色底上的高对比文字；明暗底色均使用黑色，D4可读性修订。 |
| `--color-media-overlay` | `#000000` | 截图与图像内容上的固定深色遮罩；透明度由媒体组件拥有，不随应用明暗主题翻转。 |
| `--color-media-overlay-foreground` | `#ffffff` | 媒体深色遮罩上的固定浅色文字与图标，与 media-overlay 配对使用。 |
| `--color-foreground-inverse` | `#ffffff（暗色 #000000）` | 强调底色上的反色文字；明暗主题各自取值 |
| `--color-ring` | `var(--color-input-border-focused)` | 键盘焦点环颜色，跟随强调色 |
| `--color-muted` | `var(--color-surface)` | 弱化区域底色 |
| `--color-muted-foreground` | `var(--color-foreground-subtle)` | 弱化区域文字 |
| `--color-success` | `#1e8a3e（暗色 #46bf72）` | 成功反馈；AReaL 明暗主题值 |
| `--color-activity` | `#47a582` | 活动量强调色：本地记录标记点与排行条；明暗相同 |
| `--color-activity-1` | `#c8e5d6（暗色 #24483c）` | 活动热力图第一档（当天活跃不到三十分钟） |
| `--color-activity-2` | `#83c7a6（暗色 #306e54）` | 活动热力图第二档（三十分钟到一小时） |
| `--color-activity-3` | `#42a57c（暗色 #4a9d73）` | 活动热力图第三档（一到两小时） |
| `--color-activity-4` | `#227454（暗色 #8bcfa3）` | 活动热力图第四档（两小时以上） |
| `--color-change-renamed` | `#0b7fff（暗色 #4099ff）` | 文件改动标记：已重命名；与审查面板、文件树一致 |
| `--color-syntax-background` | `#ffffff（暗色 #111111）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：代码区底色：语法高亮主题的背景；审查差异的增删行在它上面混色 |
| `--color-syntax-foreground` | `#0d0d0d（暗色 #fcfcfc）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：代码正文与未归类的标识符 |
| `--color-syntax-muted` | `#666666（暗色 #999999）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：注释、标点、运算符与函数参数 |
| `--color-syntax-string` | `#008809（暗色 #85df7b）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：字符串与符号字面量 |
| `--color-syntax-literal` | `#0071ea（暗色 #6dcbf4）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：数字、布尔等语言常量、逻辑与算术运算符、属性名、转义字符 |
| `--color-syntax-variable` | `#bd5800（暗色 #fa994c）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：变量、常量与命名空间 |
| `--color-syntax-keyword` | `#d53538（暗色 #f67576）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：关键字、存储修饰与语言内置变量 |
| `--color-syntax-function` | `#751ed9（暗色 #b06dff）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：函数名、类型名与类名 |
| `--color-syntax-regexp` | `#001bcb（暗色 #3d8dff）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：正则表达式 |
| `--color-syntax-decorator` | `#1a85d4（暗色 #69b1ff）` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：装饰器 |
| `--color-syntax-error` | `#f44747` | 代码语法配色（AReaL Light / AReaL Dark 代码主题）：语法错误与非法记号；明暗相同 |

## 动效与层级

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--motion-fast` | `100ms` | 悬停、按下等即时反馈的过渡时长；减少动效时为 0 |
| `--motion-normal` | `160ms` | 展开、切换、浮层出现等常规过渡时长；减少动效时为 0 |
| `--motion-slow` | `240ms` | 面板、大区域位移等较长过渡时长；减少动效时为 0 |
| `--motion-emphasis` | `480ms` | 反应弹出、定位高亮等需要被注意到的一次性动效；减少动效时为 0 |
| `--motion-reveal` | `900ms` | 流式文字逐段显现的时长；减少动效时为 0 |
| `--motion-cycle` | `1200ms` | 旋转、充电等常驻循环转一周的时长；减少动效时为 0 |
| `--motion-cycle-slow` | `1600ms` | 扫光、进度呼吸等慢速循环一周的时长；减少动效时为 0 |
| `--motion-loop` | `infinite` | 常驻循环动画的次数；减少动效时为 0，动画不再播放 |
| `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | 所有过渡的默认缓动曲线 |
| `--layer-dialog` | `50` | 对话框层级 |
| `--layer-popover` | `60` | 菜单、Popover 层级，高于对话框 |
| `--layer-tooltip` | `70` | Tooltip 层级，最高 |
| `--ease-enter` | `cubic-bezier(0.19, 1, 0.22, 1)` | 浮层、面板与消息入场的高阻尼缓动曲线 |
| `--ease-spring` | `cubic-bezier(0.16, 1, 0.3, 1)` | 侧栏、折叠面板与胶囊控件的弹簧缓动曲线 |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | 来回循环与折叠收起的对称缓动曲线 |
| `--ease-overshoot` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 反应弹出等略微越过终点再回弹的缓动曲线 |

## 其他

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--border-width-default` | `1px` | 描边、分隔线的默认宽度 |
| `--font-sans` | `-apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif` | 基础界面字体及平台回退 |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace` | 代码字体及CJK无衬线回退 |
| `--conversation-line` | `1.43` | 对话时间线行高（无单位比例）：14px 时为 20px；标题与更大的内容字号按比例增长 |
| `--message-reading-inset` | `32px` | 对话信息流上下留白：首条消息与列顶部、末条内容与输入框之间 |
| `--message-bubble-max` | `70%` | 用户消息气泡相对阅读列的最大宽度 |
| `--composer-inset` | `12px` | 输入框内侧留白：编辑区左右与顶部、工具栏左右 |
| `--icon-size-control` | `16px` | 控件内图标尺寸：输入框工具栏、消息操作行与图标按钮 |
| `--opacity-disabled` | `0.45` | 不可用控件的整体不透明度 |
| `--opacity-resting` | `0.45` | 常驻的次要导航（如左缘回合导航）未被指向时的不透明度 |
| `--turn-marker-length` | `6px` | 左缘回合导航标记的长度 |
| `--turn-marker-thickness` | `2px` | 左缘回合导航标记的粗细 |
| `--conversation-gap` | `12px` | 对话时间线块间距：段落、活动行、子代理行、状态行之间的统一节奏 |
| `--activity-icon-size` | `16px` | 活动行与活动组摘要的行首图标尺寸；ActivityIcon 按 16 单位网格绘制 |
| `--activity-chevron-size` | `14px` | 活动行与活动组摘要的展开箭头尺寸 |
| `--activity-icon-gap` | `6px` | 活动行行首图标与文字、动作与对象之间的间距；展开后子项缩进 = 图标尺寸 + 本间距 |
| `--activity-list-max-height` | `240px` | 活动组展开后列表的最大高度，超过后在列表内纵向滚动 |
| `--activity-list-fade` | `24px` | 活动列表可继续向下滚动时底部渐隐的高度；滚到底后渐隐消失 |
| `--conversation-fade` | `24px` | 对话时间线在 Composer 上沿的渐隐高度，正文滚到 Composer 下方时逐渐淡出 |
| `--focus-width` | `2px` | 键盘焦点轮廓线宽 |
| `--focus-offset` | `2px` | 键盘焦点轮廓与元素边缘的距离 |
| `--browser-file-status-max-height` | `112px` | 浏览器文件交接状态列表的既有最大高度；来自renderer/src/BrowserFileHandoff.layout.css，D2保持原几何。 |
| `--browser-file-status-inline-gap` | `6px` | 浏览器文件交接状态项的既有内容间距；来自renderer/src/BrowserFileHandoff.layout.css，D2保持原几何。 |
| `--browser-file-status-block-padding` | `3px` | 浏览器文件交接状态项的既有纵向内边距；来自renderer/src/BrowserFileHandoff.layout.css，D2保持原几何。 |
| `--size-status-dot` | `7px` | 移动端会话状态圆点尺寸 |
| `--size-touch-target` | `44px` | 移动端按钮与输入框的最小触控目标 |
| `--blur-header` | `18px` | 工作台顶栏与吸顶摘要栏的毛玻璃模糊半径 |
| `--blur-popover` | `24px` | 任务上下文摘要（Pin Summary）与大浮层的液态玻璃模糊半径 |
| `--corner-radius-scale` | `1` | 内部圆角倍率：只乘原料刻度，用途圆角随之变化；不开放给用户（D-005） |
| `--height-toolbar` | `46px` | 工作台顶栏、侧栏头部与设置导航顶栏的统一高度契约 |
| `--home-composer-top` | `max(0px, calc(38svh - var(--height-toolbar, 46px)))` | 首页草稿视图（Draft View）迎宾区与 Composer 的黄金视觉重心顶部偏移 |
| `--thread-summary-max-height` | `calc(100svh - var(--height-toolbar, 46px) - 24px)` | 顶栏任务资源与上下文摘要弹窗（Pin Summary）的最大可用高度 |
| `--thread-sticky-header-top` | `0px` | 对话时间线内展开态回合过程摘要头（TurnProgress）的滚动吸顶偏移 |
| `--font-weight-toolbar` | `430` | 输入框工具栏入口文字（模型、强度）的字重 |
| `--rail-width` | `52px` | 应用导航栏宽度；侧栏标题区高度与之相同 |
| `--rail-button-size` | `36px` | 应用导航栏图标按钮边长 |
| `--icon-size-rail` | `20px` | 应用导航栏图标边长 |
| `--navigation-row-height` | `max(30px, calc(var(--ui-font-size) + 16px))` | 侧栏项目行、对话行与新聊天入口的最小高度 |
| `--sidebar-default-width` | `320px` | 侧栏默认宽度；用户可拖动调整 |
| `--font-weight-strong` | `600` | 侧栏工作区名称等强调标题的字重 |
| `--font-weight-medium` | `500` | 卡片标题与选项文字的中等字重 |

## 派生参数与来源

公式限定为已有混色、透明材料、默认覆盖和阴影操作。生成时校验引用方向与循环，运行时不解释数据。来源未记录的旧参数明确保留旧实现证据，不补造截图编号。`palette.source.preMigration` 指向迁移前的纯函数及其哈希。

{"owner":"src/theme.ts#paletteVariables","sha256":"fba6ef69d451085eb34854f4d06a891dfccea75bd23833221d4f9a15e790f83f","provenance":"原实现注释中的 Codex 参考未附截图编号，不补造截图来源。"}

| 参数 | 记录 |
| --- | --- |
| `file-link-dark` | {"value":80,"source":"palette.source.preMigration"} |
| `text-settled-dark` | {"contrast":{"base":55,"slope":0.15},"source":"D4可读性修订；design-system/accessibility.md#默认主题修订；保留contrast随偏好变化及各文字角色的强弱顺序。"} |
| `text-subtle` | {"contrast":{"base":{"light":75,"dark":69.5},"slope":0.15},"source":"D4可读性修订；design-system/accessibility.md#默认主题修订；保留contrast随偏好变化及各文字角色的强弱顺序。"} |
| `text-subtlest` | {"contrast":{"base":{"light":70,"dark":55},"slope":0.05},"source":"D4可读性修订；design-system/accessibility.md#默认主题修订；保留contrast随偏好变化及各文字角色的强弱顺序。"} |
| `text-settings-dark` | {"contrast":{"base":65,"slope":0.15},"source":"design-system/exercises/settings-contrast.md 已接受的暗色设置说明 65% 前景层，保持原斜率。"} |
| `raised` | {"ratio":[2100,231],"source":"旧 theme.ts 的历史过程、查看器和菜单抬升层。231 为默认 #181818 到 #ffffff 的通道范围，保留原除法精度。"} |
| `shell` | {"ratio":[1200,231],"source":"旧 theme.ts 已接受的暗色 #242424 外壳；231 是默认前背景通道范围，截图编号未记录。"} |
| `navigation` | {"ratio":[600,231],"source":"旧 theme.ts 的暗色 #1e1e1e 导航；231 是默认前背景通道范围。"} |
| `settings-card` | {"ratio":[1100,231],"source":"旧 theme.ts 的暗色 #232323 设置组；231 是默认前背景通道范围。"} |
| `settings-sidebar` | {"ratio":[3800,231],"source":"palette.source.preMigration"} |
| `overlay` | {"ratio":[3000,231],"source":"palette.source.preMigration"} |
| `catalog` | {"ratio":[2000,231],"source":"palette.source.preMigration"} |
| `result-opacity` | {"value":50,"source":"palette.source.preMigration"} |
| `result-icon-background` | {"value":83.333333,"source":"palette.source.preMigration"} |
| `result-stroke` | {"contrast":{"base":{"light":8,"dark":15.6},"slope":0.08},"source":"palette.source.preMigration"} |
| `accent` | {"value":6,"source":"palette.source.preMigration"} |
| `secondary` | {"value":5,"source":"palette.source.preMigration"} |
| `window-alt` | {"value":4,"source":"palette.source.preMigration"} |
| `sidebar-opacity` | {"value":70,"source":"palette.source.preMigration"} |
| `selected` | {"contrast":{"base":5.5,"slope":0.04},"source":"palette.source.preMigration"} |
| `page-stroke` | {"value":{"light":8,"dark":6},"source":"palette.source.preMigration"} |
| `composer-opacity` | {"value":{"light":86.4706,"dark":96},"source":"palette.source.preMigration"} |
| `overlay-opacity` | {"value":96,"source":"palette.source.preMigration"} |
| `composer-stroke` | {"value":20,"source":"palette.source.preMigration"} |
| `background-alt` | {"value":3,"source":"palette.source.preMigration"} |
| `menu-opacity` | {"value":90,"source":"palette.source.preMigration"} |
| `menu-border` | {"contrast":{"base":{"light":8,"dark":8.2},"slope":0.08},"source":"palette.source.preMigration"} |
| `menu-hover` | {"value":5.5,"source":"palette.source.preMigration"} |
| `border` | {"contrast":{"base":{"light":7.8,"dark":8.4},"slope":0.08},"source":"palette.source.preMigration"} |
| `border-hover` | {"contrast":{"base":11.7,"slope":0.1},"source":"palette.source.preMigration"} |
| `surface` | {"contrast":{"base":3,"slope":0.03},"source":"palette.source.preMigration"} |
| `navigation-selected` | {"ratio":[2400,231],"source":"palette.source.preMigration"} |
| `surface-elevated-mix` | {"value":{"light":4,"dark":7},"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex OKLab 抬升卡片与代码块表面混合比例。"} |
| `surface-tertiary-mix` | {"value":{"light":6.5,"dark":11},"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex OKLab 三级嵌套表面混合比例。"} |
| `surface-glass-opacity` | {"value":{"light":86,"dark":84},"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex 吸顶摘要头与半透明浮层玻璃不透明度。"} |
| `border-subtle-mix` | {"contrast":{"base":{"light":5.5,"dark":6},"slope":0.06},"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex 内嵌极细分隔线 OKLab 对比度响应参数。"} |
| `activity-summary-opacity` | {"value":60,"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex 对话流工具组摘要行 60% 前景阶梯。"} |
| `text-floor` | {"value":4.5,"source":"D-005 R-DECISION-023：用户需要阅读的文字（含过程子步骤）对比度不低于 4.5:1；生成时把未达标的文字推深到达标。"} |
| `activity-child-opacity` | {"value":36,"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex 对话流工具组展开子项 36% 前景阶梯。"} |
| `diff-surface-opacity` | {"value":{"light":10,"dark":14},"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex 顶栏与回合内 Pin Summary 增删行胶囊柔化底色比例。"} |
| `focus-ring-soft-opacity` | {"value":{"light":22,"dark":28},"source":"design/archive/research/codex-design-system-review.md#阶段一；Codex 输入框与 Composer 柔和聚焦外发光混合比例。"} |

## 参考值与语义派生

参考输入为 background、foreground、accent 和 contrast；透明侧栏偏好选择已有材料。引用只允许参考值进入语义层，组件只映射语义层。

| 参考值 | 值 | 来源 |
| --- | --- | --- |
| `black` | `#000000` | WCAG 黑白可读前景候选，既有算法边界。 |
| `white` | `#ffffff` | WCAG 黑白可读前景候选，既有算法边界。 |
| `transparent` | `transparent` | CSS 透明混色目标，保留浏览器色彩空间与预乘 alpha 语义。 |
| `default-background-light` | `#ffffff` | themes.background 既有浅色默认覆盖匹配值；自定义输入不套用。 |
| `default-background-dark` | `#181818` | themes.background 既有暗色默认覆盖匹配值；自定义输入不套用。 |
| `default-foreground-dark` | `#ffffff` | themes.foreground 既有暗色默认覆盖匹配值。 |
| `default-accent` | `#3a83f7` | themes.accent 既有默认覆盖匹配值。 |
| `file-link-default` | `#2c67c5` | palette.source.preMigration |
| `primary-text-default-dark` | `#2d2d2d` | palette.source.preMigration |
| `user-message-default-dark` | `#173e76` | palette.source.preMigration |
| `user-message-default-light` | `#e8f3fe` | palette.source.preMigration |
| `user-text-default-dark` | `#f6fafe` | palette.source.preMigration |
| `user-text-default-light` | `#0c274a` | palette.source.preMigration |
| `settings-sidebar-default-solid` | `rgb(40 40 40 / 1)` | palette.source.preMigration |
| `settings-sidebar-default-translucent` | `rgb(40 40 40 / 0.7)` | palette.source.preMigration |
| `settings-row-default-dark` | `rgba(255, 255, 255, 0.08)` | palette.source.preMigration |
| `page-shadow-ambient` | `#0000000d` | palette.source.preMigration |
| `composer-shadow-light` | `0 0 0 1px #0000000a, 0 2px 8px 0 #0000000a, 0 4px 80px 8px #00000006` | 原 renderer/src/styles.css 的浅色输入区阴影，数值迁入 Token 源（D-005 数值只在 Token 源）。 |
| `composer-shadow-dark` | `inset 0 0 1px 0 #fff3` | 原 renderer/src/styles.css 的暗色输入区阴影，数值迁入 Token 源（D-005 数值只在 Token 源）。 |
| `success` | `var(--color-success)` | foundation.color-success 已有成功反馈，不改变状态配色。 |
| `warning` | `var(--color-warning)` | foundation.color-warning；subagent attention 与 UNKNOWN 的 warning toast 现有语义。 |
| `error` | `var(--color-destructive)` | foundation.color-destructive 既有错误与危险反馈。 |
| `result-shadow-near` | `#0000000a` | renderer/src/workbench.css 的原 review-comment-card 阴影，D3 保留。 |
| `result-shadow-ambient` | `#0000000d` | renderer/src/workbench.css 的原 review-comment-card 阴影，D3 保留。 |
| `settings-attention` | `#f59e0b` | 原 App.tsx 的 bg-amber-500 设置关注指示点；Tailwind amber-500 原值。 |
| `workbench-dialog-backdrop` | `#0006` | renderer/src/workbench.css .dialog-backdrop；D2 精确迁移，值来自原字面量债务。 |
| `workbench-control-thumb` | `white` | renderer/src/workbench.css .settings-page input[role="switch"]::after; .resource-switch::after; .composer-slider-shell input::-webkit-slider-thumb；D2 精确迁移，值来自原字面量债务。 |
| `workbench-diff-count-added` | `#16a45d` | renderer/src/workbench.css .diff-count b；D2 精确迁移，值来自原字面量债务。 |
| `workbench-diff-count-removed` | `#df515b` | renderer/src/workbench.css .diff-count em；D2 精确迁移，值来自原字面量债务。 |
| `workbench-trajectory-match-ink` | `#e8a838` | renderer/src/workbench.css .trajectory-content mark；D2 精确迁移，值来自原字面量债务。 |
| `workbench-inspection-scrim` | `rgb(0 0 0 / 15%)` | renderer/src/workbench.css .hook-stats-overlay；D2 精确迁移，值来自原字面量债务。 |
| `workbench-shortcut-border` | `rgb(255 255 255 / 5%)` | renderer/src/workbench.css .new-task-shortcut；D2 精确迁移，值来自原字面量债务。 |
| `workbench-shortcut-surface` | `#1b1b1b` | renderer/src/workbench.css .new-task-shortcut；D2 精确迁移，值来自原字面量债务。 |
| `workbench-shortcut-foreground` | `#fff` | renderer/src/workbench.css .new-task-shortcut；D2 精确迁移，值来自原字面量债务。 |
| `workbench-markdown-list-marker-dark` | `#ffffff7f` | renderer/src/workbench.css .dark .workspace-file-markdown .workspace-markdown-list-marker；D2 精确迁移，值来自原字面量债务。 |
| `workbench-review-comment-surface` | `light-dark(rgba(0, 0, 0, 0.032), rgba(255, 255, 255, 0.032))` | renderer/src/workbench.css .review-comment-editor; .review-comment-card；D2 精确迁移，值来自原字面量债务。 |
| `workbench-review-tree-guide-ink` | `#84848a` | renderer/src/workbench.css .review-tree-guide；D2 精确迁移，值来自原字面量债务。 |
| `workbench-diff-modified` | `light-dark(#009fff, #69b1ff)` | renderer/src/workbench.css --diffs-modified-color-override；D2 精确迁移，值来自原字面量债务。 |
| `workbench-diff-added` | `#40c977` | renderer/src/workbench.css --diffs-addition-color-override；D2 精确迁移，值来自原字面量债务。 |
| `workbench-diff-removed` | `#fa423e` | renderer/src/workbench.css --diffs-deletion-color-override；D2 精确迁移，值来自原字面量债务。 |
| `workbench-slider-selected-track` | `#ffffff80` | renderer/src/workbench.css .composer-slider-track i[data-selected=true]；D2 精确迁移，值来自原字面量债务。 |
| `workbench-annotation-selected-foreground` | `#91c5ff` | renderer/src/workbench.css .browser-annotation-trigger[aria-pressed="true"]；D2 精确迁移，值来自原字面量债务。 |
| `workbench-annotation-selected-surface` | `#4795ff26` | renderer/src/workbench.css .browser-annotation-trigger[aria-pressed="true"]；D2 精确迁移，值来自原字面量债务。 |
| `tooltip-surface-light` | `#f0f0f0` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-surface-dark` | `#2b2b2b` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-text-light` | `#0d0d0d` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-text-dark` | `#f8f8f8` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-tag-light` | `#e6e6e6` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-tag-dark` | `#363636` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-tag-text-light` | `#5c5c5c` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `tooltip-tag-text-dark` | `#adadad` | renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |

| 语义角色 | 派生公式 | 默认主题覆盖 | 用途与来源 |
| --- | --- | --- | --- |
| `surface-base` | `{"input":"background"}` | `[]` | 基础阅读表面，卡片、面板和输入静止背景共用。 palette.source.preMigration |
| `text-default` | `{"input":"foreground"}` | `[]` | 默认正文与中性主动作底色。 palette.source.preMigration |
| `interaction-focus` | `{"input":"accent"}` | `[]` | 用户强调色和键盘焦点。 palette.source.preMigration |
| `text-file-link` | `{"input":"accent"}` | `[{"match":{"accent":"default-accent"},"value":{"reference":"file-link-default"}}]` | 文件引用的基色。 palette.source.preMigration |
| `text-file-link-on-surface` | `{"mode":{"light":{"semantic":"text-file-link"},"dark":{"mix":{"from":{"semantic":"text-file-link"},"into":{"semantic":"text-default"},"percent":"file-link-dark","space":"srgb"}}}}` | `[]` | 明暗阅读表面上的文件链接。 palette.source.preMigration |
| `text-subtle` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"text-subtle","space":"srgb"}}` | `[]` | 次要文字，适用进度和元信息。 palette.source.preMigration |
| `text-subtlest` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"text-subtlest","space":"srgb"}}` | `[]` | 可读的低强调元信息文字，与禁用状态区分。 design-system/accessibility.md#默认主题修订 |
| `status-settled` | `{"mode":{"light":{"semantic":"text-subtle"},"dark":{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"text-settled-dark","space":"srgb"}}}}` | `[]` | 已结算过程元信息，保留暗色半透明与浅色次要文字的区别。 palette.source.preMigration |
| `surface-raised` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"raised","space":"srgb"}}` | `[]` | 高于基础表面的实色抬升层。 palette.source.preMigration |
| `surface-muted` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"surface","space":"srgb"}}` | `[]` | 弱化表面前景透明层。 palette.source.preMigration |
| `surface-raised-translucent` | `{"mode":{"light":{"semantic":"surface-muted"},"dark":{"mix":{"from":{"semantic":"surface-raised"},"into":{"reference":"transparent"},"percent":"result-opacity","space":"srgb"}}}}` | `[]` | 已完成结果使用的半透明抬升表面。原配方对透明度有独立要求。 palette.source.preMigration |
| `border-result` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"result-stroke","space":"srgb"}}` | `[]` | 已完成结果的细描边，保留其与通用边框不同的强度。 palette.source.preMigration |
| `shadow-result` | `{"shadows":[{"geometry":"0 0 0 .5px","color":{"semantic":"border-result"}}]}` | `[]` | 已完成结果的半像素描边阴影。 palette.source.preMigration |
| `surface-sunken` | `{"mode":{"light":{"semantic":"surface-base"},"dark":{"mix":{"from":{"semantic":"surface-base"},"into":{"reference":"black"},"percent":"result-icon-background","space":"srgb"}}}}` | `[]` | 暗色内凹图标底色，浅色沿用基础表面。 palette.source.preMigration |
| `surface-history` | `{"mode":{"light":{"semantic":"surface-base"},"dark":{"semantic":"surface-raised"}}}` | `[]` | 历史过程实色抬升层，浅色沿用基础表面。 palette.source.preMigration |
| `surface-control` | `{"mode":{"light":{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"background-alt","space":"srgb"}},"dark":{"semantic":"surface-raised"}}}` | `[]` | 紧凑控件的抬升表面。 palette.source.preMigration |
| `surface-overlay` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"overlay","space":"srgb"}}` | `[]` | 暗色浮层的基础抬升色。 palette.source.preMigration |
| `surface-history-hover` | `{"mode":{"light":{"semantic":"surface-base"},"dark":{"mix":{"from":{"semantic":"surface-overlay"},"into":{"reference":"transparent"},"percent":"overlay-opacity","space":"srgb"}}}}` | `[]` | 历史过程悬停使用的半透明浮层。 palette.source.preMigration |
| `text-primary-inverse` | `{"readableForeground":{"semantic":"text-default"}}` | `[{"match":{"mode":"dark","foreground":"default-foreground-dark"},"value":{"reference":"primary-text-default-dark"}}]` | 中性主动作上的可读文字。 palette.source.preMigration |
| `surface-accent` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"accent","space":"srgb"}}` | `[]` | 弱强调背景。 palette.source.preMigration |
| `surface-secondary` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"secondary","space":"srgb"}}` | `[]` | 次要控件的前景透明层。 palette.source.preMigration |
| `surface-user-message` | `{"semantic":"surface-accent"}` | `[{"match":{"mode":"dark","background":"default-background-dark"},"value":{"reference":"user-message-default-dark"}},{"match":{"mode":"light","background":"default-background-light"},"value":{"reference":"user-message-default-light"}}]` | 用户消息区分层，默认主题保留已采纳蓝色。 palette.source.preMigration |
| `text-user-message` | `{"semantic":"text-default"}` | `[{"match":{"mode":"dark","background":"default-background-dark"},"value":{"reference":"user-text-default-dark"}},{"match":{"mode":"light","background":"default-background-light"},"value":{"reference":"user-text-default-light"}}]` | 用户消息正文，默认主题保留蓝底配对前景。 palette.source.preMigration |
| `surface-window-alt` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"window-alt","space":"srgb"}}` | `[]` | 浅色外壳与次级窗口表面。 palette.source.preMigration |
| `surface-shell` | `{"mode":{"light":{"semantic":"surface-window-alt"},"dark":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"shell","space":"srgb"}}}}` | `[]` | 标题栏和外框表面。 palette.source.preMigration |
| `surface-navigation` | `{"mode":{"light":{"translucent":{"solid":{"semantic":"surface-base"},"translucent":{"mix":{"from":{"semantic":"surface-base"},"into":{"reference":"transparent"},"percent":"sidebar-opacity","space":"oklab"}}}},"dark":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"navigation","space":"srgb"}}}}` | `[]` | 导航表面。浅色透明材料保留 OKLab 混色。 palette.source.preMigration |
| `interaction-selected` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"selected","space":"srgb"}}` | `[]` | 悬停、选中与表面交互的前景层。 palette.source.preMigration |
| `interaction-navigation-selected` | `{"mode":{"light":{"semantic":"interaction-selected"},"dark":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"navigation-selected","space":"srgb"}}}}` | `[]` | 导航选中层，暗色独立使用原有实色抬升。 palette.source.preMigration |
| `shadow-page` | `{"shadows":[{"geometry":"0 0 0 .5px","color":{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"page-stroke","space":"srgb"}}},{"geometry":"0 4px 16px","color":{"reference":"page-shadow-ambient"}}]}` | `[]` | 共享页面表面阴影。 palette.source.preMigration |
| `surface-settings-sidebar` | `{"mode":{"light":{"translucent":{"solid":{"semantic":"surface-base"},"translucent":{"mix":{"from":{"semantic":"surface-base"},"into":{"reference":"transparent"},"percent":"sidebar-opacity","space":"srgb"}}}},"dark":{"translucent":{"solid":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"settings-sidebar","space":"srgb"}},"translucent":{"mix":{"from":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"settings-sidebar","space":"srgb"}},"into":{"reference":"transparent"},"percent":"sidebar-opacity","space":"srgb"}}}}}}` | `[{"match":{"mode":"dark","background":"default-background-dark"},"value":{"translucent":{"solid":{"reference":"settings-sidebar-default-solid"},"translucent":{"reference":"settings-sidebar-default-translucent"}}}}]` | 设置侧栏材料，保留其与导航表面的区别。 palette.source.preMigration |
| `interaction-settings-row` | `{"semantic":"interaction-selected"}` | `[{"match":{"mode":"dark","background":"default-background-dark"},"value":{"reference":"settings-row-default-dark"}}]` | 设置侧栏行悬停层，默认暗色保留观察到的 8% 白色层。 palette.source.preMigration |
| `surface-composer` | `{"mix":{"from":{"mode":{"light":{"semantic":"surface-base"},"dark":{"semantic":"surface-overlay"}}},"into":{"reference":"transparent"},"percent":"composer-opacity","space":"srgb"}}` | `[]` | 输入区半透明材料，明暗透明度不同。 palette.source.preMigration |
| `shadow-composer` | `{"mode":{"light":{"reference":"composer-shadow-light"},"dark":{"shadows":[{"geometry":"inset 0 0 1px 0","color":{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"composer-stroke","space":"srgb"}}}]}}}` | `[{"match":{"mode":"dark","background":"default-background-dark","foreground":"default-foreground-dark"},"value":{"reference":"composer-shadow-dark"}}]` | 输入区阴影，默认主题沿用宿主变量。 palette.source.preMigration |
| `surface-alt` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"background-alt","space":"srgb"}}` | `[]` | 基础表面之上的轻微分组层。 palette.source.preMigration |
| `surface-settings-group` | `{"mode":{"light":{"semantic":"surface-base"},"dark":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"settings-card","space":"srgb"}}}}` | `[]` | 设置组表面，暗色比通用抬升层更低。 palette.source.preMigration |
| `surface-menu` | `{"mix":{"from":{"mode":{"light":{"semantic":"surface-base"},"dark":{"semantic":"surface-raised"}}},"into":{"reference":"transparent"},"percent":"menu-opacity","space":"srgb"}}` | `[]` | 菜单的半透明浮层材料。 palette.source.preMigration |
| `border-menu` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"menu-border","space":"srgb"}}` | `[]` | 菜单描边，保留与通用边框不同的暗色强度。 palette.source.preMigration |
| `interaction-menu-hover` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"menu-hover","space":"srgb"}}` | `[]` | 菜单行悬停层，不随 contrast 改变。 palette.source.preMigration |
| `surface-catalog` | `{"mode":{"light":{"semantic":"surface-base"},"dark":{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"catalog","space":"srgb"}}}}` | `[]` | 目录选择器表面，保留与菜单不同的抬升高度。 palette.source.preMigration |
| `text-settings-secondary` | `{"mode":{"light":{"semantic":"text-subtle"},"dark":{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"text-settings-dark","space":"srgb"}}}}` | `[]` | 设置说明文字，暗色强于已结算过程元信息。 palette.source.preMigration |
| `border-default` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"border","space":"srgb"}}` | `[]` | 通用边框。 palette.source.preMigration |
| `border-hover` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"border-hover","space":"srgb"}}` | `[]` | 悬停边框。 palette.source.preMigration |
| `status-running` | `{"semantic":"text-subtle"}` | `[]` | 运行中进度，复用现有 activity-status 和 execution-status 的次要文字。 conversation/activity-group/activity-group.css 与 renderer/src/workbench.css 的现有进度颜色。 |
| `status-success` | `{"reference":"success"}` | `[]` | 成功反馈，不代表所有已结算状态都成功。 foundation.color-success 的现有成功语义。 |
| `status-attention` | `{"reference":"warning"}` | `[]` | 需要用户关注或处理。 conversation/subagent-panel/subagent-panel.css 的 data-state=attention。 |
| `status-unknown` | `{"reference":"warning"}` | `[]` | 执行结果未知，需要核对；沿用 warning 反馈。 renderer/src/WorktreeStatus.tsx 将 unknown toast 映射为 warning；不等同失败。 |
| `status-error` | `{"reference":"error"}` | `[]` | 明确的错误或失败。 foundation.color-destructive 的既有错误反馈。 |
| `shadow-result-raised` | `{"shadows":[{"geometry":"0 0 0 .5px","color":{"semantic":"border-result"}},{"geometry":"0 3px 7.5px","color":{"reference":"result-shadow-near"}},{"geometry":"0 0 20px","color":{"reference":"result-shadow-ambient"}}]}` | `[]` | 结果悬停层在语义结果边框上叠加近场与环境投影。 renderer/src/workbench.css 的原 review-comment-card box-shadow。 |
| `interaction-pressed` | `{"semantic":"interaction-selected"}` | `[]` | 按下状态沿用既有选中前景层，不新增配色。 D3 D1 的 interaction.pressed 语义，保留现有 interaction-selected 同色关系。 |
| `settings-attention-indicator` | `{"reference":"settings-attention"}` | `[]` | 设置入口的任务关注指示点，保留明暗主题下既有固定 amber 色。 renderer/src/views/WorkbenchChrome.tsx 从 App.tsx 提取的设置入口。 |
| `surface-dialog-scrim` | `{"reference":"workbench-dialog-backdrop"}` | `[]` | 对话框遮罩，保留原 40% 黑色覆盖度。 renderer/src/workbench.css .dialog-backdrop；D2 精确迁移，值来自原字面量债务。 |
| `surface-control-thumb` | `{"reference":"workbench-control-thumb"}` | `[]` | 原生开关与滑块的固定白色把手，独立于当前主题前景。 renderer/src/workbench.css .settings-page input[role="switch"]::after; .resource-switch::after; .composer-slider-shell input::-webkit-slider-thumb；D2 精确迁移，值来自原字面量债务。 |
| `text-diff-count-added` | `{"reference":"workbench-diff-count-added"}` | `[]` | 差异行数中新增行的内容色。 renderer/src/workbench.css .diff-count b；D2 精确迁移，值来自原字面量债务。 |
| `text-diff-count-removed` | `{"reference":"workbench-diff-count-removed"}` | `[]` | 差异行数中删除行的内容色。 renderer/src/workbench.css .diff-count em；D2 精确迁移，值来自原字面量债务。 |
| `highlight-trajectory-match` | `{"reference":"workbench-trajectory-match-ink"}` | `[]` | 轨迹搜索高亮的墨色，调用方保持既有 35% srgb 透明混色。 renderer/src/workbench.css .trajectory-content mark；D2 精确迁移，值来自原字面量债务。 |
| `surface-inspection-scrim` | `{"reference":"workbench-inspection-scrim"}` | `[]` | Hook 统计检查浮层的轻遮罩，保留原 15% 黑色。 renderer/src/workbench.css .hook-stats-overlay；D2 精确迁移，值来自原字面量债务。 |
| `border-dark-shortcut` | `{"reference":"workbench-shortcut-border"}` | `[]` | 深色新建任务快捷入口的细边框。 renderer/src/workbench.css .new-task-shortcut；D2 精确迁移，值来自原字面量债务。 |
| `surface-dark-shortcut` | `{"reference":"workbench-shortcut-surface"}` | `[]` | 新建任务快捷入口的固定深色背景。 renderer/src/workbench.css .new-task-shortcut；D2 精确迁移，值来自原字面量债务。 |
| `text-dark-shortcut` | `{"reference":"workbench-shortcut-foreground"}` | `[]` | 固定深色快捷入口的白色文字。 renderer/src/workbench.css .new-task-shortcut；D2 精确迁移，值来自原字面量债务。 |
| `text-content-list-marker-dark` | `{"reference":"workbench-markdown-list-marker-dark"}` | `[]` | 暗色可编辑 Markdown 列表标记的半透明白色。 renderer/src/workbench.css .dark .workspace-file-markdown .workspace-markdown-list-marker；D2 精确迁移，值来自原字面量债务。 |
| `surface-review-comment` | `{"reference":"workbench-review-comment-surface"}` | `[]` | 批注编辑器与卡片的低对比表面，继续由浏览器 color-scheme 选择 light-dark 分支。 renderer/src/workbench.css .review-comment-editor; .review-comment-card；D2 精确迁移，值来自原字面量债务。 |
| `border-review-tree-guide` | `{"reference":"workbench-review-tree-guide-ink"}` | `[]` | 文件评审树的引导线墨色，调用方保持既有 25% lab 透明混色。 renderer/src/workbench.css .review-tree-guide；D2 精确迁移，值来自原字面量债务。 |
| `content-diff-modified` | `{"reference":"workbench-diff-modified"}` | `[]` | 代码差异阅读器的修改色，继续由浏览器 color-scheme 选择分支。 renderer/src/workbench.css --diffs-modified-color-override；D2 精确迁移，值来自原字面量债务。 |
| `content-diff-added` | `{"reference":"workbench-diff-added"}` | `[]` | 代码差异阅读器的新增色，不等同于状态成功色。 renderer/src/workbench.css --diffs-addition-color-override；D2 精确迁移，值来自原字面量债务。 |
| `content-diff-removed` | `{"reference":"workbench-diff-removed"}` | `[]` | 代码差异阅读器的删除色，不等同于危险操作色。 renderer/src/workbench.css --diffs-deletion-color-override；D2 精确迁移，值来自原字面量债务。 |
| `interaction-slider-selected-track` | `{"reference":"workbench-slider-selected-track"}` | `[]` | 输入器推理档位中已选轨道的半透明填充。 renderer/src/workbench.css .composer-slider-track i[data-selected=true]；D2 精确迁移，值来自原字面量债务。 |
| `text-annotation-selected` | `{"reference":"workbench-annotation-selected-foreground"}` | `[]` | 浏览器标注模式已选入口的文字色。 renderer/src/workbench.css .browser-annotation-trigger[aria-pressed="true"]；D2 精确迁移，值来自原字面量债务。 |
| `surface-annotation-selected` | `{"reference":"workbench-annotation-selected-surface"}` | `[]` | 浏览器标注模式已选入口的透明背景色。 renderer/src/workbench.css .browser-annotation-trigger[aria-pressed="true"]；D2 精确迁移，值来自原字面量债务。 |
| `surface-elevated-oklab` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"surface-elevated-mix","space":"oklab"}}` | `[]` | 基于 OKLab 均匀感知插值派生的抬升表面，用于代码块表头、决策卡片与二级面板。 design/archive/research/codex-design-system-review.md#阶段一 |
| `surface-tertiary-oklab` | `{"mix":{"from":{"input":"foreground"},"into":{"input":"background"},"percent":"surface-tertiary-mix","space":"oklab"}}` | `[]` | 基于 OKLab 均匀感知插值派生的三级表面，用于内嵌徽章、分段底槽与代码块工具栏悬停。 design/archive/research/codex-design-system-review.md#阶段一 |
| `surface-glass-oklab` | `{"mix":{"from":{"semantic":"surface-elevated-oklab"},"into":{"reference":"transparent"},"percent":"surface-glass-opacity","space":"oklab"}}` | `[]` | 基于 OKLab 派生的半透明毛玻璃表面，配合 backdrop-filter 用于吸顶摘要头与浮层顶栏。 design/archive/research/codex-design-system-review.md#阶段一 |
| `border-subtle-oklab` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"border-subtle-mix","space":"oklab"}}` | `[]` | 基于 OKLab 派生的极细内嵌分隔线，随 contrast 偏好平滑缩放。 design/archive/research/codex-design-system-review.md#阶段一 |
| `text-activity-summary` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"activity-summary-opacity","space":"oklab"}}` | `[]` | 对话流工具调用聚合摘要行与折叠态过程行前景（60% OKLab 感知阶梯）。 design/archive/research/codex-design-system-review.md#阶段一 |
| `text-activity-child` | `{"mix":{"from":{"input":"foreground"},"into":{"reference":"transparent"},"percent":"activity-child-opacity","space":"oklab"}}` | `[]` | 对话流工具调用组展开后的子步骤低强调前景（36% OKLab 感知阶梯）。 design/archive/research/codex-design-system-review.md#阶段一 |
| `surface-diff-added` | `{"mix":{"from":{"reference":"workbench-diff-count-added"},"into":{"reference":"transparent"},"percent":"diff-surface-opacity","space":"oklab"}}` | `[]` | Pin Summary 与文件变更胶囊的新增行柔化底色。 design/archive/research/codex-design-system-review.md#阶段一 |
| `surface-diff-removed` | `{"mix":{"from":{"reference":"workbench-diff-count-removed"},"into":{"reference":"transparent"},"percent":"diff-surface-opacity","space":"oklab"}}` | `[]` | Pin Summary 与文件变更胶囊的删除行柔化底色。 design/archive/research/codex-design-system-review.md#阶段一 |
| `interaction-focus-ring-soft` | `{"mix":{"from":{"input":"accent"},"into":{"reference":"transparent"},"percent":"focus-ring-soft-opacity","space":"oklab"}}` | `[]` | Composer 与表单控件聚焦态的柔和强调色光晕。 design/archive/research/codex-design-system-review.md#阶段一 |
| `surface-tooltip` | `{"mode":{"light":{"reference":"tooltip-surface-light"},"dark":{"reference":"tooltip-surface-dark"}}}` | `[]` | 提示的实色浮层底。 renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `text-tooltip` | `{"mode":{"light":{"reference":"tooltip-text-light"},"dark":{"reference":"tooltip-text-dark"}}}` | `[]` | 提示文字。 renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `surface-tooltip-tag` | `{"mode":{"light":{"reference":"tooltip-tag-light"},"dark":{"reference":"tooltip-tag-dark"}}}` | `[]` | 提示里快捷键标签的底。 renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |
| `text-tooltip-tag` | `{"mode":{"light":{"reference":"tooltip-tag-text-light"},"dark":{"reference":"tooltip-tag-text-dark"}}}` | `[]` | 提示里快捷键标签的文字。 renderer/src/styles.css .theme-areal-light/.theme-areal-dark；浮层规格迁入 Token 源，值不变。 |

## 调色板（由主题输入派生，用户可在外观设置中覆盖）

| 变量 | 层与角色 | 语义引用与组件映射 | 默认亮色 | 默认暗色 |
| --- | --- | --- | --- | --- |
| `--color-surface-elevated` | semantic · 基于 OKLab 均匀感知插值派生的抬升表面，用于代码块表头、决策卡片与二级面板。 | surface-elevated-oklab  | `color-mix(in oklab, #1a1c1f 4%, #ffffff)` | `color-mix(in oklab, #ffffff 7%, #181818)` |
| `--color-surface-tertiary` | semantic · 基于 OKLab 均匀感知插值派生的三级表面，用于内嵌徽章、分段底槽与代码块工具栏悬停。 | surface-tertiary-oklab  | `color-mix(in oklab, #1a1c1f 6.5%, #ffffff)` | `color-mix(in oklab, #ffffff 11%, #181818)` |
| `--color-surface-glass` | semantic · 基于 OKLab 派生的半透明毛玻璃表面，配合 backdrop-filter 用于吸顶摘要头与浮层顶栏。 | surface-glass-oklab  | `color-mix(in oklab, color-mix(in oklab, #1a1c1f 4%, #ffffff) 86%, transparent)` | `color-mix(in oklab, color-mix(in oklab, #ffffff 7%, #181818) 84%, transparent)` |
| `--color-border-subtle` | semantic · 基于 OKLab 派生的极细内嵌分隔线，随 contrast 偏好平滑缩放。 | border-subtle-oklab  | `color-mix(in oklab, #1a1c1f 5.5%, transparent)` | `color-mix(in oklab, #ffffff 6%, transparent)` |
| `--color-activity-summary` | component · 对话流工具调用聚合摘要行与折叠态过程行前景（60% OKLab 感知阶梯）。 | text-activity-summary 引用 text-activity-summary；用于折叠态工具聚合组标题与次级摘要。 | `color-mix(in oklab, #1a1c1f 60.5%, transparent)` | `color-mix(in oklab, #ffffff 60%, transparent)` |
| `--color-activity-child` | component · 对话流工具调用组展开后的子步骤低强调前景（36% OKLab 感知阶梯）。 | text-activity-child 引用 text-activity-child；用于展开态子活动行非悬停态的柔和降噪。 | `color-mix(in oklab, #1a1c1f 60.5%, transparent)` | `color-mix(in oklab, #ffffff 45.5%, transparent)` |
| `--color-diff-added-surface` | component · Pin Summary 与文件变更胶囊的新增行柔化底色。 | surface-diff-added 引用 surface-diff-added；用于顶栏及回合内 diff 统计胶囊底色。 | `color-mix(in oklab, #16a45d 10%, transparent)` | `color-mix(in oklab, #16a45d 14%, transparent)` |
| `--color-diff-removed-surface` | component · Pin Summary 与文件变更胶囊的删除行柔化底色。 | surface-diff-removed 引用 surface-diff-removed；用于顶栏及回合内 diff 统计胶囊底色。 | `color-mix(in oklab, #df515b 10%, transparent)` | `color-mix(in oklab, #df515b 14%, transparent)` |
| `--color-focus-ring-soft` | semantic · Composer 与表单控件聚焦态的柔和强调色光晕。 | interaction-focus-ring-soft  | `color-mix(in oklab, #3a83f7 22%, transparent)` | `color-mix(in oklab, #3a83f7 28%, transparent)` |
| `--color-background` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-foreground` | semantic · 默认正文与中性主动作底色。 | text-default  | `#1a1c1f` | `#ffffff` |
| `--color-brand` | semantic · 用户强调色和键盘焦点。 | interaction-focus  | `#3a83f7` | `#3a83f7` |
| `--color-file-reference` | semantic · 明暗阅读表面上的文件链接。 | text-file-link-on-surface  | `#2c67c5` | `color-mix(in srgb, #2c67c5 80%, #ffffff)` |
| `--color-process-settled` | component · 已结算过程元信息，保留暗色半透明与浅色次要文字的区别。 | status-settled 保留已有组件变量名；仅引用 status-settled。已结算过程元信息，保留暗色半透明与浅色次要文字的区别。 | `color-mix(in srgb, #1a1c1f 75%, #ffffff)` | `color-mix(in srgb, #ffffff 55%, transparent)` |
| `--color-result-card` | component · 已完成结果使用的半透明抬升表面。原配方对透明度有独立要求。 | surface-raised-translucent 保留已有组件变量名；仅引用 surface-raised-translucent。已完成结果使用的半透明抬升表面。原配方对透明度有独立要求。 | `color-mix(in srgb, #1a1c1f 3%, transparent)` | `color-mix(in srgb, color-mix(in srgb, #ffffff 9.090909090909092%, #181818) 50%, transparent)` |
| `--shadow-result-card` | component · 已完成结果的半像素描边阴影。 | shadow-result 保留已有组件变量名；仅引用 shadow-result。已完成结果的半像素描边阴影。 | `0 0 0 .5px color-mix(in srgb, #1a1c1f 8%, transparent)` | `0 0 0 .5px color-mix(in srgb, #ffffff 15.6%, transparent)` |
| `--color-result-icon` | component · 暗色内凹图标底色，浅色沿用基础表面。 | surface-sunken 保留已有组件变量名；仅引用 surface-sunken。暗色内凹图标底色，浅色沿用基础表面。 | `#ffffff` | `color-mix(in srgb, #181818 83.333333%, #000000)` |
| `--color-history-comment` | component · 历史过程实色抬升层，浅色沿用基础表面。 | surface-history 保留已有组件变量名；仅引用 surface-history。历史过程实色抬升层，浅色沿用基础表面。 | `#ffffff` | `color-mix(in srgb, #ffffff 9.090909090909092%, #181818)` |
| `--color-viewer-control` | component · 紧凑控件的抬升表面。 | surface-control 保留已有组件变量名；仅引用 surface-control。紧凑控件的抬升表面。 | `color-mix(in srgb, #1a1c1f 3%, transparent)` | `color-mix(in srgb, #ffffff 9.090909090909092%, #181818)` |
| `--color-history-comment-hover` | component · 历史过程悬停使用的半透明浮层。 | surface-history-hover 保留已有组件变量名；仅引用 surface-history-hover。历史过程悬停使用的半透明浮层。 | `#ffffff` | `color-mix(in srgb, color-mix(in srgb, #ffffff 12.987012987012987%, #181818) 96%, transparent)` |
| `--color-primary` | semantic · 默认正文与中性主动作底色。 | text-default  | `#1a1c1f` | `#ffffff` |
| `--color-primary-foreground` | semantic · 中性主动作上的可读文字。 | text-primary-inverse  | `#ffffff` | `#2d2d2d` |
| `--color-composer-action` | component · 默认正文与中性主动作底色。 | text-default 保留已有组件变量名；仅引用 text-default。默认正文与中性主动作底色。 | `var(--color-primary)` | `var(--color-primary)` |
| `--color-composer-action-foreground` | component · 中性主动作上的可读文字。 | text-primary-inverse 保留已有组件变量名；仅引用 text-primary-inverse。中性主动作上的可读文字。 | `var(--color-primary-foreground)` | `var(--color-primary-foreground)` |
| `--color-accent` | semantic · 弱强调背景。 | surface-accent  | `color-mix(in srgb, #1a1c1f 6%, #ffffff)` | `color-mix(in srgb, #ffffff 6%, #181818)` |
| `--color-secondary` | semantic · 次要控件的前景透明层。 | surface-secondary  | `color-mix(in srgb, #1a1c1f 5%, transparent)` | `color-mix(in srgb, #ffffff 5%, transparent)` |
| `--color-user-message` | component · 用户消息区分层，默认主题保留已采纳蓝色。 | surface-user-message 保留已有组件变量名；仅引用 surface-user-message。用户消息区分层，默认主题保留已采纳蓝色。 | `#e8f3fe` | `#173e76` |
| `--color-user-message-text` | component · 用户消息正文，默认主题保留蓝底配对前景。 | text-user-message 保留已有组件变量名；仅引用 text-user-message。用户消息正文，默认主题保留蓝底配对前景。 | `#0c274a` | `#f6fafe` |
| `--color-background-win-alt` | semantic · 浅色外壳与次级窗口表面。 | surface-window-alt  | `color-mix(in srgb, #1a1c1f 4%, #ffffff)` | `color-mix(in srgb, #ffffff 4%, #181818)` |
| `--color-shell` | semantic · 标题栏和外框表面。 | surface-shell  | `color-mix(in srgb, #1a1c1f 4%, #ffffff)` | `color-mix(in srgb, #ffffff 5.194805194805195%, #181818)` |
| `--color-navigation-background` | semantic · 导航表面。浅色透明材料保留 OKLab 混色。 | surface-navigation  | `color-mix(in oklab, #ffffff 70%, transparent)` | `color-mix(in srgb, #ffffff 2.5974025974025974%, #181818)` |
| `--color-navigation-selected` | semantic · 导航选中层，暗色独立使用原有实色抬升。 | interaction-navigation-selected  | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 10.38961038961039%, #181818)` |
| `--shadow-page-surface` | component · 共享页面表面阴影。 | shadow-page 保留已有组件变量名；仅引用 shadow-page。共享页面表面阴影。 | `0 0 0 .5px color-mix(in srgb, #1a1c1f 8%, transparent), 0 4px 16px #0000000d` | `0 0 0 .5px color-mix(in srgb, #ffffff 6%, transparent), 0 4px 16px #0000000d` |
| `--color-sidebar` | component · 设置侧栏材料，保留其与导航表面的区别。 | surface-settings-sidebar 保留已有组件变量名；仅引用 surface-settings-sidebar。设置侧栏材料，保留其与导航表面的区别。 | `color-mix(in srgb, #ffffff 70%, transparent)` | `rgb(40 40 40 / 0.7)` |
| `--color-sidebar-item` | component · 设置侧栏行悬停层，默认暗色保留观察到的 8% 白色层。 | interaction-settings-row 保留已有组件变量名；仅引用 interaction-settings-row。设置侧栏行悬停层，默认暗色保留观察到的 8% 白色层。 | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `rgba(255, 255, 255, 0.08)` |
| `--color-composer` | component · 输入区半透明材料，明暗透明度不同。 | surface-composer 保留已有组件变量名；仅引用 surface-composer。输入区半透明材料，明暗透明度不同。 | `color-mix(in srgb, #ffffff 86.4706%, transparent)` | `color-mix(in srgb, color-mix(in srgb, #ffffff 12.987012987012987%, #181818) 96%, transparent)` |
| `--shadow-composer` | component · 输入区阴影，默认主题沿用宿主变量。 | shadow-composer 保留已有组件变量名；仅引用 shadow-composer。输入区阴影，默认主题沿用宿主变量。 | `0 0 0 1px #0000000a, 0 2px 8px 0 #0000000a, 0 4px 80px 8px #00000006` | `inset 0 0 1px 0 #fff3` |
| `--color-background-alt` | semantic · 基础表面之上的轻微分组层。 | surface-alt  | `color-mix(in srgb, #1a1c1f 3%, #ffffff)` | `color-mix(in srgb, #ffffff 3%, #181818)` |
| `--color-card` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-settings-card` | component · 设置组表面，暗色比通用抬升层更低。 | surface-settings-group 保留已有组件变量名；仅引用 surface-settings-group。设置组表面，暗色比通用抬升层更低。 | `#ffffff` | `color-mix(in srgb, #ffffff 4.761904761904762%, #181818)` |
| `--color-header` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-panel` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-popover` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-menu` | component · 菜单的半透明浮层材料。 | surface-menu 保留已有组件变量名；仅引用 surface-menu。菜单的半透明浮层材料。 | `color-mix(in srgb, #ffffff 90%, transparent)` | `color-mix(in srgb, color-mix(in srgb, #ffffff 9.090909090909092%, #181818) 90%, transparent)` |
| `--color-menu-border` | component · 菜单描边，保留与通用边框不同的暗色强度。 | border-menu 保留已有组件变量名；仅引用 border-menu。菜单描边，保留与通用边框不同的暗色强度。 | `color-mix(in srgb, #1a1c1f 8%, transparent)` | `color-mix(in srgb, #ffffff 8.2%, transparent)` |
| `--color-menu-hover` | component · 菜单行悬停层，不随 contrast 改变。 | interaction-menu-hover 保留已有组件变量名；仅引用 interaction-menu-hover。菜单行悬停层，不随 contrast 改变。 | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-composer-catalog` | component · 目录选择器表面，保留与菜单不同的抬升高度。 | surface-catalog 保留已有组件变量名；仅引用 surface-catalog。目录选择器表面，保留与菜单不同的抬升高度。 | `#ffffff` | `color-mix(in srgb, #ffffff 8.658008658008658%, #181818)` |
| `--color-markdown-inline-code` | component · 正文里行内代码的底色。 | surface-tertiary-oklab 仅引用 surface-tertiary-oklab；行内代码属于内嵌徽章。 | `color-mix(in oklab, #1a1c1f 6.5%, #ffffff)` | `color-mix(in oklab, #ffffff 11%, #181818)` |
| `--color-input` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-input-focused` | semantic · 基础阅读表面，卡片、面板和输入静止背景共用。 | surface-base  | `#ffffff` | `#181818` |
| `--color-input-border` | semantic · 通用边框。 | border-default  | `var(--color-border)` | `var(--color-border)` |
| `--color-input-border-hover` | semantic · 悬停边框。 | border-hover  | `var(--color-border-hover)` | `var(--color-border-hover)` |
| `--color-foreground-subtle` | semantic · 次要文字，适用进度和元信息。 | text-subtle  | `color-mix(in srgb, #1a1c1f 75%, #ffffff)` | `color-mix(in srgb, #ffffff 69.5%, #181818)` |
| `--color-foreground-subtlest` | semantic · 最弱元信息文字，未声明满足正文对比度。 | text-subtlest  | `color-mix(in srgb, #1a1c1f 70%, #ffffff)` | `color-mix(in srgb, #ffffff 55%, #181818)` |
| `--color-settings-secondary` | component · 设置说明文字，暗色强于已结算过程元信息。 | text-settings-secondary 保留已有组件变量名；仅引用 text-settings-secondary。设置说明文字，暗色强于已结算过程元信息。 | `color-mix(in srgb, #1a1c1f 75%, #ffffff)` | `color-mix(in srgb, #ffffff 65%, transparent)` |
| `--color-border` | semantic · 通用边框。 | border-default  | `color-mix(in srgb, #1a1c1f 7.8%, transparent)` | `color-mix(in srgb, #ffffff 8.4%, transparent)` |
| `--color-border-hover` | semantic · 悬停边框。 | border-hover  | `color-mix(in srgb, #1a1c1f 11.7%, transparent)` | `color-mix(in srgb, #ffffff 11.7%, transparent)` |
| `--color-hover` | semantic · 悬停、选中与表面交互的前景层。 | interaction-selected  | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-selected` | semantic · 悬停、选中与表面交互的前景层。 | interaction-selected  | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-surface` | semantic · 弱化表面前景透明层。 | surface-muted  | `color-mix(in srgb, #1a1c1f 3%, transparent)` | `color-mix(in srgb, #ffffff 3%, transparent)` |
| `--color-surface-hover` | semantic · 悬停、选中与表面交互的前景层。 | interaction-selected  | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-input-border-focused` | semantic · 用户强调色和键盘焦点。 | interaction-focus  | `#3a83f7` | `#3a83f7` |
| `--color-status-running` | semantic · 运行中进度，复用现有 activity-status 和 execution-status 的次要文字。 | status-running  | `color-mix(in srgb, #1a1c1f 75%, #ffffff)` | `color-mix(in srgb, #ffffff 69.5%, #181818)` |
| `--color-status-success` | semantic · 成功反馈，不代表所有已结算状态都成功。 | status-success  | `var(--color-success)` | `var(--color-success)` |
| `--color-status-attention` | semantic · 需要用户关注或处理。 | status-attention  | `var(--color-warning)` | `var(--color-warning)` |
| `--color-status-unknown` | semantic · 执行结果未知，需要核对；沿用 warning 反馈。 | status-unknown  | `var(--color-warning)` | `var(--color-warning)` |
| `--color-status-error` | semantic · 明确的错误或失败。 | status-error  | `var(--color-destructive)` | `var(--color-destructive)` |
| `--color-status-settled` | semantic · 已结算过程元信息，保留暗色半透明与浅色次要文字的区别。 | status-settled  | `color-mix(in srgb, #1a1c1f 75%, #ffffff)` | `color-mix(in srgb, #ffffff 55%, transparent)` |
| `--shadow-result-raised` | semantic · 结果悬停投影，全部依赖语义边框与已有参考色。 | shadow-result-raised  | `0 0 0 .5px color-mix(in srgb, #1a1c1f 8%, transparent), 0 3px 7.5px #0000000a, 0 0 20px #0000000d` | `0 0 0 .5px color-mix(in srgb, #ffffff 15.6%, transparent), 0 3px 7.5px #0000000a, 0 0 20px #0000000d` |
| `--color-settings-attention-indicator` | component · 设置入口的任务关注指示点。 | settings-attention-indicator 设置入口只引用对应语义角色，保留原 bg-amber-500 像素值。 | `#f59e0b` | `#f59e0b` |
| `--color-dialog-backdrop` | semantic · 对话框遮罩，保留原 40% 黑色覆盖度。 | surface-dialog-scrim  | `#0006` | `#0006` |
| `--color-control-thumb` | semantic · 原生开关与滑块的固定白色把手，独立于当前主题前景。 | surface-control-thumb  | `white` | `white` |
| `--color-diff-count-added` | component · 差异行数中新增行的内容色。 | text-diff-count-added 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#16a45d` | `#16a45d` |
| `--color-diff-count-removed` | component · 差异行数中删除行的内容色。 | text-diff-count-removed 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#df515b` | `#df515b` |
| `--color-trajectory-match-ink` | component · 轨迹搜索高亮的墨色，调用方保持既有 35% srgb 透明混色。 | highlight-trajectory-match 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#e8a838` | `#e8a838` |
| `--color-inspection-scrim` | semantic · Hook 统计检查浮层的轻遮罩，保留原 15% 黑色。 | surface-inspection-scrim  | `rgb(0 0 0 / 15%)` | `rgb(0 0 0 / 15%)` |
| `--color-shortcut-border` | component · 深色新建任务快捷入口的细边框。 | border-dark-shortcut 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `rgb(255 255 255 / 5%)` | `rgb(255 255 255 / 5%)` |
| `--color-shortcut-surface` | component · 新建任务快捷入口的固定深色背景。 | surface-dark-shortcut 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#1b1b1b` | `#1b1b1b` |
| `--color-shortcut-foreground` | component · 固定深色快捷入口的白色文字。 | text-dark-shortcut 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#fff` | `#fff` |
| `--color-markdown-list-marker-dark` | component · 暗色可编辑 Markdown 列表标记的半透明白色。 | text-content-list-marker-dark 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#ffffff7f` | `#ffffff7f` |
| `--color-review-comment-surface` | component · 批注编辑器与卡片的低对比表面，继续由浏览器 color-scheme 选择 light-dark 分支。 | surface-review-comment 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `light-dark(rgba(0, 0, 0, 0.032), rgba(255, 255, 255, 0.032))` | `light-dark(rgba(0, 0, 0, 0.032), rgba(255, 255, 255, 0.032))` |
| `--color-review-tree-guide-ink` | component · 文件评审树的引导线墨色，调用方保持既有 25% lab 透明混色。 | border-review-tree-guide 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#84848a` | `#84848a` |
| `--color-diff-modified` | component · 代码差异阅读器的修改色，继续由浏览器 color-scheme 选择分支。 | content-diff-modified 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `light-dark(#009fff, #69b1ff)` | `light-dark(#009fff, #69b1ff)` |
| `--color-content-diff-added` | component · 代码差异阅读器的新增色，不等同于状态成功色。 | content-diff-added 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#40c977` | `#40c977` |
| `--color-content-diff-removed` | component · 代码差异阅读器的删除色，不等同于危险操作色。 | content-diff-removed 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#fa423e` | `#fa423e` |
| `--color-slider-selected-track` | component · 输入器推理档位中已选轨道的半透明填充。 | interaction-slider-selected-track 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#ffffff80` | `#ffffff80` |
| `--color-annotation-selected-foreground` | component · 浏览器标注模式已选入口的文字色。 | text-annotation-selected 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#91c5ff` | `#91c5ff` |
| `--color-annotation-selected-surface` | component · 浏览器标注模式已选入口的透明背景色。 | surface-annotation-selected 仅引用对应内容或控件语义角色，保留原值与浏览器色彩空间。 | `#4795ff26` | `#4795ff26` |
| `--color-tooltip` | component · 提示的实色浮层底。 | surface-tooltip 仅引用对应语义角色，保留原值。 | `#f0f0f0` | `#2b2b2b` |
| `--color-tooltip-foreground` | component · 提示文字。 | text-tooltip 仅引用对应语义角色，保留原值。 | `#0d0d0d` | `#f8f8f8` |
| `--color-tooltip-tag` | component · 提示里快捷键标签的底。 | surface-tooltip-tag 仅引用对应语义角色，保留原值。 | `#e6e6e6` | `#363636` |
| `--color-tooltip-tag-foreground` | component · 提示里快捷键标签的文字。 | text-tooltip-tag 仅引用对应语义角色，保留原值。 | `#5c5c5c` | `#adadad` |
