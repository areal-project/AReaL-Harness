export const desktopSettingsMessages = {
  "settings.desktop.terminalFontPlaceholder": {
    "zh-CN": "例如 MesloLGS NF, monospace",
    en: "For example, MesloLGS NF, monospace",
  },
  "settings.desktop.proxyPlaceholder": {
    "zh-CN": "例如 http://127.0.0.1:7890",
    en: "For example, http://127.0.0.1:7890",
  },
  "settings.desktop.noProxyPlaceholder": {
    "zh-CN": "例如 localhost,127.0.0.1,::1,.example.com",
    en: "For example, localhost,127.0.0.1,::1,.example.com",
  },
  "settings.desktop.caPlaceholder": {
    "zh-CN": "例如 /absolute/certs/root-ca.pem",
    en: "For example, /absolute/certs/root-ca.pem",
  },
  "settings.desktop.terminal": { "zh-CN": "终端", en: "Terminal" },
  "settings.desktop.inheritTerminal": {
    "zh-CN": "继承系统终端 Profile",
    en: "Inherit system terminal profile",
  },
  "settings.desktop.inheritTerminalDescription": {
    "zh-CN": "新终端沿用系统终端的字体、字号和配色。",
    en: "New terminals use the system terminal's font, size, and colors.",
  },
  "settings.desktop.terminalFont": { "zh-CN": "终端字体", en: "Terminal font" },
  "settings.desktop.terminalFontDescription": {
    "zh-CN": "填写字体名称以覆盖系统字体，留空自动选择。新终端生效。",
    en: "Enter a font name to override the system font, or leave blank for automatic. Applies to new terminals.",
  },
  "settings.desktop.network": { "zh-CN": "网络", en: "Network" },
  "settings.desktop.proxy": { "zh-CN": "HTTP 代理", en: "HTTP proxy" },
  "settings.desktop.proxyDescription": {
    "zh-CN": "模型、MCP、联网命令和应用浏览器使用此代理。留空使用系统代理，重启后生效。",
    en: "Models, MCP, networked commands, and the app browser use this proxy. Leave blank for the system proxy. Restart to apply.",
  },
  "settings.desktop.noProxy": { "zh-CN": "不使用代理的地址", en: "Proxy bypass addresses" },
  "settings.desktop.noProxyDescription": {
    "zh-CN": "匹配的主机直接连接，用英文逗号分隔，支持域名、IP 和 CIDR。重启后生效。",
    en: "Matching hosts connect directly. Separate domains, IPs, and CIDRs with commas. Restart to apply.",
  },
  "settings.desktop.ca": { "zh-CN": "自定义证书", en: "Custom certificate" },
  "settings.desktop.caDescription": {
    "zh-CN": "填写 PEM 根证书文件的绝对路径以增加信任，留空移除。重启后生效。",
    en: "Enter the absolute path to a PEM root certificate to trust it, or leave blank to remove. Restart to apply.",
  },
  "settings.desktop.graphics": { "zh-CN": "图形", en: "Graphics" },
  "settings.desktop.hardwareAcceleration": {
    "zh-CN": "Chromium 硬件加速",
    en: "Chromium hardware acceleration",
  },
  "settings.desktop.hardwareAccelerationDescription": {
    "zh-CN": "关闭可缓解部分显卡导致的白屏或闪退。重启后生效。",
    en: "Turn off to work around blank screens or crashes caused by some graphics drivers. Restart to apply.",
  },
  "settings.desktop.save": { "zh-CN": "保存", en: "Save" },
  "settings.desktop.saved": { "zh-CN": "已保存", en: "Saved" },
  "settings.desktop.saveFailed": {
    "zh-CN": "设置保存失败，输入已保留。",
    en: "Could not save settings. Your input is preserved.",
  },
  "settings.desktop.taskNotifications": { "zh-CN": "任务通知", en: "Task notifications" },
  "settings.desktop.taskNotificationsDescription": {
    "zh-CN": "任务完成、需要审批或提问时发送系统通知。",
    en: "Send system notifications when a task finishes, needs approval, or asks a question.",
  },
} as const;
