import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const threadFile = /^[a-f0-9-]{36}\.json$/;
const assetDirectories = new Set(["history", "blobs", "goals"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const json = (value) => JSON.stringify(value, null, 2) + "\n";

async function statOrMissing(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalTarget(path) {
  const stat = await statOrMissing(path);
  if (stat) return realpath(path);
  return join(await canonicalTarget(dirname(path)), path.slice(dirname(path).length + 1));
}

function metadata(stat) {
  return Object.fromEntries(
    ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs", "birthtimeNs"].map(
      (key) => [key, String(stat[key])],
    ),
  );
}

async function readOnly(path) {
  assert.equal(
    await realpath(dirname(path)),
    dirname(path),
    "Source parent must not contain symlinks",
  );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    assert.ok(before.isFile(), `Source is not a regular file: ${path}`);
    const bytes = await file.readFile();
    assert.deepEqual(
      metadata(await file.stat({ bigint: true })),
      metadata(before),
      "Source drift while reading",
    );
    assert.deepEqual(
      metadata(await lstat(path, { bigint: true })),
      metadata(before),
      "Source path changed while reading",
    );
    assert.equal(
      await realpath(dirname(path)),
      dirname(path),
      "Source parent changed while reading",
    );
    return { bytes, metadata: metadata(before), sha256: sha256(bytes) };
  } finally {
    await file.close();
  }
}

async function selectedSnapshot(source) {
  const entries = [];
  async function directory(path, select = () => true) {
    const stat = await statOrMissing(path);
    const name = relative(source, path);
    if (!stat) {
      entries.push({ path: name, kind: "missing" });
      return;
    }
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      `Source directory must not be a symlink: ${name}`,
    );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      assert.deepEqual(
        metadata(await handle.stat({ bigint: true })),
        metadata(stat),
        "Source directory changed",
      );
      entries.push({ path: name, kind: "directory", metadata: metadata(stat) });
      for (const child of (await readdir(path)).sort()) {
        const childPath = join(path, child);
        const childStat = await lstat(childPath, { bigint: true });
        assert.ok(
          !childStat.isSymbolicLink(),
          `Source symlink is unsupported: ${relative(source, childPath)}`,
        );
        assert.ok(
          childStat.isDirectory() || childStat.isFile(),
          `Source special file is unsupported: ${relative(source, childPath)}`,
        );
        if (!select(child, childStat)) continue;
        if (childStat.isDirectory()) await directory(childPath);
        else {
          const value = await readOnly(childPath);
          entries.push({
            path: relative(source, childPath),
            kind: "file",
            metadata: value.metadata,
            sha256: value.sha256,
          });
        }
      }
      assert.deepEqual(
        metadata(await lstat(path, { bigint: true })),
        metadata(stat),
        "Source directory drift",
      );
    } finally {
      await handle.close();
    }
  }
  const index = await readOnly(join(source, "projects.json"));
  entries.push({
    path: "projects.json",
    kind: "file",
    metadata: index.metadata,
    sha256: index.sha256,
  });
  const projects = JSON.parse(index.bytes);
  assert.ok(Array.isArray(projects) && projects.length > 0, "Source has no projects");
  const ids = new Set();
  for (const project of projects) {
    assert.match(project.id, /^[a-f0-9]{24}$/, "Invalid source project ID");
    assert.ok(!ids.has(project.id), "Duplicate source project ID");
    ids.add(project.id);
    assert.ok(
      typeof project.root === "string" && isAbsolute(project.root),
      "Project workspace must be absolute",
    );
    const projectPath = join(source, project.id);
    const projectStat = await statOrMissing(projectPath);
    assert.ok(
      !projectStat || projectStat.isDirectory(),
      "Source project must be a directory, not a symlink",
    );
    entries.push({
      path: project.id,
      kind: projectStat ? "directory" : "missing",
      ...(projectStat ? { metadata: metadata(projectStat) } : {}),
    });
    await directory(
      join(projectPath, "state"),
      (name, stat) =>
        (stat.isFile() && threadFile.test(name)) ||
        (stat.isDirectory() && assetDirectories.has(name)),
    );
  }
  return { projects, entries, digest: sha256(JSON.stringify(entries)) };
}

function copiedBytes(path, bytes, sanitizations) {
  if (!threadFile.test(path.split(sep).at(-1)) || path.split(sep).length !== 3) return bytes;
  const record = JSON.parse(bytes);
  const queue = record.thread?.desktop?.queue;
  if (!queue?.items) return bytes;
  assert.ok(Array.isArray(queue.items), "Stored queue items must be an array");
  const removed = queue.items.filter((item) => ["pending", "running"].includes(item.status));
  if (!removed.length) return bytes;
  queue.items = queue.items.filter((item) => !["pending", "running"].includes(item.status));
  const copied = Buffer.from(json(record));
  sanitizations.push({
    path,
    removedQueueItems: removed.map(({ id, status }) => ({ id, status })),
    sourceSha256: sha256(bytes),
    copiedSha256: sha256(copied),
  });
  return copied;
}

