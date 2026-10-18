'use strict';
// Shared product worktree/review implementation: no Electron or DSH dependency.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parsePatch } = require('diff');
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const WORKTREE_BRANCH_PREFIX = 'areal/task-';

async function runGit(root, args, timeout) {
  const { stdout } = await exec('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}
const git = (root, ...args) => runGit(root, args);
const gitWrite = (root, ...args) => runGit(root, args, 120000);

function metadataPath(root, storage) {
  return path.join(storage, 'worktrees', hash(root) + '.json');
}

async function metadata(root, storage) {
  const file = metadataPath(await fs.realpath(root), storage);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function includePathspecs(root) {
  return fs.readFile(path.join(root, '.worktreeinclude'), 'utf8')
    .then(contents => contents.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(pattern => {
        if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
          throw new Error(`.worktreeinclude 包含非法路径：${pattern}`);
        }
        return pattern;
      }))
    .catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
}

async function copyWorktreeIncludes(source, destination) {
  const patterns = await includePathspecs(source);
  const copied = [];
  for (const pattern of patterns) {
    const ignored = (await git(source, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', pattern))
      .split('\0').filter(Boolean);
    for (const relative of ignored) {
      const sourcePath = path.join(source, relative);
      const targetPath = path.join(destination, relative);
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink()) continue;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(sourcePath, targetPath, { recursive: stat.isDirectory(), force: false, errorOnExist: false });
      copied.push(relative);
    }
  }
  return [...new Set(copied)];
}

async function createTask(root, storage, options = {}) {
  const taskId = options.taskId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) throw new Error('无效工作树标识');
  const source = options.source || 'head';
  if (!['head', 'working-tree', 'branch'].includes(source)) throw new Error('不支持的隔离起点');
  const target = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const sourceHead = (await git(target, 'rev-parse', 'HEAD')).trim();
  let base = sourceHead;
  if (source === 'branch') {
    if (typeof options.ref !== 'string' || !options.ref.trim() || options.ref.length > 512) throw new Error('请输入起始分支或提交');
    base = (await git(target, 'rev-parse', '--verify', '--end-of-options', `${options.ref}^{commit}`)).trim();
  }
  if (source === 'working-tree') {
    if ((await git(target, 'ls-files', '--unmerged')).trim()) throw new Error('项目存在未解决冲突，请先处理后再创建工作区快照');
    const scratch = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'areal-worktree-index-'));
    try {
      // A separate index captures tracked and untracked files without changing the user's staging area.
      const snapshotGit = async (...args) => (await exec('git', ['-C', target, ...args], {
        maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_TERMINAL_PROMPT: '0' },
      })).stdout.trim();
      await snapshotGit('read-tree', sourceHead);
      await snapshotGit('add', '-A', '--', '.');
      const tree = await snapshotGit('write-tree');
      base = await snapshotGit('-c', 'user.name=AReaL Harness', '-c', 'user.email=worktree@localhost', 'commit-tree', tree, '-p', sourceHead, '-m', 'Workspace starting snapshot');
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
  const branch = `areal/task-${taskId}`;
  const directory = path.join(storage, 'worktrees', branch.split('/')[1]);
  // A caller-supplied identity is a receipt key, never permission to replace
  // an earlier tree. Check before entering the rollback region.
  if (await fs.lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('工作树目录已存在，请核对原创建结果');
  if ((await git(target, 'branch', '--list', branch)).trim()) throw new Error('工作树分支已存在，请核对原创建结果');
  await fs.mkdir(path.dirname(directory), { recursive: true });
  let real;
  try {
    await git(target, 'worktree', 'add', '-b', branch, directory, base);
    real = await fs.realpath(directory);
    const copied = await copyWorktreeIncludes(target, real);
    const record = { target, base, source, sourceHead, sourceRef: source === 'branch' ? options.ref : null, branch, directory: real, copied, createdAt: new Date().toISOString() };
    await fs.writeFile(metadataPath(real, storage), JSON.stringify(record), { flag: 'wx' });
    return record;
  } catch (error) {
    try {
      if (real) await git(target, 'worktree', 'remove', '--force', real);
      else await fs.rm(directory, { recursive: true, force: true });
      await git(target, 'branch', '-D', branch);
    } catch { error.worktreeUncertain = true; }
    throw error;
  }
}

async function readTaskCreation(storage, taskId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) throw new Error('无效工作树标识');
  const directory = path.join(storage, 'worktrees', `task-${taskId}`);
  try {
    const record = await metadata(directory, storage);
    if (!record) return null;
    if (record.directory !== await fs.realpath(directory) || record.branch !== `areal/task-${taskId}`) throw new Error('工作树记录不匹配');
    const actual = await workspaceInfo(directory, storage);
    if (actual.root !== record.directory) throw new Error('工作树目录已变化');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function reviewFiles(diff, paths) {
  const parsed = diff ? parsePatch(diff) : [];
  if (paths && parsed.length !== paths.length) throw new Error('审查期间文件列表已变化，请刷新');
  return parsed.map((file, index) => {
    const name = file.newFileName === '/dev/null' ? file.oldFileName : file.newFileName;
    const filePath = paths?.[index] ?? (name || file.index || '').replace(/^[ab]\//, '');
    let additions = 0, deletions = 0;
    const hunks = file.hunks.map(hunk => {
      let oldLine = hunk.oldStart, newLine = hunk.newStart;
      const lines = hunk.lines.map(line => {
        const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line[0] === ' ' ? 'context' : 'meta';
        if (kind === 'add') additions++;
        if (kind === 'del') deletions++;
        return { kind, text: line.slice(1), oldLine: ['del', 'context'].includes(kind) ? oldLine++ : null, newLine: ['add', 'context'].includes(kind) ? newLine++ : null };
      });
      return { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines };
    });
    return { path: filePath, additions, deletions, hunks, binary: !hunks.length };
  });
}

async function workspaceTree(root) {
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const scratch = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'areal-review-index-'));
  try {
    const snapshotGit = async (...args) => (await exec('git', ['-C', top, ...args], {
      maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_TERMINAL_PROMPT: '0' },
    })).stdout.trim();
    await snapshotGit('read-tree', 'HEAD');
    await snapshotGit('add', '-A', '--', '.');
    const tree = await snapshotGit('write-tree');
    return { root: top, tree };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

async function snapshotTree(root, reference) {
  const snapshot = await workspaceTree(root);
  await git(snapshot.root, 'update-ref', reference, snapshot.tree);
  return snapshot;
}

async function reviewTrees(root, before, after, options = {}) {
  if (![before, after].every(value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value))) throw new Error('本轮快照尚未就绪');
  const context = options.context ?? 3;
  if (![3, 20, 100].includes(context)) throw new Error('不支持的上下文范围');
  const diff = await git(root, 'diff', '--no-ext-diff', '--no-textconv', '--binary', before, after, '--');
  const display = context === 3 ? diff : await git(root, 'diff', '--no-ext-diff', '--no-textconv', '--binary', `--unified=${context}`, before, after, '--');
  const paths = (await git(root, 'diff', '--name-only', '-z', before, after, '--')).split('\0').filter(Boolean);
  const files = reviewFiles(display, paths);
  if (options.highlight === true) await require('./review-highlight').highlightFiles(files);
  return { root, head: after, base: before, diff, files, scope: 'last-turn', conflicts: [], target: null, token: hash(JSON.stringify({ before, after, diff })) };
}

function reviewTurnFiles(root, turn, { itemId } = {}) {
  const { diff, contents } = require('./turn-review').turnChanges(turn, { itemId });
  const version = `turn:${turn.id}${itemId === undefined ? '' : `:item:${itemId}`}`;
  return { root, diff, files: reviewFiles(diff).map(file => ({ ...file, beforeText: contents.get(file.path)?.before, afterText: contents.get(file.path)?.after })), scope: itemId === undefined ? 'last-turn' : 'tool', turnId: turn.id, itemId,
    head: `${version}:after`, base: `${version}:before`, token: hash(JSON.stringify({ turnId: turn.id, itemId, diff })),
    notice: itemId === undefined ? '仅显示本轮可验证的文件工具修改；Shell 或外部编辑不计入。' : '仅显示该次可验证的文件工具修改，不使用当前磁盘版本。' };
}

const restoring = new Set();
async function restoreTrees(root, before, after, token) {
  if (![before, after].every(value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value))) throw new Error('本轮快照尚未就绪');
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  if (restoring.has(top)) throw new Error('当前工作区正在撤销另一轮改动');
  restoring.add(top);
  try {
    const reviewedDiff = await git(top, 'diff', '--no-ext-diff', '--no-textconv', '--binary', before, after, '--');
    const expected = hash(JSON.stringify({ before, after, diff: reviewedDiff }));
    if (typeof token !== 'string' || token !== expected) throw new Error('改动快照已变化，请刷新后重试');
    const paths = (await git(top, 'diff', '--no-renames', '--name-only', '-z', before, after, '--')).split('\0').filter(Boolean);
    if (!paths.length) return { restored: true, paths: [] };

    const current = await workspaceTree(top);
    const changed = (await git(top, 'diff', '--no-renames', '--name-only', '-z', after, current.tree, '--', ...paths)).split('\0').filter(Boolean);
    if (changed.length) throw new Error(`以下文件在本轮后又有改动，未执行撤销：${changed.slice(0, 5).join('、')}`);
    const staged = (await git(top, 'diff', '--cached', '--name-only', '-z', '--', ...paths)).split('\0').filter(Boolean);
    if (staged.length) throw new Error(`以下文件已有暂存内容，未执行撤销：${staged.slice(0, 5).join('、')}`);

    const reverseDiff = await git(top, 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--binary', before, after, '--');
    const scratch = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'areal-turn-undo-'));
    const patch = path.join(scratch, 'turn.patch');
    try {
      await fs.writeFile(patch, reverseDiff, { mode: 0o600 });
      try { await git(top, 'apply', '--reverse', '--check', '--binary', '--whitespace=nowarn', patch); }
      catch { throw new Error('本轮改动无法干净撤销，请先审查当前文件'); }
      try { await git(top, 'apply', '--reverse', '--binary', '--whitespace=nowarn', patch); }
      catch { throw new Error('撤销期间工作区发生变化，请刷新后重试'); }
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    return { restored: true, paths };
  } finally { restoring.delete(top); }
}

// Read-only picker data, pinned to the HEAD observed when this menu opens.
// Commit IDs are passed back to review; choosing one never checks it out.
async function reviewCommits(root) {
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const head = (await git(top, 'rev-parse', '--verify', 'HEAD').catch(async error => {
    await git(top, 'symbolic-ref', '--quiet', 'HEAD');
    if (!/unknown revision|Needed a single revision|not a valid/i.test(String(error.stderr))) throw error;
    return '';
  })).trim();
  if (!head) return { head, commits: [], truncated: false };
  const fields = (await runGit(top, ['log', '-z', '-101', '--format=%H%x00%s%x00%ct', head, '--'], 10000)).split('\0');
  fields.pop();
  const commits = [];
  for (let i = 0; i < fields.length; i += 3) {
    const [id, subject, timestamp] = fields.slice(i, i + 3);
    const committedAt = Number(timestamp);
    if (!/^[a-f0-9]{40,64}$/.test(id) || !Number.isFinite(committedAt)) throw new Error('提交历史格式无效');
    commits.push({ id, subject, committedAt });
  }
  return { head, commits: commits.slice(0, 100), truncated: commits.length > 100 };
}

// Only local refs and already present remote-tracking refs; never fetch or
// expose remote URLs. Symbolic remote HEAD aliases are not selectable branches.
async function reviewBranches(root) {
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const rows = await runGit(top, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)', 'refs/heads/', 'refs/remotes/'], 10000);
  const branches = rows.split('\n').filter(Boolean).map(row => {
    const [ref, name, id, symbolic] = row.split('\0');
    if (!/^[a-f0-9]{40,64}$/.test(id) || !name || !ref) throw new Error('分支列表格式无效');
    return symbolic ? null : { ref, name, id };
  }).filter(Boolean);
  return { branches };
}

async function review(root, storage, options = {}) {
  const context = options.context ?? 3;
  if (![3, 20, 100].includes(context)) throw new Error('不支持的上下文范围');
  const scope = options.scope || 'task';
  if (!['task', 'uncommitted', 'unstaged', 'staged', 'branch', 'commit'].includes(scope)) throw new Error('不支持的审查范围');
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const record = await metadata(top, storage);
  const head = (await git(top, 'rev-parse', '--verify', 'HEAD').catch(async error => {
    // An unborn branch is a valid repository for staging and the first commit.
    // Other invalid HEAD states still fail instead of inventing a base.
    await git(top, 'symbolic-ref', '--quiet', 'HEAD');
    if (!/unknown revision|Needed a single revision|not a valid/i.test(String(error.stderr))) throw error;
    return '';
  })).trim();
  const status = await git(top, 'status', '--porcelain');
  // Uncommitted is HEAD → current working tree, independent of the managed
  // worktree's creation base. The existing task comparison keeps that base.
  let base = (scope === 'uncommitted' ? undefined : record?.base) ?? (head || (await git(top, 'hash-object', '-t', 'tree', require('node:os').devNull)).trim());
  let reference;
  if (scope === 'branch' || scope === 'commit') {
    if (typeof options.ref !== 'string' || !options.ref.trim() || options.ref.length > 512) throw new Error('请选择基准分支或提交');
    const ref = (await git(top, 'rev-parse', '--verify', '--end-of-options', `${options.ref}^{commit}`)).trim();
    base = scope === 'branch' ? (await git(top, 'merge-base', head, ref)).trim() : ref;
    const label = scope === 'commit'
      ? (await git(top, 'log', '-1', '--format=%s', ref, '--')).trim()
      : (await git(top, 'rev-parse', '--verify', '--abbrev-ref', '--symbolic-full-name', '--end-of-options', options.ref)).trim();
    reference = { id: ref, label: label || ref.slice(0, 7) };
  }
  const args = scope === 'staged' ? ['--cached'] : scope === 'unstaged' ? [] : scope === 'branch' ? [base, head] : [base];
  const diffArgs = scope === 'commit'
    ? ['show', '--format=', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--binary', base, '--']
    : ['diff', '--no-ext-diff', '--no-textconv', '--binary', ...args, '--'];
  let diff = await git(top, ...diffArgs);
  let displayDiff = context === 3 ? diff : await git(top, diffArgs[0], `--unified=${context}`, ...diffArgs.slice(1));
  const paths = (scope === 'commit'
    ? await git(top, 'show', '--format=', '--diff-merges=first-parent', '--name-only', '-z', base, '--')
    : await git(top, 'diff', '--name-only', '-z', ...args, '--')).split('\0').filter(Boolean);
  const untracked = ['task', 'uncommitted', 'unstaged'].includes(scope) ? (await git(top, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean) : [];
  for (const file of untracked) {
    let added;
    try { added = await git(top, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', require('node:os').devNull, file); }
    catch (error) { if (error.code === 1 && typeof error.stdout === 'string') added = error.stdout; else throw error; }
    diff += added; displayDiff += added;
    if (Buffer.byteLength(diff) > 8 * 1024 * 1024) throw new Error('改动过大，请缩小任务范围后审查');
    paths.push(file);
  }
  let targetHead = null;
  let targetStatus = '';
  let conflicts = [];
  if (record) {
    targetHead = (await git(record.target, 'rev-parse', 'HEAD')).trim();
    targetStatus = await git(record.target, 'status', '--porcelain');
    conflicts = (await git(record.target, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
  }
  const files = reviewFiles(displayDiff, paths);
  if (options.highlight === true) await require('./review-highlight').highlightFiles(files);
  const branch = (await git(top, 'branch', '--show-current')).trim();
  return { head, base, diff, files, scope, reference, root: top, dirty: Boolean(status), target: record?.target ?? null, branch: branch || '(detached)',
    targetDirty: Boolean(targetStatus), conflicts,
    token: hash(JSON.stringify({ head, status, diff, targetHead, targetStatus, scope, base })) };
}
const busy = new Set();

/** Git remains authoritative. This preview includes index and worktree bytes,
 * not just status letters, and hides remote URLs from the renderer. */
async function gitState(root, storage) {
  const staged = await review(root, storage, { scope: 'staged' });
  const unstaged = await review(root, storage, { scope: 'unstaged' });
  if (staged.head !== unstaged.head || staged.branch !== unstaged.branch) throw new Error('Git 状态已变化，请刷新后重试');
  const remotes = (await git(staged.root, 'remote')).split('\n').filter(Boolean);
  const destinations = [];
  for (const name of remotes) destinations.push([name, await git(staged.root, 'remote', 'get-url', '--push', '--all', name)]);
  return { root: staged.root, head: staged.head, branch: staged.branch === '(detached)' ? '' : staged.branch,
    staged: staged.files.map(file => file.path), unstaged: unstaged.files.map(file => file.path), remotes,
    token: hash(JSON.stringify({ staged: staged.token, unstaged: unstaged.token, branch: staged.branch, destinations })) };
}

/** Only explicit user Git operations; no force push, deletion, model command or
 * turn-undo inference. The shared backend serializes this application's writes.
 * Git's native locks still arbitrate external commands; this is not a transaction
 * over arbitrary external editors and hooks between preview and commit. */
async function gitChange(root, storage, request) {
  const top = await fs.realpath((await git(root, 'rev-parse', '--show-toplevel')).trim());
  if (busy.has(top)) throw new Error('当前仓库正在执行 Git 操作，请稍后刷新');
  busy.add(top);
  try {
    const state = await gitState(top, storage);
    if (typeof request.token !== 'string' || request.token !== state.token) throw new Error('Git 状态已变化，请刷新后重试');
    if ((await git(top, 'ls-files', '--unmerged')).trim()) throw new Error('存在未解决的合并冲突，请先处理后刷新');
    try {
      switch (request.operation) {
        case 'gitStage':
          await gitWrite(top, 'add', '-A', '--', '.');
          return { applied: true };
        case 'gitUnstage':
          if (state.head) await gitWrite(top, 'reset', '--quiet', 'HEAD', '--', '.');
          else await gitWrite(top, 'read-tree', '--empty');
          return { applied: true };
        case 'gitCommit': {
          if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 10000 || request.message.includes('\0')) throw new Error('请输入有效的提交信息（最多10000字符）');
          if (!state.staged.length) throw new Error('没有已暂存的改动');
          await gitWrite(top, 'commit', '-m', request.message.trim());
          return { applied: true, head: (await git(top, 'rev-parse', 'HEAD')).trim() };
        }
        case 'gitPush': {
          if (!state.head || !state.branch) throw new Error('请先在分支上创建提交');
          if (!state.remotes.includes(request.remote)) throw new Error('请选择已配置的远程仓库');
          const destination = request.targetBranch;
          if (typeof destination !== 'string' || !destination || destination.length > 512 || destination.startsWith('-')) throw new Error('请输入有效的目标分支');
          await git(top, 'check-ref-format', `refs/heads/${destination}`);
          const urls = (await git(top, 'remote', 'get-url', '--push', '--all', request.remote)).trim().split('\n');
          if (urls.length !== 1) throw new Error('此远程配置了多个推送地址，请先在 Git 中明确目标');
          // Pin the previewed commit rather than an advancing branch name. All
          // branch destinations are explicit; repository push defaults cannot
          // expand this into tag, submodule or mirror pushes.
          await gitWrite(top, '-c', `remote.${request.remote}.mirror=false`, 'push', '--porcelain', '--no-force', '--no-follow-tags', '--no-recurse-submodules', '--', request.remote, `${state.head}:refs/heads/${destination}`);
          return { applied: true, head: state.head, remote: request.remote, targetBranch: destination };
        }
        default: throw new Error('不支持的 Git 操作');
      }
    } catch (error) {
      // Never return a process command/stdout containing remote credentials.
      if (!Object.hasOwn(error, 'cmd')) throw error;
      const detail = String(error.stderr || '');
      if (request.operation === 'gitPush') {
        if (/non-fast-forward|fetch first|\[rejected\]/i.test(detail + String(error.stdout || ''))) throw new Error('推送被拒绝：远程分支包含其他提交。请先在 Git 中合并后刷新，不会自动强推。');
        throw new Error('推送结果未能确认。请核对远程分支、连接和权限后刷新；不会自动重试。');
      }
      throw new Error('Git 操作未完成或结果未能确认。请检查提交身份、签名、仓库钩子或锁，再刷新状态；不会自动重试。');
    }
  } finally { busy.delete(top); }
}
/** Paths are relative to the opened workspace, including when it is a repo subdirectory. */
async function fileStatus(root) {
  const directory = await fs.realpath(root);
  let top;
  try { top = (await git(directory, 'rev-parse', '--show-toplevel')).trim(); }
  catch { return { available: false, entries: [] }; }
  const records = (await git(top, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const xy = record.slice(0, 2);
    const name = record.slice(3);
    if (/[RC]/.test(xy)) index++; // -z rename/copy records have a second, original path.
    const relative = path.relative(directory, path.resolve(top, name));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    const status = xy === '??' ? 'U' : xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'C' : xy.includes('D') ? 'D' : xy.includes('R') ? 'R' : xy.includes('A') ? 'A' : 'M';
    entries.push({ path: relative.split(path.sep).join('/'), status });
  }
  return { available: true, entries };
}

async function workspaceInfo(root, storage) {
  const directory = await fs.realpath(root);
  try {
    const top = (await git(directory, 'rev-parse', '--show-toplevel')).trim();
    const record = await metadata(top, storage);
    return { directory, root: top, branch: (await git(top, 'branch', '--show-current')).trim() || '(detached)',
      head: (await git(top, 'rev-parse', '--verify', 'HEAD').catch(() => '')).trim(),
      dirty: Boolean(await git(top, 'status', '--porcelain')), target: record?.target, base: record?.base, source: record?.source, sourceRef: record?.sourceRef, createdAt: record?.createdAt };
  } catch (error) {
    if (/not a git repository/i.test(String(error.stderr || error.message))) return { directory, root: directory, git: false };
    throw error;
  }
}
async function mergeTask(root, storage, token) {
  const record = await metadata(root, storage);
  if (!record) throw new Error('当前会话不是由应用创建的隔离任务');
  if (busy.has(record.target)) throw new Error('该项目正在合入另一个任务');
  busy.add(record.target);
  try {
    const current = await review(root, storage);
    if (current.token !== token) throw new Error('改动或目标项目已变化，请刷新并重新审查');
    if (current.dirty) throw new Error('请先让 Agent 提交任务改动，再刷新审查');
    if (current.targetDirty) throw new Error('目标项目有未提交改动，请先处理后重试');
    try {
      await git(record.target, 'merge', '--no-edit', current.head);
      return { merged: true, target: record.target };
    } catch (error) {
      const conflicts = (await git(record.target, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
      if (conflicts.length) return { conflicts, target: record.target, error: '合并存在冲突，请在目标项目处理并完成合并。' };
      throw error;
    }
  } finally { busy.delete(record.target); }
}

async function removeTask(root, storage, options = {}) {
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const record = await metadata(top, storage);
  if (!record) throw new Error('当前会话不是由应用创建的隔离任务');
  const dirty = (await git(top, 'status', '--porcelain')).trim();
  if (dirty && options.force !== true) throw new Error('隔离任务有未提交改动，请先提交或使用强制清理。');
  const directoryExists = await fs.access(record.directory).then(() => true, () => false);
  if (directoryExists) {
    await git(record.target, 'worktree', 'remove', ...(options.force === true ? ['--force'] : []), record.directory);
  } else {
    await git(record.target, 'worktree', 'prune');
  }
  if (record.branch?.startsWith(WORKTREE_BRANCH_PREFIX)) {
    try { await git(record.target, 'branch', '-D', record.branch); }
    catch (error) { if (!/not found|not exist/i.test(String(error.stderr || error.message))) throw error; }
  }
  await fs.rm(metadataPath(top, storage), { force: true });
  return { removed: true, directory: record.directory, branch: record.branch, target: record.target };
}

module.exports = { fileStatus, createTask, readTaskCreation, review, reviewCommits, reviewBranches, mergeTask, removeTask, copyWorktreeIncludes, reviewFiles, workspaceInfo, snapshotTree, reviewTrees, restoreTrees, reviewTurnFiles, gitState, gitChange };
