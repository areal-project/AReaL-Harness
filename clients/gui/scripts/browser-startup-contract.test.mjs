import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCoreChild } from './browser-startup.mjs';

const surface = { BrowserWindow: { getAllWindows: () => [] }, screen: { getAllDisplays: () => [] } };
test('startup probe records real child identity and excludes configuration output', async t => {
  const home = await mkdtemp(join(tmpdir(), 'browser-startup-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = join(home, 'fixture.cjs');
  await writeFile(script, 'process.stdin.resume(); process.stdin.on("end",()=>console.log(JSON.stringify({home:process.env.HOME,secret:"SYNTHETIC_SECRET"})))');
  const result = await probeCoreChild(surface, { binary: process.execPath, userHome: home,
    argv: [script] });
  assert.equal(result.status, 'completed');
  assert.ok(result.pid > 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.match(result.binarySHA256, /^[a-f0-9]{64}$/);
  assert.equal(result.home, home);
  assert.equal(result.desktop.unlocked, 'unverified');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
});

test('a killed child is blocked startup with signal, not exit zero or Browser failure', async () => {
  const result = await probeCoreChild(surface, { binary: process.execPath, userHome: tmpdir(),
    argv: ['-e', 'process.kill(process.pid, "SIGKILL")'] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
});

test('invalid JSON and timeouts cannot become a successful startup', async () => {
  const invalid = await probeCoreChild(surface, { binary: process.execPath, userHome: tmpdir(),
    argv: ['-e', 'console.log("not configuration JSON")'] });
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.reason, 'invalid_config_output');
  const timeout = await probeCoreChild(surface, { binary: process.execPath, userHome: tmpdir(),
    argv: ['-e', 'setInterval(()=>{}, 1000)'], timeoutMs: 100 });
  assert.equal(timeout.status, 'blocked');
  assert.equal(timeout.timedOut, true);
});
