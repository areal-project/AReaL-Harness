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
