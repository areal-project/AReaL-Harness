import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

function isPrivateAddress(host) {
  const value = host.replace(/^\[|\]$/g, '');
  if (isIP(value) === 6) return /^f[cd]/i.test(value);
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export const ceilings = Object.freeze({ maxHosts: 100, maxRooms: 10000, maxEnrollmentCodes: 1024, maxConnections: 256,
  maxPending: 32, maxChannelsPerHost: 16, maxFrameBytes: 524288, maxBufferedBytesPerChannel: 2097152,
  framesPerSecond: 80, bytesPerSecond: 2097152, upgradePerSecond: 50, enrollPerSecond: 10,
  handshakeTimeoutMs: 15000, idleTimeoutMs: 45000 });
export function readConfig(file) {
  return parseConfig(JSON.parse(readFileSync(file, 'utf8')));
}
export function parseConfig(input) {
  const origin = new URL(input.publicOrigin);
  const development = input.development === true;
  const local = input.local === true;
  if (local && development) throw new Error('CONFIG_ORIGIN');
  if (origin.origin !== input.publicOrigin || origin.username || origin.password ||
      (local ? origin.protocol !== 'http:' || !isPrivateAddress(origin.hostname) : development ? origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) : origin.protocol !== 'https:')) throw new Error('CONFIG_ORIGIN');
  const match = (local ? /^(0\.0\.0\.0|127\.0\.0\.1|\[::\]):([0-9]{1,5})$/ : /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/).exec(input.listen);
  if (!match || +match[2] < 1 || +match[2] > 65535 || (!development && !local && input.trustedLocalTlsProxy !== true)) throw new Error('CONFIG_LISTEN');
  if (!Array.isArray(input.allowedClientOrigins) || !input.allowedClientOrigins.length || input.allowedClientOrigins.some(value => {
    try { const u = new URL(value); return u.origin !== value || u.protocol !== origin.protocol || (local && value !== origin.origin) || (development && !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)); } catch { return true; }
  })) throw new Error('CONFIG_CLIENT_ORIGIN');
  const allowedAppOrigins = input.allowedAppOrigins === undefined ? [] : input.allowedAppOrigins;
  if (!Array.isArray(allowedAppOrigins) || allowedAppOrigins.some(value => {
    try {
      const u = new URL(value);
      return !u.hostname || ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) ||
        u.username || u.password || u.port || u.pathname || u.search || u.hash ||
        value !== `${u.protocol}//${u.hostname}` || /[%\\\s]/.test(value);
    } catch { return true; }
  })) throw new Error('CONFIG_APP_ORIGIN');
  let apns;
  if (input.apns !== undefined) {
    const value = input.apns;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['teamId', 'keyId', 'keyFile', 'bundleId', 'maxPerHostPerMinute'].includes(key)) ||
        typeof value.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(value.teamId) || typeof value.keyId !== 'string' || !/^[A-Z0-9]{10}$/.test(value.keyId) ||
        typeof value.keyFile !== 'string' || !value.keyFile || value.keyFile.length > 4096 || value.keyFile.includes('\0') ||
        typeof value.bundleId !== 'string' || value.bundleId.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleId) ||
        (value.maxPerHostPerMinute !== undefined && !Number.isSafeInteger(value.maxPerHostPerMinute)) || (value.maxPerHostPerMinute ?? 60) < 1 || (value.maxPerHostPerMinute ?? 60) > 600) throw new Error('CONFIG_APNS');
    apns = { teamId: value.teamId, keyId: value.keyId, keyFile: resolve(value.keyFile), bundleId: value.bundleId, maxPerHostPerMinute: value.maxPerHostPerMinute ?? 60 };
  }
  const limits = {};
  for (const [key, max] of Object.entries(ceilings)) {
    const value = input[key] ?? max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('CONFIG_LIMIT');
    limits[key] = value;
  }
  if (input.payloadLogging !== undefined && input.payloadLogging !== false) throw new Error('CONFIG_LOGGING');
  if (typeof input.dataDir !== 'string' || !input.dataDir) throw new Error('CONFIG_DATA');
  return { ...limits, publicOrigin: origin.origin, publicHost: origin.host, development, local,
    listenHost: match[1].replace(/[\[\]]/g, ''), listenPort: +match[2],
    allowedClientOrigins: input.allowedClientOrigins, allowedAppOrigins, apns, dataDir: resolve(input.dataDir),
    assetsDir: input.assetsDir ? resolve(input.assetsDir) : undefined };
}
