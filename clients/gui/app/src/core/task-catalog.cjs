'use strict';
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { realpath, lstat } = require('node:fs/promises');
const { dirname, basename, join } = require('node:path');
const { executeCore } = require('./core-process.cjs');
const { operationTrace } = require('./startup-timing.cjs');
const reads = new WeakMap();
const previews = new WeakMap();
const deadlineMs = 5000;

async function canonicalPending(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await lstat(path); throw new Error('任务数据目录不可用'); }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    return join(await canonicalPending(dirname(path)), basename(path));
  }
}

async function previewRead(backend, saved, limit, sourceThreadId) {
  let pending = previews.get(backend);
  if (!pending) { pending = { flights: new Map(), active: 0, queue: [] }; previews.set(backend, pending); }
  const existing = pending.flights.get(saved.id);
  if (existing) {
    if (existing.limit === limit && existing.sourceThreadId === sourceThreadId && existing.root === saved.root) return existing.work;
    await existing.work.catch(() => {});
    return previewRead(backend, saved, limit, sourceThreadId);
  }
  const guard = () => {
    if (!backend.saved.some(owner => owner.id === saved.id && owner.root === saved.root && owner.logicalProjectId === saved.logicalProjectId)) throw new Error('任务所有者已移除');
    backend.lifecycleOperations.assertProject(saved.id);
  };
  const work = (async () => {
    guard();
    if (pending.active >= 2) await new Promise(resolve => pending.queue.push(resolve));
    else pending.active++;
    try {
      guard();
      const dataPath = join(backend.home, saved.id, 'state');
      const [workspace, dataDir] = await Promise.all([realpath(saved.root), canonicalPending(dataPath)]);
      guard();
      const { stdout } = await executeCore(backend.binary, ['service', 'task-catalog', '--workspace', saved.root, '--data-dir', dataPath,
        '--limit', String(limit), ...(sourceThreadId === undefined ? [] : ['--source-thread-id', sourceThreadId]), '--json'],
      { env: backend.hooks.environment(), timeout: deadlineMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      guard();
      const value = JSON.parse(stdout), catalog = value?.catalog;
      const invalid = () => { throw new Error('任务预览身份或数据格式不匹配'); };
      if (value.version !== 1 || value.source !== 'published' || value.executionState !== 'unobserved'
        || value.target?.workspace !== workspace || value.target?.dataDir !== dataDir
        || value.target?.instanceId !== createHash('sha256').update(dataDir).digest('hex').slice(0, 24)) invalid();
      if (catalog?.kind === 'empty' || catalog?.kind === 'requiresCore' && ['unbound', 'legacyFormat', 'readBudgetExceeded'].includes(catalog.reason)) return { data: [], hasMore: false };
      if (catalog?.kind !== 'snapshot' || !/^[a-f0-9]{64}$/.test(catalog.rootDigest) || typeof catalog.hasMore !== 'boolean'
        || !Array.isArray(catalog.data) || catalog.data.length > limit || catalog.data.some(task => !task || typeof task !== 'object'
          || typeof task.id !== 'string' || !task.id || typeof task.objective !== 'string' || task.mode !== 'scheduled'
          || !Number.isSafeInteger(task.revision) || task.revision < 0 || !Array.isArray(task.runs)
          || sourceThreadId !== undefined && task.sourceThreadId !== sourceThreadId)) invalid();
      return { data: catalog.data, hasMore: catalog.hasMore };
    } finally {
      const next = pending.queue.shift();
      if (next) next();
      else pending.active--;
    }
  })();
  pending.flights.set(saved.id, { root: saved.root, limit, sourceThreadId, work });
  try { return await work; }
  finally { if (pending.flights.get(saved.id)?.work === work) pending.flights.delete(saved.id); }
}

async function previewCatalog(backend, request, selected, limit) {
  const results = new Array(selected.length), queue = selected.map((saved, index) => ({ saved, index }));
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const { saved, index } = queue.shift(), projectId = saved.logicalProjectId ?? saved.id;
      const logical = backend.saved.find(owner => owner.id === projectId);
      const execution = saved.logicalProjectId ? { executionProjectId: saved.id } : {};
      const projectName = logical?.projectless ? '独立任务' : backend.library.value.projects[projectId]?.title || (logical?.root ?? saved.root).split(/[\\/]/).pop();
      try {
        const value = await previewRead(backend, saved, limit, request.sourceThreadId);
        results[index] = { data: value.data.map(task => ({ ...task, projectId, ...execution, projectName, scope: logical?.projectless ? 'independent' : 'project' })), hasMore: value.hasMore,
          owner: { projectId, status: 'unobserved' } };
      } catch (error) {
        let message = error.message;
        try { message = JSON.parse(error.stderr).error?.message || message; } catch {}
        results[index] = { data: [], hasMore: false, owner: { projectId, status: 'error' },
          error: { projectId, ...execution, projectName, code: 'TASK_CATALOG_PREVIEW_FAILED', message: backend.providers.redact(message).slice(0, 2048) } };
      }
    }
  }));
  const owners = new Map();
  for (const { owner } of results) if (!owners.has(owner.projectId) || owner.status === 'error') owners.set(owner.projectId, owner);
  return { source: 'published', executionState: 'unobserved', data: results.flatMap(result => result.data), errors: results.flatMap(result => result.error ? [result.error] : []),
    hasMore: results.some(result => result.hasMore), owners: [...owners.values()],
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }), ...(request.requestId === undefined ? {} : { requestId: request.requestId }), ...(request.viewEpoch === undefined ? {} : { viewEpoch: request.viewEpoch }) };
}

