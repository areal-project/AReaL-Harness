const assert = require('node:assert/strict');
const { createCipheriv, createHash, pbkdf2Sync } = require('node:crypto');
const { mkdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const fixtureSecret = 'areal-synthetic-cookie-key';
const logs = [];
const logger = {
  info: (...args) => logs.push(args),
  warn: (...args) => logs.push(args),
};

async function seedProfile(root, host = 'fixture.example') {
  const profilePath = join(root, 'User Data', 'Default');
  await mkdir(profilePath, { recursive: true });
  const databasePath = join(profilePath, 'Cookies');
  const database = new DatabaseSync(databasePath);
  const key = pbkdf2Sync(fixtureSecret, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('encrypted-fixture-value')])),
    cipher.final(),
  ]);
  key.fill(0);
  try {
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, value TEXT, encrypted_value BLOB);");
    const insert = database.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [name, value, bytes] of [
      ['plain', 'plain-fixture-value', Buffer.alloc(0)],
      ['encrypted', '', encrypted],
      ['unsupported', '', Buffer.from('v99-unsupported-fixture')],
      ['empty', '', Buffer.alloc(0)],
      ['denied-write', 'blocked-fixture-value', Buffer.alloc(0)],
    ]) insert.run(host, name, '/', 0n, 0, 1, 1, value, bytes);
  } finally {
    database.close();
  }
  return { profilePath, databasePath };
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function checkImports(api, root, targetSession) {
  const fixture = await seedProfile(root);
  const before = await digest(fixture.databasePath);
  let localStorageCalls = 0;
  const result = await api.importChromeBrowserData({
    platform: 'darwin',
    profilePath: fixture.profilePath,
    targetSession,
    registerWebContents: () => { throw new Error('unexpected_window'); },
    logger,
    macChromeSafeStorageSecretReader: async () => fixtureSecret,
    localStorageImporter: async () => {
      localStorageCalls += 1;
      return { originsImported: 0, entriesImported: 0, originsSkipped: 0, originsFailed: 1, error: 'chrome_local_storage_import_failed' };
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.cookies, { imported: 2, skipped: 2, failed: 1 });
  assert.equal(result.localStorage.originsFailed, 1);
  assert.ok(result.issues.includes('chrome_cookie_protection_unsupported'));
  assert.ok(result.issues.includes('chrome_local_storage_import_failed'));
  assert.equal(localStorageCalls, 1);
  assert.equal(await digest(fixture.databasePath), before);

  const denied = await api.importChromeBrowserData({
    platform: 'darwin',
    profilePath: fixture.profilePath,
    targetSession: {
      cookies: {
        set: async () => { throw new Error('unexpected_denied_write'); },
        flushStore: async () => {},
      },
    },
    registerWebContents: () => { throw new Error('unexpected_window'); },
    logger,
    macChromeSafeStorageSecretReader: async () => { throw Object.assign(new Error('fixture_user_denied'), { code: 128 }); },
    localStorageImporter: async () => { throw new Error('unexpected_local_storage_after_denial'); },
  });
  assert.equal(denied.success, false);
  assert.equal(denied.error, 'chrome_cookie_access_denied');
  assert.deepEqual(denied.cookies, { imported: 0, skipped: 0, failed: 0 });
  assert.equal(await digest(fixture.databasePath), before);
  await assert.rejects(() => api.readWindowsChromeAppBoundKey({ logger, chromeExecutablePath: '/synthetic/chrome', userDataDir: root }), { code: 'chrome_import_not_supported' });
  const serializedLogs = JSON.stringify(logs);
  for (const value of [fixtureSecret, 'plain-fixture-value', 'encrypted-fixture-value', fixture.profilePath]) {
    assert.equal(serializedLogs.includes(value), false);
  }
  return { partial: result, denied };
}

module.exports = { checkImports, digest, fixtureSecret, logger, logs, seedProfile };
