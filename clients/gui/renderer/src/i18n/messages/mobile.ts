export const mobileMessages = {
  "mobile.inbox": { "zh-CN": "待我处理", en: "Needs your attention" },
  "mobile.decisionApproval": { "zh-CN": "请求审批", en: "Approval requested" },
  "mobile.decisionQuestion": { "zh-CN": "等待回答", en: "Question pending" },
  "mobile.decisionDetails": { "zh-CN": "查看详情", en: "View details" },
  "mobile.decisionReadFailed": {
    "zh-CN": "无法读取完整详情，请再试一次。",
    en: "Could not load the complete details. Try again.",
  },
  "mobile.decisionSubmitted": { "zh-CN": "已提交", en: "Submitted" },
  "mobile.decisionDeny": { "zh-CN": "拒绝", en: "Deny" },
  "mobile.decisionAllow": { "zh-CN": "允许一次", en: "Allow once" },
  "mobile.decisionReply": { "zh-CN": "提交回答", en: "Submit answers" },
  "mobile.decisionCustomAnswer": { "zh-CN": "输入其他回答", en: "Enter another answer" },
  "mobile.decisionChanged": {
    "zh-CN": "请求已变化，请重新打开详情。",
    en: "This request changed. Open its details again.",
  },
  "mobile.unsupportedWebView": {
    "zh-CN": "请更新 Android System WebView 或操作系统后重试。当前网页环境缺少安全连接所需的能力。",
    en: "Update Android System WebView or your operating system and try again. This web environment lacks capabilities required for a secure connection.",
  },
  "mobile.computerPermissions": { "zh-CN": "电脑权限", en: "Computer permissions" },
  "mobile.modelAdvanced": { "zh-CN": "高级设置", en: "Advanced" },
  "mobile.permissionQuestion": {
    "zh-CN": "如何审批 Agent 的操作？",
    en: "How should Agent actions be approved?",
  },
  "mobile.projectIdle": { "zh-CN": "空闲", en: "Idle" },
  "mobile.executionPermissions": { "zh-CN": "执行权限", en: "Execution permissions" },
  "mobile.authorizedProjects": {
    "zh-CN": "这台电脑授权给你的 {count} 个项目",
    en: "{count} projects shared by this computer",
  },
  "mobile.projectAccessHint": {
    "zh-CN": "需要更多项目？在电脑的「设置 → 手机连接」里给这台手机授权。",
    en: "Need more projects? Grant access in Settings → Mobile connection on your computer.",
  },
  "mobile.runsOnComputer": {
    "zh-CN": "在已连接的电脑上执行",
    en: "Runs on your connected computer",
  },
  "mobile.newConversation": { "zh-CN": "新会话", en: "New conversation" },
  "mobile.permissionWorkspace": { "zh-CN": "可写工作区", en: "Workspace write" },
  "mobile.permissionReadOnly": { "zh-CN": "只读", en: "Read only" },
  "mobile.permissionFullAccess": { "zh-CN": "完全访问", en: "Full access" },
  "mobile.fullComputerAccess": { "zh-CN": "可操作整台电脑", en: "Access across the computer" },

  "mobile.connect": {
    "zh-CN": "连接电脑",
    en: "Connect your computer",
  },
  "mobile.instructions": {
    "zh-CN": "在电脑的「设置 → 手机连接」里选择 Relay，生成配对二维码。",
    en: "In Settings → Mobile connection on your computer, select Relay and generate a pairing QR code.",
  },
  "mobile.scan": {
    "zh-CN": "扫描配对二维码",
    en: "Scan pairing QR code",
  },
  "mobile.paste": {
    "zh-CN": "粘贴配对链接",
    en: "Paste pairing link",
  },
  "mobile.link": {
    "zh-CN": "配对链接",
    en: "Pairing link",
  },
  "mobile.deviceName": {
    "zh-CN": "设备名称",
    en: "Device name",
  },
  "mobile.deviceFallback": {
    "zh-CN": "我的 iPhone",
    en: "My iPhone",
  },
  "mobile.continue": {
    "zh-CN": "连接",
    en: "Connect",
  },
  "mobile.waiting": {
    "zh-CN": "请回到电脑确认",
    en: "Confirm on your computer",
  },
  "mobile.fingerprint": {
    "zh-CN": "逐字核对手机和电脑上显示的完整指纹。",
    en: "Compare the complete fingerprint on your phone and computer.",
  },
  "mobile.access": {
    "zh-CN": "这台手机可以查看所选项目的会话，并以当前权限让 Agent 执行操作。",
    en: "This phone can view conversations in the selected projects and have the agent act with current permissions.",
  },
  "mobile.connecting": {
    "zh-CN": "正在连接…",
    en: "Connecting…",
  },
  "mobile.draftOffline": {
    "zh-CN": "连接已断开。重新连接后可以发送消息。",
    en: "Connection lost. Reconnect to send messages.",
  },
  "mobile.connected": {
    "zh-CN": "已连接 · 可操作",
    en: "Connected · Can control",
  },
  "mobile.observer": {
    "zh-CN": "已连接 · 仅查看",
    en: "Connected · View only",
  },
  "mobile.offline": {
    "zh-CN": "电脑离线",
    en: "Computer offline",
  },
  "mobile.background": {
    "zh-CN": "连接已暂停",
    en: "Connection paused",
  },
  "mobile.revoked": {
    "zh-CN": "授权已撤销，请重新配对",
    en: "Access revoked. Pair again.",
  },
  "mobile.blocked": {
    "zh-CN": "连接无法恢复，请检查电脑授权或清除此设备后重新配对。",
    en: "Connection could not be restored. Check access on your computer, or clear this device and pair again.",
  },
  "mobile.invalidLink": {
    "zh-CN": "配对链接无效，请从电脑重新复制完整 Relay 配对链接。",
    en: "Invalid pairing link. Copy the complete Relay pairing link from your computer.",
  },
  "mobile.pairFailed": {
    "zh-CN": "配对未完成。请检查电脑、网络和配对链接后重试。",
    en: "Pairing did not complete. Check your computer, network and pairing link, then try again.",
  },
  "mobile.localRelayUnreachable": {
    "zh-CN":
      "手机未能连接电脑的本机 Relay。请确认两台设备的网络可以互访，并检查 AReaL 的本地网络权限。",
    en: "Your phone could not connect to the local relay. Check that both devices can reach each other and that AReaL has local network access.",
  },
  "mobile.scanFailed": {
    "zh-CN": "无法扫描，请检查相机权限或粘贴配对链接。",
    en: "Could not scan. Check camera permission or paste the pairing link.",
  },
  "mobile.storageFailed": {
    "zh-CN": "本次可以使用，但下次需要重新配对。钥匙串保存失败。",
    en: "You can use this connection, but you will need to pair again next time. Keychain save failed.",
  },
  "mobile.clear": {
    "zh-CN": "清除此设备",
    en: "Clear this device",
  },
  "mobile.clearConfirm": {
    "zh-CN": "清除本机保存的连接？还需在电脑上撤销授权。",
    en: "Clear the saved connection on this phone? You must also revoke access on your computer.",
  },
  "mobile.clearFailed": {
    "zh-CN": "钥匙串清除失败，请重试。",
    en: "Could not clear Keychain. Try again.",
  },
  "mobile.cleared": {
    "zh-CN": "已清除此设备。请在电脑上撤销原授权。",
    en: "Device cleared. Revoke the previous access on your computer.",
  },
  "mobile.settings": {
    "zh-CN": "设置",
    en: "Settings",
  },
  "mobile.back": {
    "zh-CN": "返回",
    en: "Back",
  },
  "mobile.retry": {
    "zh-CN": "重试连接",
    en: "Reconnect",
  },
  "mobile.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
  },
  "mobile.projects": {
    "zh-CN": "项目",
    en: "Projects",
  },
  "mobile.notificationUnavailable": {
    "zh-CN": "推送通知尚未启用。",
    en: "Push notifications are not enabled yet.",
  },
  "mobile.computer": { "zh-CN": "电脑", en: "Computer" },
  "mobile.loading": { "zh-CN": "正在读取…", en: "Loading\u2026" },
  "mobile.readFailed": {
    "zh-CN": "读取失败，请刷新或重新打开。",
    en: "Could not load. Refresh or reopen.",
  },
  "mobile.refresh": { "zh-CN": "刷新", en: "Refresh" },
  "mobile.noProjects": {
    "zh-CN": "尚未授权项目。请在电脑上检查此设备的权限。",
    en: "No projects authorized. Check device access on your computer.",
  },
  "mobile.projectOffline": { "zh-CN": "项目离线", en: "Project offline" },
  "mobile.projectSummary": {
    "zh-CN": "运行中 {running} · 待处理 {attention}",
    en: "{running} running \u00b7 {attention} need attention",
  },
  "mobile.recent": { "zh-CN": "最近会话", en: "Recent conversations" },
  "mobile.sessions": { "zh-CN": "会话", en: "Chats" },
  "mobile.noSessions": { "zh-CN": "这里还没有会话。", en: "No conversations yet." },
  "mobile.untitled": { "zh-CN": "未命名会话", en: "Untitled conversation" },
  "mobile.olderSessions": { "zh-CN": "加载更多", en: "Load more" },
  "mobile.hostOnline": { "zh-CN": "电脑在线", en: "Computer online" },
  "mobile.newShort": { "zh-CN": "新建", en: "New" },
  "mobile.newPromptSimple": {
    "zh-CN": "想在这个项目里做什么？",
    en: "What would you like to do in this project?",
  },
  "mobile.providerCredentialRequired": {
    "zh-CN": "模型服务凭据不可用。请在电脑上检查模型服务设置。",
    en: "Model credentials are unavailable. Check model service settings on your computer.",
  },
  "mobile.activationPending": {
    "zh-CN": "项目正在启动，草稿已保留。请稍后重试。",
    en: "The project is starting. Your draft is saved. Try again shortly.",
  },
  "mobile.activationBlocked": {
    "zh-CN": "项目已停止。请在电脑上恢复项目后重试。",
    en: "The project is stopped. Resume it on your computer, then try again.",
  },
  "mobile.retryBody": { "zh-CN": "正文读取失败，重试", en: "Retry loading message content" },
  "mobile.desktopOnly": {
    "zh-CN": "请在电脑上查看此内容。",
    en: "View this content on your computer.",
  },
  "mobile.task": { "zh-CN": "任务", en: "Task" },
  "mobile.taskReadOnly": { "zh-CN": "这是 Task 的执行详情。", en: "Task execution details." },
  "mobile.openSession": { "zh-CN": "查看会话", en: "View conversation" },
  "mobile.status.attention": { "zh-CN": "等你确认", en: "Needs your attention" },
  "mobile.status.running": { "zh-CN": "运行中", en: "Running" },
  "mobile.status.failed": { "zh-CN": "失败", en: "Failed" },
  "mobile.status.idle": { "zh-CN": "已完成 / 空闲", en: "Completed / Idle" },
  "mobile.taskQueued": { "zh-CN": "排队中", en: "Queued" },
  "mobile.taskWaiting": { "zh-CN": "等待子任务", en: "Waiting for workers" },
  "mobile.taskPaused": { "zh-CN": "已暂停", en: "Paused" },
  "mobile.taskBlocked": { "zh-CN": "受阻", en: "Blocked" },
  "mobile.taskCompleted": { "zh-CN": "已完成", en: "Completed" },
  "mobile.taskCancelled": { "zh-CN": "已取消", en: "Cancelled" },
  "mobile.taskUnavailable": { "zh-CN": "此轮执行不可用", en: "Run unavailable" },
  "mobile.newSession": { "zh-CN": "新建会话", en: "New conversation" },
  "mobile.newPrompt": {
    "zh-CN": "要在 {project} 里做什么？",
    en: "What would you like to do in {project}?",
  },
  "mobile.newDescription": {
    "zh-CN": "发送第一条消息时，电脑会创建会话并开始工作。",
    en: "Your computer creates the conversation and starts work when you send the first message.",
  },
  "mobile.computerDefault": { "zh-CN": "电脑默认", en: "Computer default" },
  "mobile.applyOnSend": {
    "zh-CN": "这些设置将在发送时应用。",
    en: "These settings apply when you send.",
  },
  "mobile.resetIntent": { "zh-CN": "撤销本次设置", en: "Discard pending settings" },
  "mobile.permissions": { "zh-CN": "权限", en: "Permissions" },
  "mobile.newMessagePlaceholder": {
    "zh-CN": "描述你要完成的事…",
    en: "Describe what you want to accomplish…",
  },
  "mobile.queuePlaceholder": {
    "zh-CN": "补充要求，会在当前步骤后处理",
    en: "Add instructions to handle after the current step",
  },
  "mobile.messagePlaceholder": { "zh-CN": "发一条消息…", en: "Send a message\u2026" },
  "mobile.send": { "zh-CN": "发送", en: "Send" },
  "mobile.enqueue": { "zh-CN": "加入队列", en: "Add to queue" },
  "mobile.stop": { "zh-CN": "停止", en: "Stop" },
  "mobile.done": { "zh-CN": "完成", en: "Done" },
  "mobile.modelsUpgrade": {
    "zh-CN": "请升级电脑端以选择模型与权限。",
    en: "Update the desktop app to choose a model and permissions.",
  },
  "mobile.modelSettings": { "zh-CN": "模型与权限", en: "Model and permissions" },
  "mobile.models": { "zh-CN": "模型", en: "Models" },
  "mobile.reasoning": { "zh-CN": "推理强度", en: "Reasoning effort" },
  "mobile.modelUnavailable": { "zh-CN": "不可用", en: "Unavailable" },
  "mobile.configureAfterTurn": {
    "zh-CN": "会话运行时不能修改，本轮结束后可调整。",
    en: "Settings cannot be changed during a turn. Adjust them after it finishes.",
  },
  "mobile.queueDesktop": {
    "zh-CN": "队列编辑请在电脑上完成。",
    en: "Edit the queue on your computer.",
  },
  "mobile.deviceSaveBeforeSend": {
    "zh-CN": "设备信息保存失败，消息尚未发送。草稿已保留。",
    en: "Device information could not be saved. Your message was not sent and your draft is retained.",
  },
  "mobile.notSent": {
    "zh-CN": "连接或页面已变化，尚未发送。请核对后再试。",
    en: "The connection or page changed. Nothing was sent. Check the target and try again.",
  },
  "mobile.configurationUnavailable": {
    "zh-CN": "所选设置当前不可用。草稿已保留，请重新选择或撤销本次设置。",
    en: "The selected settings are unavailable. Your draft is retained. Choose again or discard the pending settings.",
  },
  "mobile.unsupportedProfile": {
    "zh-CN": "请在电脑上选择一个普通配置。",
    en: "Select an ordinary profile on your computer.",
  },
  "mobile.taskControlRequired": {
    "zh-CN": "此会话由 Task 管理，请在 Task 详情中暂停。",
    en: "This conversation belongs to a Task. Pause it from Task details.",
  },
  "mobile.commandUnknown": {
    "zh-CN": "暂未确认结果。",
    en: "Result unconfirmed.",
  },
  "mobile.commandRecoveryFailed": {
    "zh-CN": "未能读取待核对请求，请重新连接后核对。",
    en: "Could not read unresolved requests. Reconnect and check them.",
  },
  "mobile.commandFailed": {
    "zh-CN": "操作未完成，草稿已保留。",
    en: "The operation did not complete. Your draft is retained.",
  },
  "mobile.commandPending": {
    "zh-CN": "正在确认请求状态…",
    en: "Checking request status…",
  },
  "mobile.thinking": { "zh-CN": "思考中…", en: "Thinking…" },
  "mobile.sendReconnecting": {
    "zh-CN": "正在恢复连接，恢复后继续发送…",
    en: "Reconnecting to finish sending…",
  },
  "mobile.queryCommand": { "zh-CN": "核对原请求", en: "Check original request" },
  "mobile.effort.none": { "zh-CN": "无", en: "None" },
  "mobile.effort.minimal": { "zh-CN": "最少", en: "Minimal" },
  "mobile.effort.low": { "zh-CN": "低", en: "Low" },
  "mobile.effort.medium": { "zh-CN": "中", en: "Medium" },
  "mobile.effort.high": { "zh-CN": "高", en: "High" },
  "mobile.effort.xhigh": { "zh-CN": "极高", en: "Very high" },
  "mobile.effort.max": { "zh-CN": "最高", en: "Maximum" },

  "mobile.cache.button": { "zh-CN": "项目与缓存", en: "Projects & Cache" },
  "mobile.cache.title": { "zh-CN": "已授权项目与缓存", en: "Authorized projects & cache" },
  "mobile.cache.description": {
    "zh-CN": "选择要查看的项目，或管理在手机本地保留的离线会话缓存。",
    en: "Choose a project to view, or manage which authorized projects keep offline conversation cache.",
  },
  "mobile.cache.enableAll": { "zh-CN": "全部缓存", en: "Cache all" },
  "mobile.cache.clearSessions": { "zh-CN": "清空会话缓存", en: "Clear session cache" },
  "mobile.cache.clearProject": { "zh-CN": "清除此项目缓存", en: "Clear project cache" },
  "mobile.cache.current": { "zh-CN": "当前", en: "Current" },
  "mobile.cache.online": { "zh-CN": "在线", en: "Online" },
  "mobile.cache.offline": { "zh-CN": "离线", en: "Offline" },
  "mobile.cache.toggleLabel": {
    "zh-CN": "离线缓存 {project}",
    en: "Offline cache for {project}",
  },
  "mobile.cache.summaryCount": {
    "zh-CN": "{count} 个会话",
    en: "{count} conversations",
  },
  "mobile.cache.cachedDetail": {
    "zh-CN": "已缓存 {count} 条会话 · {size}",
    en: "{count} cached · {size}",
  },
  "mobile.cache.disabled": {
    "zh-CN": "未开启离线缓存",
    en: "Offline cache off",
  },
  "mobile.cache.noAuthorized": {
    "zh-CN": "暂无已授权项目缓存，连接电脑后会自动同步。",
    en: "No cached authorized projects yet. Connect to your computer to sync.",
  },
  "mobile.cache.offlineBanner": {
    "zh-CN": "电脑离线 · 正在浏览本地缓存（只读）",
    en: "Computer offline · Browsing local cache (read-only)",
  },
  "mobile.cache.connectingBanner": {
    "zh-CN": "正在连接电脑，先为你展示本地缓存。",
    en: "Connecting to your computer. Showing local cache in the meantime.",
  },
  "mobile.cache.cachedBadge": { "zh-CN": "已缓存", en: "Cached" },
  "mobile.cache.summaryOnlyBadge": { "zh-CN": "仅摘要", en: "Summary only" },
  "mobile.cache.notCachedDetail": {
    "zh-CN": "该会话尚未在本地缓存正文，请连上电脑后打开一次即可缓存。",
    en: "Full messages for this conversation are not cached locally yet. Open it once while connected to cache it.",
  },
  "mobile.cache.backToThreads": { "zh-CN": "返回会话列表", en: "Back to conversations" },
  "mobile.cache.storageSummary": {
    "zh-CN": "本地缓存：{projects} 个项目 · {sessions} 条会话（{size}）",
    en: "Local cache: {projects} projects · {sessions} conversations ({size})",
  },
  "mobile.endpoint.title": { "zh-CN": "更新连接地址", en: "Update connection address" },
  "mobile.endpoint.description": {
    "zh-CN": "电脑切换网络或本机 Relay IP 变化时，扫码或粘贴新链接即可更新，无需清除缓存。",
    en: "If your computer changed Wi-Fi or local Relay IP, scan or paste the updated link without clearing cache.",
  },
  "mobile.endpoint.scan": { "zh-CN": "扫码更新地址", en: "Scan to update address" },
  "mobile.endpoint.paste": { "zh-CN": "粘贴新连接链接", en: "Paste updated link" },
  "mobile.endpoint.apply": { "zh-CN": "更新并重连", en: "Update & reconnect" },
  "mobile.endpoint.mismatch": {
    "zh-CN": "该链接不属于当前配对的电脑。",
    en: "This link belongs to a different computer.",
  },
  "mobile.endpoint.updated": {
    "zh-CN": "连接地址已更新，正在重连…",
    en: "Connection address updated. Reconnecting…",
  },
} as const;
