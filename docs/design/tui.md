**中文** | [English](tui.en.md)

# TUI 结构

TUI 只投影 Core 状态，不拥有模型循环或业务历史。全屏与 `--prompt` 复用协议客户端；交互式共享服务由 `main.rs` 通过 `areal-local-service` 连接，`local.rs` 装配 owned 模式的可信启动器。

| 模块 | 职责 |
|---|---|
| `main.rs`, `client.rs` | 终端、鼠标捕获生命周期、WebSocket、收发队列与重连 |
| `app.rs`, `commands.rs` | RPC 上下文、焦点、订阅预算、Slash 元数据、选择器和块选择 |
| `history.rs` | 分组摘要、结果提示、布局缓存、宽字符换行、阅读锚点与视口裁剪 |
| `theme.rs`, `ui.rs` | 主题、本地偏好、颜色降级、响应式布局、任务树和 Workgroup |
| `headless.rs`, `local.rs` | 单 Turn 输出筛选与本地 launcher |

会话选择、父子树与 Workgroup 状态从 Core 读取；订阅有预算，断线后 resume 替换基线再消费增量，不能拼接缺失事件。模型切换/默认复位仅在空闲边界以配置 revision 提交；主题、展开与选择状态不进入模型上下文。

操作见[客户端指南](../guides/clients.md)，回归入口见[测试](../development/testing.md)。

## 默认信息层级

| 内容 | 默认呈现 | 展开后 |
|---|---|---|
| 用户输入、最终回复、结果媒体 | 正文或媒体说明；空 Agent 消息不绘制 | 正常阅读 |
| 连续工具、Reasoning、过程正文 | 一条 Activity 摘要，列出调用次数、运行状态和问题数量 | 第一级显示每条记录的摘要，再选某条查看参数、输出或思考 |
| 失败或 UNKNOWN 工具 | 组摘要保留问题数量及最多三条有界诊断 | 完整可用诊断；取消单独计数 |
| Turn 失败、取消或完成但无正文 | 所属 Turn 后的持久结果块 | 失败详情和 Turn ID |
| 当前 Goal 停止、用量未确认 | 原因与用量说明，不依赖侧栏 | Goal ID、原因码 |
| 等待审批或回答 | 审批弹窗；问题保留待处理提示 | TUI 直接批准/拒绝；问题使用 Web 回答 |

分组不跨用户输入、可见回复、媒体或 Turn 边界。摘要由 Item 类型、工具名称及结果状态确定，不额外调用模型；未知工具使用工具名和次数，不将调用次数误称为文件数。默认隐藏成功输出首行、命令参数、JSON、diff、思考和过程正文。

