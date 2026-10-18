'use strict';
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

// Same serialized credential-store contract as the existing OAuth owner.
class SubscriptionStore {
  constructor(backend, encryption) {
    this.filename = 'openai-subscription.json'; this.backend = backend; this.encryption = encryption; this.chain = Promise.resolve(); }
  check() {
    if (!this.encryption?.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，无法保存 ChatGPT 登录');
  }
  async readRecord() {
    try {
      const record = JSON.parse(await readFile(join(this.backend.home, this.filename), 'utf8'));
      if (!record.secret) return undefined;
      this.check();
      return JSON.parse(this.encryption.decryptString(Buffer.from(record.secret, 'base64')));
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('无法读取 ChatGPT 登录，请解锁系统钥匙串或重新登录'); }
  }
  modifyRecord(_key, mutate) {
    const result = this.chain.then(async () => {
      const current = await this.readRecord(), next = await mutate(current);
      if (next === undefined) return current;
      this.check();
      await this.backend.save(this.filename, { secret: this.encryption.encryptString(JSON.stringify(next)).toString('base64') });
      return next;
    });
    this.chain = result.catch(() => {}); return result;
  }
  deleteRecord() {
    const result = this.chain.then(() => this.backend.save(this.filename, { secret: null }));
    this.chain = result.catch(() => {}); return result;
  }
}
module.exports = { SubscriptionStore };
