**中文** | [English](README.en.md)

# @areal/ui

AReaL GUI 的基础值、React 组件和组件合同。私有 workspace 包，不发布 npm；消费者声明 `"@areal/ui": "workspace:*"`，先构建本包再构建消费者（GUI 脚本已串联）。

## 使用

```tsx
import { Button, Select, Tooltip } from "@areal/ui";          // 稳定入口
import { ComposerActionButton, SettingsRow } from "@areal/ui/wip"; // 实验入口与领域组合
```

宿主使用 React 19、Base UI 与 Tailwind 4，在 Tailwind 之后导入 `@areal/ui/styles.css`（基础值与 core 组件样式）和 `@areal/ui/themes.css`（默认明暗调色板）。领域组合各自导入样式：`conversation.css`、`settings.css`、`workbench.css`、`worktree.css`、`notifications.css`。

| 要找什么 | 去哪里 |
| --- | --- |
| 某个变量叫什么、默认值、用在哪 | [Token 速查](src/generated/tokens.md)（生成） |
| 有哪些组件、该从哪个入口导入 | 构建产物 `dist/components.json`、`dist/llms.txt`，或设计站 `design-system.html?ui-library` |
| 某个组件何时用、状态、键盘、规则 | 组件同目录的 MD 合同 |
| 选组件和改系统的顺序、常见误区 | [Agent 指南](agent-guide.md) |
| 分层与成熟度规则 | [组件与组合](../../../../design/components/README.md#分层) |

## 分层与成熟度

`src/components`（core）放通用控件；`src/settings`、`src/conversation`、`src/workbench`、`src/worktree` 放领域组合。core 不能导入其他层，组件不能导入 renderer、Core、Node 或 Electron。

core 组件在 3 个及以上生产文件使用后进入稳定入口 `@areal/ui`；领域组合留在 `@areal/ui/wip`。当前成员以 `dist/components.json` 为准。

## 修改

1. 基础值改 [tokens.json](tokens.json)，调色板派生改 [src/theme.ts](src/theme.ts)。组件改实现时同改旁边的 MD 合同。
2. `pnpm --filter @areal/ui generate` → `build` → `check`。生成产物在 `src/generated`，不要手改。
3. 在 `clients/gui` 运行 `node scripts/design-system-audit.mjs` 与 `pnpm typecheck`，再验证受影响的页面。

宿主（renderer）继续拥有用户偏好、业务状态、本地化与执行接线；取舍见 [D-004](../../../../design/decisions/004-local-ui-package.md)。
