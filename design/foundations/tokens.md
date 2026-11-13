# Token 来源与使用

`R-TOKEN-015` GUI 的基础值只有一个可编辑来源。写样式时按用途选变量，不写字面量；变量清单、默认值与用途见生成的 [Token 速查](../../clients/gui/packages/ui/src/generated/tokens.md)。用途怎样选见[基础表达角色](roles.md)。

## 每类值在哪里改

| 值 | 唯一可编辑位置 | 说明 |
| --- | --- | --- |
| 字号、行高、间距、控件高度、圆角、阴影、动效、层级、状态色 | [tokens.json](../../clients/gui/packages/ui/tokens.json) 的 `foundation` | 生成 `foundation.css` 与 Tailwind 映射；明暗不同的值写在 `$extensions.build.areal.ui.dark` |
| 浏览器焦点宽度与偏移 | [focus.css](../tokens/focus.css) | GUI 与本地 Web 共用，见 [D-002](../decisions/002-shared-semantics.md) |
| 产品专用主题别名（工作流图、终端色、轨迹色等） | [styles.css](../../clients/gui/renderer/src/styles.css) 的 `@theme` 与 `.dark` | 只放 @areal/ui 未定义的变量 |

修改流程：调色板角色与公式改 tokens.json，WCAG 算法维护在 theme.ts → `pnpm --dir clients/gui --filter @areal/ui generate` → `build` 与 `check` → 运行设计审计。

## 写样式时

- 字号用 `--text-ui-*` / `--text-page-title`（或 Tailwind 的 `text-ui-*`），这样会跟随用户设置的界面字号。阅读内容跟随内容字号，用 `--text-content-caption` 或消息正文里重映射过的 `--text-ui-base`。
- 圆角按表面用 `--radius-*`：控件、按钮、内嵌块、胶囊、浮层、导航、输入区、面板、对话框各有一个。
- 颜色用语义变量（`--color-foreground`、`--color-border`、`--color-destructive` 等），不写十六进制或 Tailwind 色板类。
- `R-TOKEN-018` 组件内部可以局部重映射变量（例如消息正文把 `--text-ui-base` 指向内容字号），不能在全局主题选择器里重新定义 @areal/ui 已生成的变量。

## 容易选错的角色

- 主要动作：审批主动作与发送共用 `--color-primary` / `--color-primary-foreground`；`--color-composer-action` 是同一配对的别名。强调色 `--color-brand` 只用于链接与焦点。
- 设置说明：活跃设置标签的说明用 `--color-settings-secondary`，不借用禁用透明度或已完成过程的颜色。
- `R-TOKEN-019` 过程附注与对话：对话时间线用 `--text-conversation` / `--conversation-line` / `--conversation-gap`（跟随内容字号）；按钮、菜单等控件文字用 `--text-ui-*`（跟随界面字号）。两种字号偏好不能合并。

## 自动守卫

[design-system-audit](../../clients/gui/scripts/design-system-audit.mjs) 在 `pnpm --dir clients/gui verify` 中运行，包含：

| 检查 | 失败时的含义 |
| --- | --- |
| Token 单源 | renderer 的 `@theme`、`:root`、`.dark`、`.theme-*` 重新定义了 @areal/ui 生成的变量；改 tokens.json |
| `R-TOKEN-022` 字面量基线（[literal-baseline.json](../../clients/gui/design-system/literal-baseline.json)） | 某个文件写死的字号、颜色或圆角比基线多；改用变量。每项保留字面量必须有原因和退出条件；更新前校验缺项、重复和旧项，保留已有说明。数量减少后同步清除对应旧说明，并运行 `node clients/gui/scripts/design-system-baseline.mjs --write` 锁定新上限 |
| 增量检查 | 本次改动新增了字号或颜色字面量，见[增量设计检查](../../clients/gui/design-system/automation.md#增量设计检查) |

## 阅读内容的字号

文件阅读器等长文阅读表面的正文用 `--text-conversation`，标题用 `--text-content-h1`…`--text-content-h4`，全部跟随内容字号；14px 时标题为 24/20/18/16px。

## 有意保留的字面量

以下位置不跟随界面字号，留在基线中：`:root` 的 `font-size: 16px`（rem 基准）；远程与移动配对界面（`remote.css`、`MobileSettings.css`，按手机尺寸设计）；以及没有对应角色的 10/15/20/23/28px。新增角色时先在 tokens.json 定义，再替换这些值。

## 平台映射

| 角色 | GUI | 本地 Web |
| --- | --- | --- |
| 主要与次要内容 | `--color-foreground`、`--color-foreground-subtle` | `--text`、`--muted` |
| 成功、警告、错误 | `--color-success`、`--color-warning`、`--color-destructive` | `--success`、`--warning`、`--error` |
| 选择与强调 | `--color-brand`、`--color-selected` | `--accent` |
| 焦点 | focus.css + `--color-ring` | focus.css + 浏览器控件 |

DTCG 是 tokens.json 的格式；扩大到 Web 共享数值源，等出现第二个运行消费者时再决定。
