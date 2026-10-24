import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const electron = process.env.ELECTRON_EXECUTABLE || require('electron');
const scratch = mkdtempSync(join(tmpdir(), 'areal-shared-profile-'));
let controlHits = 0;
const server = createServer((req, res) => {
  if (req.url === '/set') res.setHeader('set-cookie', 'profile-fixture=synthetic; HttpOnly; Path=/; Max-Age=3600; SameSite=Lax');
  if (req.url === '/cookie') { res.end(req.headers.cookie ?? ''); return; }
  if (req.url === '/download') { res.setHeader('content-disposition','attachment; filename="shared.txt"'); res.end('shared profile download'); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>Shared Profile fixture</title><a id="download" style="display:block;padding:20px" href="/download" download>Download</a>');
});
const control = createServer((_req, res) => { controlHits++; res.end('product endpoint must stay unreachable'); });
await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => control.listen(0, '127.0.0.1', resolve))]);
const origin = `http://127.0.0.1:${server.address().port}`, controlOrigin = `http://127.0.0.1:${control.address().port}`;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  for (const phase of ['seed', 'isolated', 'restore']) {
    const profile = join(scratch, phase === 'isolated' ? 'isolated-profile' : 'profile');
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [fileURLToPath(new URL('./shared-profile.cjs', import.meta.url)), phase, profile, origin, controlOrigin, scratch], { stdio: 'inherit', env });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Shared Profile ${phase} exited ${code}`)));
    });
  }
  assert.equal(controlHits, 0);
  writeFileSync(join(scratch,'RESULT.json'), JSON.stringify({ phases:['seed','isolated','restore'],controlHits,scratch },null,2));
  console.log('PASS '+join(scratch,'RESULT.json'));
} finally { server.close(); control.close(); }
