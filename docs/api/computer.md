**中文** | [English](computer.en.md)

# 电脑控制

电脑控制是 GUI 本机能力。Core 保留工具审批、执行记录与 UNKNOWN 结算；认证桌面适配器转发请求；Electron Main 管理原生 Helper；Renderer 只显示状态和授权入口。它不依赖 ZCode 私有后端。ZCode 公开仓库中的原生执行包是不可用占位，本项目根据其公开工具契约实现 macOS 原生执行层。

## 用户授权

设置中的“电脑控制”提供独立的启用开关和输入框入口开关。默认不启用。辅助功能、屏幕录制和输入监控状态来自系统检查。查看设置和模型调用 `request_access` 都不会申请系统权限。用户点击授权按钮才会发起申请；系统设置入口只打开对应面板，必须由用户完成授权。权限变更后可以刷新状态或重启 Helper。

辅助功能用于读取和操作 AX 元素。屏幕录制用于截图。所有修改应用的操作都要求可用的全局物理输入监控，以便用户接管时立即停止。缺少监控时仍可读取已授权的应用状态。缺失权限返回明确失败，不用模型审批代替系统授权。关闭功能会先停止控制再保存关闭状态。状态浮层和设置页都提供停止。

## 工具与执行

`computer_v1` 使用 `{operation:string,parameters:object}` 包络。先调用 `describe` 获取实际参数和可用性。操作包括 `list_apps`、`list_windows`、`get_app_state`、`left_click`、`scroll`、`left_click_drag`、`type`、`set_value`、`select_text`、`key`、`perform_action`、`paste`、`request_access` 和 `stop_computer_control`。这保持 ZCode 的公开方法语义，不提供任意 JavaScript 或 shell 执行入口。

观察发出有期限的 `state_id`、元素引用与截图 `frame_id`。元素和坐标操作必须绑定同一观察、应用与窗口。Core 先调用 `areal/computer/prepare`，记录具体目标和参数，再执行既有审批。Main 和 Helper 保存单次准备记录；批准后不能重新解析成另一个目标。原生进程重启、控制代次变化、过期或取消都会使计划失效。子会话不继承控制权。审批拒绝或派发前取消时，Core 使用独立有界的清理请求丢弃同一个准备计划并释放其待审批租约。清理必须匹配原始身份、参数和计划，不能执行动作、停止其他控制者或释放仍被其他计划持有的租约。

原生 Helper 使用 NSWorkspace、Accessibility、ScreenCaptureKit 和 CGEvent。停止命令使用独立控制通道并释放持有的输入。用户物理接管和显式停止会撤销已见任务轮次，当前模型轮次不能通过重新观察夺回控制；新的明确用户轮次可重新进入。Main 在 Helper 重启后保留此限制。每个 Main 最多记录 4096 个轮次，达到上限明确拒绝新控制，需要重启应用；不会淘汰旧撤权记录来恢复权限。无法证明是否已发送输入时返回 UNKNOWN，Core 不自动重放。截图经 Core Blob/媒体通道进入当前工具调用和历史，不把文件路径当模型图像。

空闲等待审批时，原生监控只豁免系统明确标注为发送给直属 AReaL 宿主的输入。外部应用输入仍撤销当前轮次；动作执行期间任何非本 Helper 的输入都会停止控制。鼠标键盘动作可从审批宿主切回准备计划中固定的应用和窗口，且重新校验身份与几何；第三方应用占据前台时拒绝切换，不重新解析目标。

仅启用功能时，新 GUI 会话登记电脑工具。已有会话可能保留其持久化工具定义，但关闭后执行准入仍拒绝。CLI/TUI 和没有本机 GUI 宿主的会话不会创建另一个原生控制进程。

## 外部 CUA（LCU）

在 macOS 的电脑控制设置中选择“外部 CUA（LCU）”，保存已经安装的 `lcu` 绝对路径，启用功能并检查连接，然后新建普通聊天。AReaL 不安装或更新 LCU，不复制专有应用或运行时，不申请它所需的系统权限。缺少依赖或 Core 不支持此能力时明确拒绝，不回退到内置控制。

此阶段只为手动新建的顶层聊天登记原始 `js` 和 `js_reset`。已有聊天、Side Chat、子代理和计划任务不启用外部 CUA 执行。原始初始化指令与已有附加指令合计不得超过 32768 字节，超限会拒绝创建，不截断。每个聊天有独立 JS 状态，正常轮次之间复用连接。切换方式会先停止旧控制；选择 LCU 时，旧 `computer_v1` 定义仍无法执行。内置 Preview 和 `browser_v1` 保留，LCU 只启用 computer surface。

LCU 负责 JS、应用控制和内部权限策略。Core 保留外层工具审批、真实 thread/turn/call 身份、媒体与历史。原始应用授权在 Main 的原生对话框显示，选择经上游映射返回；关闭、取消和过期回答不会授权。未支持的表单取消。没有独立的授权缓存。

Core 在轮次结束时等待原始 `turn_ended`；中断发送 Interrupt。设置中的停止先查询真实活动应用，再调用原始 host Stop 和轮次清理。窗口关闭、界面崩溃、锁屏及 Core/Desktop 断线会撤销当前控制。清理未确认保留不可用状态，关闭传输本身不代表系统输入已停止。派发后断线或取消保持 UNKNOWN，不能自动重放 JS。

开源适配层固定到 [LCU](https://github.com/amontlabs/lcu) 的 `c31a57958b3086112949374ca6d21414a3ba22b7`，原样保留 MIT 源文件与摘要。`node clients/gui/scripts/external-cua-acceptance.mjs` 验证原版客户端与 MCP subprocess fixture；它不操作真实应用，也不证明已安装 LCU、物理输入、系统权限或安装包验收。

外部 LCU 在受信任的 Desktop 宿主中运行，不受 AReaL Runtime 的工作区文件和网络沙箱限制。Core 权限模式控制外层 JS 工具准入，脚本内部访问与应用策略由原运行时负责。

## 构建和验证

`node clients/gui/scripts/build-computer-helper.mjs` 构建 `clients/gui/native/computer-helper/build/AReaL Computer Helper.app`。GUI 构建调用同一脚本，安装包将 Helper 放入 Resources。非 macOS 构建明确跳过原生产物并报告平台不支持。

`pnpm --dir clients/gui run test:automation` 使用隔离 Electron、真实 Core、本地确定性模型与测试网页。`--native` 模式只操作指定的独立测试应用，且要求用户事先完成系统授权。没有授权的运行只能证明拒绝和状态路径，不能证明真实鼠标键盘、截图、安装包或真实供应商验收。完整参数以验收脚本和原生验收入口为准。

来源与许可见 [浏览器复用包](../../clients/gui/packages/browser-automation/README.md)。没有迁入 ZCode 闭源原生生产者、账号资料或凭据。
