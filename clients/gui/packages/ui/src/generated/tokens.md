<!-- Generated from tokens.json and src/theme.ts. Run pnpm --dir clients/gui --filter @areal/ui generate. -->
# @areal/ui Token 速查

写样式时按用途选这里的变量，不写字面量。数值只在 [tokens.json](../../tokens.json) 修改；调色板派生在 [theme.ts](../theme.ts)。

## 字号

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--ui-font-size` | `14px` | 界面默认字号；用户偏好可覆盖 |
| `--ui-font-weight` | `400` | 界面常规字重 |
| `--text-ui-xl` | `calc(var(--ui-font-size) + 4px)` | 区块标题 |
| `--text-page-title` | `calc(var(--ui-font-size) + 8px)` | 页面标题、空态大标题 |
| `--text-ui-lg` | `calc(var(--ui-font-size) + 2px)` | 输入框文字、卡片标题等较突出内容 |
| `--text-ui-base` | `var(--ui-font-size)` | 界面正文、卡片内容、普通反馈；在消息正文内被重映射为内容字号 |
| `--text-ui-caption` | `calc(var(--ui-font-size) - 1px)` | 按钮、菜单与紧凑标签 |
| `--text-content-caption` | `max(12px, calc(var(--content-font-size, 14px) - 1px))` | 执行摘要、状态等过程附注，跟随内容字号而非界面字号 |
| `--text-ui-sm` | `calc(var(--ui-font-size) - 2px)` | 说明文字、次要反馈、表格辅助列 |
| `--text-ui-xs` | `max(11px, calc(var(--ui-font-size) - 3px))` | 来源细节、元信息；最小 11px，不用于正文 |
| `--text-ui-2xs` | `calc(var(--ui-font-size) - 5px)` | 仅限工作流图轴面的例外刻度 |
| `--text-mobile-input-safe` | `16px` | 移动端聚焦输入的安全字号下限 |

## 行高与字重

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--line-height-ui` | `max(20px, calc(var(--ui-font-size) + 6px))` | 界面正文行高，随界面字号增长 |
| `--line-height-ui-sm` | `max(18px, calc(var(--ui-font-size) + 4px))` | 紧凑说明行高 |
| `--tracking-wf-label` | `0.09em` | 工作流图大写等宽微标签字距 |

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
| `--radius-control` | `10px` | 输入框、选择器、设置卡片等控件外框 |
| `--radius-button` | `8px` | 文字按钮与按钮式入口 |
| `--radius-inset` | `8px` | 容器内部的内嵌块：列表项、引用、图片视口 |
| `--radius-pill` | `999px` | 胶囊形：发送等主动作、标签、计数徽标 |
| `--radius-overlay` | `20px` | 大浮层与独立工作区：Worktree 设置、目录列表、定时任务 |
| `--radius-navigation` | `12.5px` | 导航项、侧栏行与拖拽预览 |
| `--radius-composer` | `22px` | 输入区外框 |
| `--radius-panel` | `12px` | 面板与分组卡片 |
| `--radius-dialog` | `16px` | 对话框 |

## 阴影

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--shadow-menu` | `0 0 0 0.5px var(--color-menu-border, var(--color-border)), 0 8px 16px -4px rgb(0 0 0 / 12%)` | 下拉菜单与右键菜单 |
| `--shadow-overlay` | `0 4px 12px rgb(0 0 0 / 10%), 0 14px 40px rgb(0 0 0 / 8%)` | Popover 与悬浮面板 |
| `--shadow-composer` | `var(--composer-shadow-light)` | 输入区外框阴影，暗色由调色板切换 |
| `--shadow-dialog` | `0 12px 32px rgb(0 0 0 / 20%)` | 对话框 |

## 状态色与语义色

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--color-button-surface` | `color-mix(in srgb, var(--color-foreground) 10%, var(--color-card))` | secondary 按钮的底色 |
| `--color-button-hover` | `color-mix(in srgb, var(--color-foreground) 14%, var(--color-card))` | secondary 按钮的悬停底色 |
| `--color-destructive` | `#e03131（暗色 #ff5c5c）` | 危险操作与错误；AReaL 明暗主题值 |
| `--color-destructive-foreground` | `var(--color-foreground-inverse)` | 危险底色上的文字 |
| `--color-warning` | `#e07b00（暗色 #ff8a30）` | 警告反馈；AReaL 明暗主题值 |
| `--color-warning-foreground` | `var(--color-foreground-inverse)` | 警告底色上的文字 |
| `--color-foreground-inverse` | `#ffffff（暗色 #000000）` | 强调底色上的反色文字；明暗主题各自取值 |
| `--color-ring` | `var(--color-input-border-focused)` | 键盘焦点环颜色，跟随强调色 |
| `--color-muted` | `var(--color-surface)` | 弱化区域底色 |
| `--color-muted-foreground` | `var(--color-foreground-subtle)` | 弱化区域文字 |
| `--color-success` | `#1e8a3e（暗色 #46bf72）` | 成功反馈；AReaL 明暗主题值 |

