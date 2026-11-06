# D-004 本地 UI 包与可运行产出链

## 选择与代价

建立私有 workspace 包 `@areal/ui`，由现有 GUI workspace 消费。包与 npm 包使用同一种 package.json、exports、依赖和版本格式；workspace:* 将消费方绑定到本地实现，private 阻止误发布。当前没有 registry 发布、外部兼容或公共 semver 承诺。

`R-DECISION-011` 相比只在 renderer 内增加样板，本地包提供真实可检查的依赖方向、导出和可单独构建的产物；成本是消费者必须先构建包，迁移需要保留既有导入路径与主题偏好。没有独立使用方时不拆成更多 packages，也不新建另一套文档站。

## 四层对应

| 层 | 当前所有者与产物 |
| --- | --- |
| 分发与消费 | 包导出 JavaScript、声明类型、CSS、组件索引、llms 和 Agent 指南；原设计站提供合同、生成 API、独立包示例与组合预览 |
| 守卫 | 生成漂移、基础对比度、静态依赖方向、导出/文档状态对应、类型与既有设计审计，以及独立示例和组合浏览器专项 |

`R-DECISION-015` 后续对话预览按用户授权增加实验 conversation 层：ActivityGroup、ImageDisclosure 和 TaskContext（Section/Item/Sources）复用基础控件，基础层不能反向导入它。其基本外观放在单独conversation.css，最初由设计预览消费，现按用户确认接入生产对话。包内合同/类型/组件与 Agent 索引沿原生成链；场景数据、原资源阅读器、窄窗导航与焦点归宿主。生产接线沿TurnExecution、ToolEvent、ConversationStatusCard与原AgentsPane/AgentConversationPane，AgentHistoryPane只组合列表和历史导航；Core/Runtime权威不迁入包。源码消费不表示全部领域组合迁移、实验API稳定性提升或安装包接受。

## 使用与重审

从 [包指南](../../clients/gui/packages/ui/README.md)和 [Agent 入口](../../clients/gui/packages/ui/agent-guide.md)进入；站点入口为 [UI 包与架构](../../clients/gui/renderer/design-system.html?ui-library)。日常修改先更新所属源，显式 generate 后 build/check，再验证受影响组合。
