'use strict';
const files = require('../workspace-files');
const git = require('@areal/workspace-git');

/** 用户直接操作的桌面文件／Git 功能，复用原有路径与 revision 校验。 */
async function workspaceCommand(backend, request) {
  const project = backend.saved.find(item => item.id === request.projectId);
  if (!project) throw new Error('未知工作区');
  switch (request.operation) {
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
      const result = await live.client.request('thread/read', { threadId: request.threadId, includeTurns: true });
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
      return git.reviewTurnFiles(project.root, turn, { itemId: request.itemId });
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
