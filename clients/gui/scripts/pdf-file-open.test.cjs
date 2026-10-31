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
