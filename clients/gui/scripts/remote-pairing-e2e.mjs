import { selectRemoteTransport, requireBrowserTransport } from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
await requireBrowserTransport(transport, "remote-pairing-e2e");
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, _electron as electron } from '../app/node_modules/playwright-core/index.mjs';
import { applicationFixture } from './application-fixture.mjs';
import { createIdentity, identityId } from '../packages/remote/src/channel.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { DesktopService } = require('../app/src/core/service-protocol.cjs');
const { RemoteControl } = require('../app/src/core/remote.cjs');
const { createRemoteNetworkAdapter } = require('../app/src/core/remote-network.cjs');
const { serviceIdentity } = require('../app/src/core/service-config.cjs');
const { createOwner } = require('../app/src/core/application-owner.cjs');
const scratch = await mkdtemp('/private/tmp/areal-remote-rc02-');
// The in-process Host and real Main belong to one explicit fixture application.
// Ownership checks remain active; application exit is covered by its own suite.
const applicationOwner = createOwner(join(scratch, 'electron'));
const application = await applicationFixture(gui, join(scratch, 'application'), `
require(${JSON.stringify(join(gui, 'app/src/core/application-owner.cjs'))}).createOwner = profile => {
  require('node:assert/strict').equal(require('node:fs').realpathSync(profile), ${JSON.stringify(applicationOwner.profile)});
  return ${JSON.stringify(applicationOwner)};
};`);
const workspace = join(scratch, 'workspace');
const home = join(scratch, 'desktop');
await mkdir(workspace);
await mkdir(join(scratch, 'user', '.areal'), { recursive: true });
let modelRequests = 0;
const model = createServer(async (request, response) => {
  for await (const _ of request) { /* 消费确定性模型请求。 */ }
  modelRequests++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end('data: {"choices":[{"index":0,"delta":{"content":"RC02_READY"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(scratch, 'user', '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Complete the task' }] }));
const backend = new CoreBackend({ binary: process.env.AREAL_CORE_BIN || resolve(gui, '../../target/debug/areal'),
  home, applicationOwner, harnessHome: join(scratch, 'registry'), userHome: join(scratch, 'user'), desktopConfig: deployment,
  desktopProcesses: true });
let service, browser, app, passed = false;
const checks = [];
const networkWizard = { layer: 'production Electron UI/private DesktopService with isolated fake CLI', mutations: [], executed: false };
const networkCli = join(scratch, 'isolated-network-cli.cjs');
const networkCliState = join(scratch, 'network-cli.json');
await writeFile(networkCliState, JSON.stringify({ config: {}, mutations: [] }));
// 测试依赖只传入 Node Host 构造器，生产 Main 与系统 PATH 均不接收可执行文件覆盖。
await writeFile(networkCli, `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(networkCliState)}, journal = ${JSON.stringify(join(home, 'remote.json'))};
const s = JSON.parse(fs.readFileSync(file, 'utf8')), a = process.argv.slice(2);
if (a[0] === 'version') console.log(JSON.stringify({short:'1.52.0'}));
else if (a[0] === 'status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.example.ts.net.',CapMap:{https:[],funnel:[],'https://tailscale.com/cap/funnel-ports?ports=443':[]}},CertDomains:['fixture.example.ts.net']}));
else if (a.join(' ') === 'serve status --json') console.log(JSON.stringify(s.config));
else if (a[0] === 'serve' || a[0] === 'funnel') {
 const saved = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(journal,'utf8')).encrypted,'base64').toString());
 if (saved.network.mapping.state !== 'pending') process.exit(9);
 const port = a[2].split('=')[1], hp = 'fixture.example.ts.net:'+port;
 if (a.at(-1) === 'off') {
  if (saved.directEnabled) process.exit(10);
  delete s.config.TCP[port]; delete s.config.Web[hp];
  if (!Object.keys(s.config.TCP).length) delete s.config.TCP;
  if (!Object.keys(s.config.Web).length) delete s.config.Web;
 } else {
  s.config.TCP ||= {}; s.config.Web ||= {};
  s.config.TCP[port] = {HTTPS:true}; s.config.Web[hp] = {Handlers:{'/':{Proxy:a.at(-1)}}};
 }
 if (a[0] === 'funnel') { s.config.AllowFunnel ||= {}; s.config.AllowFunnel[hp] = true; }
 else if (s.config.AllowFunnel) { delete s.config.AllowFunnel[hp]; if (!Object.keys(s.config.AllowFunnel).length) delete s.config.AllowFunnel; }
 s.mutations.push(a); fs.writeFileSync(file, JSON.stringify(s));
} else process.exit(4);
`, { mode: 0o700 });
const readNetworkCli = async () => JSON.parse(await readFile(networkCliState, 'utf8'));
function assertPublicDirectUrl(actualValue, invitationValue) {
  let actual, expected;
  try {
    actual = new URL(actualValue);
    expected = new URL(invitationValue);
  } catch {
    assert.ok(false, 'Remote URL and invitation must be valid URLs');
  }
  const expectedHost = new URLSearchParams(expected.hash.slice(1)).get('host');
  assert.ok(typeof expectedHost === 'string' && /^[A-Za-z0-9]{20,128}$/.test(expectedHost), 'Invitation requires expected Host pin');
  const expectedHash = '#' + new URLSearchParams({ host: expectedHost }).toString();
  // 只保留本次输入选定的公开 pin；布尔断言避免错误输出泄露邀请。
  assert.ok(actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === '' && actual.username === '' && actual.password === '' && actual.hash === expectedHash, 'Remote URL must retain only the exact expected public Host pin');
}
async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
try {
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const secondWorkspace = join(scratch, 'second-project'); await mkdir(secondWorkspace);
  await backend.addProject(secondWorkspace);
  const { threadId } = await backend.command('create', { projectId, profile: { id: 'fixture', revision: 'v1' } });
  await backend.command('send', { projectId, threadId, text: 'Return RC02_READY' });
  const deadline = Date.now() + 15000;
  while (modelRequests < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(modelRequests, 1, 'real Core called the deterministic model');
  checks.push('real Core/Runtime deterministic model');
  service = new DesktopService(backend, await serviceIdentity({ binary: backend.binary, harnessHome: join(scratch, 'registry'), userHome: join(scratch, 'user'), desktopConfig: deployment, desktopProcesses: true }));
  const hostIdentity = await createIdentity();
  const protectedConfig = { enabled: false, directEnabled: true, identity: hostIdentity, deviceGrants: [] };
  const encryptionFixture = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'fixture',
    encryptString: value => Buffer.from(value), decryptString: value => value.toString('utf8') };
  const legacyIdentity = await createIdentity();
  const legacy = { enabled: true, relay: 'ws://127.0.0.1:9', identity: legacyIdentity, devices: [{ id: identityId(await createIdentity()), name: 'Old phone', projects: [projectId] }] };
  const legacyFile = JSON.stringify({ encrypted: Buffer.from(JSON.stringify(legacy)).toString('base64') });
  await writeFile(join(home, 'remote.json'), legacyFile);
  const saveBeforeMigration = backend.save.bind(backend);
  backend.save = (name, value) => name === 'remote.json' ? Promise.reject(new Error('fixture migration disk failure')) : saveBeforeMigration(name, value);
  const failedMigration = new RemoteControl(service, encryptionFixture);
  await failedMigration.init();
  assert.equal(failedMigration.state().enabled, false);
  assert.equal(failedMigration.state().directEnabled, false);
  assert.ok(failedMigration.state().migrationError);
  assert.equal(await readFile(join(home, 'remote.json'), 'utf8'), legacyFile);
  failedMigration.close(); backend.save = saveBeforeMigration;
  const migrated = new RemoteControl(service, encryptionFixture);
  await migrated.init();
  assert.equal(identityId(migrated.config.identity), identityId(legacyIdentity));
  assert.equal(migrated.state().deviceGrants[0].status, 'reviewRequired');
  assert.deepEqual(migrated.state().deviceGrants[0].projectIds, [projectId]);
  assert.deepEqual(migrated.state().deviceGrants[0].capabilities, []);
  migrated.close();
  checks.push('legacy identity/project scope preserved; migration save failure leaves original file and disables entry');
  await writeFile(join(home, 'remote.json'), JSON.stringify({ encrypted: Buffer.from(JSON.stringify(protectedConfig)).toString('base64') }));
  const remote = service.remote = new RemoteControl(service, encryptionFixture, {
    networkAdapterFactory: options => createRemoteNetworkAdapter({ ...options, executable: networkCli }),
  });
  const previousResourcePath = process.resourcesPath;
  process.resourcesPath = join(scratch, 'missing-assets');
  try { await remote.init(); }
  finally { process.resourcesPath = previousResourcePath; }
  assert.equal(remote.state().directEnabled, false, 'failed optional Direct startup leaves desktop available');
  assert.equal(remote.direct ?? null, null);
  assert.match(remote.state().directError, /Direct|资源|入口/);
  const privateService = await service.listen();
  assert.equal(typeof privateService.endpoint, 'string', 'private desktop listener remains available');
  process.resourcesPath = join(scratch, 'missing-assets');
  try { await assert.rejects(() => remote.control({ operation: 'enableDirect' })); }
  finally { process.resourcesPath = previousResourcePath; }
  assert.equal(remote.state().directEnabled, false);
  assert.equal(remote.direct ?? null, null);
  const savedAfterFailure = JSON.parse(encryptionFixture.decryptString(Buffer.from(JSON.parse(await readFile(join(home, 'remote.json'), 'utf8')).encrypted, 'base64')));
  assert.equal(savedAfterFailure.directEnabled, false, 'failed enable leaves durable setting off');
  await remote.control({ operation: 'enableDirect' });
  let address = remote.direct;
  checks.push('missing Direct assets do not block DesktopService and enable failure leaves no listener');
  await writeFile(join(home, 'service.json'), JSON.stringify(privateService), { mode: 0o600 });
  const env = { ...process.env, AREAL_CORE_BIN: backend.binary, AREAL_CORE_HOME: home,
    AREAL_CORE_USER_HOME: join(scratch, 'user'), AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
    AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_DESKTOP_CONFIG: deployment };
  for (const name of ['AREAL_CORE_CONFIG', 'AREAL_HARNESS_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_CORE_WORKSPACE', 'ELECTRON_RUN_AS_NODE']) delete env[name];
  app = await electron.launch({ executablePath: require('electron'), args: [application.path], env, timeout: 60000 });
  const desktop = await app.firstWindow();
  await desktop.locator('[data-testid=areal-workbench]').waitFor({ timeout: 60000 });
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.getByRole('button', { name: '手机连接', exact: true }).click();
  await desktop.locator('.remote-network-settings > summary').click();
  await desktop.locator('.remote-connection-details > summary').click();
  await desktop.getByRole('button', { name: '检测网络工具', exact: true }).click();
  await desktop.getByText('Tailscale 版本：1.52.0', { exact: true }).waitFor();
  await desktop.getByRole('button', { name: '生成 Serve 方案', exact: true }).click();
  await desktop.getByText('入口：https://fixture.example.ts.net', { exact: true }).waitFor();
  const applyServe = desktop.getByRole('button', { name: '确认并应用 Serve', exact: true });
  assert.equal(await applyServe.isDisabled(), true);
  assert.deepEqual((await readNetworkCli()).mutations, [], 'inspect/proposal cannot mutate CLI configuration before consent');
  await desktop.getByLabel('我明确确认按此方案更改本机网络配置，创建持久 Serve 映射。', { exact: true }).check();
  await applyServe.click();
  await desktop.locator('.remote-reconnect > summary').click();
  await desktop.getByRole('textbox', { name: '当前连接链接', exact: true }).waitFor();
  const networkDeadline = Date.now() + 10000;
  while ((await readNetworkCli()).mutations.length < 1 && Date.now() < networkDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual((await readNetworkCli()).mutations, [['serve', '--bg', '--https=443', '--set-path=/', address.origin]]);
  const publishedDeadline = Date.now() + 10000;
  while (remote.state().directUrl !== 'https://fixture.example.ts.net' && Date.now() < publishedDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(remote.state().directUrl, 'https://fixture.example.ts.net');
  assert.match(await desktop.getByRole('textbox', { name: '当前连接链接', exact: true }).inputValue(), /^https:\/\/fixture\.example\.ts\.net\/#/);
  await desktop.getByRole('combobox', { name: '手机访问方式', exact: true }).click();
  await desktop.getByRole('option', { name: '公网', exact: true }).click();
  await desktop.getByRole('button', { name: '生成公网 Funnel 方案', exact: true }).click();
  const scopeConsent = desktop.getByLabel('我明确确认按此方案更改入口访问范围。', { exact: true });
  const publicConsent = desktop.getByLabel('我再次确认将此 Remote 入口公开到互联网。', { exact: true });
  const applyScope = desktop.getByRole('button', { name: '确认更改入口范围', exact: true });
  await applyScope.waitFor();
  assert.equal(await applyScope.isDisabled(), true);
  assert.equal((await readNetworkCli()).mutations.length, 1);
  await scopeConsent.check();
  assert.equal(await applyScope.isDisabled(), true, 'scope consent alone cannot publish');
  assert.equal((await readNetworkCli()).mutations.length, 1);
  await scopeConsent.uncheck();
  await publicConsent.check();
  assert.equal(await applyScope.isDisabled(), true, 'public consent alone cannot publish');
  assert.equal((await readNetworkCli()).mutations.length, 1);
  await scopeConsent.check();
  await applyScope.click();
  await desktop.getByRole('status', { name: '网络配置状态', exact: true }).getByText('公网入口', { exact: true }).waitFor();
  assert.equal(remote.state().network.scope, 'public');
  const publicMapping = await readNetworkCli();
  assert.deepEqual(publicMapping.mutations.at(-1), ['funnel', '--bg', '--https=443', '--set-path=/', address.origin]);
  assert.equal(publicMapping.mutations.length, 2);
  assert.deepEqual(publicMapping.config.AllowFunnel, { 'fixture.example.ts.net:443': true });
  await desktop.getByRole('button', { name: '生成恢复私人入口方案', exact: true }).click();
  await applyScope.waitFor();
  assert.equal(await scopeConsent.isChecked(), false, 'new private proposal resets prior consent');
  assert.equal(await publicConsent.count(), 0);
  assert.equal(await applyScope.isDisabled(), true);
  assert.equal((await readNetworkCli()).mutations.length, 2);
  await scopeConsent.check();
  await applyScope.click();
  await desktop.getByRole('status', { name: '网络配置状态', exact: true }).getByText('私人入口', { exact: true }).waitFor();
  assert.equal(remote.state().network.scope, 'private');
  const privateMapping = await readNetworkCli();
  assert.equal(privateMapping.config.AllowFunnel, undefined);
  assert.equal(privateMapping.mutations.length, 3);
  assert.deepEqual(privateMapping.mutations.at(-1), ['serve', '--bg', '--https=443', '--set-path=/', address.origin]);
  networkWizard.scopeTransitions = ['private', 'public', 'private'];
  networkWizard.singleConsentMutations = 0;
  checks.push('production Electron requires both public-scope consents; isolated fake Funnel mapping restores private scope with fresh consent before disable; not public-network T44');
  await desktop.getByRole('button', { name: '关闭 Remote 并移除映射', exact: true }).click();
  const enableLocal = desktop.getByRole('button', { name: '启用本机入口', exact: true });
  await enableLocal.waitFor();
  const removalDeadline = Date.now() + 10000;
  while (await enableLocal.isDisabled() && Date.now() < removalDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  const networkResult = await readNetworkCli();
  assert.deepEqual(networkResult.config, {});
  assert.deepEqual(networkResult.mutations, [
    ['serve', '--bg', '--https=443', '--set-path=/', address.origin],
    ['funnel', '--bg', '--https=443', '--set-path=/', address.origin],
    ['serve', '--bg', '--https=443', '--set-path=/', address.origin],
    ['serve', '--bg', '--https=443', '--set-path=/', 'off'],
  ]);
  assert.equal(remote.state().directEnabled, false);
  networkWizard.mutations = networkResult.mutations.map((args, index) => ({ operation: args.at(-1) === 'off' ? 'remove' : args[0] === 'funnel' ? 'public' : index === 0 ? 'apply' : 'private', httpsPort: 443 }));
  networkWizard.executed = true;
  await desktop.screenshot({ path: join(scratch, 'desktop-network-wizard.png') });
  checks.push('production Electron network inspect/proposal/consent/apply/disable uses private DesktopService; isolated fake CLI observes no mutation before consent');
  await enableLocal.click();
  const localDeadline = Date.now() + 10000;
  while (!remote.state().directEnabled && Date.now() < localDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(remote.state().directEnabled, true);
  const invitationStarted = Date.now();
  await desktop.getByRole('button', { name: '生成配对链接', exact: true }).click();
  const payload = await desktop.getByRole('textbox', { name: '配对链接', exact: true }).inputValue();
  address = remote.direct;
  const invitationFinished = Date.now();
  const invite = { payload };

  const invitation = new URL(invite.payload);
  assert.equal(invitation.origin, address.origin);
  assert.equal(invitation.search, '');
  assert.equal(new URLSearchParams(invitation.hash.slice(1)).get('invite').length, 64);
  checks.push('one-use invitation uses URL fragment');
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(invite.payload);
  assertPublicDirectUrl(page.url(), invite.payload);
  await page.getByRole('button', { name: '连接电脑' }).click();
  await page.locator('#status').getByText(/等待桌面确认/).waitFor({ timeout: 10000 });
  const pending = (await remote.control({ operation: 'status' })).pending;
  assert.equal(pending.length, 1);
  assert.ok(pending[0].expiresAt >= invitationStarted + 120000 && pending[0].expiresAt <= invitationFinished + 120000, 'Host deadline is 120 seconds from invitation creation');
  assert.ok((await page.locator('#device').textContent()).includes(pending[0].fingerprint));
  assert.equal(await page.locator('#projects li').count(), 0);
  const approval = desktop.getByRole('group', { name: `确认设备 ${pending[0].id}` });
  await approval.getByLabel('workspace', { exact: true }).check();
  await approval.getByLabel('second-project', { exact: true }).check();
  await approval.getByRole('radio', { name: '可操作', exact: true }).check();
  const originalSave = backend.save.bind(backend);
  backend.save = (name, value) => name === 'remote.json' ? Promise.reject(new Error('fixture disk failure')) : originalSave(name, value);
  await approval.getByRole('button', { name: '确认配对', exact: true }).click();
  await desktop.getByRole('alert').getByText(/fixture disk failure/).waitFor();
  assert.equal(await page.locator('#projects li').count(), 0);
  assert.equal((await remote.control({ operation: 'status' })).deviceGrants.length, 0);
  assert.match(await page.locator('#status').textContent(), /等待桌面确认/);
  backend.save = originalSave;
  await approval.getByRole('button', { name: '确认配对', exact: true }).click();

  await page.locator('#status').getByText(/已连接/).waitFor({ timeout: 10000 });
  assert.match(await page.locator('#projects').textContent(), /workspace.*online/);
  assert.equal(await page.locator('#status').textContent(), '已连接电脑 · 可操作');
  assert.equal(await page.locator('#connection-protocol').textContent(), '能力：observe、review、submit、interrupt、answer、pauseTask；消息上限：262144 字节');
  assert.equal((await page.locator('body').textContent()).includes(privateService.token), false);
  assert.equal((await page.locator('body').textContent()).includes(workspace), false);
  checks.push('real browser and production desktop UI require durable local approval; disk failure never grants');
  await desktop.screenshot({ path: join(scratch, 'desktop-pairing.png') });
  await page.screenshot({ path: join(scratch, 'remote-pairing.png') });
  await desktop.locator('.remote-device-management > summary').click();
  const grant = desktop.getByRole('group', { name: `授权设备 ${pending[0].id}` });
  backend.save = (name, value) => name === 'remote.json' ? Promise.reject(new Error('fixture revoke failure')) : originalSave(name, value);
  await grant.getByRole('button', { name: '撤销访问' }).click();
  await desktop.getByRole('alert').getByText(/fixture revoke failure/).waitFor();
  assert.equal((await remote.control({ operation: 'status' })).deviceGrants[0].status, 'active');
  assert.equal(await page.locator('#projects li').count(), 2);
  backend.save = originalSave;
  await grant.getByLabel('second-project', { exact: true }).uncheck();
  await grant.getByRole('radio', { name: '仅查看', exact: true }).check();
  await grant.getByRole('button', { name: '保存授权' }).click();
  await page.locator('#status').getByText(/已断开/).waitFor();
  assert.equal(await page.locator('#projects li').count(), 0);
  await page.getByRole('button', { name: '连接电脑' }).click();
  await page.locator('#status').getByText(/已连接/).waitFor();
  assert.equal((await remote.control({ operation: 'status' })).deviceGrants[0].revision, 2);
  assert.equal(await page.locator('#projects li').count(), 1);
  assert.deepEqual((await remote.control({ operation: 'status' })).deviceGrants[0].projectIds, [projectId]);
  await desktop.locator('.remote-device-management > summary').click();
  await grant.getByRole('button', { name: '撤销访问' }).click();
  await page.locator('#status').getByText(/已断开/).waitFor();
  await page.getByRole('button', { name: '连接电脑' }).click();
  await page.locator('#status').getByText(/未获授权/).waitFor();
  checks.push('failed revoke stays active; preset narrowing closes old connection; durable revoke blocks reconnect');
  const openInvite = async link => { const target = await browser.newPage(); await target.goto(link); assertPublicDirectUrl(target.url(), link); await target.getByRole('button', { name: '连接电脑' }).click(); return target; };
  const pinInvite = await remote.control({ operation: 'pair' });
  const wrongURL = new URL(pinInvite.payload);
  const wrongParts = new URLSearchParams(wrongURL.hash.slice(1)); wrongParts.set('host', identityId(await createIdentity())); wrongURL.hash = wrongParts.toString();
  const wrong = await openInvite(wrongURL.href);
  await wrong.locator('#status').getByText(/不匹配|remote peer|expected/i).waitFor();
  assert.equal((await remote.control({ operation: 'status' })).pending.length, 0);
  const racers = await Promise.all([openInvite(pinInvite.payload), openInvite(pinInvite.payload)]);
  for (const target of racers) await target.locator('#status').getByText(/等待桌面确认|邀请已使用/).waitFor();
  const claims = (await remote.control({ operation: 'status' })).pending;
  assert.equal(claims.length, 1);
  assert.equal((await Promise.all(racers.map(target => target.locator('#status').textContent()))).filter(text => text.includes('等待桌面确认')).length, 1);
  for (const target of racers) assert.equal(await target.locator('#projects li').count(), 0);
  await desktop.getByRole('group', { name: `确认设备 ${claims[0].id}` }).getByRole('button', { name: '拒绝配对' }).click();
  checks.push('wrong pin does not consume invitation; concurrent browser claims have one winner and neither auto-authorizes');
  for (const target of [wrong, ...racers]) await target.close();
  const cancelled = await remote.control({ operation: 'pair' });
  await remote.control({ operation: 'cancelPair' });
  const cancelledPage = await openInvite(cancelled.payload);
  await cancelledPage.locator('#status').getByText(/使用或取消/).waitFor(); await cancelledPage.close();
  const expired = await remote.control({ operation: 'pair' });
  const actualNow = Date.now;
  Date.now = () => actualNow() + 121000;
  try {
    const expiredPage = await openInvite(expired.payload);
    await expiredPage.locator('#status').getByText(/邀请已过期/).waitFor(); await expiredPage.close();
  } finally { Date.now = actualNow; }
  const pasted = await remote.control({ operation: 'pair' });
  const pastedPage = await browser.newPage(); await pastedPage.goto(address.origin);
  await pastedPage.locator('.paste-invitation > summary').click();
  await pastedPage.getByRole('textbox', { name: '粘贴配对链接' }).fill(pasted.payload);
  await pastedPage.getByRole('button', { name: '使用配对链接' }).click();
  assert.equal(await pastedPage.getByRole('textbox', { name: '粘贴配对链接' }).inputValue(), '');
  await pastedPage.getByRole('button', { name: '连接电脑' }).click();
  await pastedPage.locator('#status').getByText(/等待桌面确认/).waitFor();
  await remote.control({ operation: 'cancelPair' });
  await pastedPage.locator('#status').getByText(/配对已取消/).waitFor(); await pastedPage.close();
  checks.push('expired/cancelled invites fail; accessible paste clears input; cancelling pending approval denies access');
  assert.equal((await fetch(address.origin + '/service.json')).status, 404);
  await remote.control({ operation: 'disableDirect' });
  encryptionFixture.isEncryptionAvailable = () => false;
  await assert.rejects(() => remote.control({ operation: 'enableDirect' }));
  assert.equal(remote.direct ?? null, null);
  assert.equal(remote.state().directEnabled, false);
  encryptionFixture.isEncryptionAvailable = () => true;
  checks.push('unavailable secure storage rejects enable without leaving a listener');

  passed = true;
  checks.push('public listener did not expose desktop service token or route');
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
} finally {
  await browser?.close(); await application.close(); await app?.close(); service?.close();
  for (const project of backend.projects.values()) {
    try { await project.client?.request('areal/server/drain', { strategy: 'cancel' }); } catch { /* 保留原失败。 */ }
  }
  await backend.shutdown().catch(() => backend.disconnect());
  await backend.disconnect();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  const manifest = { passed, checks, networkWizard, modelRequests, transport: 'direct-loopback',
    screenshots: ['desktop-network-wizard.png (production Electron with fake CLI)', 'desktop-pairing.png (production Electron)', 'remote-pairing.png (desktop Chrome; not mobile acceptance)'],
    command: 'pnpm --dir clients/gui run test:remote-pairing-e2e',
    source: { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
      diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex') },
    core: { binary: backend.binary, sha256: await fileSha256(backend.binary) },
    environment: { node: process.version, chrome: browser?.version() ?? null, platform: process.platform, arch: process.arch },
    scope: 'real isolated DesktopService/Core/Runtime, deterministic local model, production Electron settings and Remote browser page; shared application owner identity supplied by fixture, not application-exit acceptance',
    notRun: ['real Tailscale/tailnet/Funnel/public T44 and phone reachability', 'public HTTPS/WSS', 'mobile Safari/Chrome devices', 'system keychain', 'signed package', 'Relay'] };
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
