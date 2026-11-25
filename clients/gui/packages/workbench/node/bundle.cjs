// @ts-check
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, lstatSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");

/** @typedef {{files?:Record<string,unknown>,thirdPartyComponents?:{name?:unknown}[]}} BundleFiles */
const executablePaths = {
  areal: "bin/areal",
  "areal-runtime": "libexec/areal/areal-runtime",
  "areal-runtime-fs": "libexec/areal/areal-runtime-fs",
};
const executables = /** @type {(keyof typeof executablePaths)[]} */ (Object.keys(executablePaths));

// 搜索已编译进文件助手；兼容旧发行包中的可选工具资源并保持路径校验。
/** @param {BundleFiles} manifest */
function coreBundleFiles(manifest) {
  const tools = Object.keys(manifest.files ?? {}).filter(
    (path) => path.startsWith("libexec/areal/tools/") || path.startsWith("libexec/areal/shells/"),
  );
  // 旧包不强制新增资源；声明了私有 shell 的包必须同时携带许可证和对应源码。
  if (
    tools.some((path) => path.startsWith("libexec/areal/shells/")) ||
    manifest.thirdPartyComponents?.some((component) => component.name === "Bash")
  ) {
    for (const name of ["bash", "sh", "COPYING", "corresponding-source.tar.gz", "build.json"]) {
      if (!tools.includes("libexec/areal/shells/" + name))
        throw new Error("安装包缺少私有 shell 资源 " + name);
    }
  }
  for (const path of tools) {
    if (
      !/^libexec\/areal\/(?:tools|shells)\/[A-Za-z0-9._+/-]+$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Core 工具清单路径无效");
    }
  }
  return [...Object.values(executablePaths), ...tools.sort()];
}

/** @param {string} resourcesPath */
function bundleRoot(resourcesPath) {
  return join(resourcesPath, "areal-core");
}

/** @param {string} resourcesPath @param {{platform?:NodeJS.Platform,arch?:string,hashes?:boolean}} [options] */
function verifyCoreBundle(
  resourcesPath,
  { platform = process.platform, arch = process.arch, hashes = false } = {},
) {
  const root = bundleRoot(resourcesPath);
  /** @type {unknown} */ let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `安装包缺少有效的 AReaL Core manifest：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !record(manifest) ||
    typeof manifest.manifestVersion !== "number" ||
    ![1, 2].includes(manifest.manifestVersion) ||
    manifest.apiVersion !== "areal.core.v1" ||
    manifest.platform !== `${platform}/${arch}` ||
    !record(manifest.files) ||
    !Object.values(manifest.files).every((value) => typeof value === "string") ||
    (manifest.thirdPartyComponents != null &&
      (!Array.isArray(manifest.thirdPartyComponents) ||
        !manifest.thirdPartyComponents.every(record)))
  ) {
    throw new Error("安装包内 AReaL Core 与当前平台或协议不匹配");
  }
  if (
    typeof manifest.stateVersion !== "number" ||
    !Number.isInteger(manifest.stateVersion) ||
    manifest.stateVersion < 12
  ) {
    throw new Error("安装包内 AReaL Core 版本无法读取现有桌面会话");
  }
  if (
    manifest.manifestVersion === 2 &&
    (!record(manifest.coreBuild) ||
      manifest.coreBuild.apiVersion !== manifest.apiVersion ||
      manifest.coreBuild.stateVersion !== manifest.stateVersion ||
      manifest.coreBuild.sourceRevision !== manifest.sourceRevision ||
      typeof manifest.sourceRevision !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceRevision) ||
      (manifest.coreBuild.workingTree !== "true" && manifest.coreBuild.workingTree !== "false") ||
      (manifest.coreBuild.workingTree === "true") !== manifest.workingTree ||
      typeof manifest.coreBuild.inputHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.coreBuild.inputHash))
  ) {
    throw new Error("安装包 Core 构建身份与契约不匹配");
  }
  /** @type {Record<keyof typeof executablePaths,string>} */
  const paths = { areal: "", "areal-runtime": "", "areal-runtime-fs": "" };
  for (const name of executables) {
    const relative = executablePaths[name];
    const path = join(root, relative);
    if (
      !existsSync(path) ||
      typeof manifest.files[relative] !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.files[relative])
    ) {
      throw new Error(`安装包缺少 AReaL Core 组件 ${name}`);
    }
    if (hashes) {
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (actual !== manifest.files[relative]) throw new Error(`AReaL Core 组件校验失败：${name}`);
    }
    paths[name] = path;
  }
  for (const relative of coreBundleFiles({
    files: manifest.files,
    thirdPartyComponents: Array.isArray(manifest.thirdPartyComponents)
      ? manifest.thirdPartyComponents
      : undefined,
  }).filter((path) => !Object.values(executablePaths).includes(path))) {
    const path = join(root, relative);
    if (
      !existsSync(path) ||
      !lstatSync(path).isFile() ||
      typeof manifest.files[relative] !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.files[relative])
    )
      throw new Error(`安装包缺少 Core 工具资源 ${relative}`);
    if (
      hashes &&
      createHash("sha256").update(readFileSync(path)).digest("hex") !== manifest.files[relative]
    )
      throw new Error(`Core 工具资源校验失败：${relative}`);
  }
  return { root, manifest, paths };
}

/** @param {{explicit?: string, packaged?: boolean, resourcesPath?: string, platform?: NodeJS.Platform, arch?: string}} [options] */
function resolveCoreBinary({
  explicit,
  packaged,
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("AREAL_CORE_BIN 必须是绝对路径");
    return explicit;
  }
  if (!packaged || !resourcesPath)
    throw new Error("请设置 AREAL_CORE_BIN 为 areal 可执行文件的绝对路径");
  return verifyCoreBundle(resourcesPath, { platform, arch }).paths.areal;
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  coreBundleFiles,
  bundleRoot,
  executablePaths,
  executables,
  resolveCoreBinary,
  verifyCoreBundle,
};
