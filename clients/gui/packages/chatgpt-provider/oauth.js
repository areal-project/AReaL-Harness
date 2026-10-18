import { Worker } from 'node:worker_threads'
import { oauthEnvironment } from './network.js'

// Only the OAuth library needs an isolated global fetch. No model history,
// tools, Codex process, or Agent loop runs in this worker.
export async function runOAuth(action, { credential, signal, onAuth = () => {}, environment = process.env } = {}) {
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./oauth-worker.js', import.meta.url), {
    workerData: { action, credential }, env: oauthEnvironment(environment),
    stdout: true, stderr: true,
  })
  // Upstream diagnostics must never expose token exchange bodies to logs.
  worker.stdout.resume(); worker.stderr.resume()
  let abort
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      worker.on('message', message => {
        if (message.type === 'auth') {
          try { onAuth(message.url) } catch { reject(new Error('Untrusted ChatGPT login URL')) }
        } else if (message.type === 'result') resolve(message.credential)
        else if (message.type === 'error') reject(new Error('ChatGPT authorization failed; please sign in again.'))
      })
      worker.on('error', () => reject(new Error('ChatGPT authorization worker failed')))
      worker.on('exit', () => reject(new Error('ChatGPT authorization ended before completion')))
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
