import nodeFetch from 'node-fetch'
import { ProxyAgent } from 'proxy-agent'
import { ReadableStream } from 'node:stream/web'
import { getCACertificates } from 'node:tls'

// A request-owned agent: never change DSH's global fetch or proxy environment.
// proxy-agent handles the inherited HTTP(S)/ALL_PROXY and NO_PROXY settings.
export function subscriptionNetwork(source = process.env) {
  const systemProxy = source.AREAL_CHATGPT_SYSTEM_PROXY
  // Electron's Node transport does not automatically use macOS Keychain roots.
  // Keep bundled/extra roots and add OS-trusted roots, scoped to this provider.
  // Never disable peer or hostname verification or mutate global TLS defaults.
  const ca = [...new Set([...getCACertificates('default'), ...getCACertificates('system')])]
  const agent = new ProxyAgent({ ca, ...(systemProxy ? { getProxyForUrl: url => {
    const host = new URL(url).hostname
    if (systemProxy === 'DIRECT' || ['localhost', '127.0.0.1', '[::1]'].includes(host)) return ''
    return systemProxy
  } } : {}) })
  return {
    async fetch(url, init = {}) {
      if (source.AREAL_CHATGPT_PROXY_ERROR) throw new Error('ChatGPT proxy unavailable')
      const response = await nodeFetch(url, { ...init, agent, redirect: 'error' })
      // Pull through the iterator: toWeb's data listener can enqueue after cancel.
      // Explicitly destroy on return, including cancellation before the first read.
      const body = response.body && ReadableStream.from({
        [Symbol.asyncIterator]() {
          const iterator = response.body[Symbol.asyncIterator]()
          return {
            next: () => iterator.next(),
            return: () => { response.body.destroy(); return iterator.return() },
          }
        },
      })
      return new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      })
    },
    close() { agent.destroy() },
  }
}

export function oauthEnvironment(source = process.env) {
  const env = { ...source, PI_OAUTH_CALLBACK_HOST: '127.0.0.1' }
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|CODEX_|AREAL_DESKTOP_BRIDGE_)/.test(key)) delete env[key]
  }
  return env
}
