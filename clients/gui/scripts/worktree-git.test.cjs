"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const api = require("../packages/workspace-git");
const git = async (root, ...args) =>
    (
        await exec("git", ["-C", root, ...args], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        })
    ).stdout.trim();
async function fixture(t) {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "areal-worktree-test-")));
    t.after(() => fs.rm(scratch, { recursive: true, force: true }));
    const root = path.join(scratch, "source"),
        storage = path.join(scratch, "state");
    await fs.mkdir(root);
    await fs.mkdir(storage);
    await git(root, "init", "-b", "main");
    await fs.writeFile(path.join(root, "tracked.txt"), "committed\n");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await git(root, "add", ".");
    await git(
        root,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
    );
    return { scratch, root, storage, head: await git(root, "rev-parse", "HEAD") };
}
async function sourceState(root) {
    return {
        head: await git(root, "rev-parse", "HEAD"),
        index: await fs.readFile(path.join(root, ".git", "index")),
        status: await git(root, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
        tracked: await fs.readFile(path.join(root, "tracked.txt")),
        untracked: await fs.readFile(path.join(root, "untracked.txt")).catch(() => null),
        ignored: await fs.readFile(path.join(root, "ignored.txt")).catch(() => null),
    };
}

test("commit-only creation preserves staged, unstaged, untracked and ignored source bytes", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, "tracked.txt"), "staged\n");
    await git(f.root, "add", "tracked.txt");
    await fs.writeFile(path.join(f.root, "tracked.txt"), "unstaged\n");
    await fs.writeFile(path.join(f.root, "untracked.txt"), "new private input\n");
    await fs.writeFile(path.join(f.root, "ignored.txt"), "secret fixture\n");
    await fs.writeFile(path.join(f.root, ".worktreeinclude"), "ignored.txt\n");
    const before = await sourceState(f.root),
        id = randomUUID();
    const record = await api.createTask(f.root, f.storage, { taskId: id });
    assert.equal(record.base, f.head);
    assert.match(record.branch, /^areal\/task-/);
    assert.equal(
        await fs.readFile(path.join(record.directory, "tracked.txt"), "utf8"),
        "committed\n",
    );
    for (const file of ["untracked.txt", "ignored.txt"])
        await assert.rejects(fs.stat(path.join(record.directory, file)), { code: "ENOENT" });
    assert.deepEqual(record.copied, []);
    assert.deepEqual(await sourceState(f.root), before);
    assert.equal((await api.readTaskCreation(f.storage, id)).directory, record.directory);
});

test("custom root and branch survive repeat requests, changing defaults and module reload", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        worktreeRoot = path.join(f.scratch, "checkouts");
    const options = {
        taskId: id,
        worktreeRoot,
        branch: "areal/custom-topic",
        source: "branch",
        ref: "main",
    };
    const record = await api.createTask(f.root, f.storage, options);
    assert.equal(path.dirname(record.directory), worktreeRoot);
    assert.equal(record.branch, options.branch);
    assert.deepEqual(await api.createTask(f.root, f.storage, options), record);
    delete require.cache[require.resolve("../packages/workspace-git")];
    const reopened = require("../packages/workspace-git");
    assert.deepEqual(await reopened.readTaskCreation(f.storage, id), record);
    await assert.rejects(
        api.createTask(f.root, f.storage, { ...options, branch: "areal/changed" }),
        (error) => error.code === "WORKTREE_REQUEST_MISMATCH",
    );
    await git(
        record.directory,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "normal future commit",
    );
    assert.equal((await api.readTaskCreation(f.storage, id)).base, f.head);
});

