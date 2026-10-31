"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm, realpath, symlink, truncate } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { fileOpen } = require("../app/src/core/file-open.cjs");

test("PDF bytes follow the selected worktree and reject invalid, oversized, and escaping files", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-pdf-files-")));
  try {
    const root = join(home, "source");
    const directory = join(home, "tree");
    await mkdir(root);
    await mkdir(directory);
    const pdf = Buffer.from("%PDF-1.4\nfixture bytes\n%%EOF\n");
    await writeFile(join(root, "same.pdf"), "%PDF-1.4 source");
    await writeFile(join(directory, "same.pdf"), pdf);
    await writeFile(join(directory, "fake.pdf"), "<script>invalid</script>");
    await writeFile(join(directory, "large.pdf"), "%PDF-1.4");
    await truncate(join(directory, "large.pdf"), 20 * 1024 * 1024 + 1);
    await writeFile(join(home, "outside.pdf"), pdf);
    await symlink(join(home, "outside.pdf"), join(directory, "link.pdf"));
    const thread = { id: "t", worktree: { state: "ready", directory } };
    const dependencies = {
      backend: {
        snapshot: () => ({
          library: { settings: {} },
          projects: [{ id: "p", root, state: { threads: { t: thread } } }],
        }),
      },
      home,
      shell: { openPath: () => assert.fail("reads never open applications") },
      authorize: () => assert.fail("reads never require an external write"),
      chooseSave: () => assert.fail("reads never save"),
    };
    const read = (path) =>
      fileOpen(dependencies, { operation: "readPdf", projectId: "p", threadId: "t", path });
    assert.deepEqual(Buffer.from((await read("same.pdf")).bytes), pdf);
    assert.equal((await read("same.pdf")).mimeType, "application/pdf");
    await assert.rejects(read("fake.pdf"), /不是有效的 PDF/);
    await assert.rejects(read("large.pdf"), /超过 20 MB/);
    await assert.rejects(read("link.pdf"), /当前工作区/);
    await assert.rejects(read("../outside.pdf"), /当前工作区/);
    await assert.rejects(read("."), /仅支持 PDF/);
    thread.worktree.directory = root;
    assert.equal(Buffer.from((await read("same.pdf")).bytes).toString(), "%PDF-1.4 source");
    thread.cloud = { workspace: "remote" };
    await assert.rejects(read("same.pdf"), /云端 PDF/);
    delete thread.cloud;
    thread.worktree.state = "binding";
    await assert.rejects(read("same.pdf"), /绑定尚未确认/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("HTML documents outside the workspace open with the system handler and a local thread owner", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-html-files-")));
  try {
    const root = join(home, "source");
    const directory = join(home, "tree");
    await mkdir(root);
    await mkdir(directory);
    const outside = join(home, "中文 %20#L12?.html");
    await writeFile(outside, "<!doctype html><title>interactive document</title>");
    await writeFile(join(directory, "local.HTM"), "<!doctype html>");
    await writeFile(join(home, "script.command"), "echo unsafe");
    await symlink(join(home, "script.command"), join(directory, "alias.html"));
    await symlink(outside, join(directory, "alias.txt"));
    await mkdir(join(directory, "directory.html"));
    const thread = { id: "t", worktree: { state: "ready", directory } };
    const opened = [];
    let authorized = 0;
    let handoffError = "";
    const dependencies = {
      backend: {
        snapshot: () => ({
          library: { settings: { fileOpenTarget: "finder" } },
          projects: [{ id: "p", root, state: { threads: { t: thread } } }],
        }),
      },
      home,
      shell: {
        openPath: async (path) => {
          opened.push(path);
          return handoffError;
        },
        showItemInFolder: () => assert.fail("HTML uses the system document handler"),
      },
      authorize: () => {
        authorized += 1;
      },
      chooseSave: () => assert.fail("opening HTML never saves"),
    };
    const request = { operation: "openHtml", projectId: "p", threadId: "t", path: outside };
    await fileOpen(dependencies, request);
    await fileOpen(dependencies, { ...request, path: "local.HTM" });
    assert.deepEqual(opened, [outside, join(directory, "local.HTM")]);
    assert.equal(authorized, 2);
    await assert.rejects(fileOpen(dependencies, { ...request, operation: "open" }), /当前工作区/);
    for (const path of ["alias.html", "alias.txt", "directory.html", "missing.html"])
      await assert.rejects(fileOpen(dependencies, { ...request, path }));
    for (const path of [
      "//server/page.html",
      "\\\\server/page.html",
      "/\\server/page.html",
      "\\/server/page.html",
    ])
      await assert.rejects(fileOpen(dependencies, { ...request, path }), /无效文件打开请求/);
    await assert.rejects(fileOpen(dependencies, { ...request, threadId: undefined }));
    await assert.rejects(fileOpen(dependencies, { ...request, threadId: "unknown" }));
    thread.cloud = { workspace: "remote" };
    await assert.rejects(fileOpen(dependencies, request), /云端|本地/);
    delete thread.cloud;
    thread.worktree.state = "binding";
    await assert.rejects(fileOpen(dependencies, request), /绑定尚未确认/);
    thread.worktree.state = "ready";
    handoffError = "system document handler failed";
    await assert.rejects(fileOpen(dependencies, request), /system document handler failed/);
    dependencies.authorize = () => {
      throw new Error("sender no longer authorized");
    };
    await assert.rejects(fileOpen(dependencies, request), /sender no longer authorized/);
    assert.equal(opened.length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