export async function seedHostCopy({ from, home, binary }, { registerProject, beforeCopy } = {}) {
  assert.ok(
    from && home && binary,
    "Required: --from OLD_CORE_HOME --home ISOLATED_HOST_HOME --binary PACKAGED_AREAL",
  );
  const sourcePath = resolve(from);
  const sourceStat = await lstat(sourcePath);
  assert.ok(
    sourceStat.isDirectory() && !sourceStat.isSymbolicLink(),
    "Source must be a directory, not a symlink",
  );
  const source = await realpath(sourcePath);
  const destination = await canonicalTarget(resolve(home));
  const actualHome = await realpath(userInfo().homedir);
  for (const protectedHome of [
    join(actualHome, ".areal"),
    join(actualHome, "Library/Application Support/AReaL Harness GUI"),
  ]) {
    assert.ok(
      !inside(protectedHome, destination) &&
        !inside(await canonicalTarget(protectedHome), destination),
      "Target is live user data",
    );
  }
  assert.ok(
    !inside(source, destination) && !inside(destination, source),
    "Source and target must not overlap",
  );
  assert.equal(
    await statOrMissing(resolve(home)),
    null,
    "Target must be fresh and must not be a symlink",
  );
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const copyRoot = join(destination, "seed-copy/core");
  const marker = join(copyRoot, ".areal-test-copy.json");
  const evidencePath = join(destination, "seed-copy/manifest.json");
  const evidence = {
    version: 1,
    testCopy: true,
    source,
    status: "incomplete",
    sourceDigest: null,
    scope: "projects.json and supported Store thread/history/blobs/goals assets only",
    sanitizedFiles: [],
    projects: [],
  };
  let client;
  await mkdir(copyRoot, { recursive: true, mode: 0o700 });
  await writeFile(marker, json({ testCopy: true, status: "incomplete" }), {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(evidencePath, json(evidence), { mode: 0o600, flag: "wx" });
  try {
    const before = await selectedSnapshot(source);
    evidence.sourceDigest = before.digest;
    evidence.sourceSnapshot = before.entries;
    await writeFile(evidencePath, json(evidence));
    await beforeCopy?.();
    const copiedFiles = [];
    for (const entry of before.entries) {
      const target = join(copyRoot, entry.path);
      if (entry.kind !== "file") {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      const value = await readOnly(join(source, entry.path));
      assert.deepEqual(
        { metadata: value.metadata, sha256: value.sha256 },
        { metadata: entry.metadata, sha256: entry.sha256 },
        "Source drift before copy",
      );
      const bytes = copiedBytes(entry.path, value.bytes, evidence.sanitizedFiles);
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      copiedFiles.push({ path: entry.path, sha256: sha256(bytes) });
    }
    const after = await selectedSnapshot(source);
    assert.deepEqual(after, before, "Source drift during copy; no Host was started");
    for (const file of copiedFiles)
      assert.equal(
        (await readOnly(join(copyRoot, file.path))).sha256,
        file.sha256,
        "Copied bytes differ",
      );
    evidence.copyDigest = sha256(JSON.stringify(copiedFiles));
    evidence.status = "copied";
    await writeFile(
      marker,
      json({ testCopy: true, status: "copied", sourceDigest: before.digest }),
    );
    await writeFile(evidencePath, json(evidence));
    const registrations = before.projects.map((project) => ({
      projectId: `test-copy-${randomUUID()}`,
      workspace: project.root,
      dataDir: join(copyRoot, project.id, "state"),
      source: { kind: "cli" },
      defaultBinding: false,
    }));
    await mkdir(join(destination, "host/test-copies"), { recursive: true, mode: 0o700 });
    if (!registerProject) {
      const require = createRequire(new URL("../packages/client/package.json", import.meta.url));
      const { HostClient } = require("@areal/client/node");
      client = new HostClient();
      const isolatedUser = join(destination, "seed-copy/user");
      await mkdir(join(isolatedUser, ".areal"), { recursive: true, mode: 0o700 });
      const previousHome = process.env.HOME;
      try {
        process.env.HOME = isolatedUser;
        await client.connectOrStart(destination, resolve(binary));
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
      const descriptor = JSON.parse((await readOnly(join(destination, "host/host.json"))).bytes);
      evidence.host = {
        pid: descriptor.pid,
        hostId: descriptor.hostId,
        generation: descriptor.generation,
        descriptor: join(destination, "host/host.json"),
        home: destination,
        binary: resolve(binary),
        leftRunning: true,
      };
      await writeFile(evidencePath, json(evidence));
      registerProject = (requestId, registration) =>
        client.registerProject(requestId, registration);
    }
    for (const [index, registration] of registrations.entries()) {
      const requestId = randomUUID();
      const manifest = {
        version: 1,
        testCopy: true,
        sourceDigest: before.digest,
        sourceProjectId: before.projects[index].id,
        registration,
        registrationRequestId: requestId,
        status: "unknown",
        sanitizedFiles: evidence.sanitizedFiles.filter((entry) =>
          entry.path.startsWith(before.projects[index].id + sep),
        ),
      };
      const manifestPath = join(destination, "host/test-copies", registration.projectId + ".json");
      await writeFile(manifestPath, json(manifest), { mode: 0o600, flag: "wx" });
      evidence.projects.push(manifest);
      await writeFile(evidencePath, json(evidence));
      manifest.registrationResult = await registerProject(requestId, registration);
      if (client) manifest.receipt = await client.operation(requestId);
      manifest.status = "registered";
      await writeFile(manifestPath, json(manifest));
    }
    evidence.status = "complete";
    await writeFile(evidencePath, json(evidence));
    return evidence;
  } catch (error) {
    evidence.status = "incomplete";
    evidence.failure = error.message;
    await writeFile(
      marker,
      json({ testCopy: true, status: "incomplete", sourceDigest: evidence.sourceDigest }),
    );
    await writeFile(evidencePath, json(evidence));
    throw error;
  } finally {
    client?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { from: { type: "string" }, home: { type: "string" }, binary: { type: "string" } },
    });
    const result = await seedHostCopy(values);
    console.log(
      json({
        testCopy: true,
        status: result.status,
        sourceDigest: result.sourceDigest,
        projects: result.projects.length,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
