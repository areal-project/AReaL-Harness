// @ts-check
"use strict";
const { readFile, realpath, readdir, mkdir, writeFile, rm, rename } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join, dirname, resolve, sep } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

/** @param {import("node:crypto").BinaryLike} bytes */
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function locations() {
  const packaged = process.resourcesPath && join(process.resourcesPath, "areal-relay");
  if (packaged && existsSync(join(packaged, "bundle.json")))
    return { source: packaged, site: join(packaged, "assets") };
  return {
    source: resolve(__dirname, "../../../../../services/remote-relay"),
    site: resolve(__dirname, "../../../renderer/dist"),
  };
}

/** @param {string} source */
async function remoteAssets(source) {
  const root = await realpath(source);
  const descriptorBytes = await readFile(join(root, "remote-assets.json"));
  const descriptor = JSON.parse(descriptorBytes.toString());
  if (
    descriptor.schema !== 1 ||
    descriptor.entry !== "remote.html" ||
    !Array.isArray(descriptor.assets) ||
    descriptor.worker?.path !== "remote-sw.js"
  )
    throw new Error("Remote 静态清单无效");
  /** @type {Map<string,Buffer>} */
  const files = new Map();
  for (const asset of [...descriptor.assets, descriptor.worker]) {
    if (
      !asset ||
      typeof asset.path !== "string" ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/.test(asset.path) ||
      String(asset.path)
        .split("/")
        .some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      files.has(asset.path) ||
      ["index.html", "remote-assets.json"].includes(asset.path)
    )
      throw new Error("Remote 静态资源无效");
    const path = await realpath(join(root, asset.path));
    if (!path.startsWith(root + sep)) throw new Error("Remote 静态资源越界");
    const bytes = await readFile(path);
    if (digest(bytes) !== asset.sha256) throw new Error("Remote 静态资源版本不一致");
    files.set(asset.path, bytes);
  }
  if (!files.has("remote.html")) throw new Error("Remote 静态入口缺失");
  files.set("remote-assets.json", descriptorBytes);
  return { files, version: descriptor.version };
}

/** @param {string} destination @param {Map<string,Buffer>} files */
async function writeFiles(destination, files) {
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const [path, bytes] of files) {
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** @param {string} source @param {string} destination */
async function exportRemoteAssets(source, destination) {
  const { files, version } = await remoteAssets(source);
  await writeFiles(destination, files);
  return { files: files.size, version };
}

/** @param {string} source @param {string} site */
async function relayFiles(source, site) {
  /** @type {Map<string,Buffer>} */
  const files = new Map();
  /** @param {string} root @param {string} prefix @param {(name:string)=>boolean} [filter] */
  async function tree(root, prefix, filter = () => true) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!filter(entry.name)) continue;
      if (entry.isDirectory())
        await tree(join(root, entry.name), `${prefix}${entry.name}/`, filter);
      else if (entry.isFile())
        files.set(`${prefix}${entry.name}`, await readFile(join(root, entry.name)));
      else throw new Error("Relay 资源不能包含符号链接");
    }
  }
  await tree(join(source, "src"), "src/", (name) => name.endsWith(".mjs"));
  await tree(
    join(source, "deploy"),
    "deploy/",
    (name) =>
      name === "licenses" ||
      name.endsWith(".sh") ||
      name.endsWith("-LICENSE") ||
      name.endsWith("-NOTICE"),
  );
  for (const name of ["package.json", "package-lock.json"])
    files.set(name, await readFile(join(source, name)));
  const requireFromSource = createRequire(join(source, "package.json"));
  const ws = dirname(await realpath(requireFromSource.resolve("ws/package.json")));
  await tree(ws, "node_modules/ws/");
  const assets = await remoteAssets(site);
  for (const [name, bytes] of assets.files) files.set(`assets/${name}`, bytes);
  const manifest = [...files]
    .map(([path, bytes]) => ({ path, sha256: digest(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const version = digest(JSON.stringify(manifest));
  files.set(
    "bundle.json",
    Buffer.from(JSON.stringify({ version, files: manifest }, null, 2) + "\n"),
  );
  return { files, version };
}

/** @param {{source:string,site:string,destination:string}} options */
async function buildRelayResources({ source, site, destination }) {
  const { files, version } = await relayFiles(source, site);
  await writeFiles(destination, files);
  return { bundleDir: destination, version };
}

/** @param {{home:string}} options */
async function prepareRelayResources({ home }) {
  const { source, site } = locations();
  const { files, version } = await relayFiles(source, site);
  const parent = join(home, "relay", "bundles");
  const bundleDir = join(parent, version);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (existsSync(bundleDir)) {
    for (const [name, bytes] of files)
      if (digest(await readFile(join(bundleDir, name))) !== digest(bytes))
        throw new Error("Relay 资源校验失败");
    return { bundleDir, version };
  }
  const temporary = join(parent, `.stage-${randomUUID()}`);
  await writeFiles(temporary, files);
  try {
    await rename(temporary, bundleDir);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
      )
    )
      throw error;
    for (const [name, bytes] of files)
      if (digest(await readFile(join(bundleDir, name))) !== digest(bytes))
        throw new Error("Relay 资源校验失败");
  }
  return { bundleDir, version };
}

async function loadRelayModules() {
  const { source } = locations();
  const [server, store, config] = await Promise.all(
    ["server", "store", "config"].map(
      (name) => import(pathToFileURL(join(source, "src", `${name}.mjs`)).href),
    ),
  );
  return { serve: server.serve, openStore: store.openStore, readConfig: config.readConfig };
}

module.exports = {
  buildRelayResources,
  prepareRelayResources,
  loadRelayModules,
  exportRemoteAssets,
};