## 动效与层级

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--motion-fast` | `100ms` | 悬停、按下等即时反馈的过渡时长；减少动效时为 0 |
| `--motion-normal` | `160ms` | 展开、切换、浮层出现等常规过渡时长；减少动效时为 0 |
| `--motion-slow` | `240ms` | 面板、大区域位移等较长过渡时长；减少动效时为 0 |
| `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | 所有过渡的默认缓动曲线 |
| `--layer-dialog` | `50` | 对话框层级 |
| `--layer-popover` | `60` | 菜单、Popover 层级，高于对话框 |
| `--layer-tooltip` | `70` | Tooltip 层级，最高 |

## 其他

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--border-width-default` | `1px` | 描边、分隔线的默认宽度 |
| `--font-sans` | `-apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif` | 基础界面字体及平台回退 |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace` | 代码字体及CJK无衬线回退 |

## 调色板（由主题输入派生，用户可在外观设置中覆盖）

| 变量 | 默认亮色 | 默认暗色 |
| --- | --- | --- |
| `--color-background` | `#ffffff` | `#181818` |
| `--color-foreground` | `#1a1c1f` | `#ffffff` |
| `--color-brand` | `#3a83f7` | `#3a83f7` |
| `--color-file-reference` | `#2c67c5` | `color-mix(in srgb, #2c67c5 80%, #ffffff)` |
| `--color-process-settled` | `color-mix(in srgb, #1a1c1f 69.5%, #ffffff)` | `color-mix(in srgb, #ffffff 50%, transparent)` |
| `--color-result-card` | `color-mix(in srgb, #1a1c1f 3%, transparent)` | `color-mix(in srgb, color-mix(in srgb, #ffffff 9.090909090909092%, #181818) 50%, transparent)` |
| `--shadow-result-card` | `0 0 0 .5px color-mix(in srgb, #1a1c1f 8%, transparent)` | `0 0 0 .5px color-mix(in srgb, #ffffff 15.6%, transparent)` |
| `--color-result-icon` | `#ffffff` | `color-mix(in srgb, #181818 83.333333%, #000000)` |
| `--color-history-comment` | `#ffffff` | `color-mix(in srgb, #ffffff 9.090909090909092%, #181818)` |
| `--color-viewer-control` | `color-mix(in srgb, #1a1c1f 3%, transparent)` | `color-mix(in srgb, #ffffff 9.090909090909092%, #181818)` |
| `--color-history-comment-hover` | `#ffffff` | `color-mix(in srgb, color-mix(in srgb, #ffffff 12.987012987012987%, #181818) 96%, transparent)` |
| `--color-primary` | `#1a1c1f` | `#ffffff` |
| `--color-primary-foreground` | `#ffffff` | `#2d2d2d` |
| `--color-composer-action` | `var(--color-primary)` | `var(--color-primary)` |
| `--color-composer-action-foreground` | `var(--color-primary-foreground)` | `var(--color-primary-foreground)` |
| `--color-accent` | `color-mix(in srgb, #1a1c1f 6%, #ffffff)` | `color-mix(in srgb, #ffffff 6%, #181818)` |
| `--color-secondary` | `color-mix(in srgb, #1a1c1f 5%, transparent)` | `color-mix(in srgb, #ffffff 5%, transparent)` |
| `--color-user-message` | `#e8f3fe` | `#173e76` |
| `--color-user-message-text` | `#0c274a` | `#f6fafe` |
| `--color-background-win-alt` | `color-mix(in srgb, #1a1c1f 4%, #ffffff)` | `color-mix(in srgb, #ffffff 4%, #181818)` |
| `--color-shell` | `color-mix(in srgb, #1a1c1f 4%, #ffffff)` | `color-mix(in srgb, #ffffff 5.194805194805195%, #181818)` |
| `--color-navigation-background` | `color-mix(in oklab, #ffffff 70%, transparent)` | `color-mix(in srgb, #ffffff 2.5974025974025974%, #181818)` |
| `--color-navigation-selected` | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 10.38961038961039%, #181818)` |
| `--shadow-page-surface` | `0 0 0 .5px color-mix(in srgb, #1a1c1f 8%, transparent), 0 4px 16px #0000000d` | `0 0 0 .5px color-mix(in srgb, #ffffff 6%, transparent), 0 4px 16px #0000000d` |
| `--color-sidebar` | `color-mix(in srgb, #ffffff 70%, transparent)` | `rgb(40 40 40 / 0.7)` |
| `--color-sidebar-item` | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `rgba(255, 255, 255, 0.08)` |
| `--color-composer` | `color-mix(in srgb, #ffffff 86.4706%, transparent)` | `color-mix(in srgb, color-mix(in srgb, #ffffff 12.987012987012987%, #181818) 96%, transparent)` |
| `--shadow-composer` | `var(--composer-shadow-light)` | `var(--composer-shadow-dark)` |
| `--color-background-alt` | `color-mix(in srgb, #1a1c1f 3%, #ffffff)` | `color-mix(in srgb, #ffffff 3%, #181818)` |
| `--color-card` | `#ffffff` | `#181818` |
| `--color-settings-card` | `#ffffff` | `color-mix(in srgb, #ffffff 4.761904761904762%, #181818)` |
| `--color-header` | `#ffffff` | `#181818` |
| `--color-panel` | `#ffffff` | `#181818` |
| `--color-popover` | `#ffffff` | `#181818` |
| `--color-menu` | `color-mix(in srgb, #ffffff 90%, transparent)` | `color-mix(in srgb, color-mix(in srgb, #ffffff 9.090909090909092%, #181818) 90%, transparent)` |
| `--color-menu-border` | `color-mix(in srgb, #1a1c1f 8%, transparent)` | `color-mix(in srgb, #ffffff 8.2%, transparent)` |
| `--color-menu-hover` | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-composer-catalog` | `#ffffff` | `color-mix(in srgb, #ffffff 8.658008658008658%, #181818)` |
| `--color-input` | `#ffffff` | `#181818` |
| `--color-input-focused` | `#ffffff` | `#181818` |
| `--color-input-border` | `var(--color-border)` | `var(--color-border)` |
| `--color-input-border-hover` | `var(--color-border-hover)` | `var(--color-border-hover)` |
| `--color-foreground-subtle` | `color-mix(in srgb, #1a1c1f 69.5%, #ffffff)` | `color-mix(in srgb, #ffffff 69.5%, #181818)` |
| `--color-foreground-subtlest` | `color-mix(in srgb, #1a1c1f 49.5%, #ffffff)` | `color-mix(in srgb, #ffffff 49.5%, #181818)` |
| `--color-settings-secondary` | `color-mix(in srgb, #1a1c1f 69.5%, #ffffff)` | `color-mix(in srgb, #ffffff 65%, transparent)` |
| `--color-border` | `color-mix(in srgb, #1a1c1f 7.8%, transparent)` | `color-mix(in srgb, #ffffff 8.4%, transparent)` |
| `--color-border-hover` | `color-mix(in srgb, #1a1c1f 11.7%, transparent)` | `color-mix(in srgb, #ffffff 11.7%, transparent)` |
| `--color-hover` | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-selected` | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-surface` | `color-mix(in srgb, #1a1c1f 3%, transparent)` | `color-mix(in srgb, #ffffff 3%, transparent)` |
| `--color-surface-hover` | `color-mix(in srgb, #1a1c1f 5.5%, transparent)` | `color-mix(in srgb, #ffffff 5.5%, transparent)` |
| `--color-input-border-focused` | `#3a83f7` | `#3a83f7` |
