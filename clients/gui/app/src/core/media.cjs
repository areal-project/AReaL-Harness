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
      return await backend.submit(project, 'areal/blob/release', { threadId: request.threadId, uri: request.uri }, { requestId: request.requestId });
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
  const quotes = request.conversationQuotes ?? [];
  if (!Array.isArray(quotes) || quotes.length > 8 || quotes.some(quote => !quote || typeof quote.text !== 'string'
    || !quote.text.trim() || quote.text.length > 8000 || Object.keys(quote).some(key => key !== 'text'))
    || quotes.reduce((total, quote) => total + quote.text.length, 0) > 16000) throw new Error('引用超出限制');
  if (quotes.length) input.push({ type: 'text', text: '# userselect:\n```userselect\n' + JSON.stringify(quotes.map(({ text }) => ({ text }))) + '\n```' });
  for (const item of media) {
    if (!['image', 'audio', 'file'].includes(item.type) || !/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(item.url)) throw new Error('无效附件');
    input.push(item.type === 'file' ? { type: 'file', url: item.url, name: String(item.name ?? '').slice(0, 255), mime_type: item.mimeType } : { type: item.type, url: item.url });
  }
  if (request.mcpContent !== undefined && !Array.isArray(request.mcpContent)) throw new Error('MCP 内容必须为数组');
  const blocks = [...(request.mcpContent ?? [])];
  for (const item of media) if (item._meta !== undefined) blocks.push({type:'resource_link', uri:item.url, name:String(item.name ?? item.type).slice(0,255), ...(item.mimeType ? {mimeType:item.mimeType} : {}), _meta:item._meta});
  if (!Array.isArray(blocks) || blocks.length > 32) throw new Error('MCP 内容最多32项');
  const withoutMeta = value => Array.isArray(value) ? value.map(withoutMeta) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_meta').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, withoutMeta(value)])) : value;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Buffer.byteLength(JSON.stringify(block)) > 65536) throw new Error('MCP 内容无效或超过64KiB');
    let text;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length) text = block.text;
    else if (block.type === 'resource_link' && typeof block.uri === 'string' && typeof block.name === 'string') text = JSON.stringify(withoutMeta(block));
    else if (block.type === 'resource' && block.resource && typeof block.resource.uri === 'string' && (typeof block.resource.text === 'string' || typeof block.resource.blob === 'string')) text = JSON.stringify(withoutMeta(block));
    else throw new Error('不支持的 MCP 消息内容');
    input.push({ type: 'text', text, text_elements: [], mcpContent: block });
  }
  if (!input.length) throw new Error('消息不能为空');
  return input;
}
module.exports = { mediaCommand, messageInput };
