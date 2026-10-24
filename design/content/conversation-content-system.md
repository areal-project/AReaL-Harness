# 对话内容呈现系统：现状与统一设计建议

日期：2026-10-24。状态：首轮实现；新增共享展示投影、六类只读原生内容、审批渐进披露和显式回答。Core历史格式、Gen UI/MCP运行时与执行契约保持原位。验收以对应运行证据为准。

## 结论与范围

现有系统具备承载多种内容的基础：Streamdown正文、公式/图形插件、原生React组合，以及复用MCP Apps宿主的Gen UI页面。当前组件足以组成第一条混合内容路径，但尚不足以保证所有内容在字体、尺寸、加载、展开、返回、状态恢复和交互回写上保持一致。

设计对象提升为“对话内容呈现系统”。Markdown是其中一种阅读方式，iframe是交互页面的隔离载体；两者都不独自承担整套内容模型。延续[开源复用决策](markdown-reuse-review.md)，复用成熟渲染器，设计自己的内容选择、外壳和产品适配合同。

用户提到的ChatGPT智能UI可能涉及交互可视化与Apps两条路径。官方Visualizations介绍图表、地图、计算器和仿真，并提示结果通常是生成时的快照；公开Apps接入采用MCP Apps桥。没有证据表明ChatGPT自有可视化的内部运行时就是对外SDK，也不能由外观推断全部实现。[Visualizations](https://learn.chatgpt.com/docs/visualizations)、[MCP Apps接入](https://developers.openai.com/plugins/build/chatgpt-ui)。更多官方资料及版本边界见[调研附件](interactive-content-research.md)。

## 当前能力与缺口

下表“已有”指本轮读取源码确认，未重新运行对应Electron/浏览器验收。

| 内容或职责 | 已有实现 | 仍需统一/验证 |
| --- | --- | --- |
| 正文、列表、表格、代码 | [MessageResponse](../../clients/gui/renderer/src/components/ai-elements/message.tsx)使用Streamdown，UI包提供MarkdownSurface和阅读组合；CodeViewer/DiffViewer保留宿主偏好 | 缩减重复表格实现；复制、导出、长内容与流式结束后的布局合同 |
| 公式 | 同一正文接入`@streamdown/math`，生产[样式入口](../../clients/gui/renderer/src/styles.css)加载KaTeX CSS | 长公式、矩阵/对齐、未闭合公式、原式复制与辅助阅读；不承诺支持任意LaTeX文档或全部宏包 |
| 图与交互 | 正文接入Mermaid；Gen UI有固定的本地D3等资源 | 静态图与可调参数仿真分开选择；统一文字摘要、数据表/原数据入口和降级 |
| HTML交互回答 | [GenUiWorkspace](../../clients/gui/renderer/src/GenUiWorkspace.tsx)展示iframe；[Main发布适配](../../clients/gui/app/src/core/gen-ui.cjs)核对原消息、制品摘要与owner；Core持有不可变制品 | 通用内容外壳、尺寸/展开、状态与操作入口；当前Gen UI描述符只公布inline能力 |
| 工具应用UI | [McpAppHost](../../clients/gui/renderer/src/McpAppHost.tsx)、[McpAppsWorkspace](../../clients/gui/renderer/src/McpAppsWorkspace.tsx)通过ext-apps桥提供工具结果应用，按宿主能力提供inline/fullscreen | 与Gen UI共享呈现规则，但不合并工具权限或擅自赋予Gen UI工具调用能力 |
| 混合消息 | [Messages](../../clients/gui/renderer/src/Messages.tsx)已经将文字与visualize引用交错渲染；[引用解析](../../clients/gui/packages/gen-ui/references.ts)区分text/ui/pending/invalid，并排除代码区指令 | 分散渲染入口的共同状态、稳定身份与退化规则；不必重写Core历史格式 |
| 交互状态 | [现有契约](../../clients/gui/packages/gen-ui/contract.ts)区分modelContent/privateContent；Desktop按作用域原子保存；追问经过宿主确认 | 明确哪些状态只是阅读，哪些进入下一轮模型上下文，哪些属于权威业务；跨设备持久化尚不是当前能力 |
| 主题和字号 | UI包有Token；[guest运行时](../../clients/gui/packages/gen-ui/guest.ts)可接收`styles.variables`与`zcode/genUiStyles` | 当前Gen UI宿主显式传递light/dark，未查到完整字体/字号/Token主动投影链；iframe不自动继承父页面CSS或React组件 |

Gen UI在已完成的助手消息上解析并核对引用，随后打开已发布制品。它不等同于逐token运行尚未完整的HTML/JavaScript。页面的后续本地交互也不表示模型持续生成新页面。

## 推荐的四层职责

| 层 | 职责和输入 | 现有所有者与建议 |
| --- | --- | --- |
| 内容来源与身份 | 原Project/Thread/Turn/item、制品/工具结果引用与版本、可读摘要 | Core历史、发布和MCP结果保持权威；保留现有摘要校验、token与请求身份 |
| 内容展示与路由 | 决定正文、原生结构化控件或隔离页面；安排宽度、状态和动作 | 在现有Messages/ToolEvent产品适配上整理统一展示合同；只投影视图，不建立第二份持久历史 |
| 渲染适配 | 文本/公式/代码/图形及页面运行时 | Streamdown及插件、CodeViewer、已有React组件、GenUiWorkspace/McpAppHost各管自己的实际渲染 |
| 宿主交互与执行 | 资源打开、状态保存、带上下文追问、工具请求、审批/UNKNOWN与生命周期 | 原renderer/Electron/Core/Runtime；共用UI包只接受展示值和回调，不拥有沙箱、凭据或执行 |

统一的是来源、呈现、状态和动作合同；不要求所有内容使用同一种DOM、协议或运行时。不引入模型可任意指定组件/模块名的动态加载，不将生成JS编译后运行在产品主React树中，不建设通用页面JSON渲染引擎。

### 选择哪种呈现

| 用户目的 | 默认方式 | 何时扩展 |
| --- | --- | --- |
| 阅读解释、公式或短表格 | 原生正文/Streamdown | 长公式和表格仅内容内部横滚，保留全文/原式可访问性 |
| 选择、批准、回答问题、查看固定结构数据 | 已登记的可信React组合 | 数据/动作由现有业务契约绑定；模型文本不能新增批准范围 |
| 调参数、模拟、地图或自由可视化 | 已发布的隔离Gen UI页面 | 空间不足时按宿主实际能力展开；新的显示模式须先补宿主合同 |
| 使用带工具的第三方交互应用 | MCP Apps宿主 | 按实际协商的工具、资源和显示能力工作；保留普通结果退路 |

把一切放进iframe会增加选区、读屏、焦点、缓存和滚动成本；只扩展Markdown插件则不足以承担独立应用状态。推荐上述混合方式。OpenAI公开指南同样区分轻量inline与需要更多空间的体验，建议按最小任务选呈现；具体尺寸和操作数仍以本产品用户路径验证。[官方UI指南](https://developers.openai.com/plugins/concepts/ui-guidelines)。

## 统一设计合同

**内容外壳**：普通正文保持阅读流；需要运行时或异步资源的内容使用轻量外壳，按需提供标题/来源、准备状态、内容区和动作。不要为每段正文加边框或把完整工具日志铺在结果上。预览名称可先用`ContentFrame`，只是候选职责，不表示已新增导出。

**尺寸与返回**：优先使用对话列宽；iframe通过现有尺寸通知上报高度，滚动交给已确认的所有者。高内容进入明确的大视图，返回保留原消息位置、展开状态、键盘焦点与草稿。表格/公式可内部横滚；普通卡片避免双层纵滚。第三方页面是否能自适应必须按能力处理，不能强制假定。

**呈现状态**：统一表达准备中、可读/可交互、只读、不可用及已关闭，内容就绪与业务执行结果分开。流式正文可局部更新；生成页只在引用完整且原制品可验证后挂载。无效引用、撤权、旧epoch或缺资源时保留可读摘要和合法来源入口；“重新查看”读取原结果，不重跑原工具或自动重新生成。

**稳定身份与恢复**：沿用原item/制品/实例身份；文本偏移只用于定位原消息中的引用，不以组件挂载次数或页面位置另建业务主键。折叠与离开视口不等于销毁，关闭与撤权按原宿主释放。缓存与页面上限继续归已有Manager，不为内容组件另建隐藏页面池。跨设备同步单独设计，不能由本机恢复推导出已经支持。

**三类状态**：局部选中/展开由组件或guest拥有；需要恢复的视图状态由现有Desktop/服务持久化；业务数据继续归Core/MCP服务。`modelContent`是向模型披露的明确、有界上下文，`privateContent`保留在UI状态，不自动发送整页DOM、表格全文或私人输入。[官方状态划分](https://developers.openai.com/plugins/build/chatgpt-ui#manage-state)。

**动作等级**：复制、筛选与调参可留在局部；保存视图不触发模型；追问应说明带入哪些选中数据，走原确认/提交链；业务写入走原工具与审批，UNKNOWN不重放。结果内容不能增加宿主权限。审批和Ask User的后续卡片重构复用此合同，但不改变它们各自的合法动作。

**共同主题**：同一Token源生成主界面CSS和guest可消费的语义变量白名单，通过现有host context更新字体、字号、颜色、间距及减少动态效果。不要复制完整宿主CSS或假设跨iframe继承。自定义字体文件须同时满足guest资源和CSP规则，传一个字体名称不保证实际使用同一字体。React组件仍在可信宿主中复用；guest使用适合自身运行时的样式/控件适配。

**可访问与退化**：公式提供原式复制，图表有标题/坐标/单位及文字摘要或数据入口；交互具备键盘焦点、可读状态和减少动态效果。页面失败时正文与原工具结果仍可读。导出/分享仅在实际支持的格式上出现，明确快照与实时数据区别；不将本地计算展示视为已验证事实。

## 公式与科学内容

继续以现有KaTeX链处理常规行内/块级公式、矩阵和对齐，按固定版本支持表评估所需语法；KaTeX不是完整TeX引擎。错误公式保留源码，不让整条消息失败。物理仿真、曲线拖动和参数计算属于可视化/交互层，公式排版、数值计算与执行分别拥有事实。

当前生成页的离线资源清单没有自动提供KaTeX或Mermaid。未来若要在iframe内排公式，应显式选择原生MathML或经过登记的本地数学资源，并验证字体、CSS与可访问输出；不能因为父消息有公式插件，就推定iframe也具备同一能力。确有不支持的宏包/标注需求时再评估MathJax，不提前维护两套默认数学内核。

## 最小落地顺序与验收

当前实现与后续边界如下。新增来源核验见[外部建议复核](native-content-reference-review.md)，区分已发布能力、开放PR和小样本观察。

1. **先做混合内容预览题**：同一回复交错文字、长公式/矩阵、表格、Mermaid、参数可调图、MCP结果入口与失败摘要。先复用现有renderer，不同时更换Markdown内核。
2. **统一轻量外壳和状态**：逐步让GenUiCard与MCP工具结果采用同一展示合同；运行时和执行所有者保持原位。纯外壳及其MD、状态实例可进入`@areal/ui`；不把整个iframe宿主迁进UI包。
3. **补齐Token桥与阅读动线**：验证14/18px、明暗、减少动态效果、宽窄/主聊/Side；容器缩放不撑宽页面，展开返回不丢草稿/焦点，公式与guest字体都实际变化。
4. **按证据收口**：再执行表格上游复用对照；需要新的图表/声明式UI库时，为已确认缺口做单独选型，不新增第二套完整对话SDK。

必须覆盖的验收场景：流式中不完整公式与引用；结束后静态一致；重复打开不重新执行业务；本地调参不请求模型；追问确认与取消、只读/离线/过期实例；privateContent不泄露给模型；重载后恢复；后台/隐藏页面不能提交；撤权与关闭释放；缩放与列表虚拟化保留身份；内容失败仍可读原文。现有[Gen UI验收脚本](../../clients/gui/scripts/gen-ui-smoke.mjs)、[MCP Apps生命周期脚本](../../clients/gui/scripts/mcp-app-lifecycle-smoke.mjs)和设计预览沿用既有入口；首轮实施已复验混合内容、Gen UI主聊/Side及恢复链，未将其等同于全部MCP应用或真实供应商验收。

这条内容系统规范与本轮审批/Ask User共享同一展示边界；字体核对见[记录](codex-typography-review.md)。执行机制继续以[系统架构](../../docs/design/architecture.md)及实际源码为准；本文件不扩展当前权限、协议或Base准入。


## 首轮实现合同

`@areal/ui/content`提供可重建的内容投影、严格校验与`toText`；不成为第二份Core历史。`areal-ui` JSON围栏必须包含`version:1`、`type`和`title`，支持metric、key-value、table、bar-chart、timeline、callout六种只读数据。字段、长度和数量受限；额外动作/样式/URL字段、未知版本或无效数据回退到可展开的原文。普通代码围栏与嵌套示例保持文字，不执行生成脚本。未闭合原生块在流式中占位，结束后仍无效则显示原文入口。

每种原生类型登记校验、文字投影、流式策略和最小占位信息。可信React组件决定DOM，模型字符串只作转义文本。图表数据可展开、内容可复制；没有模型自定义事件、动态模块或工具权限。当前消息复制使用同一投影；Rust/TUI、导出、搜索和模型回放仍消费原始历史，尚未迁入JS注册表，不能声称全部渠道自动采用`toText`。

Messages将Markdown、原生内容和已验证的Gen UI引用交错展示。Gen UI仍要求已完成助手消息与有效制品；MCP Apps沿原工具结果宿主，不经过新的只读数据目录。不新增SDK/依赖，不承诺任意HTML、MathJax或全部TeX宏包。公式开启单美元兼容，保留代码/价格排除；未闭合单美元公式先显示文字。KaTeX沿已有版本提供MathML、mhchem与选区原式复制。

审批初态显示至多三行原因、一行目标和两行命令摘要，完整理由与原始请求默认折叠且始终可查；浏览器、终端、电脑与文件请求共用此规则；批准范围、提交锁和UNKNOWN核对仍由ApprovalRequest管理。Ask User使用包内QuestionCard，一次聚焦一题，选择只修改草稿，明确发送才提交；稍后回答/关闭保留草稿，不伪造Core不支持的跳过。操作页脚在正文滚动区之外。

过程耗时跨语言统一显示`Working for 15m 29s`；普通失败工具不占默认活动列表，过程标题旁只保留一个可查看原始记录的标识，不重复计数文案。结果未知和需要恢复的动作继续可见。断连时不冒充继续精确计时。

预览入口为`design-system.html?content-system`，与生产消费同一组件和投影。所有预览响应仅记录本页调用，不是真实执行。Token桥、iframe完整字体传播、完整跨渠道块协议和真实供应商生成质量评测仍为后续独立范围。
