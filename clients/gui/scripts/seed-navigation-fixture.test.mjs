import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { makeTempDir } from "./support/temp.mjs";
import { createSeedNavigationFixture } from "./support/seed-navigation-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await makeTempDir("areal-seed-navigation-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original-source"),
    seedHome = join(root, "seed"),
    fixtureRoot = join(root, "isolated-gui");
  const copy = join(seedHome, "seed-copy/core");
  const first = "a".repeat(24),
    second = "b".repeat(24);
  const oldRoot = join(root, "original-workspace"),
    oldChild = join(root, "original-child");
  const safeRoot = join(fixtureRoot, "new-workspace");
  for (const path of [source, copy, oldRoot, oldChild, safeRoot])
    await mkdir(path, { recursive: true });
  const projects = [
    { id: first, root: oldRoot },
    {
      id: second,
      root: oldChild,
      logicalProjectId: first,
      worktreeResources: "do-not-copy",
      projectlessRequestId: "do-not-copy",
    },
  ];
  const index = JSON.stringify(projects);
  await writeFile(join(source, "projects.json"), index);
  await writeFile(join(copy, "projects.json"), index);
  const library = {
    projects: {
      [first]: {
        title: "Original project",
        pinned: true,
        threadOrder: ["old-thread"],
        worktreeEnvironments: [{ setup: "private script" }],
        navigationSummaries: [
          {
            id: "old-thread",
            name: "Original conversation",
            preview: "Visible navigation summary",
            createdAt: 10,
            desktop: { archived: false, privateScript: "drop" },
            credentials: "drop",
          },
        ],
      },
      [second]: { sectionId: "section" },
    },
    threads: {
      [`${first}:old-thread`]: {
        pinned: true,
        unread: true,
        sectionId: null,
        completionId: "old-turn",
        privateData: "drop",
      },
    },
    projectOrder: [second, first],
    sidebarThreadOrder: [`${first}:old-thread`],
    sections: [{ id: "section", title: "Original group", script: "drop" }],
    sidebarRevision: 9,
    settings: {
      sidebarSort: "manual",
      showPinned: true,
      httpProxy: "private proxy",
      worktrees: { autoCleanup: true },
      projectlessDirectory: "/real/path",
      hardwareAcceleration: false,
    },
  };
  await writeFile(join(source, "library.json"), JSON.stringify(library));
  const store = join(copy, first, "state");
  await mkdir(store, { recursive: true });
  const oldStore = JSON.stringify({ cwd: oldRoot, pending: [{ status: "UNKNOWN" }] });
  await writeFile(join(store, "old-thread.json"), oldStore);
  await writeFile(
    join(seedHome, "seed-copy/manifest.json"),
    JSON.stringify({
      testCopy: true,
      source,
      sourceDigest: "existing-source-digest",
      copyDigest: "completed-copy-digest",
      status: "incomplete",
      sourceSnapshot: [{ path: "projects.json", kind: "file", sha256: hash(index) }],
    }),
  );
  const safe = { id: hash(safeRoot).slice(0, 24), root: safeRoot };
  return {
    source,
    seedHome,
    fixtureRoot,
    projects,
    first,
    second,
    safe,
    store,
    oldStore,
    options: {
      seedHome,
      fixtureRoot,
      existingProjects: [safe],
      existingLibrary: { projects: { [safe.id]: { title: "Safe selected project" } } },
    },
  };
}

test("public navigation is copied onto isolated aliases without copying execution settings or changing UNKNOWN Store", async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.source, "library.json"));
  const result = await createSeedNavigationFixture(f.options);
  const aliases = new Map(result.mappings.map((item) => [item.sourceProjectId, item.projectId]));
  assert.deepEqual(
    result.projects[0],
    f.safe,
    "the existing selected project retains its identity",
  );
  assert.equal(result.importedProjects[1].logicalProjectId, aliases.get(f.first));
  assert.deepEqual(Object.keys(result.importedProjects[1]).sort(), [
    "id",
    "logicalProjectId",
    "root",
  ]);
  for (const item of result.importedProjects) {
    assert(item.root.startsWith(f.fixtureRoot + "/seed-navigation/"));
    assert(!f.projects.some((original) => original.root === item.root));
    assert.equal(item.id, hash(item.root).slice(0, 24));
    assert.deepEqual(
      await readdir(item.root),
      [],
      "placeholder has no copied Store or executable payload",
    );
  }
  assert.deepEqual(result.library.projectOrder, [aliases.get(f.second), aliases.get(f.first)]);
  assert.deepEqual(result.library.sidebarThreadOrder, [`${aliases.get(f.first)}:old-thread`]);
  assert.equal(result.library.threads[`${aliases.get(f.first)}:old-thread`].unread, true);
  assert.equal(
    result.library.threads[`${aliases.get(f.first)}:old-thread`].completionId,
    "old-turn",
  );
  assert.deepEqual(result.library.settings, { sidebarSort: "manual", showPinned: true });
  const cached = result.library.projects[aliases.get(f.first)].navigationSummaries[0];
  assert.equal(cached.id, "old-thread");
  assert.equal(cached.name, "Original conversation");
  assert.deepEqual(cached.desktop, { archived: false });
  const projected = JSON.stringify(result.library);
  for (const forbidden of [
    "httpProxy",
    "autoCleanup",
    "worktreeEnvironments",
    "privateScript",
    "credentials",
    "projectlessDirectory",
    "privateData",
    "hardwareAcceleration",
  ])
    assert(!projected.includes(forbidden), forbidden);
  assert.deepEqual(await readFile(join(f.source, "library.json")), original);
  assert.equal(await readFile(join(f.store, "old-thread.json"), "utf8"), f.oldStore);
  assert.equal(
    result.provenance.seedRegistrationStatus,
    "incomplete",
    "partial old registration remains explicitly unconfirmed",
  );
  assert.equal(result.provenance.originalThreadStoresCopied, false);
  assert.equal(result.provenance.originalUnknownRecordsChanged, false);
});

test("a fixture inside any original workspace is rejected before placeholder creation", async (t) => {
  const f = await fixture(t);
  const unsafe = join(f.projects[0].root, "unsafe-fixture");
  await mkdir(unsafe);
  await assert.rejects(
    createSeedNavigationFixture({ ...f.options, fixtureRoot: unsafe, existingProjects: [] }),
    /overlap an original workspace/,
  );
  assert.deepEqual(await readdir(unsafe), []);
});

test("source index drift invalidates seed provenance instead of rebinding old identities", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.source, "projects.json"),
    JSON.stringify([...f.projects, { id: "c".repeat(24), root: "/new-original" }]),
  );
  await assert.rejects(createSeedNavigationFixture(f.options), /drifted since seed-copy/);
  assert.deepEqual(await readdir(f.fixtureRoot), ["new-workspace"]);
});

test("missing optional navigation document fields use the existing empty sections and settings defaults", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.source, "library.json"),
    JSON.stringify({ projects: { [f.first]: { title: "Old title" } } }),
  );
  const result = await createSeedNavigationFixture(f.options);
  assert.deepEqual(result.library.sections, []);
  assert.deepEqual(result.library.settings, {});
  assert.deepEqual(result.library.sidebarThreadOrder, []);
  assert.equal(result.library.sidebarRevision, 0);
  assert.equal(result.provenance.summaryCount, 0);
});