test("same-id and different-id simultaneous creates converge without deleting a winner", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        options = { taskId: id };
    const records = await Promise.all([
        api.createTask(f.root, f.storage, options),
        api.createTask(f.root, f.storage, options),
    ]);
    assert.equal(records[0].directory, records[1].directory);
    const distinct = await Promise.all([
        api.createTask(f.root, f.storage),
        api.createTask(f.root, f.storage),
    ]);
    assert.notEqual(distinct[0].directory, distinct[1].directory);
    assert.equal((await api.listWorktrees(f.root)).length, 4);
    assert.equal(
        await fs.readFile(path.join(records[0].directory, "tracked.txt"), "utf8"),
        "committed\n",
    );
});

test("occupied branch and destination fail without replacing existing resources", async (t) => {
    const f = await fixture(t),
        id = randomUUID();
    await git(f.root, "branch", "areal/existing");
    await assert.rejects(
        api.createTask(f.root, f.storage, { taskId: id, branch: "areal/existing" }),
    );
    assert.equal(await git(f.root, "rev-parse", "areal/existing"), f.head);
    const pathId = randomUUID(),
        directory = path.join(f.storage, "worktrees", `task-${pathId}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "keep.txt"), "keep");
    await assert.rejects(api.createTask(f.root, f.storage, { taskId: pathId }));
    assert.equal(await fs.readFile(path.join(directory, "keep.txt"), "utf8"), "keep");
    const winner = await api.createTask(f.root, f.storage, { branch: "areal/racing" });
    await assert.rejects(api.createTask(f.root, f.storage, { branch: "areal/racing" }));
    assert.equal(await git(winner.directory, "rev-parse", "HEAD"), f.head);
});

test("source worktree selection validates common repository and resolves its HEAD", async (t) => {
    const f = await fixture(t),
        other = await fixture(t);
    const source = await api.createTask(f.root, f.storage, { branch: "areal/source" });
    await git(
        source.directory,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "source branch commit",
    );
    const sourceHead = await git(source.directory, "rev-parse", "HEAD");
    const next = await api.createTask(f.root, f.storage, { sourceRoot: source.directory });
    assert.equal(next.target, source.directory);
    assert.equal(next.base, sourceHead);
    await assert.rejects(api.createTask(f.root, f.storage, { sourceRoot: other.root }), /仓库/);
    await assert.rejects(api.createTask(f.scratch, f.storage), /git repository|Git|仓库/i);
});

test("unsafe branch, traversal, symlink root and legacy snapshot requests do not mutate source", async (t) => {
    const f = await fixture(t),
        before = await sourceState(f.root);
    for (const branch of ["-bad", "areal/../escape", "areal/new\nline", "areal/topic\0bad"])
        await assert.rejects(api.createTask(f.root, f.storage, { branch }));
    for (const worktreeRoot of ["relative", path.join(f.root, "nested"), `${f.scratch}/../escape`])
        await assert.rejects(api.createTask(f.root, f.storage, { worktreeRoot }));
    const actual = path.join(f.scratch, "actual");
    await fs.mkdir(actual);
    const link = path.join(f.scratch, "link");
    await fs.symlink(actual, link);
    await assert.rejects(
        api.createTask(f.root, f.storage, { worktreeRoot: path.join(link, "nested") }),
        /符号链接/,
    );
    await assert.rejects(
        api.createTask(f.root, f.storage, { source: "working-tree" }),
        /快照|未提交/,
    );
    assert.deepEqual(await sourceState(f.root), before);
});

test("creation disables inherited Git redirection, hooks, fsmonitor and smudge filters", async (t) => {
    const f = await fixture(t),
        trap = path.join(f.scratch, "trap");
    await git(f.root, "config", "core.hooksPath", path.join(f.scratch, "hooks"));
    await fs.mkdir(path.join(f.scratch, "hooks"));
    await fs.writeFile(
        path.join(f.scratch, "hooks", "post-checkout"),
        `#!/bin/sh\nprintf hook >> '${trap}'\n`,
        { mode: 0o700 },
    );
    await fs.writeFile(path.join(f.root, ".gitattributes"), "tracked.txt filter=trap\n");
    await git(f.root, "add", ".gitattributes");
    await git(
        f.root,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "attributes",
    );
    await git(f.root, "config", "filter.trap.smudge", `sh -c "printf smudge >> '${trap}'; cat"`);
    await git(
        f.root,
        "config",
        "filter.trap.process",
        `sh -c "printf process >> '${trap}'; exit 1"`,
    );
    await git(f.root, "config", "filter.trap.required", "true");
    await git(f.root, "config", "core.fsmonitor", `sh -c "printf monitor >> '${trap}'"`);
    const keys = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
    ];
    const saved = keys.map((key) => process.env[key]);
    try {
        Object.assign(process.env, {
            GIT_DIR: "/invalid/git",
            GIT_WORK_TREE: "/invalid/tree",
            GIT_INDEX_FILE: "/invalid/index",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.hooksPath",
            GIT_CONFIG_VALUE_0: "/invalid/hooks",
        });
        const record = await api.createTask(f.root, f.storage);
        assert.equal(
            await fs.readFile(path.join(record.directory, "tracked.txt"), "utf8"),
            "committed\n",
        );
    } finally {
        keys.forEach((key, index) =>
            saved[index] === undefined
                ? delete process.env[key]
                : (process.env[key] = saved[index]),
        );
    }
    await assert.rejects(fs.stat(trap), { code: "ENOENT" });
});

