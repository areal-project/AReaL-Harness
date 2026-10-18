import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

// Only these public workspace entrypoints run in the Core distribution.
// Third-party packages retain their declared dependency and required peer closure.
const forbidden = new Set([
  "electron",
  "dsh-builtin-browser",
  "dsh-ego-browser",
  "@deepseek-ai/dsh-credentials",
  "@areal/harness-runtime-host",
  "@areal/dsh-game-bundle",
]);
function manifestAt(name, parent) {
  const req = createRequire(join(parent, "package.json"));
  const file = req.resolve
    .paths(name)
    ?.map((path) => join(path, name, "package.json"))
    .find(existsSync);
  if (!file) throw new Error(`Missing release dependency ${name} from ${parent}`);
  return file;
}
async function manifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
const json = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
function required(pkg) {
  const result = new Set(Object.keys(pkg.dependencies ?? {}));
  for (const name of Object.keys(pkg.peerDependencies ?? {}))
    if (!pkg.peerDependenciesMeta?.[name]?.optional) result.add(name);
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) result.delete(name);
  return [...result];
}

export async function stageCoreApp({ root, destination }) {
  root = resolve(root);
  destination = resolve(destination);
  assert.ok(!existsSync(destination), "Core stage must be a new directory");
  const desktop = join(root, "app");
  await mkdir(destination, { recursive: true });
  // Small desktop resources stay intact; no global docs/spec/README deletion.
  for (const path of ["src", "assets"])
    await cp(join(desktop, path), join(destination, path), { recursive: true });
  await mkdir(join(destination, "bridge"));
  for (const path of ["filetree.js", "package.json"])
    await cp(join(desktop, "bridge", path), join(destination, "bridge", path));
  await cp(join(root, "../../LICENSE"), join(destination, "LICENSE"));
  await cp(join(desktop, "LICENSE"), join(destination, "CAXSON-LICENSE"));
  await cp(join(root, "renderer/ZCODE-LICENSE"), join(destination, "ZCODE-LICENSE"));
  const sourcePackage = await manifest(join(desktop, "package.json"));
  const app = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    description: sourcePackage.description,
    author: sourcePackage.author,
    license: sourcePackage.license,
    main: "src/main.cjs",
    packageManager: "npm@10.8.2",
    dependencies: {},
  };
  await json(join(destination, "package.json"), app);
  const placed = new Map(),
    report = [];
  async function install(name, sourceParent, targetParent) {
    assert.ok(!forbidden.has(name), `Legacy dependency entered Core release: ${name}`);
    const source = dirname(await realpath(manifestAt(name, sourceParent)));
    const pkg = await manifest(join(source, "package.json"));
    const top = join(destination, "node_modules", name);
    const target =
      !placed.has(top) || placed.get(top) === source
        ? top
        : join(targetParent, "node_modules", name);
    if (placed.has(target)) {
      assert.equal(placed.get(target), source, `Conflicting dependency ${name}`);
      return pkg.version;
    }
    placed.set(target, source);
    await mkdir(target, { recursive: true });
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const rel = relative(source, path);
        return (
          !rel
            .split("/")
            .some((part) =>
              [
                "node_modules",
                ".git",
                ".github",
                "test",
                "tests",
                "__tests__",
                "examples",
              ].includes(part),
            ) && !/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(rel)
        );
      },
    });
    const deps = required(pkg);
    const optional = Object.keys(pkg.optionalDependencies ?? {}).filter((dep) => {
      try {
        manifestAt(dep, source);
        return true;
      } catch {
        return false;
      }
    });
    const staged = { ...pkg };
    // Record the resolved runtime closure; dev/peer hooks must not pull legacy
    // packages back in when electron-builder walks this isolated app directory.
    delete staged.devDependencies;
    delete staged.peerDependencies;
    delete staged.peerDependenciesMeta;
    delete staged.optionalDependencies;
    delete staged.scripts;
    staged.dependencies = {};
    for (const dep of [...new Set([...deps, ...optional])])
      staged.dependencies[dep] = await install(dep, source, target);
    await json(join(target, "package.json"), staged);
    report.push({
      name,
      version: pkg.version,
      path: relative(destination, target),
      sourceManifestSha256: createHash("sha256")
        .update(await readFile(join(source, "package.json")))
        .digest("hex"),
    });
    return pkg.version;
  }
  for (const name of Object.keys(sourcePackage.dependencies))
    app.dependencies[name] = await install(name, desktop, destination);
  await json(join(destination, "package.json"), app);
  await cp(join(root, "licenses"), join(destination, "licenses"), { recursive: true });
  await cp(join(root, "THIRD-PARTY-NOTICES.md"), join(destination, "THIRD-PARTY-NOTICES.md"));
  await verifyCoreApp(destination);
  return report.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifyCoreApp(appRoot) {
  appRoot = await realpath(appRoot);
  const visited = new Set();
  async function visit(path) {
    path = await realpath(path);
    assert.ok(path.startsWith(appRoot + "/"), `Dependency escapes package: ${path}`);
    if (visited.has(path)) return;
    visited.add(path);
    const pkg = await manifest(path);
    assert.ok(!forbidden.has(pkg.name), `Unexpected package ${pkg.name}`);
    for (const dep of required(pkg)) {
      const child = manifestAt(dep, dirname(path));
      const version = (await manifest(child)).version;
      assert.equal(
        version,
        pkg.dependencies[dep],
        `Resolved wrong version of ${dep} from ${pkg.name}`,
      );
      await visit(child);
    }
  }
  await visit(join(appRoot, "package.json"));
  assert.ok(existsSync(join(appRoot, "bridge/filetree.js")), "Missing workspace file listing");
  assert.ok(
    existsSync(join(appRoot, "node_modules/@areal/chatgpt-provider/oauth-worker.js")),
    "Missing OAuth worker",
  );
  async function inspectModules(dir) {
    if (!existsSync(dir)) return;
    for (const item of await readdir(dir)) {
      const child = join(dir, item);
      if (item.startsWith("@")) {
        await inspectModules(child);
        continue;
      }
      if (item.startsWith(".")) continue;
      const file = join(child, "package.json");
      assert.ok(
        existsSync(file) && visited.has(await realpath(file)),
        `Untracked dependency in Core distribution: ${child}`,
      );
      await inspectModules(join(child, "node_modules"));
    }
  }
  await inspectModules(join(appRoot, "node_modules"));
  return visited.size;
}
