"use strict";

const assert = require("node:assert/strict");
const {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { ScopedResources } = require("../src/desktop/core/scoped-resources.cjs");

async function skill(base, id, body) {
  const root = join(base, id);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---\nname: ${id}\ndescription: ${body}\n---\n${body}\n`);
  return root;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "areal-scoped-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "desktop");
  const userHome = join(root, "user");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const project = { id: "project", root: workspace };
  const backend = {
    home,
    userHome,
    saved: [project],
    desktopConfig: join(home, "desktop-profile.json"),
    resourcesUpdating: false,
    providerUpdating: false,
    activeCommands: 0,
    starting: new Map(),
    onChange() {},
    async save(name, value) {
      await writeFile(join(home, name), JSON.stringify(value));
    },
  };
  const resources = new ScopedResources(backend);
  await resources.init();
  return { root, home, userHome, workspace, project, resources, backend };
}

test("discovers all compatible roots without requiring absent directories", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.resources.command({ operation: "skills", scope: "user" })).data, []);

  await skill(join(f.userHome, ".codex", "skills"), "shared", "codex");
  await skill(join(f.userHome, ".claude", "skills"), "shared", "claude");
  await skill(join(f.userHome, ".codex", "skills"), "namespace:skill", "namespaced");
  const standard = await skill(join(f.userHome, ".agents", "skills"), "shared", "standard");
  const legacy = await skill(join(f.home, "resources", "user", "skills"), "legacy", "private");

  const result = await f.resources.command({
    operation: "skills",
    scope: "user",
    projectId: f.project.id,
  });
  assert.deepEqual(
    result.data.map((item) => item.id),
    ["shared", "namespace:skill", "legacy"],
  );
  assert.equal(result.data.find((item) => item.id === "shared").root, await realpath(standard));
  assert.equal(result.data.find((item) => item.id === "shared").managed, false);
  assert.equal(result.data.find((item) => item.id === "legacy").root, await realpath(legacy));
  assert.equal(result.data.find((item) => item.id === "legacy").managed, true);
});

test("saves user and project Skills to the fixed .agents/skills roots", async (t) => {
  const f = await fixture(t);
  const projectState = await f.resources.command({
    operation: "skills",
    scope: "project",
    projectId: f.project.id,
  });
  await f.resources.command({
    operation: "skillSave",
    scope: "project",
    projectId: f.project.id,
    id: "project-only",
    name: "Project only",
    description: "Project skill",
    content: "Use the project workflow.",
    expectedRevision: projectState.revision,
  });
  const projectPath = join(f.workspace, ".agents", "skills", "project-only", "SKILL.md");
  assert.match(await readFile(projectPath, "utf8"), /Use the project workflow/);
  assert.equal(
    await readFile(
      join(f.home, "resources", f.project.id, "skills", "project-only", "SKILL.md"),
      "utf8",
    ).catch((e) => e.code),
    "ENOENT",
  );

  const userState = await f.resources.command({ operation: "skills", scope: "user" });
  await f.resources.command({
    operation: "skillSave",
    scope: "user",
    id: "user-only",
    name: "User only",
    description: "User skill",
    content: "Use the shared workflow.",
    expectedRevision: userState.revision,
  });
  const userPath = join(f.userHome, ".agents", "skills", "user-only", "SKILL.md");
  assert.match(await readFile(userPath, "utf8"), /Use the shared workflow/);
  assert.equal(
    await readFile(
      join(f.home, "resources", "user", "skills", "user-only", "SKILL.md"),
      "utf8",
    ).catch((e) => e.code),
    "ENOENT",
  );

  const discovered = await f.resources.command({
    operation: "skills",
    scope: "project",
    projectId: f.project.id,
  });
  assert.equal(
    discovered.data.find((item) => item.id === "project-only").root,
    await realpath(join(f.workspace, ".agents", "skills", "project-only")),
  );
  assert.equal(discovered.data.find((item) => item.id === "project-only").enabled, true);

  const reopened = new ScopedResources(f.backend);
  await reopened.init();
  assert.match(
    (
      await reopened.command({
        operation: "skillRead",
        scope: "project",
        projectId: f.project.id,
        id: "project-only",
      })
    ).content,
    /Use the project workflow/,
  );
  assert.match(
    (await reopened.command({ operation: "skillRead", scope: "user", id: "user-only" })).content,
    /Use the shared workflow/,
  );
  await assert.rejects(
    reopened.command({
      operation: "skillSave",
      scope: "project",
      projectId: f.project.id,
      id: "project-only",
      content: "replacement",
      expectedRevision: reopened.value.revision,
    }),
    /同名技能/,
  );
  assert.match(await readFile(projectPath, "utf8"), /Use the project workflow/);
});

test("project compatibility roots and invalid overrides retain their precedence", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.resources.scan(f.project.id), []);
  await skill(join(f.userHome, ".agents/skills"), "shared", "user");
  for (const [directory, body] of [
    [".agents/skills", "agents"],
    [".claude/skills", "claude"],
    [".codex/skills", "codex"],
    [`${f.home}/resources/${f.project.id}/skills`, "managed"],
  ]) {
    const root = directory.startsWith("/") ? directory : join(f.workspace, directory);
    await skill(root, "shared", body);
    await skill(root, body, body);
  }
  let listed = await f.resources.skills({ scope: "user", projectId: f.project.id });
  assert.equal(listed.data.find((s) => s.id === "shared").overridden, true);
  let local = await f.resources.scan(f.project.id);
  assert.equal(local.find((s) => s.id === "shared").description, "agents");
  assert.deepEqual(local.map((s) => s.id).sort(), [
    "agents",
    "claude",
    "codex",
    "managed",
    "shared",
  ]);
  await writeFile(join(f.workspace, ".agents/skills/shared/SKILL.md"), "---\nname: []\n---\n");
  local = await f.resources.scan(f.project.id);
  assert.ok(local.find((s) => s.id === "shared").error);
  assert.equal(local.find((s) => s.id === "shared").enabled, false);
  listed = await f.resources.skills({ scope: "user", projectId: f.project.id });
  assert.equal(listed.data.find((s) => s.id === "shared").overridden, true);
});

test("project write roots reject escaping links before creating directories", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.workspace, ".agents"));
  await assert.rejects(f.resources.writableRoot(f.project.id), /超出工作区/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await f.resources.scan(f.project.id), []);
  await mkdir(join(outside, "skills"));
  await assert.rejects(f.resources.scan(f.project.id), /超出工作区/);
});

test("user linked roots remain readable and receive new skills at the standard location", async (t) => {
  const f = await fixture(t);
  const outside = await skill(join(f.root, "external"), "linked", "linked body");
  const root = join(f.userHome, ".agents/skills");
  await mkdir(root, { recursive: true });
  await symlink(outside, join(root, "linked"));
  assert.equal((await f.resources.scan("user"))[0].root, await realpath(outside));
  assert.match(
    (await f.resources.command({ operation: "skillRead", scope: "user", id: "linked" })).content,
    /linked body/,
  );
  await f.resources.command({
    operation: "skillSave",
    scope: "user",
    id: "new",
    content: "new body",
    expectedRevision: 0,
  });
  assert.match(await readFile(join(root, "new/SKILL.md"), "utf8"), /new body/);
});

test("a fresh worktree discovers committed skills and keeps source-only skills local", async (t) => {
  const f = await fixture(t);
  const git = (...args) =>
    require("node:child_process").execFileSync("git", ["-C", f.workspace, ...args]);
  git("init", "--quiet");
  const standard = await skill(join(f.workspace, ".agents/skills"), "shared", "committed");
  await mkdir(join(standard, "references"));
  await writeFile(join(standard, "references/guide.md"), "supporting guide");
  git("add", ".agents");
  git(
    "-c",
    "user.email=test@localhost",
    "-c",
    "user.name=Fixture",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Skill fixture",
  );
  await skill(join(f.workspace, ".agents/skills"), "local-only", "untracked");
  const target = { id: "target", root: join(f.root, "worktree") };
  git("worktree", "add", "--quiet", "--detach", target.root, "HEAD");
  f.backend.saved.push(target);
  const found = await f.resources.scan(target.id);
  assert.deepEqual(
    found.map((s) => s.id),
    ["shared"],
  );
  assert.equal(found[0].root, await realpath(join(target.root, ".agents/skills/shared")));
  assert.equal(
    await readFile(join(found[0].root, "references/guide.md"), "utf8"),
    "supporting guide",
  );
});
