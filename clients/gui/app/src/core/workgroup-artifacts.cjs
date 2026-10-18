'use strict';
const { createHash } = require('node:crypto');
const { artifactFileState, applyVerifiedArtifact } = require('../workspace-files');
const LIMIT = 2 * 1024 * 1024;
const applying = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Only IDs/path/head cross IPC. Core revalidates acceptance and supplies bytes. */
async function readAndApply(project, request, apply) {
  if (typeof request.head !== 'string' || !request.head || typeof request.path !== 'string' || !request.path) throw new Error('缺少产物文件或版本');
  const read = offset => project.client.request('areal/workgroup/artifact', { id: request.id, path: request.path, offset });
  const artifact = await read(0);
  if (artifact.head !== request.head || artifact.path !== request.path) throw new Error('产物版本已变化，请重新审查。');
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > LIMIT || typeof artifact.exists !== 'boolean' || !(artifact.baseSha256 === null || /^[0-9a-f]{64}$/.test(artifact.baseSha256)) || (artifact.exists ? !/^[0-9a-f]{64}$/.test(artifact.sha256) || typeof artifact.executable !== 'boolean' : artifact.sha256 !== null || artifact.bytes !== 0)) throw new Error('产物元数据无效');
  if (!apply) return artifactFileState(project.root, artifact);
  const chunks = []; let offset = 0, page = artifact;
  while (true) {
    if (['head', 'path', 'exists', 'bytes', 'baseSha256', 'sha256', 'executable'].some(key => page[key] !== artifact[key]) || page.offset !== offset || typeof page.dataBase64 !== 'string') throw new Error('产物分块版本不一致，未应用。');
    const bytes = Buffer.from(page.dataBase64, 'base64');
    if (bytes.length > 4096 || page.nextOffset !== offset + bytes.length || page.nextOffset > artifact.bytes || page.complete !== (page.nextOffset === artifact.bytes)) throw new Error('产物分块无效，未应用。');
    chunks.push(bytes); offset = page.nextOffset;
    if (page.complete) break;
    if (!bytes.length) throw new Error('产物读取没有前进，未应用。');
    page = await read(offset);
  }
  const bytes = Buffer.concat(chunks);
  if (artifact.exists && sha(bytes) !== artifact.sha256) throw new Error('产物摘要不一致，未应用。');
  return applyVerifiedArtifact(project.root, artifact, bytes);
}
async function workgroupArtifactFile(project, request, apply) {
  const key = JSON.stringify([project.root, request.path]);
  // A readback after a lost response must not race a still-running download/write.
  while (applying.has(key)) await applying.get(key).catch(() => {});
  if (!apply) return readAndApply(project, request, false);
  const task = readAndApply(project, request, true);
  applying.set(key, task);
  try { return await task; } finally { if (applying.get(key) === task) applying.delete(key); }
}
module.exports = { workgroupArtifactFile };
