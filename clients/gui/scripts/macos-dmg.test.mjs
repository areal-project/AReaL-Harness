import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildMacOSDmg } from "./macos-dmg.mjs";

const frameworkRelative = "Contents/Frameworks/Electron Framework.framework";
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sign = (path) => run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
const verify = (path) => run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);

async function fingerprint(directory) {
  const entries = [];
  async function scan(path, relative) {
    const info = await lstat(path);
    entries.push([
      relative,
      info.mode,
      info.ino,
      info.size,
      info.isFile()
        ? createHash("sha256")
            .update(await readFile(path))
            .digest("hex")
        : info.isSymbolicLink()
          ? await readlink(path)
          : "directory",
    ]);
    if (info.isDirectory())
      for (const name of (await readdir(path)).sort())
        await scan(join(path, name), `${relative}/${name}`);
  }
  await scan(directory, ".");
  return entries;
}

async function fixture(root) {
  const app = join(root, "Fixture with spaces.app");
  const framework = join(app, frameworkRelative);
  const version = join(framework, "Versions/A");
  await mkdir(join(version, "Resources"), { recursive: true });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Resources"));
  await writeFile(join(root, "framework.c"), "int fixture(void) { return 42; }\n");
  run("/usr/bin/xcrun", [
    "clang",
    "-dynamiclib",
    join(root, "framework.c"),
    "-o",
    join(version, "Electron Framework"),
    "-Wl,-install_name,@rpath/Electron Framework.framework/Electron Framework",
  ]);
  const plist = async (path, info) => {
    await writeFile(path, JSON.stringify(info));
    run("/usr/bin/plutil", ["-convert", "xml1", path]);
  };
  await plist(join(version, "Resources/Info.plist"), {
    CFBundleIdentifier: "com.github.Electron.framework",
    CFBundleExecutable: "Electron Framework",
    CFBundlePackageType: "FMWK",
    CFBundleVersion: "1",
    CFBundleShortVersionString: "1.0",
  });
  await writeFile(join(version, "Resources/payload"), "framework payload\n");
  await symlink("A", join(framework, "Versions/Current"));
  for (const name of ["Electron Framework", "Resources"])
    await symlink(`Versions/Current/${name}`, join(framework, name));
  await copyFile("/usr/bin/true", join(app, "Contents/MacOS/Fixture"));
  await plist(join(app, "Contents/Info.plist"), {
    CFBundleIdentifier: "org.areal.fixture",
    CFBundleExecutable: "Fixture",
    CFBundleName: "Fixture",
    CFBundlePackageType: "APPL",
    CFBundleVersion: "1",
    CFBundleShortVersionString: "1.0",
  });
  await seal(app);
  return app;
}

async function seal(app) {
  sign(join(app, frameworkRelative));
  sign(app);
  verify(app);
}

test(
  "DMG exports signed local framework files through private staging",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areal-dmg-test-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = await fixture(root);
    const before = await fingerprint(app);
    const destination = join(root, "preview.dmg");
    const result = await buildMacOSDmg({ app, destination, volumeName: "AReaL fixture" });
    assert.equal(result.path, destination);
    assert.ok(result.bytes > 0);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    const mount = join(root, "independent-mount");
    await mkdir(mount);
    run("/usr/bin/hdiutil", [
      "attach",
      destination,
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
    ]);
    try {
      const inside = join(mount, basename(app));
      const binary = `${frameworkRelative}/Versions/A/Electron Framework`;
      assert.deepEqual(await readFile(join(inside, binary)), await readFile(join(app, binary)));
      assert.deepEqual(await readdir(join(inside, "Contents/Frameworks")), [
        "Electron Framework.framework",
      ]);
      assert.equal(await readlink(join(mount, "Applications")), "/Applications");
      verify(inside);
      const reexport = await buildMacOSDmg({
        app: inside,
        destination: join(root, "reexport.dmg"),
        volumeName: "AReaL reexport",
      });
      assert.ok(reexport.bytes > 0, "a previously exported signed app remains exportable");
    } finally {
      run("/usr/bin/hdiutil", ["detach", mount]);
    }
    assert.deepEqual(
      await fingerprint(app),
      before,
      "export must leave source bytes, modes and inodes intact",
    );
    const output = await readFile(destination);
    await assert.rejects(
      buildMacOSDmg({ app, destination, volumeName: "AReaL fixture" }),
      /exist/i,
    );
    assert.deepEqual(
      await readFile(destination),
      output,
      "retry must never overwrite a published image",
    );
  },
);

test(
  "DMG rejects a changed signature or an escaping framework alias before publishing",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areal-dmg-reject-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = await fixture(root);
    const version = join(app, frameworkRelative, "Versions/A");
    const destination = join(root, "rejected.dmg");
    await writeFile(join(version, "Resources/payload"), "changed after signing\n");
    const before = await fingerprint(app);
    await assert.rejects(buildMacOSDmg({ app, destination, volumeName: "Rejected" }), /codesign/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    assert.deepEqual(await fingerprint(app), before);

    // 无新签名的调试导出仍校验路径边界。
    await symlink("/System/Library/Frameworks", join(version, "escape"));
    await assert.rejects(
      buildMacOSDmg({ app, destination, volumeName: "Rejected", verifySignatures: false }),
      /symlink escapes/,
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  },
);

test(
  "Unsigned DMG exports an unsealed source without adding signatures",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areal-dmg-unsigned-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = await fixture(root);
    await rm(join(app, frameworkRelative, "Versions/A/_CodeSignature"), { recursive: true });
    await writeFile(join(app, "Contents/Resources/unsealed"), "local unsigned package");
    const before = await fingerprint(app);
    const result = await buildMacOSDmg({
      app,
      destination: join(root, "unsigned.dmg"),
      volumeName: "Unsigned fixture",
      verifySignatures: false,
    });
    assert.ok(result.bytes > 0);
    assert.deepEqual(await fingerprint(app), before);
  },
);
