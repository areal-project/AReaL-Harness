#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkDmgSize } from "./dmg-size.mjs";

const require = createRequire(import.meta.url);
const { serviceName } = require("../app/src/core/desktop-executables.cjs");
const frameworkRelative = "Contents/Frameworks/Electron Framework.framework";
const serviceRelative = `Contents/Frameworks/${serviceName}.app/${frameworkRelative}`;
const envelope = "Versions/A/_CodeSignature/CodeResources";

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${basename(bin)} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function localDirectory(app, rel) {
  let path = app;
  for (const component of rel.split("/")) {
    path = join(path, component);
    assert.ok(
      (await lstat(path)).isDirectory(),
      `Framework ancestor must be a local directory: ${path}`,
    );
  }
  return path;
}

async function frameworkTree(base) {
  await localDirectory(base, "Versions/A");
  const entries = new Map();
  async function scan(path, rel) {
    const info = await lstat(path);
    const mode = info.mode & 0o7777;
    if (info.isDirectory()) {
      entries.set(rel, { type: "directory", mode });
      for (const name of (await readdir(path)).sort())
        await scan(join(path, name), rel ? `${rel}/${name}` : name);
    } else if (info.isSymbolicLink()) {
      const target = await readlink(path);
      assert.ok(
        !isAbsolute(target) &&
          inside(base, resolve(dirname(path), target)) &&
          inside(base, await realpath(path)),
        `Framework symlink escapes its local framework: ${path}`,
      );
      entries.set(rel, { type: "symlink", mode, target });
    } else {
      assert.ok(
        info.isFile() && rel.startsWith("Versions/A/"),
        `Unsupported framework leaf: ${path}`,
      );
      entries.set(rel, {
        type: "file",
        mode,
        file: {
          path,
          device: info.dev,
          inode: info.ino,
          mode,
          bytes: info.size,
          modified: info.mtimeMs,
          sha256: await hash(path),
        },
      });
    }
  }
  await scan(base, "");
  assert.deepEqual(
    (await readdir(join(base, "Versions"))).sort(),
    ["A", "Current"],
    "Unsupported framework version layout",
  );
  assert.ok(
    (await lstat(join(base, "Versions/A"))).isDirectory(),
    "Framework version must be a local directory",
  );
  assert.equal(
    await readlink(join(base, "Versions/Current")),
    "A",
    "Framework Current alias must remain local",
  );
  return entries;
}

function signingPolicy(path) {
  run("/usr/bin/codesign", ["--verify", "--strict", path]);
  const detail = run("/usr/bin/codesign", ["--display", "--verbose=4", path]).stderr;
  const field = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(detail)?.[1];
  const flags = /^CodeDirectory .* flags=(\S+)/m.exec(detail)?.[1];
  assert.ok(
    field("Identifier") && field("TeamIdentifier") && flags,
    `Unsupported signature metadata: ${path}`,
  );
  return {
    identifier: field("Identifier"),
    team: field("TeamIdentifier"),
    flags,
    authorities: [...detail.matchAll(/^Authority=(.*)$/gm)].map((entry) => entry[1]),
    runtime: field("Runtime Version"),
    hashes: /^Hash choices=(.*)$/m.exec(detail)?.[1],
    requirements: run("/usr/bin/codesign", ["--display", "--requirements", "-", path])
      .stdout.split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .join("\n"),
    entitlements: run("/usr/bin/codesign", ["--display", "--entitlements", "-", path]).stdout,
  };
}

async function provePayload(pair, scratch) {
  if (pair.outer.sha256 === pair.service.sha256) return;
  assert.deepEqual(
    signingPolicy(pair.outer.path),
    signingPolicy(pair.service.path),
    `Framework signing policy differs: ${pair.relative}`,
  );
  const copies = [join(scratch, "outer"), join(scratch, "service")];
  try {
    for (const [index, source] of [pair.outer.path, pair.service.path].entries()) {
      await copyFile(source, copies[index]);
      run("/usr/bin/codesign", ["--remove-signature", copies[index]]);
    }
    assert.equal(
      await hash(copies[0]),
      await hash(copies[1]),
      `Framework payload is not equivalent: ${pair.relative}`,
    );
  } finally {
    for (const path of copies) await rm(path, { force: true });
  }
}

async function planFramework(app, scratch, verifySignatures = true) {
  const outer = await localDirectory(app, frameworkRelative);
  const service = await localDirectory(app, serviceRelative);
  const trees = [await frameworkTree(outer), await frameworkTree(service)];
  assert.deepEqual([...trees[0].keys()], [...trees[1].keys()], "Framework layout differs");
  if (verifySignatures)
    assert.deepEqual(
      signingPolicy(outer),
      signingPolicy(service),
      "Framework signing policy differs",
    );
  const pairs = [];
  for (const [rel, entry] of trees[0]) {
    const other = trees[1].get(rel);
    assert.equal(entry.type, other.type, `Framework layout type differs: ${rel}`);
    assert.equal(entry.mode, other.mode, `Framework permissions differ: ${rel}`);
    if (entry.type === "symlink")
      assert.equal(entry.target, other.target, `Framework symlink differs: ${rel}`);
    if (entry.type === "file") {
      const pair = { relative: rel, outer: entry.file, service: other.file };
      if (!verifySignatures)
        assert.equal(
          pair.outer.sha256,
          pair.service.sha256,
          `Unsigned framework bytes differ: ${rel}`,
        );
      else if (rel !== envelope) await provePayload(pair, scratch);
      pairs.push(pair);
    }
  }
  assert.ok(
    pairs.some((pair) => pair.relative === "Versions/A/Electron Framework"),
    "Missing framework executable",
  );
  if (verifySignatures)
    assert.ok(
      pairs.some((pair) => pair.relative === envelope),
      "Missing framework signature envelope",
    );
  return pairs;
}

