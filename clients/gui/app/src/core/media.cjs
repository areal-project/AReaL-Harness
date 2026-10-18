'use strict';
const MAX_BYTES = 16 * 1024 * 1024;
function coreDetail(body) {
  const text = String(body ?? '').slice(0, 1000).trim();
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch { /* Core 非 JSON 正文保持原样 */ }
  return text;
}
function uploadError(status, body) {
  const detail = coreDetail(body);
  if (/unsupported MIME|signature does not match/i.test(detail)) return new Error(`不支持的附件：${detail}`);
  if (/16777216|16 MiB|must contain 1|quota|budget exhausted/i.test(detail)) return new Error(`附件超出限制：${detail}`);
  return new Error(`附件上传失败 (${status})：${detail}`);
}
async function mediaCommand(project, request, backend) {
  const thread = project.model.state.threads[request.threadId];
  if (!thread) throw new Error('请先打开附件所属会话');
  if (request.operation === 'list') {
    const result = await project.client.request('thread/read', { threadId: request.threadId, includeTurns: true });
    return { uploads: result.thread.desktop?.uploads ?? [], archived: result.thread.desktop?.archived === true };
  }
  if (request.operation === 'release') {
    if (thread.desktop?.archived) throw new Error('归档会话只读，不能释放附件');
    if (!/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(request.uri)) throw new Error('无效附件引用');
    try {
      return await backend.submit(project, 'areal/blob/release', { threadId: request.threadId, uri: request.uri });
    } catch (error) {
      if (error.submissionUnknown) {
        error.message = `附件释放结果待核对；请检查发送状态并刷新上传记录，不会自动重发。${error.message}`;
      }
      throw error;
    }
  }
  const url = new URL(project.endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/areal/blobs'; url.search = ''; url.searchParams.set('threadId', request.threadId);
  if (request.operation === 'read') {
    if (!/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(request.uri)) throw new Error('无效附件引用');
    url.pathname += `/${request.uri.split('/').at(-1)}`;
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${project.token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch (error) {
      throw new Error(`读取附件失败：${error.message}`);
    }
    if (!response.ok) {
      const detail = coreDetail(await response.text());
      throw new Error(detail ? `读取附件失败 (${response.status})：${detail}` : `读取附件失败 (${response.status})`);
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime: response.headers.get('content-type') };
  }
  if (request.operation !== 'upload' || thread.desktop?.archived) throw new Error('会话不可上传附件');
  if (!(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > MAX_BYTES) throw new Error('附件必须为 1 B–16 MiB');
  if (typeof request.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(request.mime)) throw new Error('无效附件类型');
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${project.token}`, 'Content-Type': request.mime }, body: request.bytes, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch (error) {
    // 响应没回到客户端时不能判断 Core 是否已写入，也不能再发一次。
    throw new Error(`附件上传结果待核对：${error.message}。草稿已保留，不会自动重发。`);
  }
  if (!response.ok) throw uploadError(response.status, await response.text());
  return response.json();
}
function messageInput(backend, request) {
  const media = request.attachments ?? [];
  if (!Array.isArray(media) || media.length > 16) throw new Error('每条消息最多 16 个附件');
  const input = typeof request.text === 'string' && request.text.trim() ? backend.textInput(request.text) : [];
  for (const item of media) {
    if (!['image', 'audio', 'file'].includes(item.type) || !/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(item.url)) throw new Error('无效附件');
    input.push(item.type === 'file' ? { type: 'file', url: item.url, name: String(item.name ?? '').slice(0, 255), mime_type: item.mimeType } : { type: item.type, url: item.url });
  }
  if (!input.length) throw new Error('消息不能为空');
  return input;
}
module.exports = { mediaCommand, messageInput };
