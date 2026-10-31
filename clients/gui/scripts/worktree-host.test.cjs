"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readFile, rename, rm, realpath } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const requireApp = createRequire(join(__dirname, "../app/package.json"));
const { CoreBackend } = requireApp("./src/core/backend.cjs");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
async function setup(t, { gitRepo = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "areal-host-worktree-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source"),
    home = join(directory, "desktop");
  await mkdir(root);
  await mkdir(home);
  await writeFile(join(root, "shared.txt"), "baseline\n");
  if (gitRepo) {
    git(root, "init", "-b", "main");
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
  }
  const id = createHash("sha256").update(root).digest("hex").slice(0, 24),
    facts = new Map(),
    calls = [];
  async function backend() {
    const b = new CoreBackend({ binary: "/bin/true", home, userHome: join(directory, "user") });
    try {
      b.saved = JSON.parse(await readFile(join(home, "projects.json"), "utf8"));
    } catch {
      b.saved = [{ id, root }];
    }
    b.lifecycleOperations = {
      assertProject() {},
      blocking() {
        return false;
      },
      schedulingSuppressed() {
        return false;
      },
      activeTargets: new Set(),
      generation: "fixture",
    };
    b.save = async (name, value) => {
      const path = join(home, name);
      await mkdir(dirname(path), { recursive: true });
      const temp = path + "." + randomUUID();
      await writeFile(temp, JSON.stringify(value));
      await rename(temp, path);
    };
    b.providers.catalog = () => [];
    b.providers.lastAcceptedModel = null;
    b.resources.beforeCreate = async () => {};
    b.supportsBrowser = () => false;
    b.refreshAfterAdmission = async () => {};
    b.start = async (ownerId) => {
      const saved = b.saved.find((p) => p.id === ownerId);
      assert.ok(saved, "execution is registered before launch");
      let live = b.projects.get(ownerId);
      if (!live) {
        const state = {
          connected: true,
          threads: Object.fromEntries(
            [...(facts.get(ownerId)?.values() ?? [])].map((thread) => [thread.id, thread]),
          ),
          queues: {},
          interactions: {},
        };
        live = {
          ...saved,
          model: {
            state,
            getSnapshot() {
              return this.state;
            },
          },
          summaries: Object.values(state.threads),
          summariesLoaded: true,
          configurations: {},
          pending: [],
          outcomes: {},
          models: [],
          profiles: [],
          client: {
            ready: true,
            capabilities: { features: { permissionPresets: true } },
            request: async (method, params) => {
              if (method === "thread/read") return { thread: state.threads[params.threadId] };
              if (method === "areal/task/list") return { data: [], nextCursor: null };
              if (method === "areal/server/status")
                return {
                  acceptingWork: true,
                  activeTurns: [],
                  resources: [],
                  unresolvedTools: [],
                  activeGoals: [],
                  compactions: [],
                  workgroups: [],
                  activeTasks: 0,
                  pendingQueueItems: 0,
                };
              assert.fail("unexpected fixture read " + method);
            },
          },
          service: { serviceId: ownerId },
          connectionGeneration: 1,
        };
        b.projects.set(ownerId, live);
      }
      return live;
    };
    b.listThreads = async (p) => (p.summaries = Object.values(p.model.state.threads));
    b.submit = async (p, method, parameters, options) => {
      calls.push({ root: p.root, owner: p.id, method, parameters, options });
      assert.equal(method, "areal/thread/start");
      const threadId = randomUUID();
      const thread = {
        id: threadId,
        sessionId: threadId,
        cwd: p.root,
        turns: [],
        desktop: {},
        createdAt: 1,
      };
      if (!facts.has(p.id)) facts.set(p.id, new Map());
      facts.get(p.id).set(options.requestId, thread);
      p.model.state.threads[thread.id] = thread;
      p.summaries.push(thread);
      return { thread };
    };
    b.readSubmission = async (p, _method, params) => {
      const thread = facts.get(p.id)?.get(params.requestId);
      return thread ? { confirmed: true, result: { threadId: thread.id } } : { confirmed: false };
    };
    b.openThread = async (p, threadId) => {
      assert.ok(Object.values(p.model.state.threads).some((thread) => thread.id === threadId));
    };
    await b.library.init();
    await b.worktrees.init();
    return b;
  }
  return { root, home, id, facts, calls, backend };
}

