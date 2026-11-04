# AReaL / T3 对话与 Composer 双产品基线

## 本产品发送稳定性：复现与最小改造

按范围收敛，本轮先修输入/阅读的具体失效路径；不以 T3 为正确答案，也不将以下结果外推为编辑器全面改造。架构决策已写入[发送稳定性合同](../../../docs/development/conversation-reading-acceptance.md#发送稳定性的所有权与验收)：正文属于编辑器/提交快照，受理属于 Core/Host，布局与滚动属于既有阅读宿主。当前只有三处具备失败证据并进入产品修复，均复用现有所有者：

| 现象与因果证据 | 最小改造 | 修复后结果 |
| --- | --- | --- |
| 冷首次单行，原生窗口 bounds 固定；pending 先显示 loading，高60.016→36.016px | `message.tsx` 的保留换行正文在 lazy 等待时直接显示原文，使用相同 class/行高、不加 loading padding | 真实 Electron 同场景每帧直接有原文，高度固定36.016px；仅改这一处后16px位置跳仍在，证明两类原因独立 |
| draft preview 气泡 y92，创建后正式阅读区 y76；两布局顶部48px与32px不一致 | `Worktree.css` 的新聊天预览与 `workbench.css` 消息列共享 `--message-reading-inset`；只调整消息预览，不改变 worktree 进度区 | 真实冷首发 y75.5–76，变化≤0.5px；原生bounds固定 |
| 生产壳fixture三行原文先高76.047，Markdown加载后高116.078；DOM为 `br` 加换行且 p 为pre-wrap | 正式Markdown由br表达换行，并在现有解析链移除其后附加的序列化换行；保留pre-wrap与原文连续空格 | 三行高固定76.047；真实热第二次多行Enter同样固定；Composer仅一次68.047→40收缩 |

八场景fixture：首次/第二次 × 单行/多行 × 点击/Enter，动作前取样并保存事件 marker；检查每个pending帧文字可见、气泡高度及同消息位置变化≤1px、输入区不反向增长。既有 receipt-first/snapshot-first 与图片交接断言继续执行。首轮红证 `areal-send-continuity-qHoDEP` 捕获24px；生产壳红证 `areal-send-continuity-LRhUHb` / `06e8bl` 捕获多行40px；最终绿证 `areal-send-continuity-ukhDE7`。目录均位于本机系统临时目录，完整路径见任务输出。fixture为生产组件受控回执，不是原生桌面证据。

真实桌面证据根仍为本记录的 `.scratch/dual-product-baseline-v2/`：`send-layout-01/02` 修复前，`03` 仅loading修复，`04/05` 完整修复；分别保存renderer每帧rect、原生bounds约8ms采样、截图和Host停止回执。最终 `send-layout-06/07` 冷首次多行点击521帧、热第二次多行Enter177帧；原生bounds均为(560,206,1440,900)。新Core部署身份见 `deployment-merged.json`，源码基点 `f563883ba37dc359de38cd0c1a6fcdd1f167df8b` 加 owned diff，具体产物/源码差异哈希见每轮manifest。

边界：只证明列出的合成输入和本地确定性模型路径；复杂Markdown首次转换、物理输入法、安装包及所有用户第二次发送情境仍需各自证据。已有会话发送中锁编辑、草稿存储异常隔离、宽snapshot订阅是明确的后续设计风险；此次没有因源码推测扩大为编辑器替换、持久化改造或通用状态框架。

## 第二轮：同素材实测

按用户收敛决定，双产品完整补测和排名暂停，当前优先本产品发送稳定性。保留以下已完成证据。

本轮将六条旅程落实到真实产品的客户端/服务边界，用本地确定性供应商替代真实模型。结果是**可复核的部分验收和问题清单**，不是六条旅程所有子项全部 PASS。物理输入法、原生文件选择器、真实供应商、安装包及实际屏幕呈现仍未验；不能把源码 Electron 或 Chrome 的结果外推到这些边界。

### 主要结论

- T3 的受理后丢回执是最高优先级反例：服务已接受原命令，UI 恢复同文草稿，手动重试生成新命令并产生第二次模型请求。同一会话的服务回执、模型请求和两条消息相互印证；不是用前端计时器模拟的失败。
- T3 的 30k 草稿发送会裁掉末尾一个换行，中间文字和换行完整。按逐字节合同记 FAIL，产品解释为首尾 trim 规则差异，不表述为随机丢字。AReaL 的对应两轮供应商请求保留全部 30k 字符与 25 个插入字符。
- T3 在重开后可复用已经保存的文件/图片，且发送字节匹配；AReaL 普通文件恢复为待重新添加，明确阻止不完整上下文发送。这是恢复操作成本差异，不能仅凭是否持久化附件判定安全性或总体体验。
- 双方均有流中回看、选区保留和图形结算连续性的证据。输入样本存在明显轮间波动，且运行壳、主题与后台负载不同，暂不做快慢排名。

### 固定身份与边界

| 项目 | 身份与限制 |
| --- | --- |
| AReaL | 产品源码基点 `edcaaecbc9f44cbe6dc775df7a6a575ac96e1d2f`；本轮 owned diff 为测试/文档。Core SHA-256 `2585d5db9b73b6f5ac5693bdcb8e6c5afbc48f87330b2defa4d82936212738b4`；renderer inputHash `596dbcefcb44e5ff93189b5ababfebcf96d894b05accde9bdddb7abbafeddeeb`；各轮 manifest 保存完整产物和脚本哈希 |
| T3 | 固定 `2ad6712c6d8054f32de9e04df89bd659380f48a3` 隔离副本，原仓用户修改未纳入；生产 `vp build`；Replay 入口接共享 ACP 供应商，Tailwind 扫描限制为 `source(none)` 与 `@source "../src"`，其余原产品路径保留。样式可能不完整，不能称原版视觉验收 |
| 运行环境 | macOS 26.6.1 arm64；AReaL Electron Chromium 152.0.7977.167，T3 Chrome 156.0.8078.74 / Node 26.12.1；1280×800 CSS px。AReaL 暗色、DPR 2；T3 初始两轮浅色。系统有其他任务运行 |
| 公共负载 | 同一 `baselineContent`：30,000 字草稿，80 段初始回复，40 块/100ms 增量，8 列30行表格及 Mermaid；ACP/SSE 对等测试核对全部输出块。最终请求文本独立核对，不用 DOM 去换行后的内容替代 |
| 调用隔离 | 首次 T3 启动继承环境，自动标题意外启动 Claude CLI，是否发出网络请求 UNKNOWN，原日志仅留本机。随后使用净化环境、隔离 HOME、系统 PATH，仅本地 Replay。后续真实 CLI 专项仅使用显式 Codex CLI |

证据根相对主仓库为 `.worktrees/conversation-baseline/.scratch/dual-product-baseline-v2/`。截图/日志和合成会话数据不进 Git；本报告、可执行驱动和素材进入版本控制。旧数据仍按旧产物解释，合并到新 HEAD 不升级为新构建证据。

### 六旅程覆盖账本

| 旅程 | AReaL 本轮 | T3 本轮 | 剩余边界 |
| --- | --- | --- | --- |
| B1 上下文 | `test:composer` 覆盖文件/图片/粘贴文本及引用路径，缺失附件阻止提交 | 一次多文件注入后有标签/图片；真实请求附件引用与图片哈希一致；@note 菜单可见 | 原生 picker；双方相同起终点操作成本；T3 引用选择及发送 |
| B2 草稿恢复 | 新/已有草稿刷新恢复正文和待重附元数据；重附/移除解除阻塞；粘贴文本恢复 | A/B 导航、reload、关闭浏览器进程重开保留 A 的正文/文件/图片；恢复后发送哈希匹配 | AReaL 独立重开；光标位置；T3 URL 导航不等于侧栏点击 |
| B3 输入语义 | 当前 `test:composer` 通过合成 IME、Slash、Mention 等断言 | 合成 composition Enter 不发送、随后主动 Enter 恰好一次请求；Slash/Mention Enter 不提交；Shift+Enter 与撤销已观察 | 物理 IME；每项菜单消费和实际受理次数分别记证据，不整体打 PASS |
| B4 失败与重试 | 受理后丢回执独立子项 PASS：原dispatch回执、requestId、完成快照、reload后唯一消息且不可重发；专项整体仍 FAIL 于随后既有合成IME注入等待超时 | 受理前失败可恢复并一次重试；受理后丢回执再发送 **FAIL**，同会话两次执行 | 接口故障与网络故障机制不同；不把局部证明外推全部恢复路径 |
| B5 阅读及输入 | run09/10 及修复后 run11 每组25次，实际流式重叠、锚点/选区检查、回末尾及供应商30k+25字符均 PASS | prod03/04 同负载；锚点/选区检查通过；最终末尾换行 trim 导致严格保真 FAIL | 实际 paint、连续每帧锚点、长历史规模增长；后台负载未统一 |
| B6 图表使用 | rich01 流中打开 Mermaid、完成后持续打开、表格 Markdown复制保真 PASS | 流中一次点击打开 Mermaid、结算持续、Escape 关闭；两次点击复制表格，3568字节匹配 | AReaL 本轮缩放/平移/CSV未重验；T3补测缩放1081.59→1622.40px、横向拖动270.5→420.5px、Escape后焦点在消息容器、CSV2959字节精确匹配；横滚/表头未验 |

### 同负载输入样本

单位 ms，`keydown → MutationObserver` 和 `keydown → 下一 rAF` 分别是 DOM 与绘制前代理，均不是实际画面呈现。每组25次，65ms 间隔；分位数采用 `sorted[ceil(p*n)-1]`，不合并轮次掩盖异常。

| 产品/轮次 | 负载 | DOM p50 / p95 / max | rAF p50 / p95 / max |
| --- | --- | --- | --- |
| AReaL 09 | 短稿空闲 | 0.6 / 0.7 / 2.0 | 1.4 / 201.6 / 271.3 |
| AReaL 09 | 30k 空闲 | 2.6 / 3.4 / 3.6 | 6.3 / 16.9 / 17.7 |
| AReaL 09 | 30k 流中 | 1.9 / 2.7 / 2.7 | 8.5 / 17.0 / 17.1 |
| AReaL 10 | 短稿空闲 | 0.5 / 0.7 / 1.6 | 1.3 / 1.5 / 4.6 |
| AReaL 10 | 30k 空闲 | 2.4 / 2.8 / 3.4 | 6.1 / 16.5 / 16.8 |
| AReaL 10 | 30k 流中 | 1.7 / 2.3 / 2.6 | 5.9 / 17.0 / 17.3 |
| AReaL 11（修复后） | 短稿空闲 | 0.6 / 0.8 / 1.9 | 1.5 / 13.5 / 16.0 |
| AReaL 11（修复后） | 30k 空闲 | 2.5 / 3.4 / 3.5 | 6.6 / 16.4 / 17.6 |
| AReaL 11（修复后） | 30k 流中 | 1.9 / 2.4 / 2.5 | 4.8 / 12.1 / 16.4 |
| T3 03 | 短稿空闲 | 1.2 / 2.1 / 2.6 | 4.7 / 8.5 / 10.2 |
| T3 03 | 30k 空闲 | 3.5 / 4.4 / 4.5 | 6.8 / 8.4 / 9.0 |
| T3 03 | 30k 流中 | 2.7 / 3.2 / 3.3 | 5.1 / 7.3 / 7.9 |
| T3 04 | 短稿空闲 | 1.5 / 3.5 / 3.5 | 7.9 / 14.4 / 15.5 |
| T3 04 | 30k 空闲 | 4.0 / 5.1 / 5.8 | 8.1 / 13.4 / 16.1 |
| T3 04 | 30k 流中 | 3.6 / 4.7 / 4.9 | 8.3 / 14.0 / 15.6 |

AReaL 09/10 两轮1分钟系统负载分别19.95和24.23，修复后11轮为7.67；09短稿 rAF 尾延迟必须保留，尚不能归因具体产品机制。T3 按键窗内长任务为0，但大稿准备/替换阶段出现约2.8–10.1秒长任务；这些不能归为逐键延迟，也值得后续用真实粘贴动作和浏览器性能 trace 单独定位。两边采用同一内容和节奏，但非完全同环境、严格交替实验，因此只报告观测值，不计算性能优劣百分比。

### 可重复执行与提前拦截

- `test:conversation-baseline-provider` 已登记测试 manifest：真实 stdio/HTTP 对等、gate 及标题/预测请求隔离；不是 UI 通过证明。
- `conversation-dual-product-areal.mjs`、`conversation-dual-product-rich-areal.mjs` 复用源码桌面 fixture，保存源/产物身份、输入原样本、实际供应商文本、截图及停止回执。每轮新目录。
- `conversation-dual-product-t3.mjs`、`conversation-dual-product-t3-functional.mjs` 为手动外部产品驱动；不接常规 CI，不自动修改 T3。T3 准备需隔离固定提交、依赖和生产构建、独立服务状态及 Replay 适配；全部准备偏差显式记录。
- 持久化/编辑器改动跑 `test:composer` 与长稿探针；提交/恢复改动跑 `test:send-admission` 并检查受理权威回执；图表改动跑 `test:content-reading` 与共享富内容探针。现有 runner 保留正确断言，禁止把结果未知自动判未受理再发送。
- 当前未自动覆盖的物理输入法、原生选择器、真实画面及跨环境性能，维持独立人工验收项。新增脚本存在或类型检查通过不算完成双产品验收。

### 原始证据索引与失败保留

- 最终发送稳定性：`SEND-STABILITY-RESULT.md`、`continuity-final/`、`send-layout-06/07/`；修复后输入回归 `areal-run-11-final/`。
- AReaL：`areal-run-{09,10}/` 的各组 JSON、`measurements.json`、`provider.jsonl`、`environment.json`、`manifest.json` 与 `host-stop.json`；富内容 `areal-rich-01/`。
- T3：`t3-review/RESULT.md`、`metrics.json`、`boundary-filtered.json`、`boundary-receipts.json`、截图总览；`t3-context-rich/` 的表格与附件字节；`t3-prod-{03,04}/` 全量时序。
- 保留此前启动/编译失败、首次 B2 fill 覆盖内联文件的夹具失效、第一次 B4 重试未命中的失败及所有 AReaL 早期轮次。旧脚本采样与最终受控脚本重跑分别注明，不能以语法检查替代重跑。T3最终功能runner在准备阶段按范围收敛中断退出130；性能runner最终版未重跑。AReaL B4在修复首发loading后补跑，`send-admission-dVr7lo` 命中真实受理后丢回执，独立断言通过；整体在随后pass场景合成IME等待失败，不计全通过。双方测试进程已停止，补测细项见本机RESULT。

## 第一轮记录（历史，以下不代表当前覆盖）

### 结论与使用范围

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

## 发送稳定性提交检查

最终 owned diff 的正文渲染单测11项、GUI类型检查、设计系统检查和478份文档的链接/语言配对检查通过。设计静态检查无新增例外；交互与视觉证据按生产组件夹具和真实Electron分层记录。检查使用Node 24.2.0，低于项目声明版本，保留engine警告。发送专项整体的合成IME超时仍为未解决项，不能以局部受理断言或其他专项通过替代。
