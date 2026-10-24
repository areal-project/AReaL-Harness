'use strict';
const { access } = require('node:fs/promises');
const { constants } = require('node:fs');
const { isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const upstream = () => import('../vendor/lcu/client.mjs');
const definition = tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }) });
const bounded = (promise, milliseconds, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
    .finally(() => clearTimeout(timer));
};

class ExternalCua {
  constructor({ getSelection, getAvailable, onElicitation, onActivity = () => {} }) {
    this.getSelection = getSelection; this.getAvailable = getAvailable;
    this.onElicitation = onElicitation; this.onActivity = onActivity;
    this.sessions = new Map(); this.generation = randomUUID(); this.state = 'disconnected'; this.reason = '';
    this.selectionKey = null; this.transition = null; this.failure = null; this.revokedTurns = new Set(); this.admissions = new Map();
  }
  publish(state, reason = '') {
    if (state === 'quarantined') this.failure = reason;
    this.state = this.failure ? 'quarantined' : state; this.reason = this.failure ?? reason; this.onActivity(this.status());
  }
  status() {
    return { provider: 'lcu', supported: process.platform === 'darwin', platform: process.platform,
      ready: this.state === 'ready' && this.getAvailable(), state: this.state, reason: this.reason,
      active: [...this.sessions.values()].some(session => session.turns.size > 0), sessions: this.sessions.size };
  }
  assertAdmission(generation, selectionKey) {
    if (generation !== this.generation || this.transition || this.failure || !this.getAvailable()
      || selectionKey !== undefined && selectionKey !== JSON.stringify(this.getSelection())) throw new Error('External CUA admission was revoked before dispatch');
  }
  async selected(generation) {
    if (process.platform !== 'darwin') throw new Error('External CUA is supported only on macOS');
    this.assertAdmission(generation);
    const selection = this.getSelection();
    if (!selection.enabled || selection.provider !== 'lcu' || !this.getAvailable()) throw new Error('External CUA is not enabled or its desktop host is unavailable');
    if (this.state === 'quarantined') throw new Error(this.reason || 'External CUA cleanup is unresolved');
    const key = JSON.stringify(selection);
    if (this.selectionKey !== null && this.selectionKey !== key) await this.close();
    if (typeof selection.executable !== 'string' || !isAbsolute(selection.executable)) throw new Error('Choose an absolute path to an installed LCU executable');
    await access(selection.executable, constants.X_OK);
    this.assertAdmission(generation, key);
    this.selectionKey = key;
    return selection;
  }
  async session(owner, generation = this.generation) {
    const selection = await this.selected(generation);
    this.assertAdmission(generation, JSON.stringify(selection));
    const key = JSON.stringify([owner.projectId, owner.threadId]);
    let session = this.sessions.get(key);
    const identity = JSON.stringify([owner.coreInstanceId, owner.coreGeneration, owner.toolHostGeneration]);
    if (session && session.identity !== identity) {
      try { await this.retire(session, 'core_changed'); }
      catch (error) { this.publish('quarantined', error.message); throw error; }
      this.assertAdmission(generation, JSON.stringify(selection));
      this.sessions.delete(key); session = null;
    }
    if (session) { await session.connected; this.assertAdmission(generation, JSON.stringify(selection)); return session; }
    if (this.sessions.size >= 32) throw new Error('External CUA session limit reached; stop computer control before opening another chat');
    session = { identity, owner, generation, turns: new Set(), active: null, state: 'disconnected', client: null };
    this.sessions.set(key, session);
    session.connected = (async () => {
      const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
      env.CUA_REPL_ENABLED_SURFACES = 'computer';
      const { createCuaClient } = await upstream();
      session.client = createCuaClient({ command: [selection.executable], cwd: owner.cwd, env, allowedOrigins: [], adapter: 'areal', log: { event() {} },
        onElicitation: async (params, { signal }) => {
          const active = session.active;
          if (!active || !this.current(session) || active.controller.signal.aborted) return { action: 'cancel' };
          const answer = await this.onElicitation(params, { signal: AbortSignal.any([signal, active.controller.signal]), owner: active.owner });
          return session.active === active && this.current(session) && !active.controller.signal.aborted ? answer : { action: 'cancel' };
        } });
      await session.client.connect();
      session.instructions = session.client.instructions;
      session.tools = session.client.publicTools();
      if (!session.instructions || Buffer.byteLength(session.instructions) > 32768) throw new Error('Original LCU instructions are empty or exceed the 32768-byte client instruction budget');
      if (generation !== this.generation) throw new Error('External CUA connection was revoked');
      session.state = 'ready'; this.publish('ready');
      return session;
    })().catch(async error => {
      await session.client?.close().catch(() => {});
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      this.publish('disconnected', error.message); throw error;
    });
    return session.connected;
  }
  current(session) {
    return !this.failure && session.generation === this.generation && this.selectionKey === JSON.stringify(this.getSelection())
      && this.getAvailable() && session.state === 'ready';
  }
  async catalog(owner) {
    const session = await this.session(owner);
    return { instructions: session.instructions, tools: session.tools.map(definition), descriptors: session.tools };
  }
  async check() {
    const owner = { projectId: 'dependency-check', threadId: randomUUID(), cwd: process.cwd() };
    const key = JSON.stringify([owner.projectId, owner.threadId]);
    try { await this.catalog(owner); return this.status(); }
    catch (error) { this.publish('disconnected', error.message); return this.status(); }
    finally { const session = this.sessions.get(key); if (session) { await session.client.close(); this.sessions.delete(key); } }
  }
  turnKey(owner) { return JSON.stringify([owner.projectId, owner.coreInstanceId, owner.coreGeneration, owner.toolHostGeneration, owner.threadId, owner.turnId]); }
  async call(request) {
    const generation = this.generation;
    if (!['js', 'js_reset'].includes(request.tool) || !['projectId', 'threadId', 'turnId', 'callId', 'coreInstanceId', 'toolHostGeneration'].every(key => typeof request[key] === 'string' && request[key])) throw new Error('Invalid external CUA call owner');
    const admission = Symbol(); this.admissions.set(admission, request);
    try {
      if (this.revokedTurns.has(this.turnKey(request)) || this.revokedTurns.size >= 4096) throw new Error('This computer control turn was stopped or the turn record limit was reached');
      const session = await this.session(request, generation);
      this.assertAdmission(generation);
      if (this.revokedTurns.has(this.turnKey(request))) throw new Error('This computer control turn was stopped');
      if (!this.current(session) || session.active) throw new Error('External CUA session is unavailable or busy');
      if (!isDeepStrictEqual(session.tools.map(definition).find(tool => tool.name === request.tool), request.definition)
        || typeof request.clientInstructions !== 'string' || !request.clientInstructions.endsWith(session.instructions)) {
        throw new Error('External CUA catalog changed; create a new chat before using computer control');
      }
      const controller = new AbortController();
      const active = { owner: request, controller };
      session.active = active; session.turns.add(request.turnId); this.onActivity(this.status());
      const cancel = () => controller.abort();
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.signal?.aborted) cancel();
      try {
        this.assertAdmission(generation);
        if (controller.signal.aborted) throw new Error('External CUA request cancelled before dispatch');
        const result = await session.client.call(request.tool, request.arguments, { sessionId: request.threadId, threadId: request.threadId,
          turnId: request.turnId, toolCallId: request.callId, signal: controller.signal });
        if (!this.current(session) || controller.signal.aborted) throw new Error('External CUA owner changed after dispatch; outcome is UNKNOWN');
        if (!isDeepStrictEqual(session.tools, session.client.publicTools()) || session.instructions !== session.client.instructions) {
          session.state = 'quarantined'; this.publish('quarantined', 'LCU runtime changed its catalog; create a new chat after stopping computer control');
        }
        return result;
      } catch (error) {
        session.state = 'quarantined';
        if (session.generation === this.generation) this.publish('quarantined', `External CUA outcome is UNKNOWN. ${error.message}`);
        throw error;
      } finally { request.signal?.removeEventListener('abort', cancel); if (session.active === active) session.active = null; }
    } finally { this.admissions.delete(admission); }
  }
  async endTurn(owner) {
    const session = this.sessions.get(JSON.stringify([owner.projectId, owner.threadId]));
    if (!session || session.identity !== JSON.stringify([owner.coreInstanceId, owner.coreGeneration, owner.toolHostGeneration]) || !session.turns.has(owner.turnId)) return {};
    this.revokedTurns.add(this.turnKey(owner));
    try {
      await bounded(session.client.turnEnded({ sessionId: owner.threadId, turnId: owner.turnId, event: owner.event }), 125000, 'LCU turn cleanup is unresolved');
      session.turns.delete(owner.turnId); this.onActivity(this.status()); return {};
    } catch (error) { session.state = 'quarantined'; this.publish('quarantined', error.message); throw error; }
  }
  async retire(session, reason) {
    if (session.cleanupFailure) throw session.cleanupFailure;
    for (const turnId of session.turns) this.revokedTurns.add(this.turnKey({ ...session.owner, turnId }));
    session.active?.controller.abort();
    await session.connected?.catch(() => {});
    if (!session.client) return;
    let failure;
    for (const turnId of session.turns) {
      const owner = { sessionId: session.owner.threadId, turnId };
      try {
        if (reason === 'user_stop') {
          const status = await session.client.controlStatus(owner);
          for (const app of status.computerUse.activeApplications) await session.client.controlStop({ ...owner, app: app.bundleIdentifier ?? app.applicationId ?? app.id ?? app });
        }
        await bounded(session.client.turnEnded({ ...owner, event: 'Interrupt' }), 125000, 'LCU turn cleanup is unresolved');
        session.turns.delete(turnId); this.onActivity(this.status());
      } catch (error) { failure ??= error; }
    }
    await bounded(session.client.close(), 10000, 'LCU transport close is unresolved').catch(error => { failure ??= error; });
    if (failure) { session.cleanupFailure = failure; throw failure; }
  }
  async stop(reason = 'stopped') {
    if (this.transition) return this.transition;
    for (const owner of this.admissions.values()) this.revokedTurns.add(this.turnKey(owner));
    this.generation = randomUUID();
    this.transition = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.sessions.values()].map(session => this.retire(session, reason)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) { this.publish('quarantined', failed.reason.message); throw failed.reason; }
      this.sessions.clear(); this.selectionKey = null; this.failure = null; this.publish('disconnected');
    }).finally(() => { this.transition = null; });
    this.publish('stopping', reason);
    return this.transition;
  }
  async revokeProject(owner) {
    const sessions = [...this.sessions.entries()].filter(([, session]) => session.owner.projectId === owner.projectId
      && session.identity === JSON.stringify([owner.coreInstanceId, owner.coreGeneration, owner.toolHostGeneration]));
    for (const [key, session] of sessions) {
      session.state = 'stopping';
      try { await this.retire(session, 'core_disconnected'); this.sessions.delete(key); }
      catch (error) { this.publish('quarantined', error.message); }
    }
  }
  close() { return this.stop('closed'); }
}
module.exports = { ExternalCua, upstream };
