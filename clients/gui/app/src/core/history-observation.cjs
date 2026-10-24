'use strict';
const { randomUUID } = require('node:crypto');
const { TaskNotificationMonitor } = require('./notifications.cjs');
const { isTaskDraftConfiguration } = require('./task-draft.cjs');

// Owns rebuildable history windows and read recovery. It cannot submit mutations.
const isObservationSizeFailure = error => error?.code === 'RESPONSE_TOO_LARGE'
  && ['thread/read', 'areal/thread/observe'].includes(error.method) && error.submissionUnknown === false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const historyPageBytes = 256 * 1024, historyMaxBytes = 1024 * 1024;
const historyViewLimit = 8, historyPageLimit = 4, historyItemBytes = 128 * 1024 * 1024;
const historyReason = error => error?.reason ?? error?.data?.reason;
const historyFailure = message => Object.assign(new Error(message), { code: 'HISTORY_VIEW_UNAVAILABLE', outcome: { kind: 'noMutation' }, recovery: { kind: 'none' } });
function mergeHistory(thread, entries) {
  const turns = new Map();
  for (const entry of entries) {
    const turn = turns.get(entry.sourceTurnId) ?? { ...entry.turn, id: entry.sourceTurnId, status: entry.sourceTurnStatus, items: [] };
    if (!turn.items.some(item => item.id === entry.sourceItemId)) turn.items.push(entry.item);
    turns.set(turn.id, turn);
  }
  for (const current of thread.turns ?? []) {
    const older = turns.get(current.id);
    const currentIds = new Set((current.items ?? []).map(item => item.id));
    turns.set(current.id, older ? { ...older, ...current, items: [...older.items.filter(item => !currentIds.has(item.id)), ...current.items] } : current);
  }
  return { ...thread, turns: [...turns.values()] };
}
const retryableRead = error => error?.recovery?.kind === 'retryRead'
  || !error?.recovery && ['TIMEOUT', 'DISCONNECTED', 'CONNECTION_LOST', 'RESPONSE_UNKNOWN'].includes(error?.code);
const observationDelays = [500, 1000, 2000, 4000, 8000];

class HistoryObservation {
  constructor(host) {
    this.host = host;
  }

  notification(project, client, method, params) {
    if (!this.host.currentConnection(project, client)) return;
    if (['thread/started', 'turn/started', 'turn/completed', 'areal/thread/configured', 'areal/task/changed', 'areal/queue/changed'].includes(method)) this.host.scheduleReconciliation(project);
    const threadId = params?.threadId ?? params?.thread?.id ?? params?.interaction?.threadId;
    if (threadId && project.observationErrors?.[threadId]?.code === 'RESPONSE_TOO_LARGE') return;
    if (method === 'areal/thread/configured' && params?.threadId && params.configuration) {
      project.configurations ??= {};
      const previous = project.configurations[params.threadId];
      project.configurations[params.threadId] = { ...params.configuration,
        modelName: params.configuration.defaultModelRevision && params.configuration.defaultModelRevision === previous?.defaultModelRevision ? previous.modelName : undefined };
      this.host.onChange();
    }
    if (['areal/mcp/app/tools/pending', 'areal/mcp/app/tools/cancelled'].includes(method)) {
      this.host.onMcpPageToolNotice?.({ projectId: project.logicalProjectId ?? project.id, client, method, params });
      return;
    }
    if (method === 'areal/mcp/app/notification') this.host.onMcpAppNotification?.({ projectId: project.logicalProjectId ?? project.id, ...params });
    this.host.analytics.observe(project.id, method, params);
    if (method === 'areal/thread/edited' && this.supportsBoundedHistory(client)) {
      const window = this.historyWindow(project, threadId);
      if (window) { window.invalidated = true; window.epoch++; }
      void this.openThread(project, threadId).catch(() => {});
      return;
    }
    project.model.event(method, params);
    if (params?.task) void this.host.taskWorkspaceOwners.observeProject(project).catch(error => { project.error = error.message; this.host.onChange(); });
    if (method === 'areal/context/compacted' && params?.threadId) {
      void this.openThread(project, params.threadId).catch(() => {});
    }
    if (!isTaskDraftConfiguration(project.configurations?.[params.threadId])) this.host.notifications.observe(project.logicalProjectId ? { ...project, id: project.logicalProjectId } : project, method, params, this.host.library.value);
    if (method === 'thread/started' || method === 'turn/started' || method === 'turn/completed') {
      void this.host.library.recordThreadActivity(project.id, params.threadId ?? params.thread?.id,
        method === 'turn/completed' ? params.turn?.id ?? params.turnId : undefined).catch(() => {});
    }
    // Lifecycle notifications omit thread timestamps; refresh the authoritative
    // summaries so continued and automatically dequeued tasks sort correctly.
    if (method === 'turn/started' || method === 'turn/completed') {
      void this.listThreads(project).catch(() => {});
    }
    if (method === 'turn/completed') this.host.providers.requestReconciliation();
    if (method === 'turn/completed' && this.supportsBoundedHistory(client)
      && Buffer.byteLength(JSON.stringify(project.model.state.threads[threadId] ?? {})) > historyMaxBytes)
      void this.openThread(project, threadId).catch(() => {});
  }

