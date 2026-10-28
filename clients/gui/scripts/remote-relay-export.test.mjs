import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Relay export contains exactly the verified Remote closure and never Desktop dist", async (t) => {
  const { exportRemoteAssets } = await import("./export-remote-assets.mjs");
  const root = await mkdtemp(join(tmpdir(), "rc12-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../renderer/dist/", import.meta.url)),
    output = join(root, "out");
  const descriptor = JSON.parse(await readFile(join(source, "remote-assets.json"), "utf8"));
  await exportRemoteAssets(source, output);
  const expected = [...descriptor.assets, descriptor.worker];
  const files = (await readdir(output, { recursive: true, withFileTypes: true }))
    .filter((value) => value.isFile())
    .map((value) => join(value.parentPath, value.name).slice(output.length + 1))
    .sort();
  assert.deepEqual(files, [...expected.map((value) => value.path), "remote-assets.json"].sort());
  for (const asset of expected)
    assert.equal(digest(await readFile(join(output, asset.path))), asset.sha256);
  assert.ok(!files.includes("index.html"));
  await assert.rejects(exportRemoteAssets(source, output), { code: "EEXIST" });
});

test("Relay export refuses traversal, duplicates, wrong hashes, escaped symlinks and incomplete manifests", async (t) => {
  const { exportRemoteAssets } = await import("./export-remote-assets.mjs");
  const root = await mkdtemp(join(tmpdir(), "rc12-export-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "remote.html"), "shell");
  await writeFile(join(source, "remote-sw.js"), "worker");
  const shell = { path: "remote.html", mime: "text/html", sha256: digest("shell") };
  const worker = { path: "remote-sw.js", mime: "text/javascript", sha256: digest("worker") };
  const base = { schema: 1, entry: "remote.html", assets: [shell], worker };
  let id = 0;
  for (const invalid of [
    { ...base, assets: [{ ...shell, path: "../remote.html" }] },
    { ...base, assets: [shell, shell] },
    { ...base, assets: [{ ...shell, sha256: "0".repeat(64) }] },
    { ...base, assets: [] },
    { ...base, worker: { ...worker, path: "index.html" } },
  ]) {
    await writeFile(join(source, "remote-assets.json"), JSON.stringify(invalid));
    await assert.rejects(exportRemoteAssets(source, join(root, `out-${id++}`)));
  }
  await writeFile(join(root, "outside"), "shell");
  await rm(join(source, "remote.html"));
  await symlink(join(root, "outside"), join(source, "remote.html"));
  await writeFile(join(source, "remote-assets.json"), JSON.stringify(base));
  await assert.rejects(exportRemoteAssets(source, join(root, "symlink")));
});
