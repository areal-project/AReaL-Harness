'use strict';
const { createHash } = require('node:crypto');
const { realpath, stat } = require('node:fs/promises');
const { isAbsolute, relative, sep } = require('node:path');
const { messageInput } = require('./media.cjs');
const { resolveNewConversationModel } = require('@areal/workbench/model-selection');

const marker = 'AREAL_TASK_DRAFT_V1';
const operations = new Set(['taskDraftHistory', 'taskDraftStart', 'taskDraftRead', 'taskDraftSend', 'taskDraftConfirm']);
const hash = value => createHash('sha256').update(value).digest('hex');
// 创建按配置会话去重，编辑按配置轮次去重；执行身份始终取自宿主保存的目标。
const key = (threadId, purpose) => {
  const hex = hash(`${marker}:${threadId}:${purpose}`);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
const instructions = (zone, editing = false) => `You help the user ${editing ? 'edit the selected scheduled task' : 'configure a task'}. Do not execute its objective or claim it is saved. Return exactly one JSON object in the user's language.
If the objective or execution time is missing, return {"kind":"question","message":"one concise question"}.
A complete proposal is {"kind":"proposal","message":"...","objective":"execution instructions","scheduleV2":{"version":1,"rule":RULE,"misfire":{"kind":"skip","maxLatenessSeconds":300},"overlap":"skip"},"interactionMode":"interactive"}.
RULE is one of {"kind":"onceLocal","timeZone":"${zone}","localTime":"HH:mm","date":{"kind":"date","date":"YYYY-MM-DD"}}, {"kind":"intervalLocal","timeZone":"${zone}","localTime":"HH:mm","date":{"kind":"next"},"intervalSeconds":3600}, or {"kind":"calendar","timeZone":"${zone}","frequency":"daily|weekly|monthly","interval":1,"localTime":"HH:mm","anchorDate":"YYYY-MM-DD","weekdays":[1,2,3,4,5]}.
Use Core current civil context below. For onceLocal/intervalLocal, date may be {"kind":"relative","days":0} for today, days:1 for tomorrow, or {"kind":"next"} for the next occurrence. Never calculate Unix seconds. Calendar anchorDate may be omitted to start today. Daily has no selectors, weekly requires ISO weekdays 1=Monday to 7=Sunday, monthly requires monthDays:[1..31 or "last"] and no weekdays. Missing dates and nonexistent DST times are skipped; repeated DST times run only once at the earlier instant. Weekdays mean calendar weekly [1,2,3,4,5], monthly/month-end means monthly; never approximate these as seconds. Every24hours is an interval; daily at a local time is calendar. Preserve stated start-date requirements across clarification turns. A date in objective content is not a start date. Default misfire skips after 300 seconds; each run opens a new desktop conversation. No cloud or condition triggers.
Only explicit user limits may add limits:{tokenBudget,maxTurns,maxActiveSeconds} and limitSources with exact user quotes. Never invent budgets. A complete proposal is saved automatically without another confirmation. ${editing ? 'EDIT MODE: Return only changed objective and/or scheduleV2. Preserve unchanged frequency, selectors and time zone. For pause/resume/cancel use {kind:"control",action,message}. Cancel preserves history. Immediate execution uses the saved Task button 立即运行. Budgets, permissions and project binding cannot be changed here.' : ''}`;

const targetPrefix = 'Current scheduled task: ';
function targetOf(thread, project) {
  const line = (project?.configurations?.[thread.id] ?? thread.desktop.configuration).options.appendInstructions.split('\n').find(value => value.startsWith(targetPrefix));
  return line ? JSON.parse(line.slice(targetPrefix.length)) : null;
}
const targetContext = task => ({ taskId: task.id, expectedRevision: task.revision, objective: task.objective,
  schedule: task.schedule, scheduleV2: task.scheduleV2, nextRunAt: task.nextRunAt, interactionMode: task.interactionMode, paused: task.paused });

function text(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new Error(`${label}需要 1–${max} 个字符`);
  return value.trim();
}
function timeZone(value) {
  text(value, '时区', 128);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new Error('时区无效，请重新打开创建入口'); }
  return value;
}
function scheduleIntent(value, zone, current, users) {
  let intent = value.scheduleV2;
  if (value.scheduleV2 && value.schedule) throw new Error('请只提供一份执行计划。');
  if (!intent && value.schedule) {
    const old = value.schedule;
    if (current?.scheduleV2?.rule.kind === 'calendar' && old.intervalSeconds === undefined) throw new Error('修改日历时刻需要完整日历计划，请重新描述安排。');
    if (Object.keys(old).some(field => !['at','intervalSeconds'].includes(field)) || typeof old.at !== 'string') throw new Error('模型返回的执行时间无效。');
    const interval = old.intervalSeconds === undefined ? current?.schedule?.intervalSeconds ?? (current?.scheduleV2?.rule.kind === 'interval' ? current.scheduleV2.rule.intervalSeconds : undefined) : old.intervalSeconds;
    const offset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(old.at);
    const civil = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(old.at);
    if (!offset && !civil) throw new Error('模型返回的时间缺少明确日期，请补充说明。');
    const rule = offset ? { kind: interval ? 'intervalIso' : 'onceIso', atIso: old.at } : { kind: interval ? 'intervalLocal' : 'onceLocal', timeZone: zone, localTime: old.at.slice(11,16), date: { kind:'date', date:old.at.slice(0,10) } };
    if (interval != null) rule.intervalSeconds = interval;
    intent = { version:1, rule };
  }
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('定时任务需要明确的执行时间。');
  const latest = users.findLast(message => /(工作日|周一至周五|周一到周五|每月|月末|月底|每天|每日|每周|每\s*\d+\s*(小时|天|周|分钟|秒)|一次性|仅一次)/.test(message)) ?? '';
  if (['interval','intervalLocal','intervalIso'].includes(intent.rule?.kind) && /(工作日|周一至周五|周一到周五|每月|月末|月底)/.test(latest)) throw new Error('工作日或每月安排不能换算成固定秒间隔，请补充说明日历安排。');
  return { ...intent, misfire:intent.misfire ?? {kind:'skip',maxLatenessSeconds:300}, overlap:intent.overlap ?? 'skip' };
}
async function taskDirectory(project, cwd = project.root) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw new Error('请选择项目根目录内的绝对工作目录');
  const [root, directory] = await Promise.all([realpath(project.root), realpath(cwd)]);
  const path = relative(root, directory);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('工作目录必须位于所选项目根目录内');
  if (!(await stat(directory)).isDirectory()) throw new Error('工作目录必须是现有文件夹');
  return directory;
}
const workspaceContext = (project, cwd) => `Workspace context: ${JSON.stringify({ projectRoot: project.root, cwd, projectless: project.projectless === true })}\n${project.projectless ? 'This is an independent task workspace. It is not associated with a normal saved project.' : 'This task belongs to the selected project.'} Each execution uses this exact working directory; projectRoot is the containment boundary, not a replacement cwd.`;
function proposal(value, userMessages, target) {
  if (target) {
    const binding = { taskId: target.taskId, expectedRevision: target.expectedRevision };
    if (value?.kind === 'control' && ['pause', 'resume', 'cancel'].includes(value.action)) return { ...binding, action: value.action };
    if (value?.kind !== 'proposal' || Object.keys(value).some(field => !['kind','message','objective','schedule','scheduleV2','interactionMode','timeZone'].includes(field))) throw new Error('当前只能修改任务内容和时间，或暂停／恢复／取消任务。');
    if (value.interactionMode !== undefined && value.interactionMode !== target.interactionMode) throw new Error('此次修改不能改变任务权限或提问策略。');
    const patch = { ...binding };
    if (value.objective !== undefined) patch.objective = text(value.objective, '任务目标');
    if (value.schedule !== undefined || value.scheduleV2 !== undefined) {
      patch.scheduleV2 = scheduleIntent(value, value.timeZone, target, userMessages);
    }
    if (patch.objective === undefined && patch.scheduleV2 === undefined) throw new Error('没有可保存的修改，请说明要调整的内容。');
    return patch;
  }
  if (!value || value.kind !== 'proposal') throw new Error('模型没有返回可确认的安排，请补充说明后重试。');
  const objective = text(value.objective, '任务目标');
  const scheduleV2 = scheduleIntent(value, value.timeZone, null, userMessages);
  const limits = value.limits ?? {};
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('模型返回的停止条件无效。');
  const allowed = ['tokenBudget', 'maxTurns', 'maxActiveSeconds'];
  if (Object.keys(limits).some(field => !allowed.includes(field))) throw new Error('模型返回了不支持的停止条件。');
  for (const [field, limit] of Object.entries(limits)) {
    const quote = value.limitSources?.[field];
    if (!Number.isSafeInteger(limit) || limit <= 0 || typeof quote !== 'string' || !quote.trim()
      || !userMessages.some(message => message.includes(quote))) throw new Error('停止条件缺少你的明确说明，请补充后重新生成。');
  }
  return { mode: 'scheduled', objective, interactionMode: 'interactive',
    scheduleV2, ...limits };
}
function parseReply(raw) {
  try { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')); }
  catch { throw new Error('模型未返回有效的任务安排，请补充说明后重试。'); }
}
const isTaskDraftConfiguration = configuration => configuration?.options?.appendInstructions?.startsWith(`${marker}\n`) === true;
async function inspect(project, threadId) {
  text(threadId, '配置会话', 128);
  const { thread } = await project.client.request('thread/read', { threadId, includeTurns: true });
  const options = thread?.desktop?.configuration?.options;
  if (!isTaskDraftConfiguration(thread?.desktop?.configuration) || options.readOnly !== true
    || !Array.isArray(options.toolAllowlist) || options.toolAllowlist.length !== 0) throw new Error('这不是有效的任务配置会话，请重新创建。');
  return thread;
}
const userText = turn => turn.items.filter(item => item.type === 'userMessage')
  .flatMap(item => item.content.filter(c => c.type === 'text').map(c => c.text)).join('\n');
function receiptFor(project, threadId, turnId) {
  return Object.values(project.outcomes ?? {}).find(value => value.accepted === true
    && value.draftThreadId === threadId && value.turnId === turnId && value.taskId);
}
function savedMessage(method, task, fallbackZone) {
  const status = ({ 'areal/task/create': '已创建任务。', 'areal/task/update': '已保存修改。',
    'areal/task/pause': '已暂停任务。', 'areal/task/resume': '已恢复任务。', 'areal/task/cancel': '已取消任务。' })[method] ?? '已保存安排。';
  const schedule = task.scheduleV2?.rule ?? task.schedule;
  if (!schedule) return `${status}\n任务目标：${task.objective}`;
  if (schedule.kind === 'calendar') return `${status}\n任务目标：${task.objective}\n频率：${({daily:'每天',weekly:'每周',monthly:'每月'})[schedule.frequency]} ${schedule.localTime} · ${schedule.timeZone}\n${task.scheduleV2.misfire.kind === 'skip' ? `错过 ${task.scheduleV2.misfire.maxLatenessSeconds} 秒后跳过` : '错过时合并执行一次'}`;
  const interval = schedule.intervalSeconds;
  const frequency = !interval ? '一次性' : interval === 86400 ? '每天' : interval % 86400 === 0 ? `每 ${interval / 86400} 天`
    : interval % 3600 === 0 ? `每 ${interval / 3600} 小时` : interval % 60 === 0 ? `每 ${interval / 60} 分钟` : `每 ${interval} 秒`;
  const at = new Date((task.nextRunAt ?? schedule.at ?? schedule.anchorAt) * 1000);
  const zone = schedule.timeZone ?? fallbackZone;
  let when;
  try { when = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(at); }
  catch { when = at.toLocaleString('zh-CN', { timeZone: 'UTC' }); }
  return `${status}\n任务目标：${task.objective}\n执行时间：${when}\n频率：${frequency}`;
}
function turnProjection(thread, turn, project, users, target, zone) {
  if (turn.status === 'inProgress') return { message: null, proposal: null, error: '' };
  const receipt = receiptFor(project, thread.id, turn.id);
  if (receipt) return { message: receipt.taskDraftMessage ?? (receipt.method === 'areal/task/create' ? '已创建任务。' : '已保存修改。'), proposal: null, error: '' };
  try {
    if (turn.status !== 'completed') throw new Error('模型未完成这次安排。你的描述已保留，可以补充说明后重试。');
    const raw = turn.items.filter(item => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text;
    const answer = parseReply(raw ?? '');
    if (!['question','proposal', ...(target ? ['control'] : [])].includes(answer.kind)) throw new Error('模型返回的安排格式无效，请重新描述。');
    if (answer.kind === 'question') return { message: text(answer.message, '模型回复'), proposal: null, error: '' };
    const result = proposal({ ...answer, timeZone: zone }, users, target);
    const failure = project.outcomes?.[key(thread.id, `failed:${turn.id}`)];
    return { message: failure?.taskDraftMessage ?? (turn === thread.turns.at(-1) ? '正在保存安排。' : '此安排未保存。'), proposal: result, error: failure?.taskDraftError ?? '' };
  } catch (cause) { return { message: `这次安排未保存。${cause.message}`, proposal: null, error: cause.message }; }
}
function view(thread, project) {
  const turns = thread.turns ?? [], last = turns.at(-1), messages = [];
  const target = targetOf(thread, project), users = [];
  const zone = (project.configurations?.[thread.id] ?? thread.desktop.configuration).options.appendInstructions.split('\n')[1].slice('Time zone: '.length);
  let result = null, error = '';
  const projections = new Map();
  for (const turn of turns) {
    const user = userText(turn); users.push(user);
    if (user) messages.push({ id: `${turn.id}:user`, role: 'user', text: user });
    const projection = turnProjection(thread, turn, project, users, target, zone);
    projections.set(turn.id, projection);
    if (projection.message) messages.push({ id: `${turn.id}:assistant`, role: 'assistant', text: projection.message });
    if (turn === last) { result = projection.proposal; error = projection.error; }
  }
  return { threadId: thread.id, turnId: last?.id ?? null, running: last?.status === 'inProgress', messages,
    proposal: result, digest: result ? hash(JSON.stringify(result)) : null, error, timeZone: zone, projections };
}
// Only the display projection is decoded; the saved Core transcript remains intact.
function displayThread(thread, project) {
  const { projections } = view(thread, project);
  return { ...thread, turns: (thread.turns ?? []).map(turn => {
    const last = turn.items.filter(item => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1);
    return { ...turn, items: turn.items.flatMap(item => {
      if (item.type !== 'agentMessage') return [item];
      const message = projections.get(turn.id)?.message;
      return item === last && message ? [{ ...item, text: message }] : [];
    }) };
  }) };
}
async function serial(project, id, work) {
  project.taskDraftWrites ??= new Map();
  const previous = project.taskDraftWrites.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  project.taskDraftWrites.set(id, next);
  try { return await next; }
  finally { if (project.taskDraftWrites.get(id) === next) project.taskDraftWrites.delete(id); }
}
async function committed(project, threadId, turnId) {
  const receipt = receiptFor(project, threadId, turnId);
  return receipt ? project.client.request('areal/task/read', { taskId: receipt.taskId }) : null;
}

async function manageTaskDraft(backend, project, request) {
  const { operation, threadId } = request;
  if (operation === 'taskDraftStart') {
    if (typeof request.draftId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.draftId)) throw new Error('缺少配置草稿标识');
    const zone = timeZone(request.timeZone);
    return serial(project, request.draftId, async () => {
      const task = request.taskId ? await project.client.request('areal/task/read', {taskId:text(request.taskId,'任务',128)}) : null;
      if (task && task.mode !== 'scheduled') throw new Error('只有定时任务具有管理会话。');
      if (task && !project.client.capabilities.methods.includes('areal/task/update')) throw new Error('当前 Core 尚不支持修改计划，请更新本机 Core 后重试。');
      const receipts = Object.values(project.outcomes ?? {}).filter(value => value.accepted === true
        && value.taskId === task?.id && value.draftThreadId);
      // Reuse the original management conversation, including older edit history.
      const original = task && (receipts.find(value => value.method === 'areal/task/create') ?? receipts.at(-1));
      if (original) {
        const thread = await inspect(project, original.draftThreadId);
        if (!targetOf(thread)) {
          if (thread.turns.some(turn => turn.status === 'inProgress')) throw new Error('正在整理任务，请等待回复完成。');
          await backend.configureThread(project, thread.id, { options: { readOnly: true, toolAllowlist: [],
            maxModelRounds: 1, systemPrompt: instructions(zone, true),
            appendInstructions: `${marker}\nTime zone: ${zone}\n${workspaceContext(project, thread.cwd)}\n${targetPrefix}${JSON.stringify(targetContext(task))}` } });
        }
        await backend.refreshAfterAdmission(project, thread.id);
        return { threadId: thread.id, requestId: request.draftId };
      }
      if (task?.cancelled) throw new Error('此任务已取消，且没有可恢复的管理会话。');
      const anchor = task ? (await project.client.request('thread/read', { threadId: task.threadId, includeTurns: false })).thread : null;
      const cwd = await taskDirectory(project, anchor?.cwd ?? request.cwd);
      let started = project.outcomes?.[request.draftId];
      if (!started?.accepted || !started.threadId) {
        const receipts = await project.client.request('areal/request/read', { requestId: request.draftId });
        const receipt = receipts.data.find(value => value.method === 'areal/thread/start' && (value.threadId || value.result?.thread?.id));
        if (receipt) started = { accepted: true, threadId: receipt.threadId ?? receipt.result.thread.id };
      }
      let thread, modelNotice;
      if (started?.accepted && started.threadId) {
        ({ thread } = await project.client.request('thread/read', { threadId: started.threadId, includeTurns: true }));
        if (await taskDirectory(project, thread.cwd) !== cwd) throw new Error('配置草稿已绑定其他工作目录，请恢复原目录或创建新草稿');
      } else {
        if (project.pending.some(entry => entry.params.requestId === request.draftId)) throw Object.assign(new Error('原配置会话创建结果尚未确认；不会重复创建。'), { submissionUnknown: true });
        await backend.resources.beforeCreate(project);
        const selection = resolveNewConversationModel(project.models, backend.providers.lastAcceptedModel);
        const model = selection.candidate;
        modelNotice = selection.notice;
        ({ thread } = await backend.submit(project, 'areal/thread/start', { cwd,
          ...(model?.providerId ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
          parameters: { ...model?.parameters, ...(selection.rememberedEffort != null ? { reasoningEffort: selection.rememberedEffort } : {}) },
        }, { requestId: request.draftId }));
      }
      try {
        await backend.changeOutcomes(project, outcomes => ({ ...outcomes, [request.draftId]: { accepted: true, method: 'areal/thread/start', threadId: thread.id } }));
      } catch { throw Object.assign(new Error('配置会话已创建，但本机确认记录未保存；请先核对。'), { submissionUnknown: true }); }
      if (!isTaskDraftConfiguration(thread.desktop?.configuration)) {
        // 此限制由 Core 配置强制执行，不能只依赖提示词要求模型不调用工具。
        await backend.configureThread(project, thread.id, { options: { readOnly: true, toolAllowlist: [],
          maxModelRounds: 1, systemPrompt: instructions(zone, !!task), appendInstructions: `${marker}\nTime zone: ${zone}\n${workspaceContext(project, cwd)}${task ? `\n${targetPrefix}${JSON.stringify(targetContext(task))}` : ''}` } });
      } else await inspect(project, thread.id);
      await backend.refreshAfterAdmission(project, thread.id);
      return { threadId: thread.id, requestId: request.draftId, ...(modelNotice ? { modelNotice } : {}) };
    });
  }
  if (operation === 'taskDraftHistory') {
    const taskId = text(request.taskId, '任务', 128);
    await project.client.request('areal/task/read', { taskId });
    // Creation receipts link immutable configuration history to the execution Task.
    // Older tasks without a receipt have no invented creation transcript.
    const receipt = Object.values(project.outcomes ?? {}).find(value => value.accepted === true
      && value.method === 'areal/task/create' && value.taskId === taskId && value.draftThreadId);
    if (!receipt) return { messages: [] };
    const history = view(await inspect(project, receipt.draftThreadId), project);
    return { threadId: history.threadId, messages: history.messages, timeZone: history.timeZone };
  }
  if (operation === 'taskDraftRead') {
    const thread = await inspect(project, threadId), task = await committed(project, threadId, thread.turns.at(-1)?.id);
    const { projections, ...draft } = view(thread, project);
    let preview;
    const schedule = task?.scheduleV2 ?? draft.proposal?.scheduleV2;
    if (schedule) {
      try { preview = await project.client.request('areal/task/schedule/preview', {schedule,count:5}); }
      catch (cause) { return {...draft,proposal:null,error:cause.message,thread:displayThread(thread,project)}; }
    }
    return { ...draft, preview, thread: displayThread(thread, project), ...(task ? { task, proposal:null, digest:null, error:'' } : {}) };
  }
  return serial(project, text(threadId, '配置会话', 128), async () => {
    const thread = await inspect(project, threadId), target = targetOf(thread);
    const task = await committed(project, threadId, thread.turns.at(-1)?.id);
    if (task) {
      if (operation === 'taskDraftConfirm') return task;
      if (!target) throw new Error('此安排已经创建，请从列表查看任务或开始新的安排。');
    }
    if (thread.turns.some(turn => turn.status === 'inProgress')) throw new Error('正在整理任务，请等待当前回复完成。');
    if (operation === 'taskDraftSend') {
      const input = messageInput(backend, request);
      if (!input.length) throw new Error('消息不能为空');
      const zone = timeZone(request.timeZone);
      const now = await project.client.request('areal/task/schedule/context', {timeZone:zone});
      const currentTask = target ? await project.client.request('areal/task/read', {taskId:target.taskId}) : null;
      if (currentTask?.cancelled) throw new Error('此任务已取消，不能继续修改。');
      await backend.configureThread(project, threadId, {
        ...(request.model !== undefined ? {model:request.model ? {providerId:request.model.providerId,modelId:request.model.modelId} : null} : {}),
        ...(request.effort ? {parameters:{reasoningEffort:request.effort}} : {}),
        options: { readOnly: true, toolAllowlist: [],
        maxModelRounds: 1, systemPrompt: instructions(zone, !!target),
        appendInstructions: `${marker}\nTime zone: ${zone}\n${workspaceContext(project, thread.cwd)}\nCore current civil time: ${now.localDate}T${now.localTime} in ${now.timeZone}. Use structured civil rules; Core resolves and saves the original intent.${currentTask ? `\n${targetPrefix}${JSON.stringify(targetContext(currentTask))}` : ''}`} });
      const result = await backend.submit(project, 'areal/turn/start', { threadId, input }, { requestId: request.requestId });
      return { threadId, turnId: result.turn?.id ?? result.turnId };
    }
    if (operation !== 'taskDraftConfirm') throw new Error('不支持的任务配置操作');
    const draft = view(thread, project);
    if (!draft.proposal || draft.turnId !== request.turnId || draft.digest !== request.digest) throw new Error(draft.error || '安排已经变化，请确认最新摘要。');
    try {
      if (target) {
        const currentTask = await project.client.request('areal/task/read', {taskId:target.taskId});
        if (currentTask.revision !== target.expectedRevision) throw new Error('任务已经变化，本次修改未保存。请重新发送修改要求，以最新安排为准。');
        const { action, ...patch } = draft.proposal;
        const method = action ? `areal/task/${action}` : 'areal/task/update';
        const requestId = key(threadId, `edit:${draft.turnId}`);
        if (!['pause','cancel'].includes(action)) await backend.scheduleAdmission.admitTask(project, target.taskId, action ?? 'update');
        const updated = await backend.submit(project, method, patch, {requestId});
        project.model.setTask(updated);
        try {
          await backend.changeOutcomes(project, outcomes => ({...outcomes, [requestId]: {
            method, accepted:true, draftThreadId:threadId, turnId:draft.turnId, taskId:updated.id, taskDraftMessage:savedMessage(method, updated, draft.timeZone),
          }}));
        } catch { throw Object.assign(new Error('修改已被受理，但本机确认记录未保存；请核对当前安排。'), {submissionUnknown:true}); }
        return updated;
      }
      // 任何未知提交仍由共享日志阻止重放；稳定键仅用于明确失败后的
      // 用户重试复用空执行会话，以及成功响应后的重复确认去重。
      if (project.pending.some(entry => entry.params.threadId === threadId
        || entry.params.requestId === key(threadId, 'execution') || entry.params.requestId === key(threadId, 'confirm'))) throw new Error('原提交结果尚未确认，请先核对任务列表；不会重复创建。');
      const values = {...draft.proposal};
      if (values.scheduleV2) await project.client.request('areal/task/schedule/preview', {schedule:values.scheduleV2,count:5});
      if (values.mode === 'scheduled') {
        await backend.scheduleAdmission.reserveDraft(project, threadId, thread.cwd, {executionRequestId:key(threadId,'execution'),taskRequestId:key(threadId,'confirm')});
        await backend.resources.beforeCreate(project);
        const execution = await backend.submit(project, 'areal/thread/start', { cwd: thread.cwd }, {requestId:key(threadId,'execution')});
        values.threadId = execution.thread.id;
        await backend.scheduleAdmission.setAnchor(project, values.threadId);
      }
      const created = await backend.submit(project, 'areal/task/create', values, {requestId:key(threadId,'confirm')});
      project.model.setTask(created);
      try {
        if (created.mode === 'scheduled') await backend.scheduleAdmission.bind(project, created);
        await backend.taskWorkspaceOwners?.observe(project, created);
        await backend.changeOutcomes(project, outcomes => ({...outcomes, [key(threadId,'confirm')]: {
          method:'areal/task/create', accepted:true, draftThreadId:threadId, turnId:draft.turnId, taskId:created.id, taskDraftMessage:savedMessage('areal/task/create', created, draft.timeZone),
        }}));
      } catch { throw Object.assign(new Error('任务已被受理，但本机确认记录未保存；请核对任务列表。'), {submissionUnknown:true}); }
      return created;
    } catch (error) {
      const message = error.submissionUnknown ? '保存结果尚未确认，请核对任务列表；不会重复保存。' : `这次安排未保存。${error.message}`;
      try {
        await backend.changeOutcomes(project, outcomes => ({ ...outcomes, [key(threadId, `failed:${draft.turnId}`)]: {
          accepted: false, draftThreadId: threadId, turnId: draft.turnId, taskDraftMessage: message, taskDraftError: error.message,
        } }));
      } catch {}
      throw error;
    }
  });
}
module.exports = { manageTaskDraft, taskDraftOperations: operations, isTaskDraftConfiguration, displayTaskDraftThread: displayThread };
