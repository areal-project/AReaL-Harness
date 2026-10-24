'use strict';

const labels = { activeTurn: '活动轮次', resource: '未清理终端', uninspectedUnknown: '未核查结果',
  compaction: '上下文压缩', workgroup: '未结算工作组', activeGoal: '活动目标', queuedMessage: '待发消息', activeTask: '活动任务' };
const unknown = () => ({ allowed: false, reasons: [{ code: 'unknown', count: 1 }] });
const recoveryReads = new Set(['server', 'inspect', 'context', 'plan', 'processes', 'process', 'processOutput', 'goal', 'task', 'tasks', 'interactions', 'executions', 'execution', 'inheritedHistory']);
const recoveryHistoryReads = new Set(['acquire', 'loadOlder', 'loadItem', 'release']);
const isRecoveryCommand = (name, request) => name === 'manage'
  && (recoveryReads.has(request?.operation) || request?.operation === 'toolAcknowledge')
  || name === 'history' && recoveryHistoryReads.has(request?.operation);
function decision(value) {
  if (typeof value?.allowed !== 'boolean' || !Array.isArray(value.reasons)
    || value.reasons.some(r => !Object.hasOwn(labels, r.code) || !Number.isSafeInteger(r.count) || r.count <= 0)
    || value.allowed !== (value.reasons.length === 0)) return unknown();
  return value;
}
function coreLifecycle(status) {
  if (status.lifecycle !== undefined) {
    if (status.lifecycle?.version !== 1 || !['open', 'draining', 'closed'].includes(status.lifecycle.admission))
      return { ifIdle: unknown(), settled: unknown(), admission: 'unknown' };
    return { ...status.lifecycle, ifIdle: decision(status.lifecycle.ifIdle), settled: decision(status.lifecycle.settled) };
  }
  // 已知 v1 Core 的旧字段；缺字段不能被当成空闲。
  const settled = status.restartSafe === true ? { allowed: true, reasons: [] } : unknown();
  if (typeof status.restartSafe !== 'boolean' || !Array.isArray(status.activeGoals)
    || !Number.isSafeInteger(status.pendingQueueItems) || status.pendingQueueItems < 0
    || !Number.isSafeInteger(status.activeTasks) || status.activeTasks < 0)
    return { ifIdle: unknown(), settled, admission: 'unknown' };
  const reasons = [...settled.reasons];
  for (const [code, count] of [['activeGoal', status.activeGoals.length], ['queuedMessage', status.pendingQueueItems], ['activeTask', status.activeTasks]])
    if (count > 0) reasons.push({ code, count });
  return { ifIdle: { allowed: reasons.length === 0, reasons }, settled,
    admission: status.draining === true ? 'draining' : status.closed === true ? 'closed' : 'open' };
}
function desktopBlockers(service, forUpdate = true) {
  return [forUpdate && service.clients > 1 && 'peerGui', service.activeCommands > 0 && 'inflight',
    service.providerUpdating && 'providerUpdating', service.starting > 0 && 'starting'].filter(Boolean);
}
const blockerMessage = blockers => blockers.map(code => ({ peerGui: '请先退出其他 GUI', inflight: '请等待已提交操作完成',
  providerUpdating: '请等待模型配置更新完成', starting: '请等待项目启动完成' })[code] ?? '请等待后台状态核对').join('；');
