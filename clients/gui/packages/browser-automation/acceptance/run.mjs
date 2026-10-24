import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const electron = process.env.ELECTRON_EXECUTABLE || require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [fileURLToPath(new URL('./preview-integration.cjs', import.meta.url))], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 1));
