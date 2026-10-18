'use strict';
const { basename } = require('node:path');
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

// Explicit projection: neither backend.snapshot() nor arbitrary Core RPC results
// may cross this boundary. User-authored task contents remain intentionally visible.
function projectSnapshot(backend, device) {
  const snapshot = backend.snapshot();
  return { projects: snapshot.projects.filter(project => device.projects.includes(project.id)).map(project => ({
    id: project.id, name: snapshot.library?.projects?.[project.id]?.name ?? basename(project.root),
    connected: project.state?.connected === true,
    summaries: project.summaries.map(value => pick(value, ['id', 'title', 'preview', 'updatedAt', 'createdAt'])),
    threads: Object.fromEntries(Object.entries(project.state?.threads ?? {}).map(([id, thread]) => [id, {
      id, title: thread.title, archived: thread.desktop?.archived === true,
      turns: (thread.turns ?? []).map(turn => ({ id: turn.id, status: turn.status,
        items: (turn.items ?? []).flatMap(item => {
          if (item.type === 'agentMessage') return [pick(item, ['id', 'type', 'text', 'phase'])];
          if (item.type === 'userMessage') return [{ id: item.id, type: item.type, content: (item.content ?? []).filter(part => ['text', 'image'].includes(part.type)).map(part => pick(part, ['type', 'text', 'url'])) }];
          if (item.type === 'agentMedia' && item.modality === 'image') return [{ id: item.id, type: item.type, url: item.media?.uri }];
          return [];
        }),
      })),
      interactions: (project.state?.interactions?.[id]?.data ?? []).filter(value => value.status === 'pending').map(value => pick(value, ['requestId', 'kind', 'status', 'threadId', 'turnId', 'tool', 'effectiveArguments', 'questions'])),
    }])),
    pending: project.pending.map(entry => ({ threadId: entry.params?.threadId, awaitingResponse: entry.awaitingResponse })),
  })) };
}
async function remoteCommand(service, device, message) {
  if (message.method === 'snapshot') return projectSnapshot(service.backend, device);
  const params = message.params;
  if (!params || !device.projects.includes(params.projectId) || !service.backend.saved.some(project => project.id === params.projectId)) throw new Error('此设备未获准访问该项目');
  const common = pick(params, ['projectId', 'threadId']);
  if (typeof common.projectId !== 'string' || (message.method !== 'create' && message.method !== 'list' && message.method !== 'reconcile' && typeof common.threadId !== 'string')) throw new Error('无效任务标识');
  let name = message.method, request = common;
  switch (name) {
    case 'list': case 'open': case 'create': case 'stop': case 'reconcile': break;
    case 'send': case 'steer':
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 128000) throw new Error('消息必须为 1–128000 字符');
      request = { ...common, text: params.text, ...(name === 'steer' ? { expectedTurnId: params.expectedTurnId } : {}) }; break;
    case 'respond':
      if (typeof params.requestId !== 'string') throw new Error('无效审批标识');
      if (params.decision !== undefined && !['allowOnce', 'deny'].includes(params.decision)) throw new Error('手机仅支持本次批准或拒绝');
      if (params.answers !== undefined && (!params.answers || typeof params.answers !== 'object' || Array.isArray(params.answers) || Object.values(params.answers).some(answer => typeof answer !== 'string' || answer.length > 16000))) throw new Error('无效回答');
      request = { ...common, requestId: params.requestId, decision: params.decision, answers: params.answers }; break;
    case 'image':
      request = { ...common, operation: 'read', uri: params.uri }; name = 'media'; break;
    case 'diff':
      request = { ...common, operation: 'turnReview', turnId: params.turnId }; name = 'workspace'; break;
    default: throw new Error('手机端不支持此操作');
  }
  const result = await service.executeRemote(name, request);
  if (message.method === 'create') return { threadId: result.threadId };
  if (message.method === 'image') {
    const bytes = Buffer.from(result.bytes);
    // Core's blob endpoint may use application/octet-stream. Recognize only
    // raster signatures; never pass through arbitrary active image content.
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime || bytes.length > 16 * 1024 * 1024) throw new Error('图片类型或大小不支持');
    return { mime, bytes: bytes.toString('base64') };
  }
  if (message.method === 'diff') {
    const patches = result.diff.split(/(?=^diff --git )/m).filter(Boolean);
    return { notice: result.notice, files: (result.files ?? []).map((file, index) => ({ workspaceRelativePath: file.path, patch: patches[index] ?? '', binary: file.binary, added: file.additions, removed: file.deletions })) };
  }
  return projectSnapshot(service.backend, device);
}
module.exports = { projectSnapshot, remoteCommand };
