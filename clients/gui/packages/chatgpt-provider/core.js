import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { ChatGPTAccount } from './account.js'
import { OpenAIAccount } from './openai.js'
import { providerError, responseError } from './errors.js'
import { probeResponse } from './probe.js'
export { probeResponse } from './probe.js'
import { subscriptionNetwork } from './network.js'
import { ModelCatalog } from './catalog.js'
import { protocolAdapters } from './adapters.js'
export { subscriptionRequest } from './adapters.js'

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
    if (kind === 'openai') this.catalog = new ModelCatalog(this.account, (...args) => this.network.fetch(...args))
    this.account.models = async () => kind === 'openai' ? this.discover() : this.models
    if (kind === 'openai') { this.models = []; this.account.on('changed', () => { this.models = [] }) }
  }
  get models() { return this.catalog ? this.catalog.models : this.legacyModels }
  set models(value) { this.legacyModels = value }
  async discover(options) { return this.catalog.discover(options) }
  invalidateCatalog() { if (this.catalog) this.catalog.expiresAt = 0 }
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
    const deny = (status, message, failure) => { if (!res.headersSent) { if (audit && !res.destroyed) audit.localHttpStatus = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, ...(failure ? failure.diagnostic() : {}) } })) } else res.destroy() }
    const expected = Buffer.from(`Bearer ${this.token}`), actual = Buffer.from(req.headers.authorization ?? '')
    if (req.method !== 'POST' || req.url !== '/responses' || req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { deny(403, 'Subscription transport denied'); return }
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    this.account.on('changed', abort)
    try {
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) { deny(413, 'Request too large'); return } chunks.push(chunk) }
      let body, adjustments
      try { const raw = JSON.parse(Buffer.concat(chunks)); body = protocolAdapters[this.kind].encode(raw); adjustments = protocolAdapters[this.kind].adjustments?.(raw) ?? [] } catch { deny(400, 'Invalid subscription request'); return }
      if (!this.models.some(m => m.id === body.model)) { deny(400, 'Unknown subscription model'); return }
      if (this.onRequest) audit = { providerId: this.id, protocol: 'responses', model: body.model, startedAt: new Date().toISOString(), completedAt: null,
        upstreamHttpStatus: null, upstreamContentType: null, localHttpStatus: null, outcome: 'failed', failureKind: 'request', streamFailureReason: null, adjustments }
      let token, accountId
      try {
        token = await this.account.accessToken(controller.signal)
        if (this.kind === 'codex') {
          accountId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))['https://api.openai.com/auth']?.chatgpt_account_id
          if (typeof accountId !== 'string' || !accountId) throw new Error('missing account')
        }
      } catch (error) {
        const failure = providerError(error, 'authentication')
        if (audit) { audit.outcome = controller.signal.aborted ? 'cancelled' : 'failed'; audit.failureKind = controller.signal.aborted ? 'cancelled' : 'auth'; Object.assign(audit, failure.diagnostic()) }
        deny(controller.signal.aborted ? 499 : failure.state === 'reauth_required' ? 401 : failure.state === 'permission_denied' ? 403 : 503, failure.message, failure); return
      }
      const send = token => this.network.fetch(this.kind === 'openai' ? 'https://api.openai.com/v1/responses' : ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(this.kind === 'codex' ? { 'ChatGPT-Account-Id': accountId, 'OpenAI-Beta': 'responses=experimental', originator: 'areal-harness' } : {}) }, body: JSON.stringify(body) })
      let response = await send(token)
      // POST 无已接纳状态的权威证明，认证拒绝也不自动重放推理。
      if (audit) {
        audit.upstreamHttpStatus = response.status
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        audit.upstreamContentType = !type ? 'missing' : type === 'text/event-stream' ? 'event-stream' : type === 'application/json' || type.endsWith('+json') ? 'json' : 'other'
      }
      if (!response.ok) {
        const failure = await responseError(response, 'admission', [token])
        this.account.fail(failure, 'admission')
        if (audit) { audit.failureKind = response.status === 401 || response.status === 403 ? 'auth' : 'HTTP'; Object.assign(audit, failure.diagnostic()) }
        deny(response.status, failure.message, failure); return
      }
      this.account.failure = null
      const stream = await responseStream(response, controller.signal)
      if (audit) audit.localHttpStatus = 200
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', ...(adjustments.length ? { 'X-Areal-Provider-Adjustments': adjustments.join(',') } : {}) })
      await pipeline(stream, res, { signal: controller.signal })
      if (audit) { audit.outcome = 'forwarded'; audit.failureKind = null }
    } catch (error) {
      if (audit) {
        audit.outcome = controller.signal.aborted ? 'cancelled' : 'failed'
        audit.failureKind = controller.signal.aborted ? 'cancelled' : audit.upstreamHttpStatus === null ? 'network' : 'stream'
        if (error instanceof InvalidSubscriptionStream) audit.streamFailureReason = error.reason
      }
      const failure = providerError(error, error?.phase ?? 'transport')
      if (!controller.signal.aborted) this.account.fail(failure, failure.phase)
      if (audit) Object.assign(audit, failure.diagnostic())
      deny(failure.state === 'reauth_required' ? 401 : failure.state === 'storage_locked' ? 503 : 502, error instanceof InvalidSubscriptionStream ? transportError(error) : failure.message, failure)
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