async function unchanged(file) {
  const info = await lstat(file.path);
  assert.ok(
    info.isFile() &&
      info.dev === file.device &&
      info.ino === file.inode &&
      info.size === file.bytes &&
      (info.mode & 0o7777) === file.mode &&
      info.mtimeMs === file.modified,
    `Framework changed during export: ${file.path}`,
  );
}

async function sharedPairs(app, pairs) {
  for (const pair of pairs) {
    const outer = join(app, frameworkRelative, pair.relative);
    const service = join(app, serviceRelative, pair.relative);
    const [a, b] = await Promise.all([lstat(outer), lstat(service)]);
    assert.ok(
      a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino,
      `DMG framework hardlink missing: ${pair.relative}`,
    );
    assert.equal(
      await hash(outer),
      pair.outer.sha256,
      `DMG framework bytes changed: ${pair.relative}`,
    );
  }
}

/** Export HFS+ UDBZ without changing or signing the source app.
 * No-new-signatures mode requires byte-identical framework copies, including envelopes.
 */
export async function buildMacOSDmg({ app, destination, volumeName, verifySignatures = true }) {
  assert.equal(process.platform, "darwin", "macOS is required for DMG export");
  assert.ok(typeof app === "string" && app.endsWith(".app"), "app must be an application bundle");
  assert.ok(
    typeof destination === "string" && destination.endsWith(".dmg"),
    "destination must end in .dmg",
  );
  assert.ok(
    typeof volumeName === "string" && volumeName.length > 0 && !/[\0\r\n/]/.test(volumeName),
    "Invalid DMG volume name",
  );
  const source = await realpath(resolve(app));
  assert.ok((await lstat(source)).isDirectory(), "app must be a directory");
  destination = join(await realpath(dirname(resolve(destination))), basename(destination));
  assert.ok(!inside(source, destination), "DMG output must be outside the source app");
  try {
    await lstat(destination);
    throw new Error("DMG destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
  const temporary = await mkdtemp(join(dirname(destination), ".areal-dmg-"));
  const staging = join(temporary, "root"),
    scratch = join(temporary, "signature-copies");
  const image = join(temporary, "candidate.dmg"),
    mount = join(temporary, "mount");
  let mounted = false;
  try {
    for (const path of [staging, scratch, mount]) await mkdir(path);
    const stagedApp = join(staging, basename(source));
    run("/usr/bin/ditto", [source, stagedApp]);
    if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
    const pairs = await planFramework(stagedApp, scratch, verifySignatures);
    for (const pair of pairs) {
      await unchanged(pair.outer);
      await unchanged(pair.service);
      if (pair.outer.device === pair.service.device && pair.outer.inode === pair.service.inode)
        continue;
      const temporaryLink = join(dirname(pair.service.path), `.areal-link-${randomUUID()}`);
      await link(pair.outer.path, temporaryLink);
      await rename(temporaryLink, pair.service.path);
    }
    await sharedPairs(stagedApp, pairs);
    if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
    await symlink("/Applications", join(staging, "Applications"));
    run("/usr/bin/hdiutil", [
      "create",
      "-volname",
      volumeName,
      "-srcfolder",
      staging,
      "-format",
      "UDBZ",
      "-fs",
      "HFS+",
      image,
    ]);
    run("/usr/bin/hdiutil", ["attach", image, "-readonly", "-nobrowse", "-mountpoint", mount]);
    mounted = true;
    const mountedApp = join(mount, basename(source));
    const mountedPlan = await planFramework(mountedApp, scratch, verifySignatures);
    assert.deepEqual(
      mountedPlan.map((pair) => pair.relative),
      pairs.map((pair) => pair.relative),
      "Mounted framework layout changed",
    );
    await sharedPairs(mountedApp, pairs);
    if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", mountedApp]);
    assert.equal(await readlink(join(mount, "Applications")), "/Applications");
    run("/usr/bin/hdiutil", ["detach", mount]);
    mounted = false;
    if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
    const evidence = {
      path: destination,
      bytes: (await lstat(image)).size,
      sha256: await hash(image),
      linkedFiles: pairs.length,
      linkedBytes: pairs.reduce((bytes, pair) => bytes + pair.service.bytes, 0),
      verifiedInodePairs: pairs.length,
    };
    await checkDmgSize(image);
    await link(image, destination);
    return evidence;
  } finally {
    if (mounted) {
      try {
        run("/usr/bin/hdiutil", ["detach", mount]);
      } catch {
        run("/usr/bin/hdiutil", ["detach", "-force", mount]);
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        app: { type: "string" },
        output: { type: "string" },
        "volume-name": { type: "string", default: "AReaL Harness Preview" },
        help: { type: "boolean" },
      },
    });
    if (values.help)
      console.log(
        "Usage: node clients/gui/scripts/macos-dmg.mjs --app /absolute/App.app --output /absolute/new.dmg [--volume-name 'AReaL Harness Preview']",
      );
    else
      console.log(
        JSON.stringify(
          await buildMacOSDmg({
            app: values.app,
            destination: values.output,
            volumeName: values["volume-name"],
          }),
        ),
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
