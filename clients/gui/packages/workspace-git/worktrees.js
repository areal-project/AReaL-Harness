"use strict";
const { execFile } = require("node:child_process");
const { promisify, isDeepStrictEqual } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const exec = promisify(execFile);
const inFlight = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (message, code = "WORKTREE_INVALID") => Object.assign(new Error(message), { code });
const pending = () =>
  Object.assign(
    fail("工作树结果尚未确认，请查询原请求；未重新创建或删除任何目录", "WORKTREE_PENDING"),
    { worktreeUncertain: true },
  );
const cleanEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});
const fixedConfig = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];
async function safeGit(root, args, { checkout = false } = {}) {
  const config = [...fixedConfig];
  if (checkout) {
    let names;
    try {
      names = (
        await exec(
          "git",
          [
            "-C",
            root,
            ...fixedConfig,
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|smudge|process|required)$",
          ],
          { env: cleanEnvironment(), maxBuffer: 1024 * 1024 },
        )
      ).stdout;
    } catch (error) {
      if (error.code !== 1) throw error;
      names = "";
    }
    const drivers = new Set(
      names
        .split("\0")
        .filter(Boolean)
        .map((name) => name.match(/^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/)?.[1])
        .filter(Boolean),
    );
    for (const driver of drivers)
      for (const [key, value] of [
        ["clean", ""],
        ["smudge", ""],
        ["process", ""],
        ["required", "false"],
      ])
        config.push("-c", `filter.${driver}.${key}=${value}`);
  }
  return (
    await exec("git", ["-C", root, ...config, ...args], {
      env: cleanEnvironment(),
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout;
}
function absoluteDirectory(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\0-\x1f\x7f]/.test(value) ||
    value.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
    throw fail("工作树根目录必须是无路径穿越的绝对目录");
  return path.resolve(value);
}
async function noSymlinkParents(directory, create = false) {
  const parsed = path.parse(directory);
  let cursor = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) continue;
      try {
        await fs.mkdir(cursor, { mode: 0o700 });
      } catch (failure) {
        if (failure.code !== "EEXIST") throw failure;
      }
      stat = await fs.lstat(cursor);
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw fail("工作树根目录及其父目录不能是符号链接或文件");
  }
  if (create && path.resolve(await fs.realpath(directory)) !== directory)
    throw fail("工作树根目录身份已变化");
}
async function gitIdentity(directory) {
  const root = await fs.realpath(
    (await safeGit(directory, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const common = (
    await safeGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  return { root, commonDir: await fs.realpath(common) };
}
// 返回物理 checkout 根，不用共享 commonDir 合并不同 Worktree 的执行身份。
async function checkoutRoot(directory) {
  try {
    return await fs.realpath((await safeGit(directory, ["rev-parse", "--show-toplevel"])).trim());
  } catch (error) {
    // 损坏 gitdir 的冒号错误不能当作普通目录；仓库发现明确结束才返回 null。
    if (error.code === 128 && /^fatal: not a git repository \(or /m.test(error.stderr ?? ""))
      return null;
    throw error;
  }
}
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function writeOnce(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, file);
    const parent = await fs.open(path.dirname(file), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  } finally {
    await fs.unlink(temporary);
  }
}
function requestPaths(storage, requestId) {
  if (!uuid.test(requestId)) throw fail("无效工作树标识");
  const root = path.join(storage, "worktree-creations");
  return {
    root,
    intent: path.join(root, `${requestId}.json`),
    result: path.join(root, `${requestId}.result.json`),
    created: path.join(root, `${requestId}.created.json`),
  };
}
const metadataPath = (directory, storage) =>
  path.join(storage, "worktrees", `${createHash("sha256").update(directory).digest("hex")}.json`);
async function metadata(record, storage) {
  await fs.mkdir(path.join(storage, "worktrees"), { recursive: true, mode: 0o700 });
  const file = metadataPath(record.directory, storage);
  if (!(await writeOnce(file, record)) && !isDeepStrictEqual(await readJson(file), record))
    throw fail("工作树已有不同创建记录", "WORKTREE_IDENTITY_CHANGED");
}
async function validateRecord(record) {
  await noSymlinkParents(record.directory);
  const actual = await gitIdentity(record.directory);
  if (actual.root !== record.directory || actual.commonDir !== record.commonDir)
    throw fail("工作树目录或仓库身份已变化", "WORKTREE_IDENTITY_CHANGED");
  const branch = (
    await safeGit(record.directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
  ).trim();
  if (branch !== record.branch)
    throw fail("工作树分支已变化，未修改现有检出", "WORKTREE_IDENTITY_CHANGED");
  if (record.cwd) {
    const expected = path.join(record.directory, record.relativeCwd ?? "");
    if (record.cwd !== expected)
      throw fail("工作树执行目录记录不匹配", "WORKTREE_IDENTITY_CHANGED");
    await noSymlinkParents(record.cwd);
    if ((await fs.realpath(record.cwd)) !== expected || !(await fs.stat(expected)).isDirectory())
      throw fail("来源相对目录在新工作树中不可用", "WORKTREE_IDENTITY_CHANGED");
  }
  const head = (await safeGit(record.directory, ["rev-parse", "--verify", "HEAD"])).trim();
  try {
    await safeGit(record.directory, ["merge-base", "--is-ancestor", record.base, head]);
  } catch {
    throw fail("工作树已不再基于原创建提交", "WORKTREE_IDENTITY_CHANGED");
  }
  return record;
}
function recordFrom(intent) {
  const {
    requestId,
    target,
    sourceCwd,
    relativeCwd,
    sourceHead,
    source,
    sourceRef,
    base,
    branch,
    directory,
    commonDir,
    createdAt,
  } = intent;
  return {
    requestId,
    target,
    sourceCwd,
    relativeCwd,
    sourceHead,
    source,
    sourceRef,
    base,
    branch,
    directory,
    cwd: path.join(directory, relativeCwd ?? ""),
    commonDir,
    copied: [],
    createdAt,
  };
}
async function checkoutComplete(record) {
  return !(
    await safeGit(
      record.directory,
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
      { checkout: true },
    )
  ).trim();
}
async function reconcile(storage, intent) {
  const record = recordFrom(intent);
  try {
    const trees = await listWorktrees(record.directory);
    const actual = trees.find((tree) => tree.root === record.directory);
    if (
      !actual ||
      actual.locked ||
      actual.prunable ||
      actual.branch !== record.branch ||
      actual.head !== record.base
    )
      return null;
    await validateRecord(record);
    if (!(await checkoutComplete(record))) return null;
  } catch (error) {
    if (error.code === "WORKTREE_IDENTITY_CHANGED") throw error;
    return null;
  }
  await metadata(record, storage);
  await writeOnce(requestPaths(storage, intent.requestId).created, { state: "created", record });
  return record;
}
async function listWorktrees(root) {
  const source = await gitIdentity(await fs.realpath(root));
  const output = await safeGit(source.root, ["worktree", "list", "--porcelain", "-z"]);
  const records = [];
  let current;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { root: field.slice(9), branch: null, head: null };
      records.push(current);
    } else if (current && field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (current && field.startsWith("branch "))
      current.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (current && field === "detached") current.detached = true;
    else if (current && field.startsWith("locked")) current.locked = true;
    else if (current && field.startsWith("prunable")) current.prunable = true;
    else if (current && field === "bare") current.bare = true;
  }
  for (const record of records) {
    try {
      record.root = await fs.realpath(record.root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return records;
}
async function readTaskCreationStatus(storage, requestId) {
  const paths = requestPaths(storage, requestId),
    intent = await readJson(paths.intent);
  if (!intent) return { state: "missing" };
  const confirmed = await readJson(paths.created);
  if (confirmed) return { state: "created", record: await validateRecord(confirmed.record) };
  const outcome = await readJson(paths.result);
  if (outcome?.state === "created")
    return { state: "created", record: await validateRecord(outcome.record) };
  if (outcome?.state === "failed") return outcome;
  const record = await reconcile(storage, intent);
  return record
    ? { state: "created", record }
    : (outcome ?? {
        state: "creating",
        message: "原创建结果尚未确认；保留目录和分支，请核查原请求",
      });
}
async function readTaskCreation(storage, requestId) {
  const paths = requestPaths(storage, requestId);
  if (!(await readJson(paths.intent))) {
    const directory = path.join(storage, "worktrees", `task-${requestId}`);
    const legacy = await readJson(metadataPath(directory, storage));
    if (!legacy) return null;
    const actual = await gitIdentity(directory);
    return validateRecord({ ...legacy, commonDir: actual.commonDir });
  }
  return (await readTaskCreationStatus(storage, requestId)).record ?? null;
}
async function waitForExisting(storage, requestId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await readTaskCreationStatus(storage, requestId);
    if (status.state === "created") return status.record;
    if (status.state === "failed") throw fail(status.message, status.code ?? "WORKTREE_FAILED");
    if (status.state === "unknown") throw pending();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw pending();
}
async function createTask(root, storage, options = {}) {
  const requestId = options.taskId ?? randomUUID(),
    paths = requestPaths(storage, requestId);
  const source = options.source ?? "head";
  if (source === "working-tree")
    throw fail("未提交改动快照模式已停用，避免自动创建提交；请选择提交或分支，原改动保持不变");
  if (!["head", "branch"].includes(source)) throw fail("不支持的隔离起点");
  const original = await fs.realpath(root),
    selected = await fs.realpath(options.sourceRoot ?? root);
  await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const worktreeRoot = absoluteDirectory(
    options.worktreeRoot ?? path.join(await fs.realpath(storage), "worktrees"),
  );
  await noSymlinkParents(worktreeRoot);
  const prefix = options.branchPrefix ?? "areal/task";
  if (
    typeof prefix !== "string" ||
    !prefix ||
    /[\0-\x20\x7f]/.test(prefix) ||
    prefix.startsWith("-")
  )
    throw fail("无效工作树分支前缀");
  const branch = options.branch ?? `${prefix}-${requestId}`;
  if (
    typeof branch !== "string" ||
    !branch ||
    branch.length > 512 ||
    /[\0-\x20\x7f]/.test(branch) ||
    branch.startsWith("-")
  )
    throw fail("无效工作树分支名称");
  const ref = source === "branch" ? options.ref : null;
  if (
    source === "branch" &&
    (typeof ref !== "string" ||
      !ref ||
      ref.length > 512 ||
      /[\0-\x1f\x7f]/.test(ref) ||
      ref.startsWith("-"))
  )
    throw fail("请输入有效起始分支或提交");
  const parameters = { root: original, sourceRoot: selected, source, ref, worktreeRoot, branch };
  const key = `${path.resolve(storage)}:${requestId}`;
  const running = inFlight.get(key);
  if (running) {
    if (!isDeepStrictEqual(running.parameters, parameters))
      throw fail("原工作树请求的参数不可修改", "WORKTREE_REQUEST_MISMATCH");
    return running.promise;
  }
  const existing = await readJson(paths.intent);
  if (existing) {
    if (!isDeepStrictEqual(existing.parameters, parameters))
      throw fail("原工作树请求的参数不可修改", "WORKTREE_REQUEST_MISMATCH");
    return waitForExisting(storage, requestId);
  }
  const promise = createReserved();
  inFlight.set(key, { parameters, promise });
  try {
    return await promise;
  } finally {
    if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
  }
  async function createReserved() {
    const origin = await gitIdentity(original),
      identity = await gitIdentity(selected);
    if (origin.commonDir !== identity.commonDir) throw fail("来源工作树必须属于同一 Git 仓库");
    const relativeCwd = path.relative(origin.root, original);
    const sourceCwd = path.join(identity.root, relativeCwd);
    const target = identity.root;
    const checkouts = await listWorktrees(target);
    if (
      checkouts.some(
        (tree) => worktreeRoot === tree.root || worktreeRoot.startsWith(`${tree.root}${path.sep}`),
      )
    )
      throw fail("工作树根目录不能位于已有检出目录内");
    await safeGit(target, ["check-ref-format", "--branch", branch]);
    if (options.fetchBeforeCreate === true)
      await safeGit(target, ["fetch", "--all", "--no-recurse-submodules", "--no-auto-maintenance"]);
    const sourceHead = (await safeGit(target, ["rev-parse", "--verify", "HEAD"])).trim();
    const base =
      source === "branch"
        ? (
            await safeGit(target, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
          ).trim()
        : sourceHead;
    const directory = path.join(worktreeRoot, `task-${requestId}`);
    const intent = {
      version: 1,
      requestId,
      parameters,
      target,
      sourceCwd,
      relativeCwd,
      sourceHead,
      source,
      sourceRef: ref,
      base,
      branch,
      directory,
      commonDir: identity.commonDir,
      createdAt: new Date().toISOString(),
    };
    await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
    if (!(await writeOnce(paths.intent, intent))) {
      const actual = await readJson(paths.intent);
      if (!isDeepStrictEqual(actual?.parameters, parameters))
        throw fail("原工作树请求的参数不可修改", "WORKTREE_REQUEST_MISMATCH");
      return waitForExisting(storage, requestId);
    }
    let gitStarted = false;
    try {
      let occupied = false;
      try {
        await safeGit(target, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        occupied = true;
      } catch (error) {
        if (error.code !== 1) throw error;
      }
      if (occupied) throw fail("工作树分支已存在，未覆盖或强制检出", "WORKTREE_BRANCH_EXISTS");
      await noSymlinkParents(worktreeRoot, true);
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code === "EEXIST")
          throw fail("工作树目录已存在，未覆盖或删除", "WORKTREE_DIRECTORY_EXISTS");
        throw error;
      }
      await noSymlinkParents(directory);
      gitStarted = true;
      await safeGit(target, ["worktree", "add", "--no-checkout", "-b", branch, directory, base]);
      await safeGit(directory, ["read-tree", base]);
      await safeGit(directory, ["checkout-index", "--all"], { checkout: true });
      const record = await validateRecord(recordFrom(intent));
      if (!(await checkoutComplete(record)))
        throw fail("工作树检出未完整确认，保留目录供核查", "WORKTREE_CHECKOUT_INCOMPLETE");
      await metadata(record, storage);
      await writeOnce(paths.created, { state: "created", record });
      return record;
    } catch (error) {
      if (gitStarted) {
        const recovered = await reconcile(storage, intent).catch(() => null);
        if (recovered) return recovered;
        error.worktreeUncertain = true;
      }
      await writeOnce(paths.result, {
        state: gitStarted ? "unknown" : "failed",
        code: error.code ?? "WORKTREE_FAILED",
        message: error.message,
      });
      throw error;
    }
  }
}
async function inspectManagedTask(storage, creationId, { allowDirty = false } = {}) {
  const record = await readTaskCreation(storage, creationId);
  if (!record) throw fail("工作树创建回执不可用", "WORKTREE_RECEIPT_MISSING");
  const trees = await listWorktrees(record.target);
  const tree = trees.find((item) => item.root === record.directory);
  if (
    !tree ||
    record.directory === record.target ||
    record.directory === trees[0]?.root ||
    tree.locked ||
    tree.prunable
  )
    throw fail("工作树身份、主目录或锁定状态不允许删除", "WORKTREE_REMOVE_BLOCKED");
  const status = await safeGit(record.directory, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (!allowDirty && status.trim())
    throw fail("工作树含有未提交改动、未跟踪或忽略文件", "WORKTREE_DIRTY");
  const submodules = await safeGit(record.directory, ["ls-files", "--stage"]);
  if (/^160000 /m.test(submodules)) throw fail("工作树含有子模块，保留目录", "WORKTREE_SUBMODULE");
  const target = await gitIdentity(record.target);
  if (target.commonDir !== record.commonDir)
    throw fail("来源仓库身份已变化", "WORKTREE_IDENTITY_CHANGED");
  const head = (await safeGit(record.directory, ["rev-parse", "HEAD"])).trim();
  try {
    await safeGit(record.target, ["merge-base", "--is-ancestor", head, "HEAD"]);
  } catch {
    throw fail("工作树包含尚未合并到来源的提交，保留目录与分支", "WORKTREE_UNMERGED");
  }
  return record;
}
async function readManagedTaskRemoval(storage, requestId) {
  if (!uuid.test(requestId)) throw fail("无效工作树删除标识");
  const file = path.join(storage, "worktree-removals", requestId + ".json");
  const record = await readJson(file);
  if (!record || record.removed) return record;
  if (
    await fs.lstat(record.directory).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    return record;
  const trees = await listWorktrees(record.target);
  if (trees.some((tree) => tree.root === record.directory)) return record;
  await safeGit(record.target, ["show-ref", "--verify", `refs/heads/${record.branch}`]);
  return { ...record, removed: true };
}
async function removeManagedTask(storage, { requestId, creationId }) {
  if (!uuid.test(requestId) || !uuid.test(creationId)) throw fail("无效工作树删除标识");
  const directory = path.join(storage, "worktree-removals"),
    file = path.join(directory, requestId + ".json");
  const existing = await readManagedTaskRemoval(storage, requestId);
  if (existing) {
    if (existing.creationId !== creationId) throw fail("删除标识已绑定其它工作树");
    if (existing.removed) return existing;
    throw fail("原删除结果尚未确认，请核对目录与 Git 登记", "WORKTREE_REMOVE_UNKNOWN");
  }
  const record = await inspectManagedTask(storage, creationId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const result = {
    requestId,
    creationId,
    directory: record.directory,
    branch: record.branch,
    target: record.target,
    removed: false,
  };
  if (!(await writeOnce(file, result))) throw fail("原删除正在核对", "WORKTREE_REMOVE_UNKNOWN");
  await safeGit(record.target, ["worktree", "remove", record.directory]);
  result.removed = true;
  const temporary = file + "." + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await fs.rename(temporary, file);
  return result;
}
module.exports = {
  inspectManagedTask,
  readManagedTaskRemoval,
  removeManagedTask,
  createTask,
  readTaskCreation,
  readTaskCreationStatus,
  listWorktrees,
  checkoutRoot,
};
