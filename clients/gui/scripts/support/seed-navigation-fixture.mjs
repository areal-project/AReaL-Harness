import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020.js").default;
const { addHostProtocolSchemas } = require("../host-protocol-schema-registry.cjs");
const hostSchema = JSON.parse(
  await readFile(
    new URL("../../../../schemas/areal-host-protocol-v1.json", import.meta.url),
    "utf8",
  ),
);
const coreSchema = JSON.parse(
  await readFile(new URL("../../../../schemas/areal-core-v1.json", import.meta.url), "utf8"),
);
const validator = new Ajv({ strict: false, validateFormats: false });
addHostProtocolSchemas(validator, hostSchema, coreSchema);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const emptyLibrary = () => ({
  projects: {},
  threads: {},
  projectOrder: [],
  sections: [],
  sidebarThreadOrder: [],
  sidebarRevision: 0,
  settings: {},
});
const unique = (values) => [...new Set(values)];

// 只使用现有公开合同作字段投影；不读取 Store、凭据或工作区内容。
function project(value, schema) {
  assert(
    schema && typeof schema === "object" && !schema.anyOf && !schema.oneOf && !schema.allOf,
    "Unsupported public navigation schema shape",
  );
  if (schema.$ref) {
    assert(
      schema.$ref.startsWith("#/$defs/"),
      "Navigation projection only accepts local public schema refs",
    );
    return project(value, hostSchema.$defs[schema.$ref.slice(8)]);
  }
  if (schema.type === "array" && Array.isArray(value))
    return value.map((item) => project(item, schema.items));
  if (schema.type !== "object" || !value || typeof value !== "object" || Array.isArray(value))
    return value;
  if (schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([key]) => Object.hasOwn(value, key) && value[key] !== null)
        .map(([key, field]) => [key, project(value[key], field)]),
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, project(item, schema.additionalProperties)]),
  );
}
function valid(name, value) {
  const check = validator.getSchema(`${hostSchema.$id}#/$defs/${name}`);
  assert(check(value), `Invalid ${name} projection: ${validator.errorsText(check.errors)}`);
  return value;
}
async function stableJson(path, optional = false, maxBytes = 8n * 1024n * 1024n) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && error.code === "ENOENT") return { value: {}, sha256: null };
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    assert(
      before.isFile() && before.size <= maxBytes,
      "Navigation input must be a bounded regular file",
    );
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(after[key], before[key], "Navigation source changed while reading");
    assert.equal(current.ino, before.ino, "Navigation source path changed");
    return { value: JSON.parse(bytes), sha256: digest(bytes) };
  } finally {
    await file.close();
  }
}
function publicLibrary(raw) {
  return valid(
    "WorkbenchLibraryState",
    project({ ...emptyLibrary(), ...raw }, hostSchema.$defs.WorkbenchLibraryState),
  );
}

