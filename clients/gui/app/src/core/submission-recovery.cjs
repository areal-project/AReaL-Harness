'use strict';
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { desktopError } = require('@areal/workbench/desktop-contract');
const { managementMethods } = require('./management.cjs');
const { taskMutationMethods } = require('./tasks.cjs');

// Owns pending/outcome writes and original-receipt reconciliation. Missing receipts
// remain UNKNOWN; recovery never resubmits a mutation or creates a new request ID.
const workgroupMutationMethods = new Set(['areal/workgroup/start', 'areal/workgroup/revise', 'areal/workflow/start']);
const reconciliationDelays = [500, 1000, 2000, 4000, 8000];
const creationTargets = new Map([['areal/thread/start', 'thread'], ['areal/thread/fork', 'thread'], ['areal/side/start', 'thread'], ['areal/side/create', 'thread'], ['areal/task/create', 'task']]);
const processControls = new Set(['areal/process/write', 'areal/process/closeStdin', 'areal/process/resize', 'areal/process/terminate']);
const operationOf = (method, params) => ({ method, requestId: params.requestId,
  target: creationTargets.has(method) ? { kind: 'project' } : params.taskId ? { kind: 'task', taskId: params.taskId }
    : params.threadId ? { kind: 'thread', threadId: params.threadId } : { kind: 'project' } });
const explicitRejection = error => ['rejected', 'noMutation'].includes(error?.outcome?.kind);
function matchingReceipt(entry, records, scopedThreadId) {
  const operation = entry.operation ?? operationOf(entry.method, entry.params);
  const receiptMethod = processControls.has(entry.method) ? 'areal/process/control' : entry.method;
  return records?.find(receipt => {
    const actual = receipt.operation;
    if ((actual?.requestId ?? receipt.requestId) !== operation.requestId || (actual?.method ?? receipt.method) !== receiptMethod
      || entry.digest && receipt.digest !== entry.digest) return false;
    const createdKind = creationTargets.get(entry.method);
    if (createdKind) {
      const id = createdKind === 'task' ? receipt.taskId ?? receipt.result?.id : receipt.threadId ?? receipt.result?.threadId ?? receipt.result?.thread?.id;
      return typeof id === 'string' && (!actual || actual.target?.kind === createdKind && actual.target[`${createdKind}Id`] === id);
    }
    if (actual) return isDeepStrictEqual(actual.target, operation.target);
    if (operation.target.kind === 'thread') return (receipt.threadId ?? scopedThreadId) === operation.target.threadId;
    if (operation.target.kind === 'task') return receipt.taskId === operation.target.taskId;
    return !receipt.threadId && !receipt.taskId;
  });
}
const receiptStatus = receipt => receipt.status ?? (receipt.response?.error ? 'failed'
  : receipt.result !== undefined || receipt.response?.result !== undefined ? 'completed' : 'admitted');
const receiptResult = receipt => receipt.result ?? receipt.response?.result;
// 精确 Remote 停止/交互不会重放；保留日志用于核对，不阻塞后续桌面操作。
const isRemoteControl = entry => entry.method === 'turn/interrupt' && entry.remote?.method === 'turn.stop'
  && entry.remote.capability === 'interrupt' && typeof entry.operationId === 'string'
  && typeof entry.params?.turnId === 'string' && entry.remote.target?.expectedTurnId === entry.params.turnId
  && typeof entry.params.threadId === 'string' && entry.remote.target.threadId === entry.params.threadId
  || entry.method === 'areal/interaction/respond' && entry.remote?.method === 'interaction.respond'
  && entry.remote.capability === 'answer' && typeof entry.operationId === 'string'
  && typeof entry.params?.requestId === 'string' && entry.remote.target?.interactionId === entry.params.requestId
  && typeof entry.params.turnId === 'string' && entry.remote.target.turnId === entry.params.turnId
  && typeof entry.params.threadId === 'string' && entry.remote.target.threadId === entry.params.threadId
  || entry.method === 'areal/channel/reply' && entry.remote?.method === 'task.question.reply'
  && entry.remote.capability === 'answer' && typeof entry.operationId === 'string' && entry.params?.requestId === entry.operationId
  && ['taskId', 'runId', 'questionId'].every(key => typeof entry.params[key] === 'string' && entry.remote.target?.[key] === entry.params[key])
  || entry.method === 'areal/task/pause' && entry.remote?.method === 'task.pause'
  && entry.remote.capability === 'pauseTask' && typeof entry.operationId === 'string' && entry.params?.requestId === entry.operationId
  && ['taskId', 'expectedRunId'].every(key => typeof entry.params[key] === 'string' && entry.remote.target?.[key] === entry.params[key])
  && Number.isSafeInteger(entry.params.expectedRevision) && entry.remote.target.expectedRevision === entry.params.expectedRevision;

