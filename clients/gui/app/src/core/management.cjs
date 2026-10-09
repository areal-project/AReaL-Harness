'use strict';
const { manageTask, taskOperations } = require('./tasks.cjs');
const { workgroupArtifactFile } = require('./workgroup-artifacts.cjs');

const mutations = {
  providerSave: 'areal/provider/upsert', providerRemove: 'areal/provider/remove',
  mcpSave: 'areal/mcp/configure', mcpConnect: 'areal/mcp/connect', mcpDisconnect: 'areal/mcp/disconnect',
  archive: 'areal/thread/archive',
  processCloseStdin: 'areal/process/closeStdin', processStart: 'areal/process/start', processWrite: 'areal/process/write', processResize: 'areal/process/resize', processTerminate: 'areal/process/terminate',
  goalCreate: 'areal/goal/create', goalUpdate: 'areal/goal/update', goalPause: 'areal/goal/pause', goalResume: 'areal/goal/resume', goalClear: 'areal/goal/clear',
};
// Goal receipts belong to the owning Thread, unlike deployment management receipts.
const threadMutationMethods = new Set([...Object.values(mutations).filter(method => method.startsWith('areal/goal/')), 'areal/queue/steer']);
const managementMethods = new Set(['areal/blob/release', ...Object.values(mutations).filter(method => !method.startsWith('areal/process/') && !threadMutationMethods.has(method)), ...['update', 'remove', 'reorder', 'pause', 'resume'].map(name => `areal/queue/${name}`)]);
const fields = {
  providerSave: ['provider', 'expectedRevision'], providerRemove: ['id', 'expectedRevision'],
  mcpSave: ['id', 'expectedRevision', 'config'], mcpConnect: ['id', 'expectedRevision'], mcpDisconnect: ['id', 'expectedRevision'],
  archive: ['threadId'],
  processStart: ['threadId', 'lifetime', 'argv', 'cwd', 'tty', 'cols', 'rows', 'timeoutMs'],
  processCloseStdin: ['threadId', 'id'], processWrite: ['threadId', 'id', 'dataBase64'], processResize: ['threadId', 'id', 'cols', 'rows'], processTerminate: ['threadId', 'id'],
  goalCreate: ['threadId', 'expectedRevision', 'objective', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'inferLimits'],
  goalUpdate: ['threadId', 'expectedRevision', 'goalId', 'objective', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'inferLimits'],
  goalPause: ['threadId', 'expectedRevision', 'goalId'], goalResume: ['threadId', 'expectedRevision', 'goalId'], goalClear: ['threadId', 'expectedRevision', 'goalId'],
};
const reads = {
  providers: ['areal/provider/list', []], mcp: ['areal/mcp/list', []],
  profile: ['areal/profile/read', ['id', 'revision']], skills: ['areal/skill/list', ['threadId', 'agentProfile']],
  skill: ['areal/skill/read', ['threadId', 'agentProfile', 'skill', 'resource', 'offset', 'maxBytes']],
  inspect: ['areal/thread/inspect', ['threadId']], context: ['areal/context/read', ['threadId', 'offset', 'limit']],
  plan: ['areal/plan/read', ['threadId']], processes: ['areal/process/list', ['threadId']],
  process: ['areal/process/get', ['threadId', 'id']],
  processWait: ['areal/process/wait', ['threadId', 'id', 'timeoutMs']],
  goal: ['areal/goal/get', ['threadId']],
  permissions: ['areal/permissions/read', ['threadId']],
  interactions: ['areal/interaction/list', ['threadId']],
  processOutput: ['areal/process/read', ['threadId', 'id', 'after', 'maxBytes', 'waitMs']],
  agents: ['areal/agent/list', ['parentThreadId', 'cursor', 'limit']],
  agentWait: ['areal/agent/wait', ['parentThreadId', 'threadIds', 'timeoutMs']],
  workflows: ['areal/workflow/list', []], server: ['areal/server/status', []],
  workflow: ['areal/workflow/read', ['id', 'revision']],
  workgroupPolicy: ['areal/workgroup/policy', []], workgroups: ['areal/workgroup/list', []],
  workgroup: ['areal/workgroup/read', ['id']], workgroupWait: ['areal/workgroup/wait', ['id', 'afterRevision', 'timeoutMs']],
  workgroupArtifact: ['areal/workgroup/artifact', ['id', 'path', 'offset']],
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
async function manage(backend, project, request) {
  const { operation } = request;
  if (operation === 'serverDrain' || operation === 'serverGc') {
    // These Core methods have no receipt. Never use the receipt-based submission journal.
    try {
      return await project.client.request(operation === 'serverDrain' ? 'areal/server/drain' : 'areal/server/gc',
        operation === 'serverDrain' ? { strategy: 'ifIdle', timeoutMs: 30_000 } : {}, { timeoutMs: 35_000 });
    } catch (error) {
      if (typeof error.code !== 'number' || error.code === -32603) {
        error.submissionUnknown = true;
        error.message = `维护操作结果待核对，不会自动重发。${error.message}`;
      }
      throw error;
    }
  }
  if (operation === 'workgroupApplyArtifact' || operation === 'workgroupArtifactStatus') return workgroupArtifactFile(project, request, operation === 'workgroupApplyArtifact');
  if (operation === 'workgroupSubmission') {
    if (typeof request.requestId !== 'string' || !request.requestId) throw new Error('缺少原提交标识');
    const receipt = await backend.recoverWorkgroupSubmission(project, request.requestId);
    return receipt ? { confirmed: true, ...receipt } : { confirmed: false };
  }
  if (operation === 'workgroupCapabilities') return { enabled: project.client.capabilities?.methods?.includes('areal/workgroup/start') === true };
  if (['workgroupStart', 'workflowStart', 'workgroupRevise'].includes(operation)) {
    const definition = {
      workgroupStart: ['areal/workgroup/start', ['plan', 'workers', 'admission']],
      workflowStart: ['areal/workflow/start', ['workflow', 'workers', 'admission']],
      workgroupRevise: ['areal/workgroup/revise', ['id', 'expectedRevision', 'plan']],
    }[operation];
    const value = await backend.submit(project, definition[0], pick(request, definition[1]), { requestId: request.requestId });
    return { id: value.id, record: value.record, historyCount: value.historyCount, verificationCount: value.verificationCount };
  }
  // Cancel has no requestId. Core owns cancellation and cleanup; never replay it.
  if (operation === 'workgroupCancel') {
    const value = await project.client.request('areal/workgroup/cancel', pick(request, ['id']));
    return { id: value.id, record: value.record, historyCount: value.historyCount, verificationCount: value.verificationCount };
  }
  if (taskOperations.has(operation)) return manageTask(backend, project, request);
  if (operation === 'closeResources') {
    if (typeof request.threadId !== 'string' || !request.threadId) throw new Error('缺少资源所属会话');
    // Core owns the resource gate and may partially clean before refusing.
    // This method has no receipt: never enter the submission replay journal.
    try {
      return await project.client.request('areal/thread/closeResources', { threadId: request.threadId });
    } catch (error) {
      if (typeof error.code !== 'number' || error.code === -32603) error.submissionUnknown = true;
      throw error;
    }
  }
  if (operation === 'processSubmission') {
    if (typeof request.threadId !== 'string' || !request.threadId || typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.requestId)) throw new Error('缺少原终端请求标识或任务');
    const result = await backend.recoverProcessSubmission(project, request.threadId, request.requestId);
    return result ? { confirmed: true, result } : { confirmed: false };
  }
  if (operation === 'agentSubmission') {
    if (typeof request.parentThreadId !== 'string' || !request.parentThreadId || typeof request.requestId !== 'string' || !request.requestId) throw new Error('缺少原创建请求标识或父任务');
    const receipt = await backend.recoverAgentSubmission(project, request.parentThreadId, request.requestId);
    return receipt ? { confirmed: true, ...receipt } : { confirmed: false };
  }
  if (operation === 'agentSpawn') {
    if (typeof request.parentThreadId !== 'string' || !request.parentThreadId) throw new Error('缺少父任务');
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('请输入子任务指令');
    const result = await backend.submit(project, 'areal/agent/spawn', {
      // threadId belongs only to the desktop submission journal. Core has no
      // public spawn receipt; requestSubmission strips both journal fields.
      threadId: request.parentThreadId, parentThreadId: request.parentThreadId,
      input: [{ type: 'text', text: request.prompt }], workspaceMode: 'sharedReadOnly',
      ...pick(request, ['agentProfile', 'model', 'instructions', 'skills', 'toolAllowlist']),
    }, { requestId: request.requestId });
    try {
      await backend.openThread(project, result.threadId);
      await backend.listThreads(project);
    } catch (error) { project.error = `子任务已创建，刷新失败：${error.message}`; }
    backend.onChange();
    return result;
  }
  if (reads[operation]) {
    const [method, keys] = reads[operation];
    const result = await project.client.request(method, pick(request, keys));
    if (operation === 'goal') project.model.setGoal(request.threadId, result);
    if (operation === 'plan') project.model.setPlan(request.threadId, result);
    if (operation === 'interactions') project.model.setInteractions(request.threadId, result);
    if (operation === 'workgroup' || operation === 'workgroupWait') return { id: result.id, record: result.record, historyCount: result.historyCount, verificationCount: result.verificationCount };
    return result;
  }
  if (operation === 'planUpdate') {
    // Plan updates use optimistic revisions, not request receipts. Never replay.
    try {
      const result = await project.client.request('areal/plan/update', pick(request, ['threadId', 'expectedRevision', 'steps']));
      project.model.setPlan(request.threadId, result);
      return result;
    } catch (error) {
      const current = await project.client.request('areal/plan/read', { threadId: request.threadId }).catch(() => null);
      if (current) project.model.setPlan(request.threadId, current);
      throw error;
    }
  }
  if (operation === 'toolAcknowledge') {
    if (typeof request.threadId !== 'string' || !request.threadId || typeof request.itemId !== 'string' || !request.itemId) throw new Error('缺少原会话或执行项');
    if (typeof request.inspection !== 'string' || !request.inspection.trim() || Buffer.byteLength(request.inspection, 'utf8') > 1024) throw new Error('核查说明应包含 1–1024 个 UTF-8 字节');
    const refresh = async () => {
      await project.client.request('thread/read', { threadId: request.threadId, includeTurns: true }, {
        onResult: result => project.model.replace(result.thread),
      });
      backend.onChange();
    };
    // This public method has no request receipt. Never send it through the
    // mutation replay journal or confuse it with process cleanup acknowledgement.
    try {
      await project.client.request('areal/tool/acknowledge', pick(request, ['threadId', 'itemId', 'inspection']));
    } catch (error) {
      await refresh().catch(() => {});
      throw error;
    }
    await refresh();
    return {};
  }
  if (operation === 'contextCompact') return project.client.request('areal/context/compact', pick(request, ['threadId']));
  // Scope-wide forgetting has no request receipt and must never be replayed.
  if (operation === 'permissionsForget') {
    if (typeof request.project !== 'boolean') throw new Error('请选择撤销授权的作用域');
    return project.client.request('areal/permissions/forget', pick(request, ['threadId', 'project']));
  }
  if (operation === 'providerProbe') return project.client.request('areal/provider/probe', pick(request, ['id', 'model']));
  const method = mutations[operation];
  if (!method) throw new Error('不支持的管理操作');
  if (threadMutationMethods.has(method)) {
    if (typeof request.threadId !== 'string' || !request.threadId || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('目标缺少有效的会话或版本，请刷新后重试');
    if (operation !== 'goalCreate' && (typeof request.goalId !== 'string' || !request.goalId)) throw new Error('缺少目标 ID');
    if (operation === 'goalCreate' || request.objective !== undefined) {
      if (typeof request.objective !== 'string' || !request.objective.trim() || [...request.objective].length > 4000) throw new Error('目标应包含 1–4000 个字符');
    }
    if (request.inferLimits !== undefined && typeof request.inferLimits !== 'boolean') throw new Error('目标限制解析标识无效');
    for (const key of ['tokenBudget', 'maxTurns', 'maxActiveSeconds']) {
      if (request[key] !== undefined && request[key] !== null && (!Number.isSafeInteger(request[key]) || request[key] <= 0)) throw new Error('目标预算必须为正整数');
    }
  }
  let result;
  try {
    if (operation === 'goalCreate' || operation === 'goalResume') await backend.providers.refreshGoalTransport(project, request.threadId);
    result = await backend.submit(project, method, pick(request, fields[operation]), operation === 'processStart' ? { requestId: request.requestId } : {});
  }
  catch (error) {
    if (threadMutationMethods.has(method)) {
      // Refresh a conflict/unknown result, never retry the mutation with a new revision.
      const state = await project.client.request('areal/goal/get', { threadId: request.threadId }).catch(() => null);
      if (state) project.model.setGoal(request.threadId, state);
    }
    throw error;
  }
  if (threadMutationMethods.has(method)) project.model.setGoal(request.threadId, result);
  try {
  if (operation.startsWith('provider')) {
    const models = await project.client.request('areal/model/list');
    project.models = models.data ?? [];
  }
  if (operation === 'archive') {
    const snapshot = await project.client.request('thread/read', { threadId: request.threadId, includeTurns: true });
    project.model.replace(snapshot.thread);
    await backend.listThreads(project);
  }
  } catch (error) { project.error = `操作已完成，刷新失败：${error.message}`; }
  backend.onChange();
  return result;
}
module.exports = { manage, managementMethods, threadMutationMethods };
