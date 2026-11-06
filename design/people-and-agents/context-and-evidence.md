# 上下文与证据

## 参考内容的来源

`R-CONTEXT-002` Side Chat 的历史参考是创建时固定的快照。允许读取工作区时，文件观察反映当前工作区。两者可能对应不同版本，界面需要保留来源区别。

`R-CONTEXT-003` 能定位并核对的历史选区可以作为确认引用。无法确认的用户引文保留其文本，但声明的来源标识不能证明来源真实。

`R-CONTEXT-004` 来源推进后，旧快照仍然有效地记录过去内容。界面提示其时间边界。来源状态无法读取时，不把旧引用标为最新。

## 把讨论带回主任务

`R-CONTEXT-007` 确认时核对讨论与目标归属，并防止同一次插入重复追加。来源已推进时提示旧快照。目标失效或改变时保留预览供复制。

带回操作改变草稿，不提交消息，也不引导正在执行的轮次。这样用户可以将讨论结论与主任务当前意图一起检查。

## 上下文容量与实际用量

`R-CONTEXT-008` 上下文估算描述模型输入的预计占用。实际用量描述已发生的请求消耗，不能互换。

`R-CONTEXT-009` 模型容量、用户预算和输出预留分别约束可用空间。显示占比时说明依据。缺少估算或容量时保留缺失状态，不补成零。

`R-CONTEXT-010` 会话、服务实例或生效配置改变后，旧读数不能作为当前上下文。读取与展示的绑定条件由现有实现维护。

## 契约与 GUI 绑定

[桌面 API](../../docs/api/desktop.md) 维护 Side 快照、引用、带回和上下文读取。[委派设计](../../docs/design/multi-agent.md#所有权与结算) 维护子结果的消费记录。

[SideChatPane.tsx](../../clients/gui/renderer/src/SideChatPane.tsx) 与 [side-bring-back.js](../../clients/gui/renderer/src/side-bring-back.js) 绑定预览、目标核对及草稿追加。[ContextMeter.tsx](../../clients/gui/renderer/src/ContextMeter.tsx) 与 [contextUsage.ts](../../clients/gui/renderer/src/contextUsage.ts) 绑定容量表达和读数归属。
