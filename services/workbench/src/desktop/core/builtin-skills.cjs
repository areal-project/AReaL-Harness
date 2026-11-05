// @ts-check
"use strict";
const {
  readFile,
  readdir,
  lstat,
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  chmod,
} = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { createHash } = require("node:crypto");
const YAML = require("yaml");

const ID = "openai-skill-creator";
const REVISION = "49f948faa9258a0c61caceaf225e179651397431";
const CONTENT_DIGEST = "0f1420873667f4997fc9342ed78a543228c66f977f4f8be37a88e573a1a5ae71";
const UPSTREAM = "https://github.com/openai/skills";
/** @param {string|Uint8Array} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @typedef {{path:string,sha256:string,executable:boolean}} SkillFile */
/** @param {string} root @param {{files:SkillFile[]}} manifest */
async function verifiedFiles(root, manifest) {
  /** @type {string[]} */ const found = [];
  /** @param {string} directory */
  async function visit(directory, prefix = "") {
    if (!(await lstat(directory)).isDirectory()) throw new Error("内置 Skill 目录无效");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) found.push(name);
      else throw new Error("内置 Skill 不允许链接或特殊文件");
    }
  }
  await visit(root);
  if (JSON.stringify(found.sort()) !== JSON.stringify(manifest.files.map((file) => file.path)))
    throw new Error("内置 Skill 文件清单不匹配");
  return Promise.all(
    manifest.files.map(async (file) => {
      const bytes = await readFile(join(root, file.path));
      if (hash(bytes) !== file.sha256) throw new Error(`内置 Skill 内容校验失败：${file.path}`);
      return { ...file, bytes };
    }),
  );
}

/** @param {string} home @param {string} id */
async function builtinSkill(home, id) {
  if (id !== ID) throw new Error("未知内置 Skill");
  const bundle = join(__dirname, "../../assets/builtin-skills");
  /** @type {unknown} */
  const manifest = JSON.parse(await readFile(join(bundle, `${ID}.source.json`), "utf8"));
  if (
    !record(manifest) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(isSkillFile) ||
    manifest.upstream !== UPSTREAM ||
    manifest.revision !== REVISION ||
    manifest.contentDigest !== CONTENT_DIGEST ||
    hash(JSON.stringify(manifest.files)) !== CONTENT_DIGEST
  )
    throw new Error("官方 Skill 来源清单校验失败");
  const files = await verifiedFiles(join(bundle, ID), { files: manifest.files });
  const base = join(home, "builtin-skills");
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (!(await lstat(base)).isDirectory()) throw new Error("内置 Skill 缓存目录无效");
  const root = join(base, CONTENT_DIGEST);
  try {
    await verifiedFiles(root, { files: manifest.files });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    // Rust cannot read inside Electron's ASAR. Materialize only verified product bytes.
    const stage = await mkdtemp(join(base, ".stage-"));
    try {
      for (const file of files) {
        const target = join(stage, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.bytes, { flag: "wx", mode: file.executable ? 0o500 : 0o400 });
      }
      // macOS rename(2) 可能拒绝移动只读目录，即使目标位于同一父目录。
      try {
        await rename(stage, root);
      } catch (cause) {
        // macOS 在其他发布者已创建只读目标目录时可能返回 EACCES。
        if (
          !(cause instanceof Error) ||
          !("code" in cause) ||
          typeof cause.code !== "string" ||
          !["EEXIST", "ENOTEMPTY", "EACCES"].includes(cause.code)
        )
          throw cause;
        try {
          await verifiedFiles(root, { files: manifest.files });
        } catch {
          throw cause;
        }
      }
    } finally {
      await chmod(stage, 0o700).catch(() => {});
      await rm(stage, { recursive: true, force: true });
    }
    await verifiedFiles(root, { files: manifest.files });
  }
  await chmod(root, 0o500);
  await verifiedFiles(root, { files: manifest.files });
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("内置 Skill 缺少 SKILL.md");
  const body = skill.bytes.toString("utf8");
  const frontmatter = body.split(/^---\s*$/m)[1];
  /** @type {unknown} */
  const metadata = YAML.parse(frontmatter, { maxAliasCount: 0 });
  if (
    !record(metadata) ||
    typeof metadata.name !== "string" ||
    typeof metadata.description !== "string"
  )
    throw new Error("内置 Skill 元数据无效");
  return {
    skill: {
      id: ID,
      revision: `builtin-${CONTENT_DIGEST}`,
      name: metadata.name,
      description: metadata.description,
    },
    root,
    provenance: { upstream: UPSTREAM, revision: REVISION, contentDigest: CONTENT_DIGEST },
  };
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is SkillFile} */
function isSkillFile(value) {
  return (
    record(value) &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    typeof value.executable === "boolean"
  );
}
module.exports = { builtinSkill, BUILTIN_SKILL_ID: ID };
