**中文** | [English](child-result-consumption.en.md)

# 子任务结果消费与收尾续轮

## 问题与对照

父模型已经从协调工具取得子任务终态并写出无工具回答后，`generation` 的 `child_results` 仍可能是空值。自动 join 得到完整汇总，与这个独立快照不同便续轮。工具读取与自动收尾没有共享已提供结果的状态，导致重复请求；多出的空响应还可能把原本可结束的 Turn 变成失败。

Standard122 的已见轨迹提供发现入口，不用于题目特判。103 个后续无工具样本只能说明存在收尾请求，不能证明全部都是无价值重写，也不能把其耗时全部写成修复收益。

| 实现 | 收尾和结果投递 | 可借鉴的边界 |
|---|---|---|
| Codex 0.163.0，官方提交 `83086188ae0614bd882818ff1aa23f3194962012` | `session/turn.rs` 合并模型 follow-up 与 pending input，再执行 stop hooks；`session/input_queue.rs` drain 邮箱，可将不触发 Turn 的通知延后；V2 `wait_agent` 等待邮箱活动 | 根据新输入决定续轮；等待与正文投递共享邮箱。旧 wait 接口仍可同时返回状态和完成通知，不声称所有版本绝无重复 |
| DSH 0.2.0-rc.2 发布包 | `dsh-agent-loop/lib/index.js` 无工具时 completed；next-step inbox 或 turn-stopping 钩子补入消息才继续。同步 subagent 通过工具返回结果；可持续子任务投递 settlement 消息并独立结算所有权 | 结果消费与生命周期结算分离，不能靠删除所有等待来减少请求 |
| 修复后的 AReaL | 保留 join；记录成功响应输入中已提供的可信终态版本，自动收尾仅在需要新结果时续轮 | 保留当前生命周期和资源门禁，在共享 Core 边界消除重复消费 |

