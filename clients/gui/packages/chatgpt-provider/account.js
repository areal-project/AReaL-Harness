import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runOAuth } from './oauth.js'

// 账号记录键由此适配器拥有；保留已有格式而不引入其他执行后端。
export const ACCOUNT_KEY = 'areal-chatgpt/subscription'
export function loginUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Untrusted ChatGPT login URL')
  }
  return url.href
}
function credential(record) {
  const value = record?.kind === 'grant' ? record.payload : undefined
  if (!value) return undefined
  if (value.type !== 'oauth' || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh || !Number.isFinite(value.expires)) {
    throw new Error('Invalid stored ChatGPT credential; sign in again')
  }
  return value
}
function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { return {} }
}
export class ChatGPTAccount extends EventEmitter {
  constructor(store, { oauth = runOAuth, loginTimeoutMs = 10 * 60 * 1000 } = {}) {
    super()
    this.store = store
    this.oauth = oauth
    this.loginTimeoutMs = loginTimeoutMs
    this.revision = 0
    this.login = null
    this.error = null
    this.busy = false
    this.lifetime = new AbortController()
    this.active = new Set()
    this.models = async () => []
  }
  changed() { this.revision++; this.emit('changed') }
  check() { this.lifetime.signal.throwIfAborted() }
  track(promise) {
    this.active.add(promise)
    promise.then(() => this.active.delete(promise), () => this.active.delete(promise))
    return promise
  }
  async begin() {
    this.check()
    if (this.attempt) return this.attempt.ready
    if (this.busy) throw new Error('账号操作进行中，请稍后重试。')
    this.error = null
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const attempt = { controller, loginId: randomUUID() }
    attempt.ready = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject })
    this.attempt = attempt
    attempt.timer = setTimeout(() => {
      this.error = '登录已超时，请重试。'
      controller.abort(new Error('Login timed out'))
    }, this.loginTimeoutMs)
    attempt.timer.unref?.()
    attempt.done = this.track((async () => {
      try {
        const value = await this.oauth('login', { signal, onAuth: url => {
          signal.throwIfAborted()
          this.login = { loginId: attempt.loginId, authUrl: loginUrl(url) }
          attempt.resolve(this.login)
        } })
        signal.throwIfAborted()
        credential({ kind: 'grant', payload: value })
        await this.store.modifyRecord(ACCOUNT_KEY, async () => {
          signal.throwIfAborted()
          return { kind: 'grant', payload: value }
        })
        this.changed()
      } catch {
        if (!signal.aborted) this.error = 'ChatGPT 授权未完成或已失败，请重试。'
        attempt.reject(new Error(this.error || 'ChatGPT 登录已取消。'))
      } finally {
        clearTimeout(attempt.timer)
        if (this.attempt === attempt) { this.attempt = null; this.login = null }
        // Also settle a failed flow that never supplied an authorization URL.
        attempt.reject(new Error('ChatGPT 登录已结束。'))
      }
    })())
    return attempt.ready
  }
  async cancel() {
    const attempt = this.attempt
    attempt?.controller.abort(new Error('Login cancelled'))
    await attempt?.done
    this.error = null
  }
  async logout() {
    this.check()
    if (this.busy) throw new Error('账号操作进行中，请稍后重试。')
    this.busy = true
    this.changed()
    try {
      await this.cancel()
      await this.store.deleteRecord(ACCOUNT_KEY)
      this.error = null
    } finally { this.busy = false; this.changed() }
  }
  async read() {
    this.check()
    const value = credential(await this.store.readRecord(ACCOUNT_KEY))
    if (!value) return null
    const payload = claims(value.access)
    // JWT claims are display hints only; the provider validates the credential.
    return { type: 'chatgpt', email: payload.email ?? payload['https://api.openai.com/profile']?.email ?? null,
      planType: payload['https://api.openai.com/auth']?.chatgpt_plan_type ?? null }
  }
  async accessToken(signal) {
    this.check()
    if (this.busy) throw new Error('ChatGPT account is changing')
    const revision = this.revision
    const cancellation = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const record = await this.track(this.store.modifyRecord(ACCOUNT_KEY, async current => {
      cancellation.throwIfAborted()
      const value = credential(current)
      if (!value) throw new Error('请在设置 → ChatGPT Subscription 重新登录。')
      if (value.expires > Date.now() + 60_000) return undefined
      // A completed rotation must be saved even if the requesting turn is cancelled.
      const next = await this.oauth('refresh', { credential: value, signal: this.lifetime.signal })
      credential({ kind: 'grant', payload: next })
      if (next.accountId !== value.accountId) throw new Error('ChatGPT refresh changed account')
      return { kind: 'grant', payload: next }
    }))
    cancellation.throwIfAborted()
    if (revision !== this.revision || this.busy) throw new Error('ChatGPT account changed; retry explicitly')
    return credential(record).access
  }
  async status() {
    const account = await this.read()
    let models = [], modelError = null
    if (account) {
      try { models = await this.models() }
      catch { modelError = '无法获取账号模型，请检查网络或重新登录后刷新。' }
    }
    return {
      authenticated: !!account, email: account?.email ?? null, planType: account?.planType ?? null,
      login: this.login, error: this.error, modelError, models,
    }
  }
  async close() {
    if (this.lifetime.signal.aborted) return
    this.changed()
    this.lifetime.abort(new Error('ChatGPT provider closed'))
    await Promise.allSettled([...this.active])
  }
}
