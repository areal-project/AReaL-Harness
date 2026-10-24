import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { arch, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Log files older than this are deleted when a log opens. */
export const RETENTION_DAYS = 7;
/** Matching log files beyond this total are deleted oldest first when a log opens. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** One process stops writing once its file reaches this size. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_NAME = /^[a-z0-9-]+-\d{8}T\d{6}Z-\d+\.jsonl$/;
const MAX_STRING = 200;

/** Where diagnostic logs go: `LCU_LOG_DIR`, else the platform's per-user log or state directory. */
export function diagnosticLogDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.LCU_LOG_DIR) return env.LCU_LOG_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Logs', 'LCU');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'lcu', 'logs');
}

function compactUtc(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function releaseVersion() {
  try {
    const bundle = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bundle.json');
    const { version } = JSON.parse(readFileSync(bundle, 'utf8'));
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Delete expired logs, then the oldest ones past the total budget. Only files named like our logs are touched. */
function prune(directory, nowMs) {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (!LOG_NAME.test(name)) continue;
    try {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isFile()) files.push({ path, size: stat.size, mtime: stat.mtimeMs });
    } catch { /* vanished or unreadable: leave it */ }
  }
  const remove = file => {
    try { unlinkSync(file.path); return true; } catch { return false; }
  };
  const kept = files.filter(file => nowMs - file.mtime <= RETENTION_DAYS * DAY_MS || !remove(file));
  kept.sort((a, b) => a.mtime - b.mtime);
  let total = kept.reduce((sum, file) => sum + file.size, 0);
  for (const file of kept) {
    if (total <= MAX_TOTAL_BYTES) break;
    if (remove(file)) total -= file.size;
  }
}

function plainFields(fields) {
  const clean = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key === 't' || key === 'event' || value === undefined) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
    else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      clean[key] = value.slice(0, 8).map(item => item.slice(0, MAX_STRING));
    }
  }
  return clean;
}

/**
 * Open this process's diagnostic log. Records metadata only: never tool arguments or results,
 * approval messages, UI text or error text. Any filesystem error disables the log; `event` never throws.
 */
export function openDiagnosticLog({
  adapter, env = process.env, platform = process.platform, home = homedir(), now = Date.now, pid = process.pid,
} = {}) {
  const disabled = { event() {}, path: undefined };
  if (env.LCU_DIAGNOSTIC_LOG === '0') return disabled;
  let fd;
  try {
    const name = typeof adapter === 'string' && /^[a-z0-9-]+$/.test(adapter) ? adapter : 'client';
    const directory = diagnosticLogDirectory({ env, platform, home });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o777) !== 0o700) {
      try { chmodSync(directory, 0o700); } catch { /* not ours to change */ }
    }
    try { prune(directory, now()); } catch { /* retention is best effort */ }
    const path = join(directory, `${name}-${compactUtc(now())}-${pid}.jsonl`);
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL, 0o600);
    let bytes = fstatSync(fd).size;
    let open = true;
    const append = record => {
      const line = `${JSON.stringify({ t: new Date(now()).toISOString(), ...record })}\n`;
      bytes += writeSync(fd, line);
    };
    const log = {
      path,
      event(type, fields) {
        if (!open) return;
        try {
          append({ event: type, ...plainFields(fields) });
          if (bytes >= MAX_FILE_BYTES) {
            open = false;
            append({ event: 'log_full' });
            closeSync(fd);
          }
        } catch (error) {
          open = false;
          try { closeSync(fd); } catch { /* already closed */ }
          console.error(`LCU diagnostic log disabled: ${error.code ?? 'write failed'}`);
        }
      },
    };
    log.event('log_open', {
      adapter: name, lcu_version: releaseVersion(), platform, arch: arch(), pid,
      retention_days: RETENTION_DAYS, max_total_bytes: MAX_TOTAL_BYTES, max_file_bytes: MAX_FILE_BYTES,
    });
    return log;
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    console.error(`LCU diagnostic log disabled: ${error?.code ?? 'open failed'}`);
    return disabled;
  }
}
