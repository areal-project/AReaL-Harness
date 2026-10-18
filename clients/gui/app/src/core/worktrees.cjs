'use strict';
const {mkdir,readFile,writeFile} = require('node:fs/promises');
const {join,basename} = require('node:path');
const git = require('@areal/workspace-git');

// Git owns worktree bytes and metadata; this journal binds an explicit create
// request to its source project. An uncertain create is only read, never replayed.
class CoreWorktrees {
  constructor(backend) { this.backend = backend; this.running = new Map(); }
  key(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('无效工作树请求标识');
    return join('worktree-requests', id + '.json');
  }
  async read(project, requestId) {
    let value;
    try { value = JSON.parse(await readFile(join(this.backend.home, this.key(requestId)), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {state:'missing'}; throw error; }
    if (value.projectId !== project.id) throw new Error('工作树创建请求不属于此项目');
    if (value.state === 'creating' && !this.running.has(requestId)) {
      const record = await git.readTaskCreation(this.backend.home, requestId);
      if (record) {
        const source = await git.workspaceInfo(project.root, this.backend.home);
        if (record.target !== source.root || record.source !== value.source || record.sourceRef !== value.ref) throw new Error('工作树创建记录与原请求不匹配');
        value = {...value,state:'created',record};
        await this.backend.save(this.key(requestId),value);
      }
    }
    return value;
  }
  async create(project, request) {
    const requestId = request.requestId, key = this.key(requestId);
    const source = request.source ?? 'head', ref = source === 'branch' ? request.ref?.trim() : null;
    if (!['head','working-tree','branch'].includes(source) || (source === 'branch' && (typeof ref !== 'string' || !ref || ref.length > 512))) throw new Error('请选择有效起点并填写分支或提交');
    if (this.running.has(requestId)) {
      const pending = await this.read(project,requestId);
      if (pending.source !== source || pending.ref !== ref) throw new Error('原创建请求的起点不可修改');
      return this.running.get(requestId);
    }
    const value = {requestId,projectId:project.id,source,ref,state:'creating'};
    await mkdir(join(this.backend.home,'worktree-requests'),{recursive:true,mode:0o700});
    try { await writeFile(join(this.backend.home,key),JSON.stringify(value),{flag:'wx',mode:0o600}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await this.read(project,requestId);
      if (previous.source !== source || previous.ref !== ref) throw new Error('原创建请求的起点不可修改');
      return previous;
    }
    const task = (async()=>{
      let next;
      try { next = {...value,state:'created',record:await git.createTask(project.root,this.backend.home,{source,ref,taskId:requestId})}; }
      catch (error) { next = {...value,state:error.worktreeUncertain ? 'creating' : 'failed',message:error.message}; }
      await this.backend.save(key,next);
      return next;
    })();
    this.running.set(requestId,task);
    try { return await task; } finally { this.running.delete(requestId); }
  }
  async open(project, requestId) {
    const value = await this.read(project,requestId);
    if (value.state !== 'created') throw new Error('工作树创建尚未确认，请先核对结果');
    const actual = await git.readTaskCreation(this.backend.home,requestId);
    if (!actual || actual.directory !== value.record.directory || actual.target !== value.record.target) throw new Error('工作树已不可用，未创建替代目录');
    await this.backend.resources.worktrees.snapshot(project, actual.directory, requestId);
    const projectId = await this.backend.addProjectPath(actual.directory, requestId);
    if (!this.backend.library.value.projects[projectId]?.title) await this.backend.library.command({operation:'renameProject',projectId,title:`${basename(actual.target).slice(0,160)} · 工作树 ${requestId.slice(0,6)}`});
    this.backend.onChange();
    return {projectId,root:actual.directory};
  }
}
module.exports = {CoreWorktrees};
