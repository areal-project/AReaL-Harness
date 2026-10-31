# T3 Code 优先项实施与测量结果

范围来自[功能对比与推荐](t3code-comprehensive-comparison.md)中的「优先」「先测」，去重后共 30 项。新增 H01 对应用户取消普通历史加载按钮的要求。后续与暂缓项继续按原推荐安排。

本报告记录当前实施和测量结果。逐项证据包含生产组件、真实 Electron/Core、受控外部边界和本机测试包，覆盖范围分别说明。最终独立审阅31/31 PASS，No Flags。原29项审计沿用，两项新增证据由独立增量审阅闭合。

## 功能与交互

本次源码交付包含模型搜索收藏、文件夹引用、逐附件上传状态、持久时间线事实、文件定位与文档预览、工作区详情及浏览器视口。最后一项本地提交为 `bde68b0d`；全部提交留在本地。

| ID | 功能 | 当前结果 |
| --- | --- | --- |
| I01 | 本地工作区目录拖入引用 | 真实 Chromium backed File 经 preload 进入当前工作区目录引用；外部目录拒绝；迟到验证不跨线程；零 media 上传。 |
| I02 | 长文本行内、折叠和附件显示区分 | 短粘贴不拦截；超过 200 字符或至少 5 行形成 pasted-text；折叠卡明确进入正文；真正 File 卡进入附件流程。 |
| I04 | 逐附件准备/上传/失败与回执复用 | 普通附件实际 Core 部分失败后跨线程返回，只重试失败件，以原成功回执单次发送；send 响应丢失核对原线程；upload UNKNOWN 不重传。MCP 稳定 entry/owner 身份与释放由实际 submitMessage 回归覆盖。 |
| I05 | 跨供应商模型搜索和收藏 | 跨 provider 同名搜索、收藏 reload 持久化、键盘选择及重开当前 provider 通过。 |
| C01 | 中断事件分隔行和真实停止原因 | 生产 Messages 在无工具轮次也显示 interruption 分隔行，区分 userPause/coreRecovery；真实浏览器 fixture 通过。 |
| C02 | 自动重试当前次数/等待/恢复/耗尽 | 按 logicalId 归并重试，等待/次数/恢复/耗尽由 Core trace 事实和生产 UI 展示共同覆盖；运行时内层失败不会提前显示终态耗尽。 |
| C03 | 按受理结果提供安全恢复动作 | 只有匹配原 requestId/method/target 的 operation 才能解释回执；缺失原 operation 仍 UNKNOWN。实际丢 send 响应恢复不增加上传或 send，上传 UNKNOWN 保留草稿。 |
| C04 | 持久模型变更源目标及下轮生效 | 连续 default→b→c 记录持久化，重启后重放 receipt 不重复事件，effort-only/错误 revision 不追加，下一轮实际请求模型 c；UI 显示源目标与下轮生效。 |
| C05 | 主消息悬停及焦点时间/完整时间提示 | 用户/助手 createdAt 由 Core 保存并经事件/重启保留；生产 UI 的键盘聚焦完整日期提示通过，旧无时间历史不造时间。 |
| C06 | 发送后本轮用户消息近顶部锚定/让出控制 | 真实Composer首发与历史中续发距顶32px及31.92px。用户上滚后后续流增加，scrollTop持续0。两轮400delta、权威全文和两次主请求精确匹配。normal/reduced motion组件各8帧锚点稳定。 |
| L01 | 文件路径加行号重复定位及worktree绑定 | 真实生产文件组件定位 120/220 行，同文件重复 220 再居中；冒号/hash 文件名不误解析；owner 包含执行 root，资源 action/fileOpen 注入 threadId。实际包请求证明 worktree 同名文件归属。 |
| L02 | 文件树揭示/滚动/返回原搜索 | 外部定位清当前搜索/changedOnly，等待目录再 scrollIntoView，保留原搜索入口；隐藏树定位后再打开也选中正确路径。 |
| W03 | 详情卡打开当前执行工作区 | 详情按钮携带当前 threadId 和 path=. 到现有 fileOpen。上轮直接 CUA 观察 Finder URL 与真实 execution worktree 一致。 |
| W04 | 环境工作区分支Changes与审查入口 | 真实 worktree 资源卡显示环境、执行目录、分支、Changes；Changes 打开同线程审查。 |
| B01 | 浏览器设备预设/宽高/旋转 | 完整 GUI 手机/旋转/平板/连续自定义宽高/auto 通过；实际 native 为 240×2560，底部像素正确，980px 窄窗及 GUI zoom 1.25 记录存在。 |
| B02 | 浏览器加载错误/权限拒绝/未知动作及合法恢复 | 实际加载 ERR_UNSAFE_PORT 提供当前页 reload，权限拒绝保留原因且无 reload；真实 Core navigation_timeout 保持 UNKNOWN，检查和取消保草稿，原 action 保留，显式新发送继续一次。 |
| F01 | 只读PDF内嵌/外部打开 | ad-hoc ZIP 解压包真实 PDF 双页/125%/重开/损坏提示通过；同名损坏项目根与有效 worktree PDF 区分；包内 worker 200 且关闭退出。源码保留原外部打开入口和 thread contextualFileOpen。 |
| F02 | CSV TSV表格/源码/有界显示 | 包内 CSV 表格与源码切换通过，生产 fixture TSV 通过；解析器限 200 行/100 列并显示 truncated 提示，现有边界单测覆盖。 |
| F03 | 独立Mermaid图形/源码 | 独立 Mermaid 文件在真实包中显示 SVG 及源码，复用既有 renderer；错误语法 fixture 保留源码。 |
| D01 | Diff树/正文/范围切换阅读位置 | 暂存、未暂存、branch/ref 与真实 fs_create 轮次独立恢复范围、筛选、文件和正文位置。两个turn alpha/700与beta/1200往返一致。 |
| D02 | 评论选区/删除/带回输入/版本过期 | 真实鼠标选 R1–2/L1–2 保存评论，删除后者，前者进入 Composer；刷新新 token 后显示原版本评论并脱离新 diff 行；实际发送保留旧 snippet/base/head/token 和采集时版本提示。 |
| H01 | 正常历史分页不显示加载更早消息按钮，显式上滚自动读取并保持阅读位置 | 中英文Electron无普通加载更早按钮。多次短列表输入、独立失败Retry、可信CDP触摸取消后无残留读取、真实滚动条恰一页，阅读连续性14项通过。 |

