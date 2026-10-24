# D-004 本地 UI 包与可运行产出链

2026-10-24，按用户“先参照 Raft 搭系统，再实践改进”的方向采用本地包。保留 AReaL 现有视觉，先贯通 Source、实现、分发与守卫，后续通过具体任务扩展。决定已采用；具体运行与视觉接受分别记录。

## 选择与代价

建立私有 workspace 包 `@areal/ui`，由现有 GUI workspace 消费。包与 npm 包使用同一种 package.json、exports、依赖和版本格式；workspace:* 将消费方绑定到本地实现，private 阻止误发布。当前没有 registry 发布、外部兼容或公共 semver 承诺。

相比只在 renderer 内增加样板，本地包提供真实可检查的依赖方向、导出和可单独构建的产物；成本是消费者必须先构建包，迁移需要保留既有导入路径与主题偏好。没有独立使用方时不拆成更多 packages，也不新建另一套文档站。

## 四层对应

| 层 | 当前所有者与产物 |
| --- | --- |
| Source | 原 design/ 拥有原则与模式；包内 tokens.json 拥有已采用的基础角色和默认主题输入，theme.ts 拥有原纯调色板派生，组件规则与源码就近维护 |
| 实现 | 源生成 foundation.css、Tailwind 映射、默认明暗 themes.css 与主题输入；组件基于 Base UI、原 recipe/CSS 和 React；原宿主继续拥有偏好、业务状态与执行接线 |
| 分发与消费 | 包导出 JavaScript、声明类型、CSS、组件索引、llms 和 Agent 指南；原设计站提供合同、生成 API、独立包示例与组合预览 |
| 守卫 | 生成漂移、基础对比度、静态依赖方向、导出/文档状态对应、类型与既有设计审计，以及独立示例和组合浏览器专项 |

这是首个完整产出链，尚非全部 UI 迁移。首批稳定组件为原 Button，Disclosure 走实验入口；其他通用控件与领域组合继续由原 renderer 所有。稳定入口不扩大 Base 准入或安装包接受范围。

后续对话预览按用户授权增加实验 conversation 层：ActivityGroup、ImageDisclosure 和 TaskContext（Section/Item/Sources）复用基础控件，基础层不能反向导入它。其基本外观放在单独conversation.css，最初由设计预览消费，现按用户确认接入生产对话。包内合同/类型/组件与 Agent 索引沿原生成链；场景数据、原资源阅读器、窄窗导航与焦点归宿主。生产接线沿TurnExecution、ToolEvent、ConversationStatusCard与原AgentsPane/AgentConversationPane，AgentHistoryPane只组合列表和历史导航；Core/Runtime权威不迁入包。源码消费不表示全部领域组合迁移、实验API稳定性提升或安装包接受。

## 单源与兼容

采用的基础值从原 styles.css 移除可编辑默认定义，保留已有名称与值。未迁入的产品别名、命名主题和字体偏好继续在原所有者。生成 CSS 与 TypeScript 可以同时包含同一个源值，但只有 tokens.json 可编辑该值。

调色板函数原样移到包内，默认主题由同一函数生成；applicationSettings 保留规范化与既有导出转接，applicationPreferences 保留保存和应用。Core/Runtime 的执行、权限、历史与 UNKNOWN 语义不进入 UI 包。

Button 和 cn 的旧路径只转接包内实现，服务现有消费者。实验 Disclosure 把基本外观移出对话预览；任务状态和右侧来源业务仍归原组合。原 registry 维护 GUI 模式与 Base，包内组件索引从合同、真实导出和 TypeScript 声明产生，两个索引各有明确职责。

本决定在采用范围内扩展 [D-002](002-shared-semantics.md)：焦点默认仍归共享 focus.css，其余首批值由包单源生成，未建立第二套值。根设计地图、现有站点与原守卫入口保持原位。

## 使用与重审

从 [包指南](../../clients/gui/packages/ui/README.md)和 [Agent 入口](../../clients/gui/packages/ui/agent-guide.md)进入；站点入口为 [UI 包与架构](../../clients/gui/renderer/design-system.html?ui-library)。日常修改先更新所属源，显式 generate 后 build/check，再验证受影响组合。

出现第二个独立运行消费者、需要公开分发、组件稳定性或主题范围实质变化时再评估构建/发布策略。当前不引入通用页面 DSL、自动生成产品结构或全端主题迁移。
