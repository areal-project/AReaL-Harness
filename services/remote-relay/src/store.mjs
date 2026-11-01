import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, copyFileSync, unlinkSync, renameSync, constants } from 'node:fs';
import { join } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function openStore(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  const path = join(config.dataDir, 'relay.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS enrollments (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY, active INTEGER NOT NULL, created INTEGER NOT NULL, max_channels INTEGER NOT NULL);`);
  return { db,
    enrollment() {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM enrollments WHERE expires < ?').run(Date.now());
        if (db.prepare('SELECT count(*) AS n FROM enrollments').get().n >= config.maxEnrollmentCodes) throw new Error('CAPACITY_EXCEEDED');
        const code = secret(); const expiresAt = Date.now() + 600000;
        db.prepare('INSERT INTO enrollments(hash,expires) VALUES (?,?)').run(hash(code), expiresAt);
        db.exec('COMMIT'); return { code, expiresAt };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    enroll(code) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM enrollments WHERE hash=? AND consumed=0 AND expires>?').get(hash(code), Date.now());
        if (!row || db.prepare('SELECT count(*) AS n FROM rooms').get().n >= config.maxRooms) { db.exec('ROLLBACK'); return null; }
        const capability = secret(); const room = hash(capability);
        db.prepare('UPDATE enrollments SET consumed=1 WHERE hash=?').run(hash(code));
        db.prepare('INSERT INTO rooms VALUES (?,1,?,?)').run(room, Date.now(), config.maxChannelsPerHost);
        db.exec('COMMIT'); return { capability, room };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    provision(room) {
      if (typeof room !== 'string' || !/^[a-f0-9]{64}$/.test(room)) throw new Error('INVALID_ROOM');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT active FROM rooms WHERE room=?').get(room);
        if (previous && previous.active !== 1) throw new Error('ROOM_REVOKED');
        if (!previous) {
          if (db.prepare('SELECT count(*) AS n FROM rooms').get().n >= config.maxRooms) throw new Error('CAPACITY_EXCEEDED');
          db.prepare('INSERT INTO rooms VALUES (?,1,?,?)').run(room, Date.now(), config.maxChannelsPerHost);
        }
        db.exec('COMMIT'); return { room, active: true };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    room(room) { return db.prepare('SELECT max_channels FROM rooms WHERE room=? AND active=1').get(room); },
    revoke(room) { if (!/^[a-f0-9]{64}$/.test(room ?? '')) throw new Error('INVALID_ROOM'); db.prepare('UPDATE rooms SET active=0 WHERE room=?').run(room); return { revoked: true }; },
    async backup(path) { if (existsSync(path)) throw new Error('BACKUP_EXISTS'); await backup(db, path); chmodSync(path, 0o600); return { backedUp: true }; },
    close() { db.close(); },
  };
}
function checkpoint(db) {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (result.busy !== 0 || result.log !== result.checkpointed) throw new Error('CHECKPOINT_INCOMPLETE');
}
export function restore(config, source) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // 恢复要求停止服务；停服锁与 serve 互斥，禁用恢复出的登记后才替换正式库。
  const stage = join(config.dataDir, 'restore.sqlite');
  copyFileSync(source, stage, constants.COPYFILE_EXCL);
  let db;
  try {
    db = new DatabaseSync(stage);
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('BACKUP_INVALID');
    db.exec('UPDATE rooms SET active=0; UPDATE enrollments SET consumed=1;');
    checkpoint(db); db.close(); db = undefined;
    const current = join(config.dataDir, 'relay.sqlite');
    if (existsSync(current)) {
      // 旧库 WAL 可能含已提交的撤销；先由 SQLite 完整落盘，绝不手工删掉恢复所需的日志。
      const previous = new DatabaseSync(current);
      try { previous.exec('PRAGMA busy_timeout=3000'); checkpoint(previous); }
      finally { previous.close(); }
    }
    // 失败或进程中断时，旧库仍保留全部提交；成功替换的新库则已禁用全部登记。
    renameSync(stage, current); chmodSync(current, 0o600);
    return { restored: true, registrationsDisabled: true };
  } finally { db?.close(); if (existsSync(stage)) unlinkSync(stage); }
}
