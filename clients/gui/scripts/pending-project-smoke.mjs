import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationFixture } from './application-fixture.mjs';
import { assertApplicationStopped, closeSmokeApplication } from './application-cleanup.mjs';
import { captureSmokeFailure, createProjectConversation } from './smoke-navigation.mjs';
import { respondToSessionName } from './model-fixture.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary?.startsWith(join(root, '.local/dev-bin/')), 'Use this checkout’s private fixed Core slot');
assert.ok(!process.env.AREAL_GUI_EXECUTABLE, 'This runner validates source Electron');
const red = process.argv.includes('--red');
const scratch = await mkdtemp('/private/tmp/apending-');
await mkdir(join(root, '.scratch/pending-project'), { recursive: true });
const evidence = await mkdtemp(join(root, '.scratch/pending-project/run-'));
const workspace = join(scratch, 'workspace'), execution = join(scratch, 'legacy-worktree');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const projectId = sha(workspace).slice(0, 24), executionProjectId = sha(execution).slice(0, 24);
const requestId = randomUUID();
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const checks = [], requests = [], errors = [];
const until = async (read, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(`Timeout: ${label}`);
};
await mkdir(join(workspace, '.agents/plugins'), { recursive: true });
const pluginRoot = join(workspace, 'packages/pending-fixture');
await mkdir(join(pluginRoot, 'skills/proof'), { recursive: true });
await json(join(pluginRoot, 'plugin.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'pending-fixture', version: '1.0.0', description: 'Pending project acceptance' });
await writeFile(join(pluginRoot, 'skills/proof/SKILL.md'), '---\nname: pending-proof\ndescription: Pending project proof skill\n---\nPENDING_SKILL_BODY\n');
await json(join(workspace, '.agents/plugins/marketplace.json'), { name: 'pending-market', plugins: [{ name: 'pending-fixture', source: { source: 'local', path: './packages/pending-fixture' } }] });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['worktree', 'add', '-b', 'legacy-fixture', execution], { cwd: workspace, stdio: 'ignore' });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
Object.assign(env, { AREAL_CORE_BIN: binary, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: join(scratch, 'user'), AREAL_HARNESS_HOME: join(scratch, 'config-home'),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'), AREAL_CORE_CONFIG: join(scratch, 'config.toml') });
for (const directory of [env.AREAL_CORE_HOME, env.AREAL_CORE_USER_HOME, join(env.AREAL_CORE_HOME, 'worktree-requests')]) await mkdir(directory, { recursive: true });
const pending = [{ method: 'areal/thread/start', params: { requestId, cwd: execution, model: { providerId: 'fixture', modelId: 'fixture' } },
  operation: { method: 'areal/thread/start', requestId, target: { kind: 'project' } }, at: '2026-01-01T00:00:00.000Z' }];
const binding = { kind: 'thread', requestId, projectId, executionProjectId, state: 'binding', intent: 'continue',
  parameters: { worktree: { mode: 'worktree' } }, sourceRoot: workspace, createdAt: '2026-01-01T00:00:00.000Z', automatic: false, events: [],
  record: { directory: execution, cwd: execution, branch: 'legacy-fixture' } };
await json(join(env.AREAL_CORE_HOME, 'projects.json'), [{ id: projectId, root: workspace }, { id: executionProjectId, root: execution, logicalProjectId: projectId, worktreeRequestId: requestId }]);
const pendingPath = join(env.AREAL_CORE_HOME, `${executionProjectId}-pending.json`);
const bindingPath = join(env.AREAL_CORE_HOME, 'worktree-requests', `${requestId}.json`);
await json(pendingPath, pending); await json(bindingPath, binding);
const model = createServer(async (req, res) => {
  let raw = ''; for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, res)) return;
  requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'PENDING_PROJECT_OK' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(env.AREAL_CORE_CONFIG, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const tracePath = join(evidence, 'core-calls.jsonl');
await writeFile(tracePath, '');
const application = await applicationFixture(gui, join(scratch, 'app'), `
if (process.argv.includes('--areal-core-service')) {
  const { CoreBackend } = require(${JSON.stringify(join(gui, 'app/src/core/backend.cjs'))});
  const trace = value => require('node:fs').appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + '\\n');
  const execute = CoreBackend.prototype.executeCommand;
  CoreBackend.prototype.executeCommand = async function(name, request, ...args) {
    trace({ kind: 'desktop-command', name, request });
    const result = await execute.call(this, name, request, ...args);
    trace({ kind: 'desktop-result', name, request });
    return result;
  };
  const connect = CoreBackend.prototype.connect;
  CoreBackend.prototype.connect = async function(project, ...args) {
    const result = await connect.call(this, project, ...args);
    if (!project.client.__pendingTrace) {
      const request = project.client.request.bind(project.client);
      project.client.request = (method, params, ...options) => {
        trace({ owner: project.id, method, params });
        return request(method, params, ...options);
      };
      project.client.__pendingTrace = true;
    }
    return result;
  };
}
`);
const manifest = { red, passed: false, checks, errors, scratch, evidence, requestId, projectId, executionProjectId,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  helperSHA256: sha(await readFile(fileURLToPath(import.meta.url))),
  diffSHA256: sha(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })), binary, coreSHA256: sha(await readFile(binary)),
  fixtureBoundary: 'Synthetic legacy pending journal, registered linked worktree owner, and binding seeded before startup; no original mutation was executed. Native project picker, retention confirmation and quit confirmation injected. Core request tracer forwards every real response unchanged.',
  scope: 'Source Electron Renderer → preload/Main → Desktop → real Core with deterministic local model; no real provider, package, physical input or native picker acceptance' };
const assets = (await readdir(join(gui, 'renderer/dist/assets'))).filter(name => /\.(js|css)$/.test(name));
manifest.rendererSHA256 = Object.fromEntries(await Promise.all(assets.map(async name => [name, sha(await readFile(join(gui, 'renderer/dist/assets', name)))])));
console.log(`Pending project evidence: ${evidence}`);
let app, page, metadata, failure, stderr = '';
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const logical = snapshot => snapshot.projects.find(project => project.id === projectId);
const button = name => page.getByRole('button', { name, exact: true });
const call = async (name, params) => {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.ok(result.ok, JSON.stringify(result)); return result.value;
};
const trace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const capture = async name => {
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
  await json(join(evidence, `${name}.snapshot.json`), await state());
};
try {
  app = await electron.launch({ executablePath: require('electron'), args: [application.path], env, timeout: 120000 });
  app.process().stderr?.on('data', bytes => { stderr += bytes; });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'Desktop ready');
  await app.evaluate(({ dialog, BrowserWindow }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await until(async () => logical(await state())?.state?.connected, 'logical Core ready');
  await call('reconcile', { projectId, requestId });
  await until(async () => logical(await state())?.pending.some(entry => entry.params?.requestId === requestId), 'legacy pending aggregated');
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, 'service.json'), 'utf8'));
  await json(join(evidence, 'runtime.json'), { mainPid: app.process().pid, desktopPid: metadata.pid, profile: env.AREAL_GUI_USER_DATA });
  await page.evaluate(() => localStorage.setItem('areal-gui:application-preferences', JSON.stringify({ nextPromptSuggestions: false })));
  await page.reload();
  await until(async () => (await state()).connection?.state === 'ready' && logical(await state())?.state?.connected, 'reloaded isolated preferences');
  if (process.env.AREAL_PENDING_SCHEDULE_RECOVERY === '1') {
    const scheduleDraft = { prepareId: randomUUID(), requestId, projectId, pending: true, text: 'Retained schedule intent' };
    await page.evaluate(draft => localStorage.setItem('areal-gui:ordinary-schedule-creation', JSON.stringify(draft)), scheduleDraft);
    await button('定时任务').click();
    const checkStart = (await trace()).length;
    await button('新建自动化').click();
    await until(async () => (await trace()).slice(checkStart).some(call => call.kind === 'desktop-result' && call.name === 'reconcile'), 'schedule original request checked');
    const scheduleCheck = (await trace()).slice(checkStart).find(call => call.kind === 'desktop-command' && call.name === 'reconcile');
    assert.equal(scheduleCheck.request.requestId, requestId, 'Schedule recovery must reconcile the original request identity');
    const leave = button('保留原记录，返回任务列表');
    await leave.waitFor();
    await capture('schedule-unknown');
    await page.evaluate(() => { window.confirm = message => { window.__retainedCreationPrompt = message; return true; }; });
    await leave.click();
    const retained = await page.evaluate(id => ({ active: localStorage.getItem('areal-gui:ordinary-schedule-creation'), retained: JSON.parse(localStorage.getItem(`areal-gui:retained-schedule-creation:${id}`) ?? 'null') }), requestId);
    assert.equal(retained.active, null, 'Leaving recovery releases only the active draft slot');
    assert.deepEqual(retained.retained, scheduleDraft, 'Original frozen schedule draft remains inspectable');
    assert.ok(!(await trace()).slice(checkStart).some(call => call.kind === 'desktop-command' && call.name === 'create'), 'Leaving unknown creation never creates or replays a request');
    await button('新建自动化').click();
    await page.getByTestId('chat-input').waitFor();
    await until(async () => (await page.getByTestId('chat-input').innerText()).includes('帮我创建一个定时任务'), 'fresh schedule conversation opens');
    const creates = (await trace()).slice(checkStart).filter(call => call.kind === 'desktop-command' && call.name === 'create');
    assert.equal(creates.length, 1, 'Explicit new schedule creates exactly one new conversation');
    assert.notEqual(creates[0].request.requestId, requestId, 'Fresh schedule uses a new identity');
    assert.equal(requests.length, 0, 'Recovery and opening a new schedule do not send the retained intent');
    await capture('schedule-fresh');
    checks.push('Unknown schedule can be retained without replay; explicit new creation opens a new real Core conversation');
  }
  await createProjectConversation(page, 'workspace');
  const workspaceSettings = button('新会话工作区');
  await capture('00-workspace-settings');
  assert.equal(await workspaceSettings.isEnabled(), true, 'Unrelated retained creation must not disable new-chat workspace settings');
  await workspaceSettings.click();
  const worktreeToggle = page.getByRole('switch', { name: '在新 Worktree 中工作', exact: true });
  await worktreeToggle.waitFor();
  assert.equal(await worktreeToggle.isChecked(), false, 'Opening settings keeps worktree opt-in');
  await page.keyboard.press('Escape');
  checks.push('New-chat workspace settings open with unrelated retained creation; worktree stays off');
  await page.getByTestId('chat-input').fill('Independent fresh draft');
  const draftEnabled = await button('发送').isEnabled();
  await capture('01-fresh-draft');
  manifest.draftEnabled = draftEnabled;
  const pluginId = 'pending-fixture@pending-market';
  const catalog = await call('manage', { projectId, operation: 'plugins' });
  await json(join(evidence, 'plugin-catalog.json'), catalog);
  const candidate = catalog.data.find(row => row.id === pluginId);
  assert.ok(candidate, 'Real Core discovers local plugin');
  await call('manage', { projectId, operation: 'pluginInstall', id: pluginId, scope: 'project', expectedRevision: catalog.revision,
    source: candidate.source, expectedDigest: candidate.sourceDigest });
  await page.getByRole('navigation', { name: '应用导航', exact: true }).getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tablist', { name: '市场范围', exact: true }).getByRole('tab', { name: '个人', exact: true }).click();
  await button(`查看插件 ${pluginId}`).click();
  await button('管理').click();
  const skillSwitch = page.getByRole('switch', { name: '在当前项目启用 Skill pending-proof', exact: true });
  await skillSwitch.waitFor();
  manifest.skillEnabled = await skillSwitch.isEnabled();
  await capture('02-plugin-management');
  assert.equal(await button('核对项目操作').isVisible(), false, 'Unrelated historical creation recovery is collapsed in plugin management');
  await page.getByText('历史会话创建记录（待核对）', { exact: true }).click();
  const beforeCheck = (await trace()).length;
  await button('核对项目操作').click();
  await until(async () => (await trace()).slice(beforeCheck).some(call => call.kind === 'desktop-result' && call.name === 'reconcile'), 'explicit GUI reconciliation complete');
  await until(async () => !(await button('正在核对项目操作…').count()), 'project check complete');
  await capture('03-checked-unknown');
  const checkCalls = (await trace()).slice(beforeCheck);
  await json(join(evidence, 'project-check-calls.json'), checkCalls);
  const explicitCheck = checkCalls.find(call => call.kind === 'desktop-command' && call.name === 'reconcile');
  manifest.explicitCheck = explicitCheck;
  manifest.checkOwners = checkCalls.filter(call => call.method === 'areal/request/read' && call.params?.requestId === requestId).map(call => call.owner);
  if (red) {
    assert.equal(draftEnabled, false, 'Baseline reproduces unrelated legacy pending blocking draft send');
    assert.equal(manifest.skillEnabled, false, 'Baseline reproduces unrelated legacy pending blocking Skill configuration');
    assert.equal(explicitCheck.request.requestId, undefined, 'Baseline GUI check omits original request identity');
    checks.push('RED reproduced draft and Skill project-wide locks on real Electron/Core');
  } else {
    await page.getByText('已核对，原操作仍未确认。未重新提交。', { exact: true }).waitFor();
    assert.equal(draftEnabled, true, 'Independent fresh draft can send despite legacy pending');
    assert.equal(manifest.skillEnabled, true, 'Skill setting can change despite unrelated creation');
    assert.equal(explicitCheck.request.requestId, requestId, 'GUI reconciliation carries original request identity');
    assert.ok(manifest.checkOwners.includes(executionProjectId), 'Original request read reaches original execution owner');
    assert.ok(!manifest.checkOwners.includes(projectId), 'Original receipt is never read from logical owner');
    await skillSwitch.click();
    await until(async () => !(await skillSwitch.isChecked()), 'Skill disabled through GUI');
    let detail = await call('manage', { projectId, operation: 'plugin', id: pluginId });
    assert.ok(detail.componentChoices.disabledSkills.includes(detail.installedSkills[0].id), 'Core readback confirms disabled Skill');
    await skillSwitch.click();
    await until(async () => skillSwitch.isChecked(), 'Skill reenabled through GUI');
    detail = await call('manage', { projectId, operation: 'plugin', id: pluginId });
    assert.deepEqual(detail.componentChoices.disabledSkills, [], 'Core readback confirms enabled Skill');
    checks.push('GUI Skill disable and enable persist through real Core with legacy UNKNOWN retained');
    await button('返回应用').click();
    const expandSidebar = button('展开侧栏');
    if (await expandSidebar.isVisible()) await expandSidebar.click();
    await createProjectConversation(page, 'workspace');
    await page.getByTestId('chat-input').fill('Independent fresh draft with selected skill');
    await button('添加功能与 Skills').click();
    await page.getByRole('option').filter({ hasText: 'pending-proof' }).click();
    await button('发送').click();
    await until(async () => Object.values(logical(await state())?.state?.threads ?? {}).some(thread => thread.turns?.at(-1)?.status === 'completed'), 'fresh draft completes');
    assert.equal(requests.length, 1, 'One explicit fresh draft produces exactly one model request');
    assert.match(JSON.stringify(requests[0]), /PENDING_SKILL_BODY/, 'Selected Skill reaches actual provider request');
    assert.equal(await page.getByText('PENDING_PROJECT_OK', { exact: true }).count(), 1);
    await capture('04-fresh-completed');
    checks.push('Fresh GUI draft with selected Skill completes once without replaying original creation');
    await createProjectConversation(page, 'workspace');
    await page.evaluate(({ projectId, requestId }) => {
      const key = `areal-gui:draft:${projectId}:new`;
      localStorage.setItem(key, 'Own unknown draft must remain unsent');
      localStorage.setItem(`${key}:pending-create`, requestId);
      localStorage.setItem(`${key}:pending-create-request`, JSON.stringify({ projectId, requestId, worktree: { mode: 'worktree' } }));
    }, { projectId, requestId });
    await page.reload();
    await until(async () => (await state()).connection?.state === 'ready' && logical(await state())?.state?.connected, 'own UNKNOWN reconnects to ready Core');
    await page.getByTestId('chat-input').waitFor();
    assert.equal(await button('发送').isEnabled(), false, 'Own UNKNOWN cannot send again');
    assert.equal(await page.getByTestId('chat-input').getAttribute('contenteditable'), 'false', 'Own UNKNOWN preserves editing lock');
    assert.equal(requests.length, 1, 'Reloading own UNKNOWN never sends a provider request');
    await capture('05-own-unknown-locked');
    checks.push('Persisted own-draft UNKNOWN stays locked and unsent after reload');
  }
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')), pending, 'Original missing-receipt journal preserved');
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')), binding, 'Original worktree binding preserved');
  assert.ok(!(await trace()).some(call => call.method === 'areal/thread/start' && call.params?.requestId === requestId), 'Original creation never resubmitted');
  assert.ok(logical(await state()).pending.some(entry => entry.params.requestId === requestId), 'Original UNKNOWN stays visible');
  checks.push('Original pending, binding, request identity and missing receipt preserved; no original mutation replay');
  assert.deepEqual(errors, []);
  manifest.passed = true;
} catch (error) {
  failure = error; manifest.error = error.stack;
  if (page) await captureSmokeFailure(page, evidence, error);
} finally {
  await json(join(evidence, 'model-requests.json'), requests);
  if (app) {
    try { await closeSmokeApplication(app); } catch (error) { failure ??= error; manifest.cleanupError = error.stack; }
  }
  await application.close();
  try { await assertApplicationStopped(binary, env, metadata); manifest.cleaned = true; }
  catch (error) { failure ??= error; manifest.cleanupError = error.stack; }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await writeFile(join(evidence, 'electron.stderr.log'), stderr);
  assert.equal(sha(await readFile(binary)), manifest.coreSHA256, 'Core binary unchanged');
  manifest.passed &&= !failure;
  await json(join(evidence, 'manifest.json'), manifest);
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: manifest.passed, red, evidence, checks }, null, 2));