function bounded(work, deadline, timeout) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), Math.max(0, deadline - performance.now())); })])
    .finally(() => clearTimeout(timer));
}

function ownerRead(backend, saved, inbox, limit, trace, sourceThreadId, deadline) {
  let pending = reads.get(backend);
  if (!pending) { pending = new Map(); reads.set(backend, pending); }
  const key = `${saved.id}:${inbox ? 'inbox' : 'list'}:${sourceThreadId ?? ''}`;
  const existing = pending.get(key);
  if (existing) {
    trace.advance('shared_wait', { connectionGeneration: existing.state.generation, pages: existing.state.pages });
    if (!existing.state.closed && existing.limit >= limit) return existing.result;
    return existing.connection.then(() => {
      deadline ??= performance.now() + deadlineMs;
      return bounded(existing.work.catch(() => {}), deadline, () => Object.assign(new Error('任务目录读取超时，请重试。上次读取仍在结束。'), { code: 'TASK_CATALOG_TIMEOUT', stage: existing.state.stage }))
        .then(() => ownerRead(backend, saved, inbox, limit, trace, sourceThreadId, deadline));
    });
  }
  if (deadline !== undefined && performance.now() >= deadline) return Promise.reject(Object.assign(new Error('任务目录读取超时，请重试。'), { code: 'TASK_CATALOG_TIMEOUT', stage: 'list' }));
  const state = { closed: false, stage: 'start', pages: 0, generation: 0 };
  const timeout = () => Object.assign(new Error('任务目录读取超时，请重试。后台连接仍由现有启动流程管理。'), { code: 'TASK_CATALOG_TIMEOUT', stage: state.stage, pages: state.pages, connectionGeneration: state.generation });
  const failure = error => { error.stage ??= state.stage; error.pages ??= state.pages; error.connectionGeneration ??= state.generation; throw error; };
  const guard = (project, client) => {
    if (state.closed || performance.now() >= deadline) throw timeout();
    if (!backend.saved.some(owner => owner.id === saved.id)) throw new Error('任务所有者已移除');
    backend.lifecycleOperations.assertProject(saved.id);
    if (backend.projects.get(saved.id) !== project) throw new Error('任务所有者已移除');
    backend.requireConnection(project, client);
    if (!client.ready || (project.connectionGeneration ?? 0) !== state.generation) throw Object.assign(new Error('连接已换代，请重试'), { code: 'STALE_CONNECTION' });
  };
  const connection = Promise.resolve().then(() => {
    trace.advance('start');
    return backend.readConnection(saved.id);
  }).catch(failure);
  const work = (async () => {
    const { project, client, generation } = await connection;
    deadline ??= performance.now() + deadlineMs;
    state.generation = generation;
    state.stage = 'list';
    guard(project, client);
    trace.advance('list', { connectionGeneration: state.generation });
    const data = new Map(), cursors = new Set();
    let after;
    do {
      guard(project, client);
      const page = await client.request(inbox ? 'areal/inbox/list' : 'areal/task/list', { limit: Math.min(100, limit), ...(after ? { after } : {}) });
      guard(project, client);
      state.pages++;
      for (const task of page.data) {
        if (!inbox && (task.mode !== 'scheduled' || sourceThreadId !== undefined && task.sourceThreadId !== sourceThreadId
          || task.deletedAt != null && !(task.runs ?? []).some(run => !['completed', 'failed', 'cancelled', 'skipped'].includes(run.status) || (run.workers ?? []).some(worker => !worker.settled)))) continue;
        data.set(inbox ? `${task.taskId}:${task.message.runId}:${task.message.id}` : task.id, task);
      }
      after = page.nextCursor;
      if (after && cursors.has(after)) throw new Error('任务列表分页未前进');
      if (after) cursors.add(after);
    } while (after && data.size < limit);
    guard(project, client);
    const rows = [...data.values()].slice(0, limit);
    if (!inbox) for (const task of rows) project.model.setTask(task);
    await backend.taskWorkspaceOwners?.observeTasks(project, rows);
    return { data: rows, hasMore: !!after || data.size > limit, connectionGeneration: state.generation, pages: state.pages };
  })().catch(failure);
  const result = connection.then(() => bounded(work, deadline, () => { state.closed = true; return timeout(); })).finally(() => { state.closed = true; });
  const flight = { connection, result, work, state, limit };
  pending.set(key, flight);
  const clear = () => { if (pending.get(key) === flight) pending.delete(key); };
  work.then(clear, clear);
  return result;
}

