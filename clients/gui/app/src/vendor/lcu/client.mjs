import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { openDiagnosticLog } from './diagnostics.mjs';
import { declineAgentHostApp } from './host-guard.mjs';

export const MODEL_TOOLS = new Set(['js', 'js_reset']);

/** Default cleanup/tool timeout; `js` extends past a longer requested run. */
export const TURN_END_TIMEOUT_MS = 120_000;

/** Bound a tool call's timeout, extending `js` past its requested run. */
export function callTimeout(name, args) {
  const requested = Number(args?.timeout_ms);
  return name === 'js' && Number.isFinite(requested) && requested > 0
    ? Math.max(TURN_END_TIMEOUT_MS, requested + 30_000)
    : TURN_END_TIMEOUT_MS;
}

/** Longest wait for a host to start and list its tools; the SDK's 60 s default is shorter than a start under load. */
export const CONNECT_TIMEOUT_MS = 120_000;

/** Longest timer delay Node accepts; an approval wait ends only by answer or abort. */
export const APPROVAL_TIMEOUT_MS = 2 ** 31 - 1;

/** Count pending approvals so tool-call deadlines stand still while a human decides. */
export function createApprovalGate() {
  let pending = 0;
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    get pending() { return pending; },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async track(run) {
      pending++;
      notify();
      try { return await run(); } finally {
        pending--;
        notify();
      }
    },
  };
}

