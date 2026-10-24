export const automationMessages = {
  "settings.computer.lcuReady": { "zh-CN": "LCU 连接已就绪", "en": "LCU connection ready" },
  "settings.computer.lcuNotReady": { "zh-CN": "LCU 连接未就绪", "en": "LCU connection not ready" },
  "settings.computer.lcuRefresh": { "zh-CN": "刷新连接状态", "en": "Refresh connection status" },
  "settings.computer.provider": {"zh-CN": "控制方式", "en": "Computer provider"},
  "settings.computer.providerDescription": {"zh-CN": "切换会先停止当前控制。外部 CUA 仅用于启用后新建的普通聊天。", "en": "Switching first stops current control. External CUA applies to new regular chats."},
  "settings.computer.native": {"zh-CN": "内置", "en": "Built-in"},
  "settings.computer.lcu": {"zh-CN": "外部 CUA（LCU）", "en": "External CUA (LCU)"},
  "settings.computer.executable": {"zh-CN": "LCU 程序路径", "en": "LCU executable"},
  "settings.computer.executableDescription": {"zh-CN": "填写你已安装的 LCU 绝对路径。应用不会安装、更新或授予系统权限。", "en": "Enter the absolute path to your installed LCU. The app does not install, update, or grant system permissions."},
  "settings.computer.save": {"zh-CN": "保存路径", "en": "Save path"},
  "settings.computer.check": {"zh-CN": "检查连接", "en": "Check connection"},
  "settings.computer.lcuDescription": {"zh-CN": "LCU 负责电脑控制和应用授权。内置网页预览保持可用；外部 CUA 不提供浏览器能力。更改配置后新建聊天。", "en": "LCU handles computer control and application consent. In-app browser previews remain available. Create a new chat after changing the configuration."},
  "settings.computer.capacityReached": { "zh-CN": "控制轮次记录已达上限，请重启应用后继续。", "en": "Control turn records reached capacity. Restart the application to continue." },
  "settings.browserData.sharedShort": { "zh-CN": "所有项目共享持久登录数据。", "en": "All projects share persistent login data." },
  "settings.browserData.title": {"zh-CN": "浏览器登录与数据", "en": "Browser login and data"},
  "settings.browserData.sharedDescription": {"zh-CN": "所有项目共用一个持久浏览器 Profile。登录和站点数据跨重启保留；清理或导入会先停止并关闭当前浏览页面。", "en": "All projects share one persistent browser profile. Login and site data survive restarts. Clearing or importing first stops and closes current browser pages."},
  "settings.browserData.import": {"zh-CN": "从 Chrome 导入", "en": "Import from Chrome"},
  "settings.browserData.importDescription": {"zh-CN": "导入 Chrome 的 Cookie 和本地站点存储。仅点击后读取源数据，macOS 可能要求钥匙串授权。", "en": "Import Chrome cookies and local site storage. Source data is read only after clicking. macOS may request Keychain access."},
  "settings.browserData.clearCache": {"zh-CN": "清除缓存", "en": "Clear cache"},
  "settings.browserData.cacheDescription": {"zh-CN": "清理页面与服务缓存，保留 Cookie 和登录存储。", "en": "Remove page and service caches while keeping cookies and login storage."},
  "settings.browserData.clearAll": {"zh-CN": "清除全部浏览数据", "en": "Clear all browser data"},
  "settings.browserData.allDescription": {"zh-CN": "删除所有项目共享的 Cookie、登录和站点存储。", "en": "Delete the cookies, logins and site storage shared by all projects."},
  "settings.browserData.confirmDescription": {"zh-CN": "此操作会退出内置浏览器中所有网站的登录，并影响全部项目。", "en": "This signs out websites in the in-app browser and affects every project."},
  "settings.browserData.cancel": {"zh-CN": "取消", "en": "Cancel"},
  "settings.browserData.confirmClear": {"zh-CN": "确认清除全部数据", "en": "Confirm clearing all data"},
  "settings.browserData.cleared": {"zh-CN": "浏览数据已清理。", "en": "Browser data cleared."},
  "settings.browserData.imported": {"zh-CN": "已导入 {cookies} 个 Cookie 和 {origins} 个站点的本地存储。跳过 {skipped} 项，失败 {failed} 项。", "en": "Imported {cookies} cookies and local storage for {origins} sites. Skipped {skipped} items; failed {failed} items."},
  "settings.computer.title": {
    "zh-CN": "电脑控制",
    "en": "Computer control"
  },
  "settings.computer.enable": {
    "zh-CN": "启用电脑控制",
    "en": "Enable computer control"
  },
  "settings.computer.enableDescription": {
    "zh-CN": "允许 Agent 经审批操作本机应用。系统权限由你单独授权。",
    "en": "Allow approved Agent actions in local applications. You grant system permissions separately."
  },
  "settings.computer.showEntry": {
    "zh-CN": "在输入框显示电脑操作按钮",
    "en": "Show computer control in the composer"
  },
  "settings.computer.showEntryDescription": {
    "zh-CN": "按钮打开电脑控制设置。隐藏按钮不会关闭能力。",
    "en": "The button opens computer control settings. Hiding it does not disable the capability."
  },
  "settings.computer.permissions": {
    "zh-CN": "系统授权",
    "en": "System access"
  },
  "settings.computer.permissionsDescription": {
    "zh-CN": "为 AReaL Computer Helper 授权。权限状态由实际执行操作的 Helper 检查。",
    "en": "Grant access to AReaL Computer Helper. The helper that executes actions checks these permissions."
  },
  "settings.computer.accessibility": {
    "zh-CN": "辅助功能 (Accessibility)",
    "en": "Accessibility"
  },
  "settings.computer.accessibilityDescription": {
    "zh-CN": "读取应用界面，并操作可访问的控件。",
    "en": "Read application interfaces and operate accessible controls."
  },
  "settings.computer.screenRecording": {
    "zh-CN": "屏幕录制 (Screen Recording)",
    "en": "Screen recording"
  },
  "settings.computer.screenRecordingDescription": {
    "zh-CN": "截取目标窗口，供 Agent 观察。",
    "en": "Capture the target window for the Agent to observe."
  },
  "settings.computer.inputMonitoring": {
    "zh-CN": "输入监控 (Input Monitoring)",
    "en": "Input monitoring"
  },
  "settings.computer.inputMonitoringDescription": {
    "zh-CN": "检测你的键鼠输入并停止自动操作。所有修改应用的操作都需要可用的接管监听。",
    "en": "Detect your input and stop automation. All application mutations require working takeover monitoring."
  },
  "settings.computer.grant": {
    "zh-CN": "授权",
    "en": "Grant access"
  },
  "settings.computer.openSettings": {
    "zh-CN": "打开系统设置",
    "en": "Open system settings"
  },
  "settings.computer.granted": {
    "zh-CN": "已授权",
    "en": "Granted"
  },
  "settings.computer.denied": {
    "zh-CN": "未授权",
    "en": "Not granted"
  },
  "settings.computer.unknown": {
    "zh-CN": "未知",
    "en": "Unknown"
  },
  "settings.computer.stale": {
    "zh-CN": "需要复验",
    "en": "Recheck required"
  },
  "settings.computer.unsupported": {
    "zh-CN": "此环境暂不支持电脑控制。当前原生后端需要本机 macOS 14 或更高版本。",
    "en": "Computer control is unavailable here. The native backend requires local macOS 14 or later."
  },
  "settings.computer.refresh": {
    "zh-CN": "刷新权限状态",
    "en": "Refresh access status"
  },
  "settings.computer.restart": {
    "zh-CN": "重启控制 Helper",
    "en": "Restart control helper"
  },
  "settings.computer.stop": {
    "zh-CN": "停止电脑操作",
    "en": "Stop computer control"
  },
  "settings.computer.working": {
    "zh-CN": "正在操作本机应用",
    "en": "Controlling a local application"
  },
  "settings.computer.ready": {
    "zh-CN": "系统授权已就绪",
    "en": "System access is ready"
  },
  "settings.computer.notReady": {
    "zh-CN": "请完成所需的系统授权",
    "en": "Complete the required system access"
  },
  "settings.computer.disabled": {
    "zh-CN": "电脑控制已关闭",
    "en": "Computer control is disabled"
  },
  "settings.computer.noAccess": {
    "zh-CN": "此客户端没有本机电脑控制入口。",
    "en": "This client has no local computer control entry."
  },
  "settings.computer.helper": {
    "zh-CN": "控制进程",
    "en": "Control process"
  },
  "settings.computer.helperDescription": {
    "zh-CN": "权限修改后可以重新检查或重启 Helper。停止操作会撤销当前控制和观察引用。",
    "en": "Recheck or restart the helper after permission changes. Stop revokes current control and observation references."
  },
  "chat.approval.computer": {
    "zh-CN": "电脑控制",
    "en": "Computer control"
  },
  "chat.approval.computerQuestion": {
    "zh-CN": "是否允许操作本机应用？",
    "en": "Allow this local application operation?"
  },
  "chat.approval.computerTarget": {
    "zh-CN": "目标应用",
    "en": "Target application"
  }
} as const;
