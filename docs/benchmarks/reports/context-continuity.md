**中文** | [English](context-continuity.en.md)

# 上下文连续性与持久化验证

## 问题与修复

长任务的后续修订不能只保存在有损摘要里。旧投影只原样保留最初用户消息，后续要求越过 checkpoint 后会依赖摘要；摘要遗漏或降级可使任务继续执行旧目标。本修复从持久历史按顺序重放所有真实用户输入，排除有明确 Turn origin 的自动续轮首项，保留该 Turn 后续 steer。摘要没有更改用户要求的权限，也不会生成另一份推测的“当前合同”。父任务必须显式传递相关修订给已有子任务，不能自动把整个父任务变成子任务的新范围。

压缩先模拟实际历史投影，仅在可净缩减时请求摘要；检查近期保留和最大完整前缀两个边界，避免对每个轮次重建长历史。有效摘要按实际净缩减空间接受到 16 KiB，8,000 字节仅为生成建议。内部控制和重试不再使用 user 角色，降级证据不嵌套旧 DEGRADED 摘要。摘要等待期间收到 steer 时，提交阶段使用当前历史比较压缩前后大小，避免把新用户输入误报为压缩膨胀。

可选 target token 与摘要推理/输出参数见[配置](../../guides/configuration.md)。默认不更改求解参数。压缩事件记录生成长度、允许长度、降级原因及投影用户数量。取消只给已打开流一秒尾部计量收尾，不执行输出工具；未返回用量仍是 UNKNOWN，不能借机清零预算或自动重放。

## 参考实现与取舍

调查固定以下源码，而不是根据产品名称推断行为：

| 来源 | 观察 | 本次采用与边界 |
|---|---|---|
| [Codex compact.rs，b741e480](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact.rs) | 独立收集真实用户消息，区分摘要消息，重建压缩历史；本地路径有用户消息 token 预算和截断元数据 | 采用从原始历史恢复用户要求。Harness 选择不静默截断用户输入，因此用户原文本身很大时仍可能无法缩减；不是无限上下文承诺 |
| [OpenCode compaction.ts，907b3bc5](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/compaction.ts) | 按预算保留近期对话，过滤已完成压缩控制对；overflow 可重放用户消息；自动继续有 synthetic/metadata 标记，旧工具输出有保护窗口及裁剪门槛 | 采用来源区分、完整近期分组、净缩减检查；不照搬动态裁剪已发送工具输出，以免破坏本 PR 的追加前缀及 Responses reasoning 关联 |
| [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction) | 提供服务端压缩能力 | 当前网关不声明支持该契约，因此本 PR 不默认切换到远端 opaque compaction，也不以文档代替实际兼容验证 |

持久化继续使用现有原子快照协议，不在此修复中迁移为增量日志。相同字节只编码一次，用于容量检查和写入；去掉重复深拷贝和直接向未缓冲文件逐片 JSON 写入。执行前意图持久化、文件 fsync、rename、目录 fsync、UNKNOWN 恢复边界不变。新增计时区分意图提交、工具执行、投影、最终提交，以及编码、IO 准入、写入和同步。

模型配置登记表另保留原始 JSON 字节，校验原字节的摘要，避免新增可选字段在解码补默认值后使旧 revision 失效。新指纹省略未设置的摘要参数和关闭的 WebSocket。四种登记格式（旧版、显式 false、显式 null 摘要参数、已配置摘要参数）均验证连续两次重载及篡改拒绝，已有 Turn 引用不重写。

## 验证方法

真实模型脚本：`node scripts/context-live-smoke.mjs /absolute/model.toml`。它创建独立工作区，进行真实读取、写入和命令验证；下发五项修复要求，随后以独立用户消息更改其中一项，三次手动压缩并触发自动压缩，重启 Core，最后由 Goal 生成交付文件。验收方独立核对全部 JSON 字段、随机 nonce、求和结果、已验收文件字节不变及实际命令成功。修复合同没有另存工作区文件来绕过模型历史。

本次使用 gpt-6-sol，求解 low，最终候选摘要 low/4096；测试专用 byte window 20,000、recent 4,096、target 16,000。小窗口刻意制造压缩，不作为生产配置建议。测试不是 Golden 游戏批次重跑，也不证明游戏验收通过。

确定性回归覆盖：有效 8,027 字节摘要、多次遗漏/无效摘要、修订顺序、中文输入、自动续轮中的 steer、摘要期间追加长输入、重启恢复、不可净缩减、过大近期区、目标余量、摘要参数与 Goal cap、尾部 usage 与 UNKNOWN。原生 Harness smoke 覆盖真实 read/patch/command、工具 hooks、强杀恢复和禁止重放。

结果见同目录 [JSON 证据](context-continuity-results.json)。所有尝试均保留：首次缺少凭据、第二次测试凭据返回 401，均未完成模型任务；第一条 Responses 任务实际完成但验收脚本误将成功的 verify_command 排除，修正验收后重核原制品并保留原失败记录。最终脚本同时认可真实成功的 run_command 和 verify_command。

最终完整运行均通过全部制品检查，未知用量为零：

| 协议 | Turn | 压缩 | 工具 | 请求 | 输入 tokens | 缓存 tokens | 命中率 | 秒 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| chat-completions | 7 | 6 | 19 | 27 | 206935 | 119552 | 57.77% | 165.9 |
| responses | 7 | 7 | 18 | 28 | 212487 | 107264 | 50.48% | 220.2 |

## 性能与范围

在开发机 `/data` 文件系统上，用 debug profile 的 9,399,322 字节线程快照对照三次，旧路径为 4,495.5 / 4,537.5 / 4,408.5 ms，新路径为 857.2 / 843.0 / 847.2 ms；中位耗时下降约 81.2%，约 5.3 倍。每次核对文件字节完全一致。该测试包含编码、clone、文件写入/fsync，不含排队、rename/目录 fsync，不等于端到端或所有 read_file 的加速比，也不能据此单独断言生产慢的全部根因。

复现：`TMPDIR=/data/your-test-directory cargo test --locked -p areal-engine --lib persistence_encoding_benchmark -- --ignored --nocapture`。不以时间阈值作为 CI 断言。工具阶段日志开关见[测试指南](../../development/testing.md#真实上下文连续性验证)。

频繁压缩会重建缓存前缀；本测试缓存率含冷启动和摘要，不能与此前无压缩的稳态 A/B 直接比较，不能宣称达成 99%。未压缩轮次的追加前缀仍由既有 Chat/Responses 回归约束。

## 部署与外部问题

仅更新 PR，不重启 Golden 作者、修改其已授权预算或清除 UNKNOWN。新二进制应在停稳边界以原 Goal/工作区/账本迁移；已有丢失修订会从保留的原始用户历史重新进入投影，但游戏事实仍需独立复验。

Studio 的 512 行日志尾诊断、按线程误关联取消、30 分钟评审 wrapper 和归档扫描位于外部仓库，本 PR 没有修改它们。消费者应依据完整账本及请求 owner/时间关联诊断，优先采纳已绑定终态和有效报告，未完成时有界续跑原会话。浏览器 launcher 应使用独立短临时目录并做真实相对鼠标/焦点验证；本 PR 不扩大 Runtime 文件权限来绕过环境限制。安全取消豁免、无限轮次等生产候选分支能力也不能据本 PR 的 Core 修复推断已全部合入。
