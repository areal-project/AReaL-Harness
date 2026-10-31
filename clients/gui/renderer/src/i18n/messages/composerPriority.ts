export const composerPriorityMessages = {
  "chat.composer.favoriteSaveFailed": {
    "zh-CN": "无法保存收藏，请检查本机存储后重试。",
    en: "Could not save favorites. Check local storage and try again.",
  },
  "chat.composer.directoryDropUnavailable": {
    "zh-CN": "远程和浏览器环境无法读取本机目录，请使用当前工作区文件入口。",
    en: "Remote and browser sessions cannot read local folders. Use the current workspace files instead.",
  },
  "chat.composer.directoryDropSeparate": {
    "zh-CN": "请将目录与附件文件分开拖入。",
    en: "Drop folders separately from attachment files.",
  },
  "chat.composer.attachmentPending": { "zh-CN": "发送时准备附件", en: "Prepared when you send" },
  "chat.composer.attachmentReading": { "zh-CN": "正在准备附件…", en: "Preparing attachment…" },
  "chat.composer.attachmentUploading": { "zh-CN": "正在上传…", en: "Uploading…" },
  "chat.composer.attachmentReady": { "zh-CN": "附件已就绪", en: "Attachment ready" },
  "chat.composer.attachmentFailed": {
    "zh-CN": "附件准备失败",
    en: "Attachment preparation failed",
  },
  "chat.composer.retryAttachment": { "zh-CN": "重试此附件", en: "Retry attachment" },
  "chat.composer.pastedTextBody": {
    "zh-CN": "折叠的文本，发送时进入消息正文",
    en: "Collapsed text, sent in the message body",
  },

  "chat.composer.searchModels": {
    "zh-CN": "搜索所有供应商的模型",
    en: "Search models across providers",
  },
  "chat.composer.favoriteModels": { "zh-CN": "收藏的模型", en: "Favorites" },
  "chat.composer.favoriteModel": {
    "zh-CN": "收藏 {provider} 的 {model}",
    en: "Favorite {model} from {provider}",
  },
  "chat.composer.unfavoriteModel": {
    "zh-CN": "取消收藏 {provider} 的 {model}",
    en: "Unfavorite {model} from {provider}",
  },
  "chat.composer.noMatchingModels": { "zh-CN": "没有匹配的模型", en: "No matching models" },
} as const;
