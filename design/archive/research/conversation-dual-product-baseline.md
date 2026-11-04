# AReaL / T3 对话与 Composer 第一份基线

## 结论与使用范围

这是一份**部分完成的行为基线及源码差异表**，不是两款产品的性能排行榜，也不是六条旅程全部通过的报告。合同见 [对话体验验收](../../../docs/development/conversation-reading-acceptance.md#双产品基线)。

本轮已观察到 T3 的已有会话中文草稿刷新恢复、切会话返回保留、Slash 菜单、Replay 表格展示及复制反馈。AReaL 采用此前修复后的隔离桌面证据，明确标为 `reused`。双方尚未消费相同素材，不能计算体验优劣总分、性能差值或操作成本差值。

最重要的可行动差异是附件恢复路径：T3 有已上传附件凭证复用机制；AReaL 普通文件刷新后保留元数据并要求重附。前者可能减少恢复操作，后者已有阻止缺失附件静默发送的证据。是否值得改变 AReaL 的持久化机制，需要先分别验证上传完成、上传未完成和凭证失效，不能从源码直接推导收益。

## 身份与证据等级

| 项目 | 固定身份 / 限制 |
| --- | --- |
| AReaL | `0e41110f67ef3e0103b67c4085fe674b9313aa33`；本轮仅增加验收合同与素材，未重新运行产品 |
| T3 | `2ad6712c6d8054f32de9e04df89bd659380f48a3`；原仓库 `pnpm-lock.yaml` 的用户修改未纳入基线 |
| T3 运行 | macOS 26.6.1 arm64、Node 26.12.1、Vite+ 1.4.0、Chrome Web、隔离 HOME 与数据；非 Electron 安装包 |
| T3 副本偏差 | Tailwind 自动扫描改为 `source(none)` / `@source "../src"`；server 文件恢复为固定提交原文。样式来源可能不完整，不能据此判定视觉或生产性能 |
| T3 观测方式 | Terra/CUA 人工操作；检查了即时截图，未保存截图文件或可重跑脚本。行为记录可用于确定下一轮范围，不能代替可复核截图/trace |
| AReaL 历史方式 | 源码 Electron、隔离 Core/Runtime、确定性本地模型；合成输入和文件注入，不代表原生选择器、物理 IME 或真实供应商 |

本地原始记录：

- T3：`.worktrees/conversation-baseline/.scratch/dual-product-baseline/RESULT.md`。
- AReaL 输入与阅读：`.worktrees/bug-feedback-diagnostics/.scratch/conversation-experience-followup/FIX-DESKTOP-RESULT.md`；其 `areal-gui-1iNnwY/manifest.json`、`run-long-fixed-02/measurements.json` 保存具体身份及样本。
- AReaL 图表：`.worktrees/bug-feedback-diagnostics/.scratch/content-reading/RESULT.md`；`desktop-final-9/manifest.json` 保存源码/产物身份、截图与下载记录。

这些路径相对主仓库，仅为本机证据索引，未提交生成文件、运行数据或个人配置。历史证据按各自产物哈希解释，不因当前 HEAD 包含修复就升级为当前构建实测。

## 六条旅程结果

| 旅程 | AReaL（reused） | T3（本轮观察） | 当前能下的结论 |
| --- | --- | --- | --- |
| B1 添加上下文 | 测试图片、粘贴文本、mention 的相关路径已验；原生 picker 未验 | UNVERIFIED：未添加附件；`@` 显示无匹配，未完成引用选择 | 尚无同起终点操作数；空目录无匹配不能判为缺陷 |
| B2 草稿往返与恢复 | 新/已有会话 reload 后待重附卡可见，缺失文件阻止发送；重附/移除后可发送；粘贴文本恢复 | 已有会话中文正文 reload、进入新会话再返回均保留；附件、光标、独立重开 UNVERIFIED | 正文恢复双方各有局部证据；附件恢复差异仍需 T3 实测 |
| B3 输入语义 | 合成 Chromium composition、Enter、undo、mention 已验；物理 IME UNVERIFIED | Slash 菜单可见；命令消费、IME、undo UNVERIFIED | 仅菜单出现不等于 Enter 语义通过 |
| B4 失败与重试 | Skill 真实读取失败后正文/标签保留且不请求模型，恢复后恰好一次发送；不外推全部丢回执边界 | UNVERIFIED：未注入失败 | 双方受理后丢回执须单独对照，不能用正常 Replay 替代 |
| B5 流式阅读与输入 | 80 段回复中回看选区/锚点、返回底部、30k 草稿插入完整性有证据 | UNVERIFIED：5.5 秒 Replay 完成后才输入，未形成并发样本 | T3 没有性能样本，禁止排名 |
| B6 图表结果使用 | 流式闭合图放大/缩放/平移、完成后持续打开及焦点返回；宽表复制/CSV 字节有证据 | 三行表格及 Markdown/CSV 菜单可见；点击后显示 Copied，但剪贴板读取为空；Mermaid UNVERIFIED | 复制反馈不算复制保真通过；三行表不覆盖宽长表 |

未测子项均为 UNVERIFIED，六条旅程没有任何一条因此获得双方完整 PASS。本轮未确认新的产品缺陷；启动失败是验收环境问题，剪贴板读取空是未解决的观测问题。

## 源码差异与下一步假设

以下 T3 路径相对其固定源码，AReaL 路径相对本仓库；它们是源码事实或待验证假设，均非运行通过声明。

| 领域 | T3 所有者 | AReaL 所有者 | 分类与验收问题 |
| --- | --- | --- | --- |
| 附件恢复 | `apps/web/src/composerDraftStore.ts`：`composerFileNeedsReattach`、`uploadedAttachmentId`、`uploadEnvironmentId` | `clients/gui/renderer/src/composerDraftAttachments.ts`、`ComposerAttachments.tsx` | 功能/恢复成本差异：上传完成与未完成分别刷新；检查引用凭证失效、实际请求字节和重附操作数 |
| 草稿写入 | `composerDraftStore.ts` 的延迟写入和卸载 flush | `clients/gui/renderer/src/composerDraftStorage.js` 的有界合并与生命周期 flush | 实现差异：计时参数本身不代表快慢；检查最后一个字、切会话、清空后不复活 |
| 编辑器 | `apps/web/src/components/ComposerPromptEditorTiptap.tsx`、`composer-rich-text-doc.ts` | `clients/gui/renderer/src/LexicalChatInput.tsx`、`mentions/promptSerialization.ts` | 实现差异：Tiptap/Lexical 都有输入语义与缓存；用 IME、撤销、引用中间编辑检验正确性 |
| 提交 | `apps/web/src/components/chat/useComposerSend.ts` 恢复前检查当前草稿 | `clients/gui/renderer/src/Composer.tsx`、`ComposerSubmission.ts` | 产品选择：乐观清空继续写与暂时 busy 各有代价；先验证迟到失败不覆盖新意图，再比较等待成本 |
| 流式阅读 | `apps/web/src/components/chat/timelineScrollAnchoring.ts`、`apps/web/src/markdown-incremental.ts` | `clients/gui/renderer/src/Messages.tsx`、`conversationReading/` | 机制不能替代结果：在同流速下检查人工阅读锚点、选区和列表规模增长 |
| 图表 | `apps/web/src/components/chat/MermaidDiagram.tsx`、`MarkdownTable.tsx` | `clients/gui/renderer/src/components/ai-elements/diagram-reader.tsx`、`clients/gui/renderer/src/components/ai-elements/markdown-table.tsx` | 双方有图形放大代码；表格菜单、独立预览/下载是能力组织差异。按发现入口、阅读细节、复制完整性逐项验证 |

## 性能账本

AReaL 历史 30,000 字符草稿、流式并发、20 次合成按键的 `keydown → 下一 rAF`：p50 6.75 ms、p95 13.2 ms、max 14.2 ms，观测窗口 longtask 为 0。原文与插入字符完整性已核对。系统负载约 14.66/16.13/15.56；Node 24.2.0 低于项目声明版本，构建保留警告。

这只是绘制前代理指标，**不构成合同 P1 的实际可见反馈通过**。T3 没有同口径样本；此前 AReaL 短稿、非流式长稿样本负载不同，也不能作修复前后性能对照。

素材生成器 `clients/gui/scripts/support/conversation-baseline.mjs` 提供双方可共用的输入、响应和逐文件哈希，但本轮 T3 使用官方 Replay，尚未接入这批素材。窗口尺寸、字号、主题、后台负载及构建模式没有配齐，操作数和打断数均留空，不补估算值。

## 如何提前拦截同类问题

| 风险 / 改动触发 | 最小反例 | 现有执行入口 | 当前缺口 |
| --- | --- | --- | --- |
| 附件恢复静默丢失 | 新/已有草稿添加文件，reload 后核对待重附、阻止发送、重新添加及正文完整 | `pnpm --dir clients/gui test:composer` | 进程重开、上传凭证失效和原生 picker 另验 |
| 输入缓存或延迟落盘损坏意图 | 30k 稿中间编辑、undo、mention、IME、切换会话；比较完整正文及受理次数 | Composer 单测、`test:composer`；现有长稿探针 | 长稿并发探针尚未成为通用 CI 门禁；物理 IME 保留人工测试 |
| 消息列表随历史增长变慢 | 固定正文与流速，只改变轮数/工具记录规模；测增长曲线而非单次耗时 | `conversationTurns.test.ts`、`test:conversation-reading` | 单测不能代替用户可见延迟；需同负载重复采样 |
| 故障夹具没打到运行边界 | 先取证当前 Host/Core 资源确实失败，再检查保留、恢复、唯一发送 | `test:composer`、`test:send-admission` | 逐个证明注入有效，不把超时直接算产品缺陷 |
| 图表结算时重挂载 | 流式围栏闭合时打开图，输出完成后继续缩放并关闭；核对复制/下载字节 | `test:content-reading` | 原生保存对话框、物理输入、安装包仍单列 |

以上是已有 runner 与验收合同的映射，不宣称本轮新增了全自动双产品 CI。建议后续按风险顺序补证：B2 附件恢复与 B4 提交失败优先；随后对齐 B5 输入/阅读负载；最后补 B6 同状态截图和操作成本。先补足可比较的证据，再决定产品改造，避免以参考产品的机制名称替代收益证明。

## 启动失败与收尾

保留首次失败：默认 Node 24.2 缺少所需 `import.meta.main` 行为；受限运行的 Node watch 报 EMFILE、`/bin/ps` 报 EPERM。提升权限后标准服务启动，页面仍在 Tailwind 扫描阶段长时间阻塞；代理报告内存峰值约 23 GB，未保存可复核性能 trace，不能归为 T3 生产性能结论。

限定样式扫描后进入界面，仅作为带偏差的 Web 行为观察。测试标签已关闭，本轮 dev 会话 Ctrl-C 退出 130 并记录 orchestration shutdown；代理报告 `requeuedEffects=1`，不将该回执解释为所有业务效果成功执行。

## 交付检查

共享素材生成器已实际执行：独立检查七个文件的字节数及 SHA-256、30,000 字符草稿、80 段初始正文、40 个增量、30 行表格和重复生成一致性，均通过。生成器格式检查、文档链接与语言配对检查、diff 空白检查通过。

本次改动只有合同、研究记录及测试素材生成器，未改产品实现，未重跑 AReaL 全量构建或桌面专项。T3 的上述局部行为是本轮观察，其余边界按矩阵保留。六旅程双产品完整验收、同负载性能和自动 CI 拦截尚未完成。
