const assert = require('node:assert/strict');
const Module = require('node:module');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vm = require('node:vm');
const childProcess = require('node:child_process');
const { checkImports, logger } = require('./fixtures.cjs');

childProcess.execFile = () => { throw new Error('fixture_forbids_system_command'); };
childProcess.spawn = () => { throw new Error('fixture_forbids_browser_launch'); };
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { BrowserWindow: class { constructor() { throw new Error('fixture_forbids_window'); } } };
  return originalLoad.call(this, name, ...args);
};

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'areal-browser-data-node-'));
  const received = new Map();
  try {
    const api = require('../.acceptance/source.cjs');
    const result = await checkImports(api, root, {
      cookies: {
        set: async (cookie) => {
          if (cookie.name === 'denied-write') throw new Error('fixture_write_denied');
          received.set(cookie.name, cookie);
        },
        flushStore: async () => {},
      },
    });
    assert.equal(received.get('plain').value, 'plain-fixture-value');
    assert.equal(received.get('encrypted').value, 'encrypted-fixture-value');
    assert.equal(received.get('encrypted').httpOnly, true);
    assert.equal(received.get('encrypted').sameSite, 'lax');
    assert.ok(received.get('plain').expirationDate > Date.now() / 1000);

    const entry = join(__dirname, '../.acceptance/source.cjs');
    const runtimeModule = { exports: {} };
    const requireFromEntry = Module.createRequire(entry);
    const missingSqliteRequire = (name) => {
      if (name === 'node:sqlite') throw Object.assign(new Error('fixture_missing_sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
      return requireFromEntry(name);
    };
    vm.runInNewContext(await readFile(entry, 'utf8'), { require: missingSqliteRequire, module: runtimeModule, exports: runtimeModule.exports, __filename: entry, __dirname, Buffer, process, console, setTimeout, clearTimeout, URL });
    const unavailable = await runtimeModule.exports.importChromeBrowserData({
      platform: 'darwin', profilePath: root, targetSession: {}, registerWebContents: () => () => {}, logger,
    });
    assert.equal(unavailable.success, false);
    assert.equal(unavailable.error, 'chrome_sqlite_unavailable');
    console.log(JSON.stringify({ ok: true, runtime: process.version, ...result, sqliteUnavailable: unavailable.error }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
