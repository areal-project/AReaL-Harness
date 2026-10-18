// 连接测试必须验证实际 SSE 协议、成功终态和可见文本，不能仅以 HTTP 200 为凭据。
export async function probeResponse(response, protocol = 'responses') {
  const invalid = () => new Error('模型服务未完成有效的流式文本回复')
  if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
    await response.body?.cancel(); throw invalid()
  }
  let buffer = '', data = [], bytes = 0, text = '', completed = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const dispatch = () => {
    if (!data.length) return
    const raw = data.join('\n'); data = []
    if (raw === '[DONE]') return
    let event; try { event = JSON.parse(raw) } catch { throw invalid() }
    if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw invalid()
    if (protocol === 'responses') {
      if (event.type === 'response.output_text.delta') text += typeof event.delta === 'string' ? event.delta : ''
      if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed') throw invalid()
        completed = true
        if (!text.trim()) text = (event.response.output ?? []).flatMap(i => i.content ?? []).filter(c => c.type === 'output_text').map(c => c.text ?? '').join('')
      }
    } else {
      const choice = event.choices?.find(c => c.index === 0)
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content
      if (choice?.finish_reason != null) {
        if (choice.finish_reason !== 'stop') throw invalid()
        completed = true
      }
    }
  }
  for await (const chunk of response.body) {
    bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('模型测试响应过大')
    buffer += decoder.decode(chunk, { stream: true })
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1)
      if (!line) dispatch()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  decoder.decode()
  if (!completed || !text.trim()) throw invalid()
  return { state: 'connected' }
}
