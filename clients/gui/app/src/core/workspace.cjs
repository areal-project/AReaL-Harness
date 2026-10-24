'use strict';
const files = require('../workspace-files');
const git = require('@areal/workspace-git');
const { createHash } = require('node:crypto');
const MAX_FILE_BEFORE_BYTES = 8 * 1024 * 1024;

async function readFileBefore(project, threadId, reference) {
  const digest = typeof reference?.uri === 'string' && /^areal:\/\/blob\/([a-f0-9]{64})$/.exec(reference.uri)?.[1];
  if (!digest || reference.mimeType !== 'application/octet-stream' || !Number.isSafeInteger(reference.sizeBytes)
    || reference.sizeBytes < 0 || reference.sizeBytes > MAX_FILE_BEFORE_BYTES) throw new Error('历史文件前像引用无效');
  const url = new URL(project.endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/areal/blobs/${digest}`;
  url.search = '';
  url.searchParams.set('threadId', threadId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${project.token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`历史文件前像读取失败 (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('历史文件前像响应不完整');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > reference.sizeBytes || size > MAX_FILE_BEFORE_BYTES) throw new Error('历史文件前像超过记录大小');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  if (size !== reference.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('历史文件前像与记录的大小或哈希不一致');
  return bytes;
}

/** 用户直接操作的桌面文件／Git 功能，复用原有路径与 revision 校验。 */
async function workspaceCommand(backend, request) {
  if (request.operation === 'worktreeList') return backend.worktrees.list();
  if (request.operation === 'worktreeSettings') return backend.worktrees.configure(request);
  const project = backend.saved.find(item => item.id === request.projectId);
  if (!project) throw new Error('未知工作区');
  switch (request.operation) {
    case 'worktreeOptions': return backend.worktrees.options(project, request.sourceRoot);
    case 'worktreeEnvironmentSave': return backend.worktrees.saveEnvironment(project, request);
    case 'worktreeEnvironmentDelete': return backend.worktrees.saveEnvironment(project, request, true);
    case 'worktreeCancel': return backend.worktrees.cancel(project, request.requestId);
    case 'worktreeAction': return backend.worktrees.action(project, request);
    case 'worktreeDelete': return backend.worktrees.remove(project, request);
    case 'worktreeCreate': return backend.worktrees.create(project, request);
    case 'worktreeRead': return backend.worktrees.read(project, request.requestId);
    case 'worktreeOpen': return backend.worktrees.open(project, request.requestId);
    case 'list': {
      if (typeof request.path !== 'string') throw new Error('无效目录');
      const { listDirectory } = await import('../../bridge/filetree.js');
      const result = await listDirectory(project.root, request.path, { showAll: request.showAll === true });
      if (!result) throw new Error('目录不存在或不在工作区内');
      return result;
    }
    case 'search': {
      const { searchFiles } = await import('../../bridge/filetree.js');
      return searchFiles(project.root, request.query);
    }
    case 'read': return files.readText(project.root, request.path);
    case 'save': return files.saveText(project.root, request.path, request.text, request.revision);
    case 'review': return git.review(project.root, backend.home, { scope: request.scope ?? 'unstaged', ref: request.ref });
    case 'reviewCommits': return git.reviewCommits(project.root);
    case 'reviewBranches': return git.reviewBranches(project.root);
    case 'turnReview': {
      if (typeof request.threadId !== 'string' || typeof request.turnId !== 'string') throw new Error('请选择已完成的任务轮次');
      const live = await backend.start(project.id);
      const result = backend.supportsBoundedHistory(live.client)
        ? { thread: live.model.state.threads[request.threadId] }
        : await live.client.request('thread/read', { threadId: request.threadId, includeTurns: true });
      let turn = result.thread?.turns.find(turn => turn.id === request.turnId);
      if (!turn && result.thread?.conversation?.kind === 'fork') {
        // Read only the target-owned frozen prefix; never substitute the source's live history.
        let cursor, partial = '', partialItemId;
        do {
          const page = await live.client.request('areal/conversation/history', {
            threadId: request.threadId, view: 'inherited', maxBytes: 262144, ...(cursor ? { cursor } : {}),
          });
          if (page.snapshotId !== result.thread.conversation.historySeed.snapshotId) throw new Error('继承历史快照已变化');
          for (let entry of page.data ?? []) {
            if (entry.fragment) {
              if (entry.fragment.offsetUtf8 !== Buffer.byteLength(partial) || partial && partialItemId !== entry.sourceItemId) throw new Error('继承历史分片不连续');
              partialItemId = entry.sourceItemId;
              partial += entry.fragment.text;
              const bytes = Buffer.byteLength(partial);
              if (bytes > entry.fragment.totalBytes) throw new Error('继承历史分片长度无效');
              if (bytes < entry.fragment.totalBytes) continue;
              entry = JSON.parse(partial); partial = ''; partialItemId = undefined;
            } else if (partial) throw new Error('继承历史分片不连续');
            if (entry.sourceTurnId !== request.turnId) continue;
            turn ??= { ...entry.turn, id: request.turnId, status: entry.sourceTurnStatus, items: [] };
            turn.items.push(entry.item);
          }
          if (page.complete) {
            if (partial) throw new Error('继承历史分片不完整');
            break;
          }
          if (!page.nextCursor || page.nextCursor === cursor) throw new Error('继承历史游标未推进');
          cursor = page.nextCursor;
        } while (cursor);
      }
      if (!turn) throw new Error('轮次不属于当前任务');
      if (turn.items?.some(item => (request.itemId === undefined || item.id === request.itemId)
        && item.type === 'historyDeferred' && item.originalType === 'dynamicToolCall'))
        throw new Error('请先加载本轮的完整工具内容，再查看文件变更。');
      const fileBefores = new Map();
      for (const item of turn.items ?? []) {
        if (request.itemId !== undefined && item.id !== request.itemId) continue;
        if (item.type !== 'dynamicToolCall' || !['fs_write', 'fs_create', 'fs_apply_patch', 'fs_apply_patches'].includes(item.tool)
          || item.status !== 'completed' || item.success !== true || item.execution?.backend !== 'runtime'
          || item.execution?.outcome !== 'succeeded' || item.execution.fileBefore === undefined) continue;
        fileBefores.set(item.id, await readFileBefore(live, request.threadId, item.execution.fileBefore));
      }
      return git.reviewTurnFiles(project.root, turn, { itemId: request.itemId, fileBefores });
    }
    case 'status': return git.fileStatus(project.root);
    case 'info': return git.workspaceInfo(project.root, backend.home);
    case 'gitState': return git.gitState(project.root, backend.home);
    case 'gitStage':
    case 'gitUnstage':
    case 'gitCommit':
    case 'gitPush': return git.gitChange(project.root, backend.home, request);
    default: throw new Error('不支持的工作区操作');
  }
}
module.exports = { workspaceCommand };
