const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  mkdtemp,
  mkdir,
  chmod,
  lstat,
  readFile,
  realpath,
  writeFile,
  symlink,
  unlink,
  rm,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { HostClient } = require("node:module").createRequire(
  require("node:path").resolve(__dirname, "../app/package.json"),
)("@areal/client/node");

test("a late event from an old Host socket does not close the new connection", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "host-reconnect-")));
  const home = join(root, "home");
  const directory = join(home, "host");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = join(directory, "socket");
  const listener = createServer((socket) => {
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk;
      while (bytes.includes("\n")) {
        const index = bytes.indexOf("\n");
        const request = JSON.parse(bytes.slice(0, index));
        bytes = bytes.slice(index + 1);
        socket.write(
          JSON.stringify({
            version: 1,
            id: request.id,
            result:
              request.method === "hello"
                ? { version: 1, hostId: "host", generation: "generation", capabilities: [] }
                : { state: "ready" },
          }) + "\n",
        );
      }
    });
  });
  listener.listen(socketPath);
  await once(listener, "listening");
  await chmod(socketPath, 0o600);
  await writeFile(
    join(directory, "host.json"),
    JSON.stringify({
      version: 1,
      hostId: "host",
      generation: "generation",
      socketPath,
      authFile: join(directory, "auth.json"),
    }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, "auth.json"), JSON.stringify("token"), { mode: 0o600 });
  const client = new HostClient();
  t.after(async () => {
    client.close();
    await new Promise((resolve) => listener.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(home);
  const old = client.socket;
  const oldClose = old.listeners("close")[0];
  const oldError = old.listeners("error")[0];
  const oldData = old.listeners("data")[0];
  client.close();
  await client.connect(home);
  oldClose();
  oldError(new Error("late socket error"));
  oldData(Buffer.from("invalid old frame\n"));
  assert.deepEqual(await client.status(), { state: "ready" });
});

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
