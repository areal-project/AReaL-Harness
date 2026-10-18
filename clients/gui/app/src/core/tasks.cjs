'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { manageTaskDraft, taskDraftOperations } = require('./task-draft.cjs');

const reads = {
  tasks: ['areal/task/list', ['after', 'limit']], task: ['areal/task/read', ['taskId']],
  taskInbox: ['areal/inbox/list', ['after', 'limit']],
  taskChannel: ['areal/channel/read', ['taskId', 'afterSequence', 'limit']],
};
const writes = {
  taskCreate: ['areal/task/create', ['mode', 'objective', 'threadId', 'interactionMode', 'schedule', 'tokenBudget', 'maxTurns', 'maxActiveSeconds']],
  taskUpdate: ['areal/task/update', ['taskId', 'expectedRevision', 'objective', 'schedule']],
  taskPause: ['areal/task/pause', ['taskId', 'expectedRevision']],
  taskResume: ['areal/task/resume', ['taskId', 'expectedRevision']],
  taskCancel: ['areal/task/cancel', ['taskId', 'expectedRevision']],
  taskReply: ['areal/channel/reply', ['taskId', 'runId', 'questionId', 'answers']],
};
const taskMutationMethods = new Set(Object.values(writes).map(([method]) => method));
const taskOperations = new Set([...Object.keys(reads), ...Object.keys(writes), ...taskDraftOperations, 'taskWatch', 'taskUnwatch']);
const pick = (request, keys) => Object.fromEntries(keys.filter(key => request[key] !== undefined).map(key => [key, request[key]]));
const unknown = () => Object.assign(new Error('原任务提交结果尚未确认，请先核对任务列表；不会重复创建。'), { submissionUnknown: true });
const executionRequestId = requestId => {
  const hex = createHash('sha256').update(`AREAL_TASK_EXECUTION_V1:${requestId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
async function taskCreate(backend, project, request) {
  const requestId = request.requestId ?? randomUUID();
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('无效请求标识');
  project.taskCreateWrites ??= new Map();
  const previous = project.taskCreateWrites.get(requestId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (project.pending.some(entry => entry.params.requestId === requestId) || project.outcomes?.[requestId]) throw unknown();
    const params = pick(request, writes.taskCreate[1]);
    if (!params.threadId && ['background', 'scheduled'].includes(params.mode)) {
      const preludeId = executionRequestId(requestId);
      let receipt;
      try {
        const found = await project.client.request('areal/request/read', { requestId: preludeId });
        receipt = found.data.find(item => item.method === 'areal/thread/start' && typeof item.threadId === 'string');
      } catch { throw Object.assign(new Error('无法核对执行会话；不会重复创建。'), { submissionUnknown: true }); }
      const pending = project.pending.find(entry => entry.params.requestId === preludeId);
      if (receipt) {
        if (pending) {
          if (backend.awaitingResponses.has(pending)) throw unknown();
          await backend.changePending(project, entries => entries.filter(entry => entry !== pending));
        }
        params.threadId = receipt.threadId;
      } else {
        if (pending || project.outcomes?.[preludeId]) throw unknown();
        await backend.resources.beforeCreate(project);
        const model = backend.providers.value.defaultModel;
        const profile = project.resourceProfile ?? backend.defaultProfile;
        const { thread } = await backend.submit(project, 'areal/thread/start', { cwd: project.root,
          ...(model ? { model } : {}), ...(profile ? { agentProfile: profile } : {}) }, { requestId: preludeId });
        params.threadId = thread.id;
      }
    }
    const value = await backend.submit(project, 'areal/task/create', params, { requestId });
    project.model.setTask(value);
    return value;
  });
  project.taskCreateWrites.set(requestId, next);
  try { return await next; }
  finally { if (project.taskCreateWrites.get(requestId) === next) project.taskCreateWrites.delete(requestId); }
}

async function manageTask(backend, project, request) {
  const operation = request.operation;
  if (taskDraftOperations.has(operation)) return manageTaskDraft(backend, project, request);
  if (operation === 'taskWatch' || operation === 'taskUnwatch') {
    if (typeof request.viewId !== 'string' || !request.viewId || request.viewId.length > 128) throw new Error('缺少任务视图标识');
    // Shared desktop clients can display the same task. Serialize acquisition
    // and release so leaving one view never drops another view's subscription.
    const next = (project.taskViewWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const client = project.client;
      backend.requireConnection(project, client);
      project.taskViews ??= new Map();
      const previous = project.taskViews.get(request.viewId);
      let result;
      if (operation === 'taskWatch') {
        if (typeof request.taskId !== 'string' || !request.taskId) throw new Error('缺少任务 ID');
        result = await client.request('areal/task/subscribe', { taskId: request.taskId }, { onResult: task => {
          if (backend.currentConnection(project, client)) project.model.setTask(task);
        } });
        backend.requireConnection(project, client);
        project.taskViews.set(request.viewId, request.taskId);
      } else project.taskViews.delete(request.viewId);
      if (previous && previous !== (operation === 'taskWatch' ? request.taskId : null) && ![...project.taskViews.values()].includes(previous)) {
        await client.request('areal/task/unsubscribe', { taskId: previous });
        backend.requireConnection(project, client);
      }
      return result ?? { removed: true };
    });
    project.taskViewWrite = next;
    return next;
  }
  const definition = reads[operation] ?? writes[operation];
  const [method, fields] = definition;
  const params = pick(request, fields);
  if (reads[operation]) {
    const client = project.client;
    const value = await client.request(method, params);
    backend.requireConnection(project, client);
    if (operation === 'task') project.model.setTask(value);
    return value;
  }
  if (operation === 'taskCreate') return taskCreate(backend, project, request);
  const value = await backend.submit(project, method, params);
  // Core receipts identify the Run and reply message. Preserve the originating
  // question too, so a delayed Desktop response cannot settle its sibling.
  if (operation === 'taskReply') return { ...value, questionId: params.questionId };
  project.model.setTask(value);
  return value;
}
module.exports = { manageTask, taskOperations, taskMutationMethods };
