import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs',
  platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  packages: 'external', sourcemap: true, legalComments: 'eof' });

await build({ absWorkingDir: root, entryPoints: ['src/upstream/browserVideoRecorderPreload.ts'], outfile: 'dist/browserVideoRecorderPreload.cjs', platform: 'node', target: 'node22', format: 'cjs', bundle: true, packages: 'external' });

await build({ absWorkingDir: root, entryPoints: ['src/electron.ts'], outfile: 'dist/electron.cjs', platform: 'node', target: 'node22', format: 'cjs', bundle: true, packages: 'external', sourcemap: true });