test("restart reconciles Git success with missing or unknown completion without another worktree", async (t) => {
    const f = await fixture(t),
        id = randomUUID();
    const record = await api.createTask(f.root, f.storage, {
        taskId: id,
        worktreeRoot: path.join(f.scratch, "custom-recovery"),
    });
    const journal = path.join(f.storage, "worktree-creations");
    await fs.unlink(path.join(journal, `${id}.created.json`));
    await fs.unlink(
        path.join(
            f.storage,
            "worktrees",
            `${require("node:crypto").createHash("sha256").update(record.directory).digest("hex")}.json`,
        ),
    );
    await fs.writeFile(
        path.join(journal, `${id}.result.json`),
        JSON.stringify({ state: "unknown", message: "connection lost after Git add" }),
    );
    const recovered = await api.readTaskCreationStatus(f.storage, id);
    assert.equal(recovered.state, "created");
    assert.equal(recovered.record.directory, record.directory);
    assert.equal((await api.listWorktrees(f.root)).length, 2);
    assert.equal(
        (
            await api.createTask(f.root, f.storage, {
                taskId: id,
                worktreeRoot: path.join(f.scratch, "custom-recovery"),
            })
        ).directory,
        record.directory,
    );
    await git(
        record.directory,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "recovered later work",
    );
    assert.equal((await api.readTaskCreationStatus(f.storage, id)).state, "created");
});

test("independent Node processes converge on one request and preserve the shared source", async (t) => {
    const f = await fixture(t),
        id = randomUUID();
    const modulePath = require.resolve("../packages/workspace-git");
    const script =
        "const api=require(process.argv[1]);api.createTask(process.argv[2],process.argv[3],{taskId:process.argv[4]}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})";
    const values = await Promise.all([
        exec(process.execPath, ["-e", script, modulePath, f.root, f.storage, id]),
        exec(process.execPath, ["-e", script, modulePath, f.root, f.storage, id]),
    ]);
    const records = values.map((value) => JSON.parse(value.stdout));
    assert.deepEqual(records[0], records[1]);
    assert.equal((await api.listWorktrees(f.root)).length, 2);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
});

