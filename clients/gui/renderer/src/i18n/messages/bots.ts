export const botMessages = {
  "bots.title": {
    "zh-CN": "Bots",
    en: "Bots",
  },
  "bots.navigation.label": {
    "zh-CN": "Personal Agent 列表",
    en: "Personal Agents",
  },
  "bots.new": {
    "zh-CN": "新建 Bot",
    en: "New Bot",
  },
  "bots.searchPlaceholder": {
    "zh-CN": "搜索 Bot…",
    en: "Search bots…",
  },
  "bots.emptyList": {
    "zh-CN": "还没有 Bot",
    en: "No bots yet",
  },
  "bots.emptyListHint": {
    "zh-CN": "创建一个专属 Personal Agent，它会拥有独立的云端工作区与长期记忆。",
    en: "Create a personal agent with its own persistent cloud workspace and memory.",
  },
  "bots.selectPrompt": {
    "zh-CN": "选择左侧的 Bot 开始对话，或新建一个 Personal Agent。",
    en: "Select a bot from the sidebar to chat, or create a new Personal Agent.",
  },
  "bots.unavailable": {
    "zh-CN": "当前连接暂不支持 Bot 服务，请确保本机服务正在运行并已升级到最新版本。",
    en: "Bot service is unavailable on this connection. Make sure the local service is running and up to date.",
  },
  "bots.arena.ready": {
    "zh-CN": "EnvArena 已就绪",
    en: "EnvArena ready",
  },
  "bots.arena.unconfigured": {
    "zh-CN": "配置 EnvArena 连接",
    en: "Configure EnvArena",
  },
  "bots.arena.title": {
    "zh-CN": "EnvArena 连接配置",
    en: "EnvArena Connection",
  },
  "bots.arena.subtitle": {
    "zh-CN": "Bot 运行在独立的 EnvArena 云端沙箱中。Token 仅保存在本机凭据文件，不会回传明文。",
    en: "Bots run in isolated EnvArena cloud sandboxes. Your token is stored locally and never echoed back.",
  },
  "bots.arena.baseUrl": {
    "zh-CN": "网关地址",
    en: "Gateway URL",
  },
  "bots.arena.baseUrlPlaceholder": {
    "zh-CN": "例如 https://arena.example.com/arena/v1/app-server",
    en: "e.g. https://arena.example.com/arena/v1/app-server",
  },
  "bots.arena.profile": {
    "zh-CN": "本地配置 Profile",
    en: "Local config profile",
  },
  "bots.arena.profilePlaceholder": {
    "zh-CN": "prod",
    en: "prod",
  },
  "bots.arena.profileHint": {
    "zh-CN": "未显式填写 Token 时，自动读取 ~/.arena-online-gateway/config.toml 中对应的 profile。",
    en: "Falls back to the matching profile in ~/.arena-online-gateway/config.toml when no token is set.",
  },
  "bots.arena.token": {
    "zh-CN": "访问令牌 (Token)",
    en: "Access Token",
  },
  "bots.arena.tokenConfigured": {
    "zh-CN": "已配置（留空保持不变）",
    en: "Configured (leave blank to keep)",
  },
  "bots.arena.tokenPlaceholder": {
    "zh-CN": "粘贴 Bearer Token",
    en: "Paste Bearer Token",
  },
  "bots.arena.clearToken": {
    "zh-CN": "清除已保存 Token",
    en: "Clear saved token",
  },
  "bots.arena.sourceHost": {
    "zh-CN": "来源：本机凭据",
    en: "Source: local credentials",
  },
  "bots.arena.sourceToml": {
    "zh-CN": "来源：~/.arena-online-gateway/config.toml",
    en: "Source: ~/.arena-online-gateway/config.toml",
  },
  "bots.state.ready": {
    "zh-CN": "在线",
    en: "Online",
  },
  "bots.state.waking": {
    "zh-CN": "唤醒中…",
    en: "Waking…",
  },
  "bots.state.sleeping": {
    "zh-CN": "休眠中",
    en: "Sleeping",
  },
  "bots.state.error": {
    "zh-CN": "连接异常",
    en: "Error",
  },
  "bots.banner.waking": {
    "zh-CN": "正在唤醒云端沙箱，冷启动通常需要 10–30 秒…",
    en: "Waking cloud sandbox — cold starts typically take 10–30 seconds…",
  },
  "bots.banner.sleeping": {
    "zh-CN": "沙箱当前已休眠，发消息会自动唤醒并恢复记忆。",
    en: "Sandbox is sleeping. Sending a message wakes it automatically with memory preserved.",
  },
  "bots.banner.providerAction": {
    "zh-CN": "去右侧配置模型通道",
    en: "Configure provider",
  },
  "bots.banner.unknownTitle": {
    "zh-CN": "上一条消息状态尚未确认",
    en: "Previous message status unconfirmed",
  },
  "bots.banner.unknownDesc": {
    "zh-CN": "为避免重复执行，发送已暂时锁定。请先检查最新发送结果。",
    en: "Sending is paused to prevent duplicate execution. Check the latest delivery status first.",
  },
  "bots.banner.reconcile": {
    "zh-CN": "检查状态",
    en: "Check status",
  },
  "bots.banner.reconciling": {
    "zh-CN": "检查中…",
    en: "Checking…",
  },
  "bots.chat.placeholder": {
    "zh-CN": "给 {name} 发消息…",
    en: "Message {name}…",
  },
  "bots.chat.send": {
    "zh-CN": "发送",
    en: "Send",
  },
  "bots.chat.stop": {
    "zh-CN": "停止",
    en: "Stop",
  },
  "bots.chat.copy": {
    "zh-CN": "复制",
    en: "Copy",
  },
  "bots.chat.copied": {
    "zh-CN": "已复制",
    en: "Copied",
  },
  "bots.chat.thinking": {
    "zh-CN": "正在思考…",
    en: "Thinking…",
  },
  "bots.chat.toolActivity": {
    "zh-CN": "执行了 {count} 项内部操作",
    en: "{count} background step(s)",
  },
  "bots.chat.interactionTitle": {
    "zh-CN": "需要你的确认",
    en: "Confirmation needed",
  },
  "bots.chat.approve": {
    "zh-CN": "允许",
    en: "Approve",
  },
  "bots.chat.deny": {
    "zh-CN": "拒绝",
    en: "Deny",
  },
  "bots.chat.emptyHint": {
    "zh-CN": "直接发消息即可开始。所有对话与长期偏好都会保存在这个 Bot 专属工作区中。",
    en: "Send a message to get started. Conversations and preferences persist in this bot's workspace.",
  },
  "bots.actions.settings": {
    "zh-CN": "Bot 设置与偏好",
    en: "Bot settings & preferences",
  },
  "bots.actions.more": {
    "zh-CN": "更多操作",
    en: "More actions",
  },
  "bots.actions.wake": {
    "zh-CN": "立即唤醒",
    en: "Wake sandbox",
  },
  "bots.actions.sleep": {
    "zh-CN": "断开并休眠",
    en: "Sleep sandbox",
  },
  "bots.actions.compact": {
    "zh-CN": "压缩上下文",
    en: "Compact context",
  },
  "bots.actions.reset": {
    "zh-CN": "开启新话题",
    en: "Start new topic",
  },
  "bots.actions.resetHint": {
    "zh-CN": "开启全新对话，但保留 Bot 的工作区文件与长期记忆（AGENTS.md）。",
    en: "Starts a fresh thread while keeping workspace files and long-term memory (AGENTS.md).",
  },
  "bots.actions.delete": {
    "zh-CN": "删除 Bot",
    en: "Delete Bot",
  },
  "bots.actions.deleteConfirm": {
    "zh-CN": "确认删除",
    en: "Confirm delete",
  },
  "bots.settings.title": {
    "zh-CN": "Bot 设置",
    en: "Bot Settings",
  },
  "bots.settings.close": {
    "zh-CN": "收起设置",
    en: "Close settings",
  },
  "bots.settings.sectionIdentity": {
    "zh-CN": "基本信息",
    en: "Identity",
  },
  "bots.settings.sectionPreferences": {
    "zh-CN": "偏好与行为指令",
    en: "Preferences & Instructions",
  },
  "bots.settings.harnessModelOption": {
    "zh-CN": "Harness · {model}（{provider}）",
    en: "Harness · {model} ({provider})",
  },
  "bots.settings.openModelServices": {
    "zh-CN": "打开模型服务设置",
    en: "Open model service settings",
  },
  "bots.settings.harnessAuthorization": {
    "zh-CN":
      "服务地址和凭据在 Harness 模型服务中管理。若沙箱尚未授权，请在 EnvArena 的部署配置中启用同一模型服务，然后回来重新保存。",
    en: "Manage the endpoint and credentials in Harness Model Services. If access is missing, enable the same model service in the EnvArena deployment, then return and save again.",
  },
  "bots.settings.sectionModel": {
    "zh-CN": "模型与远端通道",
    en: "Model & Provider",
  },
  "bots.settings.sectionSandbox": {
    "zh-CN": "沙箱与会话管理",
    en: "Sandbox & Session",
  },
  "bots.settings.name": {
    "zh-CN": "名称",
    en: "Name",
  },
  "bots.settings.avatar": {
    "zh-CN": "头像 (Emoji)",
    en: "Avatar (Emoji)",
  },
  "bots.settings.description": {
    "zh-CN": "简介",
    en: "Description",
  },
  "bots.settings.starterPrompts": {
    "zh-CN": "快捷开场白（每行一条，最多 6 条）",
    en: "Starter prompts (one per line, max 6)",
  },
  "bots.settings.promptMode": {
    "zh-CN": "角色模式",
    en: "Persona mode",
  },
  "bots.settings.promptModePersonal": {
    "zh-CN": "Personal Agent（私人助理）",
    en: "Personal Agent (Assistant)",
  },
  "bots.settings.promptModeDefault": {
    "zh-CN": "默认工程模式",
    en: "Default Engineering Mode",
  },
  "bots.settings.preferencesPlaceholder": {
    "zh-CN": "例如：始终用中文要点回复；每天上午优先提醒重点事项；不要输出冗长技术细节。",
    en: "e.g. Reply concisely in bullet points; prioritize action items; avoid verbose jargon.",
  },
  "bots.settings.preferencesSynced": {
    "zh-CN": "已实时同步到沙箱",
    en: "Synced with sandbox",
  },
  "bots.settings.preferencesDirty": {
    "zh-CN": "待下次唤醒时同步",
    en: "Will sync on next wake",
  },
  "bots.settings.save": {
    "zh-CN": "保存更改",
    en: "Save changes",
  },
  "bots.settings.saving": {
    "zh-CN": "保存中…",
    en: "Saving…",
  },
  "bots.settings.saved": {
    "zh-CN": "已保存",
    en: "Saved",
  },
  "bots.settings.model": {
    "zh-CN": "模型",
    en: "Model",
  },
  "bots.settings.modelDefault": {
    "zh-CN": "跟随沙箱默认模型",
    en: "Sandbox default model",
  },
  "bots.settings.providerHealthReady": {
    "zh-CN": "模型通道正常",
    en: "Provider ready",
  },
  "bots.settings.providerHealthAuthFailed": {
    "zh-CN": "远端模型通道鉴权失败",
    en: "Provider auth failed",
  },
  "bots.settings.providerHealthUnavailable": {
    "zh-CN": "未配置远端模型通道",
    en: "No provider configured",
  },
  "bots.settings.providerHealthUnchecked": {
    "zh-CN": "唤醒后自动检测通道状态",
    en: "Checked when sandbox wakes",
  },
  "bots.settings.configureProvider": {
    "zh-CN": "配置自定义远端 Provider",
    en: "Configure custom remote provider",
  },
  "bots.settings.providerId": {
    "zh-CN": "Provider ID",
    en: "Provider ID",
  },
  "bots.settings.providerIdPlaceholder": {
    "zh-CN": "openai",
    en: "openai",
  },
  "bots.settings.providerBaseUrl": {
    "zh-CN": "API Base URL",
    en: "API Base URL",
  },
  "bots.settings.providerApiKey": {
    "zh-CN": "API Key（仅写入远端沙箱，不回显）",
    en: "API Key (sent to sandbox, never echoed)",
  },
  "bots.settings.providerModelId": {
    "zh-CN": "默认模型 ID",
    en: "Default Model ID",
  },
  "bots.settings.providerModelPlaceholder": {
    "zh-CN": "gpt-5-mini",
    en: "gpt-5-mini",
  },
  "bots.settings.providerApply": {
    "zh-CN": "写入并重新探测",
    en: "Apply & probe",
  },
  "bots.chat.turnFailed": {
    "zh-CN": "本轮调用失败",
    en: "Response failed",
  },
  "bots.chat.checkProvider": {
    "zh-CN": "检查模型通道",
    en: "Check model channel",
  },
  "bots.settings.namePlaceholder": {
    "zh-CN": "给 Bot 起一个名字",
    en: "Give this bot a name",
  },
  "bots.settings.descriptionPlaceholder": {
    "zh-CN": "一句话说明它擅长什么",
    en: "One-line summary of what this bot does",
  },
  "bots.settings.avatarPick": {
    "zh-CN": "更换头像",
    en: "Change avatar",
  },
  "bots.settings.startersCount": {
    "zh-CN": "{count} 条",
    en: "{count}",
  },
  "bots.settings.startersEmpty": {
    "zh-CN": "未设置",
    en: "None",
  },
  "bots.settings.startersSummary": {
    "zh-CN": "快捷开场白",
    en: "Starter prompts",
  },
  "bots.settings.promptModePersonalShort": {
    "zh-CN": "私人助理",
    en: "Assistant",
  },
  "bots.settings.promptModeDefaultShort": {
    "zh-CN": "标准模式",
    en: "Standard",
  },
  "bots.settings.preferencesLabel": {
    "zh-CN": "行为指令",
    en: "Instructions",
  },
  "bots.settings.preferencesHint": {
    "zh-CN": "保存后热同步到当前沙箱，不影响已有对话。",
    en: "Hot-syncs to the running sandbox on save without resetting history.",
  },
  "bots.settings.revert": {
    "zh-CN": "还原",
    en: "Revert",
  },
  "bots.settings.providerProtocol": {
    "zh-CN": "协议类型",
    en: "Protocol",
  },
  "bots.settings.providerProtocolResponses": {
    "zh-CN": "Responses",
    en: "Responses",
  },
  "bots.settings.providerProtocolChat": {
    "zh-CN": "Chat Completions",
    en: "Chat Completions",
  },
  "bots.settings.providerCredentialRef": {
    "zh-CN": "沙箱凭据环境变量（可选）",
    en: "Sandbox credential env var (optional)",
  },
  "bots.settings.providerCredentialRefPlaceholder": {
    "zh-CN": "留空表示无鉴权网关，或填写如 ARENA_MODEL_API_KEY",
    en: "Leave blank for keyless gateway, or enter e.g. ARENA_MODEL_API_KEY",
  },
  "bots.settings.providerEndpointPreview": {
    "zh-CN": "实际请求地址：{url}",
    en: "Resolved endpoint: {url}",
  },
  "bots.settings.providerCredentialLimited": {
    "zh-CN":
      "当前 EnvArena 沙箱版本不支持从客户端写入自定义 API Key。默认模型需平台侧修复鉴权或升级沙箱；此处仍可配置无鉴权内部网关或引用沙箱已有环境变量。",
    en: "This EnvArena sandbox version does not support injecting custom API keys from the client yet. Platform credentials or a sandbox upgrade is needed for authenticated custom keys; keyless gateways or existing sandbox env vars still work.",
  },
  "bots.settings.providerStatusLabel": {
    "zh-CN": "通道状态",
    en: "Channel status",
  },
  "bots.settings.connectionLabel": {
    "zh-CN": "云端沙箱",
    en: "Cloud sandbox",
  },
  "bots.settings.contextLabel": {
    "zh-CN": "上下文窗口",
    en: "Context window",
  },
  "bots.settings.topicLabel": {
    "zh-CN": "会话话题",
    en: "Conversation",
  },
  "bots.settings.copyWorkspace": {
    "zh-CN": "复制工作区 ID",
    en: "Copy workspace ID",
  },
  "bots.settings.workspace": {
    "zh-CN": "工作区 ID",
    en: "Workspace ID",
  },
  "bots.create.title": {
    "zh-CN": "新建 Personal Agent",
    en: "Create Personal Agent",
  },
  "bots.create.subtitle": {
    "zh-CN": "每个 Bot 都拥有独立的云端环境与记忆。你可以先填名字和偏好，随时在右侧调整。",
    en: "Each bot gets its own persistent cloud workspace and memory. You can refine preferences anytime.",
  },
  "bots.create.templates": {
    "zh-CN": "快速模板",
    en: "Quick templates",
  },
  "bots.create.workspaceOptional": {
    "zh-CN": "工作区 ID（可选，留空自动生成）",
    en: "Workspace ID (optional, auto-generated)",
  },
  "bots.create.workspacePlaceholder": {
    "zh-CN": "bot-weekly-helper",
    en: "bot-weekly-helper",
  },
  "bots.create.submit": {
    "zh-CN": "创建 Bot",
    en: "Create Bot",
  },
  "bots.create.creating": {
    "zh-CN": "创建中…",
    en: "Creating…",
  },
  "bots.templates.weekly.name": {
    "zh-CN": "周报助手",
    en: "Weekly Digest",
  },
  "bots.templates.weekly.description": {
    "zh-CN": "梳理本周进展、风险与下周计划",
    en: "Summarize weekly progress, risks, and next-week plans",
  },
  "bots.templates.weekly.preferences": {
    "zh-CN": "用简明中文要点回复，优先突出结论与待办动作，避免冗长客套。",
    en: "Reply concisely in bullet points, highlight decisions and action items first, and skip filler.",
  },
  "bots.templates.weekly.starter1": {
    "zh-CN": "帮我整理本周工作重点",
    en: "Organize my key highlights from this week",
  },
  "bots.templates.weekly.starter2": {
    "zh-CN": "根据零散记录生成一版周报",
    en: "Draft a weekly report from my rough notes",
  },
  "bots.templates.planner.name": {
    "zh-CN": "日程规划师",
    en: "Day Planner",
  },
  "bots.templates.planner.description": {
    "zh-CN": "安排专注时间块与日常优先级",
    en: "Schedule focus blocks and daily priorities",
  },
  "bots.templates.planner.preferences": {
    "zh-CN": "上午优先安排深度工作，会议集中放下午；给出清晰的时间块建议。",
    en: "Reserve mornings for deep work, batch meetings in the afternoon, and propose clear time blocks.",
  },
  "bots.templates.planner.starter1": {
    "zh-CN": "帮我规划今天的重点事项",
    en: "Plan my top priorities for today",
  },
  "bots.templates.planner.starter2": {
    "zh-CN": "这周任务太多，帮我排优先级",
    en: "Help me prioritize this week's workload",
  },
  "bots.templates.memory.name": {
    "zh-CN": "个人知识库",
    en: "Knowledge Keeper",
  },
  "bots.templates.memory.description": {
    "zh-CN": "沉淀长期记忆、笔记与资料摘要",
    en: "Capture long-term memory, notes, and reading summaries",
  },
  "bots.templates.memory.preferences": {
    "zh-CN": "主动帮我提炼关键事实并建议记录到长期记忆，回答时标明依据。",
    en: "Extract durable facts for long-term memory and cite prior notes when answering.",
  },
  "bots.templates.memory.starter1": {
    "zh-CN": "记录一条长期偏好",
    en: "Save a new long-term preference",
  },
  "bots.templates.memory.starter2": {
    "zh-CN": "回顾之前保存的重点笔记",
    en: "Review my saved notes and highlights",
  },
} as const;