class SubmissionRecovery {
  constructor(host) {
    this.host = host;
  }

  loadProjectJournal(id) {
    this.journalLoads ??= new Map();
    if (this.journalLoads.has(id)) return this.journalLoads.get(id);
    const task = (async () => {
      const saved = this.host.saved.find(project => project.id === id);
      if (!saved) throw new Error('未知项目');
      const { CoreTaskModel } = await import('@areal/workbench/core-model');
      let project = this.host.projects.get(id);
      if (!project) {
        project = { ...saved, model: new CoreTaskModel(), pending: [], outcomes: {}, configurations: {},
          configurationChanges: new Map(), error: null, summaries: [] };
        this.host.projects.set(id, project);
        project.model.subscribe(() => {
          void this.host.worktrees.observeProject(project).catch(error => { project.error = error.message; this.host.onChange(); });
          this.host.onChange();
        });
      }
      if (!project.journalLoaded) {
        try { project.pending = JSON.parse(await readFile(join(this.host.home, `${id}-pending.json`), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { project.outcomes = JSON.parse(await readFile(join(this.host.home, `${id}-outcomes.json`), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        project.journalLoaded = true;
      }
      if (this.host.projects.get(id) !== project || !this.host.saved.some(value => value.id === id)) throw new Error('项目登记已变化');
      return project;
    })();
    this.journalLoads.set(id, task);
    const clear = () => { if (this.journalLoads.get(id) === task) this.journalLoads.delete(id); };
    task.then(clear, clear);
    return task;
  }

  changePending(project, change) {
    const task = (project.pendingWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const before = project.pending;
      project.pending = change(before);
      this.host.onChange();
      try { await this.host.save(`${project.id}-pending.json`, project.pending); }
      catch (error) { project.pending = before; this.host.onChange(); throw error; }
      this.host.onChange();
    });
    project.pendingWrite = task;
    return task;
  }

  changeOutcomes(project, change) {
    const task = (project.outcomeWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const next = change(project.outcomes ?? {});
      if (next === project.outcomes) return;
      await this.host.save(`${project.id}-outcomes.json`, next);
      project.outcomes = next; this.host.onChange();
    });
    project.outcomeWrite = task;
    return task;
  }

  async rememberWorkgroupOutcome(project, entry, value, planRevision = value.record.planRevision) {
    await this.changeOutcomes(project, outcomes => ({ ...outcomes, [entry.params.requestId]: {
      accepted: true, method: entry.method, workgroupId: value.id, planRevision,
    } }));
  }

  async recoverWorkgroupSubmission(project, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId && workgroupMutationMethods.has(item.method));
    if (entry && this.host.awaitingResponses.has(entry)) return null;
    let receipt = project.outcomes?.[requestId];
    if (!receipt?.workgroupId && entry?.method === 'areal/workgroup/revise') {
      const value = await project.client.request('areal/workgroup/read', { id: entry.params.id });
      const revision = value.record.revisions?.[requestId];
      if (revision && revision.planRevision === entry.params.expectedRevision + 1) {
        await this.rememberWorkgroupOutcome(project, entry, value, revision.planRevision);
        receipt = project.outcomes[requestId];
      }
    }
    // Creation has no public Core receipt lookup. An absent record is unknown,
    // never a reason to retry a mutation or identify a similar-looking group.
    if (!receipt?.workgroupId || !workgroupMutationMethods.has(receipt.method)) return null;
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return receipt;
  }

  async recoverProcessSubmission(project, threadId, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId);
    if (entry && (entry.method !== 'areal/process/start' || entry.params.threadId !== threadId || this.host.awaitingResponses.has(entry))) return null;
    const value = await project.client.request('areal/request/read', { threadId, requestId });
    const receipt = matchingReceipt(entry ?? { method: 'areal/process/start', params: { threadId, requestId } }, value.data, threadId);
    if (typeof receipt?.result?.id !== 'string') return null;
    const processes = await project.client.request('areal/process/list', { threadId });
    const process = processes.data.find(item => item.id === receipt.result.id);
    // A durable acceptance can precede actual process startup. Only attach once
    // it has a Runtime process, or confirmed cleanup proves it has ended.
    if (!process || (!process.processId && !process.cleanupConfirmed)) return null;
    // process/list includes historical epochs. Core's get validates the live
    // Runtime handle; an old/unavailable handle must not become an attached PTY.
    if (!process.cleanupConfirmed) await project.client.request('areal/process/get', { threadId, id: process.id });
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return { ...receipt.result, argv: process.argv, closed: process.cleanupConfirmed === true, controls: process.inputs.length };
  }

  async recoverAgentSubmission(project, parentThreadId, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId && item.method === 'areal/agent/spawn');
    if (entry && (this.host.awaitingResponses.has(entry) || entry.params.parentThreadId !== parentThreadId)) return null;
    const receipt = project.outcomes?.[requestId];
    if (receipt?.method !== 'areal/agent/spawn' || receipt.accepted !== true || receipt.parentThreadId !== parentThreadId
      || typeof receipt.threadId !== 'string' || typeof receipt.turnId !== 'string') return null;
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return receipt;
  }

  remoteRecord(project, association) {
    const matches = value => value?.remote && ['hostId', 'devicePeerId', 'projectId', 'commandId'].every(key => value.remote[key] === association[key]);
    return Object.values(project.outcomes ?? {}).find(matches) ?? project.pending.find(matches);
  }

  async readRemoteRecord(project, association, beforeReceipt) {
    // 将读取本身排在 pending 队列中，不能看见下一笔尚未落盘的临时内存。
    const read = (project.pendingWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      await project.outcomeWrite?.catch(() => {});
      return this.remoteRecord(project, association);
    });
    project.pendingWrite = read;
    const entry = await read;
    return entry ? this.recoverRemoteSubmission(project, entry, beforeReceipt) : null;
  }

