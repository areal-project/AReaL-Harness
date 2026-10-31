export const browserMessages = {
  "browser.viewport.pending": { "zh-CN": "尺寸尚未应用", en: "Dimensions not yet applied" },
  "browser.loadError.title": { "zh-CN": "无法加载网页", en: "Unable to load page" },
  "browser.loadError.retry": { "zh-CN": "重新加载网页", en: "Reload page" },
  "browser.loadError.hint": {
    "zh-CN": "重新加载当前网页。原动作的结果需在操作记录中核对。",
    en: "Reload the current page. Check the original action record to confirm its outcome.",
  },
  "browser.failure.permission": { "zh-CN": "浏览器权限拒绝", en: "Browser permission denied" },
  "browser.failure.operation": { "zh-CN": "浏览器操作未完成", en: "Browser operation incomplete" },
  "browser.failure.unknown": {
    "zh-CN": "浏览器动作结果未确认",
    en: "Browser action outcome unconfirmed",
  },
  "browser.failure.permissionHint": {
    "zh-CN": "请检查网址与浏览器权限。修改后再主动打开页面。",
    en: "Check the address and browser permissions before opening the page again.",
  },
  "browser.failure.operationHint": {
    "zh-CN": "请核对当前页面状态后选择下一步。",
    en: "Check the current page before choosing your next action.",
  },
  "browser.failure.unknownHint": {
    "zh-CN": "动作可能已经执行。先核对页面与原操作记录。",
    en: "The action may have run. Check the page and the original action record first.",
  },
  "browser.failure.checkState": { "zh-CN": "读取页面状态", en: "Read page state" },
  "browser.failure.inspectAction": { "zh-CN": "核对原动作", en: "Inspect original action" },
  "browser.viewport.preset": { "zh-CN": "设备预设", en: "Device preset" },
  "browser.viewport.phone": { "zh-CN": "手机", en: "Phone" },
  "browser.viewport.tablet": { "zh-CN": "平板", en: "Tablet" },
  "browser.viewport.desktop": { "zh-CN": "桌面", en: "Desktop" },
  "browser.viewport.custom": { "zh-CN": "自定义", en: "Custom" },
  "browser.viewport.width": { "zh-CN": "宽度", en: "Width" },
  "browser.viewport.height": { "zh-CN": "高度", en: "Height" },
  "browser.viewport.rotate": { "zh-CN": "旋转", en: "Rotate" },
  "browser.viewport.auto": { "zh-CN": "自适应", en: "Fit panel" },
} as const;
