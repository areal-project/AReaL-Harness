# 对话内容呈现系统：现状与统一设计建议

日期：2026-10-24。状态：首轮实现；新增共享展示投影、六类只读原生内容、审批渐进披露和显式回答。Core历史格式、Gen UI/MCP运行时与执行契约保持原位。验收以对应运行证据为准。

## 结论与范围

现有系统具备承载多种内容的基础：Streamdown正文、公式/图形插件、原生React组合，以及复用MCP Apps宿主的Gen UI页面。当前组件足以组成第一条混合内容路径，但尚不足以保证所有内容在字体、尺寸、加载、展开、返回、状态恢复和交互回写上保持一致。

用户提到的ChatGPT智能UI可能涉及交互可视化与Apps两条路径。官方Visualizations介绍图表、地图、计算器和仿真，并提示结果通常是生成时的快照；公开Apps接入采用MCP Apps桥。没有证据表明ChatGPT自有可视化的内部运行时就是对外SDK，也不能由外观推断全部实现。[Visualizations](https://learn.chatgpt.com/docs/visualizations)、[MCP Apps接入](https://developers.openai.com/plugins/build/chatgpt-ui)。更多官方资料及版本边界见[调研附件](../../../design/archive/content/interactive-content-research.md)。

## 当前能力与缺口

下表“已有”指本轮读取源码确认，未重新运行对应Electron/浏览器验收。

| 内容或职责 | 已有实现 | 仍需统一/验证 |
| --- | --- | --- |
| 正文、列表、表格、代码 | [MessageResponse](../renderer/src/components/ai-elements/message.tsx)使用Streamdown，UI包提供MarkdownSurface和阅读组合；CodeViewer/DiffViewer保留宿主偏好 | 缩减重复表格实现；复制、导出、长内容与流式结束后的布局合同 |
| 公式 | 同一正文接入`@streamdown/math`，生产[样式入口](../renderer/src/styles.css)加载KaTeX CSS | 长公式、矩阵/对齐、未闭合公式、原式复制与辅助阅读；不承诺支持任意LaTeX文档或全部宏包 |
| 图与交互 | 正文接入Mermaid；Gen UI有固定的本地D3等资源 | 静态图与可调参数仿真分开选择；统一文字摘要、数据表/原数据入口和降级 |
| HTML交互回答 | [GenUiWorkspace](../renderer/src/GenUiWorkspace.tsx)展示；[发布适配](../../../services/workbench/src/desktop/core/gen-ui.cjs)核对原消息、制品摘要与owner；Core持有不可变制品 | 内容外壳、尺寸/展开、状态和操作；Gen UI描述符只公布inline能力 |
| 工具应用UI | [McpAppHost](../renderer/src/McpAppHost.tsx)、[McpAppsWorkspace](../renderer/src/McpAppsWorkspace.tsx)通过ext-apps桥提供工具结果应用，按宿主能力提供inline/fullscreen | 与Gen UI共享呈现规则，但不合并工具权限或擅自赋予Gen UI工具调用能力 |
| 混合消息 | [Messages](../renderer/src/Messages.tsx)已经将文字与visualize引用交错渲染；[引用解析](../packages/gen-ui/references.ts)区分text/ui/pending/invalid，并排除代码区指令 | 分散渲染入口的共同状态、稳定身份与退化规则；不必重写Core历史格式 |
| 交互状态 | [现有契约](../packages/gen-ui/contract.ts)区分modelContent/privateContent；Desktop按作用域原子保存；追问经过宿主确认 | 明确哪些状态只是阅读，哪些进入下一轮模型上下文，哪些属于权威业务；跨设备持久化尚不是当前能力 |
| 主题和字号 | UI包有Token；[guest运行时](../packages/gen-ui/guest.ts)可接收`styles.variables`与`zcode/genUiStyles` | 当前Gen UI宿主显式传递light/dark，未查到完整字体/字号/Token主动投影链；iframe不自动继承父页面CSS或React组件 |

Gen UI在已完成的助手消息上解析并核对引用，随后打开已发布制品。它不等同于逐token运行尚未完整的HTML/JavaScript。页面的后续本地交互也不表示模型持续生成新页面。

## 推荐的四层职责

| 层 | 职责和输入 | 现有所有者与建议 |
| --- | --- | --- |
| 渲染适配 | 文本/公式/代码/图形及页面运行时 | Streamdown及插件、CodeViewer、已有React组件、GenUiWorkspace/McpAppHost各管自己的实际渲染 |

### 选择哪种呈现

| 用户目的 | 默认方式 | 何时扩展 |
| --- | --- | --- |
| `R-CONTENT-013` 选择、批准、回答问题、查看固定结构数据 | 已登记的可信React组合 | 数据/动作由现有业务契约绑定；模型文本不能新增批准范围 |

## 统一设计合同

`R-CONTENT-018` **尺寸与返回**：优先使用对话列宽；iframe通过现有尺寸通知上报高度，滚动交给已确认的所有者。高内容进入明确的大视图，返回保留原消息位置、展开状态、键盘焦点与草稿。表格/公式可内部横滚；普通卡片避免双层纵滚。第三方页面是否能自适应必须按能力处理，不能强制假定。

`R-CONTENT-019` **呈现状态**：统一表达准备中、可读/可交互、只读、不可用及已关闭，内容就绪与业务执行结果分开。流式正文可局部更新；生成页只在引用完整且原制品可验证后挂载。无效引用、撤权、旧epoch或缺资源时保留可读摘要和合法来源入口；“重新查看”读取原结果，不重跑原工具或自动重新生成。

`R-CONTENT-020` **稳定身份与恢复**：沿用原item/制品/实例身份；文本偏移只用于定位原消息中的引用，不以组件挂载次数或页面位置另建业务主键。折叠与离开视口不等于销毁，关闭与撤权按原宿主释放。缓存与页面上限继续归已有Manager，不为内容组件另建隐藏页面池。跨设备同步单独设计，不能由本机恢复推导出已经支持。

`R-CONTENT-022` **动作等级**：复制、筛选与调参可留在局部；保存视图不触发模型；追问应说明带入哪些选中数据，走原确认/提交链；业务写入走原工具与审批，UNKNOWN不重放。结果内容不能增加宿主权限。审批和Ask User的后续卡片重构复用此合同，但不改变它们各自的合法动作。

## 公式与科学内容

`R-CONTENT-026` 当前生成页的离线资源清单没有自动提供KaTeX或Mermaid。未来若要在iframe内排公式，应显式选择原生MathML或经过登记的本地数学资源，并验证字体、CSS与可访问输出；不能因为父消息有公式插件，就推定iframe也具备同一能力。确有不支持的宏包/标注需求时再评估MathJax，不提前维护两套默认数学内核。

## 最小落地顺序与验收

当前实现与后续边界如下。新增来源核验见[外部建议复核](../../../design/archive/content/native-content-reference-review.md)，区分已发布能力、开放PR和小样本观察。

`R-CONTENT-028` 必须覆盖的验收场景：流式中不完整公式与引用；结束后静态一致；重复打开不重新执行业务；本地调参不请求模型；追问确认与取消、只读/离线/过期实例；privateContent不泄露给模型；重载后恢复；后台/隐藏页面不能提交；撤权与关闭释放；缩放与列表虚拟化保留身份；内容失败仍可读原文。现有[Gen UI验收脚本](../scripts/gen-ui-smoke.mjs)、[MCP Apps生命周期脚本](../scripts/mcp-app-lifecycle-smoke.mjs)和设计预览沿用既有入口；首轮实施已复验混合内容、Gen UI主聊/Side及恢复链，未将其等同于全部MCP应用或真实供应商验收。

这条内容系统规范与本轮审批/Ask User共享同一展示边界；字体核对见[记录](../../../design/archive/content/codex-typography-review.md)。执行机制继续以[系统架构](../../../docs/design/architecture.md)及实际源码为准；本文件不扩展当前权限、协议或Base准入。

## 首轮实现合同

原生内容的围栏、校验、回退和跨渠道边界由[NativeContent 合同](../packages/ui/src/conversation/native-content/native-content.md#围栏历史与跨渠道边界)维护。

Messages 的混合投影和公式边界见[消息合同](../renderer/src/Messages.md#混合内容与过程标题)。

审批摘要、完整原文与页脚由[DecisionCard](../packages/ui/src/conversation/decision-card/decision-card.md#行为)定义；逐题选择、明确发送和草稿由[QuestionCard](../packages/ui/src/conversation/question-card/question-card.md#行为)定义。

过程标题、失败工具与断连显示见[消息合同](../renderer/src/Messages.md#混合内容与过程标题)。

预览入口为`design-system.html?content-system`，与生产消费同一组件和投影。所有预览响应仅记录本页调用，不是真实执行。Token桥、iframe完整字体传播、完整跨渠道块协议和真实供应商生成质量评测仍为后续独立范围。
