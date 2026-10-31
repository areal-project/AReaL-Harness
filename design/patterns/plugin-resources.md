**中文** | [English](plugin-resources.en.md)

# 查找并管理插件资源

用户暂时离开任务，查找插件、核对详情并调整启用范围，完成后继续原任务。GUI 以已有 PluginCenter 为生产入口；搜索和导航属于界面投影，管理结果由原服务和 Core 提供。

## 查找与查看

`R-PLUGINRESOURCES-001` 搜索只过滤当前市场或资源分类。无匹配结果时保留查询，提供清除入口。进入详情和返回列表保留原分类、查询与合理位置，键盘焦点回到原插件入口；入口已经消失时回到搜索框。加载有明确文字，不能把正在读取表达为空目录。

`R-PLUGINRESOURCES-002` 目录、连接信息和钩子信息分别读取。补充信息失败不能抹掉已取得的目录，也不能把读取失败表达为“没有连接”或“没有钩子”。失败部分明确标记暂不可用，刷新后再确认。迟到结果只属于原项目和当前读取代次，隐藏页面不能抢焦点。

## 管理与结果

`R-PLUGINRESOURCES-003` 安装、启用范围和连接是独立事实。安装确认精确绑定来源、revision和摘要，自动核对内容。MCP执行与Hook定义分别授权。用户必须看清所操作的范围，界面不偷偷将用户范围改成项目范围。

`R-PLUGINRESOURCES-004` 管理动作使用原有提交入口。处理中显示等待并禁用重复动作。明确失败保留对象及可行的下一步，成功以权威结果为准。结果未知保留原请求标识，只能显式核对原提交，不能自动重复写入。

## 返回原任务

`R-PLUGINRESOURCES-005` 返回原任务是导航动作，不是开始插件对话或新建草稿。原项目、任务、未发送内容和当前可用的阅读位置保留，焦点回到对应任务的输入入口。用户明确返回另一所属任务时沿用原有任务打开与错误处理，不建立第二套恢复流程。

## 所有者与范围

- [PluginCenter](../../clients/gui/renderer/src/settings/PluginCenter.tsx) 拥有资源路由与详情组合。读取代次归usePluginCenter，原回执归usePluginSubmission，安装审阅布局归PluginInstallReview。
- [SettingsSearchInput](../../clients/gui/renderer/src/settings/SettingsSearchInput.md) 拥有搜索输入与清除组合，设计值和 Props 仍归原实现。
- [App](../../clients/gui/renderer/src/App.tsx) 拥有原任务导航与焦点；Core 和原管理适配器拥有配置与提交回执。
- `R-PLUGINRESOURCES-006` [GUI 模式目录](../../clients/gui/design-system/patterns.md) 和 [Base](../../clients/gui/design-system/base.md) 记录实际准入范围，不能把本页设计要求当作已经完成的验收。

`R-PLUGINRESOURCES-007` 真实 GUI 验收使用隔离本地插件包和确定性外部模型。远程市场、OAuth、真实供应商、安装包及完整自定义主题另行验证。原图与运行记录留在本地，不把它们自动升级为用户认可的视觉基线。

## 快照与组件状态

`R-PLUGINRESOURCES-008` 插件中心在启动项目Core之前，通过同产物CLI读取Rust Store。用户范围无需选项目，项目范围的工作区由Main提供。页面显示读取范围、revision与观察时间。离线读取不声明运行时就绪。

`R-PLUGINRESOURCES-009` 读取hook拥有目录与详情代次。纯展示投影选择一个主状态与下一步，同时保留MCP、认证和Hook事实。可选Hook审阅不阻塞已安装Skills。两个入口共享资源导航与详情。用户切换插件或项目时，未确认回执保留原身份。安装自动核对精确来源、revision与摘要。MCP执行与Hook信任分别确认。

## 模板、配置与开发

`R-PLUGINRESOURCES-010` Commands沿普通消息提交保留插件命名空间、固定组件身份与原始参数。Agents为草稿选择已导入Profile。配置保存只更新指定字段。密码留空保留已存秘密，清除需显式选择。Main拥有凭据创建，公开快照不返回私有引用。共享配置中的新秘密需要各项目Core重新载入可信启动输入，当前项目提供空闲drain与重载入口。

`R-PLUGINRESOURCES-011` 显式开发链接为后续轮次发布不可变快照，活动轮次保留受理时版本。静态doctor与运行时诊断分别展示。必填配置缺失与Agent发布失败进入主状态下一步，可用Skills仍保留组件事实。
