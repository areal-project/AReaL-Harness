import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { build } = await import('esbuild');
await build({ entryPoints: [join(root, 'acceptance/source.ts')], outfile: join(root, '.acceptance/source.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'ws'] });
const fixtureRoot = await mkdtemp(join(tmpdir(), 'areal-browser-data-electron-'));
const env = { ...process.env, AREAL_BROWSER_DATA_FIXTURE_ROOT: fixtureRoot };
delete env.ELECTRON_RUN_AS_NODE;
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [join(root, 'acceptance/electron.cjs')], { stdio: 'inherit', env });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('browser_data_fixture_timeout')); }, 60_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); resolve(code ?? 1); });
  });
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
