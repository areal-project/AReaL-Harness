import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';
import { assertApplicationStopped, closeSmokeApplication } from './application-cleanup.mjs';
import { checkBrowserStartup } from './browser-startup.mjs';
import { respondToSessionName } from './model-fixture.mjs';

const options = { suite: 'all', native: false };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--native') options.native = true;
  else if (flag === '--ecosystem') options.ecosystem = true;
  else if (['--suite', '--native-bundle-id', '--native-fixture-app'].includes(flag)) {
    assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${flag} needs a value`);
    options[{ '--suite': 'suite', '--native-bundle-id': 'bundleId', '--native-fixture-app': 'fixtureApp' }[flag]] = process.argv[++index];
  } else throw Error(`Unknown flag ${flag}`);
}
assert.ok(['all', 'browser', 'computer'].includes(options.suite), '--suite must be all, browser, or computer');
if (options.ecosystem) {
  assert.notEqual(options.suite, 'all', '--ecosystem requires one explicit --suite');
  assert.ok(process.env.AREAL_CORE_BIN, '--ecosystem requires an explicit AREAL_CORE_BIN');
}
if (options.native) {
  assert.notEqual(options.suite, 'browser', '--native requires the computer suite');
  assert.equal(options.bundleId, 'com.areal.harness.computer-fixture', 'native actions accept only the dedicated harmless AReaL fixture');
  assert.ok(isAbsolute(options.fixtureApp ?? ''), '--native requires --native-fixture-app with an absolute .app path');
} else assert.ok(!options.bundleId && !options.fixtureApp, 'native fixture flags require --native');

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const { CoreClient } = await import('../packages/runtime-client/core.js');
const WebSocket = require('ws');
const binary = process.env.AREAL_CORE_BIN || join(root, '.local/dev-bin/areal');
assert.ok(isAbsolute(binary), 'AREAL_CORE_BIN must be absolute');
const scratch = await mkdtemp('/private/tmp/areal-automation-core-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace);
const ecosystem = options.ecosystem ? { pluginId: `${options.suite}-control@areal-adapters`, skillName: `${options.suite}-control`, tool: `${options.suite}_v1`, selections: [] } : null;
if (ecosystem) {
  await cp(join(root, 'examples/plugin-marketplace'), workspace, { recursive: true });
  ecosystem.body = await readFile(join(workspace, ecosystem.skillName, 'skills', ecosystem.skillName, 'SKILL.md'), 'utf8');
}
await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
const startedAt = new Date().toISOString();
const checks = [], errors = [], gaps = [], events = { histories: {}, media: [], modelCalls: [], cleanup: {} };
const failureModes = [
  'Core rejects or bypasses the command prepare/approval/native execute chain.',
  'A successful locator tool result does not change the real native fixture DOM exactly once.',
  'Core denial sends input or a later read/reconnect replays the denied mutation.',
  'Screenshot bytes do not become readable durable Core image Blobs.',
  'Hidden/full-page capture loses page state or returns only the visible viewport.',
  'Dialog management or recording status reports success without the actual fixture/artifact effect.',
  'Settings enablement does not persist, a fresh disabled session advertises computer_v1, or disabled native admission executes.',
  'Passive computer status requests OS authorization or native actions run without existing grants.',
];
if (ecosystem) failureModes.push(
  'GUI source review installs the wrong package or restart loses the installed digest or selected Skill reference.',
  'Try creates a thread or submits to the model before Send.',
  'The model never receives the exact installed Skill body and Core reference before native tool execution.',
  'Missing host tools or disabled computer control report available readiness.',
  'Creator replaces the existing official builtin source or skips its real Runtime initialization and validation.',
  'Stale, denied or UNKNOWN mutations execute again. Only denied mutation replay is covered by this combined runner.',
);
const siteFacts = { gets: [], effects: [] };
const sentinel = 'AUTOMATION_REAL_NATIVE_PAGE_23';
const site = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    siteFacts.effects.push({ path: request.url, body });
    response.end('ok'); return;
  }
  siteFacts.gets.push(request.url);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>AReaL automation fixture</title><style>body{font:18px system-ui;background:white;color:black}button,input{margin:12px}</style>
    <h1>${sentinel}</h1><label>Fixture draft <input id="draft"></label>
    <label>Fixture checked <input id="check" type="checkbox"></label>
    <button id="submit">Submit fixture</button><p id="dialog-result"></p>
    <div style="height:1600px;background:linear-gradient(white,#bcd)">Full-page fixture</div><p id="bottom">BOTTOM_CAPTURE_SENTINEL</p>
    <script>window.fixture={clicks:0,inputs:0,changes:0,dialogResult:null};
    document.querySelector('#draft').addEventListener('input',()=>fixture.inputs++);
    document.querySelector('#check').addEventListener('change',()=>fixture.changes++);
    document.querySelector('#submit').addEventListener('click',()=>{fixture.clicks++;fetch('/effect',{method:'POST',body:document.querySelector('#draft').value})});
    window.openFixtureDialog=()=>setTimeout(()=>{fixture.dialogResult=confirm('Fixture confirm');document.querySelector('#dialog-result').textContent=String(fixture.dialogResult)},100);</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
let app, page, projectId, threadId, pageId, nativeId, activeScenario, fixtureProcess;
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    if (body.messages?.some(message => message.role === 'system' && typeof message.content === 'string'
      && message.content.startsWith('Predict the next user prompt from the conversation data.'))) {
      assert.ok(!body.tools?.length, 'prompt predictions have no tools');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (body.messages?.some(message => message.role === 'system' && typeof message.content === 'string'
      && message.content.startsWith('AReaL permission review.'))) {
      assert.ok(!body.tools?.length, 'permission review has no tools');
      const packet = JSON.parse(body.messages.findLast(message => message.role === 'user').content);
      assert.ok(['browser_v1', 'computer_v1'].includes(packet.tool));
      assert.match(packet.digest, /^[a-f0-9]{64}$/);
      (events.permissionReviews ??= []).push({ tool: packet.tool, digest: packet.digest });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ decision: 'ask', reason: 'The fixture requires explicit user approval.', digest: packet.digest }) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    assert.ok(activeScenario, 'every conversation model request belongs to a scenario');
    const names = (body.tools ?? []).map(tool => tool.function?.name);
    const last = body.messages?.at(-1);
    const imageUrls = [];
    if (Array.isArray(last?.content)) {
      for (const part of last.content) {
        const url = part.image_url?.url;
        if (typeof url === 'string' && url.startsWith('data:image/')) imageUrls.push(createHash('sha256').update(Buffer.from(url.split(',')[1], 'base64')).digest('hex'));
      }
    }
    if (ecosystem?.currentSelected) {
      const userText = (body.messages ?? []).filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n')).join('\n');
      assert.ok(userText.includes(ecosystem.body), 'actual model request carries the installed AReaL Skill body');
      assert.ok(userText.includes(`id="${ecosystem.skill.id}" revision="${ecosystem.skill.revision}"`), 'actual model request carries the selected exact Core Skill reference');
      events.ecosystem ??= ecosystem;
      await writeFile(join(scratch, `${activeScenario.id}-model-request.json`), JSON.stringify(body, null, 2));
    }
    events.modelCalls.push({ scenario: activeScenario.id, toolNames: names, lastRole: last?.role, imageSHA256: imageUrls });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!activeScenario.sent && activeScenario.tool) {
      assert.ok(names.includes(activeScenario.tool), `${activeScenario.tool} must be registered in the actual model request`);
      activeScenario.sent = true;
      send({ tool_calls: [{ index: 0, id: activeScenario.id, type: 'function', function: { name: activeScenario.tool, arguments: JSON.stringify(activeScenario.arguments) } }] });
      send({}, 'tool_calls');
    } else {
      if (activeScenario.tool) assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === activeScenario.id), 'this tool outcome returns to the deterministic model');
      send({ content: `Reviewed ${activeScenario.id}` }); send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(`model fixture ${error.stack ?? error}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
// This bounded multi-turn fixture keeps compaction outside the dialog/automation acceptance surface.
await writeFile(join(userHome, '.areal/config.toml'), `schema_version=1\n[limits]\ncontext_window_tokens=1000000\ncontext_mode="manual"\n[model]\nprovider="fixture"\nname="fixture"\ncontext_window_tokens=1000000\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use the requested tool and report the result.', allowPluginSkills: options.ecosystem === true }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'), AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: binary };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
const sha = value => createHash('sha256').update(value).digest('hex');
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timeout waiting for ${label}`);
}
async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function preview(operation, extra = {}) {
  return page.evaluate(params => window.arealDesktop.preview(params), { operation, projectId, threadId, ...extra });
}
async function readCoreThread(id = threadId) {
  const owner = (await state()).projects.find(item => item.id === projectId);
  const thread = owner.state?.threads?.[id];
  const instanceId = thread?.executionCore?.instanceId ?? owner.core.instanceId;
  const executionRoot = thread?.worktree?.directory ?? workspace;
  const descriptor = JSON.parse(execFileSync(binary, ['service', 'status', '--instance', instanceId, '--json'], { env, encoding: 'utf8', timeout: 20000 }));
  assert.equal(descriptor.state, 'ready'); assert.equal(descriptor.workspace, executionRoot);
  const auth = JSON.parse(await readFile(descriptor.authFile, 'utf8'));
  const principal = auth.principals.find(item => item.permissions.includes('observe'));
  assert.ok(principal?.token, 'isolated observer principal exists');
  const client = new CoreClient({ createSocket: () => new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${principal.token}` }, followRedirects: false }) });
  try { await client.connect(); return (await client.request('thread/read', { threadId: id, includeTurns: true })).thread; }
  finally { client.close(); }
}
function findObject(value, predicate) {
  if (typeof value === 'string') { try { return findObject(JSON.parse(value), predicate); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const item of Object.values(value)) { const result = findObject(item, predicate); if (result) return result; }
  return null;
}
function resultObject(item, predicate) {
  const result = findObject(item.contentItems, predicate);
  assert.ok(result, `durable Core result for ${item.callId} contains expected structured output`);
  return result;
}
function successful(item) { assert.equal(item.success, true, JSON.stringify(item)); }
async function runScenario(scenario) {
  activeScenario = { approval: 'allow', ...scenario, sent: false };
  console.error(`automation-core ${scenario.id}`);
  const previous = (await readCoreThread()).turns?.at(-1)?.id;
  await command('send', { projectId, threadId, text: `automation acceptance ${scenario.id}` });
  let approvals = 0;
  await until(async () => {
    const snapshot = await state();
    const owner = snapshot.projects.find(item => item.id === projectId);
    const thread = owner?.state?.threads?.[threadId];
    // GUI history is bounded: a new completed turn need not increase its projected count.
    const latest = thread?.turns?.at(-1);
    if (latest && latest.id !== previous && ['completed', 'failed', 'interrupted'].includes(latest.status)) return true;
    const panel = page.locator('[data-interaction="approval"]');
    if (!approvals && await panel.count() && await panel.isVisible()) {
      assert.notEqual(activeScenario.approval, 'none', 'prepare-time refusal must not request approval');
      // 紧凑审批卡默认折叠完整请求，先展开再核对本次授权的具体操作。
      const details = panel.locator('details.decision-card-details');
      if (scenario.compact) {
        assert.equal(await details.getAttribute('open'), null, 'long approval starts with a collapsed full request');
        const bounds = await panel.evaluate(el => ({ height: el.getBoundingClientRect().height, width: el.clientWidth, full: el.scrollWidth }));
        assert.ok(bounds.height <= 360 && bounds.full <= bounds.width + 1, JSON.stringify(bounds));
        await panel.screenshot({ path: join(scratch, `${scenario.id}-collapsed.png`) });
      }
      if (await details.count() && await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
      const text = await panel.innerText();
      if (scenario.tool) assert.ok(text.includes(scenario.tool) || text.includes(scenario.arguments.operation), 'approval identifies this tool operation');
      await panel.getByRole('button', { name: activeScenario.approval === 'deny' ? '拒绝' : '允许一次', exact: true }).click();
      approvals++;
      assert.ok(approvals <= 1, `${scenario.id} must not prompt twice or replay`);
    }
    return false;
  }, `terminal Core turn ${scenario.id}`, 90000);
  const history = await readCoreThread();
  const turn = history.turns.at(-1);
  assert.equal(turn.status, 'completed', JSON.stringify(turn));
  events.histories[scenario.id] = turn;
  if (!scenario.tool) return { history, turn };
  assert.equal(approvals, scenario.approval === 'none' ? 0 : 1, 'approval count matches the admission outcome');
  const items = turn.items.filter(item => item.type === 'dynamicToolCall' && item.callId === scenario.id && item.tool === scenario.tool);
  assert.equal(items.length, 1, 'the actual Core history contains exactly one matching tool outcome');
  const item = items[0];
  if (scenario.approval === 'deny') {
    assert.equal(item.success, false, JSON.stringify(item));
    assert.match(JSON.stringify(item), /denied|reject|拒绝|permission/i);
  } else if (scenario.assertResult) await scenario.assertResult(item);
  else successful(item);
  if (scenario.assertEffect) await scenario.assertEffect(item);
  checks.push(scenario.id);
  return item;
}
async function browserCase(id, commandInput, extra = {}) {
  return runScenario({ id: `browser-${id}`, tool: 'browser_v1', arguments: { operation: 'command', parameters: { pageId, command: commandInput } }, ...extra });
}
async function nativeFacts() {
  return app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`({url:location.href,draft:document.querySelector('#draft').value,checked:document.querySelector('#check').checked,...window.fixture,viewport:{width:innerWidth,height:innerHeight},height:document.documentElement.scrollHeight})`), nativeId);
}
async function imageResult(item) {
  successful(item);
  const image = item.contentItems?.find(part => part.type === 'arealMedia' && part.modality === 'image');
  assert.ok(image?.media?.uri?.startsWith('areal://blob/'), 'Core materializes the screenshot into its Blob store');
  assert.equal(image.media.mimeType, 'image/png');
  const bytes = Buffer.from(await page.evaluate(async params => {
    const result = await window.arealDesktop.command('media', params);
    if (!result.ok) throw Error(JSON.stringify(result));
    return Array.from(new Uint8Array(result.value.bytes));
  }, { projectId, threadId, operation: 'read', uri: image.media.uri }));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.length, image.media.sizeBytes);
  const info = { callId: item.callId, uri: image.media.uri, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: sha(bytes) };
  assert.ok(info.width > 0 && info.height > 0);
  assert.ok(events.modelCalls.some(call => call.scenario === item.callId && call.imageSHA256.includes(info.sha256)), 'the model receives these same Core screenshot bytes');
  events.media.push(info);
  await writeFile(join(scratch, `${item.callId}.png`), bytes);
  return info;
}
async function newThread(selectSkill = true) {
  if (ecosystem) ecosystem.currentSelected = selectSkill;
  if (ecosystem && selectSkill) {
    await prepareEcosystemDraft();
    const id = `ecosystem-selection-${ecosystem.selections.length}`;
    activeScenario = { id, sent: false };
    await page.getByRole('button', { name: '发送', exact: true }).click();
    threadId = await until(async () => await page.getByTestId('areal-workbench').getAttribute('data-thread-id'), 'GUI Send creates selected Skill conversation');
    await until(async () => (await readCoreThread()).turns?.at(-1)?.status === 'completed', 'selected Skill reaches model through GUI Send');
    const inspection = await command('manage', { projectId, threadId, operation: 'inspect' });
    await command('configure', { projectId, threadId, expectedRevision: inspection.configuration.revision, selectedSkills: [{ id: ecosystem.skill.id, revision: ecosystem.skill.revision }] });
    ecosystem.selections.push({ threadId, skill: ecosystem.skill });
    checks.push(id);
    return threadId;
  }
  const created = await command('create', { projectId, browserEnabled: true, options: { permissionPreset: 'ask' }, profile: { id: 'fixture', revision: 'v1' } });
  threadId = created.threadId;
  await selectConversation(page, threadId);
  return threadId;
}
async function computerSettings() {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '电脑控制', exact: true }).click();
  await page.getByTestId('computer-control-settings').waitFor();
}
async function setComputerEnabled(value) {
  await computerSettings();
  const control = page.getByTestId('computer-control-enabled').getByRole('switch');
  if (!value && (await control.getAttribute('aria-checked')) === 'false'
    && (await state()).library?.settings?.computerControlEnabled === undefined) {
    events.initialComputerPreference = 'Unset preference renders disabled. Subsequent enabled and disabled toggles must persist explicit values.';
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    return;
  }
  if ((await control.getAttribute('aria-checked')) !== String(value)) await control.click();
  await until(async () => (await state()).library?.settings?.computerControlEnabled === value, 'computer setting reflected in actual service snapshot');
  await until(async () => JSON.parse(await readFile(join(scratch, 'core/library.json'), 'utf8')).settings.computerControlEnabled === value, 'computer setting persisted on disk');
  if (value) {
    await page.evaluate(() => document.fonts.ready);
    events.settingsScreenshot = join(scratch, 'computer-control-settings.png');
    await page.screenshot({ path: events.settingsScreenshot });
  }
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
}
async function computerCase(id, operation, parameters = {}, extra = {}) {
  return runScenario({ id: `computer-${id}`, tool: 'computer_v1', arguments: { operation, parameters }, ...extra });
}
function assertComputerCatalog(id, enabled) {
  const requests = events.modelCalls.filter(call => call.scenario === id);
  assert.ok(requests.length, 'catalog assertion observed at least one real model request');
  assert.ok(requests.every(call => call.toolNames.includes('computer_v1') === enabled), 'fresh-session catalog follows computer enablement');
}

async function ecosystemDetail() {
  await page.getByRole('navigation', { name: '应用导航', exact: true }).getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tablist', { name: '市场范围', exact: true }).getByRole('tab', { name: '个人', exact: true }).click();
  await page.getByRole('button', { name: `查看插件 ${ecosystem.pluginId}`, exact: true }).click();
  const detail = page.getByTestId('plugin-detail-page');
  await detail.waitFor();
  return detail;
}
async function prepareEcosystemDraft() {
  const before = (await state()).projects.find(project => project.id === projectId);
  const threadIds = Object.keys(before.state?.threads ?? {}).sort();
  const requests = events.modelCalls.length;
  const detail = await ecosystemDetail();
  await detail.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByTestId('plugin-detail-page').getByRole('button', { name: ecosystem.skillName, exact: true }).click();
  await page.getByTestId('skill-detail-page').getByRole('button', { name: '试用', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^查看技能 ${ecosystem.skillName}`) }).waitFor();
  assert.deepEqual(Object.keys((await state()).projects.find(project => project.id === projectId).state?.threads ?? {}).sort(), threadIds, 'Try stages only a draft');
  assert.equal(events.modelCalls.length, requests, 'Try does not submit to the model');
  const selected = await page.evaluate(id => JSON.parse(localStorage.getItem(`areal-gui:draft:${id}:new:skills`) ?? '[]'), projectId);
  assert.equal(selected.length, 1);
  assert.deepEqual({ id: selected[0].id, revision: selected[0].revision }, ecosystem.skill);
}
async function readiness(expectedAvailable) {
  const value = await command('manage', { projectId, operation: 'pluginReadiness', id: ecosystem.pluginId, expectedDigest: ecosystem.installedDigest });
  assert.equal(value.pluginId, ecosystem.pluginId);
  assert.equal(value.installedDigest, ecosystem.installedDigest);
  assert.deepEqual(value.requiredTools, [ecosystem.tool]);
  assert.equal(value.available, expectedAvailable);
  assert.deepEqual(value.missingTools, expectedAvailable ? [] : [ecosystem.tool]);
  ecosystem.readiness ??= [];
  ecosystem.readiness.push(value);
}
async function installEcosystem() {
  const detail = await ecosystemDetail();
  await detail.getByRole('button', { name: '安装', exact: true }).click();
  await detail.getByRole('checkbox', { name: '我已核对以上来源、版本和摘要', exact: true }).waitFor();
  await detail.getByRole('button', { name: '资源范围', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '当前项目', exact: true }).click();
  assert.equal(await detail.getByRole('button', { name: '安装到当前项目', exact: true }).isEnabled(), false, 'source review is required');
  await detail.getByRole('checkbox', { name: '我已核对以上来源、版本和摘要', exact: true }).check();
  await detail.getByRole('button', { name: '安装到当前项目', exact: true }).click();
  const installed = await until(async () => (await command('manage', { projectId, operation: 'plugins' })).data.find(plugin => plugin.id === ecosystem.pluginId && plugin.installed), 'reviewed package installed by GUI');
  assert.equal(installed.enabled, true);
  assert.equal(installed.installedVersion, '1.0.0');
  assert.equal(installed.installedSkills.length, 1);
  ecosystem.installedDigest = installed.installedDigest;
  ecosystem.skill = { id: installed.installedSkills[0].id, revision: installed.installedSkills[0].revision };
  assert.ok(ecosystem.skill.id && ecosystem.skill.revision);
  assert.equal(events.modelCalls.length, 0, 'installation cannot invoke inference');
  await prepareEcosystemDraft();
  const saved = await page.evaluate(id => localStorage.getItem(`areal-gui:draft:${id}:new:skills`), projectId);
  const metadata = JSON.parse(await readFile(join(scratch, 'core/service.json'), 'utf8'));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await closeSmokeApplication(app);
  app = undefined;
  await assertApplicationStopped(binary, env, metadata);
  await launch();
  const restored = (await command('manage', { projectId, operation: 'plugins' })).data.find(plugin => plugin.id === ecosystem.pluginId);
  assert.equal(restored.installedDigest, ecosystem.installedDigest, 'cold restart preserves reviewed package identity');
  assert.equal(restored.installedSkills.length, 1);
  assert.deepEqual({ id: restored.installedSkills[0].id, revision: restored.installedSkills[0].revision }, ecosystem.skill, 'cold restart preserves exact Skill selection');
  assert.equal(await page.evaluate(id => localStorage.getItem(`areal-gui:draft:${id}:new:skills`), projectId), saved, 'cold restart preserves unsent Skill reference');
  assert.equal(events.modelCalls.length, 0, 'restart cannot execute Try');
  checks.push('ecosystem-gui-install-try-restart');
}