  async startTaskMonitor(project, client) {
    project.taskNotificationMonitor = new TaskNotificationMonitor(client, project.logicalProjectId ?? project.id,
      notice => { if (this.host.currentConnection(project, client)) this.host.notifications.publish(notice); }, error => console.warn(this.host.providers.redact(`任务通知读取失败：${error.message}`)),
      async tasks => {
        if (!this.host.currentConnection(project, client)) return;
        for (const task of tasks) project.model.setTask(task);
        const scheduled=tasks.filter(task=>task.mode==='scheduled');
        if(scheduled.some(task=>task.runs.some(run=>run.threadId&&!project.summaries.some(thread=>thread.id===run.threadId)))) {
          await this.listThreads(project);
          this.host.requireConnection(project, client);
        }
        for(const task of scheduled)for(const run of task.runs) {
          if(run.status!=='completed' || !run.threadId || this.host.library.value.threads[`${project.id}:${run.threadId}`]?.scheduledCompletionId===run.id)continue;
          const {thread}=this.supportsBoundedHistory(client)
            ? await this.readObservation(project,run.threadId,{client,install:false})
            : await client.request('thread/read',{threadId:run.threadId,includeTurns:true});
          this.host.requireConnection(project,client);
          const completionId=thread.turns?.findLast(turn=>turn.status==='completed')?.id;
          await this.host.library.recordScheduledCompletion(project.id,run,completionId);
        }
      });
    await project.taskNotificationMonitor.start();
  }

