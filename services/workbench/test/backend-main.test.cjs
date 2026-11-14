const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { mkdtemp, mkdir, readFile, realpath, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

async function fixture(t, retired, projectionFixture = false) {
  const root = await mkdtemp(join(tmpdir(), "workbench-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "app"),
    home = join(root, "data");
  await mkdir(join(appRoot, "node_modules/@areal/workbench-service/src/desktop/core"), {
    recursive: true,
  });
  await mkdir(home);
  await writeFile(join(appRoot, "package.json"), "{}");
  await writeFile(
    join(appRoot, "node_modules/@areal/workbench-service/package.json"),
    JSON.stringify({ exports: { "./desktop/*": "./src/desktop/*" } }),
  );
  // 夹具只替代业务装配，进程、Host 管道和元数据生命周期使用实际入口。
  await writeFile(
    join(appRoot, "node_modules/@areal/workbench-service/src/desktop/core/service-main.cjs"),
    `
    const fs = require('node:fs/promises');
    exports.createMainDesktop = async (options, lifetime) => {
      if (typeof lifetime.hostCall !== "function") throw Error("Host ownership must precede backend initialization");
      if (options.sourceSingletonHeld !== false || options.applicationOwner) throw Error('wrong owner');
      const backend = { home: options.home, hostCall: lifetime.hostCall, host: { sourceId: 'fixture-source' }, cloud: {}, useHostLibrary: async () => {}, addProject: async (path) => 'project:' + path };
      if (options.retired === 'catalog') {
        const accepted = { acceptedAt: 2, model: { providerId: 'p', modelId: 'm' }, modelId: 'm', reasoningEffort: 'xhigh' };
        backend.starting = new Map();
        backend.projects = new Map([['p', { client: { request: async () => ({ data: [], lastAcceptedModel: accepted }) }, profiles: [] }]]);
        backend.providers = { lastAcceptedModel: null, settled: async () => {}, manages: () => true, catalog: () => [], acceptModelSelection: async (value) => { backend.providers.lastAcceptedModel = value; } };
      }
      if (options.projectionFixture) {
        const { CoreWorktrees } = require(${JSON.stringify(require.resolve("../src/desktop/core/worktrees.cjs"))});
        backend.worktrees = new CoreWorktrees(backend);
        backend.onChange = () => process.stdout.write(JSON.stringify({ event: 'projection', records: [...backend.worktrees.records.values()] }) + '\\n');
      }
      return { backend, adapter: { listen: async () => ({
        pid: process.pid, identity: 'fixture', desktopGeneration: 'generation', token: 'private-token'
      }), executeRemote: async (name, params) => {
        if (params.coreFailure) throw Object.assign(Error('PROFILE_NOT_SUPPORTED'), params.coreFailure);
        if (params.errorCode) throw Object.assign(Error('private'), { code: params.errorCode, submissionUnknown: params.unknown });
        if (params.fail) throw Error('Core refused: ' + name);
        return { executed: name, params };
      } }, close: () => fs.writeFile(options.home + '/closed', 'closed') };
    };
  `,
  );
  await mkdir(join(appRoot, "node_modules/@areal/workbench"), { recursive: true });
  await writeFile(
    join(appRoot, "node_modules/@areal/workbench/package.json"),
    JSON.stringify({
      exports: {
        "./desktop-contract": "./contract.cjs",
        "./desktop-contract/shared": "./shared.cjs",
        "./desktop-contract/provider": "./provider.cjs",
      },
    }),
  );
  await writeFile(
    join(appRoot, "node_modules/@areal/workbench/contract.cjs"),
    `
    Object.assign(exports, require(${JSON.stringify(require.resolve("../../../clients/gui/packages/workbench/client/desktop-contract.cjs"))}));
    exports.validateCommand = (name, params) => { if (params.invalid) throw Error('Invalid ' + name + ' request'); };
    exports.validateCommandResponse = () => {};
  `,
  );
  for (const name of ["shared", "provider"]) {
    await writeFile(
      join(appRoot, `node_modules/@areal/workbench/${name}.cjs`),
      `module.exports = require(${JSON.stringify(require.resolve(`../../../clients/gui/packages/workbench/client/desktop-contract/${name}.cjs`))});`,
    );
  }
  const child = spawn(process.execPath, [join(__dirname, "../src/backend-main.cjs")], {
    env: { PATH: process.env.PATH, HOME: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  return {
    home,
    child,
    lines,
    exited,
    line: () =>
      Promise.race([
        once(lines, "line"),
        exited.then(([code, signal]) => {
          throw new Error(`Backend exited before reply (${code}, ${signal}): ${stderr}`);
        }),
      ]),
    start: () =>
      child.stdin.write(
        JSON.stringify({
          version: 1,
          method: "backend.start",
          params: { appRoot, options: { home, projectionFixture, retired }, retired },
        }) + "\n",
      ),
  };
}

test("creation catalog publishes the latest Core accepted model", async (t) => {
  const f = await fixture(t, "catalog");
  const ready = f.line();
  f.start();
  await ready;
  const reply = f.line();
  f.child.stdin.write(
    JSON.stringify({
      version: 1,
      id: "catalog",
      method: "creation.catalog",
      params: { projectId: "p" },
    }) + "\n",
  );
  const frame = JSON.parse((await reply)[0]);
  assert.ok(frame.result, JSON.stringify(frame));
  assert.equal(frame.result.lastAcceptedModel.modelId, "m");
  assert.equal(frame.result.lastAcceptedModel.reasoningEffort, "xhigh");
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
});

test("后台发布身份但不泄露票据，Host EOF 等待关闭并清理本代元数据", async (t) => {
  const f = await fixture(t);
  const ready = f.line();
  f.start();
  const [line] = await ready;
  const frame = JSON.parse(line);
  assert.equal(frame.service.pid, f.child.pid);
  assert.equal(frame.event, "ready");
  assert.ok(!line.includes("private-token"));
  assert.equal(JSON.parse(await readFile(join(f.home, "service.json"))).pid, f.child.pid);
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
  assert.equal(await readFile(join(f.home, "closed"), "utf8"), "closed");
  await assert.rejects(readFile(join(f.home, "service.json")), { code: "ENOENT" });
});

test("后台拒绝覆盖未由 Host 确认退役的服务", async (t) => {
  const f = await fixture(t);
  const existing = JSON.stringify({
    pid: 19,
    identity: "old",
    desktopGeneration: "old-generation",
  });
  await writeFile(join(f.home, "service.json"), existing);
  f.start();
  assert.deepEqual(await f.exited, [1, null]);
  assert.equal(await readFile(join(f.home, "service.json"), "utf8"), existing);
});

test("只清理 Host 确认已退出的同一后台代际", async (t) => {
  const retired = { pid: 19, identity: "old", desktopGeneration: "old-generation" };
  const f = await fixture(t, retired);
  await writeFile(join(f.home, "service.json"), JSON.stringify(retired));
  const ready = f.line();
  f.start();
  await ready;
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
});

test("本机网页的桌面命令只放行命令表内、合同通过的请求，并带回失败原因", async (t) => {
  const f = await fixture(t);
  const ready = f.line();
  f.start();
  await ready;
  const call = async (id, params) => {
    const answer = f.line();
    f.child.stdin.write(
      JSON.stringify({ version: 1, id, method: "desktop.command", params }) + "\n",
    );
    return JSON.parse((await answer)[0]);
  };
  assert.deepEqual((await call("ok", { command: "list", request: { projectId: "p" } })).result, {
    executed: "list",
    params: { projectId: "p" },
  });
  assert.equal(
    (await call("add", { command: "addProject", request: { path: f.home } })).result,
    "project:" + (await realpath(f.home)),
  );
  for (const [id, params, message] of [
    ["unknown", { command: "quit", request: {} }, "Invalid desktop command"],
    ["array", { command: "list", request: [] }, "Invalid desktop command"],
    ["picker", { command: "manage", request: { operation: "pluginArchivePick" } }, "Desktop only"],
    ["contract", { command: "list", request: { invalid: true } }, "Invalid list request"],
    ["core", { command: "list", request: { fail: true } }, "Core refused: list"],
    [
      "relative",
      { command: "addProject", request: { path: "demo" } },
      "请填写项目文件夹的完整路径",
    ],
    [
      "missing",
      { command: "addProject", request: { path: "/nonexistent-areal-project" } },
      "找不到这个文件夹",
    ],
  ])
    assert.deepEqual((await call(id, params)).error, { code: "COMMAND_FAILED", message }, id);
  for (const code of [
    "MIGRATION_PENDING",
    "migrationBlocked",
    "PROVIDER_CREDENTIAL_REQUIRED",
    "PROFILE_NOT_SUPPORTED",
  ]) {
    assert.deepEqual((await call(code, { command: "list", request: { errorCode: code } })).error, {
      code,
    });
    assert.deepEqual(
      (
        await call(code + "-unknown", {
          command: "list",
          request: { errorCode: code, unknown: true },
        })
      ).error,
      { code: "SUBMISSION_UNKNOWN" },
    );
  }
  const rejected = {
    code: -32010,
    reason: "PROFILE_NOT_SUPPORTED",
    data: { reason: "PROFILE_NOT_SUPPORTED", outcome: { kind: "rejected" } },
    outcome: { kind: "rejected" },
  };
  assert.deepEqual(
    (await call("profile-rejected", { command: "fork", request: { coreFailure: rejected } })).error,
    { code: "PROFILE_NOT_SUPPORTED" },
  );
  for (const [id, failure] of [
    ["unknown", { ...rejected, submissionUnknown: true }],
    ["unconfirmed", { ...rejected, outcome: { kind: "unconfirmed" } }],
  ])
    assert.deepEqual(
      (await call(`profile-${id}`, { command: "fork", request: { coreFailure: failure } })).error,
      { code: "SUBMISSION_UNKNOWN" },
    );
  assert.deepEqual(
    (
      await call("profile-without-outcome", {
        command: "fork",
        request: { coreFailure: { code: -32010, reason: "PROFILE_NOT_SUPPORTED" } },
      })
    ).error,
    { code: "COMMAND_FAILED", message: "PROFILE_NOT_SUPPORTED" },
  );
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
});

test("Host Worktree invalidation refreshes persisted progress and rejects another source", async (t) => {
  const f = await fixture(t, undefined, true);
  const ready = f.line();
  f.start();
  await ready;
  const requestId = require("node:crypto").randomUUID();
  await mkdir(join(f.home, "worktree-requests"));
  const record = {
    kind: "thread",
    requestId,
    projectId: "logical",
    parameters: {},
    state: "settingUp",
    recordRevision: 7,
    threadId: "original-thread",
  };
  await writeFile(join(f.home, "worktree-requests", requestId + ".json"), JSON.stringify(record));
  const projected = f.line();
  f.child.stdin.write(
    JSON.stringify({ version: 1, event: "worktree.changed", sourceId: "fixture-source" }) + "\n",
  );
  assert.deepEqual(JSON.parse((await projected)[0]), { event: "projection", records: [record] });
  f.child.stdin.write(
    JSON.stringify({ version: 1, event: "worktree.changed", sourceId: "another-source" }) + "\n",
  );
  assert.deepEqual(await f.exited, [1, null]);
});

test("恢复目录查询只接受空间身份并经 Host 读取，不传入任意来源路径", async (t) => {
  const f = await fixture(t);
  const ready = f.line();
  f.start();
  await ready;
  const reply = f.line();
  f.child.stdin.write(
    JSON.stringify({
      version: 1,
      id: "inspect",
      method: "desktop.command",
      params: { command: "recovery", request: { operation: "inspect" } },
    }) + "\n",
  );
  const frame = JSON.parse((await reply)[0]);
  assert.equal(frame.call, "recovery.inspect");
  assert.deepEqual(frame.params, {});
  const answer = f.line();
  f.child.stdin.write(
    JSON.stringify({
      version: 1,
      id: frame.id,
      result: { tasks: "notImported", projects: [], providers: [] },
    }) + "\n",
  );
  assert.deepEqual(JSON.parse((await answer)[0]).result, {
    tasks: "notImported",
    projects: [],
    providers: [],
  });
  const rejected = f.line();
  f.child.stdin.write(
    JSON.stringify({
      version: 1,
      id: "invalid",
      method: "desktop.command",
      params: {
        command: "recovery",
        request: { operation: "inspect", spaceId: "space-id", sourceProfile: "/arbitrary" },
      },
    }) + "\n",
  );
  assert.equal(JSON.parse((await rejected)[0]).error.code, "INVALID_PARAMS");
  f.child.stdin.end();
  await f.exited;
});

test("恢复工作区只登记 Host 清单的目录，不接受调用者路径", async (t) => {
  const f = await fixture(t);
  const ready = f.line();
  f.start();
  await ready;
  const reversed = f.line();
  f.child.stdin.write(
    JSON.stringify({
      version: 1,
      id: "open-space",
      method: "desktop.command",
      params: { command: "recovery", request: { operation: "openWorkspace" } },
    }) + "\n",
  );
  const frame = JSON.parse((await reversed)[0]);
  assert.equal(frame.call, "recovery.inspect");
  assert.deepEqual(frame.params, {});
  const reply = f.line();
  f.child.stdin.write(
    JSON.stringify({ version: 1, id: frame.id, result: { workspace: "/verified-new-space" } }) +
      "\n",
  );
  assert.deepEqual(JSON.parse((await reply)[0]).result, {
    projectId: "project:/verified-new-space",
  });
  const rejected = f.line();
  f.child.stdin.write(
    JSON.stringify({
      version: 1,
      id: "bad-open",
      method: "desktop.command",
      params: { command: "recovery", request: { operation: "openWorkspace", path: "/old-space" } },
    }) + "\n",
  );
  assert.equal(JSON.parse((await rejected)[0]).error.code, "INVALID_PARAMS");
  f.child.stdin.end();
  await f.exited;
});

test("Workbench and Host error classifications stay in sync", async () => {
  const { businessErrorCodes, mapBackendError } = require("../src/backend-main.cjs");
  const source = await readFile(
    join(__dirname, "../../../core/host/src/gateway/session.rs"),
    "utf8",
  );
  const section = source.match(
    /pub\(crate\) fn error_code\(message: &str\) -> &str \{([\s\S]*?)\n\}/,
  );
  assert.ok(section, "Host error classification must remain inspectable");
  const host = [...section[1].matchAll(/"([A-Za-z0-9_]+)"\s*(?:\||=>)/g)].map((match) => match[1]);
  const fallbackAtHost = ["CORE_UNAVAILABLE", "RESOURCE_BUSY", "PERSISTED_HISTORY_UNAVAILABLE"];
  assert.deepEqual(
    [...businessErrorCodes].filter((code) => !fallbackAtHost.includes(code)).sort(),
    host.sort(),
  );
  for (const code of businessErrorCodes)
    assert.deepEqual(mapBackendError({ code }, false), { code });
  for (const kind of ["admitted", "unconfirmed"]) {
    assert.deepEqual(
      mapBackendError({ code: "PROVIDER_CREDENTIAL_REQUIRED", outcome: { kind } }, false),
      { code: "SUBMISSION_UNKNOWN" },
    );
  }
  for (const kind of ["rejected", "noMutation"]) {
    assert.deepEqual(
      mapBackendError({ code: -32010, reason: "PROFILE_NOT_SUPPORTED", outcome: { kind } }, false),
      { code: "PROFILE_NOT_SUPPORTED" },
    );
    assert.deepEqual(mapBackendError({ code: -32009, outcome: { kind } }, false), {
      code: "TARGET_CHANGED",
    });
  }
  assert.deepEqual(mapBackendError({ code: -32009 }, false), { code: "CORE_UNAVAILABLE" });
  assert.deepEqual(mapBackendError({ code: "NEW_INTERNAL", message: "private detail" }, false), {
    code: "CORE_UNAVAILABLE",
  });
});
