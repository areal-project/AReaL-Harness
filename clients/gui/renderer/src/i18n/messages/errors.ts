// 错误码对应的用户文案。只写一次：发生了什么、工作有没有受影响、现在能做什么。
// 登记与动作见 renderer/src/errors/errorCopy.ts。
export const errorMessages = {
  "errors.generic": {
    "zh-CN": "操作没有完成，请重试。",
    en: "That didn't work. Please try again.",
  },
  "errors.CLOUD_IMPORT_REQUIRED": {
    "zh-CN": "旧版 Cloud 凭据尚未导入。请在桌面应用中解锁凭据后重新连接。",
    en: "Your previous Cloud credentials still need to be imported. Unlock credentials in the desktop app, then reconnect.",
  },
  "errors.SOURCE_CHANGED": {
    "zh-CN": "来源已变化。请刷新后重试。",
    en: "The source has changed. Refresh and try again.",
  },
  "errors.FORBIDDEN": {
    "zh-CN": "这台设备没有权限做这个操作。请在桌面应用“手机连接”设置里允许它。",
    en: "This device isn't allowed to do that. Allow it again in the desktop app under Mobile connection.",
  },
  "errors.GRANT_CHANGED": {
    "zh-CN": "这台设备的权限刚刚有变化，请刷新后再试。",
    en: "This device's permissions just changed. Refresh and try again.",
  },
  "errors.CAPABILITY_UNAVAILABLE": {
    "zh-CN": "这个功能现在用不了，桌面应用可能没有打开。打开桌面应用后再试。",
    en: "This feature isn't available right now. The desktop app may be closed. Open it and try again.",
  },
  "errors.CORE_UNAVAILABLE": {
    "zh-CN": "项目暂时没有响应。你的内容已保留，请稍后重试。",
    en: "The project isn't responding right now. Your work is kept. Try again in a moment.",
  },
  "errors.CORE_INCOMPATIBLE": {
    "zh-CN": "项目需要更新后才能继续使用。请重新打开应用完成更新。",
    en: "This project needs an update before you can continue. Reopen the app to finish updating.",
  },
  "errors.CONFLICT": {
    "zh-CN": "应用需要重新打开才能继续。请退出后重新打开应用，你的内容不会丢失。",
    en: "The app needs to restart to continue. Quit and reopen it; your work won't be lost.",
  },
  "errors.RESYNC_REQUIRED": {
    "zh-CN": "内容已在别处更新，请刷新后再试。",
    en: "This was updated elsewhere. Refresh and try again.",
  },
  "errors.INVALID_PARAMS": {
    "zh-CN": "这个操作没有完成，请刷新后再试。",
    en: "That didn't work. Refresh and try again.",
  },
  "errors.ATTACHMENT_UNSUPPORTED": {
    "zh-CN": "不支持这个附件。可以附加图片、音频，或 UTF-8 编码的文本和源码文件。",
    en: "This attachment isn't supported. Attach an image, audio, or a UTF-8 text or source file.",
  },
  "errors.EXECUTION_CONFIGURATION_UNAVAILABLE": {
    "zh-CN": "历史仍可读取，请修复会话的执行配置后再发送。",
    en: "History is still readable. Repair this conversation's execution configuration before sending.",
  },
  "errors.PROVIDER_CREDENTIAL_REQUIRED": {
    "zh-CN": "请填写 API Key，或保留已配置的凭据环境变量。",
    en: "Enter an API key or keep the configured credential environment variable.",
  },
  "errors.INVALID_RESPONSE": {
    "zh-CN": "收到的结果不完整，请重试。",
    en: "The result came back incomplete. Please try again.",
  },
  "errors.LIMIT_EXCEEDED": {
    "zh-CN": "内容太大，超过了上限。请减少文字或附件后再试。",
    en: "This is too large. Shorten the text or remove attachments and try again.",
  },
  "errors.INPUT_LIMIT_EXCEEDED": {
    "zh-CN": "输入内容超过 1 MiB，请减少文字或附件后再试。",
    en: "Input exceeds 1 MiB. Shorten the text or remove attachments and try again.",
  },
  "errors.CAPACITY_EXCEEDED": {
    "zh-CN": "同时进行的工作太多，请等一会儿再试。",
    en: "Too much is running at once. Wait a moment and try again.",
  },
  "errors.COMMAND_CONFLICT": {
    "zh-CN": "另一个操作还在进行，请等它完成后再试。",
    en: "Another action is still in progress. Try again when it finishes.",
  },
  "errors.RESOURCE_UNAVAILABLE": {
    "zh-CN": "要打开的内容已不存在，或暂时打不开。",
    en: "This item no longer exists or can't be opened right now.",
  },
  "errors.RESOURCE_BUSY": {
    "zh-CN": "这项内容正在被使用，请稍后再试。",
    en: "This item is in use. Try again in a moment.",
  },
  "errors.NOT_FOUND": {
    "zh-CN": "找不到要打开的内容，它可能已被删除。",
    en: "We couldn't find this. It may have been deleted.",
  },
  "errors.TARGET_CHANGED": {
    "zh-CN": "对话刚有新变化，这次操作没有执行，输入已保留。请看过最新内容后再试。",
    en: "The conversation just changed, so nothing was done and your input is kept. Check the latest and try again.",
  },
  "errors.TURN_BUSY": {
    "zh-CN": "上一条消息还在处理，请等它完成或先停止。",
    en: "The previous message is still running. Wait for it or stop it first.",
  },
  "errors.SUBMISSION_UNKNOWN": {
    "zh-CN": "还不确定这次操作是否完成。请先查看结果再决定是否重试，以免重复。",
    en: "We're not sure whether that finished. Check the result before trying again to avoid doing it twice.",
  },
  "errors.SUBMISSION_PENDING": {
    "zh-CN": "上一条消息尚未确认，已暂停新的写入以免重复，请先查看最新状态。",
    en: "The previous message status is still unconfirmed. New sends are paused to avoid duplicates—check the latest status first.",
  },
  "errors.ARENA_NOT_CONFIGURED": {
    "zh-CN": "尚未配置 EnvArena 网关地址或访问令牌，请先完成连接配置。",
    en: "EnvArena gateway URL or access token is not configured yet. Configure the connection first.",
  },
  "errors.BOT_MODEL_AUTH_REQUIRED": {
    "zh-CN": "远端沙箱无法使用这个模型。请检查模型服务和沙箱授权。",
    en: "The sandbox cannot use this model. Check the model service and sandbox access.",
  },
  "errors.REMOTE_CREDENTIAL_UNSUPPORTED": {
    "zh-CN": "当前远端沙箱不支持写入自定义 API Key，请留空或升级沙箱后再试。",
    en: "This EnvArena sandbox version does not support registering custom API keys at runtime yet. Leave API Key blank for a keyless or preconfigured gateway, or upgrade the sandbox.",
  },
  "errors.PROVIDER_MANAGED": {
    "zh-CN":
      "内置 Provider（如 arena）由远端沙箱托管，不能直接覆盖。请改用新的 Provider ID（例如 custom）。",
    en: "Built-in providers (such as arena) are managed by the sandbox and cannot be overwritten. Use a different Provider ID (e.g. custom).",
  },
  "errors.REVIEW_INCOMPLETE": {
    "zh-CN": "还有待确认的内容没有处理，请先处理完再继续。",
    en: "Some items still need your review. Finish them first.",
  },
  "errors.CONFIRMATION_STALE": {
    "zh-CN": "这次确认已过期，请重新确认。",
    en: "This confirmation expired. Please confirm again.",
  },
  "errors.TASK_CONTROL_REQUIRED": {
    "zh-CN": "这个对话由任务管理，请到对应的任务里操作。",
    en: "This conversation is managed by a task. Make the change from the task.",
  },
  "errors.CREATION_REJECTED": {
    "zh-CN": "对话没有创建成功，请检查会话设置后重试。",
    en: "The conversation wasn't created. Check its settings and try again.",
  },
  "errors.TASK_REJECTED": {
    "zh-CN": "任务没有创建成功，请检查任务设置后重试。",
    en: "The task wasn't created. Check its settings and try again.",
  },
  "errors.TASK_WORKSPACE_UNAVAILABLE": {
    "zh-CN": "任务的工作目录不可用，请确认它还在原来的位置。",
    en: "The task's folder isn't available. Make sure it's still where it was.",
  },
  "errors.TASK_CATALOG_READ_FAILED": {
    "zh-CN": "任务列表暂时读不出来，请重试。",
    en: "Couldn't load the task list. Please try again.",
  },
  "errors.RECONNECTING": {
    "zh-CN": "原连接刚断开，正在恢复。这条操作没有发出，恢复后再试一次。",
    en: "The previous connection just dropped and is recovering. Nothing was sent; try again once it's back.",
  },
  "errors.stopInProgress": {
    "zh-CN": "后台服务正在停止。请等连接恢复后再试。",
    en: "The background service is stopping. Try again once the connection returns.",
  },
  "errors.PERSISTED_HISTORY_UNAVAILABLE": {
    "zh-CN": "历史记录暂时打不开，请稍后重试。历史本身没有丢失。",
    en: "History can't be opened right now. Nothing is lost; try again in a moment.",
  },
  "errors.MIGRATION_PENDING": {
    "zh-CN": "上次运行还没确认停止，暂时打不开。历史和草稿已保留，请先确认已停止。",
    en: "The project's last run hasn't confirmed it stopped, so it can't open yet. History and drafts are kept. Make sure the original task has stopped.",
  },
  "errors.UNSUPPORTED_PROFILE": {
    "zh-CN": "当前的模型设置不支持这个操作，请在会话配置里换一个模型。",
    en: "The current model settings don't support this. Choose another model in session configuration.",
  },
  "errors.MODEL_REASONING_EFFORT_UNSUPPORTED": {
    "zh-CN": "当前模型不支持所选推理强度，请选择支持的强度或服务默认值。",
    en: "The model does not support this reasoning effort. Choose a supported effort or the service default.",
  },
  "errors.PROFILE_NOT_SUPPORTED": {
    "zh-CN": "所选执行配置不支持此操作，请选择兼容的配置。（PROFILE_NOT_SUPPORTED）",
    en: "The selected profile does not support this operation. Choose a compatible profile. (PROFILE_NOT_SUPPORTED)",
  },
  "errors.PAIRING_EXPIRED": {
    "zh-CN": "邀请已过期，请在桌面应用里生成新的配对码。",
    en: "This invite expired. Create a new pairing code in the desktop app.",
  },
  "errors.PAIRING_USED": {
    "zh-CN": "这个邀请已经用过或被取消，请生成新的配对码。",
    en: "This invite was already used or canceled. Create a new pairing code.",
  },
  "errors.PAIRING_CANCELLED": { "zh-CN": "配对已取消。", en: "Pairing was canceled." },
  "errors.PROTOCOL_UNSUPPORTED": {
    "zh-CN": "这个客户端版本太旧，请更新后再连接。",
    en: "This app version is too old. Update it and connect again.",
  },
  "errors.DISCONNECTED": {
    "zh-CN": "与桌面应用的连接断开了。你的内容已保留，重新连接后再试。",
    en: "Lost connection to the desktop app. Your work is kept. Reconnect and try again.",
  },
  "errors.TIMEOUT": {
    "zh-CN": "等了太久没有回应，请重试。",
    en: "No response after waiting too long. Please try again.",
  },
  "errors.lifecycle": {
    "zh-CN": "项目没能启动或停止，请重试。",
    en: "The project couldn't start or stop. Please try again.",
  },
  "errors.action.retry": { "zh-CN": "重试", en: "Try again" },
  "errors.action.refresh": { "zh-CN": "刷新", en: "Refresh" },
  "errors.action.reconnect": { "zh-CN": "重新连接", en: "Reconnect" },
  "errors.action.openSettings": { "zh-CN": "打开设置", en: "Open settings" },
  "errors.approvalRefreshFailed": {
    "zh-CN": "暂时无法确认审批状态。",
    en: "Couldn't check the approval status right now.",
  },
  "errors.approvalUnknown": {
    "zh-CN": "还不确定审批结果是否已提交。请先刷新查看，不会自动重复提交。",
    en: "We're not sure your approval went through. Refresh to check; it won't be sent again automatically.",
  },
  "errors.turnFailed": {
    "zh-CN": "消息已发出，但这一轮没有完成。请查看对话里的结果。",
    en: "Your message was sent, but this turn didn't finish. Check the conversation for the result.",
  },
  "errors.turnRejected": {
    "zh-CN": "上一轮已经结束，这条内容没有发出，已保留在输入框。请检查后再发送。",
    en: "The previous turn already ended, so this wasn't sent. It's still in the input box; check it and send again.",
  },
  "errors.inboxProjectFailed": {
    "zh-CN": "{project}：{reason}已保留上次读取的问题。",
    en: "{project}: {reason} Showing the questions from the last read.",
  },
  "errors.workerRunMissing": {
    "zh-CN": "找不到这个对话所属的任务运行。",
    en: "Couldn't find the task run this conversation belongs to.",
  },
  "errors.storageAuthorizationRequired": {
    "zh-CN": "macOS 钥匙串未授权当前应用访问凭据，请在钥匙串访问中授权后重试。",
    en: "macOS Keychain did not authorize this app to access credentials. Grant access in Keychain and try again.",
  },
  "errors.storageMissing": {
    "zh-CN": "钥匙串缺少解密本地凭据的主密钥，请恢复凭据或重新配置手机连接。",
    en: "The Keychain master key for encrypted credentials is missing. Restore the original key or reconfigure mobile access.",
  },
  "errors.storageLocked": {
    "zh-CN": "本地凭据存储已锁定，请解锁钥匙串后重试。",
    en: "Credential storage is locked. Unlock your Keychain and try again.",
  },
  "errors.credentialHostRestartRequired": {
    "zh-CN": "新版应用已安装，但旧后台仍在运行，请重启后台服务后重试。",
    en: "A newer version is installed while the old background service is still running. Restart the background service and try again.",
  },
  "errors.remoteCredentialUnreadable": {
    "zh-CN": "无法解密手机连接凭据，请从同份备份恢复钥匙串，或重新配置并配对。",
    en: "The saved mobile connection credentials cannot be decrypted. Restore the matching Keychain master key and mobile connection settings from the same backup, then try again. Without a usable backup, set up mobile access again and re-pair your devices. A Provider API key cannot restore mobile access.",
  },
  "errors.remoteStateUnavailable": {
    "zh-CN": "手机连接配置尚未加载完成，请稍后重试。",
    en: "Remote configuration has not been loaded yet. Try again in a moment.",
  },
  "errors.localRelayUnavailable": {
    "zh-CN": "本机 Relay 组件不完整或签名校验未通过，无法启动内网连接。",
    en: "The local Relay bundle is incomplete or failed verification and could not start.",
  },
  "errors.localRelayAddressUnavailable": {
    "zh-CN": "无可用内网地址。请让电脑和手机连同一 Wi‑Fi 或 VPN 后重试。",
    en: "There is no usable local connection address. Connect your computer and phone to the same reachable Wi‑Fi or VPN, enable the local connection again, and generate a new QR code.",
  },
} as const;