  listThreads(project) {
    const client = project.client;
    // Lifecycle refreshes and explicit reads can overlap. Serialize complete
    // reads so an earlier snapshot cannot overwrite a later navigation cache.
    const task = (project.summaryReads ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.host.currentConnection(project, client)) return project.summaries;
      const data = [];
      let cursor;
      do {
        const classified = client.capabilities?.methods?.includes('areal/conversation/list');
        const page = await client.request(classified ? 'areal/conversation/list' : 'thread/list', {
          limit: 100, ...(classified ? { view: 'main', includeArchived: true } : {}), ...(cursor ? { cursor } : {}),
        });
        data.push(...page.data.filter(thread => !isTaskDraftConfiguration(thread.desktop?.configuration)));
        cursor = page.nextCursor;
      } while (cursor);
      if (!this.host.currentConnection(project, client)) return project.summaries;
      await this.host.library.recordThreadSummaries(project.id, data);
      if (!this.host.currentConnection(project, client)) return project.summaries;
      project.summaries = data;
      project.summariesLoaded = true;
      await this.host.worktrees.observeProject(project);
      this.host.onChange();
      return data;
    });
    project.summaryReads = task.catch(() => {});
    return task;
  }

  observationFailure(project, threadId, error, { refreshPending = false, id = randomUUID() } = {}) {
    project.observationErrors ??= {};
    project.observationErrors[threadId] = { id, projectId: project.id, threadId,
      connectionGeneration: project.connectionGeneration, code: error.code ?? 'OBSERVATION_FAILED',
      reason: error.reason, message: this.host.providers.redact(error.message), retryable: retryableRead(error), refreshPending,
      recovery: { kind: retryableRead(error) ? 'retryRead' : 'none' } };
    this.host.onChange();
  }

  async openThread(project, threadId) {
    const client = project.client, generation = project.connectionGeneration;
    project.observationReads ??= new Map();
    const existing = project.observationReads.get(threadId);
    if (existing?.client === client && existing.generation === generation) return existing.promise;
    const attempt = { client, generation, id: randomUUID() };
    const current = () => this.host.currentConnection(project, client) && generation === project.connectionGeneration
      && project.observationReads.get(threadId) === attempt;
    const deadline = Date.now() + 30000;
    const promise = Promise.resolve().then(async () => {
      for (let retries = 0; ; retries++) {
        if (!current()) throw Object.assign(new Error('连接已换代，请等待状态恢复'), { code: 'STALE_CONNECTION' });
        try {
          await this.observeThread(project, threadId, { client, current, deadline });
          if (current()) { delete project.observationErrors?.[threadId]; this.host.onChange(); }
          return;
        } catch (error) {
          if (!current()) throw error;
          const delay = observationDelays[retries];
          const retry = retryableRead(error) && client.ready && delay !== undefined && Date.now() + delay < deadline
            && !this.host.lifecycleOperations.blocking(project.id, threadId) && !this.host.lifecycleOperations.activeTargets.has(project.id);
          this.observationFailure(project, threadId, error, { refreshPending: retry, id: attempt.id });
          if (!retry) throw error;
          await sleep(delay);
        }
      }
    }).finally(() => { if (project.observationReads.get(threadId) === attempt) project.observationReads.delete(threadId); });
    attempt.promise = promise;
    project.observationReads.set(threadId, attempt);
    return promise;
  }

  supportsBoundedHistory(client) {
    return client?.capabilities?.features?.boundedObservation === true && client.capabilities.features.boundedHistory === true;
  }

  historyWindow(project, threadId) { return this.historyWindows?.get(`${project.id}:${threadId}`); }

  publishHistory(project, window) {
    if (this.historyWindow(project, window.threadId) !== window) return;
    const thread = project.model.state.threads[window.threadId];
    if (!thread) return;
    project.model.replace({ ...thread, displayHistory: { supported: true, complete: window.complete,
      omitted: window.omitted, loadingOlder: !!window.olderRead, loadingLatest: !!window.latestTurn.read,
      latestTurnComplete: window.latestTurn.complete, loadingItems: Object.fromEntries(window.loading),
      baselineFirstItemId: window.baselineFirstItemId, viewGeneration: window.viewGeneration } });
  }

  installObservation(project, result) {
    const thread = result.thread;
    const previousThread = project.model.state.threads[thread.id];
    if (!result.history) {
      project.model.replace({ ...thread, displayHistory: { supported: false } });
    } else {
      this.historyWindows ??= new Map();
      for (const [key, window] of this.historyWindows) {
        if (this.host.projects.get(window.project.id) !== window.project) this.historyWindows.delete(key);
      }
      const key = `${project.id}:${thread.id}`, previous = this.historyWindows.get(key);
      if (!previous && this.historyWindows.size >= historyViewLimit) {
        const victim = [...this.historyWindows.entries()].find(([, window]) => window.views.size === 0);
        if (!victim) throw historyFailure('同时打开的历史视图已达上限，请先关闭一个视图。');
        this.historyWindows.delete(victim[0]);
        const { project: owner, threadId } = victim[1];
        const { [threadId]: removed, ...threads } = owner.model.state.threads;
        const { [threadId]: interactions, ...otherInteractions } = owner.model.state.interactions;
        const { [threadId]: queue, ...queues } = owner.model.state.queues;
        owner.model.publish({ threads, interactions: otherInteractions, queues });
      }
      const latestId = thread.turns?.at(-1)?.id;
      const latestComplete = result.history.complete || !result.history.nextCursor || !latestId
        || thread.turns.some(turn => turn.id !== latestId);
      const preserve = !latestComplete && previous && !previous.invalidated && previous.client === project.client
        && previous.generation === project.connectionGeneration && previousThread?.turns?.at(-1)?.id === latestId;
      const prefix = preserve ? previousThread.turns.at(-1).items.map(item => previous.loaded.get(item.id)?.placeholder ?? item) : [];
      const seen = new Set(thread.turns?.flatMap(turn => turn.items ?? []).map(item => item.id));
      const knownUsers = new Map(prefix.filter(item => item.type === 'userMessage').map(item => [item.id, item]));
      const observed = { ...thread, turns: (thread.turns ?? []).map(turn => ({ ...turn, items: turn.items.map(item =>
        item.type === 'historyDeferred' && item.originalType === 'userMessage' && knownUsers.has(item.id) ? knownUsers.get(item.id) : item) })) };
      const window = { project, threadId: thread.id, ...result.history, views: previous?.views ?? new Set(), viewGeneration: randomUUID(),
        client: project.client, generation: project.connectionGeneration, latestTurn: { id: latestId, complete: latestComplete, read: null },
        preservedLatestItems: new Map(prefix.filter(item => !seen.has(item.id)).map(item => [item.id, item])), latestSeen: seen,
        pages: [], loaded: new Map(), loading: new Map(), omitted: false, epoch: 0, baselineCursor: result.history.nextCursor,
        baselineComplete: result.history.complete, baselineFirstItemId: thread.turns?.flatMap(turn => turn.items ?? [])[0]?.id };
      this.historyWindows.delete(key); this.historyWindows.set(key, window);
      project.model.replace(mergeHistory(observed, prefix.map(item => ({ sourceTurnId: latestId, sourceItemId: item.id,
        sourceTurnStatus: thread.turns.at(-1).status, turn: thread.turns.at(-1), item }))));
      this.publishHistory(project, window);
      if (window.views.size && !previous?.invalidated) void this.hydrateLatest(project, window).catch(() => {});
    }
    for (const turn of thread.turns ?? []) {
      if (turn.id && ['completed', 'failed', 'interrupted'].includes(turn.status)
        && previousThread?.turns?.some(previous => previous.id === turn.id && previous.status === 'inProgress')) {
        void this.host.library.recordThreadActivity(project.id, thread.id, turn.id).catch(() => {});
      }
    }
  }

  async readObservation(project, threadId, { client = project.client, current = () => this.host.currentConnection(project, client), timeoutMs, install = true, resume = false } = {}) {
    const bounded = this.supportsBoundedHistory(client);
    if (resume && bounded && client.capabilities.features.boundedResume !== true)
      throw historyFailure('当前 Core 无法按页恢复浏览器连接，请更新 Core 后重试。');
    const method = resume ? 'thread/resume' : 'areal/thread/observe';
    for (const maxBytes of bounded ? [historyPageBytes, historyMaxBytes] : [undefined]) {
      try {
        return await client.request(method, { threadId, ...(bounded ? { mode: 'bounded', maxBytes } : {}) }, {
          timeoutMs, ...(bounded ? { maxResponseBytes: maxBytes } : {}),
          onResult: result => { if (current() && result.thread?.id === threadId && install) this.installObservation(project, result); },
        });
      } catch (error) {
        if (!bounded || maxBytes === historyMaxBytes || historyReason(error) !== 'HISTORY_BUDGET_TOO_SMALL') throw error;
      }
    }
  }

  hydrateLatest(project, window) {
    if (window.invalidated) return Promise.reject(historyFailure('历史视图已变化，请重新加载。'));
    if (window.latestTurn.read) return window.latestTurn.read;
    if (window.latestTurn.complete) return Promise.resolve();
    const { client, generation, epoch, threadId } = window;
    const current = () => this.host.currentConnection(project, client) && project.connectionGeneration === generation
      && this.historyWindow(project, threadId) === window && window.epoch === epoch && window.views.size > 0;
    const loading = Promise.resolve().then(async () => {
      try {
        while (!window.latestTurn.complete) {
          if (!current()) throw historyFailure('历史视图已变化，请重新加载。');
          const cursor = window.baselineCursor;
          const page = await client.request('areal/conversation/history', { threadId, view: 'own', cursor, maxBytes: historyPageBytes }, { maxResponseBytes: historyPageBytes });
          if (!current()) throw historyFailure('历史视图已变化，请重新加载。');
          this.validateHistoryPage(window, page, cursor);
          for (const entry of page.data) window.latestSeen.add(entry.sourceItemId);
          const authoritative = new Map(page.data.map(entry => [entry.sourceItemId, entry.item]));
          const displayed = project.model.state.threads[threadId];
          const reconciled = { ...displayed, turns: displayed.turns.map(turn => ({ ...turn, items: turn.items.map(item =>
            item.type !== 'userMessage' && window.preservedLatestItems.get(item.id) === item
              ? authoritative.get(item.id) ?? item : item) })) };
          let thread = mergeHistory(reconciled, page.data);
          window.latestTurn.complete = page.complete || page.data.some(entry => entry.sourceTurnId !== window.latestTurn.id);
          window.baselineCursor = window.nextCursor = page.nextCursor;
          window.baselineComplete = window.complete = page.complete;
          if (window.latestTurn.complete && window.preservedLatestItems.size) {
            thread = { ...thread, turns: thread.turns.map(turn => ({ ...turn, items: turn.items.filter(item =>
              !window.preservedLatestItems.has(item.id) || window.latestSeen.has(item.id)) })) };
            window.preservedLatestItems.clear();
          }
          window.baselineFirstItemId = thread.turns.flatMap(turn => turn.items)[0]?.id;
          project.model.replace(thread);
          this.publishHistory(project, window);
        }
      } catch (error) {
        if (current() && historyReason(error) === 'HISTORY_CURSOR_STALE') { window.invalidated = true; window.epoch++; }
        throw error;
      } finally {
        if (window.latestTurn.read === loading) { window.latestTurn.read = null; this.publishHistory(project, window); }
      }
    });
    window.latestTurn.read = loading;
    this.publishHistory(project, window);
    return loading;
  }

  async refreshHistory(project, window) {
    window.invalidated = true; window.epoch++;
    await project.observationReads?.get(window.threadId)?.promise.catch(() => {});
    if (this.historyWindow(project, window.threadId) === window && this.host.currentConnection(project, window.client)
      && project.connectionGeneration === window.generation) await this.openThread(project, window.threadId);
  }

  validateHistoryPage(window, page, cursor) {
    if (page.snapshotId !== window.snapshotId || !Array.isArray(page.data) || page.nextCursor === cursor
      || !page.complete && (!page.nextCursor || !page.data.length))
      throw historyFailure('历史页的版本或游标无效，请重新打开聊天。');
    if (page.data.some(entry => entry.sourceThreadId !== window.threadId || entry.fragment || entry.item?.id !== entry.sourceItemId))
      throw historyFailure('历史页与当前聊天不匹配。');
  }

  async historyCommand(project, request) {
    const { threadId, viewId, operation } = request;
    let window = this.historyWindow(project, threadId);
    if (operation === 'release') {
      if (!window) return { released: true };
      window.views.delete(viewId);
      if (!window.views.size) {
        window.epoch++;
        const drop = new Set(window.pages.flatMap(page => page.data.map(entry => entry.sourceItemId)));
        const thread = project.model.state.threads[threadId];
        if (thread) project.model.replace({ ...thread, turns: thread.turns.map(turn => ({ ...turn,
          items: turn.items.filter(item => !drop.has(item.id)).map(item => window.loaded.get(item.id)?.placeholder ?? item),
        })).filter(turn => turn.items.length || turn.status === 'inProgress') });
        window.pages = []; window.loaded.clear(); window.loading.clear(); window.olderRead = null; window.latestTurn.read = null;
        window.nextCursor = window.baselineCursor; window.complete = window.baselineComplete; window.omitted = false;
        this.publishHistory(project, window);
      }
      return { released: true };
    }
    if (!this.supportsBoundedHistory(project.client)) return { supported: false, message: '当前 Core 使用完整历史读取，不支持分页；请更新 Core。' };
    if (!window) { await this.openThread(project, threadId); window = this.historyWindow(project, threadId); }
    if (!window) throw historyFailure('历史视图尚未就绪，请重新打开聊天。');
    if (operation === 'acquire') {
      window.views.add(viewId);
      await this.hydrateLatest(project, window);
      return { supported: true, complete: window.complete };
    }
    if (!window.views.has(viewId)) throw historyFailure('历史视图已关闭，请重新打开聊天。');
    if (operation === 'loadOlder' && window.invalidated) {
      await this.refreshHistory(project, window);
      window = this.historyWindow(project, threadId);
      if (!window?.views.has(viewId)) throw historyFailure('历史视图已关闭，请重新打开聊天。');
    }
    const client = project.client, epoch = window.epoch;
    const current = () => this.host.currentConnection(project, client) && this.historyWindow(project, threadId) === window && window.epoch === epoch && window.views.has(viewId);
    const read = (cursor, maxBytes = historyPageBytes) => client.request('areal/conversation/history', { threadId, view: 'own', cursor, maxBytes }, { maxResponseBytes: maxBytes });
    if (operation === 'loadOlder') {
      await this.hydrateLatest(project, window);
      if (!current()) throw historyFailure('历史视图已变化，请重新加载。');
      if (window.olderRead) return window.olderRead;
      if (!window.nextCursor) return { data: [], complete: true, nextCursor: null };
      const cursor = window.nextCursor;
      const loading = Promise.resolve().then(async () => {
        try {
          const page = await read(cursor);
          if (!current()) throw historyFailure('历史视图已变化，请重新加载。');
          this.validateHistoryPage(window, page, cursor);
          window.pages.push(page); window.nextCursor = page.nextCursor; window.complete = page.complete;
          let thread = mergeHistory(project.model.state.threads[threadId], page.data);
          if (window.pages.length > historyPageLimit) {
            const removed = new Set(window.pages.shift().data.map(entry => entry.sourceItemId));
            thread = { ...thread, turns: thread.turns.map(turn => ({ ...turn, items: turn.items.filter(item => !removed.has(item.id)) })).filter(turn => turn.items.length || turn.status === 'inProgress') };
            for (const id of removed) window.loaded.delete(id);
            window.omitted = true;
          }
          project.model.replace(thread); return page;
        } catch (error) {
          if (current() && historyReason(error) === 'HISTORY_CURSOR_STALE') await this.refreshHistory(project, window);
          throw error;
        } finally { if (window.olderRead === loading) { window.olderRead = null; this.publishHistory(project, window); } }
      });
      window.olderRead = loading; this.publishHistory(project, window); return loading;
    }
    if (operation !== 'loadItem') throw historyFailure('不支持的历史读取操作。');
    const placeholder = project.model.state.threads[threadId]?.turns.flatMap(turn => turn.items).find(item => item.id === request.itemId);
    if (!placeholder || placeholder.type !== 'historyDeferred') return { loaded: true, itemId: request.itemId };
    if (window.loading.has(placeholder.id)) throw historyFailure('此内容正在加载。');
    let cursor = placeholder.cursor, version = placeholder.version, totalBytes = placeholder.totalBytes, offset = 0, chunks = [], restarted = false;
    const reserved = () => [...this.historyWindows.values()].reduce((sum, view) => sum
      + [...view.loaded.values()].reduce((n, item) => n + item.bytes, 0)
      + [...view.loading.entries()].reduce((n, [id, item]) => n + (view === window && id === placeholder.id ? 0 : item.totalBytes), 0), 0);
    const reserve = () => {
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes + reserved() > historyItemBytes)
        throw historyFailure('完整内容超过当前 128 MiB 阅读缓存，请关闭其他已加载内容后重试。');
      window.loading.set(placeholder.id, { bytes: offset, totalBytes }); this.publishHistory(project, window);
    };
    reserve();
    try {
      while (true) {
        if (!current()) throw historyFailure('历史视图已关闭或变化。');
        let page;
        try { page = await read(cursor, historyMaxBytes); }
        catch (error) {
          if (historyReason(error) === 'HISTORY_ITEM_CHANGED' && error.data?.restartCursor && !restarted) {
            cursor = error.data.restartCursor; offset = 0; chunks = []; version = undefined; restarted = true; continue;
          }
          if (current() && historyReason(error) === 'HISTORY_CURSOR_STALE') await this.refreshHistory(project, window);
          throw error;
        }
        if (!current()) throw historyFailure('历史视图已关闭或变化。');
        const entry = page.data?.[0], fragment = entry?.fragment;
        if (page.data?.length !== 1 || entry.sourceThreadId !== threadId || entry.sourceItemId !== placeholder.id || !fragment
          || fragment.offsetUtf8 !== offset || typeof fragment.text !== 'string' || typeof fragment.version !== 'string'
          || version !== undefined && fragment.version !== version || offset > 0 && fragment.totalBytes !== totalBytes)
          throw historyFailure('历史内容分片不连续或版本已变化。');
        if (version === undefined) { version = fragment.version; totalBytes = fragment.totalBytes; }
        if (fragment.totalBytes !== totalBytes) throw historyFailure('历史内容长度已变化。');
        const bytes = Buffer.from(fragment.text, 'utf8'); offset += bytes.length; chunks.push(bytes);
        if (offset > totalBytes) throw historyFailure('历史内容超过声明长度。');
        reserve();
        if (offset === totalBytes) {
          if (!page.complete || page.nextCursor) throw historyFailure('历史内容终点无效。');
          const complete = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
          if (complete.sourceThreadId !== threadId || complete.sourceItemId !== placeholder.id || complete.item?.id !== placeholder.id)
            throw historyFailure('完整历史内容与当前条目不匹配。');
          const thread = project.model.state.threads[threadId];
          const stillDeferred = thread.turns.flatMap(turn => turn.items).find(item => item.id === placeholder.id);
          if (stillDeferred?.type === 'historyDeferred' && stillDeferred.cursor === placeholder.cursor) {
            window.loaded.set(placeholder.id, { placeholder, bytes: totalBytes });
            project.model.replace({ ...thread, turns: thread.turns.map(turn => ({ ...turn,
              items: turn.items.map(item => item.id === placeholder.id ? complete.item : item) })) });
          }
          return { loaded: true, itemId: placeholder.id };
        }
        if (!page.nextCursor || page.nextCursor === cursor || !bytes.length) throw historyFailure('历史内容游标未推进。');
        cursor = page.nextCursor;
      }
    } finally { window.loading.delete(placeholder.id); this.publishHistory(project, window); }
  }

  async observeThread(project, threadId, { client, current, deadline }) {
    const acceptSnapshot = result => {
      if (!current() || result.thread?.id !== threadId) return;
      delete project.observationErrors?.[threadId];
      this.installObservation(project, result);
    };
    try {
      if (!this.supportsBoundedHistory(client) && ((project.summaries ?? []).find(item => item.id === threadId)?.desktop?.archived || project.model.state?.threads?.[threadId]?.desktop?.archived)) {
        const result = await client.request('thread/read', { threadId, includeTurns: true }, { onResult: acceptSnapshot, timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())) });
        this.host.requireConnection(project, client);
        if (result.thread?.id !== threadId) throw new Error('恢复结果与目标会话不匹配');
        project.configurations[threadId] = result.thread.desktop.configuration;
        this.host.onChange();
        return;
      }
      if (!client.capabilities?.methods?.includes('areal/thread/observe')) {
        throw new Error('当前 Core 不支持安全观察已有聊天；请更新 Core 后重新连接');
      }
      const resumed = await this.readObservation(project, threadId, { client, current, timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())) });
      this.host.requireConnection(project, client);
      if (resumed.thread?.id !== threadId) throw new Error('恢复结果与目标会话不匹配');
      if (resumed.thread?.desktop?.archived) {
        project.configurations[threadId] = resumed.thread.desktop.configuration;
        project.model.setQueue(threadId, resumed.thread.desktop.queue);
        project.model.setInteractions(threadId, { revision: resumed.thread.desktop.interactionRevision, data: resumed.thread.desktop.interactions });
        this.host.onChange();
        return;
      }
      if (resumed.thread?.conversation?.policy?.kind === 'sideReadOnlyV1') {
        project.configurations[threadId] = resumed.thread.desktop?.configuration;
        this.host.onChange();
        return;
      }
      const timeoutMs = Math.min(6000, Math.max(1, deadline - Date.now()));
      const results = await Promise.allSettled([
        client.request('areal/interaction/list', { threadId }, {
          timeoutMs, onResult: result => { if (current()) project.model.setInteractions(threadId, result); },
        }),
        this.host.refreshConfiguration(project, threadId, { client, timeoutMs, current }),
        this.host.refreshQueue(project, threadId, { client, timeoutMs, current }),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;

    } catch (error) {
      if (!this.supportsBoundedHistory(client) && isObservationSizeFailure(error) && this.host.currentConnection(project, client) && client.ready) {
        project.observationErrors ??= {};
        project.observationErrors[threadId] = { connectionGeneration: project.connectionGeneration,
          code: 'RESPONSE_TOO_LARGE', message: '聊天历史超过当前支持的 64 MiB，无法完整加载。', retryable: false };
        this.host.onChange();
        if (client.capabilities?.methods?.includes('areal/subscription/remove')) {
          try { await client.request('areal/subscription/remove', { threadIds: [threadId] }, { timeoutMs: 2500 }); }
          catch (removeError) {
            if (!this.host.currentConnection(project, client) || !client.ready) throw removeError;
          }
        }
      }
      throw error;
    }
  }
}

module.exports = { HistoryObservation, isObservationSizeFailure };
