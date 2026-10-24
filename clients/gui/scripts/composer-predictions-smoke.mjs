import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationFixture } from './application-fixture.mjs';
import { assertApplicationStopped } from './application-cleanup.mjs';
import { respondToSessionName } from './model-fixture.mjs';
import { captureSmokeFailure, selectConversation } from './smoke-navigation.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary, 'Set AREAL_CORE_BIN to the built isolated Core');
const scratch = await mkdtemp('/private/tmp/acp-');
console.log(`Composer predictions evidence: ${scratch}`);
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
await mkdir(join(scratch, 'user'));
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const checks = [], requests = [], errors = [], identities = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, projectId, mainId, sideId, failure, heldPrediction, passed = false;
const predictions = { main: '检查主聊天实现并运行相关测试，确认失败恢复和上下文隔离符合预期。',
  side: '请检查旁路讨论中的边界条件，说明哪些判断只依赖创建时的快照，并给出一个不会改变主聊天状态的验证步骤。' };
const sse = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\ndata: [DONE]\n\n`;
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    const prediction = request.headers['x-areal-model-purpose'] === 'promptPrediction'
      || body.messages?.some(message => message.role === 'system' && /predict.*next.*(?:user|prompt)|generate.*next.*prompt/i.test(message.content));
    const lastUser = body.messages?.findLast(message => message.role === 'user');
    const side = JSON.stringify(lastUser?.content).includes('PREDICTION_SIDE');
    const record = { kind: prediction ? 'prediction' : 'solve', headers: { purpose: request.headers['x-areal-model-purpose'] }, body };
    requests.push(record);
    if (prediction) {
      assert.ok(!body.tools?.length, 'prediction inference has no tools');
      assert.ok(!body.previous_response_id, 'prediction cannot continue the live model response');
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const prompt = JSON.stringify(lastUser?.content);
    if (prediction && prompt.includes('PREDICTION_MAIN_DELAY') && prompt.lastIndexOf('PREDICTION_MAIN_DELAY') > prompt.lastIndexOf('PREDICTION_MAIN_ADVANCE')) {
      heldPrediction = () => { response.end(sse('STALE_PREDICTION_MUST_NOT_APPEAR')); heldPrediction = null; };
    } else response.end(sse(prediction ? predictions[side ? 'side' : 'main'] : side ? 'PREDICTION_SIDE_ANSWER' : 'PREDICTION_MAIN_ANSWER'));
  } catch (error) { errors.push(error.stack); response.destroy(error); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(scratch, 'config.toml');
await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n[limits]\nmodel_concurrency=1\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'standard', revision: 'v1', displayName: '标准', instructions: 'Reply with plain text.', allowThreadProcesses: true, skills: [] }] }));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
Object.assign(env, { AREAL_CORE_BIN: binary, AREAL_CORE_CONFIG: config, AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'), AREAL_CORE_USER_HOME: join(scratch, 'user'),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
const fixture = await applicationFixture(gui, join(scratch, 'application'));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const evidence = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'), binary,
  binarySha256: await hash(binary), rendererSha256: await hash(join(gui, 'renderer/dist/index.html')),
  newSourceHashes: Object.fromEntries(await Promise.all(['core/engine/src/prompt_prediction.rs', 'clients/gui/renderer/src/useComposerPrediction.ts', 'clients/gui/scripts/composer-predictions-smoke.mjs'].map(async path => [path, await hash(join(root, path))]))),
  checks, requests, errors, identities };
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = snapshot => snapshot.projects.find(value => value.id === projectId || value.root === workspace);
const thread = (snapshot, id) => project(snapshot)?.state?.threads?.[id];
async function until(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const snapshot = await state(); if (predicate(snapshot)) return snapshot; await delay(80); }
  throw Error(`Timeout: ${label}`);
}
async function call(name, parameters) {
  const reply = await page.evaluate(({ name, parameters }) => window.arealDesktop.command(name, parameters), { name, parameters });
  assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.value;
}
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [fixture.path], env, timeout: 120000 });
  app.process().stderr?.on('data', bytes => appendFileSync(join(scratch, `electron-${app.process().pid}.stderr.log`), bytes));
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.stack));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(snapshot => snapshot.connection?.state === 'ready', 'desktop ready');
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 960);
    const prefs = window.webContents.getLastWebPreferences();
    return { pid: process.pid, userData: app.getPath('userData'), security: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration } };
  });
  assert.deepEqual(identity.security, { sandbox: true, contextIsolation: true, nodeIntegration: false }); identities.push(identity);
}
async function close() {
  if (!app) return;
  const metadata = JSON.parse(await readFile(join(scratch, 'core/service.json'), 'utf8'));
  const child = app.process();
  await app.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit(); });
  const deadline = Date.now() + 30000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned Electron exits');
  await assertApplicationStopped(binary, env, metadata); app = null;
}
const predictionCount = () => requests.filter(value => value.kind === 'prediction').length;
const solveCount = () => requests.filter(value => value.kind === 'solve').length;
async function waitGhost(scope, text) {
  const ghost = scope.getByTestId('composer-prediction');
  await ghost.waitFor(); assert.ok((await ghost.innerText()).includes(text)); return ghost;
}
async function verifyInteraction(scope, inputId, id, expected, screenshot) {
  const input = scope.getByTestId(inputId);
  const ghost = await waitGhost(scope, expected);
  assert.equal((await input.innerText()).trim(), '');
  const typography = async locator => locator.evaluate(element => { const style = getComputedStyle(element); return { size: parseFloat(style.fontSize), weight: style.fontWeight, family: style.fontFamily }; });
  const ghostType = await typography(ghost), inputType = await typography(input);
  assert.ok(ghostType.size < inputType.size, 'prediction uses smaller type than the editable draft');
  assert.equal(ghostType.weight, '400', 'prediction uses regular weight');
  assert.equal(ghostType.family, inputType.family, 'prediction keeps the composer font family');
  assert.equal(await ghost.innerText(), expected, 'prediction shows only text without a Tab badge');
  const ghostBounds = await ghost.boundingBox();
  const submitBounds = await scope.locator('[type="submit"]').boundingBox();
  assert.ok(ghostBounds && submitBounds && ghostBounds.y + ghostBounds.height <= submitBounds.y + 1, 'multiline ghost stays above the toolbar');
  const saved = structuredClone(thread(await state(), id).turns);
  const beforeSolves = solveCount(), beforePredictions = predictionCount();
  await page.screenshot({ path: join(scratch, `${screenshot}-before.png`) });
  await input.focus(); await input.press('Tab');
  assert.equal(await input.innerText(), expected);
  await ghost.waitFor({ state: 'hidden' });
  assert.deepEqual(thread(await state(), id).turns, saved, 'Tab never creates a turn or changes history');
  assert.equal(solveCount(), beforeSolves, 'Tab never sends a model request');
  await page.screenshot({ path: join(scratch, `${screenshot}-accepted.png`) });
  await input.fill('我自己的输入');
  await ghost.waitFor({ state: 'hidden' });
  await input.fill(''); await waitGhost(scope, expected);
  await input.fill(' '); await ghost.waitFor({ state: 'hidden' });
  await input.fill(''); await waitGhost(scope, expected);
  await input.focus(); await input.press('Shift+Tab');
  assert.equal((await input.innerText()).trim(), '', 'Shift+Tab never accepts');
  await waitGhost(scope, expected);
  await input.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await ghost.waitFor({ state: 'hidden' });
  await input.press('Tab');
  assert.ok(!(await input.innerText()).includes(expected), 'IME Tab cannot accept prediction');
  await cdp.send('Input.insertText', { text: '中' });
  await cdp.detach();
  await input.press('ControlOrMeta+A'); await input.press('Backspace'); await waitGhost(scope, expected);
  assert.equal(predictionCount(), beforePredictions, 'typing and clearing reuse the same prediction');
  assert.deepEqual(thread(await state(), id).turns, saved, 'ghost and custom input preserve authoritative history');
  checks.push(`${screenshot}: Tab accepts without sending; own input, whitespace and IME hide; clearing restores identical candidate without inference`);
}
try {
  await launch();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.getByRole('button', { name: '不在项目中工作', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  await until(snapshot => project(snapshot)?.state?.connected, 'project connected'); projectId = project(await state()).id;
  const created = await call('create', { projectId, profile: { id: 'standard', revision: 'v1' }, model: { providerId: 'fixture', modelId: 'fixture' } });
  mainId = created.threadId; await selectConversation(page, mainId);
  const mainInput = page.getByTestId('chat-input');
  await mainInput.fill('PREDICTION_MAIN_INITIAL'); await page.getByTestId('chat-send-button').click();
  await until(snapshot => thread(snapshot, mainId)?.turns?.at(-1)?.status === 'completed', 'main completed');
  const mainScope = page.locator('.composer-dock').filter({ has: mainInput });
  await verifyInteraction(mainScope, 'chat-input', mainId, predictions.main, '01-main');
  const sourceTurnId = thread(await state(), mainId).turns.at(-1).id;
  const beforeDuplicates = predictionCount();
  for (let attempt = 0; attempt < 2; attempt++) await call('prediction', { projectId, threadId: mainId, sourceTurnId, operation: 'request' });
  assert.equal(predictionCount(), beforeDuplicates, 'duplicate source demands return the persisted candidate without inference');
  checks.push('duplicate demands for the same completed source reuse Core candidate state');
  await mainInput.fill('/');
  await mainScope.getByTestId('composer-prediction').waitFor({ state: 'hidden' });
  await mainInput.press('Tab');
  assert.ok(!(await mainInput.innerText()).includes(predictions.main), 'slash completion keeps priority over prediction');
  const closeReferences = page.getByRole('button', { name: '关闭引用选择', exact: true });
  if (await closeReferences.isVisible()) await closeReferences.click();
  await mainInput.fill(''); await page.keyboard.press('Escape'); await waitGhost(mainScope, predictions.main);
  const mainHistory = structuredClone(thread(await state(), mainId).turns);
  await mainInput.fill('PREDICTION_MAIN_OWN_FOLLOWUP'); await page.getByTestId('chat-send-button').click();
  await until(snapshot => thread(snapshot, mainId)?.turns?.length === 2 && thread(snapshot, mainId).turns.at(-1).status === 'completed', 'own followup complete');
  const ownRequest = requests.filter(value => value.kind === 'solve').at(-1).body;
  assert.ok(!JSON.stringify(ownRequest.messages).includes(predictions.main), 'unaccepted prediction cannot enter the next solve context');
  assert.ok(!JSON.stringify(ownRequest.messages).includes('Predict the next'), 'prediction instruction cannot enter solve context');
  assert.deepEqual(thread(await state(), mainId).turns[0], mainHistory[0], 'prediction does not mutate completed turn');
  await waitGhost(mainScope, predictions.main);
  await mainInput.focus(); await mainInput.press('Tab');
  await page.getByTestId('chat-send-button').click();
  await until(snapshot => thread(snapshot, mainId)?.turns?.length === 3 && thread(snapshot, mainId).turns.at(-1).status === 'completed', 'accepted draft explicitly sent');
  const acceptedRequest = requests.filter(value => value.kind === 'solve').at(-1).body;
  assert.equal(acceptedRequest.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(predictions.main)).length, 1, 'explicit send adds accepted prediction once as a user message');
  checks.push('independent prediction instructions and unaccepted candidate stay out of later solve requests; explicit send adds one ordinary user message');
  await waitGhost(mainScope, predictions.main);
  await mainInput.fill('PREDICTION_MAIN_DELAY'); await page.getByTestId('chat-send-button').click();
  await until(() => !!heldPrediction, 'held prediction started');
  const anchorTurnId = thread(await state(), mainId).turns.at(-1).id;
  const answer = page.locator(`[data-turn-id="${anchorTurnId}"] [data-side-item-id] .conversation-markdown`).last();
  await answer.click();
  await answer.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = []; let node; while ((node = walker.nextNode())) nodes.push(node);
    const range = document.createRange(); range.setStart(nodes[0], 0); range.setEnd(nodes.at(-1), nodes.at(-1).textContent.length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '在旁路中询问所选内容', exact: true }).click();
  const sideScope = page.getByRole('region', { name: '旁路讨论' });
  const sideInput = sideScope.getByTestId('side-chat-input');
  await sideInput.fill('PREDICTION_SIDE_INITIAL'); await sideScope.getByTestId('side-chat-send').click();
  const withSide = await until(snapshot => Object.values(project(snapshot).state.threads).some(value => value.conversation?.kind === 'side' && value.turns?.at(-1)?.status === 'completed'), 'side completes before held prediction timeout or release', 8000);
  assert.ok(heldPrediction, 'Side foreground completes while the main prediction response is still withheld');
  checks.push('with model_concurrency=1, Side foreground inference preempts the held main prediction');
  sideId = Object.values(project(withSide).state.threads).find(value => value.conversation?.kind === 'side').id;
  await verifyInteraction(sideScope, 'side-chat-input', sideId, predictions.side, '02-side');
  await mainInput.fill('PREDICTION_MAIN_ADVANCE'); await page.getByTestId('chat-send-button').click();
  await until(snapshot => thread(snapshot, mainId)?.turns?.length === 5 && thread(snapshot, mainId).turns.at(-1).status === 'completed', 'new source completes');
  heldPrediction?.(); await waitGhost(mainScope, predictions.main);
  assert.equal(await page.getByText('STALE_PREDICTION_MUST_NOT_APPEAR', { exact: true }).count(), 0, 'late prediction cannot install into the new source');
  checks.push('advancing a source while prediction is held cancels or discards the stale result');
  assert.equal((await mainScope.getByTestId('composer-prediction').innerText()).includes(predictions.main), true, 'Side prediction leaves main prediction unchanged');
  await writeFile(join(scratch, 'history.json'), JSON.stringify({ main: thread(await state(), mainId), side: thread(await state(), sideId) }, null, 2));
  const beforeReopen = requests.length;
  await close(); await launch(); await until(snapshot => project(snapshot)?.state?.connected, 'reopened project');
  await selectConversation(page, mainId);
  await waitGhost(page.locator('.composer-dock').filter({ has: page.getByTestId('chat-input') }), predictions.main);
  assert.equal(requests.length, beforeReopen, 'reopen restores prediction without another model request');
  checks.push('main and Side use separate candidates and history; Electron restart restores cached prediction without regeneration');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings-category-navigation').getByRole('button', { name: '常规', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '预测下一条提示词', exact: true });
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'prediction is enabled by default');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.getByTestId('composer-prediction').waitFor({ state: 'hidden' });
  const disabledPredictions = predictionCount();
  await page.getByTestId('chat-input').fill('PREDICTION_DISABLED');
  await page.getByTestId('chat-send-button').click();
  await until(snapshot => thread(snapshot, mainId)?.turns?.length === 6 && thread(snapshot, mainId).turns.at(-1).status === 'completed', 'disabled source completed');
  assert.equal(predictionCount(), disabledPredictions, 'disabled preference never requests a prediction after completion');
  checks.push('General settings defaults on; switching off hides candidates and suppresses inference on the next completed source');
  assert.ok(requests.filter(value => value.kind === 'prediction').every(value => value.body.model === 'fixture'), 'predictions reuse the source conversation model');
  assert.deepEqual(errors, []); passed = true;
} catch (error) {
  failure = error;
  if (page) {
    await captureSmokeFailure(page, scratch, error);
    await writeFile(join(scratch, 'failure-snapshot.json'), JSON.stringify(await state(), null, 2)).catch(() => {});
  }
}
finally {
  heldPrediction?.();
  try { await close(); } catch (error) {
    await writeFile(join(scratch, 'cleanup-error.txt'), error.stack);
    failure ??= error; passed = false;
    const child = app?.process();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const cleanup = { servicesStopped: !app, removed: [] };
  if (passed && !failure) for (const name of ['workspace', 'user', 'core', 'electron', 'registry', 'application', 'config.toml', 'desktop.json']) {
    await rm(join(scratch, name), { recursive: true, force: true }); cleanup.removed.push(name);
  }
  await writeFile(join(scratch, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
  await writeFile(join(scratch, 'evidence.json'), JSON.stringify({ ...evidence, passed, failure: failure?.stack, limitations: ['deterministic local provider, not real provider quality or billing', 'source Electron, not a packaged app', 'Chromium composition events, not physical IME', 'native project chooser is stubbed'] }, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ passed, checks, evidence: join(scratch, 'evidence.json') }, null, 2));
