import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { WorkspaceNetworkPolicy } = require('../app/src/core/browser-network.cjs');
const controls = () => ['ws://127.0.0.1:41001', 'ws://127.0.0.1:41002'];

function installed(policy, resolveHost = async () => { throw new Error('ordinary browsing must use Chromium DNS'); }) {
  const listeners = {};
  const session = { resolveHost, webRequest: {
    onBeforeRequest: (_, listener) => { listeners.before = listener; },
    onHeadersReceived: (_, listener) => { listeners.headers = listener; },
  } };
  policy.install(session);
  return { session, request: details => new Promise(resolve => listeners.before(details, resolve)),
    headers: details => new Promise(resolve => listeners.headers(details, resolve)) };
}

test('ordinary public and local browsing accepts redirects, CDN, frames and sockets without Origin grants', async () => {
  const policy = new WorkspaceNetworkPolicy(controls);
  const hook = installed(policy);
  for (const url of ['https://google.com/', 'http://192.168.1.1/', 'http://localhost:31000/', 'http://service.internal/'])
    assert.equal(policy.allowHumanNavigation(url), true, url);
  for (const [url, resourceType] of [
    ['https://www.google.com/search?q=AI+Agent', 'mainFrame'],
    ['https://cdn.example/script.js', 'script'], ['https://video.example/embed', 'subFrame'],
    ['https://api.example/query', 'xhr'], ['http://localhost:31001/worker.js', 'other'],
    ['wss://stream.example/events', 'webSocket'], ['ws://127.0.0.1:31000/events', 'webSocket'],
  ]) assert.deepEqual(await hook.request({ url, resourceType }), { cancel: false }, url);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello',
    'https://user:secret@example.com/', 'ws://example.com/'])
    assert.equal(policy.allowHumanNavigation(url, true), false, url);
  assert.equal(policy.permits({ url: 'ws://example.com/', resourceType: 'mainFrame' }), false);
  policy.close();
  assert.deepEqual(await hook.request({ url: 'https://google.com/', resourceType: 'mainFrame' }), { cancel: true });
});

test('site response policies and attachment headers are preserved without app policies', async () => {
  const hook = installed(new WorkspaceNetworkPolicy(controls));
  for (const responseHeaders of [
    { 'Content-Type': ['text/html'] },
    { 'content-security-policy': ["script-src 'self' https://cdn.example"], 'Connection-Allowlist': ['(response-origin); redirects=block'] },
    { 'Content-Disposition': ['attachment; filename=test.txt'], 'connection-allowlist': ['(response-origin)'] },
  ]) {
    const original = structuredClone(responseHeaders);
    assert.deepEqual(await hook.headers({ url: 'https://example.com/', resourceType: 'mainFrame', responseHeaders }), {});
    assert.deepEqual(responseHeaders, original);
  }
});

test('actual control endpoints and DNS aliases are denied for HTTP and WebSocket', async () => {
  const policy = new WorkspaceNetworkPolicy(controls);
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', 'app.localhost', '[::1]', '[::ffff:127.0.0.1]', '0.0.0.0']) {
    for (const protocol of ['http', 'https', 'ws', 'wss'])
      assert.equal(policy.permits({ url: `${protocol}://${host}:41001/api`, resourceType: protocol.startsWith('ws') ? 'webSocket' : 'xhr' }), false);
  }
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '198.18.8.29']) {
    const hook = installed(policy, async () => ({ endpoints: [{ address }] }));
    assert.deepEqual(await hook.request({ url: 'https://alias.example:41002/api', resourceType: 'xhr' }), { cancel: true });
    assert.deepEqual(await hook.request({ url: 'ws://alias.example:41002/api', resourceType: 'webSocket' }), { cancel: true });
  }
  const unavailable = installed(policy, async () => { throw new Error('DNS unavailable'); });
  assert.deepEqual(await unavailable.request({ url: 'http://alias.example:41001/', resourceType: 'xhr' }), { cancel: true });
  const ordinary = installed(policy, async () => ({ endpoints: [{ address: '93.184.215.14' }] }));
  assert.deepEqual(await ordinary.request({ url: 'https://example.com:41001/', resourceType: 'xhr' }), { cancel: true });
});

test('fake-IP and private-address resolution do not replace normal Chromium routing', async () => {
  const policy = new WorkspaceNetworkPolicy(controls);
  for (const address of ['198.18.8.29', '192.168.1.1', '169.254.169.254']) {
    const hook = installed(policy, async () => ({ endpoints: [{ address }] }));
    assert.deepEqual(await hook.request({ url: 'https://google.com/', resourceType: 'mainFrame' }), { cancel: false });
  }
});

test('scoped Human frame grants remain bound to their contents, parent and live grant', () => {
  const policy = new WorkspaceNetworkPolicy(controls);
  const parent = { url: 'https://parent.example/' };
  const contents = { id: 17, mainFrame: parent };
  let valid = true;
  policy.bindFrameGrant({ contents, origin: 'https://frame.example', parentURL: parent.url, status: 'reloading', valid: () => valid });
  const frame = { parent, origin: 'https://frame.example', isDestroyed: () => false };
  const details = { webContentsId: 17, url: 'https://frame.example/script.js', resourceType: 'script', frame };
  assert.equal(policy.permits(details), true);
  assert.equal(policy.permits({ ...details, url: 'https://unrelated.example/script.js' }), false);
  assert.equal(policy.permits({ ...details, frame: { ...frame, parent: {} } }), false);
  valid = false;
  assert.equal(policy.permits(details), false);
  policy.revokeFrameGrant(17);
  assert.equal(policy.permits(details), true);
});