test("ordinary desktop creates share the selected checkout until Worktree is explicitly selected", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  const requests = [0, 1].map(() => ({ projectId: f.id, requestId: randomUUID() }));
  const threads = await Promise.all(requests.map((request) => b.command("create", request)));
  assert.notEqual(threads[0].threadId, threads[1].threadId);
  assert.deepEqual(
    f.calls.map((call) => call.root),
    [f.root, f.root],
  );
  assert.equal(b.saved.length, 1);
  assert.equal(git(f.root, "branch", "--show-current"), "main");
  b.ownerTasks.changed(f.id);
  b.ownerTasks.changed(f.id);
  b.ownerTasks.changed("other-project");
  const snapshot = b.snapshot().projects[0];
  assert.equal(snapshot.core.taskDirectoryRevision, 2);
  assert.deepEqual(snapshot.scheduling, { suppressed: false, activationError: null });
  assert.equal(Object.keys(snapshot.state.threads).length, 2);
  assert.ok(Object.values(snapshot.state.threads).every((thread) => !thread.worktree));
  const explicit = await b.command("create", {
    projectId: f.id,
    requestId: randomUUID(),
    worktree: { mode: "worktree", ref: "main" },
  });
  const isolated = b.snapshot().projects[0].state.threads[explicit.threadId];
  assert.notEqual(isolated.cwd, f.root);
  assert.equal(isolated.worktree.automatic, false);
  assert.ok(isolated.worktree.branch.startsWith("areal"));
  assert.deepEqual(
    isolated.worktreeEvents.map((event) => event.state),
    ["creating", "created", "binding", "ready"],
  );
  assert.equal(await readFile(join(f.root, "shared.txt"), "utf8"), "baseline\n");
});

test("same creation identity reuses one thread and rejects changed model or checkout parameters", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    request = {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree", ref: "main" },
    };
  const [first, second] = await Promise.all([
    b.command("create", request),
    b.command("create", request),
  ]);
  assert.equal(first.threadId, second.threadId);
  assert.equal(f.calls.length, 1);
  assert.equal(b.saved.length, 2);
  await assert.rejects(
    b.command("create", { ...request, model: { providerId: "other", modelId: "new" } }),
    /参数/,
  );
  await assert.rejects(
    b.command("create", { ...request, worktree: { mode: "worktree", ref: "HEAD" } }),
    /参数/,
  );
  assert.equal(f.calls.length, 1);
});

test("persisted thread binding routes files, background processes, children and request recovery to its original host", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    request = {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree", ref: "main" },
    };
  const { threadId } = await b.command("create", request),
    owner = b.worktrees.executionProjectId(f.id, threadId);
  const restarted = await f.backend();
  await restarted.start(f.id);
  await restarted.worktrees.connectExecutions(f.id);
  for (const [name, params] of [
    ["manage", { threadId, operation: "processStart" }],
    ["manage", { parentThreadId: threadId, operation: "agentSpawn" }],
    ["history", { threadId, operation: "acquire" }],
    ["side", { sourceThreadId: threadId, operation: "start" }],
    ["reconcile", { requestId: request.requestId }],
  ]) {
    const routed = await restarted.worktrees.resolveRequest(name, {
      projectId: f.id,
      ...params,
    });
    assert.equal(routed.projectId, owner);
    assert.equal(routed.logicalProjectId, f.id);
  }
  const read = await restarted.command("workspace", {
    projectId: f.id,
    threadId,
    operation: "read",
    path: "shared.txt",
  });
  await restarted.command("workspace", {
    projectId: f.id,
    threadId,
    operation: "save",
    path: "shared.txt",
    revision: read.revision,
    text: "isolated edit\n",
  });
  assert.equal(
    await readFile(join(b.saved.find((p) => p.id === owner).root, "shared.txt"), "utf8"),
    "isolated edit\n",
  );
  assert.equal(await readFile(join(f.root, "shared.txt"), "utf8"), "baseline\n");
  const repeat = await restarted.command("create", request);
  assert.equal(repeat.threadId, threadId);
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    restarted.command("create", { projectId: owner, requestId: randomUUID() }),
    /不能绕过/,
  );
  await assert.rejects(
    restarted.worktrees.resolveRequest("open", {
      projectId: f.id,
      threadId,
      logicalProjectId: "foreign",
    }),
    /归属/,
  );
});

