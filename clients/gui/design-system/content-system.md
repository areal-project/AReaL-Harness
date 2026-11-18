# 对话内容呈现系统：现状与统一设计建议

本文维护对话正文、只读原生内容、审批和问答的呈现合同。

## 结论与范围

对话以 Streamdown 呈现正文、公式和图形。只读结构化内容、审批与问答由原生 React 组件渲染。

## 当前能力与缺口

下表“已有”指本轮读取源码确认，未重新运行对应Electron/浏览器验收。

| 内容或职责 | 已有实现 | 仍需统一/验证 |
| --- | --- | --- |
| 正文、列表、表格、代码 | [MessageResponse](../renderer/src/components/ai-elements/message.tsx)使用Streamdown，UI包提供MarkdownSurface和阅读组合；CodeViewer/DiffViewer读取宿主偏好 | 缩减重复表格实现；复制、导出、长内容与流式结束后的布局合同 |
| 公式 | 同一正文接入`@streamdown/math`，生产[样式入口](../renderer/src/styles.css)加载KaTeX CSS | 长公式、矩阵/对齐、未闭合公式、原式复制与辅助阅读；不承诺支持任意LaTeX文档或全部宏包 |
| 图与交互 | 正文接入Mermaid | 静态图与可调参数仿真分开选择；统一文字摘要、数据表/原数据入口和降级 |
| 混合消息 | [Messages](../renderer/src/Messages.tsx)将正文与只读结构化内容块交错渲染；[内容投影](../renderer/src/conversationContent.ts)统一区分markdown/native/pending/unsupported | 分散渲染入口的共同状态、稳定身份与退化规则 |
| 交互状态 | 追问、批准与问答走宿主确认/提交链 | 阅读状态、模型上下文、业务状态与跨设备持久化 |
| 主题和字号 | UI包有Token | 统一字体/字号/Token投影 |

## 推荐的四层职责

| 层 | 职责和输入 | 现有所有者与建议 |
| --- | --- | --- |
| 渲染适配 | 文本/公式/代码/图形 | Streamdown及插件、CodeViewer、已有React组件各管自己的实际渲染 |

### 选择哪种呈现

| 用户目的 | 默认方式 | 何时扩展 |
| --- | --- | --- |
| `R-CONTENT-013` 选择、批准、回答问题、查看固定结构数据 | 已登记的可信React组合 | 数据/动作由现有业务契约绑定；模型文本不能新增批准范围 |

## 统一设计合同

`R-CONTENT-018` 尺寸与返回。优先使用对话列宽。高内容进入大视图，返回时恢复原消息位置、展开状态、键盘焦点与草稿。表格和公式可内部横滚，普通卡片使用外层纵向滚动。

`R-CONTENT-019` 呈现状态。统一表达准备中、可读/可交互、只读、不可用及已关闭，内容就绪与业务执行结果分开。流式正文可局部更新。引用失效或资源不可用时保留可读摘要及可访问的来源。重新查看读取原结果。

`R-CONTENT-020` 稳定身份与恢复。沿用原条目或制品身份，文本偏移用于定位原消息中的引用。折叠和离开视口保留阅读状态，关闭与撤权由原所有者释放。

`R-CONTENT-022` **动作等级**：复制、筛选与调参可留在局部；保存视图不触发模型；追问应说明带入哪些选中数据，走原确认/提交链；业务写入走原工具与审批，UNKNOWN不重放。结果内容不能增加宿主权限。审批和Ask User的后续卡片重构复用此合同，但不改变它们各自的合法动作。

## 最小落地顺序与验收

`R-CONTENT-028` 内容阅读验收覆盖流式正文中的未闭合公式和围栏、流结束后的阅读状态，以及查看失败时的反馈和恢复。图形通过缩放、拖动与返回验证，表格通过原始 Markdown 复制、键盘横滚与 CSV 下载验证。图表场景见[内容阅读验收](../scripts/conversation-content-reading-smoke.mjs)。

## 首轮实现合同

原生内容的围栏、校验、回退和跨渠道边界由[NativeContent 合同](../packages/ui/src/conversation/native-content/native-content.md#围栏历史与跨渠道边界)维护。

Messages 的混合投影和公式边界见[消息合同](../renderer/src/Messages.md#混合内容与过程标题)。

审批摘要、完整原文与页脚由[DecisionCard](../packages/ui/src/conversation/decision-card/decision-card.md#行为)定义；逐题选择、明确发送和草稿由[QuestionCard](../packages/ui/src/conversation/question-card/question-card.md#状态)定义。

过程标题、失败工具与断连显示见[消息合同](../renderer/src/Messages.md#混合内容与过程标题)。

预览入口为 `design-system.html?content-system`，使用生产组件和投影。预览响应由本地夹具提供。