function recoveryView(service, projects, forUpdate = true) {
  const blockers = desktopBlockers(service, forUpdate);
  const unsafe = projects.some(p => p.observation === 'unavailable' || (p.lifecycle ? !p.lifecycle.ifIdle.allowed
    : !p.restartSafe || p.activeTasks || p.goalThreads?.length || p.waitingMessages))
    || projects.some(p => p.tasks?.some(task => !task.paused))
    || service.remote?.enabled === true || service.remote?.connections > 0;
  const legacyBusy = service.lifecycle?.version !== 2 && (service.busy || !!service.stopReport);
  return { blockers, ifIdle: !blockers.length && !unsafe && !legacyBusy,
    cancel: !blockers.length && (unsafe || legacyBusy), projects, service };
}
function targets(projects) {
  return projects.map(p => ({ projectId: p.projectId, serviceId: p.serviceId ?? null, generation: p.generation ?? null }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
}
function describe(projects) {
  return projects.flatMap(p => (p.lifecycle?.ifIdle.reasons ?? []).map(r => `${p.root ?? p.projectId}：${labels[r.code] ?? '状态待核查'} ${r.count}`)).join('\n');
}
function assertLifecycleSupport(service, kind) {
  const lifecycle = service?.lifecycle, capabilities = lifecycle?.capabilities;
  if (lifecycle?.version !== 2 || typeof lifecycle.desktopGeneration !== 'string'
    || capabilities?.request !== true || capabilities?.read !== true || capabilities?.reconcile !== true
    || Array.isArray(capabilities.kinds) && !capabilities.kinds.includes(kind)) {
    throw Object.assign(new Error('当前后台不支持可核查的生命周期操作。已有任务继续运行，请保留后台并检查原任务。'), { code: 'LIFECYCLE_UNSUPPORTED' });
  }
  return lifecycle;
}
class DesktopLifecycle {
  constructor({ connection, metadata, home, forUpdate = true, purpose = 'manage' }) {
    this.connection = connection; this.metadata = metadata; this.home = home; this.forUpdate = forUpdate; this.purpose = purpose;
  }
  async observe() {
    const projects = await this.connection.request('resources', { operation: 'inspect', includeTasks: true,
      ...(this.purpose === 'quit' ? { purpose: 'quit' } : {}) });
    const { service } = await this.connection.request('snapshot');
    return { ...recoveryView(service, projects, this.forUpdate), targets: targets(service.targets ?? projects), purpose: this.purpose };
  }
  async stop({ mode = 'ifIdle', observed } = {}) {
    const { SharedCoreBackend } = require('./service-client.cjs');
    const backend = new SharedCoreBackend({ app: { getPath: () => this.home }, home: this.home });
    backend.connection = this.connection; backend.metadata = this.metadata;
    backend.status = (observed ?? await this.observe()).service;
    backend.loadReferences(await backend.readControl());
    return backend.stopService(this.forUpdate, { cancel: mode === 'cancel', observed });
  }
  async prepare({ kind, mode = 'ifIdle', observed, projectId, threadId, turnId } = {}) {
    if (!['ifIdle', 'cancel'].includes(mode)) throw new Error('无效的停止意图');
    if (kind === 'interruptTurn') {
      const { service, snapshot } = await this.connection.request('snapshot');
      const capability = assertLifecycleSupport(service, kind);
      const thread = snapshot?.projects?.find(project => project.id === projectId)?.state?.threads?.[threadId];
      const executionProjectId = thread?.executionProjectId ?? projectId;
      const expectedTargets = targets(service.targets ?? []).filter(target => target.projectId === executionProjectId);
      if (expectedTargets.length !== 1 || thread?.executionCore?.instanceId && thread.executionCore.instanceId !== expectedTargets[0].serviceId)
        throw Object.assign(new Error('原项目后台身份不完整，请重新核查'), { code: 'CONFIRMATION_STALE' });
      return { kind, mode, expectedDesktopGeneration: capability.desktopGeneration, expectedTargets, threadId, turnId };
    }
    const before = observed ?? await this.observe();
    const capability = assertLifecycleSupport(before.service, kind);
    if (before.blockers.length) throw Object.assign(new Error(blockerMessage(before.blockers)), { code: 'LIFECYCLE_BLOCKED' });
    const current = await this.observe();
    const latest = assertLifecycleSupport(current.service, kind);
    if (capability.desktopGeneration !== latest.desktopGeneration
      || !require('node:util').isDeepStrictEqual(before.targets, current.targets))
      throw Object.assign(new Error('后台实例或项目范围已变化，请重新确认'), { code: 'CONFIRMATION_STALE' });
    if (current.blockers.length) throw Object.assign(new Error(blockerMessage(current.blockers)), { code: 'LIFECYCLE_BLOCKED' });
    if (mode === 'cancel' || before.confirmedImpact || this.purpose === 'quit') {
      const impact = value => ({ remote: value.service.remote, projects: value.projects.map(project => project.observation === 'unavailable' ? {
        projectId: project.projectId, serviceId: project.serviceId, generation: project.generation, observation: 'unavailable',
      } : ({
        observation: 'known',
        projectId: project.projectId, lifecycle: project.lifecycle, activeThreads: project.activeThreads,
        goals: project.goals, tasks: project.tasks, resources: project.resources, queues: project.queues,
        pendingRequests: project.pendingRequests,
      })).sort((left, right) => left.projectId.localeCompare(right.projectId)) });
      if (!require('node:util').isDeepStrictEqual(impact(before), impact(current)))
        throw Object.assign(new Error('退出影响已变化，请重新确认当前任务'), { code: 'CONFIRMATION_STALE' });
    }
    const expectedTargets = projectId ? current.targets.filter(target => target.projectId === projectId) : current.targets;
    if (projectId && expectedTargets.length !== 1) throw Object.assign(new Error('原项目后台身份不完整，请重新核查'), { code: 'CONFIRMATION_STALE' });
    return { kind, mode, expectedDesktopGeneration: latest.desktopGeneration, expectedTargets };
  }
}
module.exports = { coreLifecycle, desktopBlockers, blockerMessage, recoveryView, targets, describe, DesktopLifecycle, isRecoveryCommand, assertLifecycleSupport };