async function taskCatalog(backend, request) {
  const limit = request.limit ?? 30, inbox = request.operation === 'inbox';
  if ((!inbox && !['list', 'preview'].includes(request.operation)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error('无效任务列表请求');
  if (request.sourceThreadId !== undefined && (inbox || typeof request.projectId !== 'string' || typeof request.sourceThreadId !== 'string' || !request.sourceThreadId || request.sourceThreadId.length > 256 || request.sourceThreadId.includes('\0'))) throw new Error('无效来源会话');
  const requested = request.projectId === undefined ? null : backend.saved.find(saved => saved.id === request.projectId);
  if (request.projectId !== undefined && !requested) throw new Error('任务所有者不存在');
  const logicalId = requested && (requested.logicalProjectId ?? requested.id);
  const selected = requested ? backend.saved.filter(saved => (saved.logicalProjectId ?? saved.id) === logicalId) : backend.saved;
  if (request.operation === 'preview') return previewCatalog(backend, request, selected, limit);
  const trace = operationTrace('task_catalog', request);
  trace.advance('begin');
  const results = await Promise.all(selected.map(async saved => {
    const publicId = saved.logicalProjectId ?? saved.id;
    const logical = backend.saved.find(project => project.id === publicId);
    const execution = saved.logicalProjectId ? { executionProjectId: saved.id } : {};
    const projectName = logical?.projectless ? '独立任务' : backend.library.value.projects[publicId]?.title || (logical?.root ?? saved.root).split(/[\\/]/).pop();
    const ownerTrace = operationTrace('task_catalog.owner', { ...request, projectId: saved.id });
    ownerTrace.advance('begin');
    try {
      const result = await ownerRead(backend, saved, inbox, limit, ownerTrace, request.sourceThreadId);
      const data = result.data.slice(0, limit).map(task => ({ ...task, projectId: publicId, ...execution, projectName, scope: logical?.projectless ? 'independent' : 'project' }));
      const hasMore = result.hasMore || result.data.length > limit;
      ownerTrace.finish('ready', { connectionGeneration: result.connectionGeneration, pages: result.pages, rows: data.length });
      return { data, hasMore, owner: { projectId: publicId, ...execution, status: 'ready', connectionGeneration: result.connectionGeneration } };
    } catch (error) {
      const failure = { projectId: publicId, ...execution, projectName, code: error.code === 'TASK_CATALOG_TIMEOUT' ? error.code : 'TASK_CATALOG_READ_FAILED', stage: error.stage === 'start' ? 'start' : 'list', message: backend.providers.redact(error.message) };
      ownerTrace.finish(failure.code === 'TASK_CATALOG_TIMEOUT' ? 'timedOut' : 'error', { connectionGeneration: error.connectionGeneration, pages: error.pages, rows: 0 });
      return { data: [], hasMore: false, error: failure, owner: { projectId: publicId, ...execution, status: 'error' } };
    }
  }));
  trace.finish(results.some(result => result.error) ? 'error' : 'ready', { rows: results.reduce((sum, result) => sum + result.data.length, 0) });
  const owners = new Map();
  for (const { owner } of results) {
    const previous = owners.get(owner.projectId);
    if (!previous) {
      const { executionProjectId, ...logicalOwner } = owner;
      owners.set(owner.projectId, logicalOwner);
    } else if (owner.status === 'error') owners.set(owner.projectId, { projectId: owner.projectId, status: 'error' });
  }
  return { data: results.flatMap(result => result.data), errors: results.flatMap(result => result.error ? [result.error] : []), hasMore: results.some(result => result.hasMore), owners: [...owners.values()],
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }), ...(request.requestId === undefined ? {} : { requestId: request.requestId }), ...(request.viewEpoch === undefined ? {} : { viewEpoch: request.viewEpoch }) };
}
module.exports = { taskCatalog };