  async rememberRemoteOutcome(project, entry, result, error) {
    const taskReply = entry.method === 'areal/channel/reply' && entry.remote.method === 'task.question.reply';
    const taskPause = entry.method === 'areal/task/pause' && entry.remote.method === 'task.pause';
    let receipt;
    if (entry.method === 'areal/goal/create' && !error) {
      if (typeof result?.goal?.id !== 'string' || !Number.isSafeInteger(result.revision)) throw new Error('目标受理结果不完整');
      receipt = {goalId:result.goal.id,revision:result.revision};
    }
    if (taskPause && !error) {
      if (result?.id !== entry.params.taskId || result.paused !== true || result.runs?.at(-1)?.id !== entry.params.expectedRunId
        || !Number.isSafeInteger(result.revision) || result.revision !== entry.params.expectedRevision + 1) throw new Error('Task 暂停受理结果不完整');
      receipt = { taskId: result.id, runId: entry.params.expectedRunId, revision: result.revision, paused: true };
    }
    if (taskReply && !error) {
      if (result?.accepted !== true || ['messageId', 'taskId', 'runId'].some(key => typeof result[key] !== 'string' || !result[key] || Buffer.byteLength(result[key]) > 128)
        || result.taskId !== entry.params.taskId || result.runId !== entry.params.runId
        || !Number.isSafeInteger(result.channelSequence) || result.channelSequence < 1) throw new Error('Task 原生受理结果不完整');
      receipt = { accepted: true, messageId: result.messageId, taskId: result.taskId, runId: result.runId, channelSequence: result.channelSequence };
    }
    const threadId = taskReply || taskPause ? undefined : entry.params.threadId ?? result?.thread?.id;
    const turnId = taskReply || taskPause ? undefined : ['turn/interrupt', 'areal/interaction/respond'].includes(entry.method) ? entry.params.turnId : result?.turn?.id;
    if ((threadId !== undefined && (typeof threadId !== 'string' || Buffer.byteLength(threadId) > 128))
      || (turnId !== undefined && (typeof turnId !== 'string' || Buffer.byteLength(turnId) > 128))) throw new Error('原生关联超过预算');
    if (!error && !taskReply && !taskPause && (typeof threadId !== 'string' || (entry.method === 'areal/turn/start' && typeof turnId !== 'string')))
      throw new Error('原生受理结果不完整');
    const outcome = { operationId: entry.operationId, remote: entry.remote, method: entry.method,
      accepted: !error, admissionState: error ? 'rejected' : 'accepted', ...(receipt ? { receipt } : {}),
      ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}),
      ...(error ? { error: { code: error.code ?? 'CORE_UNAVAILABLE', ...(typeof (error.coreCode ?? error.code) === 'number' ? { coreCode: error.coreCode ?? error.code } : {}) } } : {}) };
    if (Buffer.byteLength(JSON.stringify(outcome)) > 4096) throw new Error('受理结果超过预算');
    // 终态先落盘，再移除 pending；并发查询不能覆盖已保存的完整关联。
    await this.changeOutcomes(project, outcomes => outcomes[entry.operationId]?.remote ? outcomes : { ...outcomes, [entry.operationId]: outcome });
    try { await this.changePending(project, pending => pending.filter(value => value.operationId !== entry.operationId)); }
    catch { /* 已落盘终态优先；遗留 pending 可在下次只读查询时清理。 */ }
    return project.outcomes[entry.operationId];
  }

  async recoverRemoteSubmission(project, entry, beforeReceipt) {
    const known = project.outcomes?.[entry.operationId];
    if (known?.remote) {
      if (project.pending.some(value => value.operationId === entry.operationId)) {
        try { await this.changePending(project, pending => pending.filter(value => value.operationId !== entry.operationId)); } catch {}
      }
      return known;
    }
    if (this.host.awaitingResponses.has(entry) || !project.client?.ready || project.client.closed || !project.model?.state?.connected)
      return entry;
    if (!['areal/thread/start', 'areal/turn/start', 'areal/turn/submit', 'areal/turn/enqueue', 'areal/thread/configure', ...['update','remove','reorder','pause','resume','steer'].map(op => `areal/queue/${op}`), ...['create','pause','resume','clear'].map(op => `areal/goal/${op}`)].includes(entry.method)) return entry;
    const client = project.client, generation = project.service?.generation;
    try {
      beforeReceipt?.(entry);
      // 精确查询原生键，不打开 Thread、不配置、不重放；离线只返回已有日志。
      const value = await client.request('areal/request/read', { requestId: entry.params.requestId,
        ...(entry.method !== 'areal/thread/start' ? { threadId: entry.params.threadId } : {}) });
      if (project.client !== client || project.service?.generation !== generation) return entry;
      const receipt = matchingReceipt(entry, value.data, entry.method !== 'areal/thread/start' ? entry.params.threadId : undefined);
      const response = entry.method === 'areal/thread/start' && typeof receipt?.threadId === 'string'
        ? { result: { thread: { id: receipt.threadId } } }
        : receipt?.result ? { result: receipt.result }
        : receipt?.state === 'completed' ? receipt.response : undefined;
      if (response?.error && !explicitRejection(response.error.data ?? response.error)) return entry;
      if (response) return await this.rememberRemoteOutcome(project, entry, response.result, response.error);
    } catch { /* 查询失败或空收据都不能证明未执行。 */ }
    return project.outcomes?.[entry.operationId] ?? entry;
  }

  async submitRemote(project, method, parameters, remote, dispatch) {
    const operationId = randomUUID();
    // interrupt 无请求键，respond 的 requestId 是交互领域标识；日志 UUID 不得覆盖它们。
    const entry = { method, operationId, params: { ...structuredClone(parameters), ...(['turn/interrupt', 'turn/steer', 'areal/interaction/respond'].includes(method) ? {} : { requestId: operationId }) }, remote: structuredClone(remote) };
    if (Buffer.byteLength(JSON.stringify(entry)) > 72 * 1024)
      throw Object.assign(new Error('提交记录超过预算'), { code: 'LIMIT_EXCEEDED' });
    let original;
    this.host.awaitingResponses.add(entry);
    try {
      await this.changePending(project, pending => {
        original = this.remoteRecord(project, remote);
        if (original) {
          if (original.remote.semanticDigest !== remote.semanticDigest)
            throw Object.assign(new Error('命令标识已用于不同内容'), { code: 'COMMAND_CONFLICT' });
          return pending;
        }
        if (pending.length + Object.keys(project.outcomes ?? {}).length >= 4096)
          throw Object.assign(new Error('提交日志容量已满'), { code: 'CAPACITY_EXCEEDED' });
        if (!['turn/interrupt', 'areal/interaction/respond'].includes(method) && parameters.threadId && project.configurationChanges?.has(parameters.threadId))
          throw Object.assign(new Error('会话配置正在变化'), { code: 'TARGET_CHANGED' });
        if (!['turn/interrupt', 'areal/interaction/respond'].includes(method) && parameters.threadId && pending.some(value => !isRemoteControl(value) && value.params.threadId === parameters.threadId && !(value.remote && project.outcomes?.[value.operationId]?.remote)))
          throw Object.assign(new Error('此会话有未结算提交'), { code: 'SUBMISSION_UNKNOWN', submissionUnknown: true });
        return [...pending, entry];
      });
      if (original) return this.recoverRemoteSubmission(project, original);
      let result, error;
      try { result = await dispatch(entry); }
      catch (cause) {
        if (cause.submissionUnknown || cause.code === -32603) return entry;
        error = cause;
      }
      try { return await this.rememberRemoteOutcome(project, entry, result, error); }
      catch { return entry; }
    } finally {
      this.host.awaitingResponses.delete(entry);
      this.scheduleReconciliation(project);
      this.host.onChange();
    }
  }

  async submit(project, method, parameters, { requestId, remote, dispatch, preDispatch } = {}) {
    const observationError = project.observationErrors?.[parameters.threadId];
    if (observationError && ['areal/turn/start', 'areal/turn/enqueue', 'areal/turn/submit', 'turn/start', 'turn/steer', 'areal/queue/resume', 'areal/queue/steer', 'areal/goal/create', 'areal/goal/resume'].includes(method)) {
      throw Object.assign(new Error(observationError.message), { code: observationError.code, submissionUnknown: false });
    }
    if (remote) return this.submitRemote(project, method, parameters, remote, dispatch);
    const semantics = project.client?.capabilities?.methodSemantics?.[method];
    if (semantics && semantics.effect !== 'mutation') throw new Error('此方法不是业务写入');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId))) throw new Error('无效请求标识');
    const params = { ...parameters, requestId: requestId ?? randomUUID() };
    const entry = { method, params, operation: operationOf(method, params) };
    // 活跃请求仅保存在内存；重启后仍在恢复日志中的请求应显示为结果未知。
    this.host.awaitingResponses.add(entry);
    try {
      // 检查与持久化在同一队列中，两个同时到达的发送不能穿透阻塞。
      await this.changePending(project, pending => {
        if (project.outcomes?.[params.requestId] || pending.some(value => value.params.requestId === params.requestId)) throw new Error('请求标识已使用，请核对原提交；不会重复执行。');
        if (method !== 'areal/thread/configure' && project.configurationChanges?.has(parameters.threadId)) {
          throw new Error('会话配置正在更新，请稍后再发送任务');
        }
        const conflicting = ['areal/thread/fork', 'areal/side/start', 'areal/side/create'].includes(method)
          ? pending.find(value => value.method === method && value.params.sourceThreadId === parameters.sourceThreadId)
          : pending.find(value => !isRemoteControl(value) && (parameters.taskId ? value.params.taskId === parameters.taskId : parameters.threadId ? value.params.threadId === parameters.threadId : false) && !(value.remote && project.outcomes?.[value.operationId]?.remote));
        if (conflicting) {
          const awaiting = this.host.awaitingResponses.has(conflicting);
          throw Object.assign(new Error(awaiting
            ? '当前操作正在等待响应，请稍后再试'
            : '上一次提交结果未知，请先查询受理结果'),
          awaiting ? {} : { submissionUnknown: true, requestId: conflicting.params.requestId });
        }
        return [...pending, entry];
      });
      let result, dispatchStarted = false;
      try {
        if (this.host.closing) throw new Error('应用正在退出');
        if (preDispatch && !preDispatch()) throw Object.assign(new Error('订阅模型同步目标已变化'), { submissionUnknown: false });
        dispatchStarted = true;
        result = await this.requestSubmission(project, method, params);
      }
      catch (error) {
        if (!dispatchStarted || explicitRejection(error)) {
          try { await this.changePending(project, pending => pending.filter(value => value !== entry)); }
          catch { throw Object.assign(new Error('原请求结果已知，但恢复日志更新失败；请检查本机存储'), { submissionUnknown: true, requestId: params.requestId, outcome: { kind: 'unconfirmed', operation: entry.operation }, recovery: { kind: 'queryOriginal' } }); }
        }
        if (dispatchStarted && !explicitRejection(error)) Object.assign(error, {
          submissionUnknown: true, outcome: error.outcome ?? { kind: 'unconfirmed', operation: entry.operation },
          recovery: error.recovery ?? { kind: 'queryOriginal' },
        });
        error.requestId = params.requestId;
        throw error;
      }
      try {
        if (workgroupMutationMethods.has(method)) await this.rememberWorkgroupOutcome(project, entry, result);
        else if (requestId !== undefined || ['areal/turn/submit', 'areal/agent/spawn'].includes(method))
          await this.rememberOutcome(project, entry, { status: 'completed', result });
        await this.changePending(project, pending => pending.filter(value => value !== entry));
      } catch {
        project.refreshErrors ??= {};
        project.refreshErrors[params.requestId] = { id: randomUUID(), projectId: project.id,
          connectionGeneration: project.connectionGeneration, operation: entry.operation,
          message: 'Core 已受理，本机恢复记录尚未更新。', refreshPending: true };
      }
      try { await this.host.providers.acceptModelSelection(result?.lastAcceptedModel); }
      catch (error) {
        project.refreshErrors ??= {};
        project.refreshErrors[params.requestId] ??= { id: randomUUID(), projectId: project.id, scope: 'modelSelection',
          connectionGeneration: project.connectionGeneration, operation: entry.operation,
          message: this.host.providers.redact(error.message), refreshPending: false };
      }
      return result;
    } finally {
      this.host.awaitingResponses.delete(entry);
      this.scheduleReconciliation(project);
      this.host.onChange();
    }
  }

  async processControlOutcome(project, params, result, cause) {
    let value;
    try { value = await project.client.request('areal/process/list', { threadId: params.threadId }); }
    catch { throw Object.assign(new Error('无法核对终端执行结果；不会重发输入'), { submissionUnknown: true }); }
    const operation = value.data.find(p => p.id === params.id)?.inputs?.find(op => op.operationId === result.operationId);
    if (operation?.outcome === 'succeeded') return result;
    if (operation?.outcome === 'failed') throw Object.assign(cause ?? new Error('终端操作执行失败；请检查进程状态'), { executionFailed: true });
    throw Object.assign(new Error('终端操作执行结果未确认；不会重发输入'), { submissionUnknown: true });
  }

  async requestSubmission(project, method, params) {
    const client = project.client;
    if (method === 'areal/blob/release') {
      let current;
      try { current = this.host.supportsBoundedHistory(project.client)
        ? await this.host.readObservation(project, params.threadId, { install: false })
        : await project.client.request('thread/read', { threadId: params.threadId, includeTurns: false }); }
      catch (error) { throw Object.assign(new Error(`无法核对附件所属会话：${error.message}`), { outcome: { kind: 'rejected' } }); }
      if (current.thread.desktop?.archived) throw Object.assign(new Error('归档会话只读，不能释放附件'), { outcome: { kind: 'rejected' } });
    }
    const { requestId, previousItems, ...steer } = params;
    const { threadId, ...spawn } = steer;
    const durableSteer = project.client.capabilities?.methods?.includes('areal/plugin/hooks/list');
    try {
      return await project.client.request(method, method === 'areal/agent/spawn' ? spawn
        : method === 'turn/steer' ? { ...steer, ...(durableSteer ? { requestId } : {}) } : params,
      ['areal/marketplace/addGit', 'areal/marketplace/update'].includes(method) ? { timeoutMs: 120000 } : undefined);
    } catch (error) {
      if (explicitRejection(error)) throw error;
      const entry = { method, params, operation: operationOf(method, params) };
      if (workgroupMutationMethods.has(method) || method === 'areal/agent/spawn') throw error;
      const client = project.client;
      let receipt;
      try { receipt = await this.readReceipt(project, entry, client); } catch {  }
      if (receipt && receiptStatus(receipt) === 'completed') {
        const result = receiptResult(receipt);
        if (processControls.has(method)) return this.processControlOutcome(project, params, result, error);
        if (creationTargets.get(method) === 'thread' && !result?.thread) {
          const id = receipt.threadId ?? result?.threadId;
          if (id) return { thread: { id }, requestId };
        }
        return result;
      }
      if (receipt && receiptStatus(receipt) === 'failed') {
        const failure = receipt.error ?? receipt.response?.error;
        Object.assign(error, { message: failure?.message ?? error.message, outcome: { kind: 'admitted', operation: receipt.operation ?? entry.operation } });
      }
      Object.assign(error, { requestId, submissionUnknown: true, outcome: error.outcome ?? { kind: 'unconfirmed', operation: entry.operation },
        recovery: error.recovery ?? { kind: 'queryOriginal' } });
      throw error;
    }
  }

  async readReceipt(project, entry, client, timeoutMs = 2500) {
    const family = client.capabilities?.methodSemantics?.[entry.method]?.receipt;
    const scopedThreadId = entry.params.threadId && (family ? family === 'thread' : !managementMethods.has(entry.method) && !taskMutationMethods.has(entry.method)) ? entry.params.threadId : undefined;
    const result = await client.request('areal/request/read', { requestId: entry.params.requestId,
      ...(scopedThreadId ? { threadId: scopedThreadId } : {}) }, { timeoutMs });
    this.host.requireConnection(project, client);
    return matchingReceipt(entry, result.data, scopedThreadId);
  }

  async readSubmission(project, method, params) {
    const client = project.client, generation = project.connectionGeneration;
    const pending = project.pending.find(entry => entry.method === method && entry.params.requestId === params.requestId);
    if (pending && this.host.awaitingResponses.has(pending)) return { confirmed: false, state: 'admitted' };
    const known = project.outcomes?.[params.requestId];
    const entry = pending ?? { method, params, ...(known?.method === method && known.operation ? { operation: known.operation } : {}) };
    const receipt = await this.readReceipt(project, entry, client);
    const current = () => this.host.currentConnection(project, client) && project.connectionGeneration === generation;
    if (!current()) throw Object.assign(new Error('连接已换代'), { code: 'STALE_CONNECTION' });
    const status = receipt && receiptStatus(receipt);
    if (!['completed', 'failed'].includes(status)) return { confirmed: false, state: status ?? 'unconfirmed' };
    if (pending) {
      await this.rememberOutcome(project, entry, receipt, current);
      if (current()) await this.changePending(project, entries => current() ? entries.filter(value => value !== pending) : entries);
    }
    const failure = receipt.error ?? receipt.response?.error;
    const error = failure ? desktopError(failure) : undefined;
    return { confirmed: true, accepted: true, status, operation: receipt.operation ?? entry.operation,
      ...(error ? { error, message: error.message } : { result: receiptResult(receipt) }) };
  }

  async rememberOutcome(project, entry, receipt, current = () => true) {
    const result = receiptResult(receipt), failure = receipt.error ?? receipt.response?.error;
    const status = receiptStatus(receipt);
    const threadId = entry.method === 'areal/agent/spawn' ? result?.threadId : entry.params.threadId ?? receipt.threadId ?? result?.threadId ?? result?.thread?.id;
    const taskId = entry.params.taskId ?? receipt.taskId ?? (taskMutationMethods.has(entry.method) ? result?.id : undefined);
    const operation = receipt.operation ?? { ...(entry.operation ?? operationOf(entry.method, entry.params)),
      ...(creationTargets.get(entry.method) === 'thread' && threadId ? { target: { kind: 'thread', threadId } }
        : creationTargets.get(entry.method) === 'task' && taskId ? { target: { kind: 'task', taskId } } : {}) };
    await this.changeOutcomes(project, outcomes => {
      if (!current()) return outcomes;
      return { ...outcomes, [entry.params.requestId]: { accepted: true, status, operation, method: entry.method,
        ...(threadId ? { threadId } : {}), ...(taskId ? { taskId } : {}),
        ...(entry.params.sourceThreadId ? { sourceThreadId: entry.params.sourceThreadId } : {}),
        ...(entry.params.parentThreadId ? { parentThreadId: entry.params.parentThreadId } : {}),
        ...(result?.turnId ?? result?.turn?.id ? { turnId: result.turnId ?? result.turn.id } : {}),
        ...(entry.method === 'turn/steer' && entry.params.input ? { input: entry.params.input } : {}),
        ...(entry.method === 'areal/side/close' ? { cleanupConfirmed: result?.cleanupConfirmed === true } : {}),
        ...(failure ? { message: this.host.providers.redact(failure.message) } : {}),
        ...(['areal/queue/update', 'areal/queue/pause', 'areal/queue/resume', 'areal/queue/remove', 'areal/queue/reorder'].includes(entry.method) && Number.isSafeInteger(result?.revision) ? { result: { revision: result.revision } } : {}),
      } };
    });
    return { result, threadId, taskId, status };
  }

  reconciliationCurrent(project, client, generation) {
    return this.host.currentConnection(project, client) && client.ready && project.connectionGeneration === generation
      && !this.host.lifecycleOperations?.activeRequestId && !this.host.lifecycleOperations?.activeTargets.has(project.id)
      && !this.host.lifecycleOperations?.blocking(project.id);
  }

  stopReconciliation(project) {
    clearTimeout(project.reconciliation?.timer);
    project.reconciliation = null;
  }

  scheduleReconciliation(project) {
    const client = project.client, generation = project.connectionGeneration;
    if (!project.pending?.length || !this.reconciliationCurrent(project, client, generation)) return;
    const previous = project.reconciliation;
    if (previous?.client === client && previous.generation === generation && (previous.timer || previous.running)) return;
    this.stopReconciliation(project);
    const worker = project.reconciliation = { client, generation, deadline: Date.now() + 30000, attempt: 0, running: false };
    const current = () => project.reconciliation === worker && this.reconciliationCurrent(project, client, generation);
    const schedule = () => {
      const delay = reconciliationDelays[Math.min(worker.attempt++, reconciliationDelays.length - 1)];
      if (!current() || !project.pending.length || Date.now() + delay >= worker.deadline) return;
      worker.timer = setTimeout(async () => {
        worker.timer = null;
        if (!current()) return;
        worker.running = true;
        try { await this.reconcile(project, { client, generation, deadline: worker.deadline }); }
        catch {  }
        finally { worker.running = false; schedule(); }
      }, delay);
      worker.timer.unref?.();
    };
    schedule();
  }

  reconcile(project, options = {}) {
    const client = options.client ?? project.client, generation = options.generation ?? project.connectionGeneration;
    const previous = project.reconciliationRead;
    if (previous?.client === client && previous.generation === generation) return previous.promise;
    const pass = { client, generation };
    pass.promise = this.reconcileEntries(project, { ...options, client, generation }).finally(() => {
      if (project.reconciliationRead === pass) project.reconciliationRead = null;
    });
    project.reconciliationRead = pass;
    return pass.promise;
  }

  async reconcileEntries(project, { client, generation, deadline = Date.now() + 30000 }) {
    const current = () => this.reconciliationCurrent(project, client, generation);
    for (const entry of [...project.pending]) {
      if (!current() || Date.now() >= deadline) break;
      if (this.host.awaitingResponses.has(entry)) continue;
      try {
        if (entry.remote) { await this.recoverRemoteSubmission(project, entry); continue; }
        if (workgroupMutationMethods.has(entry.method)) { await this.recoverWorkgroupSubmission(project, entry.params.requestId); continue; }
        if (entry.method === 'areal/agent/spawn') { await this.recoverAgentSubmission(project, entry.params.parentThreadId, entry.params.requestId); continue; }
        if (entry.method === 'turn/steer' && !client.capabilities?.methods?.includes('areal/plugin/hooks/list')
          && !client.capabilities?.features?.operationOutcomes) {
          await this.host.openThread(project, entry.params.threadId);
          if (!current()) break;
          const turn = project.model.state.threads[entry.params.threadId]?.turns.find(item => item.id === entry.params.expectedTurnId);
          const normalize = input => input.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type, url: part.url });
          const accepted = turn?.items.some(item => item.type === 'userMessage' && !entry.params.previousItems.includes(item.id)
            && JSON.stringify(normalize(item.content)) === JSON.stringify(normalize(entry.params.input)));
          if (accepted) {
            await this.rememberOutcome(project, entry, { status: 'completed', result: { turnId: turn.id } }, current);
            if (current()) await this.changePending(project, pending => current() ? pending.filter(value => value !== entry) : pending);
          }
          continue;
        }
        if (entry.localOnly) { await this.host.refreshConfiguration(project, entry.params.threadId); continue; }
        let receipt = await this.readReceipt(project, entry, client, Math.min(2500, Math.max(1, deadline - Date.now())));
        if (!current() || this.host.awaitingResponses.has(entry) || !project.pending.includes(entry) || !receipt) continue;
        if (!['completed', 'failed'].includes(receiptStatus(receipt))) continue;
        if (processControls.has(entry.method) && receiptStatus(receipt) === 'completed') {
          try { await this.processControlOutcome(project, entry.params, receiptResult(receipt)); }
          catch (error) { if (!error.executionFailed) throw error; receipt = { ...receipt, status: 'failed', error: { message: error.message } }; }
        }
        if (!current()) break;
        const outcome = await this.rememberOutcome(project, entry, receipt, current);
        if (!current()) break;
        await this.changePending(project, pending => current() ? pending.filter(value => value !== entry) : pending);
        if (!current()) break;
        delete project.refreshErrors?.[entry.params.requestId];
        if (outcome.status === 'completed') {
          if (entry.method === 'areal/thread/configure') project.configurations[entry.params.threadId] = outcome.result;
          if (taskMutationMethods.has(entry.method) && !['areal/channel/reply', 'areal/task/runNow'].includes(entry.method)) project.model.setTask(outcome.result);
          await this.host.providers.acceptModelSelection(outcome.result?.lastAcceptedModel).catch(() => {});
          void this.host.refreshAfterAdmission(project, outcome.threadId, receipt.operation ?? entry.operation).catch(() => {});
        }
      } catch (error) {
        if (!current()) break;
        project.refreshErrors ??= {};
        project.refreshErrors[entry.params.requestId ?? `legacy:${entry.params.threadId}`] = { id: randomUUID(), projectId: project.id,
          connectionGeneration: generation, operation: entry.operation, message: this.host.providers.redact(error.message), refreshPending: true };
        this.host.onChange();
      }
    }
  }
}

module.exports = { SubmissionRecovery, operationOf, isRemoteControl };
