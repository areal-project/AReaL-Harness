'use strict';
const { readFile, mkdir, realpath, stat } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');

// Desktop reserves workspace roots; Core remains the sole owner of threads and
// execution. Repeating a preparation ID never creates another root or a turn.
class ProjectlessWorkspaces {
  constructor(backend) { this.backend = backend; this.records = {}; this.pending = Promise.resolve(); }
  async init() {
    try { this.records = JSON.parse(await readFile(join(this.backend.home, 'projectless-drafts.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot() { return { directory: this.backend.library.value.settings.projectlessDirectory ?? join(this.backend.userHome ?? homedir(), 'Documents', 'AReaL') }; }
  async command(request) {
    if (request.operation === 'directory') {
      if (typeof request.path !== 'string' || !isAbsolute(request.path)) throw new Error('请选择绝对目录路径');
      const directory = await realpath(request.path);
      if (!(await stat(directory)).isDirectory()) throw new Error('请选择文件夹');
      await this.backend.library.change(state => { state.settings.projectlessDirectory = directory; });
      return this.snapshot();
    }
    if (request.operation !== 'prepare' || typeof request.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.requestId)) throw new Error('无效项目外草稿标识');
    const next = this.pending.catch(() => {}).then(async () => {
      const id = request.requestId;
      let record = this.records[id];
      if (!record) {
        const selected = this.snapshot().directory;
        await mkdir(selected, { recursive: true, mode: 0o700 });
        const directory = await realpath(selected);
        record = { root: join(directory, id) };
        const records = { ...this.records, [id]: record };
        await this.backend.save('projectless-drafts.json', records);
        this.records = records;
      }
      if (this.backend.saved.some(project => project.projectlessRequestId === id)) {
        if (!(await stat(record.root)).isDirectory()) throw new Error('原项目外目录不可用');
      } else await mkdir(record.root, { recursive: true, mode: 0o700 });
      if (await realpath(record.root) !== record.root) throw new Error('项目外目录已被替换，请检查原目录后重试');
      const projectId = await this.backend.addProjectPath(record.root, undefined, id);
      return { projectId };
    });
    this.pending = next.catch(() => {});
    return next;
  }
}
module.exports = { ProjectlessWorkspaces };
