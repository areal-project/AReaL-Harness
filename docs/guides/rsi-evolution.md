**中文** | [English](rsi-evolution.en.md)

# RSI Goal：反馈分叉与版本树

`/rsi-goal --html QUERY` 生成一个独立 HTML 页面；不带 `--html` 时保留 Markdown 行为。初始 baseline、structured、critic-and-revise 三个版本各自使用独立原生 Runtime 和写入范围。产物不超过 1 MiB，不自动写回项目。

## 操作闭环

1. 等待候选结算，在 GUI 读取产物并查看 Harness。
2. 在“评测反馈与版本分叉”填写反馈，点击“记录评测”。GUI 定性反馈标记为 `human-feedback-v1`；外部浏览器可通过 API 提交固定 rubric 的检查结果和证据引用。
3. 修改 Harness 并填写改动假设，点击“从此版本分叉”。新版本从最初冻结输入重新执行，不读取父产物，也不把父页面当成新输入。
4. 查看 Harness 版本探索树、回执与失败分支，再显式选择 winner。每轮原 winner 继续作为 incumbent，下一次选择可以保留它或替换它。

同目标冻结首次模型配置与工作区输入，轮次共享累计 token/活动时间预算。每次分叉 1–3 个版本，整个目标最多 12 个版本，父子深度最多 3。没有自动无限循环。预算耗尽或用量不完整时拒绝继续；改变模型、工具集和跨任务实验需新建目标。

原生候选的模型选择和 worker 会话共同消费首次 `EffectiveConfig`，包括供应商端点/协议快照、线程自定义采样与推理参数、Profile 和客户端选项；不会在后续轮次从当前目录重解默认值。此快照通过 Core 内部可信通道传入，不开放为模型可填写的任务字段。隔离 worker 仍强制 headless、清除交互预批准并继承当前部署的审批/拒绝边界。凭据仅保留引用，缺失时失败；Skill 引用固定版本，但资源正文仍遵循 Skill 指南的当前目录读取语义，不能据此声称冻结外部资源内容。

版本节点保存 `parentCandidateId`、`round`、完整 `harness`、`hypothesis`、`feedback` 和 `evaluations`。Core 快照是权威记录；`rsi/<goalId>/input.json` 与 `configuration.json` 保存冻结材料，候选 request 包含 `inputDigest`。重启恢复已完成树，不自动重派未完成候选。旧的第一阶段快照仍能读取；缺少冻结材料的旧目标拒绝分叉。

## 客户端与 API

GUI 支持读取、定性评测、单版本分叉、树和选择。TUI 支持 `/rsi-evaluate JSON_FILE` 和 `/rsi-evolve JSON_FILE`；JSON 文件仅包含该操作的业务字段，thread、goal、requestId、revision 由当前目标补充。批量分叉和外部评测使用 API，完整类型见 [Core API](../api/core.md)。

`areal/goal/evaluateCandidate` 接受 `candidateId` 和 `evaluation`。回执包含 rubricId、evaluator、taskId、artifactSha256、checks（布尔映射）、可空 score（0–100）、feedback、evidence（字符串引用列表）。Core 从原生产物计算哈希并核对；评分和引用由调用方提供，Core 不替调用方验证外部证据内容，也不把这些评分当成 Runtime 可信验证。

`areal/goal/evolve` 接受 parentCandidateId、feedback、variants。每个 variant 包含 label、hypothesis、完整 harness；新 Harness 必须不同于父版本，父版本必须已有完成产物和评测。两个写接口都接受 requestId、threadId、goalId、expectedRevision，支持持久收据去重和 revision 冲突拒绝。只重放同 requestId 的原请求，不在冲突后自动换 revision 重试。

## 网页真实验证

构建并显式配置真实模型后执行：

```bash
node scripts/rsi-web-live.mjs /absolute/model.toml /absolute/evidence
node scripts/rsi-web-live.mjs /absolute/model.toml /absolute/evidence /absolute/plan.json
```

脚本使用配置所引用的凭据环境变量，不含密钥；产生真实模型用量。它创建独立状态、工作区和用户 home，用真实 Core/native Runtime 生成 MOSS 网站。Playwright Chromium 检查桌面/手机溢出、筛选、收藏、预约、Escape 焦点、主题持久化、脚本错误和离线素材，保存截图、回执、产物、版本树投影和二进制哈希。plan.json 示例：

```json
{"parentCandidateId":"candidate-3","feedback":"browser feedback","variants":[{"label":"responsive-v1","hypothesis":"fluid widths prevent overflow","harness":"Build semantic HTML with fluid layout; inspect mobile width and keyboard focus before delivery."}]}
```

OUTPUT 下 `.private/` 含认证状态及私有日志，不能发布。公开证据只取 HTML、截图、rubric.json、*-browser.json、run.json、exploration.json 和 binary.json。页面功能通过率不能代表审美，也不能证明 Harness 跨任务泛化。跨任务提升需要独立留出题目和重复采样。

失败节点可以直接凭 Core 执行错误和显式反馈分叉；它没有成功产物，因此不伪造产物评测。`areal/goal/evolve` 可额外传 `tokenBudget` 显式追加累计上限，新上限必须大于旧值，累计消费不清零。GUI 分叉表单也提供此字段；未知用量仍拒绝继续。

网页 demo 驱动在 Core 之外运行浏览器 rubric，并按功能通过率调用显式选择接口；这不是 Core 内置的自动评分或自动 winner 策略。`scripts/rsi-exploration-report.mjs OUTPUT` 可将公开 Core 投影导出为可离线浏览的交互版本树。
