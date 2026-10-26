**中文** | [English](browser.en.md)

# Browser v1 契约

**设计契约，部分实现。** 当前源码支持具备 Browser 能力的 GUI 聊天自然发现固定工具包、经 Core 审批绑定同一原生页、观察/截图/诊断、Ref 动作、受限本地坐标动作、等待、导航、新页面和有界批量，以及人工直接介入和宿主缺失拒绝。实际集合通过 `describe` 发现；未公布的操作仍是提案。自然浏览流程的统一原生与安装包验收尚未完成，不改变现有 [Core UNKNOWN 规则](core.md#dynamic-tools)。

支持 Browser 的 GUI 新聊天登记固定 `browser_v1` 工具包；旧 Thread 在下一次空闲时的明确用户发送中，按 [ADR-0007](../adr/0007-browser-tool-compatibility.md) 受控追加部署固定包，保留原工具和历史。无需 Composer 开关或页面交还按钮。首次经 Core 批准的 `describe` 延迟绑定当前同一原生页；没有页面时才分配空白页。模型回调仍由该 Thread 绑定的 Core 连接承接。工具定义的 `operation:string` 保持可扩展包络；`describe` 返回参数示例，明确 `act` 的单个嵌套 `action` 与来自 `observe.observationId` 的 `snapshotId`。二次校验接受 `describe`（空参数）、`observe`（`pageId`、可选文档范围、Ref 与预算）、`capture`（当前视口）、`act`（pageId、snapshotId 与已公布的 Ref 动作及受限本地截图坐标动作）和 `wait`（pageId、1–30000 毫秒和可选 condition）。观察使用有界原生 AX 读取，按实际 Frame 覆盖状态报告不可读部分，并在可用时提供 role、name、state、value 与父节点关联。Ref 绑定原生节点和代次；预算截断本身不使被省略的存活 Ref 失效。结果 URL 去除查询和片段。截图限制在 800 万像素、单边 4096 像素和 2 MiB PNG，使用现有 Core Blob 和工具媒体通道交给模型与聊天。已知敏感表单或不可读 Frame 存在时拒绝自动截图；这不是截图遮罩，也无法识别所有敏感内容。所有项目共用当前用户数据目录中的持久浏览器 Profile，登录态跨项目和重启保留。人工接管、导航、Core/宿主换代会撤销读取；在途取消或超时不会自动重试。

预览地址栏首次聚焦时展开并选中完整 URL，输入新地址会替换旧地址；再次点击可编辑地址的一部分。地址栏、导航和标签用于普通人工浏览，批注与发送上下文不依赖 Agent 工具启用或页面认领。工具包存在不等于页面读取或动作获准；Core 按实际页面、目标、操作和控制代次审批。

已知敏感内容检查和视口测量在 Electron 隔离世界运行，网页脚本不能替换检查所用的 DOM 查询方法或视口 getter。未知敏感内容仍可能无法识别；网页始终是不可信输入。

观察按原生 AX 父子结构的阅读顺序应用节点和文本预算，不以节点数组的增量分配次序裁剪；隐私判断仍覆盖完整返回节点集合。

观察预算仅对最终投影计数：省略无信息的匿名 generic 和与直接 StaticText 父节点逐字相同的 InlineTextBox；名称、状态、值、描述与 Frame 身份仍保留，隐私判据使用完整 AX 节点集合。

观察不投影文本字段值及字段子树，并隐藏其他节点中的字段值回显。仅当当前结果 URL 的 Origin、路径、查询完整值与重数匹配尚未过期的 Core 批准公共 GET 搜索，且隔离世界确认原生目标本身是查询字段并重新核查其表单、GET 语义和敏感控件后，该搜索字段不再使普通结果标签因包含搜索词而被隐藏。许可绑定 Page 与控制代次，不续期或扩大导航权限；未批准、未知、敏感或同值的其他字段仍参与回显保护，核查失败保持隐藏。敏感名称、属性和子树保护不变。

当前动作支持经 Core 批准的本地开发操作，以及公网页面中语义明确的普通文本输入、GET 搜索提交和链接导航等 Ref 操作。Main 在准备与执行时核查实际目标；敏感、未知或高影响动作返回 `human_takeover_required`，公网截图坐标动作仍拒绝。读取与动作都经过 Core 权限路径，许可绑定页面和控制代次。每份计划短期有效，绑定当前观察、目标、文档、控制代次和视口；过期返回 `plan_stale`，不自动改目标。输入确认回执的业务验证仍为 `not_checked`。

已批准的公共 GET 搜索可在派发后的 30 秒内保留同 Page、控制代次、Origin 和路径的跳转链；跳转不续期。查询字段的全部值、顺序和重数必须一致且不能缺失；网站可改写、添加或省略其他参数。审批计划保留提交前的完整表单字段，准备与派发之间仍精确复核；这不保证网站脚本实际生成的请求包含同一套辅助参数。每次导航仍撤销旧观察、Ref 和计划。人工接管、下一次实际动作、取消或 UNKNOWN 清除此意图；后续读取仍需 Core 审批。

开发闭环中，Agent 可通过 `development_service_inspect` 与 `development_service_start` 检查或启动当前 Thread 既有 Core 受管服务。进程面板只提供当前运行进程完整输出中出现的明确回环地址，用户选择后在同一原生预览页打开。该输出是端点证据，不能证明监听已就绪，也不授予 Browser 权限。预览验证卡关联 Core 检查、Browser 观察/截图和文件写入 Item，以及原始截图 Blob 和本轮 diff。命令退出、视觉判断、已加载构建身份和刷新后行为分别标注；源码指纹不能单独证明页面加载版本。

本机控制路径由 Main 拥有：可见页面的真实键盘或鼠标输入先同步撤销旧 Agent 代次、计划和读取，再等待已派发 CDP 输入结算并释放合成键/鼠标按钮；首个人工事件在收敛后继续送入同一页，无需先切换模式。未确认收敛时保持 `transferring`，提供停止加载或关闭页面，不让双路输入争写。合成动作派发前仍校验原生焦点和隔离。人工阶段暂停自动观察、截图和诊断，迟到结果按代次丢弃；已经派发且不确定的动作保留 UNKNOWN，不自动重试。下一条明确用户消息或明确继续通过既有 `send` 路径和 Core 审批重新取得控制，清除旧观察与计划，动作前要求新观察。不会定时上传人工期间内容，也不能撤回此前已交付给 Core/模型的证据。

元素选择提供仅供可信 GUI 用户触发的 `captureElement`、`cancelElementSelection` 和 `checkElement` 预览 IPC，不扩展模型 `browser_v1` 操作。Controller 在可见 human Page 的同一 CDP 会话先启用 DOM 与 Overlay，接收 `inspectNodeRequested` 后关闭叠层，再调用已有隐私保护截图并读取该节点的 AX role/name、位图边界和 Page/文档/控制身份。选择与后续读取按 Core/Thread/Page/原生 WebContentsView、代次、显示状态及期限校验；取消或换页会使迟到结果失效。`human:` 证据 Ref 不放入 Agent 可动作的 Ref 缓存；发送前节点身份、语义、边界和视口变化会标记 `stale`，保留选择时证据。裁图与来源说明只进入原 Thread 的 Composer 草稿，用户明确发送后才经既有 Core Blob/MediaRef 和消息受理进入历史。无实际项目来源映射时不提供 React 源码位置；Canvas/不可核查的 iframe 或 Shadow 内容给出原因和区域反馈入口。未显式授权或隐私检查不可完成的跨源 Frame 拒绝图片，不伪造裁图。

人工嵌入站点授权使用 `authorizeFrameOrigin`、`reloadFrameOrigin`、`revokeFrameOrigin` 预览 IPC，要求当前 Human 页面和可信 Main 确认。Main 从当前主文档的 iframe/frame 地址取得恰好一个独立 HTTP(S) Origin，不接受 Renderer 提供的 Origin。确认仅创建 60 秒有效的待重载许可，用户明确重载才应用许可；它绑定 Core、Thread、Page、原生 WebContents、父文档和控制代次，不授予 Agent 读取或动作权限。文档变化、切换到其他页面/Thread 或显式撤销关闭该原生页面；确认文案说明状态损失。关闭预览或普通 `hide` 会销毁授权页面；仅携带本页当前 Main 截图凭据 `captureId` 的标注临时隐藏保留同一 Native 和冻结草稿，卸载始终发送普通 `hide`。授权期间拒绝 Agent 认领及普通导航/DevTools，自动截图权限不变。

人工 Frame 许可用于受限截图和页面归属，不是普通网页加载所需的逐资源 Origin 许可。许可期间请求仍按实际发起 Frame 和所属原生页面检查；不注入、删除或改写站点 CSP、`Connection-Allowlist` 或下载响应头，站点自己的限制继续生效。人工截图在同进程 Frame 和 OOPIF 各自的隔离世界检查整张返回 PNG 对应的 Frame（最多 32 个），包括截图前后敏感检查、DOM 变更及 Frame/loader 身份；未覆盖、未知嵌套跨源、上下文失败、导航或取消均不返回图片。沿用 10 秒读取期限和有界清理，未知 Canvas/closed Shadow 秘密仍不保证可识别。该授权页的元素标注提供 iframe 不可可靠识别原因并进入区域标注，不产生选择器；裁图和 Frame 来源只经原 Thread 草稿及用户显式发送进入已有 Blob/MediaRef。

临时样式试改提供可信 GUI 用户的 `beginStyleTrial`、`applyStyleTrial`、`undoStyleTrial`、`redoStyleTrial`、`captureStyleTrialAfter` 和 `clearStyleTrial` 预览 IPC；模型工具定义不变。Main 仅对 原生选中的私有 backend 节点接受固定文本/颜色/字体/间距/尺寸词表，拒绝任意 CSS、CSS 值中的 URL/脚本以及 Renderer 选择器；普通文本按文本节点赋值。每步在隔离世界按真实当前属性值、节点连接及 Page/文档/控制代次核对；应用替换节点或改写已试改属性后拒绝回放。最多 20 步。清除仅在当前值仍等于本次覆盖时恢复旧值；不确定时要求刷新，不以试改效果宣称源码验证。跨文档导航丢弃旧覆盖；页内导航将试改标为过期并阻止交还控制，用户须明确刷新以清除可能存活的覆盖，避免自动刷新丢失表单内容。前后截图都经过既有隐私保护，只有选中元素裁图与用户意图进入原 Thread Composer 草稿，显式发送才经既有 Core 媒体与消息受理进入历史。源码位置未知时如实标注。

可信 GUI 的 `selectElement` IPC 接收当前 `pageId`、`captureId` 与非负整数截图像素坐标 `x/y`，用于冻结截图点选与键盘坐标选择。Main 校验当前人工控制、任务/页面/截图身份、边界、文档和视口；跨源嵌入授权期间仍仅支持区域标注，不开放元素选择或模型操作。

人工冻结截图的 DOM 变化标记保留至选择/确认结束。截图后发生节点、属性或文本变化时，元素身份选择与确认拒绝继续；仍可仅以原截图框选区域作证，或重新截图。结束标注、进入样式试改、重新认领、换文档或释放页面会清理该标记。

诊断提供 `diagnostics` 只读操作：参数为 `pageId`、`kind=console|network`、可选非负整数 `cursor`、可选 `limit=1–200`（默认 50）。结果带页/控制/文档代次、事件序号、下一游标、丢失区间标记和 200 条/256 KiB 页缓冲上限。Console 来自当前 WebContents 的实时事件；网络来自同一页 CDP 的请求/响应/失败元数据，启用时不调用可能回放旧日志的 `Runtime.enable` 或 `Console.enable`。只保存 URL 的去查询/片段形式、方法、状态与有界错误信息，不保存 body、header 或凭据；敏感文本保守隐藏。接管立即清空缓冲并停止采集，交还开启新控制代次；迟到的网络请求按原生创建时间排除。显式 DevTools 打开撤销 Agent 控制，关闭后需要重新认领和观察。诊断工具结果是当前 Thread 的 Core Item，预览验证卡链接其来源；

资源生命周期限制每窗口最多 8 个原生 Page、每 Workspace 最多 4 个逻辑 Page，并在原生对象分配前检查。执行中、控制交接中、可见人工页、准备计划和文件交接页不参与空闲驱逐；无可驱逐页时拒绝新页。驱逐保留同一 Page shell 的 URL/标题并报告状态损失，重开会提升 `pageGeneration`；未持有嵌入站点授权时，隐藏本身不导航或关闭。归档、隐藏项目和窗口关闭撤销页面归属并关闭临时上下文的最后引用；取消与迟到结果不能重新显示旧页或将已派发操作改成确定未发送。

文件交接要求用户在当前可见 human Page 中明确许可下一次下载；许可 30 秒后失效，只能消费一次，并绑定原生 WebContents、Page、Thread、文档与控制代次。Electron 原生保存对话框取得目标后才写入，Main 不接受 Renderer 或模型提供的路径。每页同时最多一个下载、单项最多 64 MiB、最长 120 秒；超限、关闭、崩溃会取消，已派发下载的网络副作用标记未知且不自动重试。只保留每 Workspace 最近 8 条本机会话回执，记录 Page、opener、来源可知程度、文件名、大小或未知、目标文件名及完成/取消/中断状态。网页上传沿用 human 控制下的系统文件选择器；Agent 控制时 Core 准备拒绝文件输入，原生 CDP 另拦截间接触发的文件选择器并撤销控制。无文件内容、宿主路径或文件选择接口交给模型。

每页私有 Ref 缓存最多保留 1000 个存活身份，优先保留本次观察发出的 Ref；较旧的被驱逐 Ref 返回 `stale_ref`，公开 ID 不复用。原生截图前后均检查已知敏感字段，包括带可选 section 前缀的密码、支付安全码和一次性验证码自动填充 token，并在截图期间观察到 DOM 变更时拒绝图片。栅栏覆盖主文档、可读 Frame 和开放 Shadow root；短暂的 Canvas 像素或不可读的封闭 Shadow 内容无法证明安全，含未知秘密的页面不适合自动截图。

同文档且完整 URL 未变的 history 更新只使旧读取、Ref 和计划失效，不撤销或恢复当前控制权；URL 变化或新文档仍遵守原导航授权规则。

主文档 Ref `press` 的原生 keyDown 已确认后，若只有非目标子 Frame 导航使全页观察代次失效，可在主文档、原生 Page、Host/Core 归属、控制和视口均未变化且未取消时完成该按键的唯一 keyUp。该例外只结束已确认的输入，不允许复用旧 Ref、继续其他输入或扩大导航许可；旧读取计划仍失效，后续动作须 fresh observe 并经 Core 权限检查。回执仍为 `inputConfirmed:true / verification:not_checked`；ACK 丢失或其他 fence 失效仍保持 UNKNOWN，不重放。

## ZCode 命令适配

新增 `{operation:"command",parameters:{pageId,command}}`。`describe` 的 `command` 字段返回实际方法、有效示例和不支持项。通过 `describe` 的 `parameters.topic` 指定 `command.<method>` 或 `command.playwright.<action>` 获取对应的上游严格 schema，避免完整 schema 被结果预算截断。命令 schema 与执行器复用 ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab`，来源和适配点见[包说明](../../clients/gui/packages/browser-automation/README.md)。

命令组包括 Playwright 风格定位器与跨域 iframe、语义快照、页面和元素求值、CUA 输入、整页/裁剪/元素截图、视口管理、alert/confirm、下载、WebM 录制与标签交付。所有命令沿既有 Core 准备和审批路径，不提供任意 Node 或原始 CDP。`evaluate` 只在已授权网页上下文运行；这不授予宿主文件或产品 bridge 访问。录制输出路径由可信项目根约束。

准备记录绑定原始命令和涉及的每个真实 Page。执行不因审批等待而换目标；取消、页面接管、关闭、原生代次变化撤销后续输入。隐藏页面临时借用不可聚焦透明窗口取得 compositor surface，然后交还同一个 WebContentsView。截图经 Core Blob 返回，交付前后复核来源页控制代次。未知副作用保留 UNKNOWN，不重发。

上游声明并非全部可执行。普通 `fill`/`waitFor` 应改用 locator；上传、file chooser 和 `networkidle` 明确不支持。locator `downloadMedia` 复用上游下载锚点实现，并绑定修改操作审批与下载回执。Electron WebContentsView 的 `prompt()` 不可用。该适配不提供完整 Playwright/ZCode JavaScript SDK、外部 CDP、扩展或 CLI 无头后端。全部项目和聊天共用 Main 持有的 `persist:areal-embedded-browser` Session。关闭 Workspace 或聊天只销毁 Page 和控制引用，保留 Cookie、localStorage、IndexedDB 及登录状态。Profile 存放在当前 GUI userData 中，隔离测试 home 和不同安装配置不共享。旧临时 Session 不自动迁移。共享登录不授予其他聊天的页面控制权。

`pnpm --dir clients/gui run test:automation --suite browser` 通过真实 Core、隔离 Electron 和确定性本地模型验证命令效果、审批拒绝、截图媒体和录屏产物。包内直接执行器验收与这一模型调用链分别保留证据，不能代替真实供应商或安装包验收。


## 原生控件与状态等待

`act` 另接受 `{kind:"scroll",target:"viewport",deltaX,deltaY}`、`{kind:"hover",ref}`、`{kind:"selectOption",ref,value}` 和 `{kind:"setChecked",ref,checked}`。滚动量必须是 `[-4096,4096]` 内的安全整数，不能同时为零。选择操作只接受原生单选 SELECT 中唯一、启用选项的 exact value，最多 256 字符。checkbox 状态为布尔值。自定义控件、多选 SELECT 和 radio 不受支持。这些变体沿用 Core 准备、批准链和公网 Origin 政策。审批显示具体滚动量、选项值或选中状态。

观察为原生表单控件提供有界 `nativeControl` 事实。checkbox 含 `kind`、`enabled` 和 `checked`。SELECT 含 `kind`、`enabled`、`multiple`、`value`、`optionsComplete` 和 `options`。每个选项含不透明 `optionId`、`value`、`label`、`disabled` 和 `selected`。私有节点身份不会进入工具参数。最多表示 64 个选项，每个 value/label 最多 256 字符，选项文本合计最多 8192 UTF-8 字节。敏感控件或选项文本继续隐藏；不完整或歧义列表不能授权选择。完整观察字节预算仍然生效。

准备把观察时的视口与当前视口分开绑定。精确选择绑定原 SELECT 和完整有序 OPTION 对象。同值替换、重排、类型改变或禁用选项在变更前拒绝。固定 Host 命令使用隔离世界的原生 getter/setter，仅在选择改变时发送语义 `input` 和 `change` 事件。这些事件不承诺 `isTrusted`。页面处理器可能取消或恢复状态。动作与批量回执独立报告输入派发、确认、no-op 和 `stateMatched`，不代表业务成功。选择回执不包含输入后的 SELECT 选项值或标签；完整选项事实由带隐私过滤的观察提供。checkbox 回执可包含布尔 `nativeControl` 事实。

已达到目标状态的 checkbox 返回 `dispatch:"confirmed",noOp:true,inputConfirmed:false`，不产生 click 或 change。状态不同时使用原生 click 输入。输入 ACK 丢失仍是 UNKNOWN，包括 set-to-state 操作也不能自动重放。

`wait.condition` 接受原生 checkbox 的 `{kind:"checked",ref,value:boolean}`，以及原生表单控件的 `{kind:"enabled",ref,value:boolean}`。等待读取原节点身份，不要求动作可用性或几何条件。disabled 控件可以满足条件。等待不发送输入，保留既有超时、接管和迟到结果栅栏。

确认完成的 scroll 和 hover 使旧观察失效。后续动作前必须重新观察。`runBatch` 先记录本步确认收据，再使子计划失效。后续旧步骤为 `not_sent`，已确认前缀和外层调用去重继续保留。逐步收据包含 `inputConfirmed`、可选 `noOp` 和原生状态事实。已派发步骤不明确时保留前缀，并把工具结算为 UNKNOWN。

## 1. 两条既有连接与一个新能力

批量执行在既有 `browser_v1` 包络新增 `runBatch`，不修改持久化工具定义。参数为 `{pageId, snapshotId, steps}`，包含 1–8 步；每步为已有 `act` 动作（`{operation:"act", snapshotId, action}`）或有界等待（`{operation:"wait", timeoutMs, condition?}`）。所有步骤使用同一 Page 与已观察快照，不允许导航、新页面、任意代码、隐式网络工具或文件权限。截图坐标仅可用于首步，因为输入会使截图失效；已知等待总时长不能超过内部 29 秒执行预算。Core 准备并批准具体完整序列；Main 私有保存逐步计划，在每次派发前检查原生目标和控制 fence。结果包含逐步已确认回执与 `verification:not_checked`；后续确定拒绝时剩余步骤标为 `not_sent`。任一步不确定则整个工具为 UNKNOWN，并在 Core 错误详情保留已确认前缀。相同 call 身份共享运行中或已完成结果，参数变化拒绝。Preview 沿既有 Page operation 投影显示进度。

现有链路是 Core app-server ↔ 独立桌面适配器，以及该适配器 ↔ Electron Main 的认证本地服务连接；Renderer 不持有 Core 凭据。后者承载状态、客户端命令与有界的反向 Browser 请求、结果和取消，复用既有认证，不新增公开浏览器服务端口。

- Core 已有 `item/tool/call`、动态 ToolHost、`areal/tool/cancelled` 和客户端结果；真实动作沿用此链路。
- 新增可选 Host 能力 `areal.browser.host.v1`。握手包含协议版本、实际操作集合、browserHostId、hostGeneration、当前 Main availability；仅部署信任的客户端可以登记。
- Main 只向被认证的桌面适配器接收执行请求；拒绝 Renderer 或网页伪造的工具回调。Main IPC 校验 sender 与 owning window，ID 本身不等于授权。
- 独立适配器作为当前 Thread 的唯一回调连接。不能用第二条 Core 连接 `thread/resume` 抢占活跃宿主；观察另走第 10 节。
- GUI Main 退出但适配器仍在时，报告 `host_unavailable`，不把适配器心跳当作页面可用。

## 2. 模型接口与能力发现

固定模型工具名：`browser_v1`。稳定的最外层输入是 `{operation:string, parameters:object}`，严格禁止其他顶层字段。字段长度/深度/字节有界；`parameters` 由实际操作的 schema 二次严格校验。这个可扩展包络使已持久化工具定义不因新增能力而改写。

第一步调用 `describe` 获得支持的操作及短说明；只返回本 Host 已实现能力，不一次灌入全部开发文档。拒绝未知 operation/参数，不把未知参数转成 shell、JS 或原始 CDP。已授权网页求值仅通过 `command` 的严格 schema 开放。规格描述未来能力不等于提前公布可用 capability。

| operation | parameters 的意图 | 关键限制 |
|---|---|---|
| describe | 可选 topic | 限定当前绑定 Host；无系统端口或秘密 |
| listPages | 无或已知 workspaceId | 只列当前 Thread 的授权页；人工页仅元数据 |
| claimPage | pageId | 用户已选择/授权页；保留同一对象，不跨 Thread |
| newPage | URL、用户可见目的 | 同一临时上下文；配额；导航审批 |
| navigate | pageId、URL | 不依据活动标签推断目标；HTTP(S)；跨 Origin 重新检查 |
| observe | pageId、scope、可选 rootRef、budget | DOM/AX 默认；标注 iframe 覆盖和截断 |
| capture | pageId、viewport/full、可选 clip | 绑定视口；隐私与尺寸检查；返回 Core 授权证据 |
| act | pageId、snapshotId、action | 受支持的 click/fill/press/scroll/hover/select/check/drag；实际计划审批 |
| wait | pageId、condition、timeoutMs | 有界状态等待；不用全页 networkidle 当通用完成条件 |
| closePage | pageId | 人工/未知来源需用户确认；不能关闭其他 Thread |
| diagnostics | pageId、kind、cursor、limit | Console/network 摘要；隐藏正文、凭据和敏感 header |
| command | pageId、上游 BrowserCommand | 真实方法和限制见 describe.command；逐条准备与审批 |
| runBatch | pageId、snapshotId、steps | ≤8 个已知动作/等待；总预算；逐步 fence；不能跨页、包含任意代码或提升授权 |

每项操作、capability 和用户可见错误必须有行为测试。阶段构建未启用的 capability 返回确定的 `unsupported`，不创建占位浏览器。浏览器关联 Thread/Turn 来自 Core，不接受模型指定别人的 threadId、hostId、webContentsId 或 CDP sessionId。

## 3. 内部身份包络

下列是**新内部 DTO 示意，不是现有 API**。传输端生成/验证，不出现在模型可写参数中。

```ts
interface BrowserExecutionContext {
  coreInstanceId: string;        // 来自已认证部署
  projectId: string;
  threadId: string;
  turnId: string;
  callId: string;                // Core 工具调用身份
  requestId: string;             // 本次双向传输关联，不是业务去重键
  browserHostId: string;
  hostGeneration: number;
  workspaceId: string;
  pageId?: string;
  pageGeneration?: number;
  controlEpoch: number;
  deadlineRemainingMs: number;  // 每一跳只能收窄，不能重新给满预算
}
```

在 Map 中用结构化复合键或无歧义编码，不简单串接可能含分隔符的项目字符串。Host/原生连接换代、Page 替换、文档导航、控制交接、视口变化分别有独立代次，不混用一个 revision。

- `hostGeneration`：Main/Host 实例或绑定替换；旧连接回执无写入资格。
- `pageGeneration`：该逻辑 Page 的原生对象替换；恢复 URL 后仍是新代次。
- `documentEpoch`：主文档/Frame 文档替换；Ref 失效。
- `controlEpoch`：认领、接管、交还、撤销授权；旧动作计划失效。
- `viewportRevision`：CSS 尺寸、缩放或截图坐标变换变化；旧坐标动作失效。
- `eventSequence`：仅事件重订游标；不是控制权限，也不因读操作提升。

## 4. 页面、上下文与事件

Browser Workspace 绑定 `(coreInstanceId, projectId, threadId)`。首期每 Thread 一个 Workspace，多个 Page；跨 Thread 页面转移不支持。第一次认领旧预览沿用其实际 Session。新 sibling page 加入同一临时上下文；其他 Workspace 创建独立临时上下文。

Controller 提供**原子 snapshot + subscribe**，UI 先安装 snapshot 的序号，再消费后续增量。发现序号缺口就重取，不能靠独立 read 和 subscribe 假设无窗口。事件至多携带元数据；DOM、图像和网络正文按需读取，不广播。

桌面 Main 的唯一 Page Map 持有原生对象。可信主视图通过 `preview.subscribe` 一次安装监听并取得快照；后续事件只携带 Page 元数据，序号缺口重新订阅。人工新建、切换和关闭是主视图意图；关闭人工或未知来源页必须带明确用户意图。`browser_v1` 的 `navigate` / `newPage` 先只读准备，再经 Core 审批，执行时按 Page ID 和代次路由。`newPage` 的 `pageId` 指 opener；子页加载后沿同一 claim 路径建立独立 controlEpoch、诊断和原生文件选择拦截，成功回执给出新 Page ID 和子页代次。认领或交还后，导航和新建页也必须先有新的 observe/capture。网页弹窗只有近期、一次性的本地人工输入才能进入同一临时上下文；其他原生开窗请求被拒绝。

事件包括 `pageAdded/pageChanged/pageRemoved`、`controlChanged`、`operationChanged`、`hostAvailabilityChanged`、`viewportChanged`、`diagnosticsAvailable`。GUI-only 投影可在原有本地状态通道中分发；持久工具事件仍使用 Core Item。只对所属 Thread/项目/window 授权接收者广播。

页面状态采用正交维度：

| 维度 | 状态 | 所有者 |
|---|---|---|
| 资源 | ready / suspended / crashed / closed | Controller |
| 控制 | human / agent / transferring | Controller（Core 保有授权证据） |
| 可达性 | connected / disconnected / incompatible | 已认证适配器与 Controller |
| 操作 | prepared / dispatched / confirmed / rejected / unknown | 原生事实在 Controller，正式工具结果在 Core |

Page shell 可恢复 URL 与标题，但不恢复原生对象身份或表单/JS heap；崩溃恢复仅使用最后已提交的文档地址，不恢复下载等未提交导航的暂存 URL；共享持久 Profile 保留登录数据，但这不恢复原生页面、表单或 JS heap。不要通过读取历史截图宣称恢复了 live page。

## 5. 语义观察、Ref 与视觉坐标

观察至少携带 `observationId/pageId/pageGeneration/documentEpoch/controlEpoch/url/title/capturedAt/scope/truncated/frameCoverage`。视口观察另含 CSS 尺寸、scroll offset、device scale、page zoom、bitmap size、`viewportRevision`。截图是时间点证据，不是锁定网页状态的保证。

语义表示优先可见文本、role/name/state 与交互 Ref；不给每个非交互容器发 Ref。压缩结构不能丢失表单标签、错误提示、关联层级、iframe 来源和截断原因。未覆盖的跨源 iframe 明确标记 `unavailable`，不得伪装为空。

Ref 私有映射键至少含 Page generation、Frame identity、Frame document identity、backend node identity。引用公开 ID 单调不复用；只在同一节点确实仍存在时复用。查不到或已导航时返回 `stale_ref`，不按名称/XPath fallback 去点击另一个节点。重新观察后由 Agent 决定新动作。

Ref 动作准备与派发都验证目标仍连接、可见、可交互且 hit test 命中。布局可变时等待有界稳定，再检查；不使用页面脚本的 `.click()` 冒充真实输入。滚动/刷新可能改变有效条件，不能只比较一个全页 DOM revision。Canvas 坐标以**截图 bitmap → 页面 CSS viewport**的明确变换转换；不直接乘 DPR 猜测。缩放、视口或文档变化必须重新截图。

当前仅本地开发页支持截图坐标动作，公网页拒绝；坐标动作使用最新可见视口 `capture` 的 `observationId` 作为 `snapshotId`：`clickAt(x,y)`、`drag(fromX,fromY,toX,toY,steps)` 与 `pressAt(x,y,key)` 的坐标是截图 bitmap 整数像素，必须落在实际位图内；拖拽 `steps` 为 1–20。`describe` 公布当前支持的动作。Main 以实际 bitmap 和页面 CSS 尺寸转换为 CDP 输入坐标，将转换后的目标绑定到 Core 审批计划。转换统一使用可精确表示的 1/64 CSS 像素精度，避免 JSON 往返的浮点末位变化。本地 Canvas 无 Ref 时只能使用此截图路径；公网 Canvas 交给人工，不编造 DOM selector。每次动作后都需重新截图才能继续按坐标输入。截图同时记录 CSS viewport、scroll、DPR、page zoom、GUI zoom、原生 DIP bounds 和 bitmap 尺寸；GUI Renderer 的 CSS bounds 按 GUI zoom 转为原生 DIP bounds。隐藏、最小化或零尺寸页面不提供自动截图。视口、缩放、scroll 或文档变化使旧截图和准备计划失效；稳定 Ref 仍重新检查 actionability。

`wait` 可选择 `{kind:"documentReady",state:"interactive"|"complete"}` 或 `{kind:"accessibleName",ref,name}`；后者只匹配当前主文档已观察 Ref 的完整可访问名称，旧节点被替换时返回 `stale_ref`。条件随具体等待计划审批；超时不宣称条件成立。未提供 condition 时只做固定延时，不证明页面就绪，不使用全页 networkidle 或任意脚本。批量等待沿用同一 condition 及预算。

## 6. Core 审批与原生执行：两阶段，但不是事务

读取与动作均须经 Core 权限机制。首次 `describe` 的绑定及后续观察/截图/诊断也不能绕过许可或人工控制栅栏；读取许可按当前控制代次校验。对会改变页面或触发外部副作用的操作：

1. Core 记录 Tool Intent；校验工具包、实际 Thread 及部署策略。
2. 通过**新增只读服务器请求** `areal/browser/prepare` 请求已绑定 Browser Host 准备。它只解析实际目标、动作和当前代次，不输入、不导航、不上传、不创建页面。新建页只能准备计划，执行阶段才分配资源。
3. Host 返回有短有效期的 `preparedActionId`、规范化计划摘要/指纹、目标描述、Origin、范围、代次、预算、风险原因。网页提供的 label 作为不可信文本转义展示。Core 保存这份计划，不把模型描述当真实目标。
4. Core 复用现有权限状态机与 `ApprovalRequest` 交互，审批域增加 browser。**执行许可只由 Core 的决定产生**；GUI 不另写允许规则。对外部网站高影响/未知语义操作优先人工接管。已明确授权的本地开发站点可获得本次 Workspace 的受限开发操作许可。
5. Core 将获批的计划身份和许可放入**可信回调元信息**，与 `item/tool/call` 一起送 Host；不能放在模型 arguments 中。默认旧动态工具无此扩展。
6. Host 按有效期、Origin、Page/文档/控制/视口代次、计划指纹重新验证，并即时检查目标。通过才标记 dispatched，发送输入，生成回执。条件失效返回 `plan_stale`，不在宿主内部自动改目标重试。

`areal/browser/prepare` 是新增 Host 能力，需要 Core DynamicToolHost 的可选只读准备接口与专用关联响应；没有该能力的既有工具行为不变。prepare 超时、断线而尚未发 execute，Core 可记录确定的未执行；只有 Core 自己确认执行链未派发才使用这一结论，不能信任模型声称。

审批持久记录属于 Core，短命 prepared records 属于 Controller，绝不维护第二份可长期放行的授权库。外层工具授权不足以替代原生控制栅栏。Core 审批允许之后人仍可随时接管撤销。

## 7. Human Takeover 与暂停边界

用户直接在原生页输入：Controller **同步增加 controlEpoch**，禁止旧代次新动作，清退未派发队列并暂停 Agent 自动读/截图/诊断。控制通道不排在动作队列后。按下的合成按键/鼠标按钮做有界清理；已经到达网站的输入无法回滚。

本机栅栏立即生效，但 human 输入开放前必须完成原生输入收敛屏障：已派发的合成输入结算、释放按键，确认不会再派发旧代次输入。这只等待本机原生通道，不等待 Core。若在有界时间内无法证明输入已收敛，保留 transferring、阻止双写，并提供停止/关闭该页的安全退出；不能把“已请求接管”显示成“接管完成”。网页已触发的网络/业务副作用可以继续，仍需保留 UNKNOWN。

随后广播 human 状态并通知 Core。没有在途输入时可确定 `user_control`，并阻止 Agent 重复请求 Browser，允许当前 Turn 收尾或进行不依赖页面的其他工作；不自动启动新 Turn。已有输入无法确认时走 UNKNOWN，遵守 Core 的停止自动执行规则。不能因为“接管成功”就把那次动作写成未执行。

Core 将模型工具参数与内部审批计划分开记录：后续模型历史只回放经 hooks 校验的规范参数，审批计划留在审计字段。已有 Browser/client 记录中的内部审批包装只在投影时提取规范参数，不改写权威历史，也不接受模型自行提交的 `arguments/plan` 包装。

人工控制不是仅禁写：Agent 侧 DOM、图像、Console、网络采样与历史缓冲交付均停止；只留宿主安全与生命周期必须的内部信号。人手动登录结束后默认丢弃这段可敏感的诊断缓冲。在途读/截图即使在接管前启动，返回时也必须重新验证controlEpoch；过时代次不得向模型或历史发布结果。暂停不能撤回先前已发给模型的证据，UI 应明确这一点。

下一条明确用户消息或明确继续才可沿 Core 审批路径恢复控制，创建新 controlEpoch，清空旧 prepared records 与观察句柄，并要求新 observe/capture。无需独立交还按钮；普通显示、切页或定时器不算授权。有 UNKNOWN 时保留核对入口和既有检查确认，不重放旧工具。

## 8. 回执、去重、超时和取消

幂等键是 `(hostGeneration, threadId, turnId, callId, stepIndex)`；传输 requestId 只用于关联。相同键相同参数返回缓存的已知回执；不同参数拒绝冲突。相同在途键共享同一执行，不多发输入。回执缓存有界；一旦无法证明旧调用是否派发，返回 UNKNOWN，不以缓存缺失允许重发。Host 重启不恢复执行资格。

| 事实 | 对 Core 的映射 | 后续 |
|---|---|---|
| 参数错、未授权、旧 Ref、用户控制、配额/能力不支持，确定未派发 | `success:false`，带 code 与 `dispatch:not_sent` | 可修正参数/重新观察；不能自动夺回控制 |
| 动作派发和完成已确认 | `success:true`，回执与新状态 | 验证业务结果另算 |
| 动作确认完成但业务检查未通过 | 动作仍成功，verification=failed | 新观察后决定新动作，不掩盖已提交事实 |
| execute 派发后失去回执、超时、崩溃或取消，无法确定 | 有回包时返回 `code:outcome_unknown,dispatch:unknown` 与原因；连接丢失仍走既有 UNKNOWN 路径 | Core 停止自动执行；人工核对；不重放 |
| 批量前几步确认，后一步确定未派发 | 已确认步骤+确定失败+剩余未执行，`success:false` | 不重复前几步 |
| 批量任何一步结果不明 | 整体工具 UNKNOWN，保留此前已确认回执 | 剩余步骤不派发 |

超时分 prepare、审批等待、执行和传输。内层预算必须先于外层剩余期限结束，为结构化回执留空间；审批等待不沿用 3 秒动作预算。建议初始单动作默认 5 秒、上限 30 秒；普通 wait 默认 3 秒、上限 30 秒；批量执行总上限 30 秒、最多8步。它们是资源策略初值，不是性能承诺；以真实测试调优。墙钟变化不延长本地单调预算。

`navigate` 与 `newPage` 接受本次主文档的提交和 `dom-ready` 作为可交互证据，不必等待图片等全部资源完成；回执增加 `readiness:interactive|complete`，`url` 是去除查询和片段的实际页面地址。既有控制代次与所有权检查仍须通过；旧文档的 ready 事件、仅开始导航或已撤销权限不能构成完成证明。12 秒内没有完成证据仍为 UNKNOWN，结构化原因 `navigation_timeout` 经宿主、适配器与 Core 保留；导航中断为 `navigation_interrupted`，不重放导航。这是完成证据修复，不增加执行预算或放宽授权。

`areal/tool/cancelled` 传播到 adapter/Main，匹配原 requestId 和代次。尽力取消不保证回滚。迟到回执仅作核对证据，不能复活 Turn 或把 Core 已结算 UNKNOWN 静默改成成功。

Agent 的页面认领、观察、截图隐私检查和 Ref 动作所需的有界文档读取，使用当前主 Frame 的独立 CDP world，避免 Electron `executeJavaScriptInIsolatedWorld` 等待整页资源完成。读取不启用 `Runtime` 事件回放，不转为页面主 world；原文档、控制代次和隐私核查仍在发布结果前复验。人工批注仍使用原有冻结读取路径。

## 9. 资源、证据与安全限制

### 配额初值

沿用当前最多8个原生 Page 的窗口上限，另设每 Workspace 最多4页。执行、接管中的人工活动页、阻塞对话框与文件交接页不可驱逐；全部 pinned 时拒绝新页并提示关闭，而非杀掉工作页。隐藏可保留，暂停/驱逐仅对明确空闲页并展示状态损失。队列每 Workspace 至多16项，控制通道保留容量；没有无界 Promise/FIFO。

观察默认最多200个交互节点、32 KiB文本，显式扩展最多1000节点、128 KiB。诊断单页缓冲最多200条/256 KiB，body 默认不收集。值为可调整初始上限，不是测得最优值。数据截断必须报告，不能无声截断结果。

### 媒体

Core 的4 MiB WS帧上限是全链路实际约束；适配器更大的本地帧额度不覆盖它。截图先限制像素/编码大小，再通过现有 Core 媒体/Blob 上传与工具结果契约交付。超过限制采用既有分块上传（若该版本有）或显式拒绝/降低预览尺寸；不得临时发明一个未经授权的大文件 HTTP 下载端口。上传方法名、MediaRef 和 contentItems 复用当前生成 schema，不在 Browser 层复制另一套媒体类型。

全图证据保存 Core Blob；模型与 GUI 获取按 Thread/工具调用授权的引用。模型实际需要视觉判断时使用已支持的图像内容投影，不能只回一个模型读不到的 artifactId 就声称“已看到截图”。示意图像规范化不是当前截图实现已验证的证明。证据包含 URL（去敏感查询项）、时间、视口、Page/文档代次、工具 callId、可选代码变更/构建身份；无来源时字段缺省并标明未知。

### 权限和隐私

网页永远无 Node、preload 产品 API；保持 sandbox/contextIsolation/webSecurity、主/Frame导航检查及IPC来源检查。浏览器 Profile不是Agent Profile，不能从用户模型配置继承账号权限。拒绝 file/javascript/data 顶层导航、带凭据URL、私有产品协议、系统命令和 shell逃逸。新浏览器任务不得访问 Core/adapter 的内部控制端口，即使它们也在 localhost。

普通人工公网/本地浏览沿用 Chromium 的系统代理、DNS、重定向、跨源依赖、Frame、Worker 和 HTTP(S)/WebSocket；不以私网地址或 fake-IP 分类替代权限，也不要求逐站点或逐资源 Origin 提示。产品不修改 OS/Surge 配置，不注入 CSP 或 `Connection-Allowlist`，完整保留站点响应头。Main 将当前 Core/adapter 控制端口在所有主机名上保留并拒绝，防止 DNS 别名或代理 fake-IP 绕过；无关站点使用同一活动控制端口也会被拒绝。关闭 Session 后保留拒绝策略。此边界不等于操作系统级网络沙箱或防外传保证；Agent 读取与动作另外经过 Core 权限机制。

原始 Cookie/Storage导出、浏览器级CDP、系统文件访问、任意 evaluate 不向模型开放。按权限提供有限调试操作。文本密码、令牌、Authorization/Cookie/Set-Cookie、敏感查询值默认脱敏；当前截图在发现已知敏感表单或隐私检查不完整时拒绝，不提供遮罩；未知敏感内容不能保证检测，Agent 采集须有当前页面及代次的 Core 许可。手动输入流程优先接管。下载与用户选取上传另行授权，不能传任意宿主路径或自动打开可执行文件。

### 信任模型与剩余风险

主要防护对象是恶意网页、模型误操作、跨Thread串线与不可信Renderer输入；Core、认证桌面适配器与Main属于可信计算基础。本设计不防御已被攻陷的Main、操作系统管理员或另一个已获全磁盘/无限网络权限的工具。授权Runtime的任意宿主执行不会因为Browser接口受限而自动变安全。

脱敏针对Browser自动采集与投影；用户已经在聊天中提供的秘密或模型已持有的值，不能承诺从既有历史撤回。凭据输入优先human阶段，不将密码表单值作为Agent操作参数。页面上的未知敏感信息仍需用户决定是否允许该页观察。

## 10. 旧 Thread 与多客户端：新增 Core 接口

`areal/thread/tools/attach` 与 `areal/thread/observe` 已在源码实现。客户端通过 `areal/capabilities` 的方法列表和 `features.atomicObserve` 发现观察能力，通过 `features.browserToolAttachment` 和 `browserToolBundles` 发现追加能力；不修改固定 Codex 兼容 schema 的既有定义。GUI 重连与打开 Thread 先调用 `areal/thread/observe`，只恢复 Core 权威投影；旧 Core 未公布该方法时明确提示不支持，不用 `thread/resume` 偷取宿主。下一次空闲时明确发送可追加固定包；首次经 Core 批准的 `describe` 绑定页面。不能通过 `thread/resume` 抢宿主或改写历史，Core 仍执行宿主冲突检查。观察者的工具回执不能代替绑定宿主，页面操作不从 URL 或缓存事件重放。

| 方法 | 请求 | 语义 |
|---|---|---|
| `areal/thread/tools/attach` | requestId, threadId, expectedToolsetRevision, bundleId=`areal.browser.v1` | 仅 interact+tools 的可信部署客户端；Thread 空闲；原子追加部署固定工具包并绑定当前宿主；同名不同schema冲突；重复返回原结果 |
| `areal/thread/observe` | threadId | 原子历史/状态快照+后续增量；只需 observe 权限；不重绑 ToolHost，不改变现有 `thread/resume` 行为 |

`Thread.toolsetRevision` 可选，旧 Thread 缺省 0。固定 `areal.browser.v1` 包由 Core 定义；请求不传工具 schema。附加返回 `threadId`、`toolsetRevision`、`bundleId`。同一主体、方法和 `requestId` 的相同请求从 Thread 内持久回执返回原结果；输入不同返回冲突。忙碌、存档、版本不符、同名不同定义或其他仍在线的宿主返回冲突。原始 `dynamicTools` 和历史保持原样，只追加部署包，不提供任意删除或替换接口；附加不结束 Turn 或发起新 Turn。

提交后 Core 发出 `areal/thread/tools/attached`，包含 `threadId`、新 `toolsetRevision` 与完整 `dynamicTools`；GUI 用该权威事件更新已有 Thread 投影，旧快照不能覆盖更新版本。工具回调仍由绑定的 Core 宿主和原生页认领校验，不依赖可能滞后的 GUI 投影。

当前 GUI 宿主只执行 `browser_v1`。含其他既有客户端动态工具的 Thread 仅在同一在线原宿主连接上允许追加；原宿主已断开时拒绝改绑，以免把那些工具交给不能执行它们的 GUI 回调。原有定义和历史仍可读。

存储版本从 12 提升至 13；新 Core 用默认 0 读取旧 Thread。旧 Core 拒绝 13 版记录；回退前应备份数据，并使用支持版本 13 的 Core 读取，禁止改写版本号或删去工具历史。旧 Core 未公布能力时明确报告 Browser 不可用。

支持 Browser 的新建 GUI Thread 登记固定 Dispatcher；旧 Thread 在下一次空闲时明确发送受控追加固定包，无需手动启用开关。CLI/TUI 作为观察者使用新 observe，不实现 Electron Driver。由已有 GUI ToolHost 服务的Thread可继续通过授权Core入口提交消息；GUI不存在时明确 Browser unavailable，不启动另一个Chrome。子Agent默认不继承父Thread浏览控制；共享只读历史不等于控制授权。

## 11. 版本与回退

能力关闭后恢复普通预览；已有 Browser历史可读，live对象不重放。回退不得删掉历史工具定义或伪造旧版本可执行。若旧Core不能读取新增快照，明确阻止二进制降级并提供数据备份指引；禁止为了回退去改存储格式数字。每次客户端/Core契约变更同步生成类型、schema、文档和fixture。

## 共享登录数据

设置页提供从 Chrome 导入、清除缓存与清除全部浏览数据。操作影响所有项目；开始前关闭现有浏览页并撤销控制，阻止新页面和迟到审批重新写入。仅清缓存保留 Cookie、localStorage 和 IndexedDB；全部清理还清除登录、站点存储和 HTTP 认证缓存。全部清理需要用户在界面确认。导入只在用户点击后读取 Chrome 的 Cookie 和 localStorage，macOS 可能要求钥匙串授权；拒绝授权会停止导入。结果只显示计数和错误码，不向模型或日志暴露凭据。网站权限仍采用现有拒绝默认。