Codex 来源：[主循环](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/turn.rs)、[输入队列](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/input_queue.rs)、[V2 等待](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)。DSH 来源为冻结制品中实际发布的 [agent-loop](https://www.npmjs.com/package/@deepseek-ai/dsh-agent-loop/v/0.2.0-rc.2)、[subagent](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2) 和 [tool-subagent](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent/v/0.2.0-rc.2)。以上是固定版本机制参照，不代表所有可选配置在原评测中启用。

## 修复方案与不变量

- 消费记录只属于一次父 `generate`，在 Core 内部维护；不新增协议字段、配置、全局提示、重试或预算。
- 以实际模型输入中的工具输出匹配本 Turn 唯一的调用 ID，并核验内置 `coordination` 后端、成功读取和已有子任务所有权。用户正文、同名外部工具、歧义调用 ID、丢失结构的投影不能确认消费。
- 旧 threadId 与共享 executionId 映射到子 Thread/Turn；比较终态、资源释放、错误、来源 Item、活动及有界首段。2/8 KiB 工具页和 1 KiB 自动汇总按同一 UTF-8 前缀比较，尾页不能替代未见首段。
- 响应成功完成后才确认消费，预检、断流和 steer 不提前确认。记录跨当前 Turn 的压缩保留，不把“已提供”解释成模型理解或任务通过。
- join 的完成顺序同步已消费子任务，仍等待必要的未完成兄弟任务。新的失败、报告和清理状态不能被旧结果覆盖；有省略项时保留原有汇总与回取流程。
- 相同自动子结果上下文按最近同类状态去重；不删除旧历史、不修改既有 provider reasoning。A→B→A 保留最后一次变化。

适用范围是原生子任务及统一 executionId 的共享执行。隔离 Workgroup 的候选验收、应用和交付结算不改动；旧研究 Agent 与跨 Turn TaskRun 生命周期不改动。无子任务请求直接跳过消费扫描。架构分层不变，实际行为同步到[多 Agent 设计](../../design/multi-agent.md)及 [Core API](../../api/core.md#agent-工具)。

### 与参考实现的对应关系

本次对齐的是续轮不变量：模型正常结束且没有尚需提供的新结果时，同一结果不再制造一次请求。Codex 的队列 `take_mailbox` / `drain` 和 DSH 的 next-step inbox 从投递入口消费消息；AReaL 同时保留工具读取和自动 join 两个入口，因此在父生成循环内记录可信结果版本。记录在响应被接受后更新，压缩保留消费事实，查询索引同时记录调用所属 Turn，避免对每条回执重复扫描本 Turn 历史。

生命周期策略仍有区别。Codex V2 可以把不触发 Turn 的子通知留到下一 Turn；DSH 将 inbox、owned children 和 disposal 分开结算；AReaL 继续在本 Turn 的既有 join、清理及交付门禁后发布最终回答。此修复没有复制整套邮箱协议，也没有让未完成子任务失去父任务所有权。主线已有的隔离执行回执去重保持原状，本次补齐共享原生子任务的消费状态。

## 验证

验证基线为主线 `cc2c977ecb772c18f1ede6dbe5bca27fb89af665`。回归使用真实 Engine 与确定性模型替身，测试文件为 [child_completion.rs](../../../core/engine/tests/child_completion.rs)；[child_completion_http.rs](../../../core/engine/tests/child_completion_http.rs) 经过实际 Chat Completions / Responses HTTP 编解码；内部输入可信边界位于 [agents.rs](../../../core/engine/src/agents.rs)。`ci` profile 保留调试断言，关闭调试符号和增量编译；这里不测量真实模型速度。

修复前的 12 个复现均实际出现 4 次主模型请求，预期为 3 次：两种身份接口 × read/wait/wait_any × 子任务完成/失败。多余请求故意返回空响应，检查最终 Turn 不会因此失败；修复不以增大恢复次数通过测试。

额外门禁覆盖未读结果仍需汇总、尾页不替代首段、超时后的失败、快慢兄弟任务、后续工具轮不重复追加汇总、压缩后的消费状态，以及不可信输入和状态变化。扩展集加入中断、空回复与断流恢复、重复读取、用户 steer、UTF-8 / JSON 转义、4/16 个子任务批次和最终轮预算，共 49 个参数场景。专门恢复场景显式启用一次既有恢复；产品默认重试和预算不变。验证检查模型请求数、输入内容、最终消息阶段和子任务终态，不仅检查输出文本。

将未修复主线的 `generation.rs` 代入同一扩展集，24 项测试中 20 项失败、4 项通过；恢复修复后，24 项连续 5 轮全部通过。未读结果、超时新结果及最终轮限制等有效续轮没有被一律删除。

| 检查 | 结果 |
|---|---|
| `cargo test --locked --profile ci -p areal-engine --test child_completion` | 24 项 × 5 轮通过，每轮覆盖 49 个参数场景；原 12 个复现的主请求由 4 次变为 3 次 |
| `cargo test --locked --profile ci -p areal-engine --test child_completion_http` | 4 项通过：两种 HTTP 协议 × 两种身份接口，实际请求均为父 3 次、子 1 次，父用量无重复计入 |
| `cargo test --locked --profile ci -p areal-engine --lib child_consumption` | 2 项通过，包含跨 Turn、歧义 ID、未知工具结果、版本变化与已消费状态保留 |
| `cargo test --locked --profile ci --workspace --no-fail-fast` | 本机 1048 项通过、5 项失败、14 项忽略；5 项子进程执行失败见下文。此运行未包含后来单独执行的 4 项 HTTP 回归 |
| `cargo build --locked --profile ci --workspace`；`cargo clippy --locked --profile ci --workspace --all-targets -- -D warnings` | 均通过 |
| `AREAL_UNIFIED_BIN_DIR=target/ci node scripts/unified-execution-smoke.mjs` | 真实 Core/Runtime 的并行隔离交付、取消清理、权限和重启恢复通过 |
| `cargo fmt --all -- --check`、差异空白及 `python3 scripts/check-docs.py` | 通过；189 个 Markdown 的链接与语言配对检查通过 |

完整测试按[开发指南](../../development/README.md)在测试子进程的 `NO_PROXY` / `no_proxy` 中保留既有条目并补充 localhost/127.0.0.1；全局代理配置未修改。5 项失败分别涉及模型代理、MCP 插件重启、OAuth 跨进程刷新及两项 MCP 代理检查；系统日志记录对应二进制的 AMFI `Unrecoverable CT signature issue`。直接复核相同 SHA-256 的原二进制仍失败，未修改签名或安全设置，不将其计为通过。原工作区的早期代理超时和中止日志同样保留。

测试替身的修订保持严格断言：旧单许可 fixture 现在接受两个终态已通过工具完整提供，仍要求两个结果都可见且子任务已结算；未读场景用信号量保证 spawn 尚未携带终态，避免把合法提前投递误判为遗漏。开发期的同步假设、回执字段缺失和依赖未准备失败均保留。额外执行的旧研究 Agent smoke 因 fixture 将无工具的会话命名请求当作工作请求而报 `KeyError('tools')`，未计为通过，也未为本次修复修改该旧入口。默认忽略的容量与额外原生集成未执行，不计为通过。

## 解释边界

确定性回归证明重复收尾的控制流修复。固定 fixture 的少一次模型请求不等于真实任务统一提速 25%，也不证明 122 题整体速度或成功率提高。原样本与同源变体属于开发集；未重跑真实模型或来源隔离确认时，不宣称通用能力提升。原失败、UNKNOWN、子任务用量及输出均保持原语义。
