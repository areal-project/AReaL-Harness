# 原生内容目录：外部建议核验与实施边界

查阅日期：2026-10-24。本页核对用户提供的外部建议，区分官方事实、未合并方案和本项目设计取舍。仅外部资料与源码阅读，未安装LobeHub、运行漏洞验证或修改生产实现；本项目当前能力仍见[对话内容呈现系统](conversation-content-system.md)。

## OpenAI Intelligent UI：发布和内部机制已获证实

OpenAI于**2026-10-07**发布《GPT‑6 and Intelligent UI for everyone》。官方明确描述：模型组合文字、视觉与交互元素；内部使用可流式呈现的原生组件库，以及在生成过程中处理界面的编译器。它还强调，当文字最有用时应给出简单文字回答，并对清晰度、用途和完整性进行评估。[官方发布页](https://openai.com/index/gpt-6-for-everyone/#how-intelligent-ui-works)

这比“可能只是Visualizations”更具体，后续设计应纳入该已发布方向。但**该公告没有给出可安装的Intelligent UI原生组件库、编译器包或完整模型输出Schema**；本轮官方检索也没有找到可据此直接接入本仓的对应公开SDK。不能把ChatGPT内部机制当成已经可复用的依赖。公开的[MCP Apps接入](https://developers.openai.com/plugins/build/chatgpt-ui)与[ChatKit Widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets)仍是分别核对的公开方案，不应冒充该内部组件库。

可采纳：受控内容组件、渐进呈现、最小够用的格式、清晰度评测。不照搬：未公开协议、模型训练结论或全部产品能力；不因为这次发布就替换当前Core/Runtime与桌面对话栈。

## LobeHub：不能把三个并存机制写成已完成的线性替代

本轮固定阅读canary快照`c03f40b479e47004d1643ee9d844dbc91b710dcb`，另单独阅读未合并的visual PR快照。源码与提案状态分别如下：

| 机制 | 本轮证实的来源与事实 | 可采纳之处 |
| --- | --- | --- |
| 标签式Artifacts | 旧版通过`lobeArtifact`标签识别制品；当前快照仍保留Markdown的LobeArtifact插件和独立Artifacts入口。[固定源码](https://github.com/lobehub/lobehub/tree/c03f40b479e47004d1643ee9d844dbc91b710dcb/src/features/Conversation/Markdown/plugins/LobeArtifact) | 标签协议可映射到受管制品；识别标签不意味着可以把其内容注入宿主DOM |
| `visual` JSON DSL | [PR #21176](https://github.com/lobehub/lobehub/pull/21176)在本次查阅时为**open、未合并**，head为`f1c967ed9445c7433ee4d151f7200707b496b4a8`；不能当作已发布的稳定功能 | 固定数据类型、schema校验、主题映射及失败保留源码，适合作为设计参考 |
| Canvas组件页面 | 当前快照有Canvas创建/更新/读取、项目文件与版本机制；组件Schema使用`lobe-`前缀，含Flex、Grid、Card、Tabs等，校验器检查组件、属性与部分设计约束。[组件目录](https://github.com/lobehub/lobehub/blob/c03f40b479e47004d1643ee9d844dbc91b710dcb/packages/canvas/src/schema/components.ts)、[校验器](https://github.com/lobehub/lobehub/blob/c03f40b479e47004d1643ee9d844dbc91b710dcb/packages/canvas/src/validate/html.ts)、[工具职责](https://github.com/lobehub/lobehub/blob/c03f40b479e47004d1643ee9d844dbc91b710dcb/packages/builtin-tool-canvas/src/systemRole.ts) | 可执行页面可以使用宿主提供的组件语义与Token；页面资源、发布版本及执行边界另有所有者 |

另一个已合并提交将“解释类视觉默认放inline，用户要保留/迭代的交付物用Artifact”写入技能。这里的inline是完整HTML代码块预览，并非原生组件渲染。[固定提交cadf0f0](https://github.com/lobehub/lobehub/commit/cadf0f0224461279c66bb03919afb29449ae1314)

### visual提案中真正实现了什么

提案提供`stats`、`bars`、`compare`、`steps`、`timeline`、`line`六种数据块；Zod按`type`区分并校验数据，JSON解析失败返回错误，不执行模型脚本。渲染器将数据转换成主题匹配的HTML，所有模型文本经过HTML转义。[固定Schema](https://github.com/lobehub/lobehub/blob/f1c967ed9445c7433ee4d151f7200707b496b4a8/src/features/Conversation/Markdown/plugins/LobeVisual/schema.ts)、[固定文档构建器](https://github.com/lobehub/lobehub/blob/f1c967ed9445c7433ee4d151f7200707b496b4a8/src/features/Conversation/Markdown/plugins/LobeVisual/buildDocument.ts)

**它目前仍使用`HtmlPreviewIframe`呈现**，不是已接入宿主React的原生六组件。生成中且JSON尚不能解析时显示骨架，生成完成仍失败时显示JSON源码；合法数据可生成预览。[固定Render实现](https://github.com/lobehub/lobehub/blob/f1c967ed9445c7433ee4d151f7200707b496b4a8/src/features/Conversation/Markdown/plugins/LobeVisual/Render.tsx)

“单一事实问题三次中两次仍生成KPI卡”确实出现在该PR的Known gaps，但属于作者在特定模型和少量产品试验中的自报结果；不能外推为所有模型的统计结论。其价值在于提示我们把“该用纯文本时不生成卡片”纳入验收，而不是默认全局注入同一份提示或强制每次输出图表。[PR试验与缺口](https://github.com/lobehub/lobehub/pull/21176)

据此，T0/T1/T2/T3可以作为项目沟通标签，不能当成严格的行业分层标准。**内容表示**（文字、受控数据、任意页面）与**运行载体**（宿主DOM、隔离iframe、带服务的应用）是两条轴：受控数据也可能暂时用iframe呈现，MCP Apps也常用iframe。实施时分别声明这两种事实。

## CVE-2025-59417：两道边界的共同失守

GitHub Reviewed Advisory **GHSA-m79r-r765-5f9j**明确标记`@lobehub/chat <=1.129.3`受影响，`1.129.4`修复。根因链是：聊天中的SVG制品被不安全地写入宿主页面产生XSS，继而调用没有充分验证的外链打开特权接口，升级为本机代码执行。[权威Advisory](https://github.com/advisories/GHSA-m79r-r765-5f9j)、[修复提交9f044ed](https://github.com/lobehub/lobehub/commit/9f044ed)

本页不复述利用载荷，也不据此声称AReaL已经存在同样漏洞。对本项目可直接采用的检查是：

1. 数据型原生块只接受有界、明确的数据字段；文本经React等安全文本路径呈现，不让模型指定原始HTML、事件处理器、CSS脚本或任意模块名。
2. 自由HTML/SVG需要独立受控的资源与执行路径；“来自模型”“已做schema校验”都不自动赋予宿主DOM可信度。
3. 特权请求在实际宿主边界逐项校验来源、所属对象、参数与允许动作；外链、文件与工具操作不因为一个页面按钮而获得额外权限。
4. `toText`、复制、搜索和分享属于文本投影，不执行页面代码，不把仅供组件的私有元数据自动发送给模型。

一处`dangerouslySetInnerHTML`的存在本身不足以判定漏洞，必须追踪输入来源、消毒/隔离、可执行上下文与可到达的宿主能力；同样，看到iframe或关闭某个属性也不能替代实际边界核对。

## 对本轮实施的建议

- 统一登记schema、渲染入口、文字降级、加载/流式行为和动作能力，但把不依赖React的契约与文本投影放到共享中立所有者，不让Core反向依赖UI组件。
- 历史与制品继续拥有原身份；统一投影可以先适配既有消息，不必先重写所有存储格式。原生内容和Gen UI不各自宽松识别同一段正文。
- 首批优先只读、有高频用途的原生数据组件；审批/Ask User是已有权威交互的外观重构，不是模型数据块可以临时扩展的授权机制。
- 对未知类型、错误JSON、过长数据、未闭合流式块保留可读降级，失败不能使整条回复消失。验证复制与文本消费者，而不只看浏览器外观。
- 原生目录解决常见结构化阅读，自由交互页面继续复用已有宿主。不能凭“有统一注册表”就宣称所有TUI、搜索、分享和模型回放已自动接入；这些是真实消费者，需要分别接线与验收。

公式和ZCode单美元行为由本项目的本地源码核对补充，本轮不替代该核对。MathML、化学式扩展等能力按固定数学库与明确需求验证，不将建议清单当作已实现事实。