test("lost thread-start response is reconciled from original host receipt without duplicate creation", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    request = {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree", ref: "main" },
    };
  const submit = b.submit;
  b.submit = async (...args) => {
    await submit(...args);
    throw Object.assign(new Error("response lost"), { submissionUnknown: true });
  };
  await assert.rejects(b.command("create", request), /response lost/);
  assert.equal(b.worktrees.records.get(request.requestId).state, "binding");
  const restarted = await f.backend(),
    result = await restarted.command("create", request);
  assert.ok(result.threadId);
  assert.equal(f.calls.length, 1);
  assert.equal(restarted.worktrees.records.get(request.requestId).state, "ready");
  assert.notEqual(f.calls[0].root, f.root);
});

test("unconfirmed binding never starts another thread or falls back to the source checkout", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    request = {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree", ref: "main" },
    };
  b.submit = async () => {
    throw Object.assign(new Error("no confirmation"), { submissionUnknown: true });
  };
  await assert.rejects(b.command("create", request), /no confirmation/);
  const record = b.worktrees.records.get(request.requestId);
  assert.equal(record.state, "binding");
  assert.ok(record.record.directory);
  const restarted = await f.backend();
  await assert.rejects(restarted.command("create", request), /不会重发/);
  assert.equal(f.calls.length, 0);
  assert.equal(restarted.saved.length, 2);
  assert.equal(await readFile(join(record.record.directory, "shared.txt"), "utf8"), "baseline\n");
});

test("non-Git directories allow ordinary conversations and reject only explicit Worktree creation", async (t) => {
  const f = await setup(t, { gitRepo: false }),
    b = await f.backend();
  await b.command("create", { projectId: f.id, requestId: randomUUID() });
  await b.command("create", { projectId: f.id, requestId: randomUUID() });
  await b.command("create", {
    projectId: f.id,
    requestId: randomUUID(),
    worktree: { ref: "HEAD" },
  });
  await assert.rejects(
    b.command("create", {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree" },
    }),
  );
  assert.deepEqual(
    f.calls.map((call) => call.root),
    [f.root, f.root, f.root],
  );
  assert.equal(b.saved.length, 1);
});

test("settings affect future checkouts and source-specific options list real Git branches", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  git(f.root, "branch", "feature");
  const options = await b.command("workspace", { projectId: f.id, operation: "worktreeOptions" });
  assert.ok(options.branches.includes("main"));
  assert.ok(options.branches.includes("feature"));
  assert.equal(options.settings.branchPrefix, "areal");
  await b.command("workspace", {
    projectId: f.id,
    operation: "worktreeSettings",
    branchPrefix: "areal/custom",
    worktreeRoot: join(f.home, "configured"),
  });
  const { threadId } = await b.command("create", {
    projectId: f.id,
    requestId: randomUUID(),
    worktree: { mode: "worktree", ref: "feature" },
  });
  const thread = b.snapshot().projects[0].state.threads[threadId];
  assert.ok(thread.worktree.branch.startsWith("areal/custom"));
  assert.ok(thread.cwd.startsWith(join(f.home, "configured")));
  await assert.rejects(
    b.command("workspace", {
      projectId: f.id,
      operation: "worktreeSettings",
      branchPrefix: "-bad",
      worktreeRoot: "",
    }),
    /前缀/,
  );
  assert.equal(git(f.root, "branch", "--show-current"), "main");
});

test("known unsupported Core rejects before reserving a directory or source author", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    live = await b.start(f.id),
    request = {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree", ref: "main" },
    };
  live.client.capabilities.features.permissionPresets = false;
  await assert.rejects(b.command("create", request), (error) => error.submissionUnknown === false);
  assert.equal(b.worktrees.records.size, 0);
  assert.equal(b.saved.length, 1);
  assert.equal(f.calls.length, 0);
  live.client.capabilities.features.permissionPresets = true;
  await b.command("create", { projectId: f.id, requestId: randomUUID() });
  assert.equal(f.calls[0].root, f.root);
});

test("known pre-dispatch failure stays failed and does not retain a local author reservation", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    request = { projectId: f.id, requestId: randomUUID() };
  b.resources.beforeCreate = async () => {
    throw new Error("configuration invalid");
  };
  await assert.rejects(b.command("create", request), /configuration invalid/);
  assert.equal(b.worktrees.records.get(request.requestId).state, "failed");
  b.resources.beforeCreate = async () => {};
  await b.command("create", { projectId: f.id, requestId: randomUUID() });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].root, f.root);
});

