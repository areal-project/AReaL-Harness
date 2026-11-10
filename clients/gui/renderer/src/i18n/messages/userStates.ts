// 用户可见状态的文字，与 renderer/src/state/userStates.ts 一一对应。
export const userStateMessages = {
  "userState.project.ready": { "zh-CN": "可用", en: "Ready" },
  "userState.project.opening": { "zh-CN": "正在打开", en: "Opening" },
  "userState.project.needsUpgrade": { "zh-CN": "需要升级", en: "Needs upgrade" },
  "userState.project.unavailable": { "zh-CN": "暂时打不开", en: "Unavailable" },
  "userState.conversation.idle": { "zh-CN": "空闲", en: "Idle" },
  "userState.conversation.working": { "zh-CN": "正在回复", en: "Working" },
  "userState.conversation.needsYou": { "zh-CN": "等你处理", en: "Needs you" },
  "userState.conversation.failed": { "zh-CN": "出错了", en: "Something went wrong" },
  "userState.task.scheduled": { "zh-CN": "等待下次运行", en: "Scheduled" },
  "userState.task.running": { "zh-CN": "运行中", en: "Running" },
  "userState.task.needsYou": { "zh-CN": "等你处理", en: "Needs you" },
  "userState.task.paused": { "zh-CN": "已暂停", en: "Paused" },
  "userState.task.finished": { "zh-CN": "已结束", en: "Finished" },
  "userState.task.failed": { "zh-CN": "没有完成", en: "Didn't finish" },
} as const;
