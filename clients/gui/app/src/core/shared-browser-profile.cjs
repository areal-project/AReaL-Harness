'use strict';

const { WorkspaceNetworkPolicy } = require('./browser-network.cjs');
const PARTITION = 'persist:areal-embedded-browser';

class SharedBrowserProfile {
  constructor() {
    this.hosts = new Set();
    this.endpointProviders = new Set();
    this.contents = new Map();
    this.targetSession = null;
    this.operation = null;
    this.policy = new WorkspaceNetworkPolicy(
      () => [...this.endpointProviders].flatMap(provider => provider()),
      id => [...this.contents.values()].some(record => record.current() && record.devToolsContents?.()?.id === id),
      details => this.permitsRequest(details),
    );
  }
  status() { return { persistent: true, shared: true, busy: this.operation !== null }; }
  assertAvailable() {
    if (this.operation) throw Object.assign(new Error('browser_profile_busy'), { code: 'browser_profile_busy' });
  }
  get partition() { return PARTITION; }
  get session() {
    if (!this.targetSession) {
      const session = require('electron').session.fromPartition(PARTITION);
      this.policy.install(session);
      session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
      session.setPermissionCheckHandler(() => false);
      session.on('will-download', (event, item, source) => {
        const record = source && this.contents.get(source.id);
        if (this.operation || !record || record.kind !== 'page' || !record.current()) { event.preventDefault(); return; }
        record.download(event, item, source);
      });
      this.targetSession = session;
    }
    return this.targetSession;
  }
  registerHost(host) {
    this.hosts.add(host);
    this.endpointProviders.add(host.controlEndpoints);
    return () => this.hosts.delete(host);
  }
  registerPage(record) {
    this.assertAvailable();
    return this.register({ ...record, kind: 'page' });
  }
  register(record) {
    if (record.contents.isDestroyed() || record.contents.session !== this.session || this.contents.has(record.contents.id))
      throw new Error('browser_profile_contents_invalid');
    const id = record.contents.id;
    record.id = id;
    this.contents.set(id, record);
    const unregister = () => {
      if (this.contents.get(id) === record) this.contents.delete(id);
      this.policy.revokeFrameGrant(id);
      record.contents.removeListener('destroyed', unregister);
    };
    record.contents.once('destroyed', unregister);
    return unregister;
  }
  permitsRequest(details) {
    const id = details.webContentsId;
    if (!Number.isSafeInteger(id) || id <= 0) return !this.operation;
    const record = this.contents.get(id);
    if (record) return record.current() && (!this.operation || record.kind === 'importer');
    return !this.operation && [...this.contents.values()].some(item => item.current() && item.devToolsContents?.()?.id === id);
  }
  async flush() {
    if (!this.targetSession) return;
    this.targetSession.flushStorageData();
    await this.targetSession.cookies.flushStore();
  }
  async browserData(operation, { importChrome } = {}) {
    if (operation === 'status') return this.status();
    if (!['clearCache', 'clearAll', 'importChrome'].includes(operation)) throw new Error('browser_profile_operation_invalid');
    this.assertAvailable();
    if (operation === 'importChrome' && typeof importChrome !== 'function') throw new Error('browser_import_unavailable');
    const active = { operation };
    this.operation = active;
    const importers = new Set();
    try {
      const closed = await Promise.allSettled([...this.hosts].map(host => host.quiesce()));
      if (closed.some(result => result.status === 'rejected')) throw new Error('browser_profile_close_failed');
      const targetSession = this.session;
      await targetSession.closeAllConnections();
      let result = { success: true };
      if (operation === 'importChrome') {
        const registerWebContents = contents => {
          if (this.operation !== active) throw new Error('browser_import_inactive');
          contents.setWindowOpenHandler(() => ({ action: 'deny' }));
          const record = { kind: 'importer', contents, current: () => this.operation === active && !contents.isDestroyed() };
          const unregister = this.register(record);
          importers.add(record);
          return unregister;
        };
        result = await importChrome({ targetSession, registerWebContents });
      } else {
        await targetSession.clearCache();
        if (operation === 'clearAll') {
          await targetSession.clearStorageData();
          await targetSession.clearAuthCache();
        } else await targetSession.clearStorageData({ storages: ['shadercache', 'serviceworkers', 'cachestorage'] });
      }
      await this.flush();
      return result;
    } finally {
      try {
        await Promise.all([...importers].map(record => {
          if (record.contents.isDestroyed()) return;
          return new Promise(resolve => {
            record.contents.once('destroyed', resolve);
            record.contents.close({ waitForBeforeUnload: false });
          });
        }));
      } finally { this.operation = null; }
    }
  }
}

const sharedBrowserProfile = new SharedBrowserProfile();
module.exports = { sharedBrowserProfile, PARTITION };