/** Run `run(signal)` under a deadline that does not elapse while the gate has a pending approval. */
export async function callWithDeadline(gate, timeout, signal, run) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let remaining = timeout;
  let started;
  let timer;
  const sync = () => {
    if (gate.pending > 0) {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining -= Date.now() - started;
    } else if (timer === undefined) {
      started = Date.now();
      timer = setTimeout(() => controller.abort(
        McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout })),
      Math.max(remaining, 0));
    }
  };
  const unsubscribe = gate.onChange(sync);
  sync();
  try {
    return await run(controller.signal);
  } finally {
    unsubscribe();
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** Forward an upstream approval to the downstream host without the SDK's default request timeout. */
export function relayElicitation(server, gate, params, signal) {
  return gate.track(() => server.elicitInput(params, { signal, timeout: APPROVAL_TIMEOUT_MS }));
}

/** True when importMetaUrl is the process entrypoint, resolving symlinks robustly. */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const NATIVE_APPROVAL_PERSISTENCE = [
  ['session', 'Allow for this session'],
  ['always', 'Always allow'],
];

const HOST_CONTROL_TIMEOUT_MS = 45_000;
const CONTROL_RESPONSE_LIMIT = 1024 * 1024;

/** Send one bounded request to the private, per-client macOS host-control socket. */
export function sendControlRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const decoder = new StringDecoder('utf8');
    const socket = createConnection(socketPath);
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const deadline = setTimeout(() => finish(new Error('LCU host-control request timed out')),
      HOST_CONTROL_TIMEOUT_MS);
    socket.on('error', error => finish(new Error(`LCU host-control connection failed: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > CONTROL_RESPONSE_LIMIT) {
        finish(new Error('LCU host-control response exceeded its size limit'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response || typeof response !== 'object' || Array.isArray(response) ||
            typeof response.ok !== 'boolean') {
          throw new Error('invalid response shape');
        }
        if (!response.ok) {
          finish(new Error(typeof response.error === 'string' ? response.error : 'host control failed'));
          return;
        }
        finish(undefined, response.result);
      } catch (error) {
        finish(new Error(`Invalid LCU host-control response: ${error.message}`));
      }
    });
    socket.on('end', () => {
      if (!settled) finish(new Error('LCU host-control connection ended before a response'));
    });
  });
}

/** Return the choices supported by an original native-app approval request. */
export function nativeAppApprovalOptions(params) {
  const meta = params?._meta;
  const schema = params?.requestedSchema;
  const properties = schema?.properties;
  const app = meta?.tool_params?.app;
  if (params?.mode !== 'form' || typeof params.message !== 'string' || !params.message ||
      schema?.type !== 'object' || properties === null || typeof properties !== 'object' ||
      Array.isArray(properties) || Object.keys(properties ?? {}).length !== 0 ||
      (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
      meta?.codex_approval_kind !== 'mcp_tool_call' || meta?.connector_id !== 'computer-use' ||
      typeof app !== 'string' || !app) {
    return undefined;
  }

  const requested = new Set(Array.isArray(meta.persist) ? meta.persist : []);
  const choices = [{ value: 'once', label: 'Allow once' }];
  for (const [value, label] of NATIVE_APPROVAL_PERSISTENCE) {
    if (requested.has(value)) choices.push({ value, label });
  }
  choices.push({ value: 'decline', label: 'Decline' });
  return { message: params.message, resource: app, choices };
}

/** Map a selected native-app approval choice to the original MCP response. */
export function nativeAppApprovalResponse(params, value) {
  const request = nativeAppApprovalOptions(params);
  if (!request) return { action: 'cancel' };
  if (value === 'cancel') return { action: 'cancel' };
  if (value === 'decline') return { action: 'decline' };
  if (value === 'once' && request.choices.some(choice => choice.value === 'once')) {
    return { action: 'accept', content: {} };
  }
  if (NATIVE_APPROVAL_PERSISTENCE.some(([scope]) => scope === value) &&
      request.choices.some(choice => choice.value === value)) {
    return { action: 'accept', content: {}, _meta: { persist: value } };
  }
  return { action: 'cancel' };
}

/** How long a recorded mod choice stays valid; the host's answer follows it within milliseconds. */
export const APPROVAL_CHOICE_TTL_MS = 30_000;

/** Tool-use ids the Claude host assigns to calls a mod makes (the model's ids come from the API). */
export const MOD_TOOL_USE_PREFIX = 'toolu_plugin_';

const MOD_CHOICES = new Set(['session', 'always', 'deny', 'cancel']);

/**
 * Pending native-app approvals and the human choices a host mod records for them.
 * A record exists only while the runtime's elicitation is open. A choice is bound
 * to its record id, is accepted once, and only from a mod-originated call.
 */
export function createApprovalBroker({ now = Date.now, ttlMs = APPROVAL_CHOICE_TTL_MS } = {}) {
  const records = new Map();
  const fail = reason => ({ ok: false, error: reason });

  return {
    get size() { return records.size; },
    /** Register an open native-app approval, made during tool call `call` when known; returns its id. */
    open(params, { call } = {}) {
      const approval = nativeAppApprovalOptions(params);
      if (!approval) return undefined;
      const meta = params._meta;
      const display = Array.isArray(meta.tool_params_display)
        ? meta.tool_params_display.find(item => item?.name === 'app') : undefined;
      const warning = [meta.warningSubtitle, meta.subtitle].find(
        value => typeof value === 'string' && value.trim());
      const id = randomUUID();
      records.set(id, {
        id,
        app: meta.tool_params.app,
        label: typeof display?.value === 'string' && display.value ? display.value : meta.tool_params.app,
        scopes: approval.choices.map(choice => choice.value).filter(value => value === 'session' || value === 'always'),
        riskLevel: typeof meta.riskLevel === 'string' ? meta.riskLevel : 'low',
        ...(warning ? { warning } : {}),
        message: params.message,
        createdAt: now(),
        claimedAt: undefined,
        choice: undefined,
        call,
        released: false,
        waiters: [],
      });
      return id;
    },
    /** The mod asks for the display data of the oldest unclaimed record with this exact message. */
    describe(message, toolUseId) {
      if (typeof toolUseId !== 'string' || !toolUseId.startsWith(MOD_TOOL_USE_PREFIX)) {
        return fail('approval_request accepts only host-mod calls');
      }
      if (typeof message !== 'string' || !message) return fail('approval_request requires the elicitation message');
      const record = [...records.values()].find(item => item.message === message && item.claimedAt === undefined);
      if (!record) return fail('No pending native-app approval matches this message');
      record.claimedAt = now();
      const { id, app, label, scopes, riskLevel, warning } = record;
      return { ok: true, approval: { id, message: record.message, app, label, scopes, riskLevel, ...(warning ? { warning } : {}) } };
    },
    /** Record the human's choice for one pending record. */
    choose(id, choice, toolUseId) {
      if (typeof toolUseId !== 'string' || !toolUseId.startsWith(MOD_TOOL_USE_PREFIX)) {
        return fail('approval_choice accepts only host-mod calls');
      }
      const record = typeof id === 'string' ? records.get(id) : undefined;
      if (!record || record.claimedAt === undefined) return fail('Unknown approval id');
      if (record.choice !== undefined) return fail('This approval already has a choice');
      if (!MOD_CHOICES.has(choice)) return fail('Unknown approval choice');
      if (choice === 'always' && !record.scopes.includes('always')) {
        return fail('Always allow was not offered for this app');
      }
      record.choice = choice === 'session' && !record.scopes.includes('session') ? 'once' : choice;
      record.chosenAt = now();
      record.chosenInput = choice;
      for (const waiter of record.waiters.splice(0)) waiter();
      return { ok: true };
    },
    /** True once the mod has claimed this record: it will answer for the person. */
    isClaimed(id) {
      return records.get(id)?.claimedAt !== undefined;
    },
    /**
     * Wait for the mod to record a choice for a claimed record, then settle it. Resolves with the
     * runtime-facing choice, or undefined when the request ends or `signal` aborts first.
     */
    async awaitChoice(id, signal) {
      const record = records.get(id);
      if (!record || record.claimedAt === undefined) return undefined;
      if (record.choice === undefined && !record.released) {
        await new Promise(resolve => {
          record.waiters.push(resolve);
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return this.settle(id);
    },
    /** Release every wait without a choice: the request they belong to ended. */
    cancelWaiting() {
      for (const record of records.values()) for (const waiter of record.waiters.splice(0)) waiter();
    },
    /**
     * Release the waits of the approvals tool call `call` opened: the call ended, so nobody is left to use
     * their answer, and the runtime's cancel of its elicitation is not always delivered.
     */
    release(call) {
      for (const record of records.values()) {
        if (record.call !== call) continue;
        record.released = true;
        for (const waiter of record.waiters.splice(0)) waiter();
      }
    },
    /** Remove the record and return its still-valid recorded choice, if any. */
    settle(id) {
      const record = records.get(id);
      records.delete(id);
      for (const waiter of record?.waiters.splice(0) ?? []) waiter();
      if (!record || record.choice === undefined || now() - record.chosenAt > ttlMs) return undefined;
      return record.choice === 'deny' ? 'decline' : record.choice;
    },
  };
}

/** Number this adapter process's tool calls and log each one's start and how it ended. */
export function createCallTracker(log, now = Date.now) {
  let sequence = 0;
  const live = new Set();
  return {
    /** The call number when exactly one call is in flight. */
    get current() { return live.size === 1 ? [...live][0] : undefined; },
    async track(tool, { timeout_ms: timeoutMs, signal } = {}, run) {
      const call = ++sequence;
      live.add(call);
      const requested = Number(timeoutMs);
      log.event('call_start', { call, tool, ...(Number.isFinite(requested) && requested > 0 ? { timeout_ms: requested } : {}) });
      const started = now();
      let outcome = 'error';
      let code;
      try {
        const result = await run(call);
        outcome = result?.isError ? 'tool_error' : 'ok';
        return result;
      } catch (error) {
        if (error instanceof McpError) code = error.code;
        outcome = signal?.aborted ? 'aborted' : code === ErrorCode.RequestTimeout ? 'timeout' : 'error';
        throw error;
      } finally {
        live.delete(call);
        log.event('call_end', { call, tool, ms: now() - started, outcome, code });
      }
    },
  };
}

/** Log one approval's lifecycle: opened, claimed by the host mod, its choice, and how it ended. */
export function createApprovalLogger(log, calls, now = Date.now) {
  let sequence = 0;
  return {
    open(kind, params) {
      const approval = ++sequence;
      const app = params?._meta?.tool_params?.app;
      const scopes = nativeAppApprovalOptions(params)?.choices
        .map(choice => choice.value).filter(value => value === 'session' || value === 'always');
      const started = now();
      log.event('approval_open', {
        approval, call: calls.current, kind, app: typeof app === 'string' ? app : undefined, scopes,
      });
      return {
        claimed() { log.event('approval_claimed', { approval }); },
        choice(choice) { log.event('approval_choice', { approval, choice }); },
        end(response) {
          log.event('approval_end', {
            approval, ms: now() - started, action: response?.action, persist: response?._meta?.persist,
          });
        },
      };
    },
  };
}

function originApproval(params, allowedOrigins) {
  const meta = params?._meta ?? params?.meta;
  if (meta?.tool_name !== 'access_browser_origin' || typeof meta.origin !== 'string') return false;
  let origin;
  try {
    const url = new URL(meta.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== meta.origin) return false;
    origin = url.origin;
  } catch {
    return false;
  }
  return allowedOrigins.has(origin);
}

/** At most this many `upstream_stderr` events per process; later lines are counted, not logged. */
export const UPSTREAM_STDERR_EVENT_LIMIT = 500;
const STDERR_LINE_CHARS = 8192;
const STDERR_TAIL_LINES = 5;
const STDERR_TAIL_CHARS = 1000;

const wholeNumber = text => (/^\d+$/.test(text) ? Number(text) : undefined);

/**
 * Classify one stderr line of the original MCP process (and LCU's macOS host and service under it)
 * by its known prefix. Returns the event fields: a fixed `kind` and numbers parsed from the line,
 * never the line's text.
 */
export function classifyUpstreamStderr(line) {
  let match = /^LCU macOS turn-ended command: exit=(\S+) elapsed=(\d+) ms/.exec(line);
  if (match) {
    const code = wholeNumber(match[1]);
    return {
      kind: code === 0 ? 'turn_ended_slow' : 'turn_ended_failed',
      exit_code: code,
      ...(match[1] === 'timeout' ? { timed_out: true } : {}),
      ...(match[1] === 'launch-failed' ? { launch_failed: true } : {}),
      elapsed_ms: Number(match[2]),
      has_stderr: line.includes(' stderr='),
    };
  }
  match = /^LCU macOS turn cleanup: original turn-ended command failed for .* after (\d+) ms/.exec(line);
  if (match) {
    return { kind: 'turn_ended_failed', elapsed_ms: Number(match[1]), retry: line.endsWith('at the next Sky request') };
  }
  match = /^LCU macOS turn cleanup step .* (?:is still running after|took) (\d+) ms$/.exec(line);
  if (match) {
    return { kind: 'cleanup_step_slow', elapsed_ms: Number(match[1]), still_running: line.includes(' is still running ') };
  }
  if (line.startsWith('LCU macOS turn cleanup failed:')) return { kind: 'turn_cleanup_failed' };
  if (line.startsWith('LCU macOS user control unavailable:') ||
      line.startsWith('LCU macOS control channel unavailable:')) return { kind: 'user_control_unavailable' };
  if (line.startsWith('LCU macOS control request failed:')) return { kind: 'control_request_failed' };
  match = /^LCU macOS sent SIGTERM to stale Computer Use service pid \d+ .*; it (?:exited after (\d+) ms|did not exit)/
    .exec(line);
  if (match) {
    return { kind: 'stale_service_recovery', exited: match[1] !== undefined, elapsed_ms: wholeNumber(match[1] ?? '') };
  }
  if (line.startsWith('LCU: the original node_repl started its sandbox')) return { kind: 'sandbox_refused' };
  if (line.startsWith('LCU: ')) return { kind: 'sandbox_note' };
  return { kind: 'other' };
}

/**
 * Keep reading the original process's piped stderr so it never blocks on a full pipe, and record
 * each line as an `upstream_stderr` diagnostic event (classification only, never text). The
 * text is not forwarded: in-process harnesses (Pi, OMP, Hermes) draw a TUI on this process's
 * stderr. The last few lines are kept in memory so a failed start can still say why.
 */
export function drainUpstreamStderr(stream, log, { limit = UPSTREAM_STDERR_EVENT_LIMIT } = {}) {
  const tail = [];
  let pending = '';
  let skipping = false;
  let recorded = 0;
  let dropped = 0;
  const line = text => {
    const trimmed = text.replace(/\r$/, '');
    if (!trimmed.trim()) return;
    tail.push(trimmed.slice(0, STDERR_TAIL_CHARS));
    if (tail.length > STDERR_TAIL_LINES) tail.shift();
    if (recorded < limit) {
      recorded += 1;
      log.event('upstream_stderr', classifyUpstreamStderr(trimmed));
      if (recorded === limit) log.event('upstream_stderr_limit', { limit });
    } else {
      dropped += 1;
    }
  };
  if (stream) {
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => {
      let text = String(chunk);
      for (;;) {
        const newline = text.indexOf('\n');
        if (newline < 0) break;
        if (!skipping) line(pending + text.slice(0, newline));
        pending = '';
        skipping = false;
        text = text.slice(newline + 1);
      }
      if (skipping) return;
      pending += text;
      if (pending.length > STDERR_LINE_CHARS) {
        // An endless line: classify its start and discard the rest until its newline.
        line(pending.slice(0, STDERR_LINE_CHARS));
        pending = '';
        skipping = true;
      }
    });
    stream.on('end', () => {
      if (pending && !skipping) line(pending);
      pending = '';
      if (dropped) log.event('upstream_stderr_dropped', { lines: dropped });
    });
    stream.on('error', () => {});
  }
  return {
    /** The last few lines, bounded, for a start failure's error message only. */
    tail() {
      const text = tail.join('\n');
      return text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;
    },
  };
}

/** Host turns a relay remembers for js_reset, oldest evicted first. */
export const MAX_WORKER_TURNS = 1024;

/**
 * js_reset stops the original trusted worker, which holds the turn-ended hook and pending turn data of every turn
 * that ran js on it: a later turn end reaches nobody, and Sky keeps those turns' event taps (on macOS, keyboard
 * focus taps that can double keystrokes system-wide). `reset(end)` ends each such turn upstream first, while the
 * worker still lives, then gives it a fresh upstream id so its later calls are not refused as calls of an ended
 * turn. Host turns are keyed by (session, turn); `upstreamId` maps one to the id the original server sees.
 */
export function createWorkerTurns({ limit = MAX_WORKER_TURNS } = {}) {
  let worker = 0;
  // key -> { sessionId, upstreamId, worker }; `worker` is the generation the turn last ran js on, if any.
  const turns = new Map();
  const key = (sessionId, turnId) => JSON.stringify([sessionId, turnId]);
  return {
    upstreamId(sessionId, turnId) { return turns.get(key(sessionId, turnId))?.upstreamId ?? turnId; },
    ranJs(sessionId, turnId) {
      const id = key(sessionId, turnId);
      const turn = turns.get(id) ?? { sessionId, upstreamId: turnId };
      turn.worker = worker;
      turns.delete(id);
      turns.set(id, turn);
      if (turns.size > limit) turns.delete(turns.keys().next().value);
    },
    /** 'live': the hook can be reached; 'reset': its worker was reset since; 'none': no js since the last reset. */
    skyHook(sessionId, turnId) {
      const turn = turns.get(key(sessionId, turnId));
      if (turn?.worker === undefined) return 'none';
      return turn.worker === worker ? 'live' : 'reset';
    },
    ended(sessionId, turnId) { turns.delete(key(sessionId, turnId)); },
    async reset(end) {
      const used = [...turns.values()].filter(turn => turn.worker === worker);
      worker++;
      await Promise.all(used.map(async turn => {
        // `end` reports its own outcome; the reset goes ahead either way.
        try { await end(turn.sessionId, turn.upstreamId); } catch {}
        turn.upstreamId = randomUUID();
        turn.worker = undefined;
      }));
    },
  };
}

/** Code of the error `turnEnded` throws when the original host gave up waiting for cleanup. */
export const TURN_CLEANUP_TIMEOUT_CODE = 'LCU_TURN_CLEANUP_TIMEOUT';

/** The original Sky client's exact error when it cannot reach the Computer Use service. */
export const NATIVE_PIPE_FAILURE = 'Sky Computer Use native pipe startup failed';

/** Returned, as a tool error, for the `js` call that made a relay restart its original server after an app update. */
export const APP_UPDATED_RESTART_TEXT = 'The ChatGPT app was updated, so LCU restarted computer use; kernel reset ' +
  '(the JavaScript session was reset and its variables are gone), rerun your request, starting by getting the app again';

/** The tool error a call gets when the restart after an app update could not start a fresh original server. */
export function restartFailedResult(error) {
  const detail = String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 300);
  return { isError: true, content: [{ type: 'text', text: 'The ChatGPT app was updated, and LCU could not restart ' +
    `computer use (${detail}); restart the LCU MCP server, then rerun your request` }] };
}

/** True when a tool call outcome (`{result}` or `{error}`) carries the original native pipe startup failure. */
export function nativePipeFailed(outcome) {
  if (!outcome) return false;
  if ('error' in outcome) {
    const error = outcome.error;
    return String(error instanceof Error ? error.message : error).includes(NATIVE_PIPE_FAILURE);
  }
  const result = outcome.result;
  return Boolean(result?.isError) && Array.isArray(result.content) && result.content.some(item =>
    item?.type === 'text' && typeof item.text === 'string' && item.text.includes(NATIVE_PIPE_FAILURE));
}

/** Files of the selected macOS app whose inode and change time identify the build on disk. */
export const APP_BUILD_FILES = ['Contents/Info.plist', 'Contents/Resources/cua_node/bin/node_repl'];

/** The file `name` starts: a path with a slash relative to `cwd`, otherwise the first executable on `path`. */
function commandFile(name, cwd, path) {
  const base = cwd ?? process.cwd();
  if (name.includes('/')) return resolve(base, name);
  for (const directory of (path ?? '').split(delimiter)) {
    const candidate = resolve(base, directory || '.', name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return undefined;
}

/** The release root of the LCU launcher `bin/<name>` that `file` is (a tree holding `lcu/<script>`), or undefined. */
function launcherRoot(file, name, script) {
  if (file === undefined) return undefined;
  try {
    const real = realpathSync(file);
    const root = dirname(dirname(real));
    return basename(real) === name && basename(dirname(real)) === 'bin' &&
      statSync(join(root, 'lcu', script)).isFile() ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The LCU release an upstream argv runs: `lcu ...`, or `lcu-session --user ACCOUNT -- LCU ...` (also
 * `--user=ACCOUNT`), the two forms `lcu setup` registers. Undefined for any other command.
 */
function launchedRelease(argv, cwd, path) {
  const first = commandFile(argv[0], cwd, path);
  const direct = launcherRoot(first, 'lcu', 'runtime.mjs');
  if (direct || !launcherRoot(first, 'lcu-session', 'session.mjs')) return direct;
  const rest = argv[1] === '--user' && typeof argv[2] === 'string' ? argv.slice(3)
    : argv[1]?.startsWith('--user=') ? argv.slice(2) : undefined;
  if (rest?.[0] !== '--' || typeof rest[1] !== 'string' || !rest[1]) return undefined;
  return launcherRoot(commandFile(rest[1], cwd, path ?? '/bin:/usr/bin'), 'lcu', 'runtime.mjs');
}

/**
 * A comparable identity of the macOS app build the upstream argv selects, read from disk without starting
 * anything: the app the release's installation descriptor selects (as `lcu/runtime.mjs` checks it: absolute,
 * and the release's `app` link resolves to it) and the device, inode and change time of APP_BUILD_FILES, which
 * an in-place app update replaces. Undefined off macOS, for a command that is not an LCU launcher, or when any
 * of it cannot be read (an update in progress, for one).
 */
export function selectedAppBuild(argv, { cwd, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !Array.isArray(argv) || typeof argv[0] !== 'string' || !argv[0]) return undefined;
  try {
    const root = launchedRelease(argv, cwd, env?.PATH);
    if (!root) return undefined;
    const descriptor = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
    if (descriptor?.platform !== 'darwin' || typeof descriptor.app !== 'string' || !isAbsolute(descriptor.app)) {
      return undefined;
    }
    const app = realpathSync(descriptor.app);
    if (app !== realpathSync(join(root, 'app'))) return undefined;
    return JSON.stringify({ app, files: APP_BUILD_FILES.map(file => {
      const stat = statSync(join(app, file), { bigint: true });
      return [String(stat.dev), String(stat.ino), String(stat.ctimeNs)];
    }) });
  } catch {
    return undefined;
  }
}

/**
 * Restart of the original server after the selected app updated itself under a running relay. The original
 * processes of the old build stay alive, and the newly started Computer Use service refuses them, so every
 * `js` call fails with NATIVE_PIPE_FAILURE until the server restarts. `begin()` records the app build as an
 * upstream child starts (its generation). `afterJs(generation, outcome, restart)` passes through (undefined)
 * unless that outcome is the native pipe failure, the generation is the current one and the app build now
 * readable on disk differs from the one it recorded: then `restart()` replaces the upstream (at most once per
 * generation, so a fresh child that fails the same way gets its own error) and every call of that
 * generation that failed this way, or that the restart's close of that generation failed, gets the same tool
 * error. The call is never retried: the fresh kernel has
 * none of the old bindings, and JavaScript side effects could repeat.
 */
export function createAppUpdateRestart({ build, log, now = Date.now }) {
  let current;
  const read = () => {
    try {
      const value = build();
      return typeof value === 'string' && value ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    begin() {
      current = { build: read(), restart: undefined };
      return current;
    },
    get current() { return current; },
    async afterJs(generation, outcome, restart) {
      if (!generation || generation.build === undefined) return undefined;
      // A call still running on a server the restart closes fails with its transport error: it shares the restart.
      if (generation.restart && outcome && 'error' in outcome) return structuredClone(await generation.restart);
      if (!nativePipeFailed(outcome)) return undefined;
      if (!generation.restart) {
        const build = generation === current ? read() : undefined;
        if (build === undefined || build === generation.build) return undefined;
        const started = now();
        log.event('upstream_restart_start', { cause: 'app_updated' });
        generation.restart = (async () => {
          try {
            await restart();
          } catch (error) {
            log.event('upstream_restart', { cause: 'app_updated', ms: now() - started, outcome: 'error' });
            return restartFailedResult(error);
          }
          log.event('upstream_restart', { cause: 'app_updated', ms: now() - started, outcome: 'ok' });
          return { isError: true, content: [{ type: 'text', text: APP_UPDATED_RESTART_TEXT }] };
        })();
      }
      return structuredClone(await generation.restart);
    },
  };
}

/** Run `call()` and report its outcome as `{result}` or `{error}`, for createAppUpdateRestart. */
export async function callOutcome(call) {
  try {
    return { result: await call() };
  } catch (error) {
    return { error };
  }
}

/**
 * Transport and lifecycle bridge only. The installed original server owns CUA behavior. `appBuild` (tests)
 * replaces selectedAppBuild of `command` for the app-update restart (createAppUpdateRestart).
 */
export function createCuaClient({
  command, cwd, env, onElicitation, allowedOrigins = [], adapter = 'client', log = openDiagnosticLog({ adapter }),
  appBuild,
}) {
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || !part)) {
    throw new TypeError('command must be a nonempty argv array');
  }
  const approved = new Set(allowedOrigins.map(origin => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError(`Expected an exact HTTP(S) origin: ${origin}`);
    }
    return origin;
  }));
  let controlDirectory;
  if (process.platform === 'darwin') {
    try {
      controlDirectory = mkdtempSync(join(tmpdir(), 'lcu-'));
      chmodSync(controlDirectory, 0o700);
    } catch {
      if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
      controlDirectory = undefined;
    }
  }
  const baseEnv = env ?? process.env;
  const restarts = createAppUpdateRestart({ log,
    build: appBuild ?? (() => selectedAppBuild(command, { cwd, env: baseEnv })) });
  // The current original server: { client, transport, stderr, generation, controlSocketPath }.
  let link;
  let children = 0;
  let connected = false;
  let closed = false;
  let tools;
  // While a restart replaces `link`, and the reason the last one could not start a fresh server.
  let restarting;
  let restartFailure;
  const approvals = createApprovalGate();
  const callSignals = new Set();
  const calls = createCallTracker(log);
  const approvalLog = createApprovalLogger(log, calls);
  const workerTurns = createWorkerTurns();
  const elicitationHandler = async (request, extra) => {
    const params = request.params;
    // The approval log records the refusal (`agent_host_refused`); nothing is written to the TUI.
    const refused = declineAgentHostApp(params, { report() {} });
    const origin = !refused && originApproval(params, approved);
    const entry = approvalLog.open(refused ? 'agent_host_refused' : origin ? 'browser_origin'
      : nativeAppApprovalOptions(params) ? 'native_app' : 'other', params);
    const response = refused ?? (origin ? { action: 'accept', content: {} } : await answerElicitation(params, extra));
    entry.end(response);
    return response;
  };
  async function answerElicitation(params, extra) {
    if (typeof onElicitation !== 'function') return { action: 'cancel' };
    const signal = AbortSignal.any([extra.signal, ...callSignals]);
    const aborted = new Promise(resolve => {
      if (signal.aborted) resolve({ action: 'cancel' });
      else signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
    });
    const answer = await approvals.track(() => Promise.race([onElicitation(params, { signal }), aborted]));
    if (answer?.action === 'accept' || answer?.action === 'decline' || answer?.action === 'cancel') return answer;
    return { action: 'cancel' };
  }

  /** A new, not yet started original server; each gets its own control socket name. */
  function openLink() {
    const generation = restarts.begin();
    children += 1;
    const controlSocketPath = controlDirectory
      ? join(controlDirectory, children === 1 ? 'c.sock' : `c${children}.sock`) : undefined;
    const childEnv = { ...baseEnv, ...(controlSocketPath ? { LCU_MAC_CONTROL_SOCKET: controlSocketPath } : {}) };
    if (!controlSocketPath) delete childEnv.LCU_MAC_CONTROL_SOCKET;
    const transport = new StdioClientTransport({
      command: command[0], args: command.slice(1), cwd,
      // Piped, not inherited: Pi, OMP and Hermes draw their TUI on this process's stderr.
      env: childEnv, stderr: 'pipe',
    });
    const stderr = drainUpstreamStderr(transport.stderr, log);
    const client = new Client({ name: 'lcu-harness-adapter', version: '0.1.0' }, {
      capabilities: { elicitation: {} },
    });
    client.setRequestHandler(ElicitRequestSchema, elicitationHandler);
    return { client, transport, stderr, generation, controlSocketPath };
  }

  /** Connect `next` and list its tools; on failure it is closed and the error carries its last stderr lines. */
  async function start(next) {
    const started = Date.now();
    let reported = false;
    try {
      await next.client.connect(next.transport, { timeout: CONNECT_TIMEOUT_MS });
      reported = true;
      log.event('upstream_connect', { ms: Date.now() - started, ok: true });
      const listed = await next.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      const found = listed.tools.filter(tool => MODEL_TOOLS.has(tool.name));
      if (found.length !== MODEL_TOOLS.size) throw new Error('Original CUA js/js_reset tools are missing');
      return found;
    } catch (error) {
      if (!reported) log.event('upstream_connect', { ms: Date.now() - started, ok: false });
      await next.client.close().catch(() => {});
      const output = next.stderr.tail();
      if (output && error instanceof Error && !error.message.includes(output)) {
        error.message += `\nOriginal CUA MCP process stderr (last lines):\n${output}`;
      }
      throw error;
    }
  }

  // Close the old server (its LCU lifetime host runs its own exit cleanup), then start and connect a fresh one.
  // The old trusted worker is gone with it, as after js_reset, so turns that ran js on it get fresh upstream ids.
  function restartUpstream() {
    restarting ??= (async () => {
      const old = link;
      connected = false;
      link = undefined;
      try {
        await old?.client.close();
      } catch { /* the old server is being replaced */ }
      log.event('upstream_close', { cause: 'app_updated' });
      await workerTurns.reset(async () => {});
      try {
        if (closed) throw new Error('LCU is closing');
        const next = openLink();
        tools = await start(next);
        link = next;
        connected = true;
      } catch (error) {
        restartFailure = error;
        throw error;
      }
    })().finally(() => { restarting = undefined; });
    return restarting;
  }

  const settled = () => restarting?.catch(() => {});

  async function endTurnUpstream(sessionId, upstreamId, event, fields) {
    const started = Date.now();
    let result;
    try {
      await settled();
      if (!link) throw new Error('The original CUA server is not running');
      result = await link.client.callTool({ name: 'turn_ended', arguments: {
        hook_event_name: event, session_id: sessionId, turn_id: upstreamId,
      } }, undefined, { timeout: TURN_END_TIMEOUT_MS });
    } catch (error) {
      log.event('turn_end', { hook_event: event, ...fields, ms: Date.now() - started, outcome: 'error' });
      throw error;
    }
    log.event('turn_end', { hook_event: event, ...fields, ms: Date.now() - started,
      outcome: result.isError ? 'error' : 'ok' });
    return result;
  }
  return {
    async connect() {
      if (connected) return this;
      if (closed) throw new Error('LCU is not connected');
      try {
        const next = openLink();
        tools = await start(next);
        link = next;
        connected = true;
        return this;
      } catch (error) {
        connected = false;
        if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
        controlDirectory = undefined;
        throw error;
      }
    },
    get instructions() {
      if (!connected) throw new Error('LCU is not connected');
      return link.client.getInstructions() ?? '';
    },
    publicTools() {
      if (!connected) throw new Error('LCU is not connected');
      return tools;
    },
    async call(name, args, {
      sessionId, turnId, toolCallId, itemId, threadId, threadSource,
      chatgptConversationId, model, reasoningEffort, metadata, signal,
    } = {}) {
      await settled();
      if (!connected && !restartFailure) throw new Error('LCU is not connected');
      if (!MODEL_TOOLS.has(name)) throw new Error(`Tool is reserved for host use: ${name}`);
      if (!sessionId || !turnId) throw new Error('A real host session and active turn are required');
      if (!connected) return restartFailedResult(restartFailure);
      const timeout = callTimeout(name, args);
      // Before the metadata below, so a reset call already carries its turn's fresh id.
      if (name === 'js_reset') {
        await workerTurns.reset((session, upstreamId) => endTurnUpstream(session, upstreamId, 'Interrupt',
          { cause: 'js_reset', sky_hook: 'live' }));
      } else workerTurns.ranJs(sessionId, turnId);
      const inherited = metadata?.['x-codex-turn-metadata'];
      const original = typeof inherited === 'string' ? (() => {
        try { return JSON.parse(inherited); } catch { return undefined; }
      })() : inherited;
      const turnMetadata = original && typeof original === 'object' && !Array.isArray(original)
        ? { ...original } : {};
      Object.assign(turnMetadata, {
        session_id: sessionId,
        turn_id: workerTurns.upstreamId(sessionId, turnId),
        ...(toolCallId ? { call_id: toolCallId } : {}),
        ...(itemId ? { item_id: itemId } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(threadSource ? { thread_source: threadSource } : {}),
        ...(chatgptConversationId ? { chatgpt_conversation_id: chatgptConversationId } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      });
      // js_reset's turn ends above can overlap a restart another call started.
      await settled();
      const current = link;
      if (!current) return restartFailedResult(restartFailure ?? new Error('the original CUA server is not running'));
      if (signal) callSignals.add(signal);
      try {
        return await calls.track(name, { timeout_ms: args?.timeout_ms, signal }, async () => {
          const outcome = await callOutcome(() => callWithDeadline(approvals, timeout, signal,
            deadlineSignal => current.client.callTool({
              name, arguments: args, _meta: {
                ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
                'x-codex-turn-metadata': turnMetadata,
              },
            }, undefined, { signal: deadlineSignal, timeout: APPROVAL_TIMEOUT_MS })));
          const replaced = name === 'js'
            ? await restarts.afterJs(current.generation, outcome, restartUpstream) : undefined;
          if (replaced) return replaced;
          if ('error' in outcome) throw outcome.error;
          return outcome.result;
        });
      } finally {
        if (signal) callSignals.delete(signal);
      }
    },
    async turnEnded({ sessionId, turnId, event = 'Stop' }) {
      await settled();
      if (!connected) return;
      if (!sessionId || !turnId || !['Stop', 'Interrupt', 'SubagentStop'].includes(event)) {
        throw new Error('Invalid original CUA lifecycle event');
      }
      const result = await endTurnUpstream(sessionId, workerTurns.upstreamId(sessionId, turnId), event,
        { sky_hook: workerTurns.skyHook(sessionId, turnId) });
      if (result.isError) {
        const detail = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (/turn-ended handlers timed out/i.test(detail)) {
          // The original host stops waiting after about 5 s; the cleanup keeps
          // running in the worker and is retried before the next action.
          const where = log.path ? ` See the diagnostic log at ${log.path}.` : '';
          const timeout = new Error('Original CUA turn cleanup did not finish within the host\'s wait; it may still be ' +
            `finishing in the background and will be retried before the next action.${where}`);
          timeout.code = TURN_CLEANUP_TIMEOUT_CODE;
          throw timeout;
        }
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      workerTurns.ended(sessionId, turnId);
      return result;
    },
    get hasHostControl() { return connected && Boolean(link?.controlSocketPath); },
    async controlStatus({ sessionId, turnId }) {
      await settled();
      if (!connected) throw new Error('LCU host control is unavailable after the client closes');
      const controlSocketPath = link.controlSocketPath;
      if (!controlSocketPath) throw new Error('LCU host control is unavailable on this platform');
      if (!sessionId || !turnId) throw new Error('Host control requires the active session and turn IDs');
      const result = await sendControlRequest(controlSocketPath, {
        type: 'status', session_id: sessionId, turn_id: workerTurns.upstreamId(sessionId, turnId),
      });
      if (!result || typeof result !== 'object' ||
          !Array.isArray(result.computerUse?.activeApplications)) {
        throw new Error('Original host returned an invalid Computer Use status response');
      }
      return result;
    },
    async controlStop({ sessionId, turnId, app }) {
      await settled();
      if (!connected) throw new Error('LCU host control is unavailable after the client closes');
      const controlSocketPath = link.controlSocketPath;
      if (!controlSocketPath) throw new Error('LCU host control is unavailable on this platform');
      if (!sessionId || !turnId || !app) throw new Error('Host Stop requires the active session, turn, and app IDs');
      const result = await sendControlRequest(controlSocketPath, {
        type: 'stop', session_id: sessionId, turn_id: workerTurns.upstreamId(sessionId, turnId), app,
      });
      if (!result || result.accepted !== true || result.applicationId !== app) {
        throw new Error('Original host did not confirm Computer Use Stop for the selected app');
      }
      return result;
    },
    async close() {
      closed = true;
      await settled();
      const wasConnected = connected;
      connected = false;
      try { await link?.client.close(); }
      finally {
        if (wasConnected) log.event('upstream_close');
        if (controlDirectory) {
          rmSync(controlDirectory, { recursive: true, force: true });
          controlDirectory = undefined;
        }
      }
    },
  };
}
