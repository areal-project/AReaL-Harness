export function loadChromeSqlite(): typeof import('node:sqlite') {
  try {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite');
    if (typeof sqlite.DatabaseSync === 'function' && typeof sqlite.backup === 'function') return sqlite;
  } catch {}
  throw Object.assign(new Error('chrome_sqlite_unavailable'), { code: 'chrome_sqlite_unavailable' });
}
