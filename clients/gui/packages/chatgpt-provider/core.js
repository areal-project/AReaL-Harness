import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { ChatGPTAccount } from './account.js'
import { OpenAIAccount } from './openai.js'
import { probeResponse } from './probe.js'
export { probeResponse } from './probe.js'
import { subscriptionNetwork } from './network.js'

export const CORE_PROVIDER_ID = 'areal_chatgpt'
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

class InvalidSubscriptionStream extends Error {
  constructor(reason) { super('Invalid subscription stream'); this.reason = reason }
}
const certificateErrors = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])
function transportError(error) {
  if (error instanceof InvalidSubscriptionStream) return 'ChatGPT 未返回有效的流式响应'
  const code = error?.code ?? error?.cause?.code
  if (certificateErrors.has(code)) return `ChatGPT TLS 证书验证失败（${code}）。请检查系统信任证书或网络代理证书；不会跳过证书校验。`
  return 'ChatGPT 连接失败或已取消，请检查网络后重试'
}

// Some successful Codex responses have no Content-Type. Validate bounded SSE
// framing or a complete first data event, then replay every original byte.
async function responseStream(response, signal) {
  const type = response.headers.get('content-type')
  if (!response.body) throw new InvalidSubscriptionStream('missing-body')
  if (type && type.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
    await response.body?.cancel()
    throw new InvalidSubscriptionStream('content-type')
  }
  const stream = Readable.fromWeb(response.body)
  if (type) return stream
  const iterator = stream[Symbol.asyncIterator](), prefix = [], decoder = new TextDecoder()
  let buffer = '', size = 0
  const abort = () => stream.destroy(signal.reason)
  const replay = () => Readable.from((async function* () {
    try { yield* prefix; yield* iterator }
    finally { signal.removeEventListener('abort', abort); await iterator.return?.() }
  })())
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { value, done } = await iterator.next()
      if (done) throw new InvalidSubscriptionStream('empty-stream')
      prefix.push(value)
      const inspected = value.subarray(0, 64 * 1024 - size)
      size += inspected.length
      buffer += decoder.decode(inspected, { stream: true })
      const lines = buffer.split('\n'); buffer = lines.pop()
      for (const line of lines) {
        // A complete Responses event header proves SSE framing even when its
        // first JSON data line exceeds the bounded prefix. Core validates data.
        if (/^event: ?(?:response\.[A-Za-z0-9_.-]+|error)\r?$/.test(line)) return replay()
        if (!line.startsWith('data:')) continue
        let event
        try { event = JSON.parse(line.slice(5).trim()) } catch { throw new InvalidSubscriptionStream('invalid-first-event') }
        if (typeof event?.type !== 'string' || !(event.type.startsWith('response.') || event.type === 'error')) throw new InvalidSubscriptionStream('invalid-first-event')
        return replay()
      }
      if (size >= 64 * 1024) throw new InvalidSubscriptionStream('prefix-limit')
    }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    await iterator.return?.()
    throw error
  }
}

// Recognize only a fixed upstream rejection. Never echo arbitrary response bodies.
async function unsupportedModel(response) {
  if (response.status !== 400 || !response.body) return false
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16384) return false
      chunks.push(Buffer.from(value))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return /model is not supported when using Codex with a ChatGPT account/.test(body.detail ?? body.error?.message ?? '')
  } catch { return false }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

// Only provider transport: no conversation store, tool execution or Agent loop.
export function subscriptionRequest(body) {
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.input) || body.stream !== true)
    throw new Error('需要流式 Responses 请求')
  const instructions = [], input = []
  for (const item of body.input) {
    if (item.role === 'system') {
      const parts = typeof item.content === 'string' ? [{ text: item.content }] : item.content
      if (!Array.isArray(parts) || parts.some(p => typeof p.text !== 'string')) throw new Error('系统指令必须为文本')
      instructions.push(parts.map(p => p.text).join('\n'))
    } else input.push(item)
  }
  // Codex subscription does not accept the Platform token limit controls.
  // Core still owns turn deadlines, cancellation and token accounting.
  return { model: body.model, input, instructions: [body.instructions, ...instructions].filter(Boolean).join('\n\n') || 'You are a helpful assistant.',
    stream: true, store: false, include: ['reasoning.encrypted_content'],
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(body.reasoning ? { reasoning: body.reasoning } : {}) }
}

