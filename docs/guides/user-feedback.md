**中文** | [English](user-feedback.en.md)

# 回答评价与数据飞轮

GUI 在已结束的主会话回复下提供点赞和点踩。入口只在本地持久轨迹导出已启用、控制快照归属匹配、接收端的用户评价能力可用时显示。旧接收端未提供能力接口时隐藏入口。用户可在「设置 → 数据飞轮 → 回答评价」关闭图标；偏好保存在 GUI 私有目录，与轨迹导出开关分别管理。

## 使用

点击图标只创建本地草稿，理由选填。评价框依附于该回复，使用非模态窗口与轻量进入动效；原回复离开滚动可视区域时隐藏，回到原位置时恢复。点击关闭或成功提交后收起。主聊天可继续提问。

可以直接提交，也可填写理由后选择「Agent 润色」。润色使用现有 Side 能力创建独立 Thread，锚定被评价轮次，工作区访问为 `none`。首问携带冻结的完整 Core 会话上下文和用户原始意见，模型负责区分用户意见、轨迹观察与推测。补充意见继续发到同一 Side，可多轮修改，并直接编辑最终提交的分析。生成中可单独停止润色，提交需等待它结束。

生成资源仍遵守已有模型并发额度；独立上下文不等于拥有额外模型配额。Side 不向主会话带回消息，不推进主会话轮次。来源任务在准备草稿后继续生成的内容不进入这份评价。

## 上下文与保存

可信 GUI 后台通过 `thread/read` 冻结本地会话截至被评价回复的前缀，Fork 的继承历史通过分页和分片完整读取。最多 1000 轮、16 MiB，超过上限明确拒绝，不静默截断。冻结格式为 `areal.feedback-context/v1`，包含 Thread、Turn、Item 身份及完整公开历史投影。媒体和工具内容以 Core 历史中已有的数据或引用保存；该投影不能补造未采集的文件、附件二进制或原始网络字节。

提交包含 `up/down`、用户原始理由、用户确认的分析、冻结来源前缀和全部润色轮次。Arena 在独立评价表和对象存储中保存，并关联当时可读取的原始 OTLP 来源修订；尚未上传的来源引用标记为不可用。原始轨迹与评价分别保留，用户意见不改写执行结果、Reward 或独立质量判定。仅有点赞或点踩不能直接认定为 good/bad，更不能自动晋级 Benchmark。

准备草稿时绑定接收地址摘要、认证账号及队列安装身份，提交前再次核对。安装 ID 由 CLI 从实际轨迹队列读取，Renderer 不能指定地址、账号、安装身份或上下文。凭据复用轨迹导出的受保护配置，不进入 Renderer。HTTP 禁止重定向；不支持此能力的通用 OTLP Collector 继续正常接收轨迹。

本地草稿使用私有文件保存，浏览器 localStorage 仅记录草稿 UUID。提交前先固化完整请求；网络超时或回执不确定时，以同一 UUID 和同一正文重试，不带入后续编辑或主会话内容。润色首问受理不确定时先找回请求回执。接收地址、账号或队列安装身份变化会阻止旧草稿误投。用户关闭未提交草稿不会提交正式评价。若已启动 Agent 润色，这是一项真实的独立 Agent 任务，普通轨迹仍按已经启用的数据飞轮配置采集；选择润色前，窗口会说明这一行为。只有显式提交才创建用户评价记录和特殊标签。

## 管理与验证

GUI 的 `feedback` 是 App 命令，由可信后台处理，不新增 Core 推理 RPC。操作包括 `status/preference/prepare/read/draft/refine/submit/close`；上下文读取与 Side 启动复用 [桌面 API](../api/desktop.md)。`reason` 最多 32768 UTF-8 字节，`analysis` 最多 65536 字节，追加意见最多 16384 字节。

`areal trajectory feedback-status --config /absolute/config.toml` 只读检查能力，返回 `enabled/connected/destination/account/installation`。`areal trajectory feedback-submit` 从 stdin 读取最多 16 MiB + 128 KiB 的冻结 JSON，由 GUI 调用。接收端须实现同源的 `/external-feedback/capabilities` 与 `/external-feedback`，协议为 `arena.user-feedback/v1`；能力检查或提交失败不影响 Agent 回复。

运行验证：

```bash
cargo test -p areal-server trajectory::feedback --lib
cargo build -p areal-cli
cd clients/gui
pnpm typecheck
pnpm build
pnpm test:feedback
```

交互测试使用真实 Renderer 构建和隔离桌面契约，验证 UI 边界。平台的 SQL、API 与 Web 必须同步部署后，已安装客户端才会显示入口。这些本地验收不证明生产部署完成，也不证明分类准确率或 Harness 整体能力提高。
