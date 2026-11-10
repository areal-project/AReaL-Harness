# Shared main conversation, Side and panels

Chinese: [shared workspace](shared-workspace.md). The [surface contract](../../../../clients/gui/design-system/surfaces/shared-workspace.json) combines I-INPUT, I-OBSERVE, I-READ and I-RETURN. Related settings retain P-SETTINGS and existing preference ownership.

ComposerSurface owns editor/toolbar presentation, finite default/compact layouts and basic model-trigger styling. ChatPromptEditor forwards surfaceLayout; App explicitly selects compact for the main Composer/DraftComposer below a full resource view. Side stays default. An ancestor Panel selector must never change another editor. Compact reflow uses its actual composer-dock container; existing editor scrolling and mounted draft identity remain.

In narrow compact containers, the editor and toolbar stack vertically and the model trigger has a bounded width, keeping Send reachable with long drafts.

ConversationComposer remains a workbench business composition for model catalogs and reasoning effort. Main and Side share model names, effort labels and selection menus without a separate inheritance label or option. An untouched Side draft displays the source main conversation's configuration; explicit selections and created Side conversations display their own configuration. This display fallback is not submitted as draft configuration: Core still inherits from the anchor when the first question omits a model. Shared presentation does not merge main/Side draft keys, service/source identities, configuration, permissions or submission authority. SidePane owns window-local tabs/view selection; App retains return/focus. Native web, terminal and MCP App resource owners remain independent. Side uses Feedback for existing errors/bring-back messages without changing requestId, submissionUnknown or retry semantics. Settings reuse SettingsPageParts.css, real SettingsPage and portal SettingsDialog; shared components own their finite control variants.

Production CSS and normalized appearance overrides own values. The registry indexes roles/owners; no second numeric table or runtime page DSL is introduced. Static audit covers only its named migrated files.

The preview uses production WorkbenchShell for surface and transparency context instead of copying background styles. Returning from settings follows App's opening-control focus and draft restoration; settings may remount the editor and does not promise the same DOM identity as panel layout changes.

## Repeatable checks

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
node clients/gui/scripts/design-system-smoke.mjs --shared-workspace
make gui-build
AREAL_CORE_BIN=/absolute/verified/areal node clients/gui/scripts/conversation-derivation-smoke.mjs --shared-workspace
```

The browser exercise composes production ConversationComposer, SideChatPane, SidePane and SettingsDialog. Local actions do not accept/execute tasks. It checks split/full layout, long model labels, menu dismissal, tab revisit, separate drafts and representative light/dark/font14/18 conditions. The full catalog retains actual GeneralSettings local persistence/remount and stylesheet-order regression; exercise-local settings values are not persistence evidence.

The bounded Electron route reuses the isolated derivation runner, real Core/Runtime and deterministic local model. A real source command remains active while Side submits; alternate models affect only Side. Main/Side drafts survive split/full/menu/settings return and the source command finishes independently. This flag does not execute the complete restart/UNKNOWN-injection matrix. --baseline only captures the frozen old layout and cannot establish new-version acceptance.

Old/new runs match task, window, theme and typography while retaining separate events/recordings. Generated IDs, timers and unrelated asynchronous notifications differ. Functional and visual judgments remain separate. Earlier settings/conversation evidence is preserved; the previous conversation design is not automatically user-approved by this passing route. Real providers, physical IME, native notification delivery, packages, other OSes and complete resource/recovery lifecycles remain outside this slice.
