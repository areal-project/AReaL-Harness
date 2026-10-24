import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = process.argv.includes('--fixtures');
await build({
  absWorkingDir: root,
  entryPoints: [fixtures ? 'acceptance/source.ts' : 'src/index.ts'],
  outfile: join(root, fixtures ? '.acceptance/source.cjs' : 'dist/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'ws'],
  logLevel: 'info',
});
