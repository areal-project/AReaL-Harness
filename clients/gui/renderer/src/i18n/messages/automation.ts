export const automationMessages = {
  "settings.computer.lcuReady": { "zh-CN": "LCU 连接已就绪", en: "LCU connection ready" },
  "settings.computer.lcuNotReady": { "zh-CN": "LCU 连接未就绪", en: "LCU connection not ready" },
  "settings.computer.lcuRefresh": { "zh-CN": "刷新连接状态", en: "Refresh connection status" },
  "settings.computer.lcu": { "zh-CN": "外部 CUA（LCU）", en: "External CUA (LCU)" },
  "settings.computer.executable": { "zh-CN": "LCU 程序路径", en: "LCU executable" },
  "settings.computer.executableDescription": {
    "zh-CN": "填写你已安装的 LCU 绝对路径。应用不会安装、更新或授予系统权限。",
    en: "Enter the absolute path to your installed LCU. The app does not install, update, or grant system permissions.",
  },
  "settings.computer.save": { "zh-CN": "保存路径", en: "Save path" },
  "settings.computer.check": { "zh-CN": "检查连接", en: "Check connection" },
  "settings.computer.lcuDescription": {
    "zh-CN": "LCU 负责电脑控制和应用授权，内置网页预览不受影响。更改后新建聊天生效。",
    en: "LCU handles computer control and app permissions. Built-in web preview is unaffected. Start a new chat to apply changes.",
  },
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
  "settings.computer.title": {
    "zh-CN": "电脑控制",
    en: "Computer control",
  },
  "settings.computer.enable": {
    "zh-CN": "启用电脑控制",
    en: "Enable computer control",
  },
  "settings.computer.enableDescription": {
    "zh-CN": "允许 Agent 经审批操作本机应用。系统权限由你单独授权。",
    en: "Allow approved Agent actions in local applications. You grant system permissions separately.",
  },
  "settings.computer.showEntry": {
    "zh-CN": "在输入框显示电脑操作按钮",
    en: "Show computer control in the composer",
  },
  "settings.computer.showEntryDescription": {
    "zh-CN": "按钮打开电脑控制设置。隐藏按钮不会关闭能力。",
    en: "The button opens computer control settings. Hiding it does not disable the capability.",
  },
  "settings.computer.unsupported": {
    "zh-CN": "此环境暂不支持电脑控制。外部 CUA 仅支持 macOS。",
    en: "Computer control is unavailable here. External CUA is supported only on macOS.",
  },
  "settings.computer.stop": {
    "zh-CN": "停止电脑操作",
    en: "Stop computer control",
  },
  "settings.computer.working": {
    "zh-CN": "正在操作本机应用",
    en: "Controlling a local application",
  },
  "settings.computer.disabled": {
    "zh-CN": "电脑控制已关闭",
    en: "Computer control is disabled",
  },
  "settings.computer.noAccess": {
    "zh-CN": "此客户端没有本机电脑控制入口。",
    en: "This client has no local computer control entry.",
  },
} as const;