## Worktree 合入情况

当前交付分支为 `codex/popup-anchor-verification`。以下正式功能均已整合到根工作区；修订和后续修复使部分提交号与原 Worktree 不同。提交均在本地，未 push。

| Worktree | 根分支中的结果 |
| --- | --- |
| composer | 模型搜索收藏、附件状态与文件夹引用。代表提交 `ff4527ba`、`8dfee16b`、`f06c4c3d`。 |
| flow | 时间线事实与发送定位。代表提交 `e05cfb68`、`b42ffdc4`，后续定位修复 `feab87d8`。 |
| resources | 文件行号、审查阅读上下文、表格、Mermaid、PDF。代表提交 `a451b9be`、`eecdd9eb`、`53f1ad32`，PDF边界修复 `528846c3`。 |
| browser | 设备视口及错误恢复。代表提交 `6665a05d`、`14186191`、`676eaf26`。 |
| review-fixes | MCP附件身份和首轮定位修复。根分支为 `6005b2cb`、`feab87d8`。 |
| history-no-button | 移除普通历史加载按钮及输入票据修复。根分支为 `bde68b0d`。 |
| diff-worker | `3d5ff789`仅作为隔离实验，未合入。五对性能对照未达到主要输入指标门槛。 |
| diff-benchmark-baseline、package-worktree | 冻结源码与安装包验证副本，没有待合入的独立功能。 |

本次核对九个 Worktree 均无未提交的受控文件改动。测量脚本与原始证据位于 `.scratch/t3-priority/`，不作为产品代码整合。

## 性能与稳定性

持续流和 Diff 正常比较使用生产 Renderer。持续流两侧分别使用匹配源码的 release Core；Diff worker 两侧使用同一固定 release Core。每侧五轮交替，诊断 profile 单独运行。滚动比较另用 Chrome 中的生产 Messages 组件，正常与减弱动态各五对。样本中的错误、未知结果和清理失败均保留。

