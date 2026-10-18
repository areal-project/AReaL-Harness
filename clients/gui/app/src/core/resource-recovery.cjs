'use strict';
const { randomUUID } = require('node:crypto');
const blocked = message => Object.assign(new Error(message), { code: 'CORE_RESOURCES' });

// Observe every connected Workspace before touching any of them. No drain here:
// drain closes Core admission and cannot be undone by the GUI.
async function inspectResources(backend, { includeTasks = false } = {}) {
  const projects = [];
  for (const [projectId, project] of backend.projects) {
    if (!project.client?.ready) {
      if (project.service) throw new Error('Core 连接未恢复，无法确认是否可安全停止');
      continue;
    }
    const status = await project.client.request('areal/server/status');
    const resources = [];
    for (const threadId of new Set((status.resources ?? []).map(p => p.threadId))) {
      const processes = await project.client.request('areal/process/list', { threadId });
      for (const p of processes.data ?? []) if (!p.cleanupConfirmed) resources.push({
        projectId, threadId, id: p.id, epoch: p.runtimeEpoch, state: p.state,
        // No command arguments: they can contain credentials.
        executable: p.argv?.[0] ?? '',
        stale: typeof (status.runtime?.runtimeEpoch ?? status.runtime?.epoch) === 'string' && p.runtimeEpoch !== (status.runtime?.runtimeEpoch ?? status.runtime?.epoch),
      });
    }
    // Only the status page requests this projection. Stop admission keeps its
    // existing Core safety contract and never depends on a GUI task catalog.
    const tasks = [], goals = [];
    if (includeTasks) {
      let after; const cursors = new Set();
      do {
        const page = await project.client.request('areal/task/list', { limit: 100, ...(after ? { after } : {}) });
        for (const task of page.data) {
          if (task.mode === 'foreground') {
            const { goal } = await project.client.request('areal/goal/get', { threadId: task.threadId });
            if (goal && !['completed', 'cancelled'].includes(goal.status)) goals.push({ threadId: task.threadId, status: goal.status, objective: goal.objective });
          } else if (!task.cancelled) tasks.push({ id: task.id, threadId: task.threadId, mode: task.mode, objective: task.objective, paused: task.paused,
            nextRunAt: task.nextRunAt, running: task.runs.some(run => run.status === 'running') });
        }
        after = page.nextCursor;
        if (after && cursors.has(after)) throw new Error('任务列表分页未前进，请刷新后台状态');
        cursors.add(after);
      } while (after);
    }
    projects.push({ projectId, root: project.root, restartSafe: status.restartSafe === true, resources,
      activeTurns: status.activeTurns?.length ?? 0, unresolvedTools: status.unresolvedTools?.length ?? 0,
      compactions: status.compactions?.length ?? 0,
      workgroups: (status.workgroups ?? []).filter(g => g.status === 'running' || !g.cleanupConfirmed).length,
      activeThreads: (status.activeTurns ?? []).map(t => ({ threadId: t.threadId, turnId: t.turnId })),
      goalThreads: status.activeGoals ?? [], activeTasks: status.activeTasks ?? 0, ...(includeTasks ? { tasks, goals } : {}),
      waitingMessages: status.pendingQueueItems ?? 0,
      queues: Object.entries(project.model?.state.queues ?? {}).map(([threadId, queue]) => ({ threadId, paused: queue.paused === true,
        pending: queue.items.filter(item => item.status === 'pending').length, running: queue.items.filter(item => item.status === 'running').length,
      })).filter(queue => queue.pending || queue.running),
      pendingRequests: (project.pending ?? []).map(entry => ({ threadId: entry.params.threadId, awaitingResponse: backend.awaitingResponses?.has(entry) === true })),
    });
  }
  return projects;
}
async function recoverResource(backend, request) {
  const projects = await inspectResources(backend);
  const target = projects.find(p => p.projectId === request.projectId)?.resources.find(p => p.threadId === request.threadId && p.id === request.id);
  if (!target || target.epoch !== request.epoch) throw new Error('资源状态已变化，请重新检查');
  const client = backend.projects.get(target.projectId).client;
  if (target.stale) {
    if (request.operation !== 'acknowledge' || request.confirmed !== true) throw new Error('请先核实旧终端及其子进程已结束，再确认清理');
    await client.request('areal/process/acknowledgeCleanup', { threadId: target.threadId, id: target.id,
      note: '用户在 Harness 资源恢复对话框中明确确认：已检查旧终端及其子进程均已结束。仅确认资源清理，不改变历史执行结果。' });
  } else {
    if (request.operation !== 'terminate') throw new Error('当前 Runtime 资源必须通过 Runtime 关闭');
    await client.request('areal/process/terminate', { threadId: target.threadId, id: target.id, requestId: randomUUID() });
  }
  const remaining = await client.request('areal/process/list', { threadId: target.threadId });
  if (!remaining.data?.find(p => p.id === target.id)?.cleanupConfirmed) throw new Error('Core 尚未确认资源清理，请重新检查');
  return { cleanupConfirmed: true };
}
function summary(projects) {
  return projects.filter(p => !p.restartSafe).map(p => `${p.root ?? p.projectId}\n终端 ${p.resources.length} · 活动轮次 ${p.activeTurns} · 未确认工具 ${p.unresolvedTools} · 上下文压缩 ${p.compactions} · 子任务组 ${p.workgroups}`).join('\n\n');
}
// Native main-process interaction; never expose an unrestricted attestation RPC
// or credentials to the renderer. Cancellation never changes Core records.
function createResourceRecovery({ backend, notify }) {
  let opened = false;
  return async () => {
    if (opened) return;
    opened = true;
    try {
      const projects = await backend.resources({ operation: 'inspect' });
      const pending = projects.flatMap(p => p.resources.map(r => ({ ...r, root: p.root })));
      if (!pending.length) {
        await notify({ type: 'info', message: projects.every(p => p.restartSafe) ? '后台资源已就绪' : '还有其他操作阻止更新',
          detail: summary(projects) || '可以从“检查更新…”重试安装。', buttons: ['确定'] }); return;
      }
      for (const r of pending) {
        const detail = `工作区：${r.root}\n会话：${r.threadId}\n资源：${r.id}\n程序：${r.executable}\n状态：${r.state}\n\n`;
        const answer = await notify({ type: 'warning', message: r.stale ? '检查旧终端的清理状态' : '关闭阻止更新的终端？',
          detail: detail + (r.stale ? '此终端属于已退出的 Runtime，应用无法确认其进程是否仍存在。请在系统活动监视器或终端中核实对应终端及其子进程已结束；无法确定时请选择稍后处理。确认仅记录清理证据，不会把历史执行改为成功。' : '将通过 Runtime 结束此终端及其资源。请先保存该终端中的工作。'),
          buttons: ['稍后处理', r.stale ? '确认已清理' : '关闭终端'], defaultId: 0, cancelId: 0,
          ...(r.stale ? { checkboxLabel: '我已核实该终端及其子进程均已结束', checkboxChecked: false } : {}) });
        if (answer.response !== 1) return;
        if (r.stale && !answer.checkboxChecked) { await notify({ type: 'info', message: '尚未确认清理', detail: '请完成进程核实后，再勾选确认。记录未修改。', buttons: ['确定'] }); return; }
        await backend.resources({ operation: r.stale ? 'acknowledge' : 'terminate', projectId: r.projectId, threadId: r.threadId, id: r.id, epoch: r.epoch, confirmed: r.stale });
      }
      const after = await backend.resources({ operation: 'inspect' });
      await notify({ type: 'info', message: after.every(p => p.restartSafe) ? '资源清理已确认' : '仍有操作阻止更新', detail: summary(after) || '可以从“检查更新…”重试安装，已下载的更新无需重复下载。', buttons: ['确定'] });
    } catch (error) { await notify({ type: 'error', message: '资源处理未完成', detail: error.message, buttons: ['确定'] }); }
    finally { opened = false; }
  };
}
module.exports = { inspectResources, recoverResource, createResourceRecovery, summary, blocked };
