import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { serve } from './server.mjs';
import { startTlsProxy } from './tls.mjs';

export function acquireManagedLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const guard = join(dataDir, 'server.lock.guard');
  const path = join(dataDir, 'server.lock');
  try { mkdirSync(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('SERVER_LOCK_CHECK_REQUIRED');
    throw error;
  }
  try {
    let pid;
    try { pid = readFileSync(path, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pid !== undefined) {
      if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('SERVER_LOCK_INVALID');
      try { process.kill(Number(pid), 0); throw new Error('SERVER_ALREADY_RUNNING'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      unlinkSync(path);
    }
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
  } finally { rmdirSync(guard); }
  return () => { unlinkSync(path); };
}

export async function startManagedRelay({ configPath, tls = {} }) {
  const config = readConfig(configPath);
  if (config.development) throw new Error('MANAGED_REQUIRES_HTTPS');
  const unlock = acquireManagedLock(config.dataDir);
  let store;
  let backend;
  let proxy;
  let closing;
  const close = () => closing ??= (async () => {
    try { await proxy?.close(); } finally {
      try { await backend?.close(); } finally { store?.close(); unlock(); }
    }
  })();
  try {
    store = openStore(config);
    backend = await serve(config, store);
    proxy = await startTlsProxy({ port: Number(new URL(config.publicOrigin).port) || 443, ...tls, publicOrigin: config.publicOrigin,
      upstreamHost: config.listenHost, upstreamPort: config.listenPort,
      dataDir: config.dataDir });
    return { close, proxy };
  } catch (error) { await close(); throw error; }
}
