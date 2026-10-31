"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { stat } = require("node:fs/promises");
const { join, resolve } = require("node:path");

// 从实际打包消费者解析依赖，防止根目录提升掩盖旧版调用接口。
const appRequire = createRequire(resolve(__dirname, "../app/package.json"));
const electronBuilderRequire = createRequire(appRequire.resolve("electron-builder"));
const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib"));
const asar = builderRequire("@electron/asar");
const asarRequire = createRequire(builderRequire.resolve("@electron/asar"));
const universalRequire = createRequire(builderRequire.resolve("@electron/universal"));
const dirCompare = universalRequire("dir-compare");
const ejsRequire = createRequire(builderRequire.resolve("ejs"));
const jakeRequire = createRequire(ejsRequire.resolve("jake"));
const { FileList } = jakeRequire("filelist");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "areal-packaging-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  for (const [name, content] of Object.entries({
    "index.js": "module.exports = 42;\n",
    ".settings.json": "{}\n",
    "assets/image.txt": "image\n",
    "native/addon.node": "native fixture\n",
    "cache/ignored.txt": "cache\n",
  })) {
    const path = join(source, name);
    await mkdir(require("node:path").dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { root, source };
}

test(
  "asar preserves archive contents and unpack file/directory matching",
  { timeout: 15000 },
  async (t) => {
    const { root, source } = await fixture(t);
    for (const options of [{}, { unpack: "*.node" }, { unpackDir: "**/assets" }]) {
      const archive = join(root, `fixture-${Object.keys(options).join() || "packed"}.asar`);
      await asar.createPackageWithOptions(source, archive, options);
      for (const name of ["index.js", ".settings.json", "assets/image.txt", "native/addon.node"]) {
        assert.deepEqual(asar.extractFile(archive, name), await readFile(join(source, name)));
      }
      assert.equal(
        Boolean(asar.statFile(archive, "native/addon.node").unpacked),
        Boolean(options.unpack),
      );
      assert.equal(
        Boolean(asar.statFile(archive, "assets/image.txt").unpacked),
        Boolean(options.unpackDir),
      );
      const destination = join(root, `extract-${Object.keys(options).join() || "packed"}`);
      asar.extractAll(archive, destination);
      const result = await dirCompare.compare(source, destination, { compareContent: true });
      assert.equal(result.same, true);
    }
  },
);

test("dir-compare keeps include/exclude, comma patterns and dotfile matching", async (t) => {
  const { root, source } = await fixture(t);
  const copy = join(root, "copy");
  await require("node:fs/promises").cp(source, copy, { recursive: true });
  await writeFile(join(copy, "cache/ignored.txt"), "different");
  const compare = (options) =>
    dirCompare.compare(source, copy, { compareContent: true, ...options });
  assert.equal((await compare({})).same, false);
  assert.equal((await compare({ excludeFilter: "ignored.txt" })).same, true);
  assert.equal((await compare({ includeFilter: "*.js,*.json" })).same, true);
  await writeFile(join(copy, ".settings.json"), "changed");
  assert.equal((await compare({ includeFilter: "*.json" })).same, false);
});

test("builder, universal and filelist retain their minimatch APIs", async (t) => {
  const { source } = await fixture(t);
  const { FileMatcher } = builderRequire("./fileMatcher");
  const filter = new FileMatcher(source, source, (value) => value, [
    "**/*",
    "!cache/**",
  ]).createFilter();
  assert.equal(
    filter(join(source, ".settings.json"), await stat(join(source, ".settings.json"))),
    true,
  );
  assert.equal(
    filter(join(source, "cache/ignored.txt"), await stat(join(source, "cache/ignored.txt"))),
    false,
  );
  const { Minimatch } = builderRequire("minimatch");
  assert.equal(new Minimatch("**/*.node", { dot: true }).match("native/addon.node"), true);
  assert.equal(
    universalRequire("minimatch").minimatch("native/addon.node", "*.node", { matchBase: true }),
    true,
  );
  const list = new FileList(join(source, "**/*.txt"));
  assert.deepEqual(
    list.toArray().sort(),
    [join(source, "assets/image.txt"), join(source, "cache/ignored.txt")].sort(),
  );
  assert.deepEqual((await asarRequire("glob").glob("**/*.node", { cwd: source })).sort(), [
    "native/addon.node",
  ]);
});

test("Capacitor rimraf retains recursive removal through its glob dependency", async (t) => {
  const { root, source } = await fixture(t);
  const mobileRequire = createRequire(resolve(__dirname, "../../mobile/package.json"));
  const capacitorRequire = createRequire(mobileRequire.resolve("@capacitor/cli/package.json"));
  const { rimraf } = capacitorRequire("rimraf");
  await rimraf(join(source, "cache", "*.txt"), { glob: true });
  await assert.rejects(readFile(join(source, "cache/ignored.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(source, "index.js"), "utf8"), "module.exports = 42;\n");
  await rimraf(root);
});
