export const bugReportMessages = {
  "bugReport.title": {
    "zh-CN": "反馈问题",
    en: "Report a bug",
  },
  "bugReport.local": {
    "zh-CN": "提交后，描述、截图和所选诊断信息将发送至 PlayForge，供开发者处理；本机保留副本。",
    en: "Submitting sends your description, screenshots, and selected diagnostics to PlayForge for developers to review. A local copy is retained.",
  },
  "bugReport.description": {
    "zh-CN": "问题描述",
    en: "Description",
  },
  "bugReport.placeholder": {
    "zh-CN": "发生了什么？请描述复现步骤、实际结果和期望结果。",
    en: "What happened? Include steps to reproduce, actual behavior, and expected behavior.",
  },
  "bugReport.screenshots": {
    "zh-CN": "截图",
    en: "Screenshots",
  },
  "bugReport.add": {
    "zh-CN": "添加截图",
    en: "Add screenshots",
  },
  "bugReport.imageHint": {
    "zh-CN":
      "支持粘贴、拖放或选择 PNG / JPEG / WebP，最多 5 张。每张转为 PNG 后不超过 2 MiB，尺寸不超过 4096 × 4096。",
    en: "Paste, drop, or choose PNG / JPEG / WebP images. Up to 5 images, each up to 2 MiB as PNG and 4096 × 4096 pixels.",
  },
  "bugReport.privacy": {
    "zh-CN":
      "请检查描述和截图中的隐私信息。图片像素和手动输入的文字不会自动脱敏；图片元数据会被移除。",
    en: "Review your description and screenshots for private information. Image pixels and your text are not automatically redacted; image metadata is removed.",
  },
  "bugReport.diagnostics": {
    "zh-CN": "附带诊断上下文",
    en: "Include diagnostic context",
  },
  "bugReport.diagnosticHint": {
    "zh-CN":
      "从当前本机保留记录采集运行版本、进程状态、连接事件、操作耗时和模型请求结果分类，可能涉及多个工作区。不含聊天正文、代码、凭据、原始路径、供应商地址或模型名称。",
    en: "Uses retained local records, potentially across workspaces: runtime versions, process state, connection events, operation timing, and model request outcome categories. Excludes chat text, code, credentials, raw paths, provider addresses, and model names.",
  },
  "bugReport.preview": {
    "zh-CN": "查看将附带的诊断内容",
    en: "Inspect the diagnostic attachment",
  },
  "bugReport.save": {
    "zh-CN": "保存到本机",
    en: "Save locally",
  },
  "bugReport.saved": {
    "zh-CN": "已保存到本机，尚未发送。可检查内容后提交或导出。",
    en: "Saved locally, not sent. Review the contents before submitting or exporting.",
  },
  "bugReport.history": {
    "zh-CN": "本机反馈",
    en: "Local reports",
  },
  "bugReport.back": {
    "zh-CN": "返回填写",
    en: "Back to form",
  },
  "bugReport.new": {
    "zh-CN": "新建反馈",
    en: "New report",
  },
  "bugReport.empty": {
    "zh-CN": "暂无本机反馈",
    en: "No local reports yet",
  },
  "bugReport.export": {
    "zh-CN": "导出反馈包",
    en: "Export report",
  },
  "bugReport.exported": {
    "zh-CN": "反馈包已导出；导出不会提交反馈。",
    en: "Report exported. Exporting does not submit a report.",
  },
  "bugReport.submit": {
    "zh-CN": "提交反馈",
    en: "Submit report",
  },
  "bugReport.submitted": {
    "zh-CN": "已提交，反馈编号：{id}",
    en: "Submitted. Report ID: {id}",
  },
  "bugReport.uploadTooLarge": {
    "zh-CN": "反馈超过 15 MiB 上报限制，已保留在本机。可导出反馈包，或减少附件后新建反馈。",
    en: "The report exceeds the 15 MiB upload limit and remains on this device. Export it, or create a new report with fewer attachments.",
  },
  "bugReport.uploadUnconfirmed": {
    "zh-CN": "未确认提交结果，本机反馈已保留。可再次提交同一条反馈，服务端会按反馈编号去重。",
    en: "Submission was not confirmed. Your local copy is retained. Resubmit the same report; the server deduplicates by report ID.",
  },
  "bugReport.delete": {
    "zh-CN": "删除本机反馈",
    en: "Delete local report",
  },
  "bugReport.deleteConfirm": {
    "zh-CN": "确认删除",
    en: "Confirm deletion",
  },
  "bugReport.cancel": {
    "zh-CN": "取消",
    en: "Cancel",
  },
  "bugReport.close": {
    "zh-CN": "关闭",
    en: "Close",
  },
  "bugReport.remove": {
    "zh-CN": "移除截图 {number}",
    en: "Remove screenshot {number}",
  },
  "bugReport.imageAlt": {
    "zh-CN": "反馈截图 {number}",
    en: "Report screenshot {number}",
  },
  "bugReport.view": {
    "zh-CN": "查看反馈",
    en: "View report",
  },
  "bugReport.busy": {
    "zh-CN": "处理中…",
    en: "Working…",
  },
  "bugReport.error": {
    "zh-CN": "操作未完成，请重试或在本机反馈中核对记录。",
    en: "Could not complete the operation. Retry or check Local reports.",
  },
  "bugReport.imageError": {
    "zh-CN": "截图格式、尺寸、大小或数量超出限制。请检查后重试。",
    en: "The image format, dimensions, size, or count exceeds the limit. Please check and retry.",
  },
  "bugReport.capacity": {
    "zh-CN": "最多保存 20 条本机反馈，请先导出或删除旧反馈。",
    en: "Up to 20 reports can be saved. Export or delete an older report first.",
  },
  "bugReport.expired": {
    "zh-CN": "诊断预览已过期，请关闭再重新勾选诊断上下文。",
    en: "Diagnostic preview expired. Turn diagnostic context off and on to refresh it.",
  },
  "bugReport.deleteHint": {
    "zh-CN": "删除仅移除本机记录；已导出的副本需自行删除。",
    en: "Deletion removes the local record only. Delete any exported copies separately.",
  },
  "bugReport.noDiagnostics": {
    "zh-CN": "未附带诊断上下文",
    en: "No diagnostic context attached",
  },
  "bugReport.summary": {
    "zh-CN": "{count} 张截图 · {diagnostics}",
    en: "{count} screenshots · {diagnostics}",
  },
  "bugReport.included": {
    "zh-CN": "含诊断上下文",
    en: "Diagnostic context included",
  },
  "bugReport.exportLogs": {
    "zh-CN": "导出诊断日志",
    en: "Export diagnostics",
  },
} as const;
