const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, realpath, rm, access } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { runInNewContext } = require("node:vm");
const {
  buildRelayResources,
  prepareRelayResources,
} = require("@areal/workbench-service/desktop/core/relay-resources.cjs");
const requireFromApp = createRequire(resolve(__dirname, "../app/package.json"));
const requireFromBuilder = createRequire(requireFromApp.resolve("electron-builder"));
const { getFileMatchers, copyFiles } = requireFromBuilder("app-builder-lib/out/fileMatcher.js");

test("packaged Relay resources retain every manifest file and load their own ws", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-relay-package-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const gui = resolve(__dirname, "..");
  const relayBundle = await buildRelayResources({
    source: resolve(__dirname, "../../../services/remote-relay"),
    site: join(gui, "renderer/dist"),
    destination: join(home, "bundle"),
  });
  const source = await readFile(join(__dirname, "package.mjs"), "utf8");
  const resources = source.match(/extraResources: (\[[\s\S]*?\n    \]),/);
  assert.ok(resources, "package.mjs must define extraResources");
  const extraResources = runInNewContext(`(${resources[1]})`, {
    join,
    gui,
    relayBundle,
    workbenchBundle: { bundleDir: join(home, "workbench") },
    bundle: join(home, "core"),
    release: false,
  }).filter(
    ({ to }) => to === "areal-gui" || to === "areal-relay" || to.startsWith("areal-relay/"),
  );
  assert.ok(extraResources.length > 0, "package.mjs must include Relay resources");
  const destination = join(home, "Resources");
  const matchers = getFileMatchers({ extraResources }, "extraResources", destination, {
    defaultSrc: gui,
    macroExpander: (value) => value,
    customBuildOptions: {},
    globalOutDir: home,
  });
  await copyFiles(matchers, undefined, false);
  const packaged = join(destination, "areal-relay");
  const manifest = JSON.parse(await readFile(join(packaged, "bundle.json"), "utf8"));
  assert.equal(manifest.version, relayBundle.version);
  assert.ok(manifest.files.some(({ path }) => path === "node_modules/ws/package.json"));
  assert.ok(manifest.files.some(({ path }) => path === "src/host-runner.mjs"));
  await assert.rejects(access(join(packaged, "assets/remote.html")), { code: "ENOENT" });
  await assert.rejects(access(join(destination, "areal-gui/bundle-analysis.json")), {
    code: "ENOENT",
  });
  const previousResourcesPath = process.resourcesPath;
  process.resourcesPath = destination;
  let prepared;
  try {
    prepared = await prepareRelayResources({ home });
  } finally {
    process.resourcesPath = previousResourcesPath;
  }
  assert.equal(prepared.version, manifest.version);
  for (const file of manifest.files) {
    const bytes = await readFile(join(prepared.bundleDir, file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  const requireFromPackage = createRequire(join(packaged, "package.json"));
  assert.equal(
    requireFromPackage.resolve("ws/package.json"),
    join(packaged, "node_modules/ws/package.json"),
  );
  assert.equal(typeof requireFromPackage("ws").WebSocketServer, "function");
  const { serve } = await import(pathToFileURL(join(packaged, "src/server.mjs")).href);
  assert.equal(typeof serve, "function");
});
