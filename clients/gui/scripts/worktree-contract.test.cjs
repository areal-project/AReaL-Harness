"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm, realpath, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
const { fileOpen } = require("../app/src/core/file-open.cjs");

test("Worktree configuration is a validated future-creation request", () => {
  assert.equal(commandSemantics("workspace", { operation: "worktreeOptions" }).effect, "read");
  assert.equal(commandSemantics("workspace", { operation: "worktreeSettings" }).effect, "mutation");
  const valid = {
    projectId: "p",
    operation: "worktreeSettings",
    worktreeRoot: "/tmp/areal-trees",
    branchPrefix: "areal",
  };
  assert.doesNotThrow(() => validateCommand("workspace", valid));
  for (const value of [
    { ...valid, branchPrefix: "" },
    { ...valid, worktreeRoot: "bad\npath" },
    { ...valid, expandPermissions: true },
  ])
    assert.throws(() => validateCommand("workspace", value));
  assert.doesNotThrow(() =>
    validateCommand("create", {
      projectId: "p",
      worktree: { sourceRoot: "/repo", ref: "main", branch: "areal/test" },
    }),
  );
  for (const spec of [
    null,
    [],
    { sourceRoot: 42 },
    { branch: "bad\nref" },
    { shell: "touch /tmp/unsafe" },
  ])
    assert.throws(() => validateCommand("create", { projectId: "p", worktree: spec }));
});