export async function createSeedNavigationFixture({
  seedHome,
  fixtureRoot,
  existingProjects = [],
  existingLibrary = {},
}) {
  const seed = await realpath(seedHome);
  const fixture = await realpath(fixtureRoot);
  const { value: manifest, sha256: manifestSha256 } = await stableJson(
    join(seed, "seed-copy/manifest.json"),
    false,
    64n * 1024n * 1024n,
  );
  assert.equal(manifest.testCopy, true, "Requires an existing seed-host-copy manifest");
  assert(manifest.copyDigest && manifest.sourceDigest, "The seed copy phase must have completed");
  const { value: sourceProjects, sha256: copiedIndexSha256 } = await stableJson(
    join(seed, "seed-copy/core/projects.json"),
  );
  const originalIndex = manifest.sourceSnapshot?.find(
    (entry) => entry.path === "projects.json" && entry.kind === "file",
  );
  assert.equal(
    copiedIndexSha256,
    originalIndex?.sha256,
    "Copied project index lost seed provenance",
  );
  assert(
    Array.isArray(sourceProjects) && sourceProjects.length > 0 && sourceProjects.length <= 65536,
  );
  const source = await realpath(manifest.source);
  const beforeIndex = await stableJson(join(source, "projects.json"));
  assert.equal(
    beforeIndex.sha256,
    copiedIndexSha256,
    "Real project index drifted since seed-copy; make a fresh seed copy",
  );
  const sourceLibrary = await stableJson(join(source, "library.json"), true);
  assert.equal(
    (await stableJson(join(source, "projects.json"))).sha256,
    copiedIndexSha256,
    "Real project index changed while copying navigation",
  );
  const protectedHomes = [
    join(userInfo().homedir, ".areal"),
    join(userInfo().homedir, "Library/Application Support/AReaL Harness GUI"),
  ];
  assert(
    protectedHomes.every((home) => !inside(home, fixture)),
    "Fixture must not be live installed data",
  );
  const oldIds = new Set();
  for (const item of sourceProjects) {
    assert(
      /^[a-f0-9]{24}$/.test(item.id) && !oldIds.has(item.id),
      "Seed project identities must be unique",
    );
    assert(
      isAbsolute(item.root) &&
        !inside(resolve(item.root), fixture) &&
        !inside(fixture, resolve(item.root)),
      "Fixture must not overlap an original workspace",
    );
    oldIds.add(item.id);
  }
  for (const item of existingProjects)
    assert(
      inside(fixture, await realpath(item.root)),
      "Existing GUI projects must already be isolated",
    );
  const oldLibrary = publicLibrary(sourceLibrary.value);
  const current = publicLibrary(existingLibrary);
  const directory = join(fixture, "seed-navigation");
  await mkdir(directory, { mode: 0o700 });
  const mappings = [];
  for (const item of sourceProjects) {
    const label = basename(item.root);
    assert(label && label !== "." && label !== "..", "Unsupported workspace display name");
    const root = join(directory, "workspaces", item.id, label);
    await mkdir(root, { recursive: true, mode: 0o700 });
    assert(inside(directory, await realpath(root)), "Placeholder escaped isolation");
    mappings.push({ sourceProjectId: item.id, projectId: digest(root).slice(0, 24), root });
  }
  const aliases = new Map(mappings.map((item) => [item.sourceProjectId, item.projectId]));
  const alias = (id) => aliases.get(id) ?? id;
  const threadKey = (key) => {
    const colon = key.indexOf(":");
    return colon < 0 ? key : `${alias(key.slice(0, colon))}${key.slice(colon)}`;
  };
  const importedProjects = sourceProjects.map((item, index) => {
    assert(
      !item.logicalProjectId || aliases.has(item.logicalProjectId),
      "Logical project must be part of the same seed index",
    );
    return {
      id: mappings[index].projectId,
      root: mappings[index].root,
      ...(item.logicalProjectId ? { logicalProjectId: alias(item.logicalProjectId) } : {}),
    };
  });
  const projects = [...existingProjects, ...importedProjects];
  assert.equal(
    new Set(projects.map((item) => item.id)).size,
    projects.length,
    "Fixture project alias collision",
  );
  const remapped = {
    ...oldLibrary,
    projects: Object.fromEntries(
      Object.entries(oldLibrary.projects).map(([id, metadata]) => [alias(id), metadata]),
    ),
    threads: Object.fromEntries(
      Object.entries(oldLibrary.threads).map(([key, metadata]) => [threadKey(key), metadata]),
    ),
    projectOrder: oldLibrary.projectOrder.map(alias),
    sidebarThreadOrder: oldLibrary.sidebarThreadOrder.map(threadKey),
  };
  const library = {
    projects: { ...current.projects, ...remapped.projects },
    threads: { ...current.threads, ...remapped.threads },
    projectOrder: unique([...current.projectOrder, ...remapped.projectOrder]),
    sidebarThreadOrder: unique([...current.sidebarThreadOrder, ...remapped.sidebarThreadOrder]),
    sections: [...current.sections],
    sidebarRevision: Math.max(current.sidebarRevision, remapped.sidebarRevision),
    settings: { ...current.settings, ...remapped.settings },
  };
  for (const section of remapped.sections) {
    const previous = library.sections.find((item) => item.id === section.id);
    assert(!previous || previous.title === section.title, "Fixture section collision");
    if (!previous) library.sections.push(section);
  }
  valid("WorkbenchLibraryState", library);
  let summaries = 0;
  for (const item of sourceProjects) {
    const cached = sourceLibrary.value.projects?.[item.id]?.navigationSummaries;
    if (!cached) continue;
    assert(Array.isArray(cached) && cached.length <= 65536, "Invalid bounded navigation cache");
    const projected = cached.map((summary) =>
      valid(
        "NavigationSummary",
        project(
          { ...summary, desktop: { archived: false, ...summary.desktop } },
          hostSchema.$defs.NavigationSummary,
        ),
      ),
    );
    (library.projects[alias(item.id)] ??= {}).navigationSummaries = projected;
    summaries += projected.length;
  }
  const provenance = {
    testCopy: true,
    kind: "public-navigation-projection",
    seedManifestSha256: manifestSha256,
    seedCopyDigest: manifest.copyDigest,
    seedSourceDigest: manifest.sourceDigest,
    seedRegistrationStatus: manifest.status,
    copiedIndexSha256,
    sourceLibrarySha256: sourceLibrary.sha256,
    projectCount: importedProjects.length,
    summaryCount: summaries,
    originalThreadStoresCopied: false,
    originalUnknownRecordsChanged: false,
    originalWorkspacesRegistered: false,
    mappings,
  };
  await writeFile(
    join(directory, "projection.json"),
    JSON.stringify({ projects, library }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(join(directory, "manifest.json"), JSON.stringify(provenance, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return { directory, projects, library, importedProjects, mappings, provenance };
}
