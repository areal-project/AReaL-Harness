# @areal/ui：Agent 使用入口

新增基础控件、调整基础值、采用包内组件或评审这些变更时，从本页开始。包内版本与可用导出读取 package.json 和生成的 components.json；先区分稳定与实验入口。

## 使用组件

1. 从 [GUI 设计入口](../../design-system/README.md)确定用户意图与所属模式；在 `@areal/ui/components.json` 索引里选择已有组件，读取就近 Markdown 合同。完成条件是用途、必要状态和返回行为明确。
2. 稳定组件从 `@areal/ui` 导入；实验组件从 `@areal/ui/wip` 导入。类型由实际源码和生成的 `.d.ts` 提供，目录示例消费相同导出。样式里的字号、颜色、圆角、间距从 [Token 速查](src/generated/tokens.md) 选变量，不写字面量。
3. 用内容、children 和已有有限变体完成组合。调用方提供真实值与合法动作，通用控件只负责呈现与交互。业务执行、凭据、历史和权限继续归原服务。
4. 先验证所选状态，再接生产。主题、字号、键盘和窄容器按实际风险检查；预览结果与真实桌面、Core、安装包分别报告。

## 修改系统

1. 默认基础值编辑 tokens.json；动态调色板派生编辑 src/theme.ts；用户偏好的读取、保存与应用仍在 renderer 的 applicationSettings/applicationPreferences。
2. 修改组件时同改旁边的用途、理由、状态与可访问性合同。Props 从 TypeScript 读取，语义值使用既有角色；组件的基础外观由其 recipe/CSS 自身完成。
3. 运行包的 generate、build 和 check，再运行 GUI 的 verify:design、typecheck 与受影响浏览器专项。生成漂移必须修源后重建；保留失败证据。
4. 改变边界、主题语义或公共规则时更新原设计文档/决策。稳定 API 的调整检查旧消费者。core 组件有 3 个及以上生产消费者时升级为稳定（或在合同写 `hold: <原因>`），规则见[成熟度](../../../../design/components/README.md#成熟度)。
5. 某个区域专用的外观放进该区域的层（如 conversation 的 ComposerActionButton），不加到 core 组件的变体里。

## 容易带入的错误假设

| 情况 | 本项目的采用方式 |
| --- | --- |
| 看到 Raft 的品牌值就搬入 AReaL | 保留本项目的角色与默认值，采用其工程组织方法 |
| 使用 Radix 的 asChild 写法 | Base UI 组件沿真实类型使用 render |
| 页面 className 才补齐组件基本外观 | 基本外观放在包内，调用方只处理任务布局 |
| 在目录里登记就算稳定 | 实验入口、有限 Base 准入与单次运行结果分别维护 |
| 相同文字意味着相同执行状态 | 使用原身份与权威投影；查看不重试未知写入 |

本包覆盖基础控件、设置组合、阅读器与对话/Worktree/工作台组合；分组范围从生成的components.json读取，不手维护第二份组件数量。对话组件从 wip 导入，样式另导入 conversation.css。基础层不能反向导入对话层；对话层不能导入 renderer、Core、Node 或 Electron。

对话组件由设计预览与生产对话共同消费：ActivityGroup 的 status 放在折叠外，ImageDisclosure 接受宿主确认的可用性，TaskContext.Sources 只展示三项并触发宿主的查看全部/添加动作。同一对象更新保留组件 key；对象切换按原 id 重建。宿主负责窄窗、真实资源阅读、焦点返回及草稿。生产适配归TurnExecution、ToolEvent、ConversationStatusCard及AgentsPane/AgentHistoryPane，继续使用原Core投影、资源读取和SidePane导航。已有产品适配沿原目录查找；共用展示按索引选择包内实现，不创建同名替代品。包设置 private，分发边界是本地 workspace，发布需另行授权。

子代理入口使用 SubagentPanel 的列表→历史→返回动线，读取原子任务状态，不使用父任务完成状态生成Done。列表展开和焦点归组件，历史与区域布局归宿主。ThinkingStatus 的 label 用于公开模型过程摘要；无摘要回退Thinking，完成/未确认时移除，不把等待审批或未知结果写成Thinking。卡片从产品顶部入口开关，不作为永久资源侧栏。

组件MD须与实现同目录，含用途、组成、状态、行为、内容、可访问性、规则及可操作示例链接；category/aliases/related供人和Agent检索。数组使用行内JSON，关联使用已有组件id。exports列出合同覆盖的运行期导出；例如Dialog与其子组件共用一份合同，每个公开组件导出必须恰好归属一份合同。类型导出由.d.ts提供，不另建空文档。MD、TS声明与独立示例各自拥有事实，生成的索引/原文站点不反向编辑。文档阅读器可检查元数据和实际示例；仅有MD文件不等于文档完整或体验已通过。

输入区采用[ComposerSurface合同](src/conversation/composer-surface/composer-surface.md)和[工具栏合同](src/conversation/composer-toolbar/composer-toolbar.md)；设置布局从[SettingsPage合同](src/settings/settings-page/settings-page.md)进入，并沿related查找分区、组与行。各合同说明样式入口、宿主职责及可操作实例；实际编辑、提交、保存回执和导航守卫沿原业务所有者。

Worktree界面从[选择合同](src/worktree/worktree-picker/worktree-picker.md)与related进入；业务适配仍归原Worktree模块。短时提示采用[NotificationToast合同](src/components/notification-toast/notification-toast.md)，通过原ToastHost发送；任务状态与恢复动作按原权威记录提供。

工作台组合使用workbench.css；基础设置组合的控件样式使用styles.css，页面/分区使用settings.css。纯组件允许局部展开、焦点和阅读交互；已保存偏好、I18n、业务请求、历史投影、上传与本地文件处理、拖拽身份、关闭守卫及原生面板生命周期由renderer适配注入。所有包化组件保留原视觉，提升稳定状态和Base准入仍须独立决定。迁移范围见[组件迁移](../../design-system/component-migration.md)。


混合内容从`@areal/ui/content`的严格`areal-ui`注册表进入，NativeContent只展示六类只读数据。普通说明优先Markdown；不要为单个事实强制生成卡片。无效/未知数据必须保留原文入口，不新增HTML、URL、样式、动作脚本或任意组件名。Gen UI和MCP Apps继续走原制品/工具宿主，不能用原生内容目录绕过审批。

审批复用DecisionCard的摘要、默认折叠details和固定操作页脚；问题复用QuestionCard。业务控制器决定提交、草稿与UNKNOWN，选择不等于提交，收起不等于解决。所有包内实例使用同目录MD，不让展示包读取Core或Desktop权限。

操作反馈，包括有核对或设置动作的UNKNOWN提示，统一用原ToastHost/NotificationToast通道，按requestId去重并默认5秒消失。不要新增顶部或Composer大错误卡片。状态本身和草稿不随通知消失而清除，必要核对由Composer小标识进入；已确认的原创建回执/Worktree就绪记录应正常收敛，不被无关pending阻塞。

定时任务目录采用[ScheduledWorkspace合同](src/workbench/scheduled-workspace/scheduled-workspace.md)，按状态分组并提供简洁模板入口；目录完整性、失败重试、选择和原创建请求恢复由TaskCenter负责。