// SIWC permits user tools in namespaces; Core keeps plain tool names and call IDs.
function openaiRequest(body) {
  const value = subscriptionRequest(body)
  if (value.tools?.length) {
    if (value.tools.some(t => t.type !== 'function')) throw new Error('Unsupported OpenAI tool')
    value.tools = [{ type: 'namespace', name: 'areal', description: 'AReaL Runtime tools', tools: value.tools }]
  }
  value.input = value.input.map(item => item.type === 'function_call' ? { ...item, namespace: 'areal' } : item)
  if (value.tool_choice?.type === 'function') value.tool_choice = { ...value.tool_choice, namespace: 'areal' }
  return value
}

export class CoreSubscription {
  constructor({ store, token, oauth, fetch: customFetch, models, kind = 'codex', onRequest, port = 0, onListen } = {}) {
    this.token = token
    this.port = port
    this.onListen = onListen
    if (!['codex', 'openai'].includes(kind)) throw new Error('Unknown subscription kind')
    this.kind = kind
    this.id = kind === 'openai' ? 'areal_openai' : CORE_PROVIDER_ID
    this.onRequest = onRequest
    this.network = customFetch ? { fetch: customFetch, close() {} } : subscriptionNetwork()
    this.models = models ?? openaiCodexProvider().getModels().filter(m => m.input.includes('text')).map(m => ({ id: m.id, name: m.name }))
    this.account = kind === 'openai' ? new OpenAIAccount(store, { fetch: (...args) => this.network.fetch(...args) }) : new ChatGPTAccount(store, { oauth })
    this.account.models = async () => kind === 'openai' ? this.discover() : this.models
    if (kind === 'openai') this.account.on('changed', () => { this.models = []; this.catalogExpires = 0 })
    if (kind === 'openai') this.models = []
  }
  async discover() {
    // Catalogs are scoped to this signed-in session; never retain a failed/old account list.
    if (this.catalogRevision === this.account.revision && this.catalogExpires > Date.now()) return this.models
    if (this.catalogLoading) return this.catalogLoading
    const revision = this.account.revision
    this.catalogLoading = this.loadCatalog(revision).finally(() => { this.catalogLoading = null })
    return this.catalogLoading
  }
  async loadCatalog(revision) {
    const access = await this.account.accessToken()
    const response = await this.network.fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${access}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('OpenAI model discovery failed') }
    let bytes = 0, chunks = []
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('OpenAI model catalog too large'); chunks.push(chunk) }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!Array.isArray(data.models)) throw new Error('Invalid OpenAI model catalog')
    if (revision !== this.account.revision || this.account.busy) throw new Error('OpenAI account changed')
    this.models = data.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string' && m.slug && m.slug.length <= 256).slice(0, 256).map(m => ({ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name : m.slug }))
    this.catalogRevision = revision; this.catalogExpires = Date.now() + 30_000
    return this.models
  }
  async ready() {
    if (!this.starting) this.starting = (async () => {
      this.server = createServer((req, res) => { void this.handle(req, res) })
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', resolve) })
      await this.onListen?.(this.server.address().port)
      this.endpoint = `http://127.0.0.1:${this.server.address().port}/responses`
    })().catch(error => { this.server?.close(); this.starting = null; throw error })
    await this.starting
  }
  async handle(req, res) {
    let audit = null
    const deny = (status, message) => { if (!res.headersSent) { if (audit && !res.destroyed) audit.localHttpStatus = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message } })) } else res.destroy() }
    const expected = Buffer.from(`Bearer ${this.token}`), actual = Buffer.from(req.headers.authorization ?? '')
    if (req.method !== 'POST' || req.url !== '/responses' || req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { deny(403, 'Subscription transport denied'); return }
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    this.account.on('changed', abort)
    try {
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) { deny(413, 'Request too large'); return } chunks.push(chunk) }
      let body
      try { body = (this.kind === 'openai' ? openaiRequest : subscriptionRequest)(JSON.parse(Buffer.concat(chunks))) } catch { deny(400, 'Invalid subscription request'); return }
      if (!this.models.some(m => m.id === body.model)) { deny(400, 'Unknown subscription model'); return }
      if (this.onRequest) audit = { providerId: this.id, protocol: 'responses', model: body.model, startedAt: new Date().toISOString(), completedAt: null,
        upstreamHttpStatus: null, upstreamContentType: null, localHttpStatus: null, outcome: 'failed', failureKind: 'request', streamFailureReason: null }
      let token, accountId
      try {
        token = await this.account.accessToken(controller.signal)
        if (this.kind === 'codex') {
          accountId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))['https://api.openai.com/auth']?.chatgpt_account_id
          if (typeof accountId !== 'string' || !accountId) throw new Error('missing account')
        }
      } catch {
        if (audit) { audit.outcome = controller.signal.aborted ? 'cancelled' : 'failed'; audit.failureKind = controller.signal.aborted ? 'cancelled' : 'auth' }
        deny(401, 'ChatGPT 登录已失效，请重新登录'); return
      }
      const response = await this.network.fetch(this.kind === 'openai' ? 'https://api.openai.com/v1/responses' : ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(this.kind === 'codex' ? { 'ChatGPT-Account-Id': accountId, 'OpenAI-Beta': 'responses=experimental', originator: 'areal-harness' } : {}) }, body: JSON.stringify(body) })
      if (audit) {
        audit.upstreamHttpStatus = response.status
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        audit.upstreamContentType = !type ? 'missing' : type === 'text/event-stream' ? 'event-stream' : type === 'application/json' || type.endsWith('+json') ? 'json' : 'other'
      }
      if (!response.ok) {
        if (audit) audit.failureKind = response.status === 401 || response.status === 403 ? 'auth' : 'HTTP'
        const unsupported = await unsupportedModel(response)
        void response.body?.cancel().catch(() => {})
        deny(response.status, unsupported ? '当前 ChatGPT 账号不支持所选模型，请选择其他订阅模型。模型目录不代表账号实际权限。' : `ChatGPT 服务端请求失败（HTTP ${response.status}），请检查登录、订阅额度或稍后重试`); return
      }
      const stream = await responseStream(response, controller.signal)
      if (audit) audit.localHttpStatus = 200
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      await pipeline(stream, res, { signal: controller.signal })
      if (audit) { audit.outcome = 'completed'; audit.failureKind = null }
    } catch (error) {
      if (audit) {
        audit.outcome = controller.signal.aborted ? 'cancelled' : 'failed'
        audit.failureKind = controller.signal.aborted ? 'cancelled' : audit.upstreamHttpStatus === null ? 'network' : 'stream'
        if (error instanceof InvalidSubscriptionStream) audit.streamFailureReason = error.reason
      }
      deny(502, transportError(error))
    } finally {
      this.account.off('changed', abort); res.off('close', abort)
      if (audit) {
        audit.completedAt = new Date().toISOString()
        try { await this.onRequest(audit) } catch { /* Optional audit cannot affect inference. */ }
      }
    }
  }
  async probe(model) {
    await this.ready()
    const response = await fetch(this.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000), body: JSON.stringify({ model, input: [{ role: 'user', content: 'Reply with OK.' }], stream: true }) })
    if (!response.ok) {
      // This authenticated loopback only emits our fixed, credential-free errors.
      const failure = await response.json().catch(() => null)
      throw new Error(`ChatGPT 连接测试失败（HTTP ${response.status}）：${failure?.error?.message || '本地订阅转发不可用'}`)
    }
    return probeResponse(response)
  }
  async close() {
    await this.account.close()
    this.server?.closeAllConnections()
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve))
    this.network.close()
  }
}
