'use strict';
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

/** 桌面整理偏好与可重建导航摘要；Core 继续拥有会话、执行和历史。 */
class CoreLibrary {
  constructor(backend) { this.backend = backend; this.value = { projects: {}, threads: {}, projectOrder: [], sections: [], sidebarThreadOrder: [], sidebarRevision: 0, settings: {} }; this.writes = Promise.resolve(); }
  async init() {
    try { this.value = { ...this.value, ...JSON.parse(await readFile(join(this.backend.home, 'library.json'), 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async change(change) {
    const task = this.writes.catch(() => {}).then(async () => {
      const next = structuredClone(this.value);
      change(next);
      // Only layout/membership changes invalidate a held drag. Names, unread
      // state and activity timestamps continue to merge across GUI clients.
      if (sidebarLayout(next) !== sidebarLayout(this.value)) next.sidebarRevision = (this.value.sidebarRevision ?? 0) + 1;
      try { await this.backend.save('library.json', next); }
      catch (error) {
        console.error('侧栏整理保存失败', error);
        throw Object.assign(new Error(error.message, { cause: error }), { code: 'SIDEBAR_SAVE_FAILED' });
      }
      this.value = next;
      this.backend.onChange();
      return next;
    });
    // The drain tracks completion, not an already reported validation failure.
    // Actual disk failures remain tracked by backend.saves and block shutdown.
    this.writes = task.catch(() => {});
    return task;
  }
  async recordThreadActivity(projectId, threadId, completionId) {
    if (!threadId) return;
    // Core timestamps have second precision; retain observed order only as a tie-break.
    return this.change(state => {
      const project = state.projects[projectId] ??= {};
      project.threadOrder = [threadId, ...(project.threadOrder ?? []).filter(id => id !== threadId)];
      if (completionId) {
        const meta = state.threads[`${projectId}:${threadId}`] ??= {};
        if (meta.completionId !== completionId) {
          meta.completionId = completionId;
          meta.unread = true;
        }
      }
    });
  }
  threadSummaries(projectId) {
    const live = this.backend.projects.get(projectId);
    if (live?.summariesLoaded || live?.summaries?.length) return live.summaries;
    const cached = this.value.projects[projectId]?.navigationSummaries;
    if (Array.isArray(cached)) return cached;
    // Older installations know pinned/renamed IDs before their first cache fill.
    const prefix = `${projectId}:`;
    return Object.keys(this.value.threads).filter(key => key.startsWith(prefix)).map(key => ({ id: key.slice(prefix.length), preview: '未加载的任务' }));
  }
  async recordThreadSummaries(projectId, summaries) {
    // Deliberate whitelist: thread/list also carries configuration, permissions,
    // receipts and other execution state, none of which belongs in this cache.
    const navigationSummaries = summaries.map(summary => ({
      id: summary.id,
      ...(typeof summary.parentThreadId === 'string' ? { parentThreadId: summary.parentThreadId } : {}),
      ...(typeof summary.conversation?.kind === 'string' ? { conversation: { kind: summary.conversation.kind } } : {}),
      ...(typeof summary.name === 'string' ? { name: summary.name } : {}),
      ...(typeof summary.preview === 'string' ? { preview: summary.preview } : {}),
      ...(Number.isFinite(summary.createdAt) ? { createdAt: summary.createdAt } : {}),
      ...(Number.isFinite(summary.updatedAt) ? { updatedAt: summary.updatedAt } : {}),
      desktop: { archived: summary.desktop?.archived === true },
    }));
    return this.change(state => {
      (state.projects[projectId] ??= {}).navigationSummaries = navigationSummaries;
    });
  }
  async command(request) {
    const { operation, projectId, threadId, title, before } = request;
    const global = ['settings', 'createSection', 'renameSection', 'removeSection', 'orderSection', 'markAllRead', 'dropSidebar'].includes(operation);
    if (!global && !this.backend.saved.some(item => item.id === projectId)) throw new Error('未知工作区');
    if (['renameThread', 'pinThread', 'orderThread', 'moveThread', 'readThread', 'orderSidebarThread'].includes(operation)
      && !this.threadSummaries(projectId).some(item => item.id === threadId)
      && !(operation === 'readThread' && this.backend.projects.get(projectId)?.model.state.threads?.[threadId])) throw new Error('未知会话');
    if ((operation.startsWith('rename') || operation === 'createSection') && (typeof title !== 'string' || !title.trim() || title.length > 200)) throw new Error('名称需要 1–200 个字符');
    if (operation === 'hideProject' && request.hidden) {
      const live = await this.backend.start(projectId);
      // 未打开的历史线程也可能保存暂停队列；不能仅凭当前视图隐藏它们。
      for (const summary of live.summaries) {
        const { thread } = await live.client.request('thread/read', { threadId: summary.id, includeTurns: true });
        if (thread.turns?.some(turn => turn.status === 'inProgress') || thread.desktop?.queue?.items?.some(item => ['pending', 'running'].includes(item.status))) throw new Error('工作区仍有活动任务或排队消息，请先处理后再移出侧边栏');
      }
      if (live?.pending.length || Object.values(live?.model.state.threads ?? {}).some(thread => thread.turns?.some(turn => turn.status === 'inProgress'))
        || Object.values(live?.model.state.queues ?? {}).some(queue => queue.items.some(item => ['pending', 'running'].includes(item.status)))) throw new Error('工作区仍有活动任务或排队消息，请先处理后再移出侧边栏');
    }
    return this.change(state => {
      const project = projectId ? (state.projects[projectId] ??= {}) : {};
      const key = `${projectId}:${threadId}`;
      const section = state.sections.find(item => item.id === request.sectionId);
      if (['renameSection', 'removeSection', 'orderSection'].includes(operation) && !section) throw new Error('分组已不存在，请刷新');
      if (['moveThread', 'moveProject'].includes(operation) && request.sectionId != null && !section) throw new Error('分组已不存在，请刷新');
      switch (operation) {
        case 'dropSidebar': this.dropSidebar(state, request); break;
        case 'renameProject': project.title = title.trim(); break;
        case 'renameThread': (state.threads[key] ??= {}).title = title.trim(); break;
        case 'pinThread': {
          const meta = state.threads[key] ??= {};
          meta.pinned = request.pinned === true;
          if (meta.pinned) delete meta.sectionId;
          break;
        }
        case 'pinProject': {
          project.pinned = request.pinned === true;
          if (project.pinned) delete project.sectionId;
          break;
        }
        case 'createSection': state.sections.push({ id: randomUUID(), title: title.trim() }); break;
        case 'renameSection': section.title = title.trim(); break;
        case 'removeSection': {
          state.sections = state.sections.filter(item => item.id !== section.id);
          for (const meta of [...Object.values(state.projects), ...Object.values(state.threads)]) {
            if (meta.sectionId === section.id) delete meta.sectionId;
          }
          break;
        }
        case 'orderSection': {
          const ids = state.sections.map(item => item.id);
          const order = reorder(ids, ids, section.id, before);
          state.sections.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
          break;
        }
        case 'moveThread': {
          const meta = state.threads[key] ??= {};
          meta.sectionId = request.sectionId ?? null;
          meta.pinned = false;
          break;
        }
        case 'moveProject': {
          project.sectionId = request.sectionId ?? null;
          project.pinned = false;
          break;
        }
        case 'readThread': {
          if (typeof request.read !== 'boolean') throw new Error('无效已读状态');
          if (request.read && request.completionId !== undefined && request.completionId !== state.threads[key]?.completionId) break;
          (state.threads[key] ??= {}).unread = !request.read;
          break;
        }
        case 'markAllRead': for (const meta of Object.values(state.threads)) meta.unread = false; break;
        case 'orderSidebarThread': {
          // Unopened projects may not have summaries in this service lifetime.
          // Their persisted ordering is not evidence that their Threads vanished.
          const available = [...new Set([...state.sidebarThreadOrder,
            ...this.backend.saved.flatMap(owner => this.threadSummaries(owner.id).map(item => `${owner.id}:${item.id}`))])];
          const bucket = id => {
            const meta = state.threads[id];
            const owner = id.slice(0, id.lastIndexOf(':'));
            return meta?.pinned ? 'pinned' : meta?.sectionId ?? (this.backend.saved.find(p => p.id === owner)?.projectless ? 'chats' : owner);
          };
          if (before != null && bucket(before) !== bucket(key)) throw new Error('排序位置已变化，请刷新');
          state.sidebarThreadOrder = reorder(state.sidebarThreadOrder, available, key, before);
          const meta = state.threads[key];
          state.settings[meta?.pinned ? 'sidebarSortPinned' : meta?.sectionId || this.backend.saved.find(p => p.id === projectId)?.projectless ? 'sidebarSortChats' : 'sidebarSortProjects'] = 'manual';
          break;
        }
        case 'hideProject': project.hidden = request.hidden === true; break;
        case 'orderProject': {
          const ids = this.backend.saved.map(item => item.id);
          state.projectOrder = reorder(state.projectOrder, ids, projectId, before); break;
        }
        case 'orderThread': {
          const ids = this.threadSummaries(projectId).map(item => item.id);
          project.threadOrder = reorder(project.threadOrder ?? [], ids, threadId, before); break;
        }
        case 'settings': {
          const allowed = { showPinned: [true, false], showCompleted: [true, false], busyEnter: ['queue', 'steer'],
            sidebarSort: ['manual', 'updated_at', 'priority'], sidebarSortChats: ['manual', 'updated_at', 'priority'],
            sidebarSortProjects: ['manual', 'updated_at', 'priority'], sidebarSortPinned: ['manual', 'updated_at', 'priority'],
            turnNotifications: ['always', 'unfocused', 'never'], permissionNotifications: [true, false],
            questionNotifications: [true, false], notificationSound: ['default', 'silent'], preventSleep: [true, false], showInMenuBar: [true, false],
            fileOpenTarget: ['system', 'finder', 'zed', 'vscode', 'cursor'],
            browserLinkTarget: ['internal', 'external'], browserLocalTarget: ['internal', 'external'], browserFullAddress: [true, false] };
          if (!allowed[request.key]?.includes(request.value)) throw new Error('无效偏好设置');
          if (['sidebarSort', 'sidebarSortChats', 'sidebarSortProjects', 'sidebarSortPinned'].includes(request.key) && request.value === 'manual' && !state.sidebarThreadOrder.length) {
            const available = this.backend.saved.flatMap(owner => this.threadSummaries(owner.id).map(item => `${owner.id}:${item.id}`));
            if (!Array.isArray(request.order) || request.order.some(id => !available.includes(id)) || new Set(request.order).size !== request.order.length) throw new Error('排序列表已变化，请刷新');
            state.sidebarThreadOrder = [...request.order, ...available.filter(id => !request.order.includes(id))];
          }
          state.settings[request.key] = request.value; break;
        }
        default: throw new Error('不支持的整理操作');
      }
    });
  }
  dropSidebar(state, { source, target, anchor = null, edge, order = [], expectedSidebarRevision }) {
    const changed = () => { throw new Error('整理位置已变化，请刷新后重试'); };
    if (!Number.isSafeInteger(expectedSidebarRevision) || expectedSidebarRevision !== (state.sidebarRevision ?? 0)) return changed();
    const around = (ids, id, targetId) => {
      if (!ids.includes(targetId) || id === targetId || !['before', 'after'].includes(edge)) return changed();
      const others = ids.filter(value => value !== id), index = others.indexOf(targetId);
      others.splice(index + (edge === 'after' ? 1 : 0), 0, id);
      return others;
    };
    if (source?.type === 'section') {
      const ids = state.sections.map(item => item.id);
      if (!ids.includes(source.id) || target?.type !== 'section') return changed();
      const next = around(ids, source.id, target.id);
      state.sections.sort((a, b) => next.indexOf(a.id) - next.indexOf(b.id));
      return;
    }
    if (!['thread', 'project'].includes(source?.type)) return changed();
    const thread = source.type === 'thread';
    const available = thread
      ? this.backend.saved.flatMap(owner => this.threadSummaries(owner.id).map(item => `${owner.id}:${item.id}`))
      : this.backend.saved.map(owner => owner.id);
    const key = thread ? `${source.projectId}:${source.id}` : source.id;
    if (!available.includes(key)) return changed();
    const metadata = thread ? state.threads : state.projects;
    const projectless = id => this.backend.saved.find(p => p.id === id.slice(0, id.lastIndexOf(':')))?.projectless === true;
    const group = id => metadata[id]?.pinned ? 'pinned' : metadata[id]?.sectionId ? `section:${metadata[id].sectionId}`
      : thread ? projectless(id) ? 'chats' : `project:${id.slice(0, id.lastIndexOf(':'))}` : 'projects';
    if (group(key) !== source.group) return changed();
    let destination;
    if (target?.type === 'section' && state.sections.some(item => item.id === target.id)) destination = `section:${target.id}`;
    else if (target?.type === 'pinned') destination = 'pinned';
    else if (thread && target?.type === 'chats' && projectless(key)) destination = 'chats';
    else if (thread && !projectless(key) && target?.type === 'project' && target.id === source.projectId) destination = `project:${source.projectId}`;
    else if (!thread && target?.type === 'projects') destination = 'projects';
    else return changed();
    // Membership, anchor validation, ordering and preference are one Library
    // transaction. A failed/stale drop cannot leave a half-completed move.
    const meta = metadata[key] ??= {};
    meta.pinned = destination === 'pinned';
    meta.sectionId = target.type === 'section' ? target.id : null;
    const members = available.filter(id => group(id) === destination);
    if (!Array.isArray(order) || new Set(order).size !== order.length || order.some(id => !members.includes(id))) return changed();
    if (anchor !== null && (!members.includes(anchor) || anchor === key)) return changed();
    const field = thread ? 'sidebarThreadOrder' : 'projectOrder';
    const existing = state[field] ?? [];
    const seed = [...new Set([...order, ...existing.filter(id => members.includes(id)), ...members])];
    const next = anchor === null ? [...seed.filter(id => id !== key), key] : around(seed, key, anchor);
    state[field] = [...existing.filter(id => !members.includes(id)), ...next];
    if (thread) state.settings[destination === 'pinned' ? 'sidebarSortPinned' : target.type === 'section' || target.type === 'chats' ? 'sidebarSortChats' : 'sidebarSortProjects'] = 'manual';
    else if (destination === 'pinned') state.settings.sidebarSortPinned = 'manual';
  }
}
function sidebarLayout(state) {
  const placement = meta => [meta.pinned === true, meta.sectionId ?? null];
  return JSON.stringify([
    state.projectOrder, state.sidebarThreadOrder, state.sections.map(section => section.id),
    Object.entries(state.projects).map(([id, meta]) => [id, placement(meta), meta.hidden === true,
      (meta.navigationSummaries ?? []).map(thread => [thread.id, thread.desktop?.archived === true]).sort((a,b)=>a[0].localeCompare(b[0]))]),
    Object.entries(state.threads).filter(([,meta])=>meta.pinned || meta.sectionId).map(([id,meta])=>[id,placement(meta)]),
    ['sidebarSort','sidebarSortChats','sidebarSortProjects','sidebarSortPinned','showPinned','showCompleted'].map(key=>state.settings[key]),
  ]);
}
function reorder(current, available, id, before) {
  if (before != null && !available.includes(before)) throw new Error('排序位置已变化，请刷新');
  const ids = [...new Set([...current, ...available])].filter(value => value !== id && available.includes(value));
  if (before === id) return [...new Set([...current, ...available])];
  ids.splice(before == null ? ids.length : ids.indexOf(before), 0, id);
  return ids;
}
module.exports = { CoreLibrary };
