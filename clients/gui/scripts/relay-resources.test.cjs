const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:net");
const { buildRelayResources } = require("@areal/workbench-service/desktop/core/relay-resources.cjs");

test("portable Relay bundle runs with its own dependency and only exports Remote assets", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "areal-relay-bundle-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bundleDir = join(home, "bundle");
  const result = await buildRelayResources({
    source: resolve(__dirname, "../../../services/remote-relay"),
    site: resolve(__dirname, "../renderer/dist"),
    destination: bundleDir,
  });
  const manifest = JSON.parse(await readFile(join(bundleDir, "bundle.json"), "utf8"));
  assert.equal(manifest.version, result.version);
  assert.match(result.version, /^[a-f0-9]{64}$/);
  assert.ok(manifest.files.some((f) => f.path === "node_modules/ws/lib/websocket.js"));
  assert.ok(manifest.files.some((f) => f.path === "deploy/managed-install.sh"));
  assert.ok(manifest.files.some((f) => f.path === "deploy/licenses/CINDY-LICENSE"));
  assert.ok(!manifest.files.some((f) => f.path === "assets/index.html"));
  const [{ serve }, { openStore }, { readConfig }] = await Promise.all(
    ["server", "store", "config"].map(
      (name) => import(pathToFileURL(join(bundleDir, "src", `${name}.mjs`)).href),
    ),
  );
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const publicOrigin = `http://127.0.0.1:${port}`;
  const configPath = join(home, "relay.json");
  await writeFile(
    configPath,
    JSON.stringify({
      publicOrigin,
      listen: `127.0.0.1:${port}`,
      development: true,
      allowedClientOrigins: [publicOrigin],
      assetsDir: join(bundleDir, "assets"),
      dataDir: join(home, "data"),
    }),
  );
  const config = readConfig(configPath);
  const store = openStore(config);
  t.after(() => store.close());
  const service = await serve(config, store);
  t.after(() => service.close());
  const health = await fetch(`${publicOrigin}/healthz`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(`${publicOrigin}/`)).status, 200);
  assert.equal((await fetch(`${publicOrigin}/index.html`)).status, 404);
  assert.equal((await fetch(`${publicOrigin}/../package.json`)).status, 404);
  const code = store.enrollment().code;
  const enrolled = await fetch(`${publicOrigin}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(enrolled.status, 201);
  assert.match((await enrolled.json()).room, /^[a-f0-9]{64}$/);
});
