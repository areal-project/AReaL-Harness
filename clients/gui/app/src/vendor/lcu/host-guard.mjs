import { execFileSync } from 'node:child_process';

/**
 * Computer use can click buttons in any approved app. An app that shows this agent's
 * own approval prompt must therefore never be approved, or the agent could approve
 * itself. The runtime already refuses Terminal, iTerm2 and com.openai.codex; this
 * guard adds the other known agent hosts and the app actually hosting this session.
 *
 * Set LCU_ALLOW_AGENT_HOST_APPROVAL=1 in the adapter's environment to disable it
 * (for tests of the approval flow only).
 */
export const ALLOW_ENV = 'LCU_ALLOW_AGENT_HOST_APPROVAL';

/**
 * Dedicated agent hosts and terminals only. Editors and IDEs (VS Code, Cursor,
 * Windsurf, Antigravity, Zed, ...) are common computer-use targets, so they are left
 * to the parent-chain detection, which refuses them when an agent extension hosts
 * this session.
 */
export const KNOWN_AGENT_HOSTS = new Map([
  ['com.anthropic.claudefordesktop', 'Claude'],
  ['com.anthropic.claude-code', 'Claude Code'],
  ['com.openai.codex', 'Codex'],
  ['ai.opencode.desktop', 'OpenCode'],
  ['com.electron.factory', 'Factory'],
  ['com.nousresearch.hermes', 'Hermes'],
  ['com.deepseek.dsh', 'DeepSeek Harness'],
  ['com.apple.Terminal', 'Terminal'],
  ['com.googlecode.iterm2', 'iTerm2'],
  ['com.mitchellh.ghostty', 'Ghostty'],
  ['dev.warp.Warp-Stable', 'Warp'],
  ['dev.warp.Warp-Preview', 'Warp'],
  ['com.github.wez.wezterm', 'WezTerm'],
  ['org.alacritty', 'Alacritty'],
  ['net.kovidgoyal.kitty', 'kitty'],
  ['co.zeit.hyper', 'Hyper'],
  ['com.raphaelamorim.rio', 'Rio'],
  ['dev.commandline.waveterm', 'Wave'],
]);

const APP_MARKER = '.app/';

/** The outermost `.app` bundle directory containing an executable path, or undefined. */
export function appBundleOf(executablePath) {
  if (typeof executablePath !== 'string') return undefined;
  const index = executablePath.indexOf(APP_MARKER);
  return index < 0 ? undefined : executablePath.slice(0, index + APP_MARKER.length - 1);
}

/** Look up a process on macOS: {ppid, path} from `ps`, or undefined. */
export function psLookup(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(out);
    return match ? { ppid: Number(match[1]), path: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

/** Read CFBundleIdentifier from an app bundle, or undefined. */
export function plistBundleId(bundle) {
  try {
    const id = execFileSync('plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find every app bundle this process runs inside: the outermost `.app` of each
 * ancestor that lives in one (the agent CLI can itself be a bundle, with the real GUI
 * host above it). LCU's own runtime may live in an app bundle (the official app's
 * Node), so ancestors in the same bundle as `execPath` are skipped. Returns a list of
 * {bundle, bundleId, name}, empty when undeterminable. Every lookup is injectable.
 */
export function findHostApps({
  pid = process.pid,
  execPath = process.execPath,
  lookup = psLookup,
  bundleId = plistBundleId,
  maxDepth = 64,
} = {}) {
  const found = [];
  try {
    const own = appBundleOf(execPath);
    const seen = new Set([pid]);
    let current = lookup(pid);
    for (let depth = 0; current && depth < maxDepth; depth++) {
      const parent = current.ppid;
      if (!Number.isInteger(parent) || parent <= 1 || seen.has(parent)) break;
      seen.add(parent);
      current = lookup(parent);
      if (!current) break;
      const bundle = appBundleOf(current.path);
      if (!bundle || bundle === own || found.some(host => host.bundle === bundle)) continue;
      const id = bundleId(bundle);
      if (id) found.push({ bundle, bundleId: id, name: bundle.slice(bundle.lastIndexOf('/') + 1, -4) });
    }
  } catch {
    // Keep whatever was found before the failure.
  }
  return found;
}

let detected;

/** The detected host apps, computed once per process; empty off macOS or on failure. */
export function detectHostApps() {
  if (detected === undefined) detected = process.platform === 'darwin' ? findHostApps() : [];
  return detected;
}

function sameId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Why `app` (a bundle id) must not be approved, or undefined if it may be. */
export function agentHostReason(app, { hosts, env = process.env } = {}) {
  if (typeof app !== 'string' || !app || env?.[ALLOW_ENV] === '1') return undefined;
  for (const host of hosts ?? detectHostApps()) if (sameId(host.bundleId, app)) return host.name;
  for (const [id, name] of KNOWN_AGENT_HOSTS) if (sameId(id, app)) return name;
  return undefined;
}

/** The app bundle id of a native-app approval elicitation, or undefined. */
export function approvalApp(params) {
  const meta = params?._meta;
  const app = meta?.tool_params?.app;
  return meta?.connector_id === 'computer-use' && typeof app === 'string' && app ? app : undefined;
}

/**
 * Shared by every adapter: a decline response for an approval of an agent-hosting app,
 * answered before the host or user is asked; undefined for any other request. `report` receives
 * the explanation (stderr by default; the shared client, which runs inside a TUI, passes a no-op).
 */
export function declineAgentHostApp(params, { report = message => console.error(message), ...options } = {}) {
  const app = approvalApp(params);
  if (!app) return undefined;
  const name = agentHostReason(app, options);
  if (!name) return undefined;
  report(`LCU does not allow computer use to control the app hosting this agent (${name}); ` +
    `declined approval for ${app}`);
  return { action: 'decline' };
}
