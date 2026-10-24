'use strict';
// Adapted from ZCode terminalProfile.ts and terminalProfileMacOs.ts at
// 3c5b227649371507ddc4eb46ac5133afe6db1cab, copyright 2026 Z.AI Co., Ltd.
// Apache-2.0. See renderer/ZCODE-LICENSE and THIRD-PARTY-NOTICES.md.
// AReaL uses bounded asynchronous reads, the supplied home, and presentation only.
const { readFile, stat } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');

const FALLBACKS = ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', 'Noto Sans Mono CJK SC', 'monospace'];
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const MAX_BYTES = 2 * 1024 * 1024;
const text = value => typeof value === 'string' ? value.trim() : '';
const fontSize = value => { const size = Number.parseFloat(value); return Number.isFinite(size) && size >= 6 && size <= 72 ? size : undefined; };
const fontName = value => text(value).replace(/\s+\d+(?:\.\d+)?$/, '').replace(/-/g, ' ');
const hasProfile = profile => profile.fontFamily || profile.fontSize || profile.theme;

async function readConfig(file, signal) {
  if (signal.aborted) return null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const raw = await readFile(file, { signal });
    return raw.length <= MAX_BYTES ? raw : null;
  } catch { return null; }
}

function plutil(format, input, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/plutil', ['-convert', format, '-o', '-', '--', '-'], { encoding: 'utf8', timeout: 1000, maxBuffer: MAX_BYTES, signal }, (error, output) => error ? reject(error) : resolve(output));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function readPlist(input, signal) {
  try {
    // Terminal stores fonts and colors as NSData. plutil cannot convert NSData
    // to JSON, so preserve its base64 text before the second conversion.
    const xml = await plutil('xml1', input, signal);
    const portable = xml
      .replace(/<data>([\s\S]*?)<\/data>/g, (_, data) => `<string>${data.replace(/\s/g, '')}</string>`)
      .replace(/<date>(.*?)<\/date>/g, '<string>$1</string>')
      .replace(/<key>CF\$UID<\/key>/g, '<key>NSArchiveUID</key>');
    const json = await plutil('json', portable, signal);
    return JSON.parse(json);
  } catch { return null; }
}

async function archivedObject(value, signal) {
  if (typeof value !== 'string') return null;
  return readPlist(Buffer.from(value, 'base64'), signal);
}

async function terminalFont(profile, signal) {
  const descriptor = text(profile.Font);
  let family = text(profile.FontName);
  let size = fontSize(profile.FontSize);
  if (!family && descriptor && !/^[A-Za-z0-9+/]+=*$/.test(descriptor)) family = fontName(descriptor);
  if (!size) size = fontSize(descriptor.match(/\s+(\d+(?:\.\d+)?)$/)?.[1]);
  if (!family && descriptor) {
    const archive = await archivedObject(descriptor, signal);
    const objects = archive?.$objects;
    if (Array.isArray(objects)) {
      const font = objects.find(object => object && typeof object === 'object' && (object.NSName || object.NSFontName));
      const name = font?.NSName ?? font?.NSFontName;
      family = fontName(typeof name === 'string' ? name : objects[name?.NSArchiveUID]);
      size ??= fontSize(font?.NSSize);
    }
  }
  return { fontFamily: family || undefined, fontSize: size };
}

function color(value) {
  if (typeof value === 'string') return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(value.trim()) ? value.trim() : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const components = ['Red', 'Green', 'Blue'].map(key => Number(value[`${key} Component`] ?? value[key.toLowerCase()] ?? value[key]));
  if (components.some(component => !Number.isFinite(component) || component < 0 || component > 1)) return undefined;
  return '#' + components.map(component => Math.round(component * 255).toString(16).padStart(2, '0')).join('');
}

async function terminalColor(value, signal) {
  const direct = color(value);
  if (direct || !value) return direct;
  const archive = await archivedObject(value, signal);
  for (const object of archive?.$objects ?? []) {
    if (!object || typeof object !== 'object') continue;
    const rgb = object.NSRGB || object.NSWhite;
    if (typeof rgb !== 'string') continue;
    const components = Buffer.from(rgb, 'base64').toString('ascii').replace(/\0/g, '').trim().split(/\s+/).map(Number);
    if (object.NSWhite) components.splice(0, components.length, components[0], components[0], components[0]);
    const result = color({ red: components[0], green: components[1], blue: components[2] });
    if (result) return result;
  }
}

