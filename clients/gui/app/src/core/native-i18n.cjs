'use strict';

let locale = 'zh-CN';
const nativeMessages = {
  "common.cancel": { 'zh-CN': "取消", en: "Cancel" },
  "common.back": { 'zh-CN': "返回", en: "Back" },
  "common.quit": { 'zh-CN': "退出", en: "Quit" },
  "quit.question": { 'zh-CN': "退出 AReaL Harness？", en: "Quit AReaL Harness?" },
  "quit.interfaceDetail": { 'zh-CN': "退出将关闭当前应用界面。历史与草稿保留。", en: "Quitting closes the current application interface. History and drafts are retained." },
  "quit.backendDetail": { 'zh-CN': "退出后，应用后台将关闭。历史与草稿保留。", en: "Quitting stops the application backend. History and drafts are retained." },
  "quit.unavailableWarning": { 'zh-CN': "部分工作区的任务状态暂时无法读取，退出可能中断其中的工作。\n\n", en: "Task status is temporarily unavailable for some workspaces. Quitting may interrupt their work.\n\n" },
  "quit.activeDetail": { 'zh-CN': "正在运行的对话和任务将中断。应用关闭期间，定时任务不会运行，手机连接也将断开。", en: "Running conversations and tasks will be interrupted. Scheduled tasks will not run while the application is closed, and mobile connections will disconnect." },
  "lifecycle.preparing": { 'zh-CN': "界面仍在准备，请稍后退出", en: "The interface is still preparing. Please try quitting again shortly." },
  "lifecycle.foreignOwner": { 'zh-CN': "原后台属于其他应用会话，请先从其原入口安全退出，再重试安装", en: "The original backend belongs to another application session. Quit safely from its original interface before retrying installation." },
  "lifecycle.stopIncomplete": { 'zh-CN': "应用后台停止尚未完成，请检查原请求与阻塞事项。", en: "The application backend has not finished stopping. Check the original request and blockers." },
  "lifecycle.confirmationRequired": { 'zh-CN': "退出应用或取消后台任务需要原生确认", en: "Quitting the application or canceling background tasks requires native confirmation." },
  "lifecycle.cancelQuestion": { 'zh-CN': "确认取消后台任务？", en: "Cancel background tasks?" },
  "lifecycle.cancelImpact": { 'zh-CN': "将取消所列工作区后台的活动执行，并暂停目标。未完成的资源清理仍可能阻止退出。\n\n", en: "Active executions in the listed workspaces will be canceled and goals paused. Unfinished resource cleanup may still block quitting.\n\n" },
  "lifecycle.stopImpact": { 'zh-CN': "退出应用会停止定时安排触发并断开手机连接。安排定义、待发送输入和历史保留。\n", en: "Quitting stops scheduled triggers and disconnects mobile connections. Schedule definitions, pending inputs and history are retained.\n" },
  "lifecycle.cancelAndUpdate": { 'zh-CN': "取消任务并更新", en: "Cancel tasks and update" },
  "lifecycle.cancelAndStop": { 'zh-CN': "取消任务并停止", en: "Cancel tasks and stop" },
  "lifecycle.activeWork": { 'zh-CN': "仍有活动任务或操作，请检查后台状态", en: "Tasks or operations are still active. Check the backend status." },
  "lifecycle.installCanceled": { 'zh-CN': "应用退出已取消，更新尚未安装", en: "Application quit was canceled. The update has not been installed." },
  "diagnostics.exportTitle": { 'zh-CN': "导出诊断包", en: "Export diagnostics" },
  "diagnostics.saveFailed": { 'zh-CN': "诊断包保存失败，请选择其他位置后重试。", en: "Could not save diagnostics. Choose another location and try again." },
  "diagnostics.saveFailedTitle": { 'zh-CN': "诊断包保存失败", en: "Could not save diagnostics" },
  "diagnostics.retryLocation": { 'zh-CN': "请选择其他位置后重试。", en: "Choose another location and try again." },
  "boundary.untrustedSender": { 'zh-CN': "拒绝非主视图请求", en: "Requests from outside the main view are not allowed." },
  "boundary.quitting": { 'zh-CN': "应用正在退出或安装更新", en: "The application is quitting or installing an update." },
  "browser.frameTitle": { 'zh-CN': "授权当前页面的嵌入站点", en: "Authorize an embedded site for this page" },
  "browser.developmentTitle": { 'zh-CN': "允许本地开发站点", en: "Allow a local development site" },
  "browser.frameDetail": { 'zh-CN': "仅当前 Human 页面有效，不授权 Agent。确认后需明确重载，未保存的页面状态可能丢失。截图检查失败不生成图片；撤销、文档变化、关闭预览或切换页面将关闭此页面；标注时临时隐藏除外。", en: "Applies only to the current Human page and does not authorize the Agent. Explicitly reload after confirming; unsaved page state may be lost. No image is produced if screenshot checks fail. Revocation, document changes, closing the preview or switching pages closes this page, except when temporarily hidden for annotation." },
  "browser.developmentDetail": { 'zh-CN': "仅授权当前工作区访问此精确地址；关闭工作区或重启后需要重新授权。共享登录数据独立保留。", en: "Authorizes this exact address for the current workspace. Authorize again after closing the workspace or restarting. Shared login data is retained separately." },
  "browser.allowFrame": { 'zh-CN': "仅当前页面允许", en: "Allow for this page only" },
  "browser.allowWorkspace": { 'zh-CN': "仅此工作区允许", en: "Allow for this workspace only" },
  "browser.previewUnavailable": { 'zh-CN': "预览不可用", en: "Preview unavailable" },
  "browser.selectTask": { 'zh-CN': "请选择有效任务", en: "Select a valid task." },
  "browser.windowClosed": { 'zh-CN': "窗口已关闭，无法打开浏览页面", en: "The window is closed. A browser page cannot be opened." },
  "browser.claimExpired": { 'zh-CN': "浏览页面已换代，请重新认领", en: "The browser page has changed. Claim it again." },
  "recovery.attention": { 'zh-CN': "定时安排需要核对", en: "Scheduled arrangements need review" },
  "recovery.attentionDetail": { 'zh-CN': "\n\n可打开原任务核对安排。应用不会恢复已暂停的 Run 或自动重发未知操作。", en: "\n\nOpen the original task to review its arrangements. The application will not resume paused Runs or automatically resend operations with unknown outcomes." },
  "recovery.review": { 'zh-CN': "打开应用后核对", en: "Review in the application" },
  "gui.notBuilt": { 'zh-CN': "GUI 未构建，请先执行 make gui-build", en: "The GUI has not been built. Run make gui-build first." },
  "gui.unknownTheme": { 'zh-CN': "未知主题", en: "Unknown theme" },
  "gui.startupFailed": { 'zh-CN': "AReaL 启动失败", en: "AReaL failed to start" },
  "picker.project": { 'zh-CN': "打开项目", en: "Open project" },
  "picker.taskDirectory": { 'zh-CN': "选择工作目录", en: "Choose working directory" },
  "picker.projectlessDirectory": { 'zh-CN': "选择无项目任务文件夹", en: "Choose projectless task folder" },
  "picker.existingDirectory": { 'zh-CN': "请选择现有文件夹", en: "Select an existing folder." },
  "archive.question": { 'zh-CN': "归档此会话？", en: "Archive this conversation?" },
  "archive.detail": { 'zh-CN': "历史仍可查看。当前 Core 不支持取消归档，归档后无法继续发送消息；该会话的浏览页面将关闭，共享登录数据保留。", en: "History remains available. Core currently does not support unarchiving, so no further messages can be sent after archiving. Browser pages for this conversation close; shared login data is retained." },
  "archive.confirm": { 'zh-CN': "归档会话", en: "Archive conversation" },
  "export.selectConversation": { 'zh-CN': "请选择需要导出的会话", en: "Select a conversation to export." },
  "export.title": { 'zh-CN': "导出会话记录与执行轨迹", en: "Export conversation and execution trace" },
  "auth.unsupportedUrl": { 'zh-CN': "不支持的认证 URL", en: "Unsupported authentication URL" },
  "auth.openFailed": { 'zh-CN': "无法打开认证页面，请核对认证状态后重试", en: "Could not open the authentication page. Check authentication status and try again." },
  "auth.chatgptOpenFailed": { 'zh-CN': "无法打开浏览器，请重试 ChatGPT 登录", en: "Could not open the browser. Retry ChatGPT sign-in." },
  "browser.frameQuestion": { 'zh-CN': ({ origin }) => `允许当前页面嵌入 ${origin} 并在人工标注时检查其隐私？`, en: ({ origin }) => `Allow this page to embed ${origin} and inspect its privacy during human annotation?` },
  "browser.developmentQuestion": { 'zh-CN': ({ origin }) => `允许此浏览工作区访问 ${origin}？`, en: ({ origin }) => `Allow this browser workspace to access ${origin}?` },
  "lifecycle.mobileConnections": { 'zh-CN': ({ count }) => `手机入口已启用，当前连接 ${count}。\n`, en: ({ count }) => `Mobile access is enabled with ${count} current connections.\n` },
  "lifecycle.activeThread": { 'zh-CN': ({ value }) => `正在执行的会话：${value}`, en: ({ value }) => `Running conversation: ${value}` },
  "lifecycle.goal": { 'zh-CN': ({ value }) => `持续目标：${value}`, en: ({ value }) => `Ongoing goal: ${value}` },
  "lifecycle.task": { 'zh-CN': ({ value }) => `任务：${value}`, en: ({ value }) => `Task: ${value}` },
  "lifecycle.resource": { 'zh-CN': ({ value }) => `未清理资源：${value}`, en: ({ value }) => `Unreleased resource: ${value}` },
};

function setNativeLocale(value) {
  if (value === 'zh-CN' || value === 'en') locale = value;
}
function nativeText(id, values) {
  const message = nativeMessages[id][locale];
  return typeof message === 'function' ? message(values) : message;
}
module.exports = { setNativeLocale, nativeText, nativeMessages };
