**中文** | [English](conversation-composer-command-model.en.md)

# 对话 Composer 命令模型与结构化上下文分阶段设计

本文把 Composer 的输入采集、提交命令和结构化上下文拆成两个边界：

- **命令**描述用户对某个 Thread 发起的意图；网络重试仍属于同一个命令。
- **上下文部件**描述随命令提交、可在历史中回显或只供本次模型调用使用的结构化内容。

第一阶段只迁移“对话引用（conversation quote）”。它已经有现行的 `conversationQuotes` Host 契约和历史投影，先把它纳入类型化命令模型，保持 wire 兼容，再用同一条链路迁移 Review comment、浏览器批注和 Skill。

## 命令边界

```ts
type ComposerCommand =
  | { kind: "send"; threadId: string; enqueue: boolean }
  | { kind: "steer"; threadId: string; expectedTurnId: string }
  | { kind: "queueEdit"; threadId: string; queueItemId: string; expectedRevision: number }
  | { kind: "sideSend"; threadId: string; sourceThreadId: string };
```

`send` 的 `enqueue` 是提交策略，不是另一种消息类型；`steer` 必须携带目标 Turn；队列编辑和 Side 发送不得通过布尔参数伪装成普通发送。

## 受理状态

| 状态 | 事实来源 | 本地输入 | 下一步 |
| --- | --- | --- | --- |
| `accepted` | Host/Core 受理回执 | 消费已捕获上下文，保留历史投影等待 | 等待 Turn/queue 结算 |
| `rejected` | 明确拒绝回执 | 保留草稿和上下文 | 展示错误，可再次提交同一命令 |
| `unknown` | 断连、超时或缺失回执 | 保留原命令 ID、草稿和上下文 | 只允许 `reconcile`，禁止自动重发 |
| `reconciled` | 原命令的 Core outcome | `accepted` 才消费；拒绝继续保留 | 回到空闲或错误态 |

规则：消费发生在明确 `accepted` 或 `reconciled(accepted)` 之后；`steer`、`enqueue`、Side 发送分别保留自己的目标身份和消费 owner。

## 结构化上下文部件

第一阶段的内部模型是：

```ts
type ComposerContextPart = {
  kind: "conversationQuote";
  text: string;
  sourceSessionId?: string;
  sourceRowId?: string;
};
```

提交适配器把它编码成现有 `conversationQuotes: Array<{text:string}>`，因此主会话、Side 和 Remote 可以先共享命令模型而不改变旧客户端的 wire 格式。Core 继续负责把引用投影到历史；后续阶段再增加带来源和可编辑元数据的持久化类型。

## 分阶段交付

1. **阶段一（本次）**：命令判别联合、提交适配器、conversation quote 垂直切片；覆盖 Host-compatible send/steer/queue 选择、accepted/rejected/unknown 消费规则，并保持旧字段兼容。
2. **阶段二（本次）**：把 Review comment 迁移为 `contextParts` 中的 `reviewComment` part；Host/Core 只在结构化字段中传递，历史回显直接按类型渲染。模型适配只在边界生成带标签的文本投影，用户历史保留原始结构。
3. **阶段三**：迁移浏览器批注、图片批注、Plugin intent 和 Skill；为每类部件声明 `persisted`、`modelProjection` 和 `editable`。
4. **阶段四**：主会话、Side、Remote 共用 command adapter；各入口只提供目标身份、权限和 UI owner，删除重复的消费与 UNKNOWN 编排。

## 验收入口

- `ComposerSubmission.test.ts`：普通发送、steer、enqueue、UNKNOWN 后不消费上下文。
- `ConversationComposer.test.tsx`：模型和上下文插槽仍由共享输入表面提供。
- Remote/Side journey：相同 quote 在三条入口产生相同 Host 参数和历史回显。
- Core/Host：现有 `conversationQuotes` 兼容测试保持通过；阶段二增加 `contextParts` schema、Host 转换与 Core history round-trip 测试。
