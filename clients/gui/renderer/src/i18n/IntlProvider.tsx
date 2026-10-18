const messages: Record<string, string> = {
  "chat.message.expand": "展开消息",
  "chat.message.collapse": "收起消息",
  "chat.composer.actionMenu": "添加上下文",
  "chat.composer.workspaceFileDragHint": "松开以引用此文件或目录",
  "common.loading": "加载中...",
  "markdownTable.collapseScrollMode": "收回表格滚动区域",
  "markdownTable.copyFailed": "复制表格失败：{error}",
  "markdownTable.copyMarkdown": "复制 Markdown",
  "markdownTable.copySucceeded": "已复制 Markdown 表格",
  "markdownTable.downloadCsv": "下载 CSV",
  "markdownTable.downloadFailed": "下载表格失败",
  "markdownTable.expandScrollMode": "展开表格滚动区域",
  "markdownTable.openPreview": "预览表格",
  "markdownTable.previewDescription": "在更大的可滚动视图中查看表格。",
  "markdownTable.previewTitle": "表格预览",
  "terminal.close": "关闭终端面板",
  "terminal.closeTab": "关闭 {title}",
  "terminal.contextMenu.copy": "复制",
  "terminal.contextMenu.paste": "粘贴",
  "terminal.exited": "[进程已退出]",
  "terminal.hide": "收起终端",
  "terminal.new": "新建终端",
  "terminal.show": "打开终端",
  "terminal.title": "终端",
  "terminal.toggle": "切换终端",
};
Object.assign(messages, {
  "chat.empty.greeting.office": "今天有什么工作，交给我吧",
  "chat.empty.greeting.morningEarly": "早上好呀，新的一天开始啦",
  "chat.empty.greeting.morning": "上午好呀，有什么想让我帮忙的吗",
  "chat.empty.greeting.noon": "中午好呀，要不要先休息一下",
  "chat.empty.greeting.afternoon": "下午好呀，接下来交给我吧",
  "chat.empty.greeting.evening": "晚上好呀，今天辛苦啦",
  "chat.empty.greeting.lateNight": "夜深啦，别忘了照顾好自己哦",
  "taskList.newThread": "新聊天",
});
Object.assign(messages, {
  "settings.modelProvider.apiKeyPlaceholder": "输入 API Key",
  "settings.modelProvider.apiKey": "API Key",
  "settings.modelProvider.baseUrl": "Base URL",
  "settings.modelProvider.baseUrlPlaceholder": "https://api.example.com/v1",
  "settings.modelProvider.apiFormat": "API 格式",
  "settings.modelProvider.apiFormat.title.chatCompletions": "Chat Completions",
  "settings.modelProvider.apiFormat.title.responses": "Responses",
  "settings.navigation.back": "返回应用",
  "settings.navigation.searchPlaceholder": "搜索设置...",
  "settings.navigation.empty": "没有匹配的设置",
  "settings.navigation.personal": "个人",
  "settings.navigation.integrations": "集成",
  "settings.navigation.coding": "编码",
  "settings.general.title": "常规",
  "settings.appearance.title": "外观",
  "settings.shortcuts.title": "键盘快捷键",
  "settings.usage.title": "使用情况",
  "settings.plugins.title": "插件",
  "settings.models.title": "模型设置",
  "settings.permissions.title": "会话权限",
});

const enMessages: Record<string, string> = {
  "chat.message.expand": "Expand message",
  "chat.message.collapse": "Collapse message",
  "chat.composer.actionMenu": "Add context",
  "chat.composer.workspaceFileDragHint": "Release to reference file or directory",
  "common.loading": "Loading...",
  "settings.navigation.back": "Back to app",
  "settings.navigation.searchPlaceholder": "Search settings...",
  "settings.navigation.empty": "No matching settings",
  "settings.navigation.personal": "Personal",
  "settings.navigation.integrations": "Integrations",
  "settings.navigation.coding": "Coding",
  "settings.general.title": "General",
  "settings.appearance.title": "Appearance",
  "settings.shortcuts.title": "Keyboard shortcuts",
  "settings.usage.title": "Usage",
  "settings.plugins.title": "Plugins",
  "settings.models.title": "Configuration",
  "settings.permissions.title": "Permissions",
  "settings.modelProvider.apiKeyPlaceholder": "Enter API Key",
  "settings.modelProvider.apiKey": "API Key",
  "settings.modelProvider.baseUrl": "Base URL",
  "settings.modelProvider.baseUrlPlaceholder": "https://api.example.com/v1",
  "settings.modelProvider.apiFormat": "API Format",
};

const intl = {
  formatMessage({ id }: { id: string }, values: Record<string, unknown> = {}) {
    let text = messages[id] ?? enMessages[id] ?? id;
    for (const [key, value] of Object.entries(values))
      text = text.replaceAll(`{${key}}`, String(value));
    return text;
  },
};
export const useZCodeIntl = () => ({ intl, locale: "zh-CN" });
export { enMessages };
