'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const LIMIT = 2 * 1024 * 1024;
const revision = (bytes) => createHash('sha256').update(bytes).digest('hex');

function resolveFile(root, relative) {
  if (!root || typeof relative !== 'string' || !relative) throw new Error('未选择文件');
  const realRoot = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(realRoot, relative));
  if (!file.startsWith(realRoot + path.sep)) throw new Error('文件不在当前工作区内');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('仅支持编辑 2 MB 以内的文本文件');
  return file;
}

function readText(root, relative) {
  const file = resolveFile(root, relative);
  const bytes = fs.readFileSync(file);
  if (bytes.length > LIMIT || bytes.includes(0)) throw new Error('该文件不能作为文本编辑');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { path: relative, text, revision: revision(bytes) };
}

function saveText(root, relative, text, expectedRevision) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw new Error('文件内容过大');
  const file = resolveFile(root, relative);
  const bytes = fs.readFileSync(file);
  if (typeof expectedRevision !== 'string' || revision(bytes) !== expectedRevision) {
    return { conflict: true, error: '文件已在外部修改。请保留你的草稿并重新读取文件后处理冲突。' };
  }
  const temporary = path.join(path.dirname(file), `.areal-edit-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
    // Recheck immediately before replacing, including changes made while preparing the write.
    if (resolveFile(root, relative) !== file || revision(fs.readFileSync(file)) !== expectedRevision) {
      return { conflict: true, error: '文件已在外部修改，未覆盖；请重新读取并处理冲突。' };
    }
    fs.renameSync(temporary, file);
    return { revision: revision(Buffer.from(text)), saved: true };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { readText, saveText };

// Workgroup files may be new, binary, executable, or deleted. Their bytes and
// base hash come from the Core artifact broker, never from Renderer input.
function artifactDestination(root, relative, createParents = false) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('无效产物路径');
  const realRoot = fs.realpathSync(root), parts = relative.split('/');
  let parent = realRoot;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    let info;
    try { info = fs.lstatSync(parent); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createParents) return { file: path.join(realRoot, relative), missingParent: true };
      fs.mkdirSync(parent); info = fs.lstatSync(parent);
    }
    if (info.isSymbolicLink()) throw new Error('产物路径包含符号链接，未应用。');
    if (!info.isDirectory()) throw new Error('产物父路径不是目录，未应用。');
  }
  const file = path.join(parent, parts.at(-1));
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info?.isSymbolicLink()) throw new Error('产物文件是符号链接，未应用。');
  if (info && (!info.isFile() || info.size > LIMIT)) throw new Error('产物目标不是2 MB以内的普通文件，未应用。');
  return { file, info };
}
function artifactFileState(root, artifact) {
  const target = artifactDestination(root, artifact.path);
  let sha256 = null, executable = null;
  if (target.info) {
    const fd = fs.openSync(target.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd), bytes = fs.readFileSync(fd);
      if (!info.isFile() || bytes.length > LIMIT) throw new Error('产物目标在读取期间变化，未应用。');
      sha256 = revision(bytes); executable = !!(info.mode & 0o111);
    } finally { fs.closeSync(fd); }
  }
  return { path: artifact.path, head: artifact.head, state: sha256 === artifact.sha256 && (!artifact.exists || executable === artifact.executable) ? 'matches' : sha256 === artifact.baseSha256 ? 'ready' : 'conflict' };
}
function applyVerifiedArtifact(root, artifact, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT || (artifact.exists ? revision(bytes) !== artifact.sha256 : bytes.length !== 0 || artifact.sha256 !== null)) throw new Error('产物完整性校验失败，未应用。');
  const previous = artifactFileState(root, artifact);
  if (previous.state === 'matches') return previous;
  if (previous.state !== 'ready') throw new Error('文件已变化，与工作组基线不一致；未覆盖，请先处理冲突。');
  const target = artifactDestination(root, artifact.path, artifact.exists);
  const temporary = path.join(path.dirname(target.file), `.areal-artifact-${randomUUID()}`);
  let committed = false;
  try {
    if (artifact.exists) {
      const mode = ((target.info?.mode ?? 0o644) & 0o666) | (artifact.executable ? 0o111 : 0);
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode });
      fs.chmodSync(temporary, mode);
    }
    // Match the editor's conditional-save boundary: no await between the last
    // source check and replacement. This is not an OS transaction with external
    // writers; each file is applied separately and conflicts never auto-retry.
    const current = artifactFileState(root, artifact);
    if (current.state !== 'ready' || artifactDestination(root, artifact.path).file !== target.file) throw new Error('文件已变化，未覆盖；请先处理冲突。');
    if (!artifact.exists) fs.unlinkSync(target.file);
    else if (artifact.baseSha256 === null) fs.linkSync(temporary, target.file); // atomic no-overwrite creation
    else fs.renameSync(temporary, target.file);
    committed = true;
    return artifactFileState(root, artifact);
  } catch (error) {
    if (committed) error.submissionUnknown = true;
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') { if (committed) error.submissionUnknown = true; throw error; } }
  }
}
module.exports.artifactFileState = artifactFileState;
module.exports.applyVerifiedArtifact = applyVerifiedArtifact;
