'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { open, writeFile, rename, unlink } = require('node:fs/promises');
const { constants } = require('node:fs');
const { join, dirname } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
// Core owns parsing, validation and execution. Only the hooks field is exposed
// over IPC; paths and other extension fields are selected by trusted config.
class AppHooks {
  constructor(backend) { this.backend = backend; }
  environment() {
    return { ...process.env, ...(this.backend.userHome ? { HOME: this.backend.userHome } : {}),
      // 只覆盖服务登记目录，Core 配置沿用用户 home 与显式配置的解析规则。
      AREAL_HARNESS_SERVICE_HOME: this.backend.harnessHome,
      ...(this.backend.toolExtensions ? { AREAL_HARNESS_TOOL_EXTENSIONS: this.backend.toolExtensions } : {}) };
  }
  async diagnose(operation, path) {
    const args = ['config', operation, '--management'];
    if (this.backend.config) args.push('--config', this.backend.config);
    try {
      const { stdout } = await execute(this.backend.binary, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024,
        env: { ...this.environment(), ...(path ? { AREAL_HARNESS_TOOL_EXTENSIONS: path } : {}) } });
      return operation === 'show' ? JSON.parse(stdout) : null;
    } catch (error) {
      throw new Error(`Core 配置校验失败：${this.backend.providers.redact(error.stderr || error.message).slice(0, 2048)}`);
    }
  }
  async readPath(path, optional = false) {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (optional && error.code === 'ENOENT') return { text: '{}', mode: 0o600, missing: true }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('钩子配置必须是不超过 1 MiB 的普通文件');
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error('钩子配置超过 1 MiB');
      return { text: bytes.subarray(0, bytesRead).toString('utf8'), mode: stat.mode & 0o777 };
    } finally { await file.close(); }
  }
  async current() {
    const config = await this.diagnose('show');
    const external = config.tools.extensions_file;
    const path = external || join(this.backend.home, 'tool-extensions.json');
    const file = await this.readPath(path, !external);
    // config show validates an external source itself. The fallback is supplied
    // only to child Core launches, so validate it explicitly on reads as well.
    if (!external && !file.missing) await this.diagnose('validate', path);
    const value = JSON.parse(file.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('扩展配置必须是 JSON 对象');
    return { ...file, path, value, external: !!external, revision: hash(JSON.stringify([path, file.text, !!file.missing])) };
  }
  public(current) {
    return { path: current.path, external: current.external, revision: current.revision, hooks: current.value.hooks ?? [],
      projects: this.backend.saved.map(project => {
        const live = this.backend.projects.get(project.id);
        const connected = !!live?.client?.ready;
        return { projectId: project.id, root: project.root, connected,
          applied: connected && live.hookRevision === current.revision };
      }) };
  }
  async launch() {
    let current = await this.current();
    if (current.missing) {
      try { await writeFile(current.path, '{}', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      current = await this.current();
    }
    return current;
  }
  async command(request) {
    if (request.operation === 'hooks') return this.public(await this.current());
    if (request.operation !== 'hooksSave') throw new Error('不支持的钩子操作');
    if (this.backend.resourcesUpdating || this.backend.providerUpdating || this.backend.starting.size) throw new Error('配置正在更新，请稍后重试');
    this.backend.resourcesUpdating = true;
    let temporary;
    try {
      const current = await this.current();
      if (request.expectedRevision !== current.revision) throw new Error('钩子配置已变化，请刷新后重新保存');
      if (!Array.isArray(request.hooks) || request.hooks.length > 64) throw new Error('最多支持 64 个钩子');
      const text = JSON.stringify({ ...current.value, hooks: request.hooks }, null, 2) + '\n';
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('扩展配置超过 1 MiB');
      temporary = join(dirname(current.path), `.areal-hooks-${randomUUID()}.tmp`);
      await writeFile(temporary, text, { flag: 'wx', mode: current.mode });
      await this.diagnose('validate', temporary);
      // Serializes GUI writers; detect external edits again after validation.
      // External editors do not participate in a shared atomic filesystem CAS.
      if ((await this.current()).revision !== current.revision) throw new Error('钩子配置已变化，未覆盖外部修改');
      await rename(temporary, current.path); temporary = null;
      this.backend.onChange();
      return this.public(await this.current());
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      this.backend.resourcesUpdating = false;
    }
  }
}
module.exports = { AppHooks };
