const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  mkdtemp,
  mkdir,
  chmod,
  lstat,
  readFile,
  writeFile,
  symlink,
  unlink,
  rm,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { HostClient } = require("../app/src/core/host-client.cjs");

test("legacy Host home is restricted before opening its private log", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const child = join(home, "child");
  await mkdir(home, { mode: 0o755 });
  await chmod(home, 0o755);
  await mkdir(child, { mode: 0o755 });
  await chmod(child, 0o755);
  await writeFile(join(home, "config.toml"), "original");
  const client = new HostClient();
  await assert.rejects(client.connectOrStart(home, join(root, "missing-binary")));
  assert.equal((await lstat(home)).mode & 0o777, 0o700);
  assert.equal((await lstat(child)).mode & 0o777, 0o755);
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), "original");
  assert.equal((await lstat(join(home, "host.log"))).mode & 0o777, 0o600);
  client.close();
});

test("Host home and log reject unsafe paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const alias = join(root, "alias");
  await symlink(home, alias);
  const client = new HostClient();
  await assert.rejects(client.connectOrStart(alias, join(root, "missing")), (error) =>
    ["ELOOP", "ENOTDIR"].includes(error.code),
  );
  await assert.rejects(lstat(join(home, "host.log")), { code: "ENOENT" });
  await chmod(home, 0o775);
  await assert.rejects(
    client.connectOrStart(home, join(root, "missing")),
    /private or legacy mode 755/,
  );
  await assert.rejects(lstat(join(home, "host.log")), { code: "ENOENT" });
  assert.equal((await lstat(home)).mode & 0o777, 0o775);
  await chmod(home, 0o700);
  const target = join(root, "target");
  await writeFile(target, "untouched", { mode: 0o600 });
  await symlink(target, join(home, "host.log"));
  await assert.rejects(client.connectOrStart(home, join(root, "missing")), { code: "ELOOP" });
  assert.equal(await readFile(target, "utf8"), "untouched");
  await unlink(join(home, "host.log"));
  await writeFile(join(home, "host.log"), "old", { mode: 0o644 });
  await chmod(join(home, "host.log"), 0o644);
  await assert.rejects(
    client.connectOrStart(home, join(root, "missing")),
    /Host log must be private/,
  );
  assert.equal(await readFile(join(home, "host.log"), "utf8"), "old");
  await mkdir(join(home, "host"), { mode: 0o755 });
  await chmod(join(home, "host"), 0o755);
  await assert.rejects(client.connect(home), /Host discovery directory must be private/);
  client.close();
});
