import type { MessagePair } from "../messages.js";

export const labsMessages = {
  "settings.labs.title": { "zh-CN": "Labs", en: "Labs" },
  "settings.labs.description": {
    "zh-CN": "实验功能默认关闭，按需开启后才会出现在应用导航中。",
    en: "Experimental features stay off by default and appear in the app navigation once enabled.",
  },
  "settings.labs.bots.label": { "zh-CN": "Bots", en: "Bots" },
  "settings.labs.bots.description": {
    "zh-CN": "启用 Bot 工作区和相关设置入口。",
    en: "Show the Bots workspace and its settings entry.",
  },
} satisfies Record<string, MessagePair>;