| 项目 | 结果 | 决定 |
| --- | --- | --- |
| P01 发送定位 | 完整应用首发约 32px，历史中续发约 31.92px；用户上滚后继续输出不抢回位置。Chrome 组件五对中，instant 首个可见消息帧距顶31.797px；normal smooth经过30个scrollTop值，采样开始后525–537ms到同点。减弱动态两组均即时。 | 保留发送锚点修复和即时策略。比较时间含点击及调度；未测平滑进行中打断，不外推所有平台。 |
| P02 流式输入 | 每轮 23 键的 keydown→RAF p50，五轮中位数 8.4ms（5.8–10.6）→10.3ms（10.0–12.3）。当前侧一次最大值 307.8ms，原因未确认。 | 不宣称加速或确定回归。异常保留。 |
| P03 阅读稳定 | 折叠、前插和图片解码增高 62px；同一段落仍在 473.34375px。 | 保留阅读锚点与人工展开状态。 |
| P04 重连与受理 | 真实 Core 重连 7 项、生产 transport 真实 socket 与终端 service 8 项、passive recovery 3 项通过；UNKNOWN 原请求不重放。 | 保留权威快照恢复和精确回执身份。 |
| P05 隐藏动画 | 五个 fresh app 各做原 CSS/临时暂停动画的隐藏窗口对照。样式重算减少；总体 TaskDuration 变化未超过预声明波动门槛。 | 采用现有产品策略，诊断样式未进入产品。 |
| P06 长历史 | 20 次独立读取，始终 4 页、202 段、消息容器 291 个节点。GC 数据单列。 | 采用现有有界分页，不新增虚拟列表；不据单点堆数据宣称无泄漏。 |
| P07 派生与布局 | Layout 五轮中位数260→258，style1339→1340。单独200delta插桩中，Messages356、内容投影363、分段与分组各356、阅读layout256，其余4入口0。投影相邻同参数162次。React根提交735次，包含Composer输入。9个入口实际脚本SHA匹配。 | 次数不代表CPU开销或缓存收益；独立profile多数idle，沿用现有缓存与合并。插桩耗时不进入正常比较。 |
| P08 终端 | 500 行重挂无缺失重复；真实 gap、预算截断、最终 closed 与 Runtime 退出均有证据。 | 采用现有 8MiB 有界预算。预算终止按信号 9 表达，不伪造 exit 0。 |
| P09 大 Diff | 输入每轮中位数的五轮中位数 9.4ms（8.6–14.7）→13.0ms（8.5–13.5）。worker 首次可读 2236→703ms，完整语法 2237→2554ms，working set 更高。 | 未达到预声明输入延迟门槛，采用原 Diff 路径。worker 保留为隔离实验。 |

Diff 的十轮均验证 10000 行正文及完整 token、颜色、词差异和布局摘要相同。profile 确认高亮移入 worker，但 Renderer 的原生 `(program)` 未细分，不把它说成已确认的具体布局或绘制瓶颈。working set 含共享页面，不是独占物理内存。

后台对照中的 native 窗口确实隐藏，document.visibilityState 仍为 visible。诊断恢复动画后继续完整接收 200 个 delta。TaskDuration 是主线程任务经过时间，不是整个进程 CPU；GPU/paint 没有通用计数器。未证明动画免费或整体性能获胜。

## 验证范围

- GUI 正式单测 37 文件、235 项通过。H01 另有 42 项历史 Node 检查，中英文 Electron 历史与 Chrome 阅读连续性 14 项通过。可信触摸由 CDP 驱动，未声明物理手机验收。
- Root 完整类型检查 5/5，H01 最后修正后的 Renderer 和 mobile 类型检查通过。GUI 构建 6/6，通过结果含缓存命中。隔离实现环境曾出现 Remote Upgrader 类型错误，Root 正式环境复验通过，原失败保留。
- 实际 Core/Electron 验证附件部分失败回执复用、UNKNOWN 恢复、文件夹边界、工作区归属、浏览器真实视口、错误与合法恢复、Diff 评论和范围阅读恢复。
- PDF、CSV、Mermaid 的本机 ad-hoc ZIP 专项通过。PDF 使用真实 worktree 同名文件并验证包内 worker；这不代表完整签名、公证、分发或所有格式变体验收。
- 终端 Runtime 的执行终态和持久 managed record 分开记录。超预算后 runtime 为 exited、cleanupConfirmed=true，持久 process.state 仍为 running。正常退出码 0 未单独验证。
- 未执行真实供应商、全平台、安装包全量或物理输入验收；这些范围没有用单测或受控 fixture 代替。

## 可复查证据


- [最终独立增量审阅](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/closure-delta-audit.md)。
- [逐项31项清单](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/requirements.json)。
- [汇总与覆盖限制](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/RESULT.md)。
- [功能独立审阅](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/functional-closure/audit.md)。
- [无按钮交付最终审阅](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/history-no-button/final-audit.md)。
- [流式输入release对照](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/perf/stream-release/RESULT.md)。
- [滚动即时与平滑比较](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/perf/scroll-motion/RESULT.md)。
- [派生函数精确调用计数](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/perf/derivation-counts/RESULT.md)。
- [隐藏动画因果诊断](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/perf/background-causal-execution/RESULT.md)。
- [终端最终状态](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/perf/terminal-final-state/RESULT.md)。
- [大Diff worker对照](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/perf/diff-measured/RESULT.md)。
- [决策记录](/Users/sailfish/CodeProject/AReaL-Harness/.scratch/t3-priority/decisions.tsv)。

Model the Domain 让输入授权、上传状态和生命周期沿既有所有者表达。Laziness Protocol 促使删除短历史累计限制，并拒绝证据不足的新缓存或调度层。Prove It Works 促使分别核查真实 Core、组件、包内资源与清理。Explain the Number 促使使用交替样本、保留异常，并按预声明门槛决定实验取舍。

当前独立审阅仅使用 GPT 模型，缺少跨厂商多样性。
