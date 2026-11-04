import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedHostCopy } from "./seed-host-copy.mjs";

const sourceId = "1".repeat(24);
const emptyId = "2".repeat(24);
const threadId = "11111111-1111-4111-8111-111111111111";

async function fixture(t, items = [{ id: "finished", status: "completed" }]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "areal-seed-copy-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = join(root, "source");
  const home = join(root, "isolated-host");
  const workspace = join(root, "real-workspace");
  const state = join(from, sourceId, "state");
  await mkdir(state, { recursive: true });
  await mkdir(workspace);
  await writeFile(
    join(from, "projects.json"),
    JSON.stringify([
      { id: sourceId, root: workspace },
      { id: emptyId, root: workspace },
    ]),
  );
  const record = {
    thread: {
      id: threadId,
      cwd: workspace,
      status: { type: "unknown" },
      turns: [{ id: "historical-turn", status: "unknown" }],
      goals: { goal: { status: "active" } },
      desktop: {
        queue: { revision: 9, paused: true, items },
        processes: [{ state: "unknown" }],
        hookRuns: [{ delivered: false }],
      },
    },
  };
  const threadPath = join(state, threadId + ".json");
  const threadBytes = Buffer.from(JSON.stringify(record, null, 4) + "\n");
  await writeFile(threadPath, threadBytes);
  for (const path of ["history/thread", "blobs", "goals/requests"])
    await mkdir(join(state, path), { recursive: true });
  const assets = new Map([
    ["history/thread/page.json", Buffer.from('{"historical":"exact"}\n')],
    ["blobs/image", Buffer.from([0, 255, 17, 3])],
    ["goals/requests/goal.json", Buffer.from('{"goal":"history"}')],
  ]);
  for (const [path, bytes] of assets) await writeFile(join(state, path), bytes);
  for (const path of [
    "queue/pending",
    "pending",
    "outcomes",
    "desktop/task-mode",
    "desktop/task-ledger",
  ]) {
    await mkdir(join(state, path), { recursive: true });
    await writeFile(join(state, path, "secret.json"), "do-not-copy");
  }
  for (const path of [
    "credentials.json",
    "providers.json",
    "config.toml",
    "mobile-pairing.json",
    "remote.json",
    "owner.lock",
  ])
    await writeFile(join(state, path), "do-not-copy");
  await writeFile(join(from, "config.toml"), "do-not-copy");
  return {
    root,
    from,
    home,
    state,
    threadPath,
    threadBytes,
    workspace,
    assets,
    options: { from, home, binary: join(root, "explicit-packaged-areal") },
  };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("copies supported history bytes before registration and leaves original workspaces and source unchanged", async (t) => {
  const f = await fixture(t);
  const sourceIndex = await readFile(join(f.from, "projects.json"));
  const seen = [];
  const evidence = await seedHostCopy(f.options, {
    registerProject: async (requestId, registration) => {
      const current = await readJson(join(f.home, "seed-copy/manifest.json"));
      assert.equal(current.status, "copied");
      assert.equal(
        (await readJson(join(f.home, "seed-copy/core/.areal-test-copy.json"))).testCopy,
        true,
      );
      assert.deepEqual(
        await readFile(join(f.home, "seed-copy/core", sourceId, "state", threadId + ".json")),
        f.threadBytes,
      );
      assert.equal(registration.workspace, f.workspace);
      assert.deepEqual(registration.source, { kind: "cli" });
      assert.equal(registration.defaultBinding, false);
      assert.match(registration.projectId, /^test-copy-[a-f0-9-]{36}$/);
      assert.match(requestId, /^[a-f0-9-]{36}$/);
      seen.push(registration);
      return { registration, created: true };
    },
  });
  assert.equal(evidence.status, "complete");
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].projectId, seen[1].projectId);
  assert.equal(
    evidence.projects[0].registration.dataDir,
    join(f.home, "seed-copy/core", sourceId, "state"),
  );
  const copiedState = join(f.home, "seed-copy/core", sourceId, "state");
  assert.deepEqual(
    (await readdir(copiedState)).sort(),
    [threadId + ".json", "blobs", "goals", "history"].sort(),
  );
  for (const [path, bytes] of f.assets)
    assert.deepEqual(await readFile(join(copiedState, path)), bytes);
  assert.deepEqual(await readFile(f.threadPath), f.threadBytes);
  assert.deepEqual(await readFile(join(f.from, "projects.json")), sourceIndex);
  assert.deepEqual(await readFile(join(f.home, "seed-copy/core/projects.json")), sourceIndex);
  assert.deepEqual(evidence.sanitizedFiles, []);
  for (const project of evidence.projects) {
    const manifest = await readJson(
      join(f.home, "host/test-copies", project.registration.projectId + ".json"),
    );
    assert.equal(manifest.testCopy, true);
    assert.equal(manifest.sourceDigest, evidence.sourceDigest);
    assert.equal(manifest.sourceProjectId, project.sourceProjectId);
    assert.equal(manifest.status, "registered");
  }
});

