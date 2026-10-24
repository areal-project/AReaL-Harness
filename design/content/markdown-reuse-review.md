# Markdown 开源复用调研与建议

调研日期：2026-10-24。结论状态：选型建议，尚未进行替换试点、升级或性能对比。本次只读取当前源码、已安装包与官方资料，没有安装候选依赖或改变生产渲染。

本评估是[对话内容呈现系统](conversation-content-system.md)中的正文子系统。Gen UI、MCP Apps、公式与交互可视化的共同容器、状态和动作合同由该文统一设计；表格试点放入混合内容验收，不把Markdown当作全部内容的唯一入口。

## 建议决策

**继续采用 Streamdown，减少自行维护的呈现组件；不自建 Markdown 解析器。** 优先使用上游内建的正文、表格和交互控件，通过 Token、CSS 和公开配置调整外观。AReaL 只保留链接/媒体授权、代码偏好、资源阅读和必要的产品适配。

下一步先在设计系统做一个表格复用对照题，验证能否移除大部分现有 `MarkdownTable`。无需先把正文换成另一套解析生态。`react-markdown`作为静态内容备选；XMarkdown作为有实际缺口时的流式备选；AI Elements/shadcn主要提供组合参考，复制它的源码仍需要我们维护。

## 当前实际基线

当前已经复用了开源内核，待评估的是外围自有代码量，而非是否从零开始解析Markdown。

| 职责 | 当前实现与版本 | 事实来源 |
| --- | --- | --- |
| 正文与流式处理 | `streamdown` 2.6.0；`MarkdownSurface`包裹实际Streamdown，生产`MessageResponse`传入插件与元素覆盖 | [workspace依赖](../../clients/gui/packages/ui/package.json)、[渲染表面](../../clients/gui/packages/ui/src/conversation/markdown-surface/markdown-surface.tsx)、[生产适配](../../clients/gui/renderer/src/components/ai-elements/message.tsx) |
| 中文、数学与图 | `@streamdown/cjk`、`@streamdown/math`、`@streamdown/mermaid`已接入；静态/streaming模式分开 | [生产适配](../../clients/gui/renderer/src/components/ai-elements/message.tsx)、[renderer依赖](../../clients/gui/renderer/package.json) |
| 代码与Diff | `@pierre/diffs` 1.4.3、Shiki 4.4.3；宿主注入保存的代码偏好，继续承担批注与阅读需要 | [CodeViewer适配](../../clients/gui/renderer/src/components/ui/code-viewer.tsx)、[DiffViewer适配](../../clients/gui/renderer/src/components/ui/diff-viewer.tsx)、[包依赖](../../clients/gui/packages/ui/package.json) |
| 表格 | 约1411行自有呈现、测量与交互实现，包括复制Markdown、导出CSV、预览对话框、扩展横滚、虚拟滚动条与位置观察 | [MarkdownTable](../../clients/gui/packages/ui/src/conversation/markdown-table/markdown-table.tsx)；行数为调研时快照，不作为维护指标 |
| 真实资源边界 | `a`由宿主分流外部URL与文件阅读；`img`交给`onRenderImage`，精确`areal://blob/…`由原授权读取链处理；插件标签与相对文件链接有产品转换 | [MessageResponse](../../clients/gui/renderer/src/components/ai-elements/message.tsx) |

当前代码存在一处值得在试点中消除的重复策略：[STREAMDOWN_CONTROLS](../../clients/gui/renderer/src/components/ai-elements/streamdown-controls.ts)关闭了表格fullscreen，并写明避免打断阅读；自有`MarkdownTable`仍无条件提供预览按钮和Dialog。配置只控制上游默认实现，不能自动约束被完全覆盖的自有表格。这说明把功能移入包不等于已减少维护成本。

源码保留ZCode与Vercel来源说明，许可沿[第三方声明](../../clients/gui/THIRD-PARTY-NOTICES.md)和[ZCode许可](../../clients/gui/renderer/ZCODE-LICENSE)。包化时仍需保留这些来源。

## 候选比较

