# Base 设计系统 beta

<!-- BEGIN GENERATED: base -->

候选 ID：`desktop-core`；版本：`0.4.1`；状态：`candidate`。

来源快照：待最终验收后记录；冻结与兼容所有者：[design-system/base.md](../design-system/base.md)。

完整准入归 [registry.json](registry.json) 的 `baseCandidate`。

### 成员准入

| 成员 | 合同 | 证据ID |
| --- | --- | --- |
| Button | [合同](../packages/ui/src/components/button/button.md) | E-CONTROLS, E-PLUGINS |
| ActionButton | [合同](../renderer/src/components/ui/action-button.md) | E-CONTROLS |
| Switch | [合同](../renderer/src/components/ui/switch.md) | E-CONTROLS, E-PLUGINS |
| Select | [合同](../renderer/src/components/ui/select.md) | E-CONTROLS |
| Feedback | [合同](../renderer/src/components/ui/feedback.md) | E-CONTROLS, E-PLUGINS |
| SettingsPage | [合同](../renderer/src/settings/SettingsPageParts.md#settingspage) | E-SETTINGS |
| SettingsSection | [合同](../renderer/src/settings/SettingsPageParts.md#settingssection) | E-SETTINGS |
| SettingsGroupCard | [合同](../renderer/src/settings/SettingsPageParts.md#settingsgroupcard) | E-SETTINGS |
| SettingsRow | [合同](../renderer/src/settings/SettingsPageParts.md#settingsrow) | E-SETTINGS |
| SettingsSelect | [合同](../renderer/src/settings/SettingsPageParts.md#settingsselect) | E-SETTINGS |
| SettingsSegmentedTabs | [合同](../renderer/src/settings/SettingsPageParts.md#settingssegmentedtabs) | E-SETTINGS, E-PLUGINS |
| SettingsDisclosure | [合同](../renderer/src/settings/SettingsPageParts.md#settingsdisclosure) | E-SETTINGS, E-PLUGINS |
| DecisionCard | [合同](../renderer/src/DecisionCard.md#decisioncard) | E-DECISION |
| ApprovalRequest | [合同](../renderer/src/DecisionCard.md#approvalrequest) | E-DECISION |
| CollapsibleText | [合同](../renderer/src/CollapsibleText.md) | E-DECISION |
| Messages | [合同](../renderer/src/Messages.md#messages) | E-CONVERSATION, E-RECOVERY |
| TurnProgress | [合同](../renderer/src/Messages.md#turnprogress) | E-CONVERSATION |
| TurnExecution | [合同](../renderer/src/Messages.md#turnexecution) | E-CONVERSATION |
| ToolEvent | [合同](../renderer/src/Messages.md#toolevent) | E-CONVERSATION |
| SettingsSearchInput | [合同](../renderer/src/settings/SettingsSearchInput.md) | E-PLUGINS |
| SettingsDialog | [合同](../packages/ui/src/settings/settings-dialog/settings-dialog.md) | E-SETTINGS |
| EmptySettings | [合同](../packages/ui/src/settings/settings-dialog/settings-dialog.md) | E-SETTINGS |
| SettingsNavigation | [合同](../packages/ui/src/workbench/settings-navigation/settings-navigation.md) | E-SETTINGS |
| ComposerSurface | [合同](../packages/ui/src/conversation/composer-surface/composer-surface.md) | E-CONVERSATION |
| CommandDetails | [合同](../packages/ui/src/conversation/command-details/command-details.md) | E-CONVERSATION |
| TaskContext | [合同](../packages/ui/src/conversation/task-context/task-context.md) | E-CONVERSATION |
| ActivityGroup | [合同](../packages/ui/src/conversation/activity-group/activity-group.md) | E-CONVERSATION |
| ActivityRow | [合同](../packages/ui/src/conversation/activity-row/activity-row.md) | E-CONVERSATION |
| ImageDisclosure | [合同](../packages/ui/src/conversation/image-disclosure/image-disclosure.md) | E-CONVERSATION |
| SubagentPanel | [合同](../packages/ui/src/conversation/subagent-panel/subagent-panel.md) | E-CONVERSATION |
| ThinkingStatus | [合同](../packages/ui/src/conversation/thinking-status/thinking-status.md) | E-CONVERSATION |
| ComposerToolbar | [合同](../packages/ui/src/conversation/composer-toolbar/composer-toolbar.md) | E-CONVERSATION |
| AttachmentCard | [合同](../packages/ui/src/conversation/attachment-card/attachment-card.md) | E-CONVERSATION |
| MarkdownBlockquote | [合同](../packages/ui/src/conversation/markdown-blockquote/markdown-blockquote.md) | E-CONVERSATION |
| MarkdownUnorderedList | [合同](../packages/ui/src/conversation/markdown-list/markdown-list.md) | E-CONVERSATION |
| MessageCodeBlock | [合同](../packages/ui/src/conversation/message-code-block/message-code-block.md) | E-CONVERSATION |
| MarkdownSurface | [合同](../packages/ui/src/conversation/markdown-surface/markdown-surface.md) | E-CONVERSATION |
| NativeContent | [合同](../packages/ui/src/conversation/native-content/native-content.md) | E-CONVERSATION |
| QuestionCard | [合同](../packages/ui/src/conversation/question-card/question-card.md) | E-DECISION |
| WorkbenchShell | [合同](../packages/ui/src/workbench/workbench-shell/workbench-shell.md) | E-SETTINGS |
| SidePaneFrame | [合同](../packages/ui/src/workbench/side-pane-frame/side-pane-frame.md) | E-CONVERSATION |
| SidePaneLauncher | [合同](../packages/ui/src/workbench/side-pane-launcher/side-pane-launcher.md) | E-CONVERSATION |
| TaskTitleOverflowText | [合同](../packages/ui/src/workbench/task-title-overflow/task-title-overflow.md) | E-SETTINGS |
| MemoTaskItem | [合同](../packages/ui/src/workbench/task-list-item/task-list-item.md) | E-SETTINGS |
| ResourceScope | [合同](../packages/ui/src/workbench/resource-controls/resource-controls.md) | E-RESOURCES |
| ScheduledWorkspace | [合同](../packages/ui/src/workbench/scheduled-workspace/scheduled-workspace.md) | E-SETTINGS |
| WorktreePicker | [合同](../packages/ui/src/worktree/worktree-picker/worktree-picker.md) | E-SETTINGS |
| WorktreeStatus | [合同](../packages/ui/src/worktree/worktree-status/worktree-status.md) | E-SETTINGS |
| WorktreeDirectory | [合同](../packages/ui/src/worktree/worktree-directory/worktree-directory.md) | E-SETTINGS |
| WorktreeSettings | [合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md) | E-SETTINGS |
| WorktreeWorkspace | [合同](../packages/ui/src/worktree/worktree-workspace/worktree-workspace.md) | E-SETTINGS |

证据见 [Base索引](base-evidence.md)。

### 验收条件

完整准入条件归 [registry.json](registry.json) 的 `baseCandidate.acceptance`。

### 边界

范围与限制归 [registry.json](registry.json) 的 `baseCandidate.limits`。冻结历史验收不能由当前生成索引扩张。

<!-- END GENERATED: base -->

## 使用与变更

`R-BASE-004` 删除已准入成员或改变已准入行为，需要提升 Base 版本并迁移消费者。新增验证夹具或补充同一合同的证据不提升版本，也不能悄悄改写已冻结快照的验收范围。新公共成员必须先有真实生产消费者、就近合同、有限变体和状态、可重复检查与可归属运行证据。未在成员表中的生产组件继续由原所有者维护。

0.3 与 0.4 的输入快照和迁移回归边界见[冻结记录](../../../design/archive/gui/base-candidate-history.md#03-与-04-的迁移记录)；当前候选的准入范围仍归上方 registry 索引。
## 复验入口

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
pnpm --dir clients/gui test:design --conversation-exercise
```

设置组合的挂载前提见 [SettingsPage 生产上下文](../packages/ui/src/settings/settings-page/settings-page.md#生产上下文)。

## 候选快照的探索题

固定输入与早期候选修订见[候选实验历史](../../../design/archive/gui/base-candidate-history.md#候选快照的探索题)。