test("native file handoff follows selected thread checkout and rejects source/foreign fallback", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-file-worktree-")));
  try {
    const root = join(home, "source"),
      directory = join(home, "tree");
    await mkdir(root);
    await mkdir(directory);
    await writeFile(join(root, "same.txt"), "source");
    await writeFile(join(directory, "same.txt"), "isolated");
    const project = {
      id: "p",
      root,
      state: {
        threads: {
          t: {
            id: "t",
            executionProjectId: "e",
            worktree: { state: "ready", directory },
          },
        },
      },
    };
    const backend = { snapshot: () => ({ library: { settings: {} }, projects: [project] }) };
    const opened = [];
    const dependencies = {
      backend,
      home,
      shell: {
        openPath: async (path) => {
          opened.push(path);
          return "";
        },
      },
      authorize: () => {},
      chooseSave: () => assert.fail("not saving"),
    };
    await fileOpen(dependencies, {
      operation: "open",
      projectId: "p",
      threadId: "t",
      path: "same.txt",
    });
    assert.deepEqual(opened, [join(directory, "same.txt")]);
    await assert.rejects(
      fileOpen(dependencies, {
        operation: "open",
        projectId: "p",
        threadId: "t",
        path: join(root, "same.txt"),
      }),
      /当前工作区/,
    );
    await assert.rejects(
      fileOpen(dependencies, {
        operation: "open",
        projectId: "p",
        threadId: "missing",
        path: "same.txt",
      }),
      /尚未确认/,
    );
    project.state.threads.t.worktree.state = "binding";
    await assert.rejects(
      fileOpen(dependencies, {
        operation: "open",
        projectId: "p",
        threadId: "t",
        path: "same.txt",
      }),
      /绑定尚未确认/,
    );
    assert.equal(opened.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("conversation images are read from the selected thread checkout by content type", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-file-image-")));
  try {
    const root = join(home, "source"),
      directory = join(home, "tree");
    await mkdir(root);
    await mkdir(join(directory, "out"), { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(join(directory, "out", "表1.png"), png);
    await writeFile(join(directory, "out", "fake.png"), "<svg onload=alert(1)>");
    await writeFile(join(home, "outside.png"), png);
    await symlink(join(home, "outside.png"), join(directory, "out", "link.png"));
    const project = {
      id: "p",
      root,
      state: { threads: { t: { id: "t", worktree: { state: "ready", directory } } } },
    };
    const dependencies = {
      backend: { snapshot: () => ({ library: { settings: {} }, projects: [project] }) },
      home,
      shell: { openPath: async () => assert.fail("not opening") },
      authorize: () => {},
      chooseSave: () => assert.fail("not saving"),
    };
    const read = (path) =>
      fileOpen(dependencies, { operation: "readImage", projectId: "p", threadId: "t", path });
    const image = await read("./out/表1.png");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.bytes), png);
    assert.equal((await read(join(directory, "out", "表1.png"))).mimeType, "image/png");
    await assert.rejects(read("out/fake.png"), /不是可直接显示的图片/);
    await assert.rejects(read("../outside.png"), /当前工作区/);
    await assert.rejects(read("out/link.png"), /当前工作区/);
    await assert.rejects(read("out"), /仅支持图片文件/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("browser workspace identity includes the selected thread execution host", () => {
  const { PreviewWorkspace } = require("../app/src/core/preview-native/workspace.cjs");
  const hosts = { a: "core-a", b: "core-b" };
  const pages = [
    { id: "page-a", projectId: "logical", threadId: "a", coreInstanceId: "core-a" },
    { id: "page-b", projectId: "logical", threadId: "b", coreInstanceId: "core-b" },
    { id: "stale", projectId: "logical", threadId: "b", coreInstanceId: "core-a" },
  ];
  const view = new PreviewWorkspace(
    () => true,
    (projectId, threadId) => hosts[threadId],
    () => true,
    () => [],
    async () => {},
  );
  view.unregisterProfileHost();
  view.pages = new Map(pages.map((page) => [page.id, page]));
  assert.deepEqual(
    view.workspacePages("logical", "a").map((page) => page.id),
    ["page-a"],
  );
  assert.deepEqual(
    view.workspacePages("logical", "b").map((page) => page.id),
    ["page-b"],
  );
  hosts.b = "new-core";
  assert.deepEqual(view.workspacePages("logical", "b"), []);
});

test("desktop browser callbacks select physical owner without changing logical identity", () => {
  const { DesktopService } = require("../app/src/core/service-protocol.cjs");
  const physical = { id: "physical", service: { serviceId: "core-isolated" } };
  const backend = {
    projects: new Map([
      ["physical", physical],
      ["logical", { id: "logical" }],
    ]),
    worktrees: {
      executionProjectId: (logical, thread) => {
        assert.equal(logical, "logical");
        assert.equal(thread, "t");
        return "physical";
      },
    },
  };
  assert.equal(
    DesktopService.prototype.projectForThread.call({ backend }, "logical", "t"),
    physical,
  );
});

test("MCP app opening retains logical page identity and physical Core connection", async () => {
  const { DesktopService } = require("../app/src/core/service-protocol.cjs");
  const calls = [];
  const client = {
    ready: true,
    request: async (method, params) => {
      calls.push({ method, params });
      return method.endsWith("/register")
        ? { registrationId: "registration", tools: [] }
        : { revoked: true };
    },
  };
  const project = { id: "physical", logicalProjectId: "logical", client };
  const socket = { readyState: 1 };
  const service = Object.assign(Object.create(DesktopService.prototype), {
    clients: new Set([socket]),
    mcpPageOwners: new Map(),
  });
  service.bindMcpPageOwner(
    socket,
    project,
    client,
    {
      projectId: "physical",
      logicalProjectId: "logical",
      threadId: "t",
      operation: "mcpAppOpen",
    },
    { instanceId: "app", generation: 7 },
  );
  assert.equal(service.mcpPageOwners.has(JSON.stringify(["physical", "app"])), false);
  const lease = service.mcpPageOwners.get(JSON.stringify(["logical", "app"]));
  assert.equal(lease.project, project);
  assert.equal(lease.client, client);
  await service.mcpPageTools(socket, {
    projectId: "logical",
    threadId: "t",
    instanceId: "app",
    generation: 7,
    operation: "register",
    declaration: { version: 1, documentId: "document", tools: ["getSelection"] },
  });
  const result = await service.mcpPageTools(socket, {
    projectId: "logical",
    threadId: "t",
    instanceId: "app",
    generation: 7,
    operation: "revoke",
    registrationId: "registration",
  });
  assert.equal(result.revoked, true);
  assert.equal(calls[0].method, "areal/mcp/app/tools/register");
  assert.equal(calls.at(-1).method, "areal/mcp/app/tools/revoke");
  assert.equal(calls[0].params.threadId, "t");
});