test("simultaneous custom branch collision has one winner and never rolls it back", async (t) => {
    const f = await fixture(t),
        branch = "areal/one-owner";
    const results = await Promise.allSettled([
        api.createTask(f.root, f.storage, { branch }),
        api.createTask(f.root, f.storage, { branch }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const record = results.find((result) => result.status === "fulfilled").value;
    assert.equal(await git(record.directory, "branch", "--show-current"), branch);
    assert.equal(
        await fs.readFile(path.join(record.directory, "tracked.txt"), "utf8"),
        "committed\n",
    );
    assert.equal((await api.listWorktrees(f.root)).length, 2);
});

test("recovery rejects changed branch, foreign checkout and symlink replacement", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        record = await api.createTask(f.root, f.storage, { taskId: id });
    await git(record.directory, "checkout", "-b", "areal/rebound");
    await assert.rejects(
        api.readTaskCreation(f.storage, id),
        (error) => error.code === "WORKTREE_IDENTITY_CHANGED",
    );
    assert.equal(await git(record.directory, "branch", "--show-current"), "areal/rebound");
    await git(record.directory, "checkout", record.branch);
    const moved = record.directory + "-moved";
    await fs.rename(record.directory, moved);
    await fs.symlink(moved, record.directory);
    await assert.rejects(api.readTaskCreation(f.storage, id), /符号链接/);
});

test("recovery does not expose an initializing or locked checkout as completed", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        record = await api.createTask(f.root, f.storage, { taskId: id });
    await fs.unlink(path.join(f.storage, "worktree-creations", `${id}.created.json`));
    await git(f.root, "worktree", "lock", "--reason", "initializing fixture", record.directory);
    assert.equal((await api.readTaskCreationStatus(f.storage, id)).state, "creating");
    await git(f.root, "worktree", "unlock", record.directory);
    assert.equal((await api.readTaskCreationStatus(f.storage, id)).state, "created");
});

test("a repeated request keeps its frozen commit after its source ref advances", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        options = { taskId: id, source: "branch", ref: "main" };
    const first = await api.createTask(f.root, f.storage, options);
    await git(
        f.root,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "source advanced",
    );
    const advanced = await git(f.root, "rev-parse", "HEAD");
    assert.notEqual(advanced, f.head);
    assert.equal((await api.createTask(f.root, f.storage, options)).base, f.head);
    const second = await api.createTask(f.root, f.storage, { source: "branch", ref: "main" });
    assert.equal(second.base, advanced);
    assert.equal(await git(first.directory, "rev-parse", "HEAD"), f.head);
});

test("a known failed request is not replayed after an occupied branch becomes free", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        options = { taskId: id, branch: "areal/occupied" };
    await git(f.root, "branch", options.branch);
    await assert.rejects(
        api.createTask(f.root, f.storage, options),
        (error) => error.code === "WORKTREE_BRANCH_EXISTS",
    );
    await git(f.root, "branch", "-d", options.branch);
    await assert.rejects(
        api.createTask(f.root, f.storage, options),
        (error) => error.code === "WORKTREE_BRANCH_EXISTS",
    );
    assert.equal((await api.listWorktrees(f.root)).length, 1);
    assert.equal((await api.readTaskCreationStatus(f.storage, id)).state, "failed");
});

test("new-branch conditional filter configuration cannot execute during materialization", async (t) => {
    const f = await fixture(t),
        trap = path.join(f.scratch, "conditional-trap");
    await fs.writeFile(path.join(f.root, ".gitattributes"), "tracked.txt filter=conditional\n");
    await git(f.root, "add", ".gitattributes");
    await git(
        f.root,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "conditional attributes",
    );
    const include = path.join(f.scratch, "conditional.gitconfig");
    const command = `sh -c "printf trap >> '${trap}'; cat"`;
    await exec("git", ["config", "--file", include, "filter.conditional.smudge", command]);
    await exec("git", ["config", "--file", include, "filter.conditional.required", "true"]);
    await git(f.root, "config", "includeIf.onbranch:areal/*.path", include);
    const record = await api.createTask(f.root, f.storage);
    assert.equal(
        await fs.readFile(path.join(record.directory, "tracked.txt"), "utf8"),
        "committed\n",
    );
    await assert.rejects(fs.stat(trap), { code: "ENOENT" });
    assert.equal(
        await git(record.directory, "config", "--get", "filter.conditional.smudge"),
        command,
    );
    await git(record.directory, "checkout-index", "--force", "--all");
    assert.equal(await fs.readFile(trap, "utf8"), "trap");
});

