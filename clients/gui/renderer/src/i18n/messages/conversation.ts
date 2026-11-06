// 对话流活动行与分段标题（CONV-ACTIVITY-01）。verb 与 state 的取值由 conversationPresentation.ts 产生。
export const conversationMessages = {
  "chat.composer.attachmentNeedsReattach": {
    "zh-CN": "文件尚未恢复，请重新添加",
    en: "File needs to be reattached",
  },
  "chat.composer.reattachFile": { "zh-CN": "重新添加", en: "Reattach" },
  "chat.composer.unrestoredAttachment": { "zh-CN": "未恢复的附件", en: "Unrestored attachment" },
  "chat.composer.missingAttachmentsBlockSend": {
    "zh-CN": "请重新添加或移除未恢复的附件后再发送。草稿已保留。",
    en: "Reattach or remove missing files before sending. Your draft has been kept.",
  },
  "chat.submission.starting": { "zh-CN": "正在启动聊天", en: "Starting your chat" },
  "chat.submission.sending": { "zh-CN": "正在发送消息", en: "Sending your message" },
  "chat.submission.context": { "zh-CN": "附加的上下文", en: "Attached context" },
  "chat.activity.action": {
    "zh-CN":
      "{tense, select, running {正在} done {已} other {}}{verb, select, read {读取} edit {编辑} create {创建} search {搜索} list {列出} command {运行} wait {等待} skillRead {读取技能} planRead {读取计划} readProcess {读取进程输出} terminateProcess {停止进程} browser {使用浏览器} agentSpawn {创建子智能体} agentWait {等待子智能体} image {查看图片} other {调用 {name}}}",
    en: "{tense, select, running {{verb, select, read {Reading} edit {Editing} create {Creating} search {Searching} list {Listing} command {Running} wait {Waiting} skillRead {Reading skill} planRead {Reading plan} readProcess {Reading process output} terminateProcess {Stopping process} browser {Using browser} agentSpawn {Creating subagent} agentWait {Waiting for subagent} image {Viewing image} other {Calling {name}}}} other {{verb, select, read {Read} edit {Edited} create {Created} search {Searched} list {Listed} command {Ran} wait {Waited} skillRead {Read skill} planRead {Read plan} readProcess {Read process output} terminateProcess {Stopped process} browser {Used browser} agentSpawn {Created subagent} agentWait {Waited for subagent} image {Viewed image} other {Called {name}}}}}",
  },
  "chat.activity.run.explore": {
    "zh-CN": "{tense, select, running {正在探索} other {已探索}}",
    en: "{tense, select, running {Exploring} other {Explored}}",
  },
  "chat.activity.run.commands": {
    "zh-CN": "{tense, select, running {正在运行命令} other {已运行命令}}",
    en: "{tense, select, running {Running commands} other {Ran commands}}",
  },
  "chat.activity.run.edits": {
    "zh-CN":
      "{tense, select, running {正在修改文件} other {{count, plural, =0 {已修改文件} other {已修改 # 个文件}}}}",
    en: "{tense, select, running {Editing files} other {{count, plural, =0 {Edited files} one {Edited # file} other {Edited # files}}}}",
  },
  "chat.activity.run.generic": {
    "zh-CN": "{tense, select, running {正在执行活动} other {已执行活动}}",
    en: "{tense, select, running {Working} other {Worked}}",
  },
  "chat.activity.run.withDetails": { "zh-CN": "{action} · {parts}", en: "{action} · {parts}" },
  "chat.activity.run.wait": {
    "zh-CN": "{tense, select, running {正在等待任务} other {已等待任务}}",
    en: "{tense, select, running {Waiting for tasks} other {Waited for tasks}}",
  },
  "chat.activity.part.failures": {
    "zh-CN": "{count} 个失败",
    en: "{count, plural, one {# failure} other {# failures}}",
  },
  "chat.activity.failedExit": { "zh-CN": "失败 · exit {code}", en: "Failed · exit {code}" },
  "chat.activity.part.separator": { "zh-CN": "，", en: ", " },
  "chat.activity.reasoning": { "zh-CN": "思考过程", en: "Thinking" },
  "chat.progress.working": { "zh-CN": "已工作 {duration}", en: "Working for {duration}" },
  "chat.progress.worked": { "zh-CN": "工作了 {duration}", en: "Worked for {duration}" },
  "chat.progress.awaiting": { "zh-CN": "等待你批准", en: "Waiting for your approval" },
  "chat.progress.duration": {
    "zh-CN": "{minutes, plural, =0 {} other {# 分 }}{seconds} 秒",
    en: "{minutes, plural, =0 {} other {#m }}{seconds}s",
  },
  "chat.activity.status": {
    "zh-CN":
      "{state, select, awaiting {等待你批准} running {执行中} failed {失败} unsettled {结果待确认} stopped {已停止} other {已完成}}",
    en: "{state, select, awaiting {Waiting for your approval} running {Running} failed {Failed} unsettled {Result unconfirmed} stopped {Stopped} other {Completed}}",
  },
  "chat.activity.stillRunning": { "zh-CN": "仍在运行", en: "Still running" },
  "chat.activity.turnFailed": { "zh-CN": "回合失败", en: "Turn failed" },
  "chat.activity.rawRecord": { "zh-CN": "查看工具原始记录", en: "View raw tool record" },
  "chat.activity.openFile": { "zh-CN": "打开 {path}", en: "Open {path}" },
  "chat.command.exitCode": { "zh-CN": "退出码 {code}", en: "exit code {code}" },
  "chat.composer.uploadFiles": { "zh-CN": "上传文件", en: "Upload files" },
  "chat.composer.uploadFilesDescription": {
    "zh-CN": "添加图片、文档或其他文件",
    en: "Add images, documents, or other files",
  },
  "chat.composer.mcpDescription": {
    "zh-CN": "查看服务器与连接状态",
    en: "View servers and connection status",
  },
  "chat.composer.planMode": { "zh-CN": "计划模式", en: "Plan mode" },
  "chat.composer.exitPlanMode": { "zh-CN": "退出计划模式", en: "Exit plan mode" },
  "chat.composer.planModeEnableDescription": {
    "zh-CN": "先规划，再开始执行",
    en: "Plan first before executing",
  },
  "chat.composer.planModeDisableDescription": {
    "zh-CN": "关闭计划模式",
    en: "Turn off plan mode",
  },
  "chat.composer.goalMode": { "zh-CN": "目标", en: "Goal" },
  "chat.composer.exitGoalMode": { "zh-CN": "退出目标模式", en: "Exit goal mode" },
  "chat.composer.setGoal": { "zh-CN": "设置目标", en: "Set goal" },
  "chat.composer.goalModeEnableDescription": {
    "zh-CN": "设置持续目标与停止条件",
    en: "Set an ongoing goal and stopping condition",
  },
  "chat.composer.goalModeDisableDescription": {
    "zh-CN": "关闭目标模式",
    en: "Turn off goal mode",
  },
  "chat.queue.sendNow": { "zh-CN": "立即发送", en: "Send now" },
  "chat.queue.sendNowItem": { "zh-CN": "立即发送 {item}", en: "Send now {item}" },
  "chat.queue.sendNowHint": {
    "zh-CN": "不等这一轮结束，现在就发给正在进行的任务",
    en: "Send to the running task without waiting for this turn to finish",
  },
  "chat.queue.pausedServerDraining": {
    "zh-CN": "队列已暂停；点击继续后才会执行待发消息。",
    en: "Queue paused; click Resume to run queued messages.",
  },
  "chat.queue.pausedByUser": {
    "zh-CN": "你已暂停队列。",
    en: "You paused the queue.",
  },
} as const;