test("removes only pending and running queue submissions in copies, retaining terminal and UNKNOWN history", async (t) => {
  const f = await fixture(
    t,
    ["pending", "running", "completed", "steered", "removed", "unknown"].map((status) => ({
      id: status,
      status,
    })),
  );
  const evidence = await seedHostCopy(f.options, {
    registerProject: async (_id, registration) => ({ registration }),
  });
  const copied = await readJson(
    join(f.home, "seed-copy/core", sourceId, "state", threadId + ".json"),
  );
  const original = JSON.parse(f.threadBytes);
  assert.deepEqual(
    copied.thread.desktop.queue.items.map((item) => item.status),
    ["completed", "steered", "removed", "unknown"],
  );
  copied.thread.desktop.queue.items = original.thread.desktop.queue.items;
  assert.deepEqual(copied, original);
  assert.deepEqual(await readFile(f.threadPath), f.threadBytes);
  assert.equal(evidence.sanitizedFiles.length, 1);
  assert.deepEqual(
    evidence.sanitizedFiles[0].removedQueueItems.map((item) => item.status),
    ["pending", "running"],
  );
  assert.notEqual(evidence.sanitizedFiles[0].sourceSha256, evidence.sanitizedFiles[0].copiedSha256);
});

test("rejects target overlaps, existing directories, and the OS user's live home despite overwritten HOME", async (t) => {
  const f = await fixture(t);
  const previousHome = process.env.HOME;
  process.env.HOME = join(f.root, "fake-user");
  try {
    for (const home of [
      f.from,
      join(f.from, "nested"),
      f.root,
      join(userInfo().homedir, ".areal"),
      join(userInfo().homedir, ".areal", "test-copy"),
    ]) {
      await assert.rejects(
        seedHostCopy(
          { ...f.options, home },
          { registerProject: async () => assert.fail("must not register") },
        ),
        /overlap|fresh|live user data/,
      );
    }
    await mkdir(f.home);
    await assert.rejects(seedHostCopy(f.options), /fresh/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("rejects source resource symlinks and preserves marked incomplete evidence", async (t) => {
  const f = await fixture(t);
  await symlink(f.workspace, join(f.state, "blobs", "escape"));
  let calls = 0;
  await assert.rejects(
    seedHostCopy(f.options, { registerProject: async () => calls++ }),
    /symlink/,
  );
  assert.equal(calls, 0);
  assert.equal((await readJson(join(f.home, "seed-copy/manifest.json"))).status, "incomplete");
  assert.equal(
    (await readJson(join(f.home, "seed-copy/core/.areal-test-copy.json"))).testCopy,
    true,
  );
});

test("rejects a symlink target into live user data", async (t) => {
  const f = await fixture(t);
  const actualHome = await realpath(userInfo().homedir);
  await symlink(actualHome, join(f.root, "user-alias"));
  await assert.rejects(
    seedHostCopy({ ...f.options, home: join(f.root, "user-alias/.areal/test-copy") }),
    /live user data/,
  );
});

test("rejects special files inside selected Store assets", async (t) => {
  const f = await fixture(t);
  execFileSync("mkfifo", [join(f.state, "blobs", "special")]);
  await assert.rejects(
    seedHostCopy(f.options, { registerProject: async () => assert.fail("must not register") }),
    /special file/,
  );
});

test("rejects a selected directory replaced by an escaping symlink during copy", async (t) => {
  const f = await fixture(t);
  const originalPage = await readFile(join(f.state, "history/thread/page.json"));
  const outside = join(f.root, "outside");
  await mkdir(join(outside, "thread"), { recursive: true });
  await writeFile(join(outside, "thread/page.json"), originalPage);
  await assert.rejects(
    seedHostCopy(f.options, {
      beforeCopy: async () => {
        await rm(join(f.state, "history"), { recursive: true });
        await symlink(outside, join(f.state, "history"));
      },
      registerProject: async () => assert.fail("must not register"),
    }),
    /symlink/,
  );
  assert.deepEqual(await readFile(join(outside, "thread/page.json")), originalPage);
});

test("detects selected-file drift without starting Host or retrying", async (t) => {
  const f = await fixture(t);
  let callbacks = 0;
  let registrations = 0;
  await assert.rejects(
    seedHostCopy(f.options, {
      beforeCopy: async () => {
        callbacks++;
        await writeFile(
          f.threadPath,
          Buffer.from(f.threadBytes.toString().replace("historical-turn", "different-turn")),
        );
      },
      registerProject: async () => registrations++,
    }),
    /Source drift/,
  );
  assert.equal(callbacks, 1);
  assert.equal(registrations, 0);
  assert.equal((await readJson(join(f.home, "seed-copy/manifest.json"))).status, "incomplete");
  await assert.rejects(seedHostCopy(f.options), /fresh/);
});

test("detects added selected assets using the complete after-copy inventory", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    seedHostCopy(f.options, {
      beforeCopy: () => writeFile(join(f.state, "blobs/new-asset"), "new"),
      registerProject: async () => assert.fail("must not register"),
    }),
    /Source drift/,
  );
});

test("preserves UNKNOWN registration evidence on a lost response without replay or cleanup", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    seedHostCopy(f.options, {
      registerProject: async () => {
        calls++;
        throw new Error("lost response");
      },
    }),
    /lost response/,
  );
  assert.equal(calls, 1);
  const evidence = await readJson(join(f.home, "seed-copy/manifest.json"));
  assert.equal(evidence.status, "incomplete");
  assert.equal(evidence.projects.length, 1);
  assert.equal(evidence.projects[0].status, "unknown");
  const manifest = await readJson(
    join(f.home, "host/test-copies", evidence.projects[0].registration.projectId + ".json"),
  );
  assert.equal(manifest.registrationRequestId, evidence.projects[0].registrationRequestId);
  assert.equal(manifest.status, "unknown");
  assert.deepEqual(
    await readFile(join(f.home, "seed-copy/core", sourceId, "state", threadId + ".json")),
    f.threadBytes,
  );
});
