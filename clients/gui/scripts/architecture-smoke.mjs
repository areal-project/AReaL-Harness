import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

// 通过产品 preload/Main/Core 验证契约，并直接观察真实原生 WebContents。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-architecture-');
const workspace = join(scratch, 'workspace');
await mkdir(workspace); await mkdir(join(scratch, 'user', '.areal'), { recursive: true });
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<html><body><h1>ARCHITECTURE_PREVIEW</h1></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/preview`;
const config = join(scratch, 'user', '.areal', 'config.toml');
await writeFile(config, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Complete the task' }] }));
const env = { ...process.env, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, '../../target/debug/areal'),
  AREAL_CORE_HOME: join(scratch, 'core'), AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_USER_HOME: join(scratch, 'user'), AREAL_GUI_USER_DATA: join(scratch, 'electron'),
  AREAL_CORE_DESKTOP_CONFIG: deployment };
delete env.AREAL_CORE_WORKSPACE;
delete env.AREAL_CORE_CONFIG;
delete env.AREAL_HARNESS_CONFIG;
delete env.AREAL_HARNESS_HOME;
let app, page, passed = false;
const checks = [], errors = [];
async function until(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timeout: ${label}`);
}
const raw = (name, params) => page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
async function call(name, params) { const result = await raw(name, params); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
const preview = request => page.evaluate(request => window.arealDesktop.preview(request), request);
const natives = () => app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents()
  .filter(content => content.getURL().startsWith(prefix)).map(content => ({ id: content.id, url: content.getURL() })), url);
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-testid=areal-workbench]').waitFor({ timeout: 120000 });
  await until(async () => (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === 'ready', 'background Core ready');
  const providers = await call('providers', { operation: 'list' });
  assert.equal(providers.path, config, 'real desktop IPC reads the default user Core configuration');
  assert.equal(providers.data[0].id, 'fixture');
  await assert.rejects(() => readFile(join(scratch, 'registry', 'config.toml')), { code: 'ENOENT' });
  checks.push('real Electron IPC reads the global Core provider catalog without a config override');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, workspace);
  const projectId = await page.evaluate(() => window.arealDesktop.chooseProject());
  const create = () => call('create', { projectId, profile: { id: 'fixture', revision: 'v1' } });
  const { threadId } = await create();
  for (const [name, params] of [['not-a-command', {}], ['open', []], ['configure', { projectId, threadId, model: { providerId: 'fixture' } }]]) {
    const result = await raw(name, params);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_DESKTOP_REQUEST');
  }
  const coreError = await raw('open', { projectId, threadId: 'missing-thread' });
  assert.equal(coreError.ok, false); assert.equal(typeof coreError.error.code, 'number');
  await call('configure', { projectId, threadId, parameters: {} });
  checks.push('real IPC rejects malformed capability requests and preserves numeric Core error codes');
  await preview({ operation: 'navigate', projectId, threadId, url });
  await preview({ operation: 'show', projectId, threadId, visible: true, bounds: { x: 0, y: 80, width: 400, height: 300 } });
  await until(async () => (await natives()).some(content => content.url === url), 'first native page');
  const original = (await natives()).find(content => content.url === url).id;
  const owners = [];
  for (let index = 0; index < 10; index++) {
    const owner = await create(); owners.push(owner.threadId);
    await preview({ operation: 'navigate', projectId, threadId: owner.threadId, url: `${url}?page=${index}` });
  }
  await until(async () => (await natives()).length === 8, 'bounded native page cache');
  assert.ok((await natives()).some(content => content.id === original), 'current native page is protected from eviction');
  await preview({ operation: 'show', projectId, threadId: owners[0], url: `${url}?page=0`, visible: false });
  await until(async () => (await natives()).some(content => content.url === `${url}?page=0`), 'evicted owner URL restores');
  const restored = (await natives()).find(content => content.url === `${url}?page=0`).id;
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), restored);
  await until(async () => !!(await preview({ operation: 'state', projectId, threadId: owners[0] })).error, 'renderer crash observed');
  await preview({ operation: 'reload', projectId, threadId: owners[0] });
  await until(async () => (await natives()).some(content => content.url === `${url}?page=0` && content.id !== restored), 'crashed preview rebuilt');
  const content = await app.evaluate(async ({ webContents }, target) => {
    const page = webContents.getAllWebContents().find(content => content.getURL() === target);
    return { text: await page.executeJavaScript('document.body.innerText'), bridge: await page.executeJavaScript('typeof window.arealDesktop'), image: (await page.capturePage()).toPNG().toString('base64') };
  }, `${url}?page=0`);
  assert.match(content.text, /ARCHITECTURE_PREVIEW/); assert.equal(content.bridge, 'undefined');
  await writeFile(join(scratch, 'native-preview.png'), Buffer.from(content.image, 'base64'));
  checks.push('native pages stay bounded, protect the current owner, and restore evicted/crashed pages without a product bridge');
  await call('manage', { operation: 'archive', projectId, threadId: owners[0] });
  await until(async () => !(await natives()).some(content => content.url === `${url}?page=0`), 'archived owner releases its native page');
  await until(async () => (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(project => project.id === projectId)?.state?.threads[owners[0]]?.desktop?.archived, 'archive snapshot');
  await assert.rejects(() => preview({ operation: 'show', projectId, threadId: owners[0], url: `${url}?page=0` }));
  await call('library', { operation: 'hideProject', projectId, hidden: true });
  await until(async () => (await natives()).length === 0, 'hidden project releases all native pages');
  await until(async () => (await page.evaluate(() => window.arealDesktop.snapshot())).library.projects[projectId]?.hidden, 'hidden project snapshot');
  await assert.rejects(() => preview({ operation: 'show', projectId, threadId, url }));
  checks.push('archive and project hiding release native resources through the product command path');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (app) { await call('stopService', {}).catch(() => {}); await app.close(); }
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, scope: 'source Electron/Core/Runtime capability and native resource integration' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
