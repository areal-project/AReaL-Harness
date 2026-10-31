**中文** | [English](browser-automation-evaluation.en.md)

# 浏览器自动化的测量与方案比较

## 测量边界

浏览器自动化分为模型选择工具、Core 权限与回执、原生执行和用户展示。分别记录成本，不能用一层的改善推导整体 Agent 提升。可重复命令与成功判据见[浏览器测试指南](../../development/browser-testing.md#浏览器自动化基准)，原始基线摘要见[基线报告](browser-automation-baseline.json)。

确定性 Core 模型按夹具发出固定调用，因此其请求数只表示工作量。原生导航基准直接调用生产 `CorePreview.prepare/execute`，省略模型与真实 Core 权限循环。普通页面与固定延迟图片页面都要求真实文档 GET、资源 GET、正确 URL 和独立 DOM 标记。图片可以在导航返回后完成，验证等待单列，主指标为导航准备与执行耗时。

首轮原生计分样本每组 5 次。普通 command 导航中位数约 130 ms，固定 2 秒慢图片约 2131 ms。顶层导航两组约 6 ms。Core 的 29 个计时场景与 33 个功能检查通过。此结果定位了等待语义与展示表面的成本，没有比较四个产品的总体速度，也没有验证真实模型策略收益。

## 固定版本与机制

| 项目 | 固定版本 | 可参考的机制 | 不能直接推导的结论 |
| --- | --- | --- | --- |
| ZCode | `3c5b227649371507ddc4eb46ac5133afe6db1cab` | backend capability manifest、locator 与受控 CDP、会话归属、不确定副作用 | AReaL 已导入该版本执行器；重复导入不会解决当前导航等待。 |
| ego-lite | `12407167f84a58af24044f072868051952131491` | 显式导航 lifecycle、提交事实、超时携带 committed 与 late-effects 信息 | 公开 SDK 可审计，浏览器引擎闭源；供应商性能数字不是本项目结果。 |
| T3 Code | `c8a606c7b73e1e3586d5c06f76c69525f2d4c679` | typed 工具、带代次 Ref、每 tab 控制 epoch、固定 host lease | 单步 act 不自带观察；snapshot 在不发送图片时仍采 PNG，不能视作天然低成本。 |
| Cindy | `7d7473c62d17b0a893fa503d8a42e35c34ae02d1` | 可选 afterSnapshot、结果分页、声明式 recipe、按 session 选目标 | 不同 backend 的 freshness 与并发不同；recipe 失败不证明前序写入未发生。 |

ZCode 的 [导航执行器](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/main/browserView/browserCommandPageHandlers.ts) 正常路径仍等待 `loadURL`。其 [Browser API manifest](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/browser-client/manifest.ts) 根据后端能力裁剪接口。AReaL 已有同版本的原生 DOM、locator、iframe、截图与录制执行器，兼容范围由 `packages/browser-automation/UPSTREAM.json` 和实际验收共同决定。

ego-lite 的 [导航实现](https://github.com/citrolabs/ego-lite/blob/12407167f84a58af24044f072868051952131491/package/ego-browser/src/driver/page-waits.ts) 区分 commit、DOMContentLoaded、load 和 networkidle，并保存本次 loader 提交事实。其 [公开边界](https://github.com/citrolabs/ego-lite/blob/12407167f84a58af24044f072868051952131491/AGENTS.md) 明确浏览器闭源。可采用公开协议设计，不能声称已经验证其引擎算法或迁移收益。

T3 的 [SessionControl](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/server/src/preview/SessionControl.ts) 在接管时递增 epoch，阻止旧排队动作，并等待运行中动作收敛。[Broker](https://github.com/pingdotgg/t3code/blob/c8a606c7b73e1e3586d5c06f76c69525f2d4c679/apps/server/src/mcp/PreviewAutomationBroker.ts) 固定环境、会话和聊天的 host，超时不重放可能已执行的动作。AReaL 已有 Core/Host/Page/control 代次和 UNKNOWN，采用这些边界不要求迁入另一套 Broker。

Cindy 的 [afterSnapshot](https://github.com/makecindy/cindy/blob/7d7473c62d17b0a893fa503d8a42e35c34ae02d1/packages/lizi-mcps/src/browser/tools.ts#L1238-L1268) 保留原动作成功，将后续观察失败单独返回。它可能节省模型往返，内部仍是两次 runtime 调用。[结果缓存](https://github.com/makecindy/cindy/blob/7d7473c62d17b0a893fa503d8a42e35c34ae02d1/packages/lizi-mcps/src/browser/result-cache.ts) 在 session 内有界保留原文，分页读取不重新执行命令。两项应在模型任务基准中独立评估。

以上比较来自固定提交源码与公开主源校验。T3 与 Cindy 的上游 main 已移动，固定版本不代表最新 main。本项目没有运行四个产品的同任务性能对照。

## 候选选择与实验门

Astra 的设计决策采用现有所有者内的局部收敛。当前测量直接指向导航完成条件和绘制表面，四个项目的源码没有证明替换引擎能解决这些慢点。统一模型工具契约、动作后观察与新 Host 属于各自独立的候选，不与本轮导航实验合并。

| 候选 | 收益假设 | 采用条件 |
| --- | --- | --- |
| 沿现有所有者统一导航完成语义 | command 避免等待不影响交互的慢资源 | 相同可读页面、一次请求、取消与 UNKNOWN 语义通过独立回归。 |
| 导航不申请绘制专用背景表面 | 避免创建临时窗口与固定展示等待 | 隐藏页 readiness、后续输入与截图、隐私判断、焦点和接管均保持正确。 |
| 统一模型工具契约与动作后观察 | 减少能力误用和模型往返 | 真实模型任务证明成功率不降，收益超过发现、观察与结果传输成本。 |
| 替换 Host 或引擎 | 提供当前所有者无法满足的能力 | 先证明必要能力缺失或现有边界无法修复，并以相同任务、权限和环境确认收益。 |

每轮只改变一个机制。冻结 workload、脚本、资源延迟、viewport 和 oracle，通过固定旧版工作树交替运行 A/B。每侧至少 5 次，报告中位数、范围、完整错误和工作量。默认速度门为目标成功任务改善至少 20% 且超过波动。任何成功任务降为失败、UNKNOWN 或未运行均拒绝候选。导航、表单、拒绝后副作用、Ref、接管与 UNKNOWN 使用现有质量门。

模型工具契约的调整另按[评测方法](../methodology.md)准备来源隔离的任务。单一生成器的多个 fixture 不构成多个独立来源，确定性模型也不能证明真实模型更容易选择正确工具。

## 已验证的局部结果

| 独立轮次 | 计分目标 | 变更前中位数 | 变更后中位数 | 下降比例 |
| --- | --- | ---: | ---: | ---: |
| H1 | 固定慢图片下 command 导航返回 | 2139.24 ms | 124.35 ms | 94.19% |
| H2，相对 H1 | 普通 command 导航返回 | 130.86 ms | 8.78 ms | 93.29% |

每轮每侧 5 个独立进程，每进程每场景 1 个计分样本和 1 个预热样本，旧版与候选交替执行。每轮 40 个计分场景、40 个预热场景通过；独立恢复 4/4、完整 Core 29 个计时场景与 33 项检查通过。GUI 类型检查、69 个浏览器契约测试通过。对照入口的微小负向差量与异常值完整保留在 [H1 报告](browser-automation-h1.json) 和 [H2 报告](browser-automation-h2.json)。

H1 统一本次文档可交互完成语义。H2 只让 navigate 免去绘制表面，保留页面隐私检查；输入、截图与录制继续使用需要的渲染路径。图片仍实际请求并完成，未提交导航仍为 UNKNOWN，原生接管与停止加载不重放请求。

native-v1 曾在 DOM ready 与服务器收到首个图片请求之间提前检查。native-v2 有界等待资源请求出现与响应完成，计分的 prepare/execute 区间没有增加等待。两侧使用同一修订版本重新测量，没有续用中止的半组成绩。恢复探针的早期尺寸假设和未完成收敛假设亦有失败原始记录，修正后重新运行。首次基线、失败、中止和所有后续尝试由本地 `.scratch/browser-hillclimb/decision.tsv` 关联。

这些是本地原生阶段的改进。Core 使用固定调用的模型夹具，仅作为质量门；未测整体任务速度、真实模型 token 成本、真实供应商、安装包、物理输入或其他系统。宿主 Node 24.2.0 低于 GUI 声明范围，实际 Electron 测量使用 Node 24.22.0。下一轮模型工具契约与动作后观察应使用真实模型任务基准，不能沿用本轮性能数字作结论。
