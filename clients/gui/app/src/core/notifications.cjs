'use strict';

// Ephemeral delivery hints derived only from live Core events. Never derive
// notifications from snapshots/history or persist a second execution state.
class CoreNotifications {
  constructor(deliver) { this.deliver = deliver; this.seen = new Set(); }
  observe(project, method, params, library) {
    let kind, threadId, eventId;
    if (method === 'turn/completed' && params?.turn?.status === 'completed') {
      kind = 'completion'; threadId = params.threadId; eventId = params.turn.id;
      // Worker/coordinator turns are implementation steps, not user turn alerts.
      if (params.turn.goal || project.model.state.threads[threadId]?.goalOwner) return;
    } else if (method === 'areal/interaction/requested' && params?.interaction?.status === 'pending') {
      const item = params.interaction;
      if (!['approval', 'question'].includes(item.kind)) return;
      kind = item.kind; threadId = item.threadId; eventId = item.requestId;
    } else return;
    if (typeof threadId !== 'string' || typeof eventId !== 'string') return;
    const id = JSON.stringify([project.id, kind, threadId, eventId]);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    const title = library.threads?.[`${project.id}:${threadId}`]?.title
      ?? project.model.state.threads[threadId]?.title
      ?? project.summaries.find(t => t.id === threadId)?.title;
    this.deliver({ id, kind, projectId: project.id, threadId, body: String(title || '打开任务查看详情').slice(0, 200) });
  }
}

// Core exposes per-Task subscriptions (shared 128-connection quota), not a
// project-wide Task feed. Observe paged public Task/Inbox snapshots centrally;
// never poll from a renderer or infer execution from GUI visibility.
class TaskNotificationMonitor {
  constructor(client, projectId, deliver, report, onTasks) {
    this.client = client; this.projectId = projectId; this.deliver = deliver; this.report = report;
    this.onTasks = onTasks;
    this.previous = null; this.stopped = false; this.pending = null;
  }
  async start() {
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => { void this.refresh(); }, 2000);
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
  async pages(method) {
    const rows = []; let after;
    do {
      const page = await this.client.request(method, { limit: 100, ...(after ? { after } : {}) });
      rows.push(...page.data);
      if (page.nextCursor && page.nextCursor === after) throw new Error('任务通知分页未前进');
      after = page.nextCursor;
    } while (after && !this.stopped);
    return rows;
  }
  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const [tasks, inbox] = await Promise.all([this.pages('areal/task/list'), this.pages('areal/inbox/list')]);
      if (this.stopped) return;
      this.onTasks?.(tasks);
      const current = new Map();
      for (const task of tasks) for (const run of task.runs ?? []) {
        if (run.status !== 'completed') continue;
        const id = JSON.stringify([this.projectId, 'task-completion', task.id, run.id]);
        current.set(id, { id, kind: 'completion', projectId: this.projectId, taskId: task.id, runId: run.id, body: task.objective.slice(0, 200) });
      }
      for (const row of inbox) {
        const message = row.message;
        if (message.status !== 'pending' || (message.expiresAt != null && message.expiresAt * 1000 <= Date.now())) continue;
        const id = JSON.stringify([this.projectId, 'task-question', row.taskId, message.id]);
        current.set(id, { id, kind: 'question', projectId: this.projectId, taskId: row.taskId, runId: message.runId, questionId: message.id, body: row.objective.slice(0, 200) });
      }
      const previous = this.previous; this.previous = new Set(current.keys());
      // The first successful read on every Core connection is a baseline. A
      // disconnected interval is not evidence of a new live notification.
      if (previous) for (const [id, notice] of current) if (!previous.has(id)) this.deliver(notice);
    })().catch(error => { if (!this.stopped) this.report(error); }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

// The selected Electron Main owns native resources. A null window is used only
// by the shared service, whose click handler opens the existing GUI entrypoint.
function showCoreNotification(Notification, window, notice, open) {
  if (window?.isDestroyed() || !Notification.isSupported()) return;
  const titles = { completion: '任务已完成', approval: '任务需要授权', question: '任务需要你的回答' };
  if (!titles[notice?.kind] || typeof notice.projectId !== 'string' || (typeof notice.threadId !== 'string' && typeof notice.taskId !== 'string')) return;
  try {
    const notification = new Notification({ title: titles[notice.kind], body: notice.body, silent: notice.silent });
    notification.on('click', () => {
      if (window?.isDestroyed()) return;
      if (window) {
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
      }
      open(typeof notice.taskId === 'string'
        ? { projectId: notice.projectId, taskId: notice.taskId, runId: notice.runId, questionId: notice.questionId }
        : { projectId: notice.projectId, threadId: notice.threadId });
    });
    notification.on('failed', (_event, error) => console.warn('系统通知未送达：', error));
    notification.show();
    return notification;
  } catch (error) { console.warn('无法显示系统通知：', error.message); }
}

class BackgroundNotifications {
  constructor(Notification, launch) { this.Notification = Notification; this.launch = launch; this.entries = new Set(); }
  get active() { return this.entries.size > 0; }
  show(notice, open) {
    const notification = showCoreNotification(this.Notification, null, notice, open);
    if (!notification) return;
    this.entries.add(notification);
    const release = () => this.entries.delete(notification);
    notification.once('click', release);
    notification.once('close', release);
    notification.once('failed', release);
  }
  close() {
    for (const notification of this.entries) notification.close();
    this.entries.clear();
  }
}
module.exports = { CoreNotifications, TaskNotificationMonitor, showCoreNotification, BackgroundNotifications };