async function macProfile(home, signal) {
  const iterm = await readConfig(join(home, 'Library', 'Preferences', 'com.googlecode.iterm2.plist'), signal);
  if (iterm) {
    const plist = await readPlist(iterm, signal);
    const profiles = Array.isArray(plist?.['New Bookmarks']) ? plist['New Bookmarks'] : [];
    const preferred = profiles.find(profile => profile?.Guid === plist['Default Bookmark Guid']) ?? profiles.find(profile => profile?.['Default Bookmark'] === true);
    for (const profile of preferred ? [preferred, ...profiles.filter(item => item !== preferred)] : profiles) {
      if (!profile || typeof profile !== 'object') continue;
      const theme = {};
      const keys = { foreground: 'Foreground Color', background: 'Background Color', cursor: 'Cursor Color', cursorAccent: 'Cursor Text Color', selectionBackground: 'Selection Color', ...Object.fromEntries(ANSI.map((key, index) => [key, `Ansi ${index} Color`])) };
      for (const [key, source] of Object.entries(keys)) { const value = color(profile[source]); if (value) theme[key] = value; }
      const descriptor = text(profile['Normal Font']);
      const detected = { fontFamily: fontName(descriptor) || undefined, fontSize: fontSize(descriptor.match(/\s+(\d+(?:\.\d+)?)$/)?.[1]), theme: Object.keys(theme).length ? theme : undefined };
      if (hasProfile(detected)) return detected;
    }
  }
  const terminal = await readConfig(join(home, 'Library', 'Preferences', 'com.apple.Terminal.plist'), signal);
  if (!terminal) return null;
  const plist = await readPlist(terminal, signal);
  for (const name of [plist?.['Startup Window Settings'], plist?.['Default Window Settings']]) {
    const profile = plist?.['Window Settings']?.[name];
    if (!profile || typeof profile !== 'object') continue;
    const keys = { foreground: 'TextColor', background: 'BackgroundColor', cursor: 'CursorColor', selectionBackground: 'SelectionColor', ...Object.fromEntries(ANSI.map(key => [key, `ANSI${key[0].toUpperCase() + key.slice(1)}Color`])) };
    const colors = await Promise.all(Object.entries(keys).map(async ([key, source]) => [key, await terminalColor(profile[source], signal)]));
    const theme = Object.fromEntries(colors.filter(([, value]) => value));
    const detected = { ...await terminalFont(profile, signal), theme: Object.keys(theme).length ? theme : undefined };
    if (hasProfile(detected)) return detected;
  }
  return null;
}

async function textProfile(home, signal) {
  for (const file of [join(home, '.config', 'kitty', 'kitty.conf'), join(home, 'Library', 'Application Support', 'kitty', 'kitty.conf')]) {
    const raw = await readConfig(file, signal);
    const family = text(raw?.toString('utf8').match(/^\s*font_family\s+(.+)$/m)?.[1]).replace(/^"|"$/g, '');
    if (family) return { fontFamily: family };
  }
  return null;
}

async function resolveTerminalPresentation(settings = {}, home) {
  let detected = null;
  if (settings?.terminalInheritSystemProfile !== false) {
    const signal = AbortSignal.timeout(2500);
    try {
      if (home === undefined) home = homedir();
      const lookup = async () => typeof home === 'string' && isAbsolute(home) ? (process.platform === 'darwin' ? await macProfile(home, signal) : null) ?? await textProfile(home, signal) : null;
      detected = await Promise.race([lookup(), new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))]);
    }
    catch {}
  }
  const custom = text(settings?.terminalFontFamily);
  const family = custom || detected?.fontFamily || '';
  const stack = [...new Set([...family.split(',').map(part => part.trim()).filter(Boolean), ...FALLBACKS])].join(', ');
  return { fontFamily: stack, fontSize: detected?.fontSize, theme: detected?.theme, fontFamilySource: custom ? 'custom' : detected ? 'system' : 'fallback' };
}

module.exports = { resolveTerminalPresentation };