test("registration failure after Git creation preserves the checkout and resumes the same resource", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    save = b.save,
    request = {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "worktree", ref: "main" },
    };
  let fail = true;
  b.save = async (name, value) => {
    if (name === "projects.json" && fail) {
      fail = false;
      throw new Error("registration unavailable");
    }
    return save(name, value);
  };
  await assert.rejects(b.command("create", request), (error) => {
    assert.match(error.message, /registration unavailable/);
    assert.equal(error.requestId, request.requestId);
    assert.equal(error.submissionUnknown, true);
    return true;
  });
  const record = b.worktrees.records.get(request.requestId);
  assert.equal(record.state, "created");
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(record.record.directory, "shared.txt"), "utf8"), "baseline\n");
  const resumed = await b.command("create", request);
  assert.ok(resumed.threadId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].root, record.record.cwd ?? record.record.directory);
});

test("non-creation pending and outcome receipts recover through the owning execution host", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  const { threadId } = await b.command("create", {
    projectId: f.id,
    requestId: randomUUID(),
    worktree: { mode: "worktree", ref: "main" },
  });
  const owner = b.worktrees.executionProjectId(f.id, threadId),
    live = b.projects.get(owner),
    pendingId = randomUUID(),
    completedId = randomUUID();
  live.pending.push({ method: "areal/turn/submit", params: { requestId: pendingId, threadId } });
  live.outcomes[completedId] = { accepted: true };
  assert.equal(
    (await b.worktrees.resolveRequest("reconcile", { projectId: f.id, requestId: pendingId }))
      .projectId,
    owner,
  );
  assert.equal(
    (
      await b.worktrees.resolveRequest("dismissRecovery", {
        projectId: f.id,
        requestId: completedId,
      })
    ).projectId,
    owner,
  );
});

test("observed child ownership survives restart before child views have loaded", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  const { threadId } = await b.command("create", {
    projectId: f.id,
    requestId: randomUUID(),
    worktree: { mode: "worktree", ref: "main" },
  });
  const owner = b.worktrees.executionProjectId(f.id, threadId),
    live = b.projects.get(owner),
    child = randomUUID();
  live.model.state.threads[child] = {
    id: child,
    parentThreadId: threadId,
    cwd: live.root,
    turns: [],
  };
  await b.worktrees.observeProject(live);
  const restarted = await f.backend();
  assert.equal(restarted.projects.size, 0);
  assert.equal(restarted.worktrees.executionProjectId(f.id, child), owner);
  assert.equal(
    (await restarted.worktrees.resolveRequest("open", { projectId: f.id, threadId: child }))
      .projectId,
    owner,
  );
});

test("root and subdirectory projects keep their selected current directories", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  const subroot = join(f.root, "src");
  await mkdir(subroot);
  await writeFile(join(subroot, "entry.txt"), "committed subdirectory\n");
  git(f.root, "add", "src");
  git(
    f.root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "subdirectory",
  );
  const subId = createHash("sha256").update(subroot).digest("hex").slice(0, 24);
  b.saved.push({ id: subId, root: subroot });
  const results = await Promise.all(
    [f.id, subId].map((projectId) => b.command("create", { projectId, requestId: randomUUID() })),
  );
  assert.equal(results.length, 2);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(new Set(f.calls.map((call) => call.root)), new Set([f.root, subroot]));
  assert.notEqual(f.calls[0].root, f.calls[1].root);
  assert.equal(
    f.calls.some((call) => call.root.endsWith("/src")),
    true,
  );
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("global management stores versioned project environments without starting Core", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  b.start = () => assert.fail("metadata management must not start Core");
  const list = await b.command("workspace", { projectId: f.id, operation: "worktreeList" });
  assert.equal(list.defaultRoot, join(b.userHome, ".areal", "worktrees"));
  assert.equal(list.settings.autoCleanup, false);
  const environment = {
    id: "dev",
    name: "Development",
    setup: { default: "printf setup", macos: " " },
    cleanup: { default: "" },
    actions: [{ id: "check", name: "Check", script: { default: "pwd" } }],
  };
  const saved = await b.command("workspace", {
    projectId: f.id,
    operation: "worktreeEnvironmentSave",
    environment,
    expectedRevision: 0,
  });
  assert.equal(saved.environmentRevision, 1);
  await assert.rejects(
    b.command("workspace", {
      projectId: f.id,
      operation: "worktreeEnvironmentSave",
      environment,
      expectedRevision: 0,
    }),
    /版本|revision/,
  );
  const restarted = await f.backend();
  const restored = await restarted.command("workspace", {
    projectId: f.id,
    operation: "worktreeList",
  });
  assert.deepEqual(restored.projects[0].environments, [environment]);
});