async function launch() {
  app = await electron.launch({ executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  app.process().stderr.on('data', chunk => void writeFile(join(scratch, 'electron.stderr.log'), chunk, { flag: 'a' }));
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  events.driverDialogs = [];
  app.context().on('page', target => target.on('dialog', dialog => events.driverDialogs.push({ type: dialog.type(), message: dialog.message() })));
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'desktop service ready');
  events.startup = await checkBrowserStartup(app, { binary, userHome, scratch });
  events.runtime = await app.evaluate(({ app, BrowserWindow, dialog, shell, webContents }, { workspace, computerModule }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    globalThis.__automationPermissionRequests = [];
    globalThis.__automationDialogs = [];
    globalThis.__automationDialogTrace = [];
    const trace = entry => globalThis.__automationDialogTrace.push({ at: Date.now(), monotonicMs: performance.now(), ...entry });
    const parentWindowId = contents => {
      try { return BrowserWindow.fromWebContents(contents)?.id ?? null; }
      catch { return null; }
    };
    const traceContents = contents => {
      const webContentsId = contents.id;
      trace({ kind: 'contents-created', webContentsId, parentWindowId: parentWindowId(contents) });
      contents.debugger.on('message', (_event, method, params, sessionId) => {
        if (method !== 'Page.javascriptDialogOpening' && method !== 'Page.javascriptDialogClosed') return;
        const entry = { webContentsId, parentWindowId: parentWindowId(contents), method, params, sessionId };
        globalThis.__automationDialogs.push({ at: Date.now(), ...entry });
        trace({ kind: 'dialog-event', ...entry });
      });
      const sendCommand = contents.debugger.sendCommand.bind(contents.debugger);
      contents.debugger.sendCommand = (method, ...args) => {
        if (method === 'Page.handleJavaScriptDialog') trace({ kind: 'dialog-command', webContentsId,
          parentWindowId: parentWindowId(contents), method, params: args[0], sessionId: args[1], stack: new Error().stack });
        return sendCommand(method, ...args);
      };
      contents.on('before-input-event', (_event, input) => {
        if (input.key === 'Escape' || input.key === 'Enter') trace({ kind: 'native-key', webContentsId,
          parentWindowId: parentWindowId(contents), type: input.type, key: input.key, isAutoRepeat: input.isAutoRepeat });
      });
      contents.on('destroyed', () => trace({ kind: 'contents-destroyed', webContentsId }));
    };
    const traceWindow = (window, kind) => {
      const windowId = window.id;
      trace({ kind, windowId, webContentsId: window.webContents.id });
      for (const method of ['close', 'destroy']) {
        const original = window[method].bind(window);
        window[method] = (...args) => {
          trace({ kind: 'window-call', windowId, method, stack: new Error().stack });
          return original(...args);
        };
      }
      window.on('close', () => trace({ kind: 'window-close', windowId }));
      window.on('closed', () => trace({ kind: 'window-closed', windowId }));
    };
    app.on('web-contents-created', (_event, contents) => traceContents(contents));
    app.on('browser-window-created', (_event, window) => traceWindow(window, 'window-created'));
    for (const contents of webContents.getAllWebContents()) traceContents(contents);
    for (const window of BrowserWindow.getAllWindows()) traceWindow(window, 'window-existing');
    const showMessageBox = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...args) => {
      const options = args.at(-1), windowId = args.length > 1 ? args[0]?.id ?? null : null;
      trace({ kind: 'message-box-open', windowId, type: options?.type, message: options?.message,
        buttons: options?.buttons, defaultId: options?.defaultId, cancelId: options?.cancelId, stack: new Error().stack });
      const pending = showMessageBox(...args);
      void pending.then(result => trace({ kind: 'message-box-result', windowId, result }),
        error => trace({ kind: 'message-box-error', windowId, message: error.message }));
      return pending;
    };
    if (computerModule) {
      const { ComputerControl } = process.getBuiltinModule('node:module').createRequire(computerModule)(computerModule);
      globalThis.__automationComputerTrace = [];
      const prepare = ComputerControl.prototype.prepare;
      ComputerControl.prototype.prepare = async function (request) {
        try {
          const result = await prepare.call(this, request);
          globalThis.__automationComputerTrace.push({ phase: 'prepare', request: { ...request, signal: undefined }, result });
          return result;
        } catch (error) {
          globalThis.__automationComputerTrace.push({ phase: 'prepare', code: error.code, message: error.message });
          throw error;
        }
      };
      ComputerControl.prototype.requestAccess = function (capability) {
        globalThis.__automationPermissionRequests.push({ kind: 'requestAccess', capability });
        throw Error('Acceptance runner forbids OS authorization requests');
      };
    }
    const openExternal = shell.openExternal.bind(shell);
    shell.openExternal = async (url, ...rest) => {
      if (String(url).startsWith('x-apple.systempreferences:')) {
        globalThis.__automationPermissionRequests.push({ kind: 'openSettings', url });
        throw Error('Acceptance runner forbids opening OS permission settings');
      }
      return openExternal(url, ...rest);
    };
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 960);
    const preferences = window.webContents.getLastWebPreferences();
    return { pid: process.pid, userData: app.getPath('userData'), electron: process.versions.electron, chromium: process.versions.chrome,
      sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  }, { workspace, computerModule: options.suite === 'browser' ? null : join(gui, 'app/src/core/computer-control.cjs') });
  assert.equal(events.runtime.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(events.runtime.sandbox, true); assert.equal(events.runtime.contextIsolation, true); assert.equal(events.runtime.nodeIntegration, false);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const owner = await until(async () => (await state()).projects.find(item => item.root === workspace && item.state?.connected), 'isolated project ready');
  projectId = owner.id;
  if (ecosystem) {
    ecosystem.fixtureProfile = { id: 'fixture', revision: 'v1' };
    await page.evaluate(({ key, profile }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(profile));
    }, { key: `areal-gui:draft:${projectId}:new:profile`, profile: ecosystem.fixtureProfile });
  }
}
let passed = false;
console.log(`Automation Core evidence ${scratch}`);
try {
  await launch();
  if (ecosystem) {
    if (options.suite === 'computer') await setComputerEnabled(true);
    await installEcosystem();
  }
  if (options.suite !== 'browser') {
    let selectedThread;
    if (ecosystem) { await newThread(); selectedThread = threadId; }
    await setComputerEnabled(false);
    if (ecosystem) {
      await readiness(false);
      const requests = events.modelCalls.length;
      const before = (await state()).projects.find(project => project.id === projectId).state;
      const draft = await page.evaluate(id => ({ text: localStorage.getItem(`areal-gui:draft:${id}:new`), skills: localStorage.getItem(`areal-gui:draft:${id}:new:skills`) }), projectId);
      const detail = await ecosystemDetail();
      await until(async () => !(await detail.getByRole('button', { name: '试用', exact: true }).isEnabled()), 'disabled native provider blocks Try');
      await until(async () => /computer_v1/.test(await detail.innerText()), 'unavailable readiness identifies missing native host tool');
      assert.deepEqual(await page.evaluate(id => ({ text: localStorage.getItem(`areal-gui:draft:${id}:new`), skills: localStorage.getItem(`areal-gui:draft:${id}:new:skills`) }), projectId), draft, 'unavailable Try preserves the draft and selected Skill reference');
      assert.equal(events.modelCalls.length, requests);
      assert.deepEqual(Object.keys((await state()).projects.find(project => project.id === projectId).state.threads).sort(), Object.keys(before.threads).sort(), 'unavailable adapter does not create a thread');
      await detail.getByRole('button', { name: '管理', exact: true }).click();
      await page.getByTestId('plugin-detail-page').getByRole('button', { name: ecosystem.skillName, exact: true }).click();
      const skillDetail = page.getByTestId('skill-detail-page');
      await skillDetail.getByRole('button', { name: '试用', exact: true }).click();
      await until(async () => /computer_v1/.test(await skillDetail.innerText()), 'Skill detail Try reports the same missing deployment');
      assert.deepEqual(await page.evaluate(id => ({ text: localStorage.getItem(`areal-gui:draft:${id}:new`), skills: localStorage.getItem(`areal-gui:draft:${id}:new:skills`) }), projectId), draft, 'Skill detail blocked Try preserves draft');
      assert.equal(events.modelCalls.length, requests, 'Skill detail cannot bypass disabled native deployment');
      checks.push('ecosystem-disabled-computer-try-blocked');
      await page.getByRole('navigation', { name: '应用导航', exact: true }).getByRole('button', { name: '首页', exact: true }).click();
    }
    const before = await command('computerControl', { operation: 'status' });
    const after = await command('computerControl', { operation: 'status' });
    events.passiveStatus = { before, after };
    assert.equal(before.enabled, false); assert.equal(after.enabled, false);
    for (const capability of ['accessibility', 'screenRecording', 'inputMonitoring']) assert.equal(after[capability], before[capability], 'passive status leaves OS grants unchanged');
    await newThread(false);
    await runScenario({ id: 'computer-disabled-tool-catalog' });
    assertComputerCatalog('computer-disabled-tool-catalog', false);
    checks.push('computer-disabled-tool-catalog');
    await setComputerEnabled(true);
    if (ecosystem) {
      const status = await command('computerControl', { operation: 'status' });
      await readiness(status.available === true);
    }
    if (ecosystem) {
      threadId = selectedThread;
      ecosystem.currentSelected = true;
      await selectConversation(page, threadId);
    } else await newThread();
    await computerCase('describe', 'describe', {}, { assertResult(item) {
      successful(item); const text = JSON.stringify(item.contentItems);
      for (const name of ['get_app_state', 'left_click', 'set_value', 'request_access', 'stop_computer_control']) assert.ok(text.includes(name), `describe lists ${name}`);
    } });
    assertComputerCatalog('computer-describe', true);
    const status = await command('computerControl', { operation: 'status' });
    assert.equal(status.enabled, true);
    events.enabledStatus = status;
    await computerCase('passive-access', 'request_access', {}, { assertResult(item) {
      successful(item);
      const access = resultObject(item, value => typeof value.accessibility === 'string' && typeof value.screenRecording === 'string');
      assert.equal(access.accessibility, status.accessibility);
      assert.equal(access.screenRecording, status.screenRecording);
    } });
    if (status.accessibility === 'denied') {
      await computerCase('permission-denied', 'get_app_state', { app_ref: { bundle_id: 'com.areal.harness.computer-fixture' }, include_screenshot: false }, { approval: 'none', assertResult(item) {
        assert.equal(item.success, false, JSON.stringify(item));
        const denial = resultObject(item, value => value.code === 'permission_denied');
        assert.equal(denial.action_sent, false);
        assert.equal(denial.dispatch_status, 'not_sent');
      } });
    } else gaps.push('Native AX permission-denied behavior was not run because this helper already has Accessibility access.');
    if (options.native) {
      if (status.available !== true || status.accessibility !== 'granted' || status.screenRecording !== 'granted') {
        const blocker = Error('Native acceptance blocked. The helper needs pre-existing Accessibility and Screen Recording grants. No authorization was requested.');
        blocker.code = 'NATIVE_GRANTS_REQUIRED'; throw blocker;
      }
      const plist = join(options.fixtureApp, 'Contents/Info.plist');
      const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim();
      assert.equal(bundleId, options.bundleId, 'only the dedicated harmless fixture can be launched');
      const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' }).trim();
      assert.ok(executable && !executable.includes('/'));
      const truthPath = join(scratch, 'native-fixture-truth.json');
      fixtureProcess = spawn(join(options.fixtureApp, 'Contents/MacOS', executable), [truthPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let fixtureError;
      fixtureProcess.on('error', error => { fixtureError = error; });
      fixtureProcess.stderr.on('data', chunk => void writeFile(join(scratch, 'native-fixture.stderr.log'), chunk, { flag: 'a' }));
      const truth = () => readFile(truthPath, 'utf8').then(JSON.parse);
      const initial = await until(() => { if (fixtureError) throw fixtureError; return truth().catch(() => null); }, 'owned native fixture ready');
      assert.equal(initial.pid, fixtureProcess.pid, 'fixture evidence belongs to this launched process');
      assert.equal(initial.presses, 0);
      const app_ref = { bundle_id: options.bundleId };
      const observe = async id => {
        const item = await computerCase(id, 'get_app_state', { app_ref, include_screenshot: true });
        const observed = resultObject(item, value => typeof value.state_id === 'string' && Array.isArray(value.elements));
        assert.equal(observed.app.bundle_id, options.bundleId);
        await imageResult(item);
        return observed;
      };
      let observed = await observe('native-observe');
      const target = identifier => {
        const element = observed.elements.find(element => element.identifier === identifier);
        assert.ok(element, `real AX tree contains ${identifier}`); return { type: 'element', index: element.index };
      };
      await computerCase('native-denied', 'left_click', { app_ref, state_id: observed.state_id, target: target('fixture-press'), strategy: 'a11y' }, { approval: 'deny', assertEffect: async () => assert.equal((await truth()).presses, 0) });
      observed = await observe('native-after-denial');
      assert.equal((await truth()).presses, 0, 'read after denial does not replay native input');
      await computerCase('native-click', 'left_click', { app_ref, state_id: observed.state_id, target: target('fixture-press'), strategy: 'a11y' }, { assertEffect: () => until(async () => (await truth()).presses === 1, 'real AppKit button effect') });
      observed = await observe('native-after-click');
      await computerCase('native-set-value', 'set_value', { app_ref, state_id: observed.state_id, target: target('fixture-editor'), value: 'Core AX input A😀BC' }, { assertEffect: () => until(async () => (await truth()).text === 'Core AX input A😀BC', 'real AppKit text effect') });
      events.nativeFixture = { initial, final: await truth(), bundleId, truthPath };
      gaps.push('Native accepted cases cover AX button/text effects and app-window capture. CGEvent input, UTF-16 selection, clipboard restoration, stale refs and physical takeover are not run by this Core integration runner.');
    } else gaps.push('Native AX observation, screen capture and input were not run. Use --native with the dedicated fixture and pre-existing helper grants.');
    await setComputerEnabled(false);
    await computerCase('disabled-existing-thread', 'get_app_state', { app_ref: { bundle_id: 'com.areal.harness.computer-fixture' }, include_screenshot: false }, { approval: 'none', assertResult(item) {
      assert.equal(item.success, false, JSON.stringify(item));
      const denial = resultObject(item, value => value.code === 'not_authorized');
      assert.match(denial.message, /disabled/i);
      assert.equal(denial.action_sent, false);
      assert.equal(denial.dispatch_status, 'not_sent');
    } });
    events.computerRegistrationContract = 'Existing threads may retain their saved tool definition. Disabled Main admission rejects before approval. Fresh disabled threads omit computer_v1.';
    await newThread(false);
    await runScenario({ id: 'computer-disabled-again' });
    assertComputerCatalog('computer-disabled-again', false);
    checks.push('computer-disabled-again');
  }
  if (options.suite !== 'computer') {
    if (ecosystem) await readiness(true);
    await newThread();
    await page.keyboard.press('Meta+t');
    await page.locator('.preview-panel').waitFor();
    await preview('navigate', { url: siteUrl });
    nativeId = await until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url)?.id, siteUrl), 'real native fixture page');
    const claimed = await preview('claim'); pageId = claimed.browser.pageId;
    assert.ok(pageId);
    await runScenario({ id: 'browser-describe', tool: 'browser_v1', arguments: { operation: 'describe', parameters: {} }, assertResult(item) {
      successful(item); assert.match(JSON.stringify(item.contentItems), /command/); assert.match(JSON.stringify(item.contentItems), /playwright/);
    } });
    await runScenario({ id: 'browser-locator-schema', tool: 'browser_v1', approval: 'none', arguments: { operation: 'describe', parameters: { topic: 'command.playwright.locator' } }, assertResult(item) { successful(item); assert.match(JSON.stringify(item.contentItems), /commandSchema/); assert.match(JSON.stringify(item.contentItems), /selectOption/); } });
    await runScenario({ id: 'browser-observe-before-navigation', tool: 'browser_v1', approval: 'none', arguments: { operation: 'observe', parameters: { pageId } } });
    await runScenario({ id: 'browser-navigate', tool: 'browser_v1', approval: 'none', arguments: { operation: 'navigate', parameters: { pageId, url: `${siteUrl}target` } }, assertEffect: async () => {
      await until(async () => (await nativeFacts()).url === `${siteUrl}target`, 'actual native navigation');
      assert.equal(siteFacts.gets.filter(path => path === '/target').length, 1);
    } });
    await browserCase('dom-snapshot', { method: 'playwright', action: { name: 'domSnapshot' } }, { assertResult(item) { successful(item); assert.ok(JSON.stringify(item.contentItems).includes(sentinel)); } });
    await browserCase('long-command', { method: 'evaluate', expression: '(() => {' + '/* retained long browser approval parameter */'.repeat(180) + 'window.fixture.longCommands=(window.fixture.longCommands||0)+1;return true;})()' }, { compact: true, assertResult: successful, assertEffect: async () => assert.equal((await nativeFacts()).longCommands, 1) });
    const locator = (selector, operation, rest = {}) => ({ method: 'playwright', action: { name: 'locator', selector, operation, ...rest } });
    await browserCase('fill', locator('#draft', 'fill', { value: 'Core browser input A😀BC' }), { assertEffect: async () => { const facts = await nativeFacts(); assert.equal(facts.draft, 'Core browser input A😀BC'); assert.equal(facts.inputs, 1); } });
    await browserCase('check', locator('#check', 'setChecked', { checked: true }), { assertEffect: async () => { const facts = await nativeFacts(); assert.equal(facts.checked, true); assert.equal(facts.changes, 1); } });
    await browserCase('click', locator('#submit', 'click'), { assertEffect: async () => { await until(() => siteFacts.effects.length === 1, 'real fixture server receipt'); assert.equal((await nativeFacts()).clicks, 1); assert.equal(siteFacts.effects[0].body, 'Core browser input A😀BC'); } });
    await browserCase('denied-click', locator('#submit', 'click'), { approval: 'deny', assertEffect: async () => { assert.equal((await nativeFacts()).clicks, 1); assert.equal(siteFacts.effects.length, 1); } });
    await browserCase('read-after-denial', { method: 'playwright', action: { name: 'domSnapshot' } }, { assertEffect: async () => { assert.equal((await nativeFacts()).clicks, 1); assert.equal(siteFacts.effects.length, 1); } });
    const viewportItem = await browserCase('screenshot', { method: 'screenshot' }, { assertResult: imageResult });
    const viewportImage = events.media.find(item => item.callId === viewportItem.callId);
    await browserCase('full-page', { method: 'screenshot', fullPage: true }, { assertResult: async item => { const full = await imageResult(item); assert.ok(full.height > viewportImage.height, 'full-page capture includes content below the viewport'); } });
    await browserCase('hide', { method: 'browserVisibilitySet', visible: false });
    await browserCase('background-capture', { method: 'screenshot' }, { assertResult: imageResult, assertEffect: async () => assert.equal((await nativeFacts()).clicks, 1) });
    await browserCase('show', { method: 'browserVisibilitySet', visible: true });
    const assertConfirm = item => { successful(item); const result = resultObject(item, value => value.dialog?.message === 'Fixture confirm'); assert.equal(result.dialog.type, 'confirm'); };
    for (const [suffix, accept] of [['', true], ['-cancel', false]]) {
      await browserCase(`open-dialog${suffix}`, { method: 'evaluate', expression: '(() => { window.openFixtureDialog(); return true; })()' });
      // Exceed the independently reproduced native auto-accept interval. This is a held-dialog assertion, not a retry.
      await new Promise(resolve => setTimeout(resolve, 4000));
      await browserCase(`get-dialog${suffix}`, { method: 'getDialog' }, { assertResult: assertConfirm });
      if (accept) {
        await browserCase('denied-handle-dialog', { method: 'handleDialog', accept: true }, { approval: 'deny' });
        await browserCase('dialog-after-denial', { method: 'getDialog' }, { assertResult: assertConfirm });
      }
      await browserCase(`handle-dialog${suffix}`, { method: 'handleDialog', accept }, { assertEffect: () => until(async () => (await nativeFacts()).dialogResult === accept, 'actual confirm response') });
    }
    const dialogTrace = await app.evaluate(() => globalThis.__automationDialogTrace);
    assert.equal(dialogTrace.filter(item => item.kind === 'message-box-open' && item.message === 'Fixture confirm').length, 0, 'Agent-owned dialogs never enter native human presentation');
    assert.deepEqual(dialogTrace.filter(item => item.kind === 'dialog-event' && item.method === 'Page.javascriptDialogClosed').map(item => item.params.result), [true, false], 'only the two approved CDP answers close the actual confirms');
    const recording = await browserCase('recording-start', { method: 'recordingStart', options: { actions: [{ type: 'wait', durationMs: 1000 }], maxDurationMs: 5000 } });
    const recordingId = resultObject(recording, value => typeof value.recording?.id === 'string').recording.id;
    let job;
    for (let attempt = 0; attempt < 8; attempt++) {
      const item = await browserCase(`recording-status-${attempt}`, { method: 'recordingStatus', recordingId, outputPath: 'automation/core-acceptance.webm' });
      job = resultObject(item, value => value.recording?.id === recordingId).recording;
      if (job.status !== 'running') break;
    }
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.ok(job.artifact?.path, 'recording status exposes the real output path');
    const recordingPath = isAbsolute(job.artifact.path) ? job.artifact.path : resolve(workspace, job.artifact.path);
    assert.ok(recordingPath.startsWith(`${workspace}/`), 'recording is materialized inside the isolated workspace');
    const bytes = await readFile(recordingPath);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'recording artifact is a WebM container');
    events.recording = { job, path: recordingPath, bytes: bytes.length, sha256: sha(bytes) };
    await browserCase('open-dialog-stop', { method: 'evaluate', expression: '(() => { window.openFixtureDialog(); return true; })()' });
    await browserCase('get-dialog-stop', { method: 'getDialog' }, { assertResult: assertConfirm });
    await preview('stop', { pageId });
    await until(async () => (await preview('state', { pageId })).browser?.control === 'human', 'pending dialog cancellation converges before human control');
    assert.equal((await nativeFacts()).dialogResult, false, 'Stop cancels the actual pending dialog without accepting it');
    const stoppedDialogs = await app.evaluate(() => globalThis.__automationDialogTrace.filter(item => item.kind === 'dialog-event' && item.method === 'Page.javascriptDialogClosed').map(item => item.params.result));
    assert.deepEqual(stoppedDialogs, [true, false, false], 'Stop terminates its one dialog without duplicate completion');
    checks.push('browser-pending-dialog-stop');
    await page.reload();
    await page.getByTestId('areal-workbench').waitFor();
    await until(async () => (await state()).connection?.state === 'ready', 'renderer reconnection after denial');
    assert.equal((await nativeFacts()).clicks, 1, 'reconnection does not replay denied or completed input');
    assert.equal(siteFacts.effects.length, 1);
    const durable = await readCoreThread();
    for (const id of ['browser-denied-click', 'browser-full-page', 'browser-recording-start']) assert.ok(durable.turns.some(turn => turn.items.some(item => item.callId === id)), `Core retains ${id} after renderer reload`);
    checks.push('browser-durable-results-no-replay');
    gaps.push('The runner covers representative browser commands. It does not establish every ZCode command, arbitrary public sites, real-provider behavior, or packaged application parity.');
    gaps.push('The browser dialog cases cover held confirm accept/cancel and denied approval without native human presentation. Electron prompt support and physical human dialog handling are not established by this runner.');
  }
  if (ecosystem) gaps.push('Selected-plugin browser/computer paths do not cover stale-reference mutation rejection, UNKNOWN receipt loss, physical Stop/takeover, real providers, or packaged apps. Those scenarios require separate acceptance and cannot be inferred from this runner.');
  events.permissionRequests = await app.evaluate(() => globalThis.__automationPermissionRequests);
  assert.deepEqual(events.permissionRequests, [], 'passive settings/model access queries never call explicit authorization or open System Settings');
  checks.push(options.suite === 'browser' ? 'browser-no-authorization-request' : 'passive-status-no-authorization-request');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push({ code: error.code ?? 'ACCEPTANCE_FAILED', message: error.stack ?? String(error) });
  if (page) await captureSmokeFailure(page, scratch, error);
  process.exitCode = error.code === 'NATIVE_GRANTS_REQUIRED' ? 2 : 1;
} finally {
  if (fixtureProcess && fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
    fixtureProcess.kill('SIGTERM');
    await until(() => fixtureProcess.exitCode !== null || fixtureProcess.signalCode !== null, 'owned native fixture stopped', 10000).catch(error => errors.push(error.message));
  }
  const metadata = await readFile(join(scratch, 'core/service.json'), 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') errors.push(error.message); return null; });
  if (app) {
    events.nativeDialogs = await app.evaluate(() => globalThis.__automationDialogs).catch(error => ({ unavailable: error.message }));
    events.nativeDialogTrace = await app.evaluate(() => globalThis.__automationDialogTrace).catch(error => ({ unavailable: error.message }));
    events.computerTrace = await app.evaluate(() => globalThis.__automationComputerTrace).catch(error => ({ unavailable: error.message }));
    events.permissionRequests ??= await app.evaluate(() => globalThis.__automationPermissionRequests).catch(error => ({ unavailable: error.message }));
    try {
      await app.evaluate(({ dialog }) => {
        const original = dialog.showMessageBox;
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1);
          return options?.type === 'question' && /退出|关闭/.test(options.message ?? '')
            ? { response: 1, checkboxChecked: false } : original(...args);
        };
      });
      await closeSmokeApplication(app); events.cleanup.electronStopped = true;
    }
    catch (error) { errors.push(`Electron cleanup ${error.message}`); }
  }
  if (metadata) {
    try { await assertApplicationStopped(binary, env, metadata); events.cleanup.applicationStopped = true; }
    catch (error) {
      errors.push(`Application cleanup ${error.message}`);
      const { ServiceConnection, waitForServiceProcessExit } = require(join(gui, 'app/src/core/service-client.cjs'));
      const connection = new ServiceConnection();
      try {
        await connection.connect(metadata);
        const packet = await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
        await connection.request('stopService', { protocol: metadata.protocol, cancel: true, expectedDesktopGeneration: metadata.desktopGeneration, expectedTargets: packet.service.targets }, true).catch(error => { if (!error.message.includes('已请求退出')) throw error; });
        await waitForServiceProcessExit(join(scratch, 'core'), metadata);
        events.cleanup.assistedServiceStop = true;
      } catch (cleanupError) { errors.push(`Assisted cleanup ${cleanupError.message}`); }
      finally { connection.close(); }
    }
  }
  site.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve))]);
  passed = passed && errors.length === 0;
  if (!passed) process.exitCode ||= 1;
  const files = ['scripts/automation-core-smoke.mjs', 'app/src/core/browser-tool.cjs', 'app/src/core/computer-control.cjs', 'app/src/core/preview.cjs', 'app/src/core/agent-dialog-presentation.cjs', 'renderer/dist/index.html'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(gui, file)).then(sha, error => `unavailable ${error.code}`)])));
  const manifest = { passed, options, startedAt, endedAt: new Date().toISOString(), checks, errors, gaps, failureModes, events, siteFacts,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: sha(execFileSync('git', ['diff', 'HEAD'], { cwd: root })), hashes, coreBinary: binary,
    coreBinarySHA256: await readFile(binary).then(sha, error => `unavailable ${error.code}`),
    scope: 'Real isolated source Electron, independent desktop service, Core and native browser executor. Loopback model/site, directory chooser, explicit plugin-enabled Profile and its saved draft selection are fixtures. Explicit OS authorization and System Settings opening are guarded to fail and recorded. Native OS actions require explicit mode and pre-existing grants.' };
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors, gaps }));
}
