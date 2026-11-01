#!/usr/bin/env node
import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config.mjs';
import { openStore, restore } from './store.mjs';
import { serve } from './server.mjs';
import { startManagedRelay } from './managed.mjs';

process.umask(0o077);
const args = process.argv.slice(2);
const command = args.shift(); const index = args.indexOf('--config');
let store; const locks = [];
function lock(config, name) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, name); const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
  locks.push(path);
}
function unlock() { for (const path of locks.splice(0).reverse()) unlinkSync(path); }
try {
  if (process.versions.node !== '24.2.0') throw new Error('NODE_VERSION_REQUIRED_24_2_0');
  if (index < 0) throw new Error('CONFIG_REQUIRED');
  const configPath = args[index + 1];
  const config = readConfig(configPath); args.splice(index, 2);
  if (command === 'managed-serve') {
    const server = await startManagedRelay({ configPath });
    const stop = async () => { await server.close(); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    console.log(JSON.stringify({ event: 'listening' }));
  } else {
    if (command !== 'serve') lock(config, 'admin.lock');
    if (command === 'serve' || command === 'restore') lock(config, 'server.lock');
    if (command === 'restore') { console.log(JSON.stringify(restore(config, args[0]))); unlock(); }
    else {
      store = openStore(config);
      if (command === 'serve') {
        const server = await serve(config, store);
        const stop = async () => { await server.close(); store.close(); store = undefined; unlock(); process.exit(0); };
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
        console.log(JSON.stringify({ event: 'listening' }));
      } else {
        if (command === 'provision' && (args.length !== 2 || args[0] !== '--room')) throw new Error('ROOM_REQUIRED');
        const result = command === 'provision' ? store.provision(args[1]) : command === 'enrollment' ? store.enrollment() : command === 'revoke' ? store.revoke(args[0]) : command === 'backup' ? await store.backup(args[0]) : (() => { throw new Error('INVALID_COMMAND'); })();
        console.log(JSON.stringify(result)); store.close(); store = undefined; unlock();
      }
    }
  }
} catch (error) {
  store?.close(); unlock();
  // 外部输入和原始系统异常不进入日志。
  console.error(JSON.stringify({ error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED' })); process.exitCode = 1;
}