[消息阶段](../api/core.md#agent-message-phase)由 Core 按实际执行轮次设置：流式过程及还需要工具/子任务续轮的消息为 `commentary`，确认无需继续后才是 `final_answer`。TUI 不根据正文关键词猜测。旧记录缺少阶段时保留非空正文；失败或取消前最后一条非空正文显示为 `Agent · incomplete reply`。`ModelContext` 不进入轨迹视图。

## 错误与状态

Turn 结果块从快照生成，按 Turn ID 定位；重连、切换会话和重复终态不会丢失或重复错误。失败显示 `Turn.error.message` 的有界摘要；错误缺失时明确说明服务端未提供详情。完成但没有最终正文或媒体时显示 `Turn completed · no final reply`，仅有 Reasoning 不能视为成功回答。

活动 Turn 的状态栏显示等待模型、工具执行、待处理交互或已通知的自动重试。`areal/model/watchdogRetry` 提供尝试次数和等待时间；恢复输出、终态、快照替换和断线会清除重试指示。终态停止本轮观察计时，不根据等待时长猜测成功或失败。

传输连接、当前 Turn、Goal 分开表达。断线或未完成订阅时显示状态待同步；相同 Goal 的停止投影与活动 Turn 矛盾且不在结算中时，每个 Turn/Goal 序列最多请求一次 `thread/resume`，等待权威快照。Goal Blocked 不覆盖后来独立运行的用户 Turn，较旧的列表响应不回退新 Goal 投影。

`usageUnknown` 解释为请求用量未确认；显示已确认 tokens 和未知请求数，尚未完成计量但未知请求数为零时显示 `accounting incomplete`。Turn 缺失用量显示 unknown，不当作零消费。`/goal-resume` 仍受 Core 预算和 UNKNOWN 检查约束，客户端不重放工具。恢复规则见 [Core 契约](../api/core.md#recovery)。

输入框以完整字素边界记录光标，键入、粘贴和删除都作用于光标位置；单行视口按终端显示宽度跟随光标，换行与 Tab 使用可见表示。Option+← / Option+→（终端未启用增强键盘协议时为 Alt+b / Alt+f）按 Codex 插入模式的词边界移动：上一词开头、下一词结尾。Ctrl-A / Ctrl-E 定位粘贴文本的当前逻辑行首 / 行尾。Slash 补全、失败恢复将光标放到恢复文本末尾，发送后归零；弹窗和其他焦点不修改后台草稿。快捷键见[客户端指南](../guides/clients.md#tui-操作)。

提交 RPC 失败在输入区保留有界提示；原输入自动恢复到空输入框，新草稿不会被覆盖，`/restore-input` 可显式恢复。提交期间断线标为结果待确认，不自动重发。此提示属于客户端反馈，不伪造成业务历史。

## 展开与阅读

- 点击摘要行切换该块；命中区域依据实际视口、滚动偏移和换行计算。拖动不触发展开，滚轮滚动历史。退出清理鼠标捕获；`--mouse=false` 保留终端原生鼠标行为。
- 历史获得焦点后，`↑/↓` 选择可展开块，`Enter/Space` 切换，`←/→` 收起/展开；输入框 Enter 保持发送语义，Esc 返回输入框。
- `/details` 或 `Ctrl+O` 切换紧凑/详细视图。新会话默认紧凑；回到紧凑视图恢复此前的局部展开选择，不修改草稿。
- 展开、收起、增量、快照替换和宽度变化使用稳定内容锚点。主动展开暂停自动跟随；`End` 返回底部并恢复跟随。浏览旧内容时新事件不抢焦点，新失败在阅读进度处提示。
- 展开符号仅用于可展开块。失败、取消、运行和 UNKNOWN 使用文字区分，在窄屏和无颜色模式下仍可辨认。

客户端块键区分 Item、首成员定位的 Activity、Turn 结果、当前 Goal 和待处理交互。Goal 提示只表示当前投影，不补造历史事件。折叠路径不拼接、换行完整成功输出；展开后缓存换行结果，渲染时裁剪到视口。模型、工具和错误文字继续清理终端控制字符；折叠不替代脱敏，不改变原始历史、执行、上下文回放或计费。

## 参考与验证

交互参考 [OpenCode TUI](https://opencode.ai/docs/tui/) 的详情入口、[固定源码](https://github.com/anomalyco/opencode/blob/fe3f3a41f79ad292cc3c7c629567385a20ec5130/packages/tui/src/routes/session/index.tsx)的独立错误展示，以及 [Claude Code 交互模式](https://code.claude.com/docs/en/interactive-mode)的 `Ctrl+O` 和[全屏模式](https://code.claude.com/docs/en/fullscreen)的局部展开。产品细节不作为本项目协议。

回归覆盖失败/空正文/部分回复、旧消息、100 次调用折叠、精确命中第二与第三条记录、中文换行和缩放、详细视图往返、浏览时新失败、重试与晚到事件、Goal 投影同步。真实 PTY smoke 覆盖鼠标、键盘、默认隐藏、错误重连保留和终端清理。Core 阶段测试覆盖事件、工具续轮、失败和持久化。