版本与文档均在本次日期核对；`main`和“Latest”资料会变化，以下不把它们冒充当前锁定包的API。

| 候选 | 固定观察版本/来源 | 能直接复用什么 | 对本项目的代价与结论 |
| --- | --- | --- | --- |
| **Streamdown** | 本地2.6.0；官方已发布2.7.1；Apache-2.0；React peer包含18/19 | 流式与未闭合内容处理、GFM、元素覆盖、表格复制/导出/全屏配置，以及独立CJK、math、mermaid插件 | 已接入且扩展模型与现有适配一致，建议继续采用。先减少覆盖；升级2.7.1单独评估，不能混进组件文件移动。[2.6.0源码](https://github.com/vercel/streamdown/blob/streamdown%402.6.0/packages/streamdown/index.tsx)、[2.7.1包](https://github.com/vercel/streamdown/blob/streamdown%402.7.1/packages/streamdown/package.json)、[发布记录](https://github.com/vercel/streamdown/releases) |
| **react-markdown + remark/rehype** | 10.1.0；MIT；React peer为>=18 | 稳定的Markdown→React AST管线、公开组件映射与插件；GFM、数学等按需配置；HTML策略可控 | 适合静态文档。未在本轮查证等价的内建未闭合流式修复与交互工具栏；换用它会重新组合当前已用的能力，不建议为减代码而立即换内核。[官方README](https://github.com/remarkjs/react-markdown)、[包与版本](https://github.com/remarkjs/react-markdown/blob/10.1.0/package.json) |
| **Ant Design X XMarkdown** | 官方文档/仓库包2.9.0；MIT；React/ReactDOM peer为>=18 | 基于marked的流式渲染、组件映射、插件和主题；官方说明支持公式、高亮、mermaid；包依赖包含DOMPurify，主包不要求安装整套antd | 合理流式备选。需要重接组件映射、消毒/URL策略和Token样式；当前没有必须换生态的实测缺口。CJK边界、现有批注/表格行为及嵌套工作台阅读须实际验证。[介绍](https://x.ant.design/x-markdowns/introduce/)、[包与许可](https://github.com/ant-design/x/blob/main/packages/x-markdown/package.json)、[公开接口](https://github.com/ant-design/x/blob/main/packages/x-markdown/src/XMarkdown/interface.ts) |
| **AI Elements / shadcn组合** | 非单一稳定Markdown npm运行包；源码复制模式；旧AI Elements仓库Apache-2.0 | 消息、工具、引用、输入区与代码块等组合参考；原Message也基于Streamdown | 适合按需采纳组合，不会自动替我们维护复制后的实现。当前官方宣布原AI Elements迁入shadcn/ui、旧项目预计2026年11月底废弃；新方案应核对新来源，不能重新深度复制旧目录。[Message公告](https://elements.ai-sdk.dev/components/message)、[新模式与迁移说明](https://ui.shadcn.com/docs/ai-elements)、[原许可](https://github.com/vercel/ai-elements/blob/main/LICENSE) |

这里的“支持React19”指依赖声明覆盖或官方源码采用，**不代表已在本仓验证了对应候选的真实用户路径**。本轮没有基于星数、宣传跑分或示例外观选择方案。

## 为什么优先缩减现有覆盖

Streamdown官方说明：`components`会完全替换内建组件及其样式；仅调整外观时优先通过`data-streamdown`选择器，或在支持版本中组合公开默认组件。表格内建交互已提供复制/导出等能力，因此通用表格工具栏与转换逻辑不应默认由我们重复实现。[组件扩展](https://streamdown.ai/docs/components)、[交互](https://streamdown.ai/docs/interactivity)

需要注意版本差异：本地2.6.0声明文件没有导出`defaultComponents`，但已有`TableCopyDropdown`、`TableDownloadButton`、`TableDownloadDropdown`和表格数据转换辅助。2.7.1固定源码才确认公开导出`defaultComponents`。因此2.6.0试点应从**撤掉表格相关覆盖，使用内建渲染**开始；不要根据最新版网页向旧包写不存在的导入，也不要深导入未公开内部文件。[2.6.0入口](https://github.com/vercel/streamdown/blob/streamdown%402.6.0/packages/streamdown/index.tsx)、[2.7.1入口](https://github.com/vercel/streamdown/blob/streamdown%402.7.1/packages/streamdown/index.tsx)

中文也已有专门上游实现：`@streamdown/cjk`处理中文标点附近的强调和自动链接边界，生产已接入；没有依据另写同义修复器。[CJK插件](https://streamdown.ai/docs/plugins/cjk)

## 哪些适配仍应保留

| 内容 | 建议所有者 | 理由 |
| --- | --- | --- |
| Markdown语法、GFM、未闭合片段修复、普通表格渲染与复制/导出 | 上游Streamdown及插件 | 通用能力，优先配置而非复制源码 |
| 正文字体、标题层级、间距、表面和控件外观 | `@areal/ui` Token与少量有范围CSS | 保持AReaL/Codex参考视觉，同时能够更新上游 |
| 外链打开、文件链接、blob媒体、权限与真实读取 | renderer原产品适配 | 渲染库不能成为资源访问或执行权威 |
| 已保存代码主题/字号、批注和Diff阅读 | 现有CodeViewer/DiffViewer适配 | 属于已存在的产品阅读行为；是否替换代码块另做范围受控的对照 |
| 表格向消息列外借位、跟随长页面的虚拟横向滑块 | 暂不扩写；先确认保留价值 | 本轮未查证上游具备等价行为；也没有依据把它当成不可取消的硬要求。应比较普通内部横滚/上游全屏是否足够，再决定是否留下小型独立增强 |

任何候选的默认安全处理都不等于AReaL资源授权。Streamdown允许配置消毒、协议和URL范围；覆盖`rehypePlugins`会替换默认数组，需要保留消毒链。当前`linkSafety.enabled=false`伴随宿主链接按钮与媒体读取适配，重构时须整体验证，不能只抄一项布尔值。[官方安全说明](https://streamdown.ai/docs/security)

## 最小试点与决策门槛

先只在设计系统建立同输入双栏：A为当前表格，B为固定2.6.0的上游内建表格，二者使用相同外观Token与真实生产链接/媒体适配；保留当前代码块与完整产品页面。试点不同时升级内核、换主题和改产品流程。

1. **文字/流式**：逐段送入未闭合强调、代码围栏、链接、GFM表格、中文标点/长URL；结束后与完整静态内容一致，复制内容完整。
2. **表格**：420px与宽容器、14/18px、明暗主题，长列/长行、复制Markdown/CSV导出；先核对真实公开配置，避免自有预览绕过`fullscreen=false`。页面不得横向撑宽，内部横滚可达。
3. **阅读稳定性**：主聊、Side、嵌套滚动/虚拟消息、历史返回和容器缩放；比较滚动跳变与重复挂载。上游宣传性能不能替代此观察。
4. **资源边界**：普通外链、相对文件、有效/失效blob、自定义协议和不可信HTML；由原宿主作出相同打开/拒绝决定，不新增自动网络读取或执行。
5. **收口**：若B满足已确认需求，删除被替代的表格测量、工具栏和转换实现，不长期保留两个生产渲染器。若只缺粘性横滚，先写清必需用户路径，再决定最小增强；有充分缺口才评估XMarkdown。

另开一个升级对照时再固定Streamdown 2.7.1及兼容插件版本，核对lockfile、变更说明、引用链接与中文处理；不因版本较新直接认为应该升级。普通正文与解析内核继续上游复用，`@areal/ui`中的Markdown入口保持薄适配和可替换性。

## 本轮未完成的验证

没有运行候选安装、同输入浏览器对照、长文性能/内存测量或真实Electron验收；未证明能删除全部1411行，也未证明所有现有表格增强都有必要保留。XMarkdown的中文边界与本仓权限映射尚未验证；当前官方文档会更新，实施时必须复查固定版本的公开类型与源码。本文支持“保留Streamdown并优先缩减自有覆盖”的决策，不宣称替换已经完成。
