'use strict';

// 全局目录只汇总各 Core 的事实；项目外工作空间仍由已有 projectless 所有者管理。
async function taskCatalog(backend, request) {
  const limit = request.limit ?? 30;
  const inbox = request.operation === 'inbox';
  if ((!inbox && request.operation !== 'list') || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error('无效任务列表请求');
  const results = await Promise.all(backend.saved.map(async saved => {
    const projectName = saved.projectless ? '独立任务' : backend.library.value.projects[saved.id]?.title || saved.root.split(/[\\/]/).pop();
    try {
      const project = await backend.start(saved.id), data = new Map(), cursors = new Set();
      const client = project.client;
      let after;
      do {
        const page = await client.request(inbox ? 'areal/inbox/list' : 'areal/task/list', { limit: 100, ...(after ? { after } : {}) });
        backend.requireConnection(project, client);
        for (const task of page.data) {
          if (!inbox) project.model.setTask(task);
          data.set(inbox ? `${task.taskId}:${task.message.runId}:${task.message.id}` : task.id, { ...task, projectId: saved.id, projectName, scope: saved.projectless ? 'independent' : 'project' });
        }
        after = page.nextCursor;
        if (after && cursors.has(after)) throw new Error('任务列表分页未前进');
        cursors.add(after);
      } while (after && data.size < limit);
      return { data: [...data.values()].slice(0, limit), hasMore: !!after || data.size > limit };
    } catch (error) {
      return { data: [], error: { projectId: saved.id, projectName, message: backend.providers.redact(error.message) } };
    }
  }));
  return { data: results.flatMap(r => r.data), errors: results.flatMap(r => r.error ? [r.error] : []), hasMore: results.some(r => r.hasMore) };
}
module.exports = { taskCatalog };
