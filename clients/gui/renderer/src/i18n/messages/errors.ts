// 错误码对应的用户文案。只写一次：发生了什么、工作有没有受影响、现在能做什么。
// 登记与动作见 renderer/src/errors/errorCopy.ts。
export const errorMessages = {
  "errors.generic": {
    "zh-CN": "操作没有完成，请重试。",
    en: "That didn't work. Please try again.",
  },
  "errors.FORBIDDEN": {
    "zh-CN": "这台设备没有权限做这个操作。请在桌面应用的“手机与网页”设置里重新允许它。",
    en: "This device isn't allowed to do that. Allow it again in the desktop app under Mobile & Web.",
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
  "errors.INVALID_RESPONSE": {
    "zh-CN": "收到的结果不完整，请重试。",
    en: "The result came back incomplete. Please try again.",
  },
  "errors.LIMIT_EXCEEDED": {
    "zh-CN": "内容太大，超过了上限。请减少文字或附件后再试。",
    en: "This is too large. Shorten the text or remove attachments and try again.",
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
    "zh-CN": "对话刚刚有了新变化，这次操作没有执行，输入的内容已保留。请看一下最新内容后再试。",
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
  "errors.PERSISTED_HISTORY_UNAVAILABLE": {
    "zh-CN": "历史记录暂时打不开，请稍后重试。历史本身没有丢失。",
    en: "History can't be opened right now. Nothing is lost; try again in a moment.",
  },
  "errors.MIGRATION_PENDING": {
    "zh-CN": "项目上次的运行还没确认停止，暂时打不开。历史和草稿都已保留，请先确认原任务已停止。",
    en: "The project's last run hasn't confirmed it stopped, so it can't open yet. History and drafts are kept. Make sure the original task has stopped.",
  },
  "errors.UNSUPPORTED_PROFILE": {
    "zh-CN": "当前的模型设置不支持这个操作，请在会话设置里换一个模型。",
    en: "The current model settings don't support this. Choose another model in conversation settings.",
  },
  "errors.PAIRING_EXPIRED": {
    "zh-CN": "邀请已过期，请在桌面应用里生成新的配对码。",
    en: "This invite expired. Create a new pairing code in the desktop app.",
  },
  "errors.PAIRING_USED": {
    "zh-CN": "这个邀请已经用过或被取消，请生成新的配对码。",
    en: "This invite was already used or cancelled. Create a new pairing code.",
  },
  "errors.PAIRING_CANCELLED": { "zh-CN": "配对已取消。", en: "Pairing was cancelled." },
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
  "errors.workerRunMissing": {
    "zh-CN": "找不到这个对话所属的任务运行。",
    en: "Couldn't find the task run this conversation belongs to.",
  },
} as const;
