export const automationMessages = {
  "settings.browserData.sharedShort": {
    "zh-CN": "所有项目共享持久登录数据。",
    en: "All projects share persistent login data.",
  },
  "settings.browserData.title": { "zh-CN": "浏览器登录与数据", en: "Browser login and data" },
  "settings.browserData.sharedDescription": {
    "zh-CN": "所有项目共用一个浏览器 Profile，登录跨重启保留。清理或导入会关闭当前页面。",
    en: "All projects share one browser profile, and sign-ins persist across restarts. Clearing or importing closes open pages.",
  },
  "settings.browserData.import": { "zh-CN": "从 Chrome 导入", en: "Import from Chrome" },
  "settings.browserData.importDescription": {
    "zh-CN": "导入 Chrome 的 Cookie 和本地站点存储。仅点击后读取源数据，macOS 可能要求钥匙串授权。",
    en: "Import Chrome cookies and local site storage. Source data is read only after clicking. macOS may request Keychain access.",
  },
  "settings.browserData.clearCache": { "zh-CN": "清除缓存", en: "Clear cache" },
  "settings.browserData.cacheDescription": {
    "zh-CN": "清理页面与服务缓存，保留 Cookie 和登录存储。",
    en: "Remove page and service caches while keeping cookies and login storage.",
  },
  "settings.browserData.clearAll": { "zh-CN": "清除全部浏览数据", en: "Clear all browser data" },
  "settings.browserData.allDescription": {
    "zh-CN": "删除所有项目共享的 Cookie、登录和站点存储。",
    en: "Delete the cookies, logins and site storage shared by all projects.",
  },
  "settings.browserData.confirmDescription": {
    "zh-CN": "此操作会退出内置浏览器中所有网站的登录，并影响全部项目。",
    en: "This signs out websites in the in-app browser and affects every project.",
  },
  "settings.browserData.cancel": { "zh-CN": "取消", en: "Cancel" },
  "settings.browserData.confirmClear": {
    "zh-CN": "确认清除全部数据",
    en: "Confirm clearing all data",
  },
  "settings.browserData.cleared": { "zh-CN": "浏览数据已清理。", en: "Browser data cleared." },
  "settings.browserData.imported": {
    "zh-CN":
      "已导入 {cookies} 个 Cookie 和 {origins} 个站点的本地存储。跳过 {skipped} 项，失败 {failed} 项。",
    en: "Imported {cookies} cookies and local storage for {origins} sites. Skipped {skipped} items; failed {failed} items.",
  },
} as const;
