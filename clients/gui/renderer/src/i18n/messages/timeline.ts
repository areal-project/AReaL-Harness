export const timelineMessages = {
  "chat.timeline.messageTime": { "zh-CN": "消息时间 {time}", en: "Message time {time}" },
  "chat.timeline.modelChange": {
    "zh-CN": "模型 {from} → {to}，下轮生效",
    en: "Model {from} → {to}, effective next turn",
  },
  "chat.timeline.retry.waiting": {
    "zh-CN": "正在等待重试，已尝试 {attempts} 次。",
    en: "Waiting to retry after {attempts} attempts.",
  },
  "chat.timeline.retry.retrying": {
    "zh-CN": "正在重试，当前第 {attempts} 次尝试。",
    en: "Retrying, attempt {attempts}.",
  },
  "chat.timeline.retry.recovered": {
    "zh-CN": "连接已恢复，共尝试 {attempts} 次。",
    en: "Connection recovered after {attempts} attempts.",
  },
  "chat.timeline.retry.exhausted": {
    "zh-CN": "重试额度已耗尽，共尝试 {attempts} 次。",
    en: "Retry budget exhausted after {attempts} attempts.",
  },
  "chat.timeline.retry.stopped": {
    "zh-CN": "重试已停止，共尝试 {attempts} 次。",
    en: "Retry stopped after {attempts} attempts.",
  },
  "chat.timeline.retry.delay": {
    "zh-CN": "计划等待 {seconds} 秒。",
    en: "Scheduled wait {seconds} seconds.",
  },
  "chat.timeline.interruption.userPause": {
    "zh-CN": "你暂停了本轮执行",
    en: "You paused this turn",
  },
  "chat.timeline.interruption.coreRecovery": {
    "zh-CN": "Core 恢复时中断了本轮执行",
    en: "This turn was interrupted during Core recovery",
  },
  "chat.timeline.interruption.other": {
    "zh-CN": "本轮执行已中断",
    en: "This turn was interrupted",
  },
} as const;
