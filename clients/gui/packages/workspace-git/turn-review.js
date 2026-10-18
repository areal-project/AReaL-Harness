'use strict';
const { createHash } = require('node:crypto');
const { createTwoFilesPatch } = require('diff');
const sha = text => createHash('sha256').update(text).digest('hex');
const verifiedWrites = ['fs_create', 'fs_write', 'fs_apply_patch', 'fs_apply_patches'];

// 与 Runtime 的 apply_patches 相同：1–32 条、oldText 非空且全文只出现一次，
// 按顺序只替换第一次。成功回执的字节数和 SHA-256 必须对上，不能改用当前磁盘。
function applyRecordedPatches(before, patches) {
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 32) throw new Error('本轮补丁无法按公开记录重建，请使用工作区审查');
  let text = before;
  for (const patch of patches) {
    if (!patch || typeof patch.oldText !== 'string' || typeof patch.newText !== 'string' || patch.oldText.length === 0) throw new Error('本轮补丁无法按公开记录重建，请使用工作区审查');
    const first = text.indexOf(patch.oldText);
    if (first < 0 || first !== text.lastIndexOf(patch.oldText)) throw new Error('本轮补丁无法按公开记录重建，请使用工作区审查');
    text = `${text.slice(0, first)}${patch.newText}${text.slice(first + patch.oldText.length)}`;
  }
  return text;
}

// Core remains the historical authority. These are verified text versions from
// public filesystem records, not current working-tree snapshots or undo data.
function turnChanges(turn, { itemId } = {}) {
  if (!turn || turn.status !== 'completed') throw new Error('本轮尚未完成，无法比较文件版本');
  if (itemId !== undefined) {
    const matches = turn.items?.filter(item => item.id === itemId) ?? [];
    if (typeof itemId !== 'string' || !itemId || matches.length !== 1) throw new Error('指定工具记录不属于此轮次');
    const item = matches[0];
    if (item.type !== 'dynamicToolCall' || !verifiedWrites.includes(item.tool)
      || item.status !== 'completed' || item.success !== true
      || item.execution?.backend !== 'runtime' || item.execution?.outcome !== 'succeeded') throw new Error('指定工具不是已成功完成的文件写入');
  }
  const observed = new Map(), changed = new Map();
  for (const item of turn.items ?? []) {
    if (item.type !== 'dynamicToolCall' || item.status !== 'completed' || item.success !== true
      || item.execution?.backend !== 'runtime' || item.execution?.outcome !== 'succeeded') continue;
    const patchTool = item.tool === 'fs_apply_patch' || item.tool === 'fs_apply_patches';
    if (!patchTool && !['fs_read', 'fs_create', 'fs_write'].includes(item.tool)) continue;
    const resultParts = (item.contentItems ?? []).filter(part => ['inputText', 'text'].includes(part.type));
    let result;
    try { if (resultParts.length === 1) result = JSON.parse(resultParts[0].text); } catch {}
    const args = item.execution.effectiveArguments;
    if (!args || typeof result?.path !== 'string' || !result.path.startsWith('workspace://repo/')
      || args.path !== result.path || !/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error('本轮文件版本记录不完整，请使用工作区审查');
    const path = result.path.slice('workspace://repo/'.length);
    if (!path || /[\r\n\t]/.test(path) || path.split('/').some(part => ['..', '.', ''].includes(part))) throw new Error('本轮文件路径无法比较');
    if (item.tool === 'fs_read') {
      if ((args.offset ?? 0) !== 0 || !result.eof || typeof result.text !== 'string'
        || Buffer.byteLength(result.text) !== result.size || sha(result.text) !== result.sha256) continue;
      if (changed.has(path) && sha(changed.get(path).after) !== result.sha256) throw new Error('本轮文件在工具之间发生了外部变化，无法归并版本');
      observed.set(path, { text: result.text, hash: result.sha256 });
      continue;
    }
    const previous = observed.get(path);
    let after;
    if (patchTool) {
      if (typeof args.expectedSha256 !== 'string' || !previous || previous.hash !== args.expectedSha256) throw new Error('本轮缺少写入前的完整文件版本，请使用工作区审查');
      after = applyRecordedPatches(previous.text, args.patches);
      if (Buffer.byteLength(after) !== result.size || sha(after) !== result.sha256) throw new Error('本轮补丁结果与确认版本不一致');
    } else {
      if (typeof args.text !== 'string' || Buffer.byteLength(args.text) !== result.size || sha(args.text) !== result.sha256) throw new Error('本轮写入文本与确认版本不一致');
      after = args.text;
      const creation = item.tool === 'fs_create' || args.expectedSha256 === null;
      if (creation && changed.has(path)) throw new Error('本轮文件重复创建，缺少完整版本链');
      if (!creation && (!previous || previous.hash !== args.expectedSha256)) throw new Error('本轮缺少写入前的完整文件版本，请使用工作区审查');
    }
    const creation = !patchTool && (item.tool === 'fs_create' || args.expectedSha256 === null);
    const before = creation ? '' : previous.text;
    // Verify the canonical prefix, then compare only this write's immediate
    // versions. Later tools or the current disk never replace its old side.
    if (itemId !== undefined && item.id === itemId) {
      changed.clear();
      changed.set(path, { before, after });
      break;
    }
    changed.set(path, { before: changed.get(path)?.before ?? before, after });
    observed.set(path, { text: after, hash: result.sha256 });
  }
  let diff = '';
  const contents = new Map();
  for (const [path, versions] of changed) {
    if (versions.before === versions.after) continue;
    contents.set(path, versions);
    diff += `diff --git a/${path} b/${path}\n` + createTwoFilesPatch(`a/${path}`, `b/${path}`, versions.before, versions.after, '', '');
  }
  return { diff, contents };
}
module.exports = { turnChanges };
