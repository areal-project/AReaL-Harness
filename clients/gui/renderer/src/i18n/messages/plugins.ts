export const pluginMessages = {
  "settings.pluginCenter.commandsTitle": { "zh-CN": "命令", en: "Commands" },
  "settings.pluginCenter.agentsTitle": { "zh-CN": "智能体", en: "Agents" },
  "settings.pluginCenter.connectProjectBackend": {
    "zh-CN": "连接项目后台",
    en: "Connect project Core",
  },
  "settings.pluginCenter.chooseProjectToInstall": {
    "zh-CN": "选择项目以继续安装",
    en: "Choose a project to continue installation",
  },
  "settings.pluginCenter.agentProfileUnavailable": {
    "zh-CN": "插件 Agent 配置已不可用，请刷新后选择。原草稿已保留。",
    en: "The plugin Agent profile is unavailable. Refresh and select it again. Your draft is preserved.",
  },
  "settings.pluginCenter.sharedCredentialReloadRequired": {
    "zh-CN": "新凭据需要各项目重新载入，当前项目可在空闲时载入。",
    en: "Each project must reload the new credentials. Reload this project while it is idle.",
  },
  "settings.pluginCenter.reloadProjectCredentials": {
    "zh-CN": "重新载入当前项目凭据",
    en: "Reload credentials for this project",
  },
  "settings.pluginCenter.credentialsReloaded": {
    "zh-CN": "当前项目已重新载入凭据，请检查组件连接。",
    en: "This project reloaded its credentials. Check component connections.",
  },
  "settings.pluginCenter.userConfiguration": { "zh-CN": "插件配置", en: "Plugin configuration" },
  "settings.pluginCenter.secretConfigurationBoundary": {
    "zh-CN": "敏感值保存在系统受保护凭据中，留空会保留已保存的值。",
    en: "Sensitive values are stored in protected credentials. Leave blank to keep the saved value.",
  },
  "settings.pluginCenter.missingConfiguration": {
    "zh-CN": "需要配置 {fields}",
    en: "Configure {fields}",
  },
  "settings.pluginCenter.secretAlreadyConfigured": {
    "zh-CN": "已配置，输入新值可替换",
    en: "Configured. Enter a new value to replace it",
  },
  "settings.pluginCenter.clearSavedConfiguration": {
    "zh-CN": "清除已保存值",
    en: "Clear saved value",
  },
  "settings.pluginCenter.undoClearConfiguration": {
    "zh-CN": "保留已保存值",
    en: "Keep saved value",
  },
  "settings.pluginCenter.saveConfiguration": {
    "zh-CN": "保存插件配置",
    en: "Save plugin configuration",
  },
  "settings.pluginCenter.developmentSource": {
    "zh-CN": "本地开发来源",
    en: "Local development source",
  },
  "settings.pluginCenter.developmentLinkActive": {
    "zh-CN": "已链接本地来源，下一轮使用新内容。需要重新确认执行信任。",
    en: "Local source linked. The next turn uses the new content. Execution trust needs to be confirmed again.",
  },
  "settings.pluginCenter.developmentLinkExplanation": {
    "zh-CN": "显式链接当前本地来源后，后台会检查内容变化并发布不可变快照。",
    en: "Link this local source to let Core check changes and publish immutable snapshots.",
  },
  "settings.pluginCenter.stopDevelopmentLink": {
    "zh-CN": "停止跟踪本地来源",
    en: "Stop tracking local source",
  },
  "settings.pluginCenter.linkDevelopmentSource": {
    "zh-CN": "链接当前本地来源",
    en: "Link current local source",
  },
  "settings.pluginCenter.commandSubmissionBoundary": {
    "zh-CN": "命令会作为一条普通消息提交到当前任务。",
    en: "Commands are submitted to the current task as an ordinary message.",
  },
  "settings.pluginCenter.selectTaskForCommand": {
    "zh-CN": "打开一个普通任务后再提交命令。",
    en: "Open an ordinary task to submit a command.",
  },
  "settings.pluginCenter.commandArguments": { "zh-CN": "命令参数", en: "Command arguments" },
  "settings.pluginCenter.submitCommandToTask": {
    "zh-CN": "提交到当前任务",
    en: "Submit to current task",
  },
  "settings.pluginCenter.agentProfileBoundary": {
    "zh-CN": "Agent 使用已导入的任务配置，权限限制照常生效。",
    en: "Agents use imported task profiles. Permission limits still apply.",
  },
  "settings.pluginCenter.agentDraftPrompt": {
    "zh-CN": "请使用 {name} 的任务配置协助处理当前需求。",
    en: "Use the {name} task profile to help with this request.",
  },
  "settings.pluginCenter.useAgentProfile": {
    "zh-CN": "使用此配置创建草稿",
    en: "Create a draft with this profile",
  },
  "settings.pluginCenter.pluginDoctor": { "zh-CN": "插件诊断", en: "Plugin diagnostics" },
  "settings.pluginCenter.doctorStaticBoundary": {
    "zh-CN": "诊断只检查安装和支持情况，不包括项目运行状态。",
    en: "Diagnostics cover installation and support only, not project runtime state.",
  },
  "settings.pluginCenter.readDoctorReport": {
    "zh-CN": "读取诊断报告",
    en: "Read diagnostic report",
  },
  "settings.pluginCenter.componentSnapshotChanged": {
    "zh-CN": "组件摘要已变化，请刷新插件详情后再操作。",
    en: "The component snapshot changed. Refresh plugin details before continuing.",
  },
  "settings.pluginCenter.installTrustBoundary": {
    "zh-CN": "安装会自动核对来源与快照。MCP 执行和 Hook 信任需分别授权。",
    en: "Installation verifies the source and snapshot automatically. Authorize MCP execution and Hook trust separately.",
  },
  "settings.pluginCenter.pluginNotInSnapshot": {
    "zh-CN": "当前快照中没有此插件，请返回列表刷新。",
    en: "This plugin is absent from the current snapshot. Return to the list and refresh.",
  },
  "settings.pluginCenter.snapshotScope": {
    "zh-CN": "读取范围 {scope} · revision {revision} · {time}",
    en: "Read scope {scope} \u00b7 revision {revision} \u00b7 {time}",
  },
  "settings.pluginCenter.runtimeNotObserved": {
    "zh-CN": "尚未观察当前项目的运行状态。目录与支持信息来自本地 Store 快照。",
    en: "Runtime state for this project has not been observed. Catalog and support information come from the local Store snapshot.",
  },
  "settings.pluginCenter.runtimeNotObservedTitle": {
    "zh-CN": "已读取安装快照，运行状态未观察",
    en: "Installation snapshot read. Runtime not observed",
  },
  "settings.pluginCenter.partiallyAvailable": {
    "zh-CN": "部分组件可用，其他组件需要处理",
    en: "Some components are available. Others need attention",
  },
  "settings.pluginCenter.declaredComponentsAvailable": {
    "zh-CN": "已声明组件已就绪",
    en: "Declared components are ready",
  },
  "settings.pluginCenter.reviewInstallation": {
    "zh-CN": "检查安装内容",
    en: "Review installation",
  },
  "settings.pluginCenter.enablePlugin": { "zh-CN": "在当前项目启用", en: "Enable in this project" },
  "settings.pluginCenter.refreshSnapshot": { "zh-CN": "刷新快照", en: "Refresh snapshot" },
  "settings.pluginCenter.pluginOverview": {
    "zh-CN": "插件状态与下一步",
    en: "Plugin status and next step",
  },
  "settings.pluginCenter.componentFactsRemainIndependent": {
    "zh-CN": "各组件的配置、认证与信任状态见下方详情。执行受当前任务权限约束。",
    en: "See configuration, authentication, and trust for each component below. Execution remains subject to current task permissions.",
  },
  "settings.pluginCenter.skillsInstalledAndEnabled": {
    "zh-CN": "Skills 已安装并在当前范围启用。",
    en: "Skills are installed and enabled in this scope.",
  },
  "settings.pluginCenter.hooksRequireSeparateReview": {
    "zh-CN": "Hook 定义需要独立审阅与信任。",
    en: "Hook definitions require separate review and trust.",
  },
  "settings.pluginCenter.previousCreationRecords": {
    "zh-CN": "历史会话创建记录（待核对）",
    en: "Previous conversation creation records (awaiting review)",
  },
  "settings.pluginCenter.unrelatedCreationUnconfirmed": {
    "zh-CN": "另一个对话创建结果待核对。你可以继续管理插件，原请求会保留且不会自动重发。",
    en: "Another conversation creation is unconfirmed. You can manage plugins. The original request is retained and will not be resent automatically.",
  },
  "settings.pluginCenter.projectOperationStillUnconfirmed": {
    "zh-CN": "已核对，原操作仍未确认。未重新提交。",
    en: "Checked. The original operation is still unconfirmed. It was not resubmitted.",
  },
  "settings.pluginCenter.projectOperationConfirmedComplete": {
    "zh-CN": "原操作已确认完成。未重新提交。",
    en: "The original operation is confirmed complete. It was not resubmitted.",
  },
  "settings.pluginCenter.projectOperationConfirmedFailed": {
    "zh-CN": "原操作已确认失败。未重新提交。",
    en: "The original operation is confirmed failed. It was not resubmitted.",
  },
  "settings.pluginCenter.originalRequestIdUnavailable": {
    "zh-CN": "原请求 ID 缺失，无法定位并核对原操作。原记录已保留。",
    en: "The original request ID is unavailable, so the original operation could not be located and checked. Its record is retained.",
  },
  "settings.pluginCenter.requiredHostToolsUnavailable": {
    "zh-CN": "当前宿主未提供所需工具：{tools}。",
    en: "Required tools are unavailable in this host: {tools}.",
  },
  "settings.pluginCenter.enableNativeComputerProvider": {
    "zh-CN": "请在设置中明确启用原生电脑控制提供方。LCU 不提供 computer_v1。",
    en: "Enable the native computer control provider in Settings. LCU does not provide computer_v1.",
  },
  "settings.pluginCenter.hostReadinessUnavailable": {
    "zh-CN": "无法确认当前安装快照的工具可用性，请刷新插件详情。",
    en: "Could not confirm tool availability for this installed snapshot. Refresh plugin details.",
  },
  "settings.pluginCenter.hostToolDeploymentReady": {
    "zh-CN": "所需工具已部署。执行仍需通过操作审批与系统权限检查。",
    en: "Required tools are deployed. Execution still checks action approvals and OS permissions.",
  },
  "settings.pluginCenter.checkingHostToolDeployment": {
    "zh-CN": "正在检查宿主工具部署…",
    en: "Checking host tool deployment…",
  },
  "settings.pluginCenter.returnToTask": {
    "zh-CN": "返回原任务",
    en: "Return to original task",
  },
  "settings.pluginCenter.loadingCatalog": {
    "zh-CN": "正在加载插件目录…",
    en: "Loading plugin catalog…",
  },
  "settings.pluginCenter.refreshingCatalog": {
    "zh-CN": "正在刷新插件目录…",
    en: "Refreshing plugin catalog…",
  },
  "settings.pluginCenter.connectionsUnavailable": {
    "zh-CN": "插件 MCP 连接暂不可用。{error}",
    en: "Plugin MCP connections are temporarily unavailable. {error}",
  },
  "settings.pluginCenter.hooksUnavailable": {
    "zh-CN": "插件 hooks 暂不可用。{error}",
    en: "Plugin hooks are temporarily unavailable. {error}",
  },
  "settings.pluginCenter.theOriginalAuthenticationSubmissionIsStillUnconfirmed": {
    "zh-CN": "原认证配置提交仍待核对，请先完成核对。",
    en: "The original authentication submission is still unconfirmed. Check it first.",
  },
  "settings.pluginCenter.sourceResolutionCompletedButTheReturnedPreview": {
    "zh-CN": "来源解析已完成，但返回的预览不完整。请刷新目录后重新解析来源。",
    en: "Source resolution completed, but the returned preview is incomplete. Refresh the catalog and resolve the source again.",
  },
  "settings.pluginCenter.theSetupSkillWasSubmittedReturnTo": {
    "zh-CN": "设置技能已提交，请回到对话查看执行与审批。",
    en: "The setup skill was submitted. Return to the conversation to view execution and approvals.",
  },
  "settings.pluginCenter.operationCompleted": {
    "zh-CN": "操作已完成。",
    en: "Operation completed.",
  },
  "settings.pluginCenter.theOriginalSubmissionIsStillProcessingCheck": {
    "zh-CN": "原提交仍在处理中，请稍后再次核对。",
    en: "The original submission is still processing. Check again later.",
  },
  "settings.pluginCenter.theOriginalSubmissionResultIsStillUnconfirmed": {
    "zh-CN": "原提交结果仍未确认，请稍后再次核对。",
    en: "The original submission result is still unconfirmed. Check again later.",
  },
  "settings.pluginCenter.theOriginalPluginOperationIsConfirmedFailed": {
    "zh-CN": "原插件操作已确认失败。",
    en: "The original plugin operation is confirmed failed.",
  },
  "settings.pluginCenter.theOriginalSubmissionIsConfirmedCompleteIt": {
    "zh-CN": "原提交已确认完成，未重新执行。",
    en: "The original submission is confirmed complete. It was not run again.",
  },
  "settings.pluginCenter.couldNotCheckTheOriginalSubmissionValue": {
    "zh-CN": "无法核对原提交：{value0}",
    en: "Could not check the original submission: {value0}",
  },
  "settings.pluginCenter.checkConnectionResult": {
    "zh-CN": "核对连接结果",
    en: "Check connection result",
  },
  "settings.pluginCenter.checkPluginSubmission": {
    "zh-CN": "核对插件提交",
    en: "Check plugin submission",
  },
  "settings.pluginCenter.aProjectOperationHasAnUnconfirmedResult": {
    "zh-CN":
      "项目中有结果待核对的操作，插件修改暂不可用。核对项目操作只读取原请求结果，不会重新提交。",
    en: "A project operation has an unconfirmed result. Plugin changes are unavailable. Checking reads the original request result without resubmitting it.",
  },
  "settings.pluginCenter.checkProjectOperation": {
    "zh-CN": "核对项目操作",
    en: "Check project operation",
  },
  "settings.pluginCenter.checkingProjectOperation": {
    "zh-CN": "正在核对项目操作…",
    en: "Checking project operation…",
  },
  "settings.pluginCenter.openOperationConversation": {
    "zh-CN": "打开原操作会话",
    en: "Open operation conversation",
  },
  "settings.pluginCenter.theOriginalPluginSubmissionResultIsUnconfirmed": {
    "zh-CN": "原插件提交结果待核对，不会自动重发。",
    en: "The original plugin submission result is unconfirmed and will not be resent automatically.",
  },
  "settings.pluginCenter.addingPluginMarketplace": {
    "zh-CN": "正在添加插件市场…",
    en: "Adding plugin marketplace…",
  },
  "settings.pluginCenter.aProjectOperationIsProcessingPleaseWait": {
    "zh-CN": "项目操作正在处理中，插件修改暂不可用。请等待原请求完成。",
    en: "A project operation is processing. Plugin changes are unavailable until the original request completes.",
  },
  "settings.pluginCenter.checkingTheOriginalSourceResolution": {
    "zh-CN": "正在核对原来源解析…",
    en: "Checking the original source resolution…",
  },
  "settings.pluginCenter.resolvingSource": {
    "zh-CN": "正在解析来源…",
    en: "Resolving source…",
  },
  "settings.pluginCenter.theSourceResolutionResultIsUnconfirmedAnd": {
    "zh-CN": "来源解析结果待核对，不会自动重发。",
    en: "The source resolution result is unconfirmed and will not be resent automatically.",
  },
  "settings.pluginCenter.sourceResolvedReviewTheDigestBeforeInstalling": {
    "zh-CN": "来源已解析，可确认安装内容。",
    en: "Source resolved. Confirm the installation contents.",
  },
  "settings.pluginCenter.savingCredentialsDidNotReturnAProtected": {
    "zh-CN": "凭据保存未返回受保护引用。",
    en: "Saving credentials did not return a protected reference.",
  },
  "settings.pluginCenter.githubConnectorConfigurationSavedConnectThePlugin": {
    "zh-CN": "GitHub Connector 配置已保存，请明确连接该插件。",
    en: "GitHub Connector configuration saved. Connect the plugin when ready.",
  },
  "settings.pluginCenter.pluginsValue": {
    "zh-CN": "插件 · {value0}",
    en: "Plugin · {value0}",
  },
  "settings.pluginCenter.selectAProjectInWhichToCreate": {
    "zh-CN": "请先选择要创建 Skill 的项目。",
    en: "Select a project in which to create the skill first.",
  },
  "settings.pluginCenter.addResource": {
    "zh-CN": "添加资源",
    en: "Add resource",
  },
  "settings.pluginCenter.add": {
    "zh-CN": "添加",
    en: "Add",
  },
  "settings.pluginCenter.addMarketplace": {
    "zh-CN": "添加市场",
    en: "Add marketplace",
  },
  "settings.pluginCenter.addMCP": {
    "zh-CN": "添加 MCP",
    en: "Add MCP",
  },
  "settings.pluginCenter.uploadPluginPackage": {
    "zh-CN": "上传插件包",
    en: "Upload plugin package",
  },
  "settings.pluginCenter.pluginMarketplace": {
    "zh-CN": "插件市场",
    en: "Plugin marketplace",
  },
  "settings.pluginCenter.plugins": {
    "zh-CN": "插件",
    en: "Plugins",
  },
  "settings.pluginCenter.pluginNavigation": {
    "zh-CN": "插件导航",
    en: "Plugin navigation",
  },
  "settings.pluginCenter.extensions": {
    "zh-CN": "扩展",
    en: "Extensions",
  },
  "settings.pluginCenter.installed": {
    "zh-CN": "已安装",
    en: "Installed",
  },
  "settings.pluginCenter.manageInstalled": {
    "zh-CN": "管理已安装",
    en: "Manage installed",
  },
  "settings.pluginCenter.breadcrumb": {
    "zh-CN": "面包屑",
    en: "Breadcrumb",
  },
  "settings.pluginCenter.backToPluginList": {
    "zh-CN": "返回插件列表",
    en: "Back to plugin list",
  },
  "settings.pluginCenter.pluginSettings": {
    "zh-CN": "插件设置",
    en: "Plugin settings",
  },
  "settings.pluginCenter.discoverAndInstallPluginsToExtendAReaL": {
    "zh-CN": "发现并安装插件，扩展 AReaL Harness 的能力。",
    en: "Discover and install plugins to extend AReaL Harness.",
  },
  "settings.pluginCenter.addReusableExpertiseForDifferentTasks": {
    "zh-CN": "为不同任务添加可复用的专业能力。",
    en: "Add reusable expertise for different tasks.",
  },
  "settings.pluginCenter.manageInstalledPluginsMCPServersAndSkills": {
    "zh-CN": "管理已安装的插件、MCP 和 Skills。",
    en: "Manage installed plugins, MCP servers, and skills.",
  },
  "settings.pluginCenter.searchPluginPackages": {
    "zh-CN": "搜索插件包",
    en: "Search plugin packages",
  },
  "settings.pluginCenter.searchPlugins": {
    "zh-CN": "搜索插件…",
    en: "Search plugins…",
  },
  "settings.pluginCenter.clearPluginSearch": {
    "zh-CN": "清除插件搜索",
    en: "Clear plugin search",
  },
  "settings.pluginCenter.createSkill": {
    "zh-CN": "创建 Skill",
    en: "Create skill",
  },
  "settings.pluginCenter.browseMarketplace": {
    "zh-CN": "浏览市场",
    en: "Browse marketplace",
  },
  "settings.pluginCenter.refreshMarketplace": {
    "zh-CN": "刷新市场",
    en: "Refresh marketplace",
  },
  "settings.pluginCenter.marketplaceScope": {
    "zh-CN": "市场范围",
    en: "Marketplace scope",
  },
  "settings.pluginCenter.public": {
    "zh-CN": "公共",
    en: "Public",
  },
  "settings.pluginCenter.personal": {
    "zh-CN": "个人",
    en: "Personal",
  },
  "settings.pluginCenter.installedResourceType": {
    "zh-CN": "已安装资源类型",
    en: "Installed resource type",
  },
  "settings.pluginCenter.marketplace": {
    "zh-CN": "市场",
    en: "Marketplace",
  },
  "settings.pluginCenter.preservingTheOriginalSubmissionForProjectValue": {
    "zh-CN": "正在保留项目 {value0} 的原提交。核对完成后再切换管理上下文。",
    en: "Preserving the original submission for project {value0}. Check it before switching management context.",
  },
  "settings.pluginCenter.selectAProjectToBrowsePlugins": {
    "zh-CN": "选择项目后浏览插件",
    en: "Select a project to browse plugins",
  },
  "settings.pluginCenter.thePluginCatalogIsManagedByThe": {
    "zh-CN": "插件目录由已打开项目的 Core 管理。",
    en: "The plugin catalog is managed by the open project's Core.",
  },
  "settings.pluginCenter.openProject": {
    "zh-CN": "打开项目",
    en: "Open project",
  },
  "settings.pluginCenter.theProjectSCoreIsDisconnectedCurrent": {
    "zh-CN": "项目 Core 尚未连接。当前内容和原提交已保留。",
    en: "The project's Core is disconnected. Current content and the original submission have been preserved.",
  },
  "settings.pluginCenter.thisCoreDoesNotSupportThePlugin": {
    "zh-CN": "当前 Core 不支持插件目录。请升级到支持插件包的 Core 后重新连接项目。",
    en: "This Core does not support the plugin catalog. Upgrade to a Core with plugin package support and reconnect the project.",
  },
  "settings.pluginCenter.advancedStandaloneHooks": {
    "zh-CN": "高级 · 独立钩子",
    en: "Advanced · Standalone hooks",
  },
  "settings.pluginCenter.userHooks": {
    "zh-CN": "用户钩子",
    en: "User hooks",
  },
  "settings.pluginCenter.projectHooks": {
    "zh-CN": "项目钩子",
    en: "Project hooks",
  },
  "settings.pluginCenter.globalToggleEnabled": {
    "zh-CN": "全局开关已启用",
    en: "Global toggle enabled",
  },
  "settings.pluginCenter.globalToggleDisabled": {
    "zh-CN": "全局开关已停用",
    en: "Global toggle disabled",
  },
  "settings.pluginCenter.openSetupConversation": {
    "zh-CN": "打开设置对话",
    en: "Open setup conversation",
  },
  "settings.pluginCenter.importedPluginPackage": {
    "zh-CN": "导入的插件包",
    en: "Imported plugin package",
  },
  "settings.pluginCenter.valuePluginValue": {
    "zh-CN": "{value0} · 插件 {value1}",
    en: "{value0} · Plugin {value1}",
  },
  "settings.pluginCenter.viewPluginValue": {
    "zh-CN": "查看插件 {value0}",
    en: "View plugin {value0}",
  },
  "settings.pluginCenter.disable": {
    "zh-CN": "停用",
    en: "Disable",
  },
  "settings.pluginCenter.enable": {
    "zh-CN": "启用",
    en: "Enable",
  },
  "settings.pluginCenter.valuePluginValueInTheCurrentProject": {
    "zh-CN": "在当前项目{value0}插件 {value1}",
    en: "{value0} plugin {value1} in the current project",
  },
  "settings.pluginCenter.manage": {
    "zh-CN": "管理",
    en: "Manage",
  },
  "settings.pluginCenter.valuePluginValue2": {
    "zh-CN": "{value0}插件 {value1}",
    en: "{value0} plugin {value1}",
  },
  "settings.pluginCenter.added": {
    "zh-CN": "已添加",
    en: "Added",
  },
  "settings.pluginCenter.noMatchingPlugins": {
    "zh-CN": "没有匹配的插件",
    en: "No matching plugins",
  },
  "settings.pluginCenter.noPluginsInstalled": {
    "zh-CN": "尚未安装插件",
    en: "No plugins installed",
  },
  "settings.pluginCenter.noOfficialPluginMarketplaceAdded": {
    "zh-CN": "尚未添加官方插件市场",
    en: "No official plugin marketplace added",
  },
  "settings.pluginCenter.noPersonalPluginMarketplaceAdded": {
    "zh-CN": "尚未添加个人插件市场",
    en: "No personal plugin marketplace added",
  },
  "settings.pluginCenter.tryAnotherNameOrKeyword": {
    "zh-CN": "试试其他名称或关键词。",
    en: "Try another name or keyword.",
  },
  "settings.pluginCenter.addAMarketplaceToViewPluginContents": {
    "zh-CN": "添加市场后，查看真实插件内容并审核安装。",
    en: "Add a marketplace to view plugin contents and review installations.",
  },
  "settings.pluginCenter.addPluginMarketplace": {
    "zh-CN": "添加插件市场",
    en: "Add plugin marketplace",
  },
  "settings.pluginCenter.removeSource": {
    "zh-CN": "移除来源",
    en: "Remove source",
  },
  "settings.pluginCenter.refreshGitSourceSnapshot": {
    "zh-CN": "刷新 Git 来源快照",
    en: "Refresh Git source snapshot",
  },
  "settings.pluginCenter.importAndInspectAZIPPluginPackage": {
    "zh-CN": "先导入并检查 ZIP 插件包，再审核内容摘要与安装范围。",
    en: "Import and inspect a ZIP plugin package, then review its content digest and installation scope.",
  },
  "settings.pluginCenter.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
  },
  "settings.pluginCenter.importAndPreview": {
    "zh-CN": "导入并预览",
    en: "Import and preview",
  },
  "settings.pluginCenter.chooseALocalDirectoryOrGitMarketplace": {
    "zh-CN": "选择本地目录或 Git marketplace。读取来源不会安装插件或启动服务器。",
    en: "Choose a local directory or Git marketplace. Reading the source does not install plugins or start servers.",
  },
  "settings.pluginCenter.sourceType": {
    "zh-CN": "来源类型",
    en: "Source type",
  },
  "settings.pluginCenter.localDirectory": {
    "zh-CN": "本地目录",
    en: "Local directory",
  },
  "settings.pluginCenter.gitRepository": {
    "zh-CN": "Git 仓库",
    en: "Git repository",
  },
  "settings.pluginCenter.marketplaceRootDirectory": {
    "zh-CN": "Marketplace 根目录",
    en: "Marketplace root directory",
  },
  "settings.pluginCenter.branchTagOrCommitOptional": {
    "zh-CN": "分支、标签或提交（可选）",
    en: "Branch, tag, or commit (optional)",
  },
  "settings.pluginCenter.sparseCheckoutPathsOptional": {
    "zh-CN": "稀疏检出路径（可选）",
    en: "Sparse checkout paths (optional)",
  },
  "settings.pluginCenter.onePathRelativeToTheRepositoryRoot": {
    "zh-CN": "每行一个相对于仓库根目录的路径",
    en: "One path relative to the repository root per line",
  },
  "settings.pluginCenter.addDirectory": {
    "zh-CN": "添加目录",
    en: "Add directory",
  },
  "settings.pluginCenter.openaiPluginMarketplace": {
    "zh-CN": "OpenAI 插件市场",
    en: "OpenAI plugin marketplace",
  },
  "settings.pluginCenter.morePluginActions": {
    "zh-CN": "更多插件操作",
    en: "More plugin actions",
  },
  "settings.pluginCenter.copyPluginID": {
    "zh-CN": "复制插件标识",
    en: "Copy plugin ID",
  },
  "settings.pluginCenter.uninstallPlugin": {
    "zh-CN": "卸载插件",
    en: "Uninstall plugin",
  },
  "settings.pluginCenter.loadingPluginDetails": {
    "zh-CN": "正在读取插件详情…",
    en: "Loading plugin details…",
  },
  "settings.pluginCenter.retryLoadingDetails": {
    "zh-CN": "重试读取详情",
    en: "Retry loading details",
  },
  "settings.pluginCenter.pluginSubmissionStatus": {
    "zh-CN": "插件提交状态",
    en: "Plugin submission status",
  },
  "settings.pluginCenter.connectionResultUnconfirmed": {
    "zh-CN": "连接结果待核对",
    en: "Connection result unconfirmed",
  },
  "settings.pluginCenter.operationResultUnconfirmed": {
    "zh-CN": "操作结果待核对",
    en: "Operation result unconfirmed",
  },
  "settings.pluginCenter.thePreviousOperationIsNotConfirmedComplete": {
    "zh-CN": "尚未确认上次操作是否完成，请先核对原请求。",
    en: "The previous operation is not confirmed complete. Check the original request first.",
  },
  "settings.pluginCenter.resultUnconfirmed": {
    "zh-CN": "结果待核对",
    en: "Result unconfirmed",
  },
  "settings.pluginCenter.hideThisSubmission": {
    "zh-CN": "收起本次提交",
    en: "Hide this submission",
  },
  "settings.pluginCenter.viewThisSubmission": {
    "zh-CN": "查看本次提交",
    en: "View this submission",
  },
  "settings.pluginCenter.checkTheResultBeforeResubmittingOrChanging": {
    "zh-CN": "核对前暂不可重复提交或修改配置。",
    en: "Check the result before resubmitting or changing configuration.",
  },
  "settings.pluginCenter.pluginOperationProgress": {
    "zh-CN": "插件操作进度",
    en: "Plugin operation progress",
  },
  "settings.pluginCenter.checkingOriginalSubmission": {
    "zh-CN": "正在核对原提交…",
    en: "Checking original submission…",
  },
  "settings.pluginCenter.updatingConnection": {
    "zh-CN": "正在更新连接…",
    en: "Updating connection…",
  },
  "settings.pluginCenter.processing": {
    "zh-CN": "正在处理…",
    en: "Processing…",
  },
  "settings.pluginCenter.pleaseWaitTheSubmissionWillNotBe": {
    "zh-CN": "请稍候，不会重复提交。",
    en: "Please wait. The submission will not be repeated.",
  },
  "settings.pluginCenter.sourceResolutionAndPreview": {
    "zh-CN": "来源解析与预览",
    en: "Source resolution and preview",
  },
  "settings.pluginCenter.reviewNewInstallationSnapshot": {
    "zh-CN": "核对新安装快照",
    en: "Review new installation snapshot",
  },
  "settings.pluginCenter.notInstalled": {
    "zh-CN": "尚未安装",
    en: "Not installed",
  },
  "settings.pluginCenter.reviewTheSourceThenChooseAnInstallation": {
    "zh-CN": "核对来源后，选择安装范围。",
    en: "Review the source, then choose an installation scope.",
  },
  "settings.pluginCenter.pluginPackage": {
    "zh-CN": "插件包",
    en: "Plugin package",
  },
  "settings.pluginCenter.reviewTheSourceBeforeInstalling": {
    "zh-CN": "安装前需要核对来源。",
    en: "Review the source before installing.",
  },
  "settings.pluginCenter.reviewSourceAndInstall": {
    "zh-CN": "核对来源并安装",
    en: "Review source and install",
  },
  "settings.pluginCenter.source2": {
    "zh-CN": "来源",
    en: "Source",
  },
  "settings.pluginCenter.packageVersion": {
    "zh-CN": "包版本",
    en: "Package version",
  },
  "settings.pluginCenter.contentDigest": {
    "zh-CN": "原包内容摘要",
    en: "Package content digest",
  },
  "settings.pluginCenter.definitionReviewDigest": {
    "zh-CN": "有效定义审阅摘要",
    en: "Effective definition review digest",
  },
  "settings.pluginCenter.installedSnapshotDigest": {
    "zh-CN": "已安装快照摘要",
    en: "Installed snapshot digest",
  },
  "settings.pluginCenter.pinnedCommit": {
    "zh-CN": "固定提交",
    en: "Pinned commit",
  },
  "settings.pluginCenter.integrity": {
    "zh-CN": "完整性",
    en: "Integrity",
  },
  "settings.pluginCenter.installationScope": {
    "zh-CN": "安装范围",
    en: "Installation scope",
  },
  "settings.pluginCenter.availableToProjectsUnderTheSameUser": {
    "zh-CN": "同一用户目录下的项目可用。",
    en: "Available to projects under the same user directory.",
  },
  "settings.pluginCenter.saveWithinTheCurrentProjectScope": {
    "zh-CN": "保存到当前项目范围。",
    en: "Save within the current project scope.",
  },
  "settings.pluginCenter.iHaveReviewedTheSourceVersionAnd": {
    "zh-CN": "我已核对以上来源、版本和摘要",
    en: "I have reviewed the source, version, and digests above",
  },
  "settings.pluginCenter.theCatalogChangedResolveTheSourceAgain": {
    "zh-CN": "目录已变化，请重新解析来源后安装。",
    en: "The catalog changed. Resolve the source again before installing.",
  },
  "settings.pluginCenter.installReviewedSnapshot": {
    "zh-CN": "安装已核对的新快照",
    en: "Install reviewed snapshot",
  },
  "settings.pluginCenter.user": {
    "zh-CN": "用户",
    en: "User",
  },
  "settings.pluginCenter.currentProject": {
    "zh-CN": "当前项目",
    en: "Current project",
  },
  "settings.pluginCenter.installForValue": {
    "zh-CN": "安装到{value0}",
    en: "Install for {value0}",
  },
  "settings.pluginCenter.resolveSourceAgain": {
    "zh-CN": "重新解析来源",
    en: "Resolve source again",
  },
  "settings.pluginCenter.cancelInstallation": {
    "zh-CN": "取消安装",
    en: "Cancel installation",
  },
  "settings.pluginCenter.disabledInCurrentProject": {
    "zh-CN": "当前项目已停用",
    en: "Disabled in current project",
  },
  "settings.pluginCenter.manageTheEnabledScopeBeforeUsingThis": {
    "zh-CN": "管理启用范围后，再使用此插件。",
    en: "Manage the enabled scope before using this plugin.",
  },
  "settings.pluginCenter.manageEnabledScope": {
    "zh-CN": "管理启用范围",
    en: "Manage enabled scope",
  },
  "settings.pluginCenter.pleaseUseValueToHelpMeComplete": {
    "zh-CN": "请使用 {value0} 帮助我完成任务。",
    en: "Please use {value0} to help me complete my task.",
  },
  "settings.pluginCenter.githubConnectorConfiguration": {
    "zh-CN": "GitHub Connector 配置",
    en: "GitHub Connector configuration",
  },
  "settings.pluginCenter.credentialsAreSavedInProtectedDesktopCredential": {
    "zh-CN": "凭据保存在受保护的桌面凭据存储中。修改前请先断开连接。",
    en: "Credentials are saved in protected desktop credential storage. Disconnect before making changes.",
  },
  "settings.pluginCenter.originalConnectorID": {
    "zh-CN": "原始 Connector ID",
    en: "Original Connector ID",
  },
  "settings.pluginCenter.selectADeclaredConnector": {
    "zh-CN": "选择声明的 Connector",
    en: "Select a declared Connector",
  },
  "settings.pluginCenter.githubAccessToken": {
    "zh-CN": "GitHub 访问令牌",
    en: "GitHub access token",
  },
  "settings.pluginCenter.saveSecurelyAndConfigureGitHub": {
    "zh-CN": "安全保存并配置 GitHub",
    en: "Save securely and configure GitHub",
  },
  "settings.pluginCenter.protectedCredentialsConfigured": {
    "zh-CN": "受保护凭据已配置",
    en: "Protected credentials configured",
  },
  "settings.pluginCenter.enabledStatus": {
    "zh-CN": "启用状态",
    en: "Enabled status",
  },
  "settings.pluginCenter.hideEnabledScope": {
    "zh-CN": "收起启用范围",
    en: "Hide enabled scope",
  },
  "settings.pluginCenter.changeScope": {
    "zh-CN": "修改范围",
    en: "Change scope",
  },
  "settings.pluginCenter.projectConfigurationCanOverrideUserConfigurationThe": {
    "zh-CN": "项目配置可覆盖用户配置；上方显示当前项目的有效状态。",
    en: "Project configuration can override user configuration. The current project's effective status is shown above.",
  },
  "settings.pluginCenter.catalogContentsChanged": {
    "zh-CN": "目录内容已变化",
    en: "Catalog contents changed",
  },
  "settings.pluginCenter.currentExecutionAndSettingsStillUseThe": {
    "zh-CN": "当前运行和设置仍使用已安装快照。",
    en: "Current execution and settings still use the installed snapshot.",
  },
  "settings.pluginCenter.reviewNewSnapshot": {
    "zh-CN": "核对新快照",
    en: "Review new snapshot",
  },
  "settings.pluginCenter.sourceAndInstallationDetails": {
    "zh-CN": "来源与安装详情",
    en: "Source and installation details",
  },
  "settings.pluginCenter.viewThePluginSSourceInstallationInformation": {
    "zh-CN": "查看插件的来源、安装信息和技术详情。",
    en: "View the plugin's source, installation information, and technical details.",
  },
  "settings.pluginCenter.hideDetails": {
    "zh-CN": "收起详情",
    en: "Hide details",
  },
  "settings.pluginCenter.viewDetails": {
    "zh-CN": "查看详情",
    en: "View details",
  },
  "settings.pluginCenter.localPluginPackage": {
    "zh-CN": "本地插件包",
    en: "Local plugin package",
  },
  "settings.pluginCenter.developer": {
    "zh-CN": "开发者",
    en: "Developer",
  },
  "settings.pluginCenter.currentInstallationSnapshot": {
    "zh-CN": "当前安装快照",
    en: "Current installation snapshot",
  },
  "settings.pluginCenter.couldNotCopyTheContentDigest": {
    "zh-CN": "无法复制内容摘要。",
    en: "Could not copy the content digest.",
  },
  "settings.pluginCenter.fullDigestCopied": {
    "zh-CN": "已复制完整摘要",
    en: "Full digest copied",
  },
  "settings.pluginCenter.copyFullDigest": {
    "zh-CN": "复制完整摘要",
    en: "Copy full digest",
  },
  "settings.pluginCenter.catalogContents": {
    "zh-CN": "目录内容",
    en: "Catalog contents",
  },
  "settings.pluginCenter.matchesInstalledSnapshot": {
    "zh-CN": "与已安装快照一致",
    en: "Matches installed snapshot",
  },
  "settings.pluginCenter.differsFromInstalledSnapshot": {
    "zh-CN": "与已安装快照不同",
    en: "Differs from installed snapshot",
  },
  "settings.pluginCenter.catalogVersion": {
    "zh-CN": "目录版本",
    en: "Catalog version",
  },
  "settings.pluginCenter.website": {
    "zh-CN": "网站",
    en: "Website",
  },
  "settings.pluginCenter.capabilitiesDeclaredByCatalog": {
    "zh-CN": "目录声明的能力",
    en: "Capabilities declared by catalog",
  },
  "settings.pluginCenter.technicalDetails": {
    "zh-CN": "技术详情",
    en: "Technical details",
  },
  "settings.pluginCenter.pluginID": {
    "zh-CN": "插件标识",
    en: "Plugin ID",
  },
  "settings.pluginCenter.sourceSnapshotPath": {
    "zh-CN": "来源快照路径",
    en: "Source snapshot path",
  },
  "settings.pluginCenter.catalogComponents": {
    "zh-CN": "目录组件",
    en: "Catalog components",
  },
  "settings.pluginCenter.none": {
    "zh-CN": "无",
    en: "None",
  },
  "settings.pluginCenter.catalogContentDigest": {
    "zh-CN": "目录原包内容摘要",
    en: "Catalog package content digest",
  },
  "settings.pluginCenter.installedContentDigest": {
    "zh-CN": "已安装原包内容摘要",
    en: "Installed package content digest",
  },
  "settings.pluginCenter.catalogPackageDiagnostics": {
    "zh-CN": "目录包诊断",
    en: "Catalog package diagnostics",
  },
  "settings.pluginCenter.catalogPackageSkills": {
    "zh-CN": "目录包 Skills",
    en: "Catalog package skills",
  },
  "settings.pluginCenter.installedSkills": {
    "zh-CN": "已安装 Skills",
    en: "Installed skills",
  },
  "settings.pluginCenter.runTheSetupSkillInARegular": {
    "zh-CN": "在普通对话中运行设置技能，由对话展示执行与审批。",
    en: "Run the setup skill in a regular conversation to view execution and approvals there.",
  },
  "settings.pluginCenter.runSetup": {
    "zh-CN": "运行设置",
    en: "Run setup",
  },
  "settings.pluginConnectionPanel.authenticationStatusCouldNotBeConfirmedCheck": {
    "zh-CN": "认证状态未能确认，请核对后再继续。",
    en: "Authentication status could not be confirmed. Check it before continuing.",
  },
  "settings.pluginConnectionPanel.theAuthenticationResultIsUnconfirmedCheckAuthentication": {
    "zh-CN": "认证结果尚未确认，请先核对认证状态。",
    en: "The authentication result is unconfirmed. Check authentication status first.",
  },
  "settings.pluginConnectionPanel.loadingConnectionStatus": {
    "zh-CN": "正在读取连接状态…",
    en: "Loading connection status…",
  },
  "settings.pluginConnectionPanel.cleanupResultUnconfirmed": {
    "zh-CN": "清理结果待核对",
    en: "Cleanup result unconfirmed",
  },
  "settings.pluginConnectionPanel.connectionStatusUnconfirmed": {
    "zh-CN": "连接状态待核对",
    en: "Connection status unconfirmed",
  },
  "settings.pluginConnectionPanel.servicesDisabled": {
    "zh-CN": "服务已停用",
    en: "Services disabled",
  },
  "settings.pluginConnectionPanel.connectionConfigurationNeedsAttention": {
    "zh-CN": "连接配置需要处理",
    en: "Connection configuration needs attention",
  },
  "settings.pluginConnectionPanel.someServicesAreDisconnected": {
    "zh-CN": "部分服务未连接",
    en: "Some services are disconnected",
  },
  "settings.pluginConnectionPanel.authenticationResultUnconfirmed": {
    "zh-CN": "认证结果待核对",
    en: "Authentication result unconfirmed",
  },
  "settings.pluginConnectionPanel.waitingForAuthentication": {
    "zh-CN": "等待认证完成",
    en: "Waiting for authentication",
  },
  "settings.pluginConnectionPanel.authenticationRequired": {
    "zh-CN": "需要认证",
    en: "Authentication required",
  },
  "settings.pluginConnectionPanel.connectionConfigurationRequired": {
    "zh-CN": "需要配置连接",
    en: "Connection configuration required",
  },
  "settings.pluginConnectionPanel.connected": {
    "zh-CN": "已连接",
    en: "Connected",
  },
  "settings.pluginConnectionPanel.installed": {
    "zh-CN": "已安装",
    en: "Installed",
  },
  "settings.pluginConnectionPanel.authenticatedWaitingToConnect": {
    "zh-CN": "认证完成，等待连接",
    en: "Authenticated, waiting to connect",
  },
  "settings.pluginConnectionPanel.waitingToConnect": {
    "zh-CN": "等待连接",
    en: "Waiting to connect",
  },
  "settings.pluginConnectionPanel.cleanupOfThePreviousServiceIsUnconfirmed": {
    "zh-CN": "旧服务的清理尚未确认，暂不可重新连接。",
    en: "Cleanup of the previous service is unconfirmed. Reconnection is unavailable for now.",
  },
  "settings.pluginConnectionPanel.reloadTheCurrentConnectionStatusFirstThe": {
    "zh-CN": "请先重新读取当前连接状态，不会重新提交连接。",
    en: "Reload the current connection status first. The connection request will not be resubmitted.",
  },
  "settings.pluginConnectionPanel.noMCPServicesAreEnabledInThe": {
    "zh-CN": "当前配置未启用任何 MCP 服务。",
    en: "No MCP services are enabled in the current configuration.",
  },
  "settings.pluginConnectionPanel.serviceDeclarationsAreInvalidOrRestrictedBy": {
    "zh-CN": "服务声明无效或受宿主策略限制，请查看连接诊断。",
    en: "Service declarations are invalid or restricted by host policy. View connection diagnostics.",
  },
  "settings.pluginConnectionPanel.theAuthenticationResultHasNotBeenConfirmed": {
    "zh-CN": "尚未确认认证结果，请先核对认证状态。",
    en: "The authentication result has not been confirmed. Check authentication status first.",
  },
  "settings.pluginConnectionPanel.completeAuthenticationAndCheckItsStatusDisconnected": {
    "zh-CN": "请完成认证并核对状态，尚未连接的服务不会自动启动。",
    en: "Complete authentication and check its status. Disconnected services will not start automatically.",
  },
  "settings.pluginConnectionPanel.completeAuthenticationThenConfirmTrustAndConnect": {
    "zh-CN": "完成认证后，再确认信任并连接服务。",
    en: "Complete authentication, then confirm trust and connect the services.",
  },
  "settings.pluginConnectionPanel.configureTheConnectorsDeclaredByThisPlugin": {
    "zh-CN": "请配置此插件声明的 Connector 后再连接。",
    en: "Configure the Connectors declared by this plugin before connecting.",
  },
  "settings.pluginConnectionPanel.pluginServicesAreAvailableInConversations": {
    "zh-CN": "插件服务已可在对话中使用。",
    en: "Plugin services are available in conversations.",
  },
  "settings.pluginConnectionPanel.someServicesAreAvailableCheckTheStatus": {
    "zh-CN": "部分服务可用，请查看未连接服务的状态。",
    en: "Some services are available. Check the status of disconnected services.",
  },
  "settings.pluginConnectionPanel.thePluginIsInstalledAndEnabled": {
    "zh-CN": "插件已安装并启用。",
    en: "The plugin is installed and enabled.",
  },
  "settings.pluginConnectionPanel.confirmThatYouTrustTheCurrentInstallation": {
    "zh-CN": "连接前，请确认信任当前安装快照。",
    en: "Confirm that you trust the current installation snapshot before connecting.",
  },
  "settings.pluginConnectionPanel.pluginConnectionStatus": {
    "zh-CN": "插件连接状态",
    en: "Plugin connection status",
  },
  "settings.pluginConnectionPanel.reloadConnectionStatus": {
    "zh-CN": "重新读取连接状态",
    en: "Reload connection status",
  },
  "settings.pluginConnectionPanel.authenticationInProgress": {
    "zh-CN": "认证进行中",
    en: "Authentication in progress",
  },
  "settings.pluginConnectionPanel.checkAuthenticationStatus": {
    "zh-CN": "核对认证状态",
    en: "Check authentication status",
  },
  "settings.pluginConnectionPanel.cancelThisAuthentication": {
    "zh-CN": "取消本次认证",
    en: "Cancel this authentication",
  },
  "settings.pluginConnectionPanel.enableAuthentication": {
    "zh-CN": "启用认证",
    en: "Enable authentication",
  },
  "settings.pluginConnectionPanel.authenticateInBrowser": {
    "zh-CN": "在浏览器中认证",
    en: "Authenticate in browser",
  },
  "settings.pluginConnectionPanel.checkConnectionStatus": {
    "zh-CN": "核对连接状态",
    en: "Check connection status",
  },
  "settings.pluginConnectionPanel.startConversation": {
    "zh-CN": "开始对话",
    en: "Start conversation",
  },
  "settings.pluginConnectionPanel.disconnectAndRevokeTrust": {
    "zh-CN": "断开并撤销信任",
    en: "Disconnect and revoke trust",
  },
  "settings.pluginConnectionPanel.afterDisconnectingConfirmTrustAgainToReconnect": {
    "zh-CN": "断开后，再次连接需要重新确认信任。",
    en: "After disconnecting, confirm trust again to reconnect.",
  },
  "settings.pluginConnectionPanel.reviewAndConnect": {
    "zh-CN": "审阅并连接",
    en: "Review and connect",
  },
  "settings.pluginConnectionPanel.thisAuthorization": {
    "zh-CN": "本次授权",
    en: "This authorization",
  },
  "settings.pluginConnectionPanel.allowTheMCPServicesDeclaredByThis": {
    "zh-CN": "允许启动此插件声明的 MCP 服务，并在对话中使用其工具。",
    en: "Allow the MCP services declared by this plugin to start and use their tools in conversations.",
  },
  "settings.pluginConnectionPanel.installationSnapshot": {
    "zh-CN": "安装快照",
    en: "Installation snapshot",
  },
  "settings.pluginConnectionPanel.hideFullDigest": {
    "zh-CN": "收起完整摘要",
    en: "Hide full digest",
  },
  "settings.pluginConnectionPanel.viewFullDigest": {
    "zh-CN": "查看完整摘要",
    en: "View full digest",
  },
  "settings.pluginConnectionPanel.iTrustTheCurrentInstallationSnapshotAnd": {
    "zh-CN": "我信任当前安装快照，并允许启动其 MCP 服务。",
    en: "I trust the current installation snapshot and allow its MCP services to start.",
  },
  "settings.pluginConnectionPanel.trustAndConnect": {
    "zh-CN": "信任并连接",
    en: "Trust and connect",
  },
  "settings.pluginConnectionPanel.connectLater": {
    "zh-CN": "暂不连接",
    en: "Connect later",
  },
  "settings.pluginConnectionPanel.confirmThatYouTrustTheCurrentInstallation2": {
    "zh-CN": "请先确认信任当前安装快照。",
    en: "Confirm that you trust the current installation snapshot first.",
  },
  "settings.pluginConnectionPanel.connectionDiagnostics": {
    "zh-CN": "连接诊断",
    en: "Connection diagnostics",
  },
  "settings.pluginHookSettings.hookConfigurationIsIncompleteCheckSubmissionStatus": {
    "zh-CN": "钩子配置未完成，请核对提交状态。",
    en: "Hook configuration is incomplete. Check submission status.",
  },
  "settings.pluginHookSettings.pluginHooks": {
    "zh-CN": "插件钩子",
    en: "Plugin hooks",
  },
  "settings.pluginHookSettings.refreshHooks": {
    "zh-CN": "刷新钩子",
    en: "Refresh hooks",
  },
  "settings.pluginHookSettings.hooksCanRunShellCommandsOrCall": {
    "zh-CN": "钩子可以运行命令或调用 MCP 工具。安装插件不会自动信任钩子。",
    en: "Hooks can run commands or call MCP tools. Installing a plugin does not trust its hooks.",
  },
  "settings.pluginHookSettings.loadingHooksFromTheInstalledPackage": {
    "zh-CN": "正在读取当前安装包的钩子…",
    en: "Loading hooks from the installed package…",
  },
  "settings.pluginHookSettings.hookSummary": {
    "zh-CN": "钩子摘要",
    en: "Hook summary",
  },
  "settings.pluginHookSettings.installedPackageDigest": {
    "zh-CN": "已安装包摘要",
    en: "Installed package digest",
  },
  "settings.pluginHookSettings.currentDefinitionDigest": {
    "zh-CN": "当前定义摘要",
    en: "Current definition digest",
  },
  "settings.pluginHookSettings.theInstalledPackageHasNoExecutableHook": {
    "zh-CN": "当前安装包没有可执行的钩子定义。",
    en: "The installed package has no executable hook definitions.",
  },
  "settings.pluginHookSettings.currentDefinitionsTrusted": {
    "zh-CN": "当前定义已获信任",
    en: "Current definitions trusted",
  },
  "settings.pluginHookSettings.trustNotGranted": {
    "zh-CN": "尚未授予信任",
    en: "Trust not granted",
  },
  "settings.pluginHookSettings.all": {
    "zh-CN": "全部",
    en: "All",
  },
  "settings.pluginHookSettings.shellCommand": {
    "zh-CN": "Shell 命令",
    en: "Shell command",
  },
  "settings.pluginHookSettings.mcpToolAndArguments": {
    "zh-CN": "MCP 工具及参数",
    en: "MCP tool and arguments",
  },
  "settings.pluginHookSettings.fullDefinition": {
    "zh-CN": "完整定义",
    en: "Full definition",
  },
  "settings.pluginHookSettings.iHaveReviewedThePackageDigestAll": {
    "zh-CN": "我已审阅以上安装包摘要和全部钩子，允许当前定义运行。",
    en: "I have reviewed the package digest and all hooks above, and allow the current definitions to run.",
  },
  "settings.pluginHookSettings.separatelyAllowTheCommandHooksAboveTo": {
    "zh-CN": "也允许以上命令钩子在只读子任务中运行（无网络、无供应商凭据）。",
    en: "Also allow the command hooks above in read-only subtasks (no network, no provider credentials).",
  },
  "settings.pluginHookSettings.trustAndEnableCurrentHooks": {
    "zh-CN": "信任并启用当前钩子",
    en: "Trust and enable current hooks",
  },
  "settings.pluginHookSettings.revokeHookTrustAndDisable": {
    "zh-CN": "撤销钩子信任并停用",
    en: "Revoke hook trust and disable",
  },
  "settings.pluginSkillsPage.personal": {
    "zh-CN": "个人",
    en: "Personal",
  },
  "settings.pluginSkillsPage.savedChangesTakeEffectInNewTasks": {
    "zh-CN": "已保存，将在新任务中生效。",
    en: "Saved. Changes take effect in new tasks.",
  },
  "settings.pluginSkillsPage.pleaseUseValueToHelpMeComplete": {
    "zh-CN": "请使用 {value0} 帮助我完成任务。",
    en: "Please use {value0} to help me complete my task.",
  },
  "settings.pluginSkillsPage.managePlugin": {
    "zh-CN": "管理插件",
    en: "Manage plugin",
  },
  "settings.pluginSkillsPage.tryIt": {
    "zh-CN": "试用",
    en: "Try it",
  },
  "settings.pluginSkillsPage.moreSkillActions": {
    "zh-CN": "更多 Skill 操作",
    en: "More skill actions",
  },
  "settings.pluginSkillsPage.copySkillID": {
    "zh-CN": "复制 Skill 标识",
    en: "Copy skill ID",
  },
  "settings.pluginSkillsPage.source": {
    "zh-CN": "来源",
    en: "Source",
  },
  "settings.pluginSkillsPage.skillID": {
    "zh-CN": "Skill 标识",
    en: "Skill ID",
  },
  "settings.pluginSkillsPage.version": {
    "zh-CN": "版本",
    en: "Version",
  },
  "settings.pluginSkillsPage.status": {
    "zh-CN": "状态",
    en: "Status",
  },
  "settings.pluginSkillsPage.enabled": {
    "zh-CN": "已启用",
    en: "Enabled",
  },
  "settings.pluginSkillsPage.disabled": {
    "zh-CN": "已停用",
    en: "Disabled",
  },
  "settings.pluginSkillsPage.enableTheOwningPluginToReadThe": {
    "zh-CN": "启用所属插件后可读取 Skill 正文。",
    en: "Enable the owning plugin to read the skill content.",
  },
  "settings.pluginSkillsPage.loadingSkillContent": {
    "zh-CN": "正在读取 Skill 内容…",
    en: "Loading skill content…",
  },
  "settings.pluginSkillsPage.searchSkills": {
    "zh-CN": "搜索 Skills",
    en: "Search skills",
  },
  "settings.pluginSkillsPage.searchSkills2": {
    "zh-CN": "搜索 Skills…",
    en: "Search skills…",
  },
  "settings.pluginSkillsPage.clearSkillSearch": {
    "zh-CN": "清除 Skill 搜索",
    en: "Clear skill search",
  },
  "settings.pluginSkillsPage.viewSkillValue": {
    "zh-CN": "查看技能 {value0}",
    en: "View skill {value0}",
  },
  "settings.pluginSkillsPage.disable": {
    "zh-CN": "停用",
    en: "Disable",
  },
  "settings.pluginSkillsPage.enable": {
    "zh-CN": "启用",
    en: "Enable",
  },
  "settings.pluginSkillsPage.valueSkillValue": {
    "zh-CN": "{value0}技能 {value1}",
    en: "{value0} skill {value1}",
  },
  "settings.pluginSkillsPage.noMatchingSkills": {
    "zh-CN": "没有匹配的 Skill",
    en: "No matching skills",
  },
  "settings.pluginSkillsPage.noSkillsInstalled": {
    "zh-CN": "尚未安装 Skills",
    en: "No skills installed",
  },
  "settings.pluginSkillsPage.collapse": {
    "zh-CN": "收起",
    en: "Collapse",
  },
  "settings.pluginSkillsPage.showMoreValueMoreSkills": {
    "zh-CN": "查看更多，另有 {value0, number} 个 Skill",
    en: "{value0, plural, one {Show # more skill} other {Show # more skills}}",
  },
  "settings.pluginSkillsPage.installed": {
    "zh-CN": "已安装",
    en: "Installed",
  },
  "settings.pluginSkillsPage.createSkill": {
    "zh-CN": "创建 Skill",
    en: "Create skill",
  },
  "settings.pluginSkillsPage.tryAnotherNameOrKeyword": {
    "zh-CN": "试试其他名称或关键词。",
    en: "Try another name or keyword.",
  },
  "settings.pluginSkillsPage.createAReusableSkillOrInstallOne": {
    "zh-CN": "创建可复用的 Skill，或从插件市场安装。",
    en: "Create a reusable skill or install one from the plugin marketplace.",
  },
  "settings.pluginSkillsPage.addReusableExpertiseForDifferentTasks": {
    "zh-CN": "为不同任务添加可复用的专业能力。",
    en: "Add reusable expertise for different tasks.",
  },
  "settings.pluginSkillsPage.selectedProject": {
    "zh-CN": "所选项目",
    en: "Selected project",
  },
  "settings.pluginSkillsPage.createASkillInValue": {
    "zh-CN": "在{value0}中创建 Skill",
    en: "Create a skill in {value0}",
  },
  "settings.pluginSkillsPage.installedSkills": {
    "zh-CN": "已安装 Skills",
    en: "Installed skills",
  },
  "settings.pluginSkillsPage.skillSource": {
    "zh-CN": "Skill 来源",
    en: "Skill source",
  },
  "settings.pluginSkillsPage.skillsForValue": {
    "zh-CN": "{value0}的 Skills",
    en: "Skills for {value0}",
  },
  "settings.pluginAuthConfiguration.authenticationConfigurationSavedEnableAuthenticationAndCheck": {
    "zh-CN": "认证配置已保存。启用认证后核对状态，再连接插件。",
    en: "Authentication configuration saved. Enable authentication and check its status before connecting the plugin.",
  },
  "settings.pluginAuthConfiguration.authenticationConfigurationIncomplete": {
    "zh-CN": "认证配置未完成",
    en: "Authentication configuration incomplete",
  },
  "settings.pluginAuthConfiguration.theResultIsStillUnconfirmedCheckAgain": {
    "zh-CN": "结果仍待核对，请稍后查询。",
    en: "The result is still unconfirmed. Check again later.",
  },
  "settings.pluginAuthConfiguration.authenticationConfigurationWasNotAccepted": {
    "zh-CN": "认证配置未被接受",
    en: "Authentication configuration was not accepted",
  },
  "settings.pluginAuthConfiguration.authenticationConfigurationConfirmedSaved": {
    "zh-CN": "认证配置已确认保存。",
    en: "Authentication configuration confirmed saved.",
  },
  "settings.pluginAuthConfiguration.authenticationConfiguration": {
    "zh-CN": "认证配置",
    en: "Authentication configuration",
  },
  "settings.pluginAuthConfiguration.disconnectThePluginFirstCredentialsAreSaved": {
    "zh-CN": "请先断开插件。凭据保存在系统安全存储中。",
    en: "Disconnect the plugin first. Credentials are stored in system secure storage.",
  },
  "settings.pluginAuthConfiguration.oauthClientSecret": {
    "zh-CN": "OAuth 客户端秘密",
    en: "OAuth client secret",
  },
  "settings.pluginAuthConfiguration.oauthSigningPrivateKeyPEM": {
    "zh-CN": "OAuth 签名私钥（PEM）",
    en: "OAuth signing private key (PEM)",
  },
  "settings.pluginAuthConfiguration.signingKeyID": {
    "zh-CN": "签名密钥 ID",
    en: "Signing key ID",
  },
  "settings.pluginAuthConfiguration.apiCredentialsUsernamePassword": {
    "zh-CN": "API 凭据（用户名:密码）",
    en: "API credentials (username:password)",
  },
  "settings.pluginAuthConfiguration.apiCredentials": {
    "zh-CN": "API 凭据",
    en: "API credentials",
  },
  "settings.pluginAuthConfiguration.cimdClientMetadataURLOptional": {
    "zh-CN": "CIMD 客户端元数据 URL（可选）",
    en: "CIMD client metadata URL (optional)",
  },
  "settings.pluginAuthConfiguration.registeredLoopbackCallbackURLOptional": {
    "zh-CN": "已登记的 loopback 回调 URL（可选）",
    en: "Registered loopback callback URL (optional)",
  },
  "settings.pluginAuthConfiguration.saveAuthenticationConfiguration": {
    "zh-CN": "保存认证配置",
    en: "Save authentication configuration",
  },
  "settings.pluginAuthConfiguration.checkAuthenticationSubmission": {
    "zh-CN": "核对认证配置提交",
    en: "Check authentication submission",
  },
  "settings.scopedSkillsSettings.resourceScope": {
    "zh-CN": "资源范围",
    en: "Resource scope",
  },
  "settings.scopedSkillsSettings.user": {
    "zh-CN": "用户",
    en: "User",
  },
  "settings.scopedSkillsSettings.currentTask": {
    "zh-CN": "当前任务",
    en: "Current task",
  },
  "settings.scopedSkillsSettings.currentProject": {
    "zh-CN": "当前项目",
    en: "Current project",
  },
  "settings.scopedSkillsSettings.tryAnotherNameOrKeyword": {
    "zh-CN": "试试其他名称或关键词。",
    en: "Try another name or keyword.",
  },
  "settings.scopedSkillsSettings.standaloneResourcesValue": {
    "zh-CN": "独立资源 · {value0}",
    en: "Standalone resources · {value0}",
  },
  "settings.scopedSkillsSettings.skills": {
    "zh-CN": "技能",
    en: "Skills",
  },
  "settings.scopedSkillsSettings.searchSkills": {
    "zh-CN": "搜索技能",
    en: "Search skills",
  },
  "settings.scopedSkillsSettings.searchSkills2": {
    "zh-CN": "搜索技能…",
    en: "Search skills…",
  },
  "settings.scopedSkillsSettings.clearSearch": {
    "zh-CN": "清除搜索",
    en: "Clear search",
  },
  "settings.scopedSkillsSettings.availableToAllProjectsProjectConfigurationTakes": {
    "zh-CN": "供所有项目使用；同名技能优先使用项目配置。",
    en: "Available to all projects. Project configuration takes priority for skills with the same name.",
  },
  "settings.scopedSkillsSettings.onlyForTheCurrentProjectChangesTake": {
    "zh-CN": "仅用于当前项目；保存后在新任务中生效。",
    en: "Only for the current project. Changes take effect in new tasks after saving.",
  },
  "settings.scopedSkillsSettings.createSkill": {
    "zh-CN": "新建技能",
    en: "Create skill",
  },
  "settings.scopedSkillsSettings.aCustomDeploymentIsInUseTask": {
    "zh-CN": "当前使用自定义部署，任务技能仍由部署文件指定。",
    en: "A custom deployment is in use. Task skills are still specified by the deployment file.",
  },
  "settings.scopedSkillsSettings.viewSkillValue": {
    "zh-CN": "查看技能 {value0}",
    en: "View skill {value0}",
  },
  "settings.scopedSkillsSettings.viewSkillContent": {
    "zh-CN": "查看技能内容",
    en: "View skill content",
  },
  "settings.scopedSkillsSettings.overriddenByProject": {
    "zh-CN": "项目已覆盖",
    en: "Overridden by project",
  },
  "settings.scopedSkillsSettings.disable": {
    "zh-CN": "停用",
    en: "Disable",
  },
  "settings.scopedSkillsSettings.enable": {
    "zh-CN": "启用",
    en: "Enable",
  },
  "settings.scopedSkillsSettings.valueSkillValue": {
    "zh-CN": "{value0}技能 {value1}",
    en: "{value0} skill {value1}",
  },
  "settings.scopedSkillsSettings.savedChangesTakeEffectInNewTasks": {
    "zh-CN": "已保存，将在新任务中生效。",
    en: "Saved. Changes take effect in new tasks.",
  },
  "settings.scopedSkillsSettings.enabledInCurrentProject": {
    "zh-CN": "当前项目已启用",
    en: "Enabled in current project",
  },
  "settings.scopedSkillsSettings.disabledInCurrentProject": {
    "zh-CN": "当前项目已停用",
    en: "Disabled in current project",
  },
  "settings.scopedSkillsSettings.managePlugin": {
    "zh-CN": "管理插件",
    en: "Manage plugin",
  },
  "settings.scopedSkillsSettings.skillContentPreview": {
    "zh-CN": "技能内容预览",
    en: "Skill content preview",
  },
  "settings.scopedSkillsSettings.saveAsAUserSkillAvailableTo": {
    "zh-CN": "保存为用户技能，所有项目均可使用。",
    en: "Save as a user skill available to all projects.",
  },
  "settings.scopedSkillsSettings.saveAsAProjectSkillForThe": {
    "zh-CN": "保存为项目技能，仅用于当前项目。",
    en: "Save as a project skill for the current project only.",
  },
  "settings.scopedSkillsSettings.skillSavedChangesTakeEffectInNew": {
    "zh-CN": "技能已保存，将在新任务中生效。",
    en: "Skill saved. Changes take effect in new tasks.",
  },
  "settings.scopedSkillsSettings.skillID": {
    "zh-CN": "技能 ID",
    en: "Skill ID",
  },
  "settings.scopedSkillsSettings.displayName": {
    "zh-CN": "显示名称",
    en: "Display name",
  },
  "settings.scopedSkillsSettings.description": {
    "zh-CN": "描述",
    en: "Description",
  },
  "settings.scopedSkillsSettings.skillInstructions": {
    "zh-CN": "技能指令",
    en: "Skill instructions",
  },
  "settings.scopedSkillsSettings.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
  },
  "settings.scopedSkillsSettings.saving": {
    "zh-CN": "保存中…",
    en: "Saving…",
  },
  "settings.scopedSkillsSettings.saveSkill": {
    "zh-CN": "保存技能",
    en: "Save skill",
  },
  "settings.resourceSettings.cannotSaveRightNowTryAgainLater": {
    "zh-CN": "当前无法保存，请稍候重试。",
    en: "Cannot save right now. Try again later.",
  },
  "settings.resourceSettings.serverIDCannotBeEmpty": {
    "zh-CN": "服务 ID 不能为空。",
    en: "Server ID cannot be empty.",
  },
  "settings.resourceSettings.theMCPConfigurationIsNotValidJSON": {
    "zh-CN": "MCP 配置不是有效的 JSON。",
    en: "The MCP configuration is not valid JSON.",
  },
  "settings.resourceSettings.provideAnMCPConfigurationContainingTransport": {
    "zh-CN": "请提供包含 transport 的 MCP 配置。",
    en: "Provide an MCP configuration containing transport.",
  },
  "settings.resourceSettings.commandCannotBeEmpty": {
    "zh-CN": "命令不能为空。",
    en: "Command cannot be empty.",
  },
  "settings.resourceSettings.theServerURLMustBeAValid": {
    "zh-CN": "服务器 URL 必须是有效的 HTTP(S) 地址。",
    en: "The server URL must be a valid HTTP(S) address.",
  },
  "settings.resourceSettings.configurationSaved": {
    "zh-CN": "配置已保存",
    en: "Configuration saved",
  },
  "settings.resourceSettings.mcpConfiguration": {
    "zh-CN": "MCP 配置",
    en: "MCP configuration",
  },
  "settings.resourceSettings.user": {
    "zh-CN": "用户",
    en: "User",
  },
  "settings.resourceSettings.currentProject": {
    "zh-CN": "当前项目",
    en: "Current project",
  },
  "settings.resourceSettings.standaloneResourcesValue": {
    "zh-CN": "独立资源 · {value0}",
    en: "Standalone resources · {value0}",
  },
  "settings.resourceSettings.clearSearch": {
    "zh-CN": "清除搜索",
    en: "Clear search",
  },
  "settings.resourceSettings.searchMCPServers": {
    "zh-CN": "搜索 MCP 服务器…",
    en: "Search MCP servers…",
  },
  "settings.resourceSettings.searchMCPServers2": {
    "zh-CN": "搜索 MCP 服务器",
    en: "Search MCP servers",
  },
  "settings.resourceSettings.reusableAcrossAllProjectsTheConnectionToggle": {
    "zh-CN": "供所有项目复用；连接开关仅影响当前项目。",
    en: "Reusable across all projects. The connection toggle affects only the current project.",
  },
  "settings.resourceSettings.onlyForTheCurrentProject": {
    "zh-CN": "仅用于当前项目。",
    en: "Only for the current project.",
  },
  "settings.resourceSettings.addMCP": {
    "zh-CN": "新增 MCP",
    en: "Add MCP",
  },
  "settings.resourceSettings.notApplied": {
    "zh-CN": "未应用",
    en: "Not applied",
  },
  "settings.resourceSettings.connected": {
    "zh-CN": "已连接",
    en: "Connected",
  },
  "settings.resourceSettings.disconnected": {
    "zh-CN": "未连接",
    en: "Disconnected",
  },
  "settings.resourceSettings.connectionFailed": {
    "zh-CN": "连接失败",
    en: "Connection failed",
  },
  "settings.resourceSettings.toolCatalogExpired": {
    "zh-CN": "工具目录已过期",
    en: "Tool catalog expired",
  },
  "settings.resourceSettings.connecting": {
    "zh-CN": "连接中",
    en: "Connecting",
  },
  "settings.resourceSettings.editMCPValue": {
    "zh-CN": "编辑 MCP {value0}",
    en: "Edit MCP {value0}",
  },
  "settings.resourceSettings.connectValue": {
    "zh-CN": "连接 {value0}",
    en: "Connect {value0}",
  },
  "settings.resourceSettings.disconnectValue": {
    "zh-CN": "断开 {value0}",
    en: "Disconnect {value0}",
  },
  "settings.resourceSettings.connectionStatusRefreshedForValue": {
    "zh-CN": "{value0} 连接状态已刷新",
    en: "Connection status refreshed for {value0}",
  },
  "settings.resourceSettings.noToolsAvailableYetConnectAndRefresh": {
    "zh-CN": "尚无可用工具，连接成功后刷新查看。",
    en: "No tools available yet. Connect and refresh to view them.",
  },
  "settings.resourceSettings.enabledInCurrentProject": {
    "zh-CN": "当前项目已启用",
    en: "Enabled in current project",
  },
  "settings.resourceSettings.disabledInCurrentProject": {
    "zh-CN": "当前项目已停用",
    en: "Disabled in current project",
  },
  "settings.resourceSettings.managePlugin": {
    "zh-CN": "管理插件",
    en: "Manage plugin",
  },
  "settings.resourceSettings.backToMCPServers": {
    "zh-CN": "← 返回 MCP 服务器",
    en: "← Back to MCP servers",
  },
  "settings.resourceSettings.editMCPServer": {
    "zh-CN": "编辑 MCP 服务器",
    en: "Edit MCP server",
  },
  "settings.resourceSettings.addMCPServer": {
    "zh-CN": "新增 MCP 服务器",
    en: "Add MCP server",
  },
  "settings.resourceSettings.configureALocalCommandOrHTTPService": {
    "zh-CN": "配置本地命令或 HTTP 服务。保存后点击列表开关连接，查看服务器提供的工具。",
    en: "Configure a local command or HTTP service. After saving, use the list toggle to connect and view the server's tools.",
  },
  "settings.resourceSettings.serverID": {
    "zh-CN": "服务 ID",
    en: "Server ID",
  },
  "settings.resourceSettings.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
  },
  "settings.resourceSettings.saving": {
    "zh-CN": "保存中…",
    en: "Saving…",
  },
  "settings.resourceSettings.saveMCPConfiguration": {
    "zh-CN": "保存 MCP 配置",
    en: "Save MCP configuration",
  },
  "settings.resourceSettings.couldNotReadValueValue": {
    "zh-CN": "读取 {value0} 失败：{value1}",
    en: "Could not read {value0}: {value1}",
  },
  "settings.resourceSettings.loadingResource": {
    "zh-CN": "正在读取资源…",
    en: "Loading resource…",
  },
  "settings.resourceSettings.bytes": {
    "zh-CN": "字节",
    en: "bytes",
  },
  "settings.resourceSettings.preview": {
    "zh-CN": "预览",
    en: "Preview",
  },
  "settings.resourceSettings.source": {
    "zh-CN": "源码",
    en: "Source",
  },
  "settings.resourceSettings.readMore": {
    "zh-CN": "继续读取",
    en: "Read more",
  },
  "settings.resourceSettings.currentTask": {
    "zh-CN": "当前任务",
    en: "Current task",
  },
  "settings.resourceSettings.skills": {
    "zh-CN": "技能",
    en: "Skills",
  },
  "settings.resourceSettings.searchSkills": {
    "zh-CN": "搜索技能…",
    en: "Search skills…",
  },
  "settings.resourceSettings.searchSkills2": {
    "zh-CN": "搜索技能",
    en: "Search skills",
  },
  "settings.resourceSettings.thisTaskHasValueBoundSkillsSelect": {
    "zh-CN": "当前任务绑定 {value0} 个技能；在会话配置中选择下一轮使用的预设允许技能。",
    en: "This task has {value0, plural, one {# bound skill} other {# bound skills}}. Select the preset allowed skills for the next turn in conversation settings.",
  },
  "settings.resourceSettings.versionValueViewSkillContent": {
    "zh-CN": "版本 {value0} · 查看技能内容",
    en: "Version {value0} · View skill content",
  },
  "settings.resourceSettings.unavailable": {
    "zh-CN": "不可用",
    en: "Unavailable",
  },
  "settings.resourceSettings.read": {
    "zh-CN": "已读取",
    en: "Read",
  },
  "settings.resourceSettings.available": {
    "zh-CN": "可用",
    en: "Available",
  },
  "settings.resourceSettings.selectATaskToViewSkillsWithin": {
    "zh-CN": "请先选择任务，以查看该任务权限范围内的技能。",
    en: "Select a task to view skills within its permission scope.",
  },
  "settings.resourceSettings.noMatchingSkills": {
    "zh-CN": "没有匹配的技能",
    en: "No matching skills",
  },
  "settings.resourceSettings.noSkillsAreAvailableForTheCurrent": {
    "zh-CN": "当前任务没有可用技能。",
    en: "No skills are available for the current task.",
  },
  "settings.resourceSettings.versionValueSkillResourcesForTheCurrent": {
    "zh-CN": "版本 {value0} · 当前任务的技能资源",
    en: "Version {value0} · Skill resources for the current task",
  },
  "settings.resourceSettings.skillResources": {
    "zh-CN": "技能资源",
    en: "Skill resources",
  },
  "settings.resourceSettings.skillMdOrReferencesGuideMd": {
    "zh-CN": "SKILL.md 或 references/guide.md",
    en: "SKILL.md or references/guide.md",
  },
  "settings.resourceSettings.readResource": {
    "zh-CN": "读取资源",
    en: "Read resource",
  },
  "settings.resourceSettings.backToSKILLMd": {
    "zh-CN": "返回 SKILL.md",
    en: "Back to SKILL.md",
  },
  "settings.mcpAppsSettings.thisAppUsesAnUnsupportedSettingsFormat": {
    "zh-CN": "此应用的设置格式不受支持，未应用任何更改。",
    en: "This app uses an unsupported settings format. No changes were applied.",
  },
  "settings.mcpAppsSettings.otherSettings": {
    "zh-CN": "其他设置",
    en: "Other settings",
  },
  "settings.mcpAppsSettings.settings": {
    "zh-CN": "设置",
    en: "Settings",
  },
  "settings.mcpAppsSettings.checkTheValueOfValue": {
    "zh-CN": "请检查“{value0}”的值。",
    en: "Check the value of “{value0}”.",
  },
  "settings.mcpAppsSettings.theSettingsUpdateIsUnconfirmedRefreshAnd": {
    "zh-CN": "设置更新未确认。请刷新核对后再修改。",
    en: "The settings update is unconfirmed. Refresh and check before making more changes.",
  },
  "settings.mcpAppsSettings.valueSettings": {
    "zh-CN": "{value0} 设置",
    en: "{value0} settings",
  },
  "settings.mcpAppsSettings.runValue": {
    "zh-CN": "运行 {value0}",
    en: "Run {value0}",
  },
  "settings.mcpAppsSettings.theOperationDidNotCompleteTryAgain": {
    "zh-CN": "操作未完成，请重试。",
    en: "The operation did not complete. Try again.",
  },
  "settings.mcpAppsSettings.run": {
    "zh-CN": "运行",
    en: "Run",
  },
  "settings.mcpAppsSettings.working": {
    "zh-CN": "处理中…",
    en: "Working…",
  },
  "settings.mcpAppsSettings.saveSettings": {
    "zh-CN": "保存设置",
    en: "Save settings",
  },
  "settings.mcpAppsSettings.appEntryPoints": {
    "zh-CN": "应用入口",
    en: "App entry points",
  },
  "settings.mcpAppsSettings.couldNotSearchThisAppTryAgain": {
    "zh-CN": "无法搜索此应用，请重试。",
    en: "Could not search this app. Try again.",
  },
  "settings.mcpAppsSettings.appReferences": {
    "zh-CN": "应用引用",
    en: "App references",
  },
  "settings.mcpAppsSettings.searchReferences": {
    "zh-CN": "搜索引用",
    en: "Search references",
  },
  "settings.mcpConfigEditor.form": {
    "zh-CN": "表单",
    en: "Form",
  },
  "settings.mcpConfigEditor.mcpConfigurationJSON": {
    "zh-CN": "MCP 配置 JSON",
    en: "MCP configuration JSON",
  },
  "settings.mcpConfigEditor.fixTheJSONBeforeSwitchingToThe": {
    "zh-CN": "请先修正 JSON，再切换到表单。",
    en: "Fix the JSON before switching to the form.",
  },
  "settings.mcpConfigEditor.type": {
    "zh-CN": "类型",
    en: "Type",
  },
  "settings.mcpConfigEditor.stdioLocalCommand": {
    "zh-CN": "stdio（本地命令）",
    en: "stdio (local command)",
  },
  "settings.mcpConfigEditor.command": {
    "zh-CN": "命令",
    en: "Command",
  },
  "settings.mcpConfigEditor.argumentsOnePerLine": {
    "zh-CN": "参数（每行一个）",
    en: "Arguments (one per line)",
  },
  "settings.mcpConfigEditor.serverURL": {
    "zh-CN": "服务器 URL",
    en: "Server URL",
  },
  "settings.mcpConfigEditor.authenticationEnvironmentVariableOptional": {
    "zh-CN": "认证环境变量（可选）",
    en: "Authentication environment variable (optional)",
  },
  "settings.mcpConfigEditor.advancedSettings": {
    "zh-CN": "高级设置",
    en: "Advanced settings",
  },
  "settings.mcpConfigEditor.workingDirectoryOptional": {
    "zh-CN": "工作目录（可选）",
    en: "Working directory (optional)",
  },
  "settings.mcpConfigEditor.inheritedEnvironmentVariablesOneNamePerLine": {
    "zh-CN": "继承环境变量（每行一个名称）",
    en: "Inherited environment variables (one name per line)",
  },
  "settings.mcpConfigEditor.enterVariableNamesFromTheStartupEnvironment": {
    "zh-CN": "填写启动环境中的变量名称，不在此处保存密钥。",
    en: "Enter variable names from the startup environment. Do not save secrets here.",
  },
  "settings.mcpConfigEditor.startupTimeoutMs": {
    "zh-CN": "启动超时（毫秒）",
    en: "Startup timeout (ms)",
  },
  "settings.mcpConfigEditor.callTimeoutMs": {
    "zh-CN": "调用超时（毫秒）",
    en: "Call timeout (ms)",
  },
  "settings.hooksSettings.theConfigurationSourceChangedCancelEditingAnd": {
    "zh-CN": "配置来源已变化，请取消编辑并重新读取。",
    en: "The configuration source changed. Cancel editing and reload it.",
  },
  "settings.hooksSettings.commandArgumentsMustBeAJSONArray": {
    "zh-CN": "命令参数必须是字符串组成的 JSON 数组。",
    en: "Command arguments must be a JSON array of strings.",
  },
  "settings.hooksSettings.configurationSavedRestartTheBackendToApply": {
    "zh-CN": "配置已保存，重启后台后生效。",
    en: "Configuration saved. Restart the backend to apply it.",
  },
  "settings.hooksSettings.restartCancelledYourConfigurationIsSaved": {
    "zh-CN": "已取消重启，配置仍保留。",
    en: "Restart cancelled. Your configuration is saved.",
  },
  "settings.hooksSettings.theBackendHasNotStoppedConfigurationHas": {
    "zh-CN": "后台尚未停止，配置尚未应用。",
    en: "The backend has not stopped. Configuration has not been applied.",
  },
  "settings.hooksSettings.theBackendReconnectedCheckTheLoadStatus": {
    "zh-CN": "后台已重新连接，请核对各项目的加载状态。",
    en: "The backend reconnected. Check the load status of each project.",
  },
  "settings.hooksSettings.hookManagement": {
    "zh-CN": "钩子管理",
    en: "Hook management",
  },
  "settings.hooksSettings.runToolEventCommandsInOrderRestart": {
    "zh-CN": "按顺序运行工具事件命令，修改后重启后台生效。",
    en: "Run tool event commands in order. Restart the backend to apply changes.",
  },
  "settings.hooksSettings.toolHooks": {
    "zh-CN": "工具钩子",
    en: "Tool hooks",
  },
  "settings.hooksSettings.refreshHooks": {
    "zh-CN": "刷新钩子",
    en: "Refresh hooks",
  },
  "settings.hooksSettings.addHook": {
    "zh-CN": "添加钩子",
    en: "Add hook",
  },
  "settings.hooksSettings.moveValueUp": {
    "zh-CN": "上移 {value0}",
    en: "Move {value0} up",
  },
  "settings.hooksSettings.moveUp": {
    "zh-CN": "上移",
    en: "Move up",
  },
  "settings.hooksSettings.moveValueDown": {
    "zh-CN": "下移 {value0}",
    en: "Move {value0} down",
  },
  "settings.hooksSettings.moveDown": {
    "zh-CN": "下移",
    en: "Move down",
  },
  "settings.hooksSettings.noHooksConfigured": {
    "zh-CN": "尚未配置钩子。",
    en: "No hooks configured.",
  },
  "settings.hooksSettings.applyConfiguration": {
    "zh-CN": "配置生效",
    en: "Apply configuration",
  },
  "settings.hooksSettings.savingDoesNotInterruptExecutionApplyingChanges": {
    "zh-CN": "保存不会中断执行；应用时需重启共享后台。",
    en: "Saving does not interrupt execution. Applying changes requires restarting the shared backend.",
  },
  "settings.hooksSettings.restartBackendAndApply": {
    "zh-CN": "重启后台并应用",
    en: "Restart backend and apply",
  },
  "settings.hooksSettings.connectBackendAndApply": {
    "zh-CN": "连接后台并应用",
    en: "Connect backend and apply",
  },
  "settings.hooksSettings.loadOnNextStart": {
    "zh-CN": "下次启动加载",
    en: "Load on next start",
  },
  "settings.hooksSettings.currentConfigurationLoaded": {
    "zh-CN": "已加载当前配置",
    en: "Current configuration loaded",
  },
  "settings.hooksSettings.restartRequiredToApply": {
    "zh-CN": "待重启应用",
    en: "Restart required to apply",
  },
  "settings.hooksSettings.configurationDetails": {
    "zh-CN": "配置详情",
    en: "Configuration details",
  },
  "settings.hooksSettings.loadingConfigurationSource": {
    "zh-CN": "正在读取配置来源…",
    en: "Loading configuration source…",
  },
  "settings.hooksSettings.manageCoreExtensionHooksOtherFormatsFrom": {
    "zh-CN": "管理 Core 扩展钩子。命令直接执行，不经过 shell。",
    en: "Manage Core extension hooks. Commands run directly, without a shell.",
  },
  "settings.hooksSettings.restartingDisconnectsAllWindowsRunningTasksTerminals": {
    "zh-CN": "重启会断开所有窗口；运行中的任务、终端或待确认操作可能阻止停止。",
    en: "Restarting disconnects all windows. Running tasks, terminals, or pending approvals may prevent shutdown.",
  },
  "settings.hooksSettings.editHook": {
    "zh-CN": "编辑钩子",
    en: "Edit hook",
  },
  "settings.hooksSettings.commandsReceiveOneLineOfEventJSON": {
    "zh-CN": "命令接收一行事件 JSON，并返回钩子响应。保存时由 Core 校验完整扩展配置。",
    en: "Commands receive one line of event JSON and return a hook response. Core validates the full extension configuration when saving.",
  },
  "settings.hooksSettings.reloadHookConfiguration": {
    "zh-CN": "重新读取钩子配置",
    en: "Reload hook configuration",
  },
  "settings.hooksSettings.hookName": {
    "zh-CN": "钩子名称",
    en: "Hook name",
  },
  "settings.hooksSettings.triggerEvent": {
    "zh-CN": "触发事件",
    en: "Trigger event",
  },
  "settings.hooksSettings.beforeToolExecution": {
    "zh-CN": "工具执行前",
    en: "Before tool execution",
  },
  "settings.hooksSettings.afterToolSuccess": {
    "zh-CN": "工具成功后",
    en: "After tool success",
  },
  "settings.hooksSettings.afterToolFailure": {
    "zh-CN": "工具失败后",
    en: "After tool failure",
  },
  "settings.hooksSettings.matchTools": {
    "zh-CN": "匹配工具",
    en: "Match tools",
  },
  "settings.hooksSettings.commandArgumentsJSONArray": {
    "zh-CN": "命令参数（JSON 数组）",
    en: "Command arguments (JSON array)",
  },
  "settings.hooksSettings.timeoutMs": {
    "zh-CN": "超时（毫秒）",
    en: "Timeout (ms)",
  },
  "settings.hooksSettings.confirmHookDeletion": {
    "zh-CN": "确认删除钩子",
    en: "Confirm hook deletion",
  },
  "settings.hooksSettings.cancelDeletion": {
    "zh-CN": "取消删除",
    en: "Cancel deletion",
  },
  "settings.hooksSettings.deleteHook2": {
    "zh-CN": "删除钩子",
    en: "Delete hook",
  },
  "settings.hooksSettings.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
  },
  "settings.hooksSettings.saveHook": {
    "zh-CN": "保存钩子",
    en: "Save hook",
  },
  "settings.pluginResources.thePluginCatalogIsDisabledInThis": {
    "zh-CN": "当前 Core 未启用插件目录。独立资源仍可使用。",
    en: "The plugin catalog is disabled in this Core. Standalone resources are still available.",
  },
  "settings.pluginResources.pluginCatalogValue": {
    "zh-CN": "插件目录：{value0}",
    en: "Plugin catalog: {value0}",
  },
  "settings.pluginResources.theInstallationSnapshotForPluginValueChanged": {
    "zh-CN": "插件 {value0} 的安装快照已变化，请刷新资源。",
    en: "The installation snapshot for plugin {value0} changed. Refresh resources.",
  },
  "settings.pluginResources.pluginMCPValue": {
    "zh-CN": "插件 MCP：{value0}",
    en: "Plugin MCP: {value0}",
  },
  "settings.pluginResources.selectAProjectToViewInstalledPlugin": {
    "zh-CN": "选择项目后查看已安装插件资源。",
    en: "Select a project to view installed plugin resources.",
  },
  "settings.pluginResources.theProjectIsDisconnectedConnectCoreTo": {
    "zh-CN": "项目尚未连接，请连接 Core 后查看插件资源。",
    en: "The project is disconnected. Connect Core to view plugin resources.",
  },
  "settings.pluginHookSettings.thePluginHookResponseFormatIsInvalid": {
    "zh-CN": "插件钩子响应格式无效。",
    en: "The plugin hook response format is invalid.",
  },
  "settings.pluginHookSettings.hooksAreUnavailableForThisPluginRefresh": {
    "zh-CN": "当前插件的钩子不可用，请刷新插件详情。",
    en: "Hooks are unavailable for this plugin. Refresh the plugin details.",
  },
  "settings.pluginHookSettings.theInstalledPackageChangedRefreshThePlugin": {
    "zh-CN": "已安装包已变化，请刷新插件详情后重新审阅。",
    en: "The installed package changed. Refresh the plugin details and review it again.",
  },
  "settings.pluginHookSettings.theHookDefinitionFormatIsInvalid": {
    "zh-CN": "钩子定义格式无效。",
    en: "The hook definition format is invalid.",
  },
  "settings.pluginSkillsPage.theSkillContentExceedsTheReadableLimit": {
    "zh-CN": "Skill 正文超过可读取的 256 KiB 上限。",
    en: "The skill content exceeds the readable limit of 256 KiB.",
  },
  "settings.pluginSkillsPage.connectTheOwningProjectToReadThe": {
    "zh-CN": "连接所属项目后读取 Skill 正文。",
    en: "Connect the owning project to read the skill content.",
  },
  "settings.pluginSkillsPage.theSkillPageIsInvalid": {
    "zh-CN": "Skill 分页无效。",
    en: "The skill page is invalid.",
  },
  "settings.pluginCenter.pluginOperationFailed": {
    "zh-CN": "插件操作失败，请刷新目录核对状态。",
    en: "The plugin operation failed. Refresh the catalog to check its status.",
  },
  "settings.pluginCenter.submissionResultUnconfirmed": {
    "zh-CN": "提交结果待核对，不会自动重发。请核对原请求。",
    en: "The submission result is unconfirmed and will not be resent automatically. Check the original request.",
  },
  "settings.pluginCenter.errorCode": {
    "zh-CN": "错误：{value0}",
    en: "Error: {value0}",
  },
  "settings.pluginCenter.requestId": {
    "zh-CN": "请求：{value0}",
    en: "Request: {value0}",
  },
  "settings.pluginHookSettings.couldNotLoadPluginHooks": {
    "zh-CN": "读取插件钩子失败。",
    en: "Could not load plugin hooks.",
  },
  "settings.pluginConnectionPanel.authenticatedServiceState": {
    "zh-CN": "已认证 · {state}",
    en: "Authenticated · {state}",
  },
  "settings.pluginResources.connectedState": {
    "zh-CN": "已连接",
    en: "Connected",
  },
  "settings.pluginResources.disconnectedState": {
    "zh-CN": "未连接",
    en: "Disconnected",
  },
  "settings.pluginResources.failedState": {
    "zh-CN": "连接失败",
    en: "Connection failed",
  },
  "settings.pluginResources.connectingState": {
    "zh-CN": "连接中",
    en: "Connecting",
  },
  "settings.pluginResources.disabledState": {
    "zh-CN": "已停用",
    en: "Disabled",
  },
  "settings.pluginResources.authRequiredState": {
    "zh-CN": "需要认证",
    en: "Authentication required",
  },
  "settings.pluginResources.partialState": {
    "zh-CN": "部分服务未连接",
    en: "Some services are disconnected",
  },
  "settings.pluginResources.cleanupUnknownState": {
    "zh-CN": "清理结果待核对",
    en: "Cleanup result unconfirmed",
  },
  "settings.pluginResources.authenticationState": {
    "zh-CN": "认证未完成",
    en: "Authentication incomplete",
  },
  "settings.pluginResources.startupState": {
    "zh-CN": "启动失败",
    en: "Startup failed",
  },
  "settings.pluginResources.discoveryState": {
    "zh-CN": "工具发现失败",
    en: "Tool discovery failed",
  },
  "settings.pluginResources.staleState": {
    "zh-CN": "工具目录已过期",
    en: "Tool catalog expired",
  },
  "settings.pluginResources.notAppliedState": {
    "zh-CN": "未应用",
    en: "Not applied",
  },
  "settings.pluginResources.unknownState": {
    "zh-CN": "状态待核对",
    en: "Status unconfirmed",
  },
  "settings.pluginResources.unsupportedState": {
    "zh-CN": "当前配置不受支持",
    en: "Current configuration unsupported",
  },
  "settings.pluginResources.missingMappingState": {
    "zh-CN": "需要配置凭据映射",
    en: "Credential mapping required",
  },
  "settings.pluginResources.configurationState": {
    "zh-CN": "服务配置无效，请在插件详情查看",
    en: "Invalid service configuration. View plugin details.",
  },
  "settings.pluginResources.policyState": {
    "zh-CN": "服务配置受宿主策略限制",
    en: "Service configuration is restricted by host policy",
  },
  "settings.pluginResources.pluginSourceLabel": {
    "zh-CN": "插件 {value0} · {value1}",
    en: "Plugin {value0} · {value1}",
  },
  "settings.pluginResources.unknownStateDetails": {
    "zh-CN": "状态待核对，请在插件详情查看",
    en: "Status unconfirmed. View plugin details.",
  },
  "settings.pluginResources.resourceDiagnosticsAvailable": {
    "zh-CN": "插件资源包含诊断信息，请在插件详情查看。",
    en: "Plugin resources include diagnostics. View plugin details.",
  },
  "settings.pluginResources.pluginDiagnostic": {
    "zh-CN": "插件 {value0}：{value1}",
    en: "Plugin {value0}: {value1}",
  },
  "settings.pluginResources.readFailed": {
    "zh-CN": "读取插件资源失败。",
    en: "Could not load plugin resources.",
  },
  "settings.scopedSkillsSettings.truncatedContent": {
    "zh-CN": "（内容过长，仅预览前 256 KiB）",
    en: "(Content is too long. Previewing only the first 256 KiB.)",
  },
  "settings.scopedSkillsSettings.noMatchingResources": {
    "zh-CN": "{kind, select, mcp {没有匹配的 MCP 服务器} other {没有匹配的技能}}",
    en: "{kind, select, mcp {No matching MCP servers} other {No matching skills}}",
  },
  "settings.scopedSkillsSettings.noResourcesYet": {
    "zh-CN":
      "暂无{scope, select, user {用户} other {项目}}{kind, select, mcp { MCP 服务器} other {技能}}",
    en: "No {scope, select, user {user} other {project}} {kind, select, mcp {MCP servers} other {skills}} yet",
  },
  "settings.scopedSkillsSettings.sharedResources": {
    "zh-CN": "在这里添加的{kind, select, mcp { MCP 服务器} other {技能}}可供各项目复用。",
    en: "{kind, select, mcp {MCP servers} other {Skills}} added here can be reused across projects.",
  },
  "settings.scopedSkillsSettings.projectResources": {
    "zh-CN": "在这里管理仅用于当前项目的{kind, select, mcp { MCP 服务器} other {技能}}。",
    en: "Manage {kind, select, mcp {MCP servers} other {skills}} for the current project here.",
  },
  "settings.scopedSkillsSettings.addResource": {
    "zh-CN": "添加{kind, select, mcp { MCP 服务器} other {技能}}",
    en: "Add {kind, select, mcp {MCP server} other {skill}}",
  },
  "settings.hooksSettings.deleteHookConfirmation": {
    "zh-CN": "删除钩子“{name}”？保存后仍需重启后台生效。",
    en: "Delete hook “{name}”? Restart the backend after saving to apply this change.",
  },
  "settings.hooksSettings.editHookNamed": {
    "zh-CN": "编辑{value0}",
    en: "Edit {value0}",
  },
  "settings.mcpConfigEditor.streamableHttp": {
    "zh-CN": "HTTP（Streamable HTTP）",
    en: "HTTP (Streamable HTTP)",
  },
  "settings.pluginCenter.managedProjectName": {
    "zh-CN": "管理项目 · {name}",
    en: "Managed project · {name}",
  },
  "settings.pluginCenter.projectEnabledState": {
    "zh-CN": "当前项目{enabled, select, true {已启用} other {已停用}}",
    en: "{enabled, select, true {Enabled} other {Disabled}} in current project",
  },
  "settings.pluginCenter.installedVersionNumber": {
    "zh-CN": "已安装版本{version}",
    en: "Installed version {version}",
  },
  "settings.pluginCenter.enableForScope": {
    "zh-CN": "在{scope, select, user {用户} other {项目}}范围启用",
    en: "Enable for {scope, select, user {user} other {project}} scope",
  },
  "settings.pluginCenter.disableForScope": {
    "zh-CN": "在{scope, select, user {用户} other {项目}}范围停用",
    en: "Disable for {scope, select, user {user} other {project}} scope",
  },
  "settings.pluginHookSettings.hookExecutionSummary": {
    "zh-CN":
      "匹配：{matcher} · 超时：{timeout, number} 秒 · {mode, select, background {后台执行} other {同步执行}}",
    en: "Match: {matcher} · Timeout: {timeout, number} seconds · {mode, select, background {Run in background} other {Run synchronously}}",
  },
  "settings.pluginCenter.sourceName": {
    "zh-CN": "来源：{name}",
    en: "Source: {name}",
  },
  "settings.pluginCenter.gitUrl": {
    "zh-CN": "Git URL",
    en: "Git URL",
  },
  "settings.pluginHookSettings.readOnlyCommandPermission": {
    "zh-CN":
      "普通只读子任务命令许可：{trusted, select, true {当前定义已单独获准} other {尚未单独授权}}",
    en: "Command permission for regular read-only subtasks: {trusted, select, true {Current definitions separately authorized} other {Not separately authorized}}",
  },
  "settings.pluginHookSettings.statusMessageValue": {
    "zh-CN": "状态提示：{message}",
    en: "Status message: {message}",
  },
  "settings.pluginHookSettings.windowsCommandValue": {
    "zh-CN": "Windows 命令：{command}",
    en: "Windows command: {command}",
  },
  "settings.resourceSettings.toolCount": {
    "zh-CN": "工具 · {count, number}",
    en: "Tools · {count, number}",
  },
  "settings.pluginCenter.installPlugin": {
    "zh-CN": "安装",
    en: "Install",
  },
  "settings.pluginCenter.viewPluginDetails": {
    "zh-CN": "查看插件详情",
    en: "View plugin details",
  },
  "settings.pluginCenter.tryPlugin": {
    "zh-CN": "试用",
    en: "Try",
  },
  "settings.pluginCenter.usageExamples": {
    "zh-CN": "使用示例",
    en: "Usage examples",
  },
  "settings.pluginCenter.mcpConnections": {
    "zh-CN": "MCP 连接",
    en: "MCP connections",
  },
  "settings.pluginCenter.mcpDeclarationNeedsReview": {
    "zh-CN": "MCP 声明需要检查，请在连接设置中查看诊断。",
    en: "The MCP declaration needs review. Check diagnostics in connection settings.",
  },
  "settings.pluginCenter.mcpDeclaredInstallToReview": {
    "zh-CN": "此插件声明了 MCP 服务。安装后可查看各项服务及其认证要求。",
    en: "This plugin declares MCP services. Install to review each service and its authentication requirements.",
  },
  "settings.pluginCenter.installDoesNotConnect": {
    "zh-CN": "安装不会启动服务或授权账户。请在管理中核对要求并明确连接。",
    en: "Installation does not start services or authorize an account. Review requirements and explicitly connect in Manage.",
  },
  "settings.pluginCenter.declaredAuthenticationRequired": {
    "zh-CN": "此服务要求认证。",
    en: "This service requires authentication.",
  },
  "settings.pluginCenter.declaredAuthenticationOptional": {
    "zh-CN": "此服务支持按需认证。",
    en: "This service supports optional authentication.",
  },
  "settings.pluginCenter.declaredNoAuthentication": {
    "zh-CN": "此服务未要求账户认证。",
    en: "This service does not require account authentication.",
  },
  "settings.pluginCenter.pluginInformation": {
    "zh-CN": "插件信息",
    en: "Plugin information",
  },
  "settings.pluginCenter.category": {
    "zh-CN": "类别",
    en: "Category",
  },
  "settings.pluginCenter.privacyPolicy": {
    "zh-CN": "隐私政策",
    en: "Privacy policy",
  },
  "settings.pluginCenter.termsOfService": {
    "zh-CN": "服务条款",
    en: "Terms of service",
  },
  "settings.pluginCenter.enableSkillInProject": {
    "zh-CN": "在当前项目启用 Skill {name}",
    en: "Enable Skill {name} in this project",
  },
  "settings.pluginCenter.enableMcpInProject": {
    "zh-CN": "在当前项目启用 MCP {name}",
    en: "Enable MCP {name} in this project",
  },
  "settings.pluginCenter.componentOffInProject": {
    "zh-CN": "已在当前项目关闭。",
    en: "Off in this project.",
  },
  "settings.pluginCenter.componentOnRestricted": {
    "zh-CN": "已选择开启，当前受插件或策略限制。",
    en: "Selected on, but currently restricted by the plugin or policy.",
  },
  "settings.pluginCenter.skillChoiceOn": {
    "zh-CN": "已选择开启，实际准入由会话的 Profile 决定。",
    en: "Selected on. The conversation Profile determines actual availability.",
  },
  "settings.pluginCenter.componentChoiceExplanation": {
    "zh-CN": "开关只影响当前项目。插件启用状态和当前任务配置仍会限制可用能力。",
    en: "Switches affect only this project. Plugin enablement and the current task configuration still limit available capabilities.",
  },
  "settings.pluginConnectionPanel.connectedServicesSubjectToProfile": {
    "zh-CN": "已连接的 MCP 服务可按当前会话的 Profile 使用；其他组件请查看各自状态。",
    en: "Connected MCP services are subject to the current conversation Profile. Check other components for their status.",
  },
  "settings.pluginConnectionPanel.componentReconnectRequired": {
    "zh-CN": "更改服务开关会断开此插件的全部 MCP 连接，之后需要重新连接。",
    en: "Changing a service switch disconnects all MCP connections for this plugin; reconnect afterward.",
  },
  "chat.composer.pluginReferences": {
    "zh-CN": "插件",
    en: "Plugins",
  },
  "chat.composer.filesGroup": { "zh-CN": "文件", en: "Files" },
  "chat.composer.noFileMatches": {
    "zh-CN": "未找到文件，可继续输入文件名或相对路径",
    en: "No files found. Type a filename or relative path",
  },
  "chat.composer.fileResultsLimited": {
    "zh-CN": "仅显示部分文件，请缩小搜索范围",
    en: "Showing partial file results. Refine your search",
  },
  "chat.composer.fileSearchFailed": {
    "zh-CN": "无法搜索工作区文件，请重试",
    en: "Could not search workspace files. Try again",
  },
  "chat.composer.fileQueryTooLong": {
    "zh-CN": "文件搜索最多支持 256 个字符",
    en: "File searches support up to 256 characters",
  },
  "chat.composer.catalogSearch": { "zh-CN": "搜索功能与 Skills", en: "Search actions and Skills" },
  "chat.composer.catalogLabel": { "zh-CN": "功能与 Skills", en: "Actions and Skills" },
  "chat.composer.actionsGroup": { "zh-CN": "功能", en: "Actions" },
  "chat.composer.conversationsGroup": { "zh-CN": "最近会话", en: "Recent conversations" },
  "chat.composer.conversationReference": {
    "zh-CN": "需要时读取此会话",
    en: "Read this conversation when needed",
  },
  "chat.composer.searchReferences": {
    "zh-CN": "搜索文件、会话与插件",
    en: "Search files, conversations and plugins",
  },
  "chat.composer.references": { "zh-CN": "引用", en: "References" },
  "chat.composer.addToCurrentMessage": { "zh-CN": "添加到当前消息", en: "Add to this message" },
  "chat.composer.attached": { "zh-CN": "已附加", en: "Attached" },
  "chat.composer.noMatches": { "zh-CN": "无匹配结果", en: "No matches" },
  "chat.composer.retryCatalog": { "zh-CN": "重试", en: "Retry" },
  "chat.composer.searchPluginReferences": {
    "zh-CN": "搜索插件",
    en: "Search plugins",
  },
  "chat.composer.mcpResourceReference": {
    "zh-CN": "搜索 MCP 资源",
    en: "Search MCP resources",
  },
  "chat.composer.mcpResourceReferenceDescription": {
    "zh-CN": "引用应用中的文件、工单或其他资源",
    en: "Reference files, tickets, or other application resources",
  },
  "chat.composer.pluginReferenceUnavailable": {
    "zh-CN": "所选插件已变化或不可用。草稿已保留，请移除引用后重新选择。",
    en: "A selected plugin changed or is unavailable. The draft is preserved. Remove its mention and select it again.",
  },
  "chat.composer.pluginReferenceIntent": {
    "zh-CN": "请在本次请求中使用所选插件 {name}。",
    en: "Use the selected plugin {name} for this request.",
  },
  "chat.composer.pluginReferenceOnly": {
    "zh-CN": "仅作引用",
    en: "Reference only",
  },
  "settings.pluginCenter.copyLink": {
    "zh-CN": "复制链接",
    en: "Copy link",
  },
  "settings.pluginCenter.copyMetadataLink": {
    "zh-CN": "复制{name}链接",
    en: "Copy {name} link",
  },
  "settings.pluginCenter.metadataLinkCopied": {
    "zh-CN": "已复制{name}链接。",
    en: "Copied {name} link.",
  },
  "settings.pluginCenter.metadataLinkCopyFailed": {
    "zh-CN": "无法复制{name}链接，请选择网址并手动复制。",
    en: "Could not copy {name} link. Select the URL and copy it manually.",
  },
} as const;
