'use strict';
const { realpath, stat, open, rename, unlink } = require('node:fs/promises');
const { createWriteStream, constants } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { join, resolve, sep, basename, dirname } = require('node:path');
const childProcess = require('node:child_process');
const editors = [
  { id: 'zed', label: 'Zed', bundle: 'Zed.app' },
  { id: 'vscode', label: 'Visual Studio Code', bundle: 'Visual Studio Code.app' },
  { id: 'cursor', label: 'Cursor', bundle: 'Cursor.app' },
];

// Main owns OS handoff. Renderer selects a registered workspace and an opaque
// target ID, never an executable, command line or unrestricted absolute path.
async function fileOpen({ backend, shell, home, authorize, chooseSave }, request) {
  if (!request || typeof request !== 'object') throw new Error('无效文件打开请求');
  const targets = [{ id: 'system', label: '系统默认应用' }];
  if (process.platform === 'darwin') {
    targets.push({ id: 'finder', label: 'Finder' });
    for (const editor of editors) {
      for (const base of ['/Applications', join(home, 'Applications')]) {
        const path = join(base, editor.bundle);
        try { if ((await stat(path)).isDirectory()) { targets.push({ id: editor.id, label: editor.label, application: path }); break; } }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  const preferred = backend.snapshot().library.settings.fileOpenTarget ?? 'system';
  if (request.operation === 'targets') return {
    targets: targets.map(({ id, label }) => ({ id, label })), preferred,
    preferredLabel: targets.find(t => t.id === preferred)?.label ?? `${editors.find(t => t.id === preferred)?.label ?? preferred}（不可用）`,
  };
  if (request.operation === 'setDefault') {
    if (!targets.some(t => t.id === request.target)) throw new Error('所选打开应用不可用，请重新选择');
    authorize();
    await backend.command('library', { operation: 'settings', key: 'fileOpenTarget', value: request.target });
    return {};
  }
  if (!['open', 'reveal', 'saveAs'].includes(request.operation) || typeof request.projectId !== 'string'
    || typeof request.path !== 'string' || !request.path || request.path.length > 4096 || request.path.includes('\0')) throw new Error('无效文件打开请求');
  const project = backend.snapshot().projects.find(p => p.id === request.projectId);
  if (!project) throw new Error('未知工作区');
  const root = await realpath(project.root), path = await realpath(resolve(root, request.path));
  if (path !== root && !path.startsWith(root + sep)) throw new Error('文件不在当前工作区内');
  const info = await stat(path);
  if (!info.isFile() && !info.isDirectory()) throw new Error('仅支持文件或目录');
  if (request.operation === 'saveAs') {
    if (!info.isFile()) throw new Error('仅支持另存普通文件');
    authorize();
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let temporary;
    const sameVersion = value => value.isFile() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => value[key] === info[key]);
    try {
      if (!sameVersion(await source.stat())) throw new Error('源文件已变化，请重新另存');
      // The native chooser alone grants the destination. Pin the source inode
      // and stage the full bytes so a failed copy cannot truncate a destination.
      const result = await chooseSave({ title: '另存文件', defaultPath: basename(path) });
      if (result.canceled || !result.filePath) return { saved: false };
      authorize();
      const current = backend.snapshot().projects.find(p => p.id === request.projectId);
      if (current?.root !== project.root || await realpath(resolve(root, request.path)) !== path || !sameVersion(await stat(path)) || !sameVersion(await source.stat())) throw new Error('源文件已变化，请重新另存');
      let destination;
      try { destination = await stat(result.filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (destination?.dev === info.dev && destination?.ino === info.ino) throw new Error('另存位置不能是原文件');
      temporary = join(dirname(result.filePath), `.areal-save-${randomUUID()}.tmp`);
      await pipeline(source.createReadStream({ autoClose: false }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (!sameVersion(await stat(path)) || !sameVersion(await source.stat())) throw new Error('源文件已变化，请重新另存');
      authorize();
      await rename(temporary, result.filePath); temporary = null;
      return { saved: true };
    } catch (error) {
      if (error.code) {
        const message = ['EISDIR', 'ENOTDIR'].includes(error.code) ? '请选择文件位置，不能覆盖目录'
          : ['EACCES', 'EPERM'].includes(error.code) ? '所选位置不可写，请重新选择另存位置'
          : error.code === 'ENOENT' ? '源文件或另存位置已不存在，请重新选择'
          : '无法另存文件，请检查所选位置后重试';
        throw new Error(message);
      }
      throw error;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await source.close();
    }
  }
  const target = targets.find(t => t.id === preferred);
  if (request.operation !== 'reveal' && !target) throw new Error('默认打开应用已不可用，请在设置中重新选择');
  authorize();
  if (request.operation === 'reveal' || target.id === 'finder') shell.showItemInFolder(path);
  else if (target.id === 'system') {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  } else await new Promise((done, reject) => {
    childProcess.execFile('/usr/bin/open', ['-a', target.application, path], { timeout: 15000 }, error => error ? reject(error) : done());
  });
  return {};
}
module.exports = { fileOpen };
