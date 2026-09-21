// 使用隔离的用户目录验证所有入口；模型 fixture 只返回工具调用，不运行第二套循环。
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnNative } from "../../scripts/native-child.mjs";
import { connect } from "./client.mjs";
import { fixture } from "./fixture.mjs";

const scratch = await mkdtemp(join(tmpdir(), "areal-skills-"));
const workspace = join(scratch, "workspace"),
  userDirectory = join(scratch, "user");
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug");
const model = await fixture();
const env = {
  ...process.env,
  HOME: userDirectory,
  AREAL_HARNESS_HOME: join(scratch, "harness-home"),
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  OTEL_SDK_DISABLED: "true",
};
const config = join(scratch, "config.toml"),
  deployment = join(scratch, "deployment.json");
const explicitRoot = join(scratch, "explicit-skill");
let child, client;

async function skill(directory, text) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${basename(directory)}\ndescription: Use ${basename(directory)} for skill discovery validation.\n---\n\n${text}`,
  );
}
async function assertSkillWarning(stderr) {
  const serviceLog = stderr.match(/Service log: ([^\r\n]+)/)?.[1];
  const diagnostic = serviceLog ? stderr + (await readFile(serviceLog, "utf8")) : stderr;
  assert.match(diagnostic, /skipping auto-discovered skill broken-skill/);
  assert.match(diagnostic, /invalid skill frontmatter/);
}
async function run(binary, args) {
  const process = spawnNative(join(bin, binary), args, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  process.stdout.on("data", (b) => (stdout += b));
  process.stderr.on("data", (b) => (stderr += b));
  const timer = setTimeout(() => process.kill("SIGKILL"), 45000);
  const [code] = await once(process, "exit");
  clearTimeout(timer);
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /SKILL_DISCOVERY_PASSED/);
  await assertSkillWarning(stderr);
  return stdout;
}
async function stop() {
  if (client) {
    await client.close();
    client = undefined;
  }
  if (child) {
    const process = child;
    child = undefined;
    if (process.exitCode === null) {
      const timer = setTimeout(() => process.kill("SIGKILL"), 15000);
      process.kill("SIGTERM");
      await once(process, "exit");
      clearTimeout(timer);
    }
    assert.equal(process.exitCode, 0);
  }
}
async function start(mode, state) {
  const ready = join(scratch, `ready-${crypto.randomUUID()}.json`);
  const args = [
    "--config",
    config,
    "--data-dir",
    state,
    "--desktop-config",
    deployment,
    "--listen",
    "127.0.0.1:0",
    "--ready-metadata-file",
    ready,
  ];
  child = spawnNative(
    join(bin, mode === "serve" ? "areal" : "areal-server"),
    mode === "serve" ? ["serve", "--desktop", "--workspace", workspace, ...args] : args,
    { cwd: workspace, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-32768)));
  const deadline = Date.now() + 30000;
  let metadata;
  while (!metadata) {
    try {
      metadata = JSON.parse(await readFile(ready, "utf8"));
    } catch {
      assert(child.exitCode === null && Date.now() < deadline, stderr);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  client = await connect(metadata.endpoint, metadata.authFile);
  await assertSkillWarning(stderr);
}
async function turn(threadId) {
  const { turn } = await client.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId,
    input: [{ type: "text", text: "skill-discovery" }],
  });
  const event = await client.waitEvent(
    "turn/completed",
    (p) => p.threadId === threadId && p.turn.id === turn.id,
  );
  assert.equal(event.turn.status, "completed", JSON.stringify(event));
  assert.equal(Object.keys((await client.call("areal/skill/list", { threadId })).loaded).length, 3);
}
try {
  await skill(join(userDirectory, ".agents/skills/global-only"), "GLOBAL_SKILL_BODY");
  await mkdir(join(userDirectory, ".agents/skills/global-only/references"));
  await writeFile(
    join(userDirectory, ".agents/skills/global-only/references/check.md"),
    "GLOBAL_REFERENCE",
  );
  await mkdir(join(userDirectory, ".agents/skills/global-only/assets"));
  await writeFile(
    join(userDirectory, ".agents/skills/global-only/assets/sample-style1-flat.png"),
    Buffer.alloc(320_819, 0x89),
  );
  await writeFile(
    join(userDirectory, ".agents/skills/global-only/assets/sample-style3-blueprint.png"),
    Buffer.alloc(263_578, 0x89),
  );
  await skill(join(userDirectory, ".agents/skills/broken-skill"), "broken");
  await writeFile(
    join(userDirectory, ".agents/skills/broken-skill/SKILL.md"),
    "---\nname: [invalid type]\n---\n",
  );
  await skill(join(userDirectory, ".agents/skills/review"), "GLOBAL_SHADOWED");
  await skill(join(workspace, ".agents/skills/review"), "PROJECT_SKILL_BODY");
  await skill(join(workspace, "sources/linked"), "LINKED_SKILL_BODY");
  await mkdir(join(workspace, ".claude/skills"), { recursive: true });
  await symlink("../../.agents/skills/review", join(workspace, ".claude/skills/review"));
  await symlink("../../sources/linked", join(workspace, ".claude/skills/linked"));
  await skill(explicitRoot, "EXPLICIT_SKILL_BODY");
  await writeFile(join(explicitRoot, "large.png"), Buffer.alloc(3 * 1024 * 1024, 0x89));
  await writeFile(
    config,
    `schema_version = 1\n[model]\nname = "fixture"\nprovider = "local"\n[model.providers.local]\nendpoint = "${model.endpoint}"\nprotocol = "chat-completions"\n`,
  );
  await writeFile(
    deployment,
    JSON.stringify({
      skills: [{ id: "explicit", revision: "v1", root: explicitRoot }],
      profiles: [
        {
          id: "restricted",
          revision: "v1",
          displayName: "Restricted",
          instructions: "",
          skills: [],
        },
        {
          id: "diagrams",
          revision: "v1",
          displayName: "Diagrams",
          instructions: "",
          skills: [{ id: "explicit", revision: "v1" }],
        },
      ],
    }),
  );
  for (const mode of ["serve", "core"]) {
    const state = join(scratch, `state-${mode}`);
    await start(mode, state);
    let threadId;
    for (const method of ["thread/start", "areal/thread/start"]) {
      const { thread } = await client.call(
        method,
        method.startsWith("areal/") ? { requestId: crypto.randomUUID() } : {},
      );
      threadId = thread.id;
      assert.equal(thread.desktop.configuration.profile.id, "areal-discovered-skills");
      assert.deepEqual((await client.call("areal/skill/list", { threadId })).loaded, {});
      await turn(threadId);
    }
    const { thread: restricted } = await client.call("areal/thread/start", {
      requestId: crypto.randomUUID(),
      agentProfile: { id: "restricted", revision: "v1" },
    });
    assert.deepEqual((await client.call("areal/skill/list", { threadId: restricted.id })).data, []);
    const { thread: diagrams } = await client.call("areal/thread/start", {
      requestId: crypto.randomUUID(),
      agentProfile: { id: "diagrams", revision: "v1" },
    });
    const explicitRead = {
      threadId: diagrams.id,
      skill: { id: "explicit", revision: "v1" },
      resource: "large.png",
      offset: 2 * 1024 * 1024,
      maxBytes: 8192,
    };
    const explicitImage = await client.call("areal/skill/read", explicitRead);
    assert.equal(explicitImage.sizeBytes, 3 * 1024 * 1024);
    assert.equal(Buffer.from(explicitImage.dataBase64, "base64").length, 8192);
    await writeFile(join(explicitRoot, "reference.txt"), `updated for ${mode}`);
    const currentRead = { ...explicitRead, resource: "reference.txt", offset: 0 };
    assert.equal((await client.call("areal/skill/read", currentRead)).text, `updated for ${mode}`);
    const { data } = await client.call("areal/skill/list", { threadId });
    assert(data.every((s) => s.resources === null && s.description.length > 0));
    const resource = "assets/sample-style1-flat.png";
    const image = await client.call("areal/skill/read", {
      threadId,
      skill: { id: data[0].id, revision: data[0].revision },
      resource,
      offset: 300_000,
      maxBytes: 16,
    });
    assert.equal(image.sizeBytes, 320_819);
    assert.equal(Buffer.from(image.dataBase64, "base64").length, 16);
    await assert.rejects(
      client.call("areal/skill/read", {
        threadId: restricted.id,
        skill: { id: data[0].id, revision: data[0].revision },
      }),
    );
    await stop();
    await start(mode, state);
    await client.call("thread/resume", { threadId });
    await client.call("thread/resume", { threadId: diagrams.id });
    assert.equal((await client.call("areal/skill/read", currentRead)).text, `updated for ${mode}`);
    await turn(threadId);
    await stop();
    console.log(JSON.stringify({ entry: mode, status: "passed", resume: true }));
  }
  const output = await run("areal", [
    "-p",
    "skill-discovery",
    "--config",
    config,
    "--workspace",
    workspace,
    "--desktop-config",
    deployment,
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
  ]);
  const session = JSON.parse(output).session_id;
  await run("areal", [
    "-p",
    "skill-discovery",
    "--resume",
    session,
    "--config",
    config,
    "--workspace",
    workspace,
    "--permission-mode",
    "bypassPermissions",
  ]);
  console.log(JSON.stringify({ entry: "cli", status: "passed", resume: true }));
  await run("areal-tui", [
    "--prompt",
    "skill-discovery",
    "--config",
    config,
    "--workspace",
    workspace,
    "--data-dir",
    join(scratch, "state-tui"),
  ]);
  console.log(JSON.stringify({ entry: "tui", status: "passed" }));
  assert.deepEqual(model.failures, []);
} finally {
  await stop();
  await model.close();
  await rm(scratch, { recursive: true, force: true });
}