test("registered but incomplete checkout is not recovered as created", async (t) => {
    const f = await fixture(t),
        id = randomUUID(),
        record = await api.createTask(f.root, f.storage, { taskId: id });
    await fs.unlink(path.join(f.storage, "worktree-creations", `${id}.created.json`));
    await fs.unlink(path.join(record.directory, "tracked.txt"));
    assert.equal((await api.readTaskCreationStatus(f.storage, id)).state, "creating");
    await fs.writeFile(path.join(record.directory, "tracked.txt"), "committed\n");
    assert.equal((await api.readTaskCreationStatus(f.storage, id)).state, "created");
});

test("a subdirectory project preserves its execution directory across source worktrees", async (t) => {
    const f = await fixture(t),
        relative = path.join("packages", "client");
    await fs.mkdir(path.join(f.root, relative), { recursive: true });
    await fs.writeFile(path.join(f.root, relative, "entry.txt"), "nested fixture\n");
    await git(f.root, "add", ".");
    await git(
        f.root,
        "-c",
        "user.name=Worktree test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "nested project",
    );
    const selected = await api.createTask(f.root, f.storage);
    const record = await api.createTask(path.join(f.root, relative), f.storage, {
        sourceRoot: selected.directory,
    });
    assert.equal(record.relativeCwd, relative);
    assert.equal(record.sourceCwd, path.join(selected.directory, relative));
    assert.equal(record.cwd, path.join(record.directory, relative));
    assert.equal(await fs.readFile(path.join(record.cwd, "entry.txt"), "utf8"), "nested fixture\n");
    const id = randomUUID();
    await assert.rejects(
        api.createTask(path.join(f.root, relative), f.storage, {
            taskId: id,
            source: "branch",
            ref: f.head,
        }),
    );
    assert.notEqual((await api.readTaskCreationStatus(f.storage, id)).state, "created");
    assert.equal(
        await fs.readFile(path.join(f.root, relative, "entry.txt"), "utf8"),
        "nested fixture\n",
    );
});

test("guarded removal preserves ignored and unmerged content and keeps the branch after deletion", async (t) => {
    const f = await fixture(t),
        creationId = randomUUID();
    const record = await api.createTask(f.root, f.storage, { taskId: creationId });
    const remove = () => api.removeManagedTask(f.storage, { requestId: randomUUID(), creationId });
    await fs.writeFile(path.join(record.directory, "ignored.txt"), "keep ignored");
    await assert.rejects(remove(), /ignored|未跟踪|忽略|改动/);
    assert.equal(
        await fs.readFile(path.join(record.directory, "ignored.txt"), "utf8"),
        "keep ignored",
    );
    await fs.unlink(path.join(record.directory, "ignored.txt"));
    await fs.writeFile(path.join(record.directory, "committed.txt"), "keep commit");
    await git(record.directory, "add", ".");
    await git(
        record.directory,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "preserved",
    );
    await assert.rejects(remove(), /合并|unmerged/);
    await git(f.root, "merge", "--ff-only", record.branch);
    const requestId = randomUUID();
    const result = await api.removeManagedTask(f.storage, { requestId, creationId });
    assert.equal(result.removed, true);
    assert.equal(
        await git(f.root, "rev-parse", record.branch),
        await git(f.root, "rev-parse", "HEAD"),
    );
    await assert.rejects(fs.access(record.directory));
    assert.deepEqual(await api.removeManagedTask(f.storage, { requestId, creationId }), result);
    await fs.writeFile(
        path.join(f.storage, "worktree-removals", requestId + ".json"),
        JSON.stringify({ ...result, removed: false }),
    );
    assert.equal(
        (await api.readManagedTaskRemoval(f.storage, requestId)).removed,
        true,
        "restart reconciles an already removed checkout without running remove again",
    );
});
