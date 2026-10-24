[中文](README.md) | **English**

# @areal/ui

Foundations, React components and component contracts for the AReaL GUI. A private workspace package, not published to npm. Consumers declare `"@areal/ui": "workspace:*"` and build this package first (GUI scripts already chain it).

## Usage

```tsx
import { Button, Select, Tooltip } from "@areal/ui";          // stable entry
import { ComposerActionButton, SettingsRow } from "@areal/ui/wip"; // experimental entry and domain compositions
```

The host uses React 19, Base UI and Tailwind 4. Import `@areal/ui/styles.css` (foundations and core component styles) and `@areal/ui/themes.css` (default light/dark palette) after Tailwind. Domain compositions import their own styles: `conversation.css`, `settings.css`, `workbench.css`, `worktree.css`, `notifications.css`.

| Looking for | Where |
| --- | --- |
| A variable's name, default value and purpose | [Token reference](src/generated/tokens.md) (generated) |
| Which components exist and which entry exports them | build output `dist/components.json`, `dist/llms.txt`, or the design site `design-system.html?ui-library` |
| When to use a component, its states, keyboard and rules | the Markdown contract next to the component |
| Order for choosing components and changing the system | [Agent guide](agent-guide.md) |
| Layer and maturity rules | [Components](../../../../design/components/README.md#分层) |

## Layers and maturity

`src/components` (core) holds general controls; `src/settings`, `src/conversation`, `src/workbench` and `src/worktree` hold domain compositions. Core cannot import other layers, and no component may import the renderer, Core, Node or Electron.

A core component used by three or more production files moves to the stable entry `@areal/ui`; domain compositions stay in `@areal/ui/wip`. `dist/components.json` lists the current members.

## Changing the system

1. Edit foundation values in [tokens.json](tokens.json) and palette derivation in [src/theme.ts](src/theme.ts). Update a component's Markdown contract together with its implementation.
2. Run `pnpm --filter @areal/ui generate`, then `build` and `check`. Generated files live in `src/generated`; do not edit them by hand.
3. From `clients/gui`, run `node scripts/design-system-audit.mjs` and `pnpm typecheck`, then verify the affected screens.

The host (renderer) keeps user preferences, business state, localization and execution wiring; see [D-004](../../../../design/decisions/004-local-ui-package.md).
