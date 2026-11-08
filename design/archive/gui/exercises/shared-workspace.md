# 主会话、Side 与面板的共享交互

English: [shared workspace](shared-workspace.en.md)。[页面合同](../../../../clients/gui/design-system/surfaces/shared-workspace.json)以 I-INPUT、I-OBSERVE、I-READ、I-RETURN 组织主会话和 Side；关联设置仍沿 P-SETTINGS 与原偏好所有者。

## 所有权与默认结构

- ComposerSurface 拥有编辑区、工具栏、default/compact 布局和模型入口的基础呈现。ChatPromptEditor 透传 surfaceLayout；App 只为满屏资源下的主 Composer / DraftComposer 显式选择 compact。Side 保持 default，切换工作区不会因祖先选择器改变另一个编辑器的布局。
- 紧凑输入在其实际 composer-dock 容器宽度下重排；长输入由原编辑区滚动。布局切换保留编辑器实例，不重建草稿。
- 窄容器的紧凑布局将编辑区与工具栏上下排列，并约束模型入口宽度，避免长草稿挤出发送按钮。
- ConversationComposer 仍是理解模型目录与思考强度的业务组合。主/Side 共用模型名称、思考强度和选择菜单，不单列“继承”文案或选项；未选模型的 Side 草稿按来源主会话配置展示，显式选择后及已创建的 Side 按自己的配置展示。展示回退不写入草稿提交，首问未指定模型时仍由 Core 按锚点继承。主/Side 共用展示和编辑骨架，草稿键、来源、服务身份、配置与提交分别归原调用方和 Core。
- SidePane 拥有窗口局部的标签和视图选择。App 继续拥有任务面板返回与焦点；原生网页、终端和 MCP App 的资源归属不转移到共享控件。
- Side 的已带回提示和错误复用 Feedback 的文字角色。原 requestId、未知受理、恢复与重试入口保留；已保存与后续同步失败不合并成一个成功状态。
- 设置继续复用 SettingsPageParts.css、真实 SettingsPage 与 portal SettingsDialog。普通设置 Switch 沿 default；SettingsSelect 的有限变体由共享组件决定，调用方不复制控件样式。

目录只引用生产来源，用户外观覆盖仍沿 styles / applicationSettings / applicationPreferences；不新增另一份数值表或运行时页面 DSL。仅扩大本次实际迁移文件的审计，不声称全仓 JSX 自动依从。

预览通过生产 WorkbenchShell 提供工作区表面与透明层级，不复制背景样式。设置返回沿 App 恢复打开入口的焦点与原草稿；设置导航允许编辑器重挂载，不要求与面板布局切换相同的 DOM 身份。

## 可重复检查

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
node clients/gui/scripts/design-system-smoke.mjs --shared-workspace
make gui-build
AREAL_CORE_BIN=/absolute/verified/areal node clients/gui/scripts/conversation-derivation-smoke.mjs --shared-workspace
```

浏览器题目组合真实 ConversationComposer、SideChatPane、SidePane 和 SettingsDialog，本地 actions 不受理或执行任务；检查分屏/完整视图的布局、长模型名称、模型菜单、面板重访、草稿、明暗和14/18字号的代表条件。Settings 的保存/重挂载及样式顺序沿完整设计目录回归，不能用题目中的本地设置值替代持久化验收。

Electron 专项复用原隔离派生 runner、真实 Core 与 Runtime、本地确定性模型：来源命令运行时发送 Side，选择不同模型并核对配置隔离；保留两侧草稿，往返分屏、全屏、模型菜单及真实设置；来源命令随后独立完成。该参数只运行该有界旅程；不把完整派生脚本中未运行的重启/UNKNOWN 注入矩阵算作通过。`--baseline` 只用于冻结的旧布局采集，不替代新版断言。

旧新版保持相同任务、窗口、主题和字号，各自保留事件与录像。生成ID、计时和无关异步通知不同；比较布局与业务状态分开。原设置和对话阶段的证据继续保留，旧对话的视觉选择不因本次功能通过而自动获批。
