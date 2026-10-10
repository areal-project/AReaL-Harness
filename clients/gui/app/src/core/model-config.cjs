'use strict';
const { execFile } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const protocolToCore = value => value === 'chatCompletions' ? 'chat-completions' : value;
const baseUrl = endpoint => endpoint.replace(/\/(chat\/completions|responses)\/?$/, '');

// Core owns the document and its revision. This store owns only encrypted secrets
// and migration receipts; an immutable credential reference makes failed CAS safe.
class ModelConfiguration {
  constructor(backend, encryption) { this.backend = backend; this.encryption = encryption; this.vault = { keys: {}, migrated: [] }; }
  async init() {
    try { this.vault = JSON.parse(await readFile(join(this.backend.home, 'provider-credentials.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { this.legacy = JSON.parse(await readFile(join(this.backend.home, 'providers.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  execute(operation, request) {
    const args = ['config', 'models', operation];
    if (this.backend.config) args.push('--config', this.backend.config);
    for (const reference of Object.keys(this.vault.keys)) args.push('--stored-credential-env', reference);
    return new Promise((resolve, reject) => {
      // 与项目启动使用相同的凭据环境，由 Core 判断就绪状态，输出不含密钥。
      const child = execFile(this.backend.binary, args, { env: { ...this.backend.hooks.environment(), ...this.environment() }, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          // execFile 的超时由本调用发送 SIGTERM；与系统终止和配置拒绝分开记录。
          const timedOut = error.killed === true && error.signal === 'SIGTERM' && error.code === null;
          console.error(JSON.stringify({ event: 'core-model-configuration-failed', operation,
            exitCode: typeof error.code === 'number' ? error.code : null,
            code: typeof error.code === 'string' ? error.code : null,
            signal: error.signal ?? null, killed: error.killed === true, timedOut }));
          const detail = timedOut ? 'Core 模型配置请求超时，请检查后台服务日志。'
            : error.signal ? 'Core 模型配置进程意外终止，请检查后台服务日志。'
              : `Core 模型配置失败：${this.backend.providers.redact(stderr || error.message).slice(0, 2048)}。`;
          reject(new Error(`${detail}配置若已变化，请刷新核对后再操作。`));
          return;
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Core 返回了无效的模型配置')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(request ? JSON.stringify(request) : undefined);
    });
  }
  current() {
    // 设置页与多个项目启动可同时读取，首次迁移只允许一个写入者。
    if (!this.reading) this.reading = this.read().finally(() => { this.reading = null; });
    return this.reading;
  }
  async read() {
    let current = await this.execute('read');
    if (this.legacy && !this.vault.migrated.includes(current.path)) {
      const imported = this.legacy.data.map(({ id, name, baseUrl: url, protocol, enabled, models, parameters, secret }) => ({
        id, name, endpoint: url + (protocol === 'responses' ? '/responses' : '/chat/completions'), protocol: protocolToCore(protocol), enabled, models, parameters,
        ...(secret ? { apiKeyEnv: `AREAL_CREDENTIAL_${id}` } : {}),
      }));
      for (const item of imported) {
        const existing = current.data.find(p => p.id === item.id);
        if (existing && !isDeepStrictEqual(existing, item)) throw new Error(`旧供应商与 Core 配置存在同 ID 冲突：${item.id}。请先调整文件中的 ID，再刷新。`);
      }
      // Keep the original document for recovery. Never overwrite a saved key on
      // a retry after the config write succeeded but its receipt was interrupted.
      for (const item of this.legacy.data) if (item.secret) {
        const reference = `AREAL_CREDENTIAL_${item.id}`;
        if (this.vault.keys[reference] && this.vault.keys[reference] !== item.secret) throw new Error(`旧供应商凭据冲突：${item.id}`);
        this.vault.keys[reference] = item.secret;
      }
      await this.backend.save('provider-credentials.json', this.vault);
      current = await this.execute('write', { expectedRevision: current.revision, data: [...current.data, ...imported.filter(item => !current.data.some(p => p.id === item.id))], defaultModel: current.defaultModel });
      this.vault.migrated.push(current.path);
      await this.backend.save('provider-credentials.json', this.vault);
    }
    this.value = current;
    return current;
  }
  async credential(value) {
    if (typeof value !== 'string' || value.length > 16384 || /[\r\n]/.test(value)) throw new Error('API Key 格式无效');
    if (!value.trim()) return undefined;
    if (!this.encryption?.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，API Key 未保存');
    const reference = `AREAL_CREDENTIAL_${randomUUID().replaceAll('-', '')}`;
    this.vault.keys[reference] = this.encryption.encryptString(value.trim()).toString('base64');
    await this.backend.save('provider-credentials.json', this.vault);
    return reference;
  }
  key(item) {
    if (!item?.apiKeyEnv) return '';
    const encrypted = this.vault.keys[item?.apiKeyEnv];
    if (!encrypted) return process.env[item?.apiKeyEnv] ?? '';
    try { return this.encryption.decryptString(Buffer.from(encrypted, 'base64')); }
    catch { throw new Error('无法读取已保存的 API Key，请解锁系统钥匙串或重新填写密钥'); }
  }
  environment() {
    // Frozen thread/queue configurations can still reference a retired key.
    return Object.fromEntries(Object.keys(this.vault.keys).map(reference => [reference, this.key({ apiKeyEnv: reference })]));
  }
  public() {
    const value = this.value;
    return { ...value, data: value.data.map(item => ({ ...item, protocol: item.protocol === 'chat-completions' ? 'chatCompletions' : item.protocol, baseUrl: baseUrl(item.endpoint) })),
      projects: [...this.backend.projects.values()].map(project => ({ projectId: project.id, root: project.root, connected: !!project.client?.ready, applied: !!project.client?.ready && project.providerRevision === value.revision })),
      pendingApply: [...this.backend.projects.values()].some(project => project.service && project.providerRevision !== value.revision) };
  }
}
module.exports = { ModelConfiguration, protocolToCore, baseUrl };
