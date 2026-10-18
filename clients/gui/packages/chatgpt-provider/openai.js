import { createServer } from 'node:http'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { ChatGPTAccount, ACCOUNT_KEY } from './account.js'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const issuedClient = id => typeof id === 'string' && id.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(id) && id !== 'dynamic_agent_client'
const registered = c => issuedClient(c?.clientId) && typeof c.subject === 'string' && !!c.subject
const registration = c => ({ hostId: c.hostId, ...(registered(c) ? { clientId: c.clientId, subject: c.subject, email: c.email, issuer: ISSUER } : {}) })

// 新版应用授权有独立的注册身份；Codex grant 不能迁移为此类凭据。
class OpenAIOAuth {
  constructor(fetch) { this.fetch = fetch }
  async json(url, options = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])])
    const response = await this.fetch(url, { ...options, signal, redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new Error('OpenAI 认证服务请求失败') }
    let bytes = 0, chunks = []
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('OpenAI 认证响应过大'); chunks.push(chunk) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async metadata(signal) {
    if (this.configuration) return this.configuration
    const config = await this.json(`${ISSUER}/.well-known/openid-configuration`, { signal })
    if (config.issuer !== ISSUER) throw new Error('OpenAI issuer 无效')
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      const url = new URL(config[field])
      if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) throw new Error('OpenAI 认证端点无效')
    }
    this.configuration = config
    return config
  }
  async identity(token, clientId, nonce, signal) {
    const config = await this.metadata(signal)
    const loadKeys = async () => { this.keys = createLocalJWKSet(await this.json(config.jwks_uri, { signal })) }
    if (!this.keys) await loadKeys()
    const verify = () => jwtVerify(token, this.keys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 })
    let result
    try { result = await verify() }
    catch (error) { if (error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error; await loadKeys(); result = await verify() }
    const claims = result.payload
    if (typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)) throw new Error('OpenAI 身份无效')
    if (!Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 5) throw new Error('OpenAI ID Token 时间无效')
    return claims
  }
  async tokens(form, signal) {
    const config = await this.metadata(signal)
    const result = await this.json(config.token_endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form })
    if (result.token_type?.toLowerCase() !== 'bearer' || typeof result.access_token !== 'string' || !result.access_token || typeof result.refresh_token !== 'string' || !result.refresh_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('OpenAI 凭据无效')
    const scopes = typeof result.scope === 'string' ? result.scope.split(/\s+/) : []
    if (!['resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => scopes.includes(scope))) throw new Error('未授权 ChatGPT API 使用权限')
    return { result, value: { type: 'oauth', access: result.access_token, refresh: result.refresh_token, expires: Date.now() + result.expires_in * 1000, scopes } }
  }
  async login(saved, { signal, onAuth }) {
    const config = await this.metadata(signal)
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url'), nonce = randomBytes(24).toString('base64url')
    let settle, fail, claimed = false
    const callback = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    void callback.catch(() => {})
    // listener 必须先就绪；只处理一次绑定 state 的回调，支持已占用的默认端口。
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state || claimed) { res.writeHead(400); res.end('Invalid authorization callback'); return }
      res.setHeader('Connection', 'close')
      claimed = true
      if (url.searchParams.has('error')) { res.writeHead(400); res.end('Authorization declined'); fail(new Error('ChatGPT 授权未完成')); return }
      const code = url.searchParams.get('code'), returned = url.searchParams.get('client_id'), clientId = returned ?? saved.clientId
      if (!code || !issuedClient(clientId) || (registered(saved) && clientId !== saved.clientId)) { res.writeHead(400); res.end('Invalid client registration'); fail(new Error('OpenAI 注册未完成')); return }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('浏览器授权已返回，请回到 AReaL Harness 查看登录结果。')
      settle({ code, clientId })
    })
    const listen = port => new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error) }, ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1')
    })
    const abort = () => fail(signal.reason)
    try {
      try { await listen(1455) } catch (error) { if (error.code !== 'EADDRINUSE') throw error; await listen(0) }
      signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true })
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`
      const url = new URL(config.authorization_endpoint)
      url.search = new URLSearchParams({ client_id: saved.clientId ?? 'dynamic_agent_client', ...(registered(saved) ? {} : { agent_name_hint: 'AReaL Harness' }), ext_agent_host_id: saved.hostId, response_type: 'code', redirect_uri: redirect, resource: RESOURCE, scope: SCOPES, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString()
      onAuth(url.href)
      const { code, clientId } = await callback
      const { result, value } = await this.tokens(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }), signal)
      const identity = await this.identity(result.id_token, clientId, nonce, signal)
      if (registered(saved) && identity.sub !== saved.subject) throw new Error('OpenAI 登录账号已变化')
      return { ...value, clientId, hostId: saved.hostId, subject: identity.sub, accountId: identity.sub, issuer: ISSUER, email: typeof identity.email === 'string' ? identity.email : null, idToken: result.id_token }
    } finally {
      signal.removeEventListener('abort', abort)
      if (server.listening) await new Promise(resolve => server.close(resolve))
    }
  }
  async refresh(current, { signal }) {
    const { result, value } = await this.tokens(new URLSearchParams({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refresh, resource: RESOURCE }), signal)
    if (result.id_token) {
      const identity = await this.identity(result.id_token, current.clientId, undefined, signal)
      if (identity.sub !== current.subject) throw new Error('OpenAI refresh changed account')
    }
    return { ...current, ...value, idToken: result.id_token ?? current.idToken }
  }
  async revoke(current, signal) {
    const config = await this.metadata(signal)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetch(config.revocation_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: current.refresh, token_type_hint: 'refresh_token', client_id: current.clientId }) })
        await response.body?.cancel()
        if (response.status === 200) return
        if (response.status < 500) break
      } catch { if (signal.aborted) break }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('远端授权撤销未确认')
  }
}

export class OpenAIAccount extends ChatGPTAccount {
  constructor(store, { fetch } = {}) {
    const auth = new OpenAIOAuth(fetch)
    super(store, { oauth: async (action, options) => {
      if (action === 'refresh') return auth.refresh(options.credential, options)
      const record = await store.modifyRecord(ACCOUNT_KEY, current => current ?? { kind: 'registration', payload: { hostId: `urn:uuid:${randomUUID()}` } })
      return auth.login(registration(record.payload), options)
    } })
    this.auth = auth
  }
  async read() {
    this.check(); const record = await this.store.readRecord(ACCOUNT_KEY)
    if (record?.kind !== 'grant') return null
    const c = record.payload
    if (!registered(c) || c.issuer !== ISSUER || c.type !== 'oauth' || !c.access || !c.refresh || !Number.isFinite(c.expires)) throw new Error('ChatGPT API 登录记录无效，请重新登录')
    return { type: 'openai', email: c.email ?? null, planType: null }
  }
  async logout() {
    this.check(); if (this.busy) throw new Error('账号操作进行中，请稍后重试。')
    this.busy = true; this.changed()
    try {
      await this.cancel()
      await this.store.modifyRecord(ACCOUNT_KEY, async current => {
        if (!current) return undefined
        if (current.kind === 'grant') {
          try { await this.auth.revoke(current.payload, this.lifetime.signal) }
          catch { this.error = '已退出本地账号，但远端授权撤销未确认。可在 ChatGPT 设置中断开应用。' }
        }
        return { kind: 'registration', payload: registration(current.payload) }
      })
    } finally { this.busy = false; this.changed() }
  }
  async forget() {
    this.check()
    if (this.busy || this.attempt) throw new Error('请先完成或取消当前账号操作')
    if (await this.read()) throw new Error('请先退出当前 ChatGPT API 账号')
    await this.store.modifyRecord(ACCOUNT_KEY, current => current ? { kind: 'registration', payload: { hostId: current.payload.hostId } } : undefined)
    this.error = null; this.changed()
  }
}
