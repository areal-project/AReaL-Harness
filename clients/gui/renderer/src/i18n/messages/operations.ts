export const operationMessages = {
  "operations.inspectionDetails": {
    "zh-CN": "查看原操作与诊断",
    en: "View original operation and diagnostics",
  },
  "operations.browserUnconfirmed": {
    "zh-CN": "浏览器操作未确认，任务已暂停。请核对当前页面后继续。",
    en: "The browser operation is unconfirmed. Check the current page to continue the paused task.",
  },
  "operations.browserInspected": {
    "zh-CN": "已记录页面核对，可以继续发送消息。原操作不会重放。",
    en: "Page inspection recorded. You can send another message; the original operation will not be replayed.",
  },
  "operations.browserInspect": { "zh-CN": "核对浏览器结果", en: "Check browser result" },
  "operations.browserInspectionHelp": {
    "zh-CN":
      "请核对浏览器当前页面。如果刚完成登录，记录当前已打开的页面；如果涉及提交，先确认是否已提交。核对后可发送保留的草稿继续任务，原操作不会重放。",
    en: "Check the current browser page. If you just signed in, describe the page now open. If a submission was involved, check whether it went through. Then send your saved draft to continue; the original operation will not be replayed.",
  },
  "operations.browserInspectionPlaceholder": {
    "zh-CN": "例如：已完成登录，当前显示任务列表；没有再次点击提交。",
    en: "For example: Signed in and the task list is visible. I did not submit again.",
  },
  "operations.browserInspectionChecked": {
    "zh-CN": "已核对当前页面及操作结果",
    en: "I checked the current page and operation result",
  },
  "operations.browserRecovery": {
    "zh-CN": "请核对当前页面；如需登录，请先完成登录。点击聊天中的“核对后继续”，再发送保留的草稿。",
    en: "Check the current page and finish signing in if needed. Choose “Check to continue” in the chat, then send your saved draft.",
  },
  "operations.toolRecovery": {
    "zh-CN": "上次操作的结果待核对。请核查实际状态后继续发送，草稿已保留。",
    en: "The previous operation needs checking. Inspect its actual result before sending. Your draft is preserved.",
  },
  "operations.inspectToContinue": { "zh-CN": "核对后继续", en: "Check to continue" },
  "operations.inspectBeforeSend": { "zh-CN": "核对后发送", en: "Check before sending" },
  "operations.outputStyles": { "zh-CN": "输出样式", en: "Output styles" },
  "operations.themes": { "zh-CN": "主题", en: "Themes" },
  "operations.languageServers": { "zh-CN": "语言服务器", en: "Language servers" },
  "operations.hostRuntimeUnsupported": {
    "zh-CN": "此组件依赖当前宿主未提供的运行时或 SDK。",
    en: "This component requires a runtime or SDK this host does not provide.",
  },
  "operations.packageDependenciesUnsupported": {
    "zh-CN": "当前宿主不安装或执行此包声明的依赖。",
    en: "This host does not install or execute this package's declared dependencies.",
  },
  "operations.userConfigUnsupported": {
    "zh-CN": "当前宿主不提供此包声明的用户配置接口。",
    en: "This host does not provide this package's declared user configuration interface.",
  },
  "operations.declaredHostTools": {
    "zh-CN": "会话已部署并允许声明的宿主工具",
    en: "Declared host tools deployed and allowed in the session",
  },

  "operations.quitting": {
    "zh-CN": "正在退出 AReaL Harness",
    en: "Quitting AReaL Harness",
  },
  "operations.quit.checking": {
    "zh-CN": "正在检查后台状态…",
    en: "Checking background status…",
  },
  "operations.quit.stopping": {
    "zh-CN": "正在等待后台退出…",
    en: "Waiting for background shutdown…",
  },
  "operations.quit.finishing": {
    "zh-CN": "正在完成退出…",
    en: "Finishing shutdown…",
  },
  "operations.componentIncompatible": {
    "zh-CN": "必需组件不兼容",
    en: "Required components are incompatible",
  },
  "operations.scrollViewport": {
    "zh-CN": "滚动视口：",
    en: "Scroll viewport:",
  },
  "operations.optionValue": {
    "zh-CN": "选项值：",
    en: "Option value:",
  },
  "operations.checked": {
    "zh-CN": "选中：",
    en: "Checked:",
  },
  "operations.yes": {
    "zh-CN": "是",
    en: "Yes",
  },
  "operations.no": {
    "zh-CN": "否",
    en: "No",
  },
  "operations.runNow": {
    "zh-CN": "立即运行",
    en: "Run now",
  },
  "operations.viewCurrentRun": {
    "zh-CN": "查看当前运行",
    en: "View current run",
  },
  "operations.runNowUnsupported": {
    "zh-CN": "当前 Core 尚不支持立即运行。",
    en: "This Core does not support Run now.",
  },
  "operations.recentWindow": {
    "zh-CN": "最近窗口",
    en: "Recent window",
  },
  "operations.runsOf": {
    "zh-CN": "次 · 共",
    en: "runs · total",
  },
  "operations.runsLoaded": {
    "zh-CN": "次 · 已加载",
    en: "runs · loaded",
  },
  "operations.runs": {
    "zh-CN": "次",
    en: "runs",
  },
  "operations.recentOnly": {
    "zh-CN": "当前 Core 仅提供最近运行窗口。更新 Core 后可读取更早记录。",
    en: "This Core provides only recent runs. Update Core to read earlier records.",
  },
  "operations.loadingNotification": {
    "zh-CN": "正在读取通知运行…",
    en: "Loading the notified run…",
  },
  "operations.retryNotification": {
    "zh-CN": "重试读取通知运行",
    en: "Retry loading the notified run",
  },
  "operations.retryHistory": {
    "zh-CN": "重试读取运行记录",
    en: "Retry loading run history",
  },
  "operations.historyChanged": {
    "zh-CN": "新增运行超过本次读取范围，请刷新运行记录以读取完整历史。",
    en: "New runs exceed the current read window. Refresh run history to load the complete history.",
  },
  "operations.refreshHistory": {
    "zh-CN": "刷新运行记录",
    en: "Refresh run history",
  },
  "operations.manual": {
    "zh-CN": "手动触发",
    en: "Manual",
  },
  "operations.scheduled": {
    "zh-CN": "计划",
    en: "Scheduled",
  },
  "operations.loadingHistory": {
    "zh-CN": "正在读取运行记录…",
    en: "Loading run history…",
  },
  "operations.loadEarlier": {
    "zh-CN": "加载更早运行",
    en: "Load earlier runs",
  },
  "operations.admissionUnknown": {
    "zh-CN": "提交结果尚未确认，请核对受理结果。",
    en: "Submission is unconfirmed. Check whether it was accepted.",
  },
  "operations.checkAdmission": {
    "zh-CN": "核对受理结果",
    en: "Check acceptance",
  },
  "operations.schedulePreview": {
    "zh-CN": "后续执行预览",
    en: "Upcoming runs",
  },
  "operations.upcoming": {
    "zh-CN": "后续执行 ·",
    en: "Upcoming runs ·",
  },
  "operations.skipFiveMinutes": {
    "zh-CN": "错过 5 分钟后跳过",
    en: "Skip after five minutes late",
  },
  "operations.coalesceMissed": {
    "zh-CN": "错过时合并执行一次",
    en: "Combine missed runs into one",
  },
  "operations.openingResult": {
    "zh-CN": "正在打开…",
    en: "Opening…",
  },
  "operations.openResult": {
    "zh-CN": "打开交互结果",
    en: "Open interactive result",
  },
  "operations.uiPages": {
    "zh-CN": "UI 页面",
    en: "UI pages",
  },
  "operations.supported": {
    "zh-CN": "解析契约支持",
    en: "Supported by the parsing contract",
  },
  "operations.partial": {
    "zh-CN": "部分支持",
    en: "Partly supported",
  },
  "operations.unsupported": {
    "zh-CN": "尚不支持",
    en: "Unsupported",
  },
  "operations.notImplemented": {
    "zh-CN": "此类声明尚未实现。",
    en: "This declaration kind is not implemented.",
  },
  "operations.invalidMcp": {
    "zh-CN": "MCP 声明结构无效。",
    en: "The MCP declaration has an invalid structure.",
  },
  "operations.emptyMcp": {
    "zh-CN": "MCP 声明未包含服务。",
    en: "The MCP declaration contains no servers.",
  },
  "operations.invalidHook": {
    "zh-CN": "Hook 声明结构无效。",
    en: "The hook declaration has an invalid structure.",
  },
  "operations.emptyHook": {
    "zh-CN": "Hook 声明未包含处理器。",
    en: "The hook declaration contains no handlers.",
  },
  "operations.unsupportedHook": {
    "zh-CN": "Hook 事件或处理器尚不支持。",
    en: "The hook event or handler is unsupported.",
  },
  "operations.invalidConnector": {
    "zh-CN": "Connector 声明结构无效。",
    en: "The connector declaration has an invalid structure.",
  },
  "operations.emptyConnector": {
    "zh-CN": "Connector 声明为空。",
    en: "The connector declaration is empty.",
  },
  "operations.invalidDocument": {
    "zh-CN": "组件文件缺失或格式无效。",
    en: "The component file is missing or invalid.",
  },
  "operations.emptyDeclaration": {
    "zh-CN": "组件声明为空。",
    en: "The component declaration is empty.",
  },
  "operations.installSnapshot": {
    "zh-CN": "安装当前快照",
    en: "Install the current snapshot",
  },
  "operations.enableProject": {
    "zh-CN": "当前项目启用",
    en: "Enable in the current project",
  },
  "operations.profileAllows": {
    "zh-CN": "目标会话 Profile 允许插件",
    en: "Allow plugins in the target conversation profile",
  },
  "operations.trustMcp": {
    "zh-CN": "单独信任 MCP",
    en: "Trust MCP separately",
  },
  "operations.connectMcp": {
    "zh-CN": "连接 MCP 服务",
    en: "Connect MCP servers",
  },
  "operations.authenticate": {
    "zh-CN": "完成认证",
    en: "Complete authentication",
  },
  "operations.declaredAuth": {
    "zh-CN": "按服务声明完成认证",
    en: "Authenticate as declared by the server",
  },
  "operations.connectorMapping": {
    "zh-CN": "配置 Connector 映射",
    en: "Configure connector mappings",
  },
  "operations.trustHooks": {
    "zh-CN": "单独信任 Hook 定义",
    en: "Trust hook definitions separately",
  },
  "operations.readOnlyConsent": {
    "zh-CN": "只读子会话另需命令 Hook 授权",
    en: "Authorize command hooks separately for read-only child conversations",
  },
  "operations.installedSupport": {
    "zh-CN": "已安装组件支持",
    en: "Installed component support",
  },
  "operations.catalogSupport": {
    "zh-CN": "目录组件支持",
    en: "Catalog component support",
  },
  "operations.unverifiedSupport": {
    "zh-CN": "当前快照的支持报告尚未核实。",
    en: "The support report for this snapshot is unverified.",
  },
  "operations.blockedSnapshot": {
    "zh-CN": "必需组件不兼容，当前快照不可激活。",
    en: "Required components are incompatible. This snapshot cannot be activated.",
  },
  "operations.partialComponents": {
    "zh-CN": "部分组件不受支持",
    en: "Some components are unsupported",
  },
  "operations.declaredSupport": {
    "zh-CN": "已声明组件符合所列解析契约。",
    en: "Declared components satisfy the listed parsing contracts.",
  },
  "operations.profileAdmission": {
    "zh-CN": "当前会话的 Profile 决定实际准入。",
    en: "The current conversation profile determines admission.",
  },
  "operations.separateTrust": {
    "zh-CN": "MCP 连接、认证与 Hook 信任以各自状态为准。",
    en: "MCP connections, authentication, and hook trust retain their separate states.",
  },
  "operations.viewRequirements": {
    "zh-CN": "查看逐项声明与前提",
    en: "View declarations and requirements",
  },
  "operations.snapshot": {
    "zh-CN": "快照",
    en: "Snapshot",
  },
  "operations.noComponents": {
    "zh-CN": "此快照未声明组件。",
    en: "This snapshot declares no components.",
  },
  "operations.required": {
    "zh-CN": "· 必需",
    en: "· Required",
  },
  "operations.parsingContract": {
    "zh-CN": "解析契约",
    en: "Parsing contract",
  },
  "operations.requirements": {
    "zh-CN": "使用前提为",
    en: "Requirements:",
  },
  "operations.missingKind": {
    "zh-CN": "缺少必需的 {kind} 声明。",
    en: "The required {kind} declaration is missing.",
  },
  "operations.unsupportedKind": {
    "zh-CN": "必需的 {kind} 声明未完全受支持。",
    en: "The required {kind} declaration is not fully supported.",
  },
  "operations.lateSeconds": {
    "zh-CN": "错过 {seconds} 秒后跳过",
    en: "Skip after {seconds} seconds late",
  },
  "operations.schedules.deleting": {
    "zh-CN": "删除中，等待执行结算",
    en: "Deleting, waiting for execution to settle",
  },
  "operations.schedules.deleted": { "zh-CN": "已删除", en: "Deleted" },
  "operations.schedules.cancelled": { "zh-CN": "已取消", en: "Cancelled" },
  "operations.schedules.paused": { "zh-CN": "已暂停", en: "Paused" },
  "operations.schedules.enabled": { "zh-CN": "已开启", en: "Enabled" },
  "operations.schedules.none": { "zh-CN": "无后续计划", en: "No future occurrence" },
  "operations.schedules.once": { "zh-CN": "仅一次 · {time}", en: "Once · {time}" },
  "operations.schedules.everySeconds": {
    "zh-CN": "每 {seconds} 秒",
    en: "Every {seconds} seconds",
  },
  "operations.schedules.calendar": {
    "zh-CN": "每 {interval} {unit} · {days} · {time}",
    en: "Every {interval} {unit} · {days} · {time}",
  },
  "operations.schedules.dayUnit": { "zh-CN": "天", en: "days" },
  "operations.schedules.weekUnit": { "zh-CN": "周", en: "weeks" },
  "operations.schedules.monthUnit": { "zh-CN": "月", en: "months" },
  "operations.schedules.monthDay": { "zh-CN": "{day} 日", en: "Day {day}" },
  "operations.schedules.lastDay": { "zh-CN": "最后一天", en: "Last day" },
  "operations.schedules.monday": { "zh-CN": "周一", en: "Mon" },
  "operations.schedules.tuesday": { "zh-CN": "周二", en: "Tue" },
  "operations.schedules.wednesday": { "zh-CN": "周三", en: "Wed" },
  "operations.schedules.thursday": { "zh-CN": "周四", en: "Thu" },
  "operations.schedules.friday": { "zh-CN": "周五", en: "Fri" },
  "operations.schedules.saturday": { "zh-CN": "周六", en: "Sat" },
  "operations.schedules.sunday": { "zh-CN": "周日", en: "Sun" },
  "operations.schedules.next": { "zh-CN": "下次执行：{time}", en: "Next run: {time}" },
  "operations.schedules.independent": { "zh-CN": "独立任务", en: "Independent task" },
  "operations.schedules.defaultModel": {
    "zh-CN": "跟随当前默认模型",
    en: "Use current default model",
  },
  "operations.schedules.latestRun": { "zh-CN": "最近运行：{status}", en: "Latest run: {status}" },
  "operations.schedules.blocked": { "zh-CN": "受阻", en: "Blocked" },
  "operations.schedules.failed": { "zh-CN": "失败", en: "Failed" },
  "operations.schedules.waiting": { "zh-CN": "等待回答", en: "Waiting for an answer" },
  "operations.schedules.enable": { "zh-CN": "开启", en: "Enable" },
  "operations.schedules.pause": { "zh-CN": "暂停", en: "Pause" },
  "operations.schedules.delete": { "zh-CN": "删除", en: "Delete" },
  "operations.schedules.stopRun": { "zh-CN": "停止本次", en: "Stop this run" },
  "operations.schedules.unknown": {
    "zh-CN": "操作结果尚未确认，不会自动重发。",
    en: "The operation is unconfirmed and will not be replayed.",
  },
  "operations.schedules.check": { "zh-CN": "核对受理状态", en: "Check acceptance" },
  "operations.schedules.threadLabel": {
    "zh-CN": "本会话定时任务",
    en: "Schedules in this conversation",
  },
  "operations.schedules.title": { "zh-CN": "定时任务", en: "Scheduled tasks" },
  "operations.schedules.add": { "zh-CN": "添加", en: "Add" },
  "operations.schedules.unavailable": { "zh-CN": "状态暂不可用", en: "State unavailable" },
  "operations.schedules.loading": { "zh-CN": "正在读取安排…", en: "Reading schedules…" },
  "operations.schedules.retry": { "zh-CN": "重新读取", en: "Read again" },
  "operations.schedules.empty": {
    "zh-CN": "本会话暂无定时任务",
    en: "This conversation has no scheduled tasks",
  },
  "operations.schedules.created": { "zh-CN": "已创建定时任务", en: "Scheduled task created" },
  "operations.schedules.updated": { "zh-CN": "已更新定时任务", en: "Scheduled task updated" },
  "operations.schedules.controlled": { "zh-CN": "已保存任务操作", en: "Task control saved" },
  "operations.schedules.current": { "zh-CN": "当前状态：{status}", en: "Current state: {status}" },
  "operations.schedules.reading": { "zh-CN": "正在读取…", en: "Reading…" },
  "operations.schedules.retryStatus": { "zh-CN": "重新读取状态", en: "Read current state" },
  "operations.schedules.filterProject": { "zh-CN": "筛选项目", en: "Filter projects" },
  "operations.schedules.allOwners": {
    "zh-CN": "所有项目与独立任务",
    en: "All projects and independent tasks",
  },
  "operations.schedules.ownerStates": { "zh-CN": "项目加载状态", en: "Project loading status" },
  "operations.schedules.unloaded": { "zh-CN": "未加载", en: "Not loaded" },
  "operations.schedules.ownerLoading": { "zh-CN": "加载中", en: "Loading" },
  "operations.schedules.ownerReady": {
    "zh-CN": "已加载 {count} 个安排",
    en: "Loaded {count} schedules",
  },
  "operations.schedules.newLabel": { "zh-CN": "新建定时任务", en: "New scheduled task" },
  "operations.schedules.newTitle": { "zh-CN": "新建任务", en: "New task" },
  "operations.schedules.openLabel": {
    "zh-CN": "打开自动化 {title}",
    en: "Open automation {title}",
  },
  "operations.schedules.retryCreation": {
    "zh-CN": "重试或核对原请求",
    en: "Retry or check the original request",
  },
  "operations.schedules.opening": {
    "zh-CN": "正在打开独立会话…",
    en: "Opening an independent conversation…",
  },
  "operations.schedules.retainCreation": {
    "zh-CN": "保留原记录，返回任务列表",
    en: "Keep the original record and return to tasks",
  },
  "operations.schedules.retainCreationConfirm": {
    "zh-CN":
      "原创建结果仍未确认，目录或会话可能已经存在。将保留原记录和资源，返回任务列表，不重发原请求或发送草稿。之后再次新建会创建另一份资源。继续吗？",
    en: "The original creation result is still unconfirmed; its directory or conversation may already exist. Keep its records and resources and return to tasks without replaying the request or sending the draft. Creating again afterward will create a separate resource. Continue?",
  },
  "operations.schedules.conversation": {
    "zh-CN": "定时任务会话",
    en: "Scheduled task conversation",
  },
  "operations.schedules.intro": {
    "zh-CN": "让 AReaL 按计划处理持续性任务。",
    en: "Let AReaL handle ongoing tasks on a schedule.",
  },
  "operations.schedules.backendUpdateRequired": {
    "zh-CN":
      "当前后台不支持此版本的任务目录。已加载的任务会保留，现有任务继续运行。请在设置的“后台服务”中安全更新后台后重试。",
    en: "This backend does not support the current task catalog. Loaded tasks are kept and existing work continues. Safely update the backend in Settings > Background service, then retry.",
  },
  "operations.schedules.partialLoad": {
    "zh-CN": "部分任务未能加载",
    en: "Some tasks could not be loaded",
  },
  "operations.schedules.retryCatalog": { "zh-CN": "重新加载任务", en: "Reload tasks" },
  "operations.schedules.catalogEmpty": { "zh-CN": "尚无定时任务", en: "No scheduled tasks yet" },
  "operations.schedules.updatingStatus": {
    "zh-CN": "正在更新任务状态…",
    en: "Updating task status…",
  },
  "operations.schedules.unconfirmedStatus": {
    "zh-CN": "任务状态尚未确认，请重试更新。",
    en: "Task status is unconfirmed. Retry the update.",
  },
  "operations.schedules.finishedGroup": { "zh-CN": "已结束", en: "Finished" },
  "operations.schedules.closeDetails": { "zh-CN": "关闭任务详情", en: "Close task details" },
  "operations.schedules.location": {
    "zh-CN": "工作目录与来源",
    en: "Working directory and source",
  },
  "operations.schedules.openSource": { "zh-CN": "打开来源会话", en: "Open source conversation" },
  "operations.schedules.sourceUnavailable": {
    "zh-CN": "来源会话暂不可用。安排和运行记录仍保留。",
    en: "The source conversation is unavailable. The schedule and run history are retained.",
  },
  "operations.schedules.retrySource": { "zh-CN": "重新读取来源", en: "Read source again" },
  "operations.schedules.readingSource": {
    "zh-CN": "正在读取来源会话…",
    en: "Reading the source conversation…",
  },
  "operations.schedules.sourceMissing": {
    "zh-CN": "来源会话已不可用，可继续管理已保存的安排。",
    en: "The source conversation is unavailable. You can still manage the saved schedule.",
  },
  "operations.schedules.projectFilter": { "zh-CN": "运行位置筛选", en: "Filter by project" },
  "operations.schedules.allProjects": { "zh-CN": "全部项目", en: "All projects" },
  "operations.schedules.readFailed": { "zh-CN": "读取失败", en: "Read failed" },
  "operations.schedules.cached": { "zh-CN": "上次记录", en: "Last saved record" },
  "operations.schedules.readAt": { "zh-CN": "本次读取于 {time}", en: "Read at {time}" },
  "operations.schedules.incomplete": { "zh-CN": "完整性尚未确认", en: "Completeness unconfirmed" },
  "operations.schedules.refreshProject": { "zh-CN": "刷新这个项目", en: "Refresh this project" },
  "operations.schedules.creationIntent": {
    "zh-CN": "帮我创建一个定时任务：",
    en: "Help me create a scheduled task:",
  },
} as const;
