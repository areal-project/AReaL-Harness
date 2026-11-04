import { randomUUID } from 'node:crypto';
import { open, lstat, mkdir, unlink } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { serve } from './server.mjs';

process.umask(0o077);
let input = Buffer.alloc(0),
  started = false,
  ended = false,
  server,
  store,
  lock,
  lockPath,
  lockIdentity;
let finishing,
  failed = false;
async function finish() {
  if (finishing) return finishing;
  ended = true;
  finishing = (async () => {
    try {
      if (server) await server.close();
    } catch {
      failed = true;
    }
    try {
      store?.close();
    } catch {
      failed = true;
    }
    if (lock) {
      try {
        const current = await lstat(lockPath);
        if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino)
          throw new Error('LOCK_CHANGED');
        await unlink(lockPath);
      } catch {
        failed = true;
      }
      try {
        await lock.close();
      } catch {
        failed = true;
      }
    }
    if (failed) process.stderr.write('RELAY_HOST_FAILED\n');
    process.exitCode = failed ? 1 : 0;
    process.stdin.destroy();
  })();
  return finishing;
}
async function start(frame) {
  try {
    if (
      !frame ||
      frame.version !== 1 ||
      Object.keys(frame).sort().join(',') !== 'config,room,version' ||
      !frame.config ||
      frame.config.local !== true ||
      typeof frame.room !== 'string' ||
      !/^[a-f0-9]{64}$/.test(frame.room)
    )
      throw new Error('INVALID_FRAME');
    const lease = Number(process.env.AREAL_LOCAL_RELAY_LEASE_FD);
    if (!Number.isSafeInteger(lease) || lease < 3 || !fstatSync(lease).isFile())
      throw new Error('INVALID_LEASE');
    const config = parseConfig(frame.config);
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    lockPath = join(config.dataDir, 'server.lock');
    lock = await open(lockPath, 'wx', 0o600);
    lockIdentity = await lock.stat();
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + '\n');
    if (ended) return await finish();
    store = openStore(config);
    store.provision(frame.room);
    if (ended) return await finish();
    server = await serve(config, store, undefined, (entry) =>
      process.stderr.write(JSON.stringify(entry) + '\n'),
    );
    if (ended) return await finish();
    process.stdout.write(JSON.stringify({ version: 1, event: 'ready' }) + '\n');
  } catch {
    failed = true;
    await finish();
  }
}
const stop = (error = false) => {
  ended = true;
  failed ||= error;
  if (!started || server) void finish();
};
process.stdin.on('data', (chunk) => {
  if (started) return stop(true);
  input = Buffer.concat([input, chunk]);
  if (input.length > 65536) return stop(true);
  const end = input.indexOf(10);
  if (end < 0) return;
  if (end !== input.length - 1) return stop(true);
  started = true;
  try {
    void start(JSON.parse(input.subarray(0, end).toString('utf8')));
  } catch {
    failed = true;
    void finish();
  }
});
process.stdin.on('end', () => stop(!started));
process.stdin.on('error', () => stop(true));
process.once('SIGTERM', () => stop());
process.once('SIGINT', () => stop());