test("explicit source allows multiple conversations without allocating a checkout", async (t) => {
  const f = await setup(t),
    b = await f.backend();
  for (let index = 0; index < 2; index++)
    await b.command("create", {
      projectId: f.id,
      requestId: randomUUID(),
      worktree: { mode: "source" },
    });
  assert.deepEqual(
    f.calls.map((call) => call.root),
    [f.root, f.root],
  );
  assert.equal(b.saved.length, 1);
});

test("cancel before binding retains checkout and never starts a thread", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    requestId = randomUUID();
  const register = b.worktrees.register.bind(b.worktrees);
  let release, reached;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  b.worktrees.register = async (...args) => {
    const result = await register(...args);
    reached();
    await gate;
    return result;
  };
  const creating = b.command("create", {
    projectId: f.id,
    requestId,
    worktree: { mode: "worktree", ref: "main" },
  });
  const rejected = assert.rejects(creating, /取消|cancel/i);
  await waiting;
  const cancelling = b.command("workspace", {
    projectId: f.id,
    operation: "worktreeCancel",
    requestId,
  });
  const deadline = Date.now() + 1000;
  while (b.worktrees.records.get(requestId).intent !== "cancel" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  assert.equal(b.worktrees.records.get(requestId).intent, "cancel");
  await rejected;
  const result = await cancelling;
  assert.equal(result.state, "cancelled");
  assert.ok(result.record.directory);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await b.command("workspace", { projectId: f.id, operation: "worktreeRead", requestId })).state,
    "cancelled",
  );
});

test("ready cancellation reports too late and preserves the existing thread", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    requestId = randomUUID();
  const created = await b.command("create", {
    projectId: f.id,
    requestId,
    worktree: { mode: "worktree", ref: "main" },
  });
  const result = await b.command("workspace", {
    projectId: f.id,
    operation: "worktreeCancel",
    requestId,
  });
  assert.equal(result.state, "ready");
  assert.equal(result.cancelResult, "tooLate");
  assert.equal(result.threadId, created.threadId);
});

test("unknown setup read never dispatches the script again", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    requestId = randomUUID();
  await b.command("create", {
    projectId: f.id,
    requestId,
    worktree: { mode: "worktree", ref: "main" },
  });
  const ready = b.worktrees.records.get(requestId);
  await b.worktrees.persist({
    ...ready,
    state: "settingUp",
    environment: {
      id: "dev",
      name: "Dev",
      setup: { default: "touch unknown-effect" },
      cleanup: { default: "" },
      actions: [],
    },
    setup: {
      requestId: randomUUID(),
      kind: "setup",
      status: "running",
      script: "touch unknown-effect",
    },
  });
  const restarted = await f.backend();
  restarted.readSubmission = async () => ({ confirmed: false });
  restarted.submit = () => assert.fail("unknown process start cannot be repeated");
  const recovered = await restarted.command("workspace", {
    projectId: f.id,
    operation: "worktreeRead",
    requestId,
  });
  assert.equal(recovered.state, "unknown");
  assert.equal(recovered.setup.status, "unknown");
});

test("bound setup thread rejects ordinary writes before environment is ready", async (t) => {
  const f = await setup(t),
    b = await f.backend(),
    requestId = randomUUID();
  const created = await b.command("create", {
    projectId: f.id,
    requestId,
    worktree: { mode: "worktree", ref: "main" },
  });
  const value = b.worktrees.records.get(requestId);
  await b.worktrees.persist({ ...value, state: "settingUp" });
  await assert.rejects(
    b.command("send", { projectId: f.id, threadId: created.threadId, text: "must not run" }),
    /环境|就绪/,
  );
  await assert.rejects(
    b.command("manage", {
      projectId: f.id,
      threadId: created.threadId,
      operation: "processStart",
      requestId: randomUUID(),
      argv: ["/bin/true"],
    }),
    /环境|就绪/,
  );
  await assert.rejects(
    b.command("workspace", {
      projectId: f.id,
      threadId: created.threadId,
      operation: "save",
      path: "shared.txt",
      text: "must not write",
      revision: "current-file-revision",
    }),
    /环境|就绪/,
  );
});
