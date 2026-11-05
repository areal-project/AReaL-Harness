"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { CoreLibrary } = require("../app/src/core/library.cjs");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** 与 Host library.write 同样按文件内容摘要比较后替换。 */
function hostStore(path, calls) {
  return {
    async write(value, expectedDigest) {
      calls.push(expectedDigest);
      const current = await readFile(path).then(sha, () => null);
      if (current !== expectedDigest)
        throw Object.assign(new Error("changed"), { code: "conflict" });
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(path, bytes);
      return sha(bytes);
    },
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "areal-library-store-"));
  const saves = [];
  const backend = {
    home,
    saved: [{ id: "p" }, { id: "q" }],
    projects: new Map(),
    save: async (name, value) => saves.push([name, value]),
    onChange: () => {},
  };
  const library = new CoreLibrary(backend);
  await library.init();
  return { home, library, saves, path: join(home, "library.json") };
}

test("Host store writes by digest and recomputes on a concurrent change", async () => {
  const { library, saves, path } = await fixture();
  const calls = [];
  await library.useStore(hostStore(path, calls));
  await library.command({ operation: "renameProject", projectId: "p", title: "One" });
  assert.equal(calls[0], null);
  // 另一个客户端经 Host 改了文件：下一次写摘要对不上，重读后在新内容上重算，两边的改动都保留。
  const other = JSON.parse(await readFile(path, "utf8"));
  other.projects.q = { title: "Other" };
  await writeFile(path, JSON.stringify(other));
  await library.command({ operation: "pinProject", projectId: "p", pinned: true });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.projects.p, { title: "One", pinned: true });
  assert.deepEqual(saved.projects.q, { title: "Other" });
  assert.equal(library.digest, sha(await readFile(path)));
  assert.equal(saves.length, 0);
});

test("without a Host navigation source the desktop keeps writing itself", async () => {
  const { library, saves } = await fixture();
  await library.useStore({
    write: async () => {
      throw Object.assign(new Error("no source"), { code: "notFound" });
    },
  });
  await library.command({ operation: "renameProject", projectId: "p", title: "One" });
  assert.equal(saves.length, 1);
  assert.equal(library.store, null);
});
