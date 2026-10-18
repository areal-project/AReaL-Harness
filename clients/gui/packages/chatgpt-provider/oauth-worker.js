import { parentPort, workerData } from 'node:worker_threads'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { subscriptionNetwork } from './network.js'

const network = subscriptionNetwork()
globalThis.fetch = network.fetch
const oauth = openaiCodexProvider().auth.oauth
const signal = new AbortController().signal
try {
  const credential = workerData.action === 'refresh'
    ? await oauth.refresh(workerData.credential, signal)
    : await oauth.login({
      signal,
      notify(event) {
        if (event.type === 'auth_url') parentPort.postMessage({ type: 'auth', url: event.url })
      },
      prompt(prompt) {
        // The existing desktop flow uses the local browser callback only.
        if (prompt.type === 'select') return Promise.resolve('browser')
        return new Promise((_, reject) => {
          const abort = () => reject(new Error('Authorization cancelled'))
          prompt.signal?.addEventListener('abort', abort, { once: true })
          if (prompt.signal?.aborted) abort()
        })
      },
    })
  parentPort.postMessage({ type: 'result', credential })
} catch {
  parentPort.postMessage({ type: 'error' })
} finally {
  network.close()
}
