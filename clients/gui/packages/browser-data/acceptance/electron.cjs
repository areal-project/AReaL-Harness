const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { checkImports } = require('./fixtures.cjs');

const root = process.env.AREAL_BROWSER_DATA_FIXTURE_ROOT;
assert.ok(root, 'Run the fixture through scripts/run-electron.mjs');
app.setPath('userData', join(root, 'userData'));
app.setPath('sessionData', join(root, 'sessionData'));
app.on('window-all-closed', () => {});
childProcess.execFile = () => { throw new Error('fixture_forbids_system_command'); };
childProcess.spawn = () => { throw new Error('fixture_forbids_chrome_launch'); };

async function main() {
  await app.whenReady();
  app.dock?.hide();
  const api = require('../.acceptance/source.cjs');
  const target = session.fromPartition('persist:browser-data-fixture');
  const result = await checkImports(api, root, {
    cookies: {
      set: (cookie) => cookie.name === 'denied-write'
        ? Promise.reject(new Error('fixture_write_denied'))
        : target.cookies.set(cookie),
      flushStore: () => target.cookies.flushStore(),
    },
  });
  const cookies = await target.cookies.get({ domain: 'fixture.example' });
  assert.deepEqual(cookies.map(({ name, value }) => [name, value]).sort(), [
    ['encrypted', 'encrypted-fixture-value'], ['plain', 'plain-fixture-value'],
  ]);
  assert.ok(cookies.every((cookie) => cookie.httpOnly && !cookie.session));
  assert.equal((await session.defaultSession.cookies.get({ domain: 'fixture.example' })).length, 0);

  let siteRequests = 0;
  const server = createServer((_request, response) => {
    siteRequests += 1;
    response.end('<!doctype html><title>Fixture</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const registered = new Set();
  const created = [];
  const registerWebContents = (contents) => {
    assert.equal(contents.session, target);
    registered.add(contents.id);
    created.push(contents);
    return () => { assert.equal(registered.delete(contents.id), true); };
  };
  let verifier;
  try {
    const storage = await api.writeElectronLocalStorage(target, [
      { origin, entries: [['fixture-login', 'shared-user'], ['fixture-theme', 'light']] },
      { origin: 'not-an-origin', entries: [['blocked', 'blocked']] },
    ], registerWebContents);
    assert.deepEqual(storage, { importedOrigins: 1, importedEntries: 2, failedOrigins: 1 });
    assert.equal(siteRequests, 0);
    assert.equal(registered.size, 0);
    assert.equal(created.length, 1);
    assert.ok(created.every((contents) => contents.isDestroyed()));
    verifier = new BrowserWindow({ show: false, webPreferences: { session: target, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await verifier.loadURL(origin);
    assert.deepEqual(await verifier.webContents.executeJavaScript('Object.entries(localStorage).sort()'), [['fixture-login', 'shared-user'], ['fixture-theme', 'light']]);
    verifier.destroy();

    const beforeWindows = BrowserWindow.getAllWindows().length;
    await assert.rejects(() => api.writeElectronLocalStorage(target, [{ origin, entries: [['x', 'y']] }], () => { throw new Error('fixture_registration_denied'); }), /fixture_registration_denied/);
    assert.equal(BrowserWindow.getAllWindows().length, beforeWindows);
    console.log(JSON.stringify({ ok: true, runtime: process.versions, ...result, localStorage: storage, importerContentsDestroyed: created.length, importSiteRequests: 0 }, null, 2));
  } finally {
    if (verifier && !verifier.isDestroyed()) verifier.destroy();
    await new Promise((resolve) => server.close(resolve));
    await target.clearStorageData();
    await target.closeAllConnections();
  }
}

main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
