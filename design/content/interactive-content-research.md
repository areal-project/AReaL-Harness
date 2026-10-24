# 对话交互内容：官方资料调研

调研日期：2026-10-24。本文只整理外部一次来源与设计推论，没有安装依赖、运行兼容性试验或修改生产实现。本仓现有能力由后续本地源码评估确认；官方文档不能证明本仓已实现相同协议。

## 先区分三种能力

| 路径 | 官方已公开的事实 | 对本项目的含义 |
| --- | --- | --- |
| ChatGPT动态视觉解释 | OpenAI在2026-03-10发布数学/科学互动解释，初始覆盖70多个概念，允许改变变量观察公式、图与结果。[发布公告](https://openai.com/index/new-ways-to-learn-math-and-science-in-chatgpt/) | 可参考“解释文字＋可操作模块”的产品模式；公告没有公开其内部运行时，不能据此认定就是Apps SDK或可直接嵌入第三方产品 |
| ChatGPT Visualizations | 当前官方使用文档列出图表、地图、图解、计算器、仿真与交互解释；预览可用性取决于账户和平台。结果通常是生成时的信息快照，不是始终同步的数据看板。[官方使用文档](https://learn.chatgpt.com/docs/visualizations) | 用户所指“新智能UI”的具体公告仍不确定；统一设计应覆盖这类结果，不承诺复刻ChatGPT未公开能力 |
| MCP Apps/原Apps SDK组件 | MCP工具可以关联HTML UI资源，在iframe中通过标准桥与宿主通信；OpenAI建议新UI优先使用MCP Apps标准，ChatGPT专有能力才使用`window.openai`。[官方接入文档](https://developers.openai.com/plugins/build/chatgpt-ui)、[扩展参考](https://developers.openai.com/plugins/reference) | 这是可复用的公开集成路径。iframe只是运行载体，完整方案还包括资源发现、协议、权限、状态、布局和生命周期 |

因此，不应把“模型生成HTML”“符合MCP Apps的工具UI”“ChatGPT自有互动模块”视为完全等价的对象，也不应推导出所有内容都必须通过iframe显示。

## 声明式组件是另一条成熟路线

OpenAI ChatKit允许后端返回由`WidgetRoot/WidgetNode`组成的JSON描述，例如Card、ListView、Text、Button和Form；按钮/表单绑定`ActionConfig`，经客户端或服务端处理动作，也可更新组件或触发后续流式结果。[Widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets)、[Actions](https://developers.openai.com/api/docs/guides/chatkit-actions)

| 路线 | 约束与收益 | 本项目建议 |
| --- | --- | --- |
| 受控组件描述/Schema | 描述选用已知节点和动作，渲染器拥有可用能力；易统一Token、键盘和常见表单，扩展自由度取决于支持的节点 | 借鉴其“受控组件＋显式动作”模型；以后有重复的结构化结果卡片需求时再做最小映射，不先自建万能页面DSL |
| MCP Apps隔离HTML | 开发者提供更自由的Web UI，经标准桥请求宿主能力；需要单独处理隔离、协议和生命周期 | 继续承接已有Gen UI/MCP Apps交互画布，与原生阅读器并存 |
| 整套ChatKit集成 | 包含聊天UI、线程/会话和服务端集成；官方提供自有服务器接入路线 | 目前没有替换现有桌面对话/Core栈的需求或兼容性证据；只借鉴内容组织和动作契约，不把接入整套ChatKit当作统一渲染的前提。[官方接入](https://developers.openai.com/api/docs/guides/chatkit) |

这里“受控Schema由宿主渲染”是结构性比较；ChatKit提供自己的运行组件，不等于它的JSON可以直接驱动本仓任意React组件，也不证明本仓已经支持ChatKit协议。

## 公开协议中值得保留的边界

MCP Apps稳定规范标记为`2026-01-26`；本次官方仓库`package.json`显示`@modelcontextprotocol/ext-apps`为2.0.3、MIT，提供View端`App`和Host端`AppBridge`等公开入口。规范版本与npm包版本是不同维度，实施时按固定版本类型验证。[稳定规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)、[SDK包元数据](https://github.com/modelcontextprotocol/ext-apps/blob/main/package.json)

### 内容、模型上下文与状态分开

OpenAI的工具结果区分三种载荷：`structuredContent`用于结构化结果，`content`用于可读结果，二者可交给模型和组件；`_meta`只交给组件，不出现在模型可见的对话结果中。后者只是可见性隔离，不应当作凭据保管机制。[工具结果参考](https://developers.openai.com/plugins/reference)

业务数据的权威归服务端；选中行、折叠和草稿筛选等临时状态归UI；跨会话数据需要明确持久化所有者。`window.openai.widgetState/setWidgetState`是ChatGPT提供的可选组件状态机制，不能由此推断任意宿主都提供同样的持久化保证。标准`ui/update-model-context`与发送新消息是不同动作；前者表达供后续轮次使用的上下文，而不应把每次滑块变化变成新的用户请求。[官方状态指导](https://developers.openai.com/plugins/build/chatgpt-ui)、[MCP Apps通信规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

### 宿主决定能力和承载空间

标准协议提供host context、能力协商、大小变化和展示模式请求；模式包括inline、fullscreen、PiP，但需要双方声明支持。主题、尺寸等通过上下文与通知传递，组件不能假设自己控制整个聊天窗口。标准主题变量可通过`hostContext.styles.variables`传入，字体也有明确传递机制；Host缺省值与View回退须配套。[主题与容器规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

普通iframe本身不构成资源授权。稳定规范对Web宿主规定不同origin的sandbox proxy、受约束CSP和桥接流程；Desktop/Native的承载路径另有说明。不能只看到`sandbox`属性便判断某个Electron或Web集成已经完整满足规范。[隔离要求](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

工具调用、消息、下载/外链等请求应交回宿主；公开桥的存在不应绕过本项目原有审批、真实服务权限和UNKNOWN恢复语义。OpenAI还明确说明，需审批工具的参数可能在批准后才送达UI，初始缺少参数应作为合法等待状态处理。[审批与桥参考](https://developers.openai.com/plugins/reference)

## 公式和图解优先复用成熟渲染器

| 内容 | 复用方向 | 需要设计的部分 |
| --- | --- | --- |
| 行内/块级公式 | Streamdown官方math插件使用remark-math与rehype-katex，并依赖KaTeX样式；文档说明其不完整公式流式处理。[插件文档](https://streamdown.ai/docs/plugins/math) | 分隔符约定、未完成/无效公式、字号、长公式横滚、复制源式与可读文本回退；按本仓锁定版本检查，不直接照最新网页写API |
| 公式可访问性 | KaTeX默认`htmlAndMathml`输出同时提供视觉HTML和MathML，`trust`默认false；可按具体需要控制命令。[KaTeX选项](https://katex.org/docs/options) | 保留MathML，避免无必要扩大trust；若确有更强数学语义导航/语音需要，再对照MathJax的可访问性扩展，而非先并装第二套内核。[MathJax可访问性](https://docs.mathjax.org/en/latest/basic/accessibility.html) |
| 文字定义的流程图/时序图 | 已有Streamdown Mermaid插件提供图解、主题和交互控件。[插件文档](https://streamdown.ai/docs/plugins/mermaid) | 统一缩放、查看源码、展开/导出策略及错误降级，避免插件默认控件与产品策略重复 |
| 滑块实验、交互曲线或计算器 | 属于可执行互动内容，可放入受控Gen UI/MCP Apps承载 | 数据与计算来源、单位、默认值、重置、暂停、键盘、结果解释与持久化；静态公式排版库不会自动提供这些产品行为 |

这说明“公式支持”和“智能互动支持”应分别验收：能排出公式，不代表已具备可交互计算、可信数据更新或安全动作回写。

## 统一设计建议

以下是基于上述资料的项目设计推论，不是上游已经替本项目完成的功能：

1. **统一内容外壳，保留专用渲染器。** 文字/公式/表格采用成熟原生阅读链；可执行UI采用受控宿主。外壳统一标题、来源、生成/加载/失败状态、展开和文本回退，不建设一个执行任意模型JSX的万能组件。
2. **共同定义三类状态。** 内容快照与版本、用户呈现状态、真实业务结果分别有所有者。明确历史重新打开恢复什么；失效引用和静态快照不能伪装为实时数据。
3. **交互意图经宿主执行。** 本地筛选/滑块不必触发模型或工具；发消息、修改服务数据、打开外链/文件分别走已有授权入口。审批和UNKNOWN不能退化为iframe内部的普通按钮状态。
4. **统一显示与阅读契约。** 默认最小inline展示，扩大空间需能力协商；深色/字号/字体、宽窄尺寸、内部滚动和聊天阅读锚点共同验证。跨iframe传递Token通过公开host context适配，不能依赖宿主CSS穿透。
5. **把失败和不可交互结果纳入设计。** 加载、禁止、失效、离线、历史只读均有可读说明；保留文本摘要、数据来源和适当的静态替代。避免卡片不可用时整段回答变空。

## 最小验证题

以一条回答混排“解释文字＋公式＋表格＋Mermaid＋交互曲线”，验证下列路径即可开始判断设计是否足够；不要先穷举所有图表类型：

- 流式未结束、无效公式、iframe加载失败，各自局部降级，正文和来源仍可阅读。
- 420px/宽容器、14/18px与明暗切换；公式和表格在内容内横滚，iframe尺寸变化不把用户拉离阅读位置。
- 键盘进入交互模块、重置参数、展开后返回；焦点和本地呈现状态明确恢复。
- 改变滑块只改变本地结果；显式“继续讨论/应用”才经宿主进入模型或真实服务动作，取消和UNKNOWN均不重发。
- 切会话、历史返回、reload和后台隐藏；分别核对快照、持久状态、运行资源回收与动画暂停。
- 无网络/失效引用/没有相应能力的宿主，仍保留文字摘要和数据；模型只接收有意提供的上下文，不把组件私有元数据全部塞进对话。

本轮尚未运行以上验证，也未查证ChatGPT自有互动模块的内部实现。本文支持把设计范围从单一Markdown扩展为对话内容呈现系统，不证明现有组件已经完全足够；本地实现与缺口判断由源码评估另行给出。
