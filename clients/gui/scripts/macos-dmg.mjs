#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkDmgSize } from "./dmg-size.mjs";

const frameworkRelative = "Contents/Frameworks/Electron Framework.framework";

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
        bytes: info.size,
        sha256: await hash(path),
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
  assert.equal(
    entries.get("Versions/A/Electron Framework")?.type,
    "file",
    "Missing framework executable",
  );
  return entries;
}

/** Export a staged copy without modifying the source application's signed bytes. */
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
  const staging = join(temporary, "root");
  const image = join(temporary, "candidate.dmg"),
    mount = join(temporary, "mount");
  let mounted = false;
  try {
    const sourceFramework = await frameworkTree(await localDirectory(source, frameworkRelative));
    for (const path of [staging, mount]) await mkdir(path);
    const stagedApp = join(staging, basename(source));
    run("/usr/bin/ditto", [source, stagedApp]);
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
    assert.deepEqual(
      await frameworkTree(await localDirectory(mountedApp, frameworkRelative)),
      sourceFramework,
      "Mounted framework differs from the source application",
    );
    if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", mountedApp]);
    assert.equal(await readlink(join(mount, "Applications")), "/Applications");
    run("/usr/bin/hdiutil", ["detach", mount]);
    mounted = false;
    if (verifySignatures) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
    const evidence = {
      path: destination,
      bytes: (await lstat(image)).size,
      sha256: await hash(image),
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
