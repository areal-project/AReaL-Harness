import assert from "node:assert/strict";
import { makeTempDir } from "./support/temp.mjs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const creationOnly = process.argv.includes("--creation-only");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const scratch = await makeTempDir("aw-integration-");
const source = join(scratch, "source"),
  home = join(scratch, "desktop"),
  userHome = join(scratch, "user");
await mkdir(source);
await mkdir(join(userHome, ".areal"), { recursive: true });
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
git("init", "-b", "main");
await writeFile(join(source, "base.txt"), "committed base\n");
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-m",
  "fixture",
);
const base = git("rev-parse", "HEAD");
const checks = [],
  requests = [],
  errors = [];
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (body.messages?.[0]?.content?.startsWith("Generate a concise semantic session title")) {
      send({ content: "Worktree fixture" });
      send({}, "stop");
      response.end("data: [DONE]\n\n");
      return;
    }
    const messages = body.messages ?? [],
      lastUser = messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          /WT_[AB]_(file|shell|after)/.test(JSON.stringify(message.content)),
      );
    const content = messages[lastUser]?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const marker = text.match(/WT_([AB])_(file|shell|after)/);
    if (!marker) throw new Error("Unrecognized fixture input " + text);
    requests.push({
      owner: marker[1],
      kind: marker[2],
      model: body.model,
      hasTools: !!body.tools?.length,
    });
    if (messages.slice(lastUser + 1).some((message) => message.role === "tool"))
      send({ content: `WT_${marker[1]}_${marker[2]}_DONE` });
    else {
      const name = marker[2] === "shell" ? "run_command" : "fs_create";
      const args =
        name === "run_command"
          ? {
              command: `pwd > shell-cwd.txt; printf '${marker[1]}' > shell-output.txt`,
              timeoutMs: 10000,
              yieldMs: 10000,
            }
          : {
              path: marker[2] === "after" ? "after-restart.txt" : "file-tool.txt",
              text: marker[1],
            };
      assert.ok(
        body.tools.some((tool) => tool.function?.name === name),
        "real Core exposes requested fixture tool",
      );
      send({
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls");
      response.end("data: [DONE]\n\n");
      return;
    }
    send({}, "stop");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(error.stack);
    response.end();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(userHome, ".areal/config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "profile.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Use the requested tool once, then report its observed result.",
        allowThreadProcesses: true,
      },
    ],
  }),
);
const options = {
  binary: process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"),
  home,
  harnessHome: join(scratch, "registry"),
  userHome,
  desktopConfig: deployment,
  desktopProcesses: true,
  defaultProfile: { id: "fixture", revision: "v1" },
};
let backend = new CoreBackend(options),
  passed = false;
const until = async (predicate, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timeout " + label);
};
const projection = () => backend.snapshot().projects.find((project) => project.id === projectId);
const complete = async (threadId, turnId, label) => {
  assert.ok(turnId, "send must identify the admitted Turn");
  // 提交回执可能先于投影更新；只能等待本次 Turn，不能复用上一轮的完成状态。
  await until(
    () =>
      projection()?.state?.threads?.[threadId]?.turns?.find((turn) => turn.id === turnId)
        ?.status === "completed",
    label,
  );
};
let projectId, threads, directories;
try {
  await backend.init();
  projectId = await backend.addProject(source);
  const rejectedRequest = randomUUID();
  await assert.rejects(
    backend.command("create", {
      projectId,
      requestId: rejectedRequest,
      profile: { id: "missing-profile", revision: "v1" },
    }),
    (error) => error.submissionUnknown === false && error.outcome?.kind === "rejected",
  );
  assert.equal(
    projection().pending.length,
    0,
    "known configuration rejection leaves no pending creation",
  );
  assert.equal(
    (
      await backend.command("workspace", {
        projectId,
        operation: "worktreeRead",
        requestId: rejectedRequest,
      })
    ).state,
    "failed",
  );
  checks.push(
    "invalid creation configuration is rejected before acceptance and clears pending without replay",
  );
  const ids = [randomUUID(), randomUUID()];
  const create = (index) =>
    backend.command("create", {
      projectId,
      requestId: ids[index],
      options: { permissionPreset: "fullAccess" },
      ...(index === 1 ? { worktree: { mode: "worktree", ref: "main" } } : {}),
    });
  const ordinary = await Promise.all([
    create(0),
    backend.command("create", {
      projectId,
      requestId: randomUUID(),
      options: { permissionPreset: "fullAccess" },
    }),
  ]);
  for (const { threadId } of ordinary) {
    const thread = projection().state.threads[threadId];
    assert.equal(thread.cwd, source);
    assert.equal(thread.worktree, undefined);
    assert.equal(backend.worktrees.executionProjectId(projectId, threadId), projectId);
  }
  assert.equal(
    backend.saved.length,
    1,
    "ordinary concurrent creation registers no new execution host",
  );
  assert.equal(git("branch", "--show-current"), "main");
  assert.deepEqual(await create(0), ordinary[0]);
  checks.push(
    "concurrent ordinary conversations retain the selected directory, branch and Core with idempotent receipts",
  );
  const nonGit = join(scratch, "non-git");
  await mkdir(nonGit);
  const nonGitId = await backend.addProject(nonGit);
  for (let index = 0; index < 2; index++) {
    const result = await backend.command("create", {
      projectId: nonGitId,
      requestId: randomUUID(),
    });
    const thread = backend.snapshot().projects.find((project) => project.id === nonGitId).state
      .threads[result.threadId];
    assert.equal(thread.cwd, nonGit);
    assert.equal(thread.worktree, undefined);
  }
  const nonGitThreads = Object.keys(
    backend.snapshot().projects.find((project) => project.id === nonGitId).state.threads,
  );
  await assert.rejects(
    backend.command("create", {
      projectId: nonGitId,
      requestId: randomUUID(),
      worktree: { mode: "worktree" },
    }),
  );
  assert.deepEqual(
    Object.keys(
      backend.snapshot().projects.find((project) => project.id === nonGitId).state.threads,
    ),
    nonGitThreads,
  );
  checks.push(
    "non-Git directories allow two ordinary conversations and reject explicit Worktree creation without a replacement thread",
  );
  threads = [ordinary[0], await create(1)];
  assert.equal(new Set(threads.map((thread) => thread.threadId)).size, 2);
  assert.equal(
    backend.snapshot().projects.length,
    2,
    "execution hosts remain hidden in navigation",
  );
  const snapshots = threads.map(({ threadId }) => projection().state.threads[threadId]);
  directories = snapshots.map((thread) => thread.worktree?.directory ?? source);
  assert.equal(
    new Set(directories).size,
    2,
    "only the explicit Worktree creation allocates an independent checkout before model execution",
  );
  assert.equal(snapshots.filter((thread) => !thread.worktree).length, 1);
  for (const thread of snapshots) assert.equal(thread.cwd, thread.worktree?.directory ?? source);
  assert.deepEqual(
    await create(1),
    threads[1],
    "duplicate original request identifies one existing Thread",
  );
  await assert.rejects(
    backend.command("create", {
      projectId,
      requestId: ids[1],
      options: { permissionPreset: "ask" },
    }),
  );
  assert.equal(requests.length, 0, "creation, isolation and binding precede any model request");
  checks.push(
    "explicit Worktree creation retains an independent host, logical project aggregation and idempotent receipts",
  );
  if (!creationOnly) {
    for (const kind of ["file", "shell"]) {
      const submitted = await Promise.all(
        threads.map(({ threadId }, index) =>
          backend.command("send", { projectId, threadId, text: `WT_${index ? "B" : "A"}_${kind}` }),
        ),
      );
      await Promise.all(
        threads.map(({ threadId }, index) =>
          complete(threadId, submitted[index].turn?.id, `${kind} ${index}`),
        ),
      );
      for (let index = 0; index < threads.length; index++) {
        const items = projection().state.threads[threads[index].threadId].turns.find(
          (turn) => turn.id === submitted[index].turn.id,
        ).items;
        const toolSucceeded = items.some(
          (item) => item.type === "dynamicToolCall" && item.success === true,
        );
        if (!toolSucceeded) {
          const detail = JSON.stringify(items.filter((item) => item.type === "dynamicToolCall"));
          errors.push({ stage: kind, owner: index, detail });
          assert.fail(
            `Actual Core/Runtime tool did not complete successfully before file verification: ${detail}`,
          );
        }
        assert.equal(
          await readFile(
            join(directories[index], kind === "file" ? "file-tool.txt" : "shell-output.txt"),
            "utf8",
          ),
          index ? "B" : "A",
        );
        if (kind === "shell")
          assert.equal(
            (await readFile(join(directories[index], "shell-cwd.txt"), "utf8")).trim(),
            directories[index],
          );
      }
      checks.push(
        `real Core/Runtime ${kind} tools mutate matching relative paths only in their owning default checkout`,
      );
    }
    for (let index = 0; index < threads.length; index++) {
      const { threadId } = threads[index];
      const process = await backend.command("manage", {
        projectId,
        threadId,
        operation: "processStart",
        requestId: randomUUID(),
        lifetime: "thread",
        argv: [
          "/bin/sh",
          "-c",
          `pwd > managed-cwd.txt; printf '${index ? "B" : "A"}' > managed-output.txt`,
        ],
        cwd: directories[index],
        timeoutMs: 10000,
      });
      await backend.command("manage", {
        projectId,
        threadId,
        operation: "processWait",
        id: process.id,
        timeoutMs: 10000,
      });
      assert.equal(
        (await readFile(join(directories[index], "managed-cwd.txt"), "utf8")).trim(),
        directories[index],
      );
      assert.equal(
        await readFile(join(directories[index], "managed-output.txt"), "utf8"),
        index ? "B" : "A",
      );
      const cleanup = await backend.command("manage", {
        projectId,
        threadId,
        operation: "closeResources",
      });
      assert.equal(cleanup.cleanupConfirmed, true, "exited managed processes release their scope");
    }
    checks.push(
      "managed Thread-lifetime processes and process controls use the original physical host",
    );
    const isolatedIndex = snapshots.findIndex((thread) => thread.worktree);
    const isolated = threads[isolatedIndex];
    const read = await backend.command("workspace", {
      projectId,
      threadId: isolated.threadId,
      operation: "read",
      path: "base.txt",
    });
    assert.ok(JSON.stringify(read).includes("committed base"));
    assert.equal(git("rev-parse", "HEAD"), base, "source HEAD is unchanged");
    const before = projection().state.threads[isolated.threadId];
    assert.ok(
      before.worktreeEvents.some((event) => event.state === "ready"),
      "ready host event follows binding",
    );
    await backend.disconnect();
    backend = new CoreBackend(options);
    await backend.init();
    await backend.command("connect", { projectId });
    await backend.command("open", { projectId, threadId: isolated.threadId });
    const restored = projection().state.threads[isolated.threadId];
    assert.equal(restored.worktree.directory, directories[isolatedIndex]);
    assert.equal(restored.worktree.branch, before.worktree.branch);
    const resumed = await backend.command("send", {
      projectId,
      threadId: isolated.threadId,
      text: `WT_${isolatedIndex ? "B" : "A"}_after`,
    });
    await complete(isolated.threadId, resumed.turn?.id, "post-restart write");
    assert.equal(
      await readFile(join(directories[isolatedIndex], "after-restart.txt"), "utf8"),
      isolatedIndex ? "B" : "A",
    );
    checks.push(
      "desktop manager restart preserves Thread, history, branch, creation events and physical execution owner without moving the conversation",
    );
  }
  assert.deepEqual(errors, []);
  await backend.shutdown();
  passed = true;
} finally {
  if (!passed) {
    for (const project of backend.projects.values())
      await project.client?.request("areal/server/drain", { strategy: "cancel" }).catch(() => {});
    await backend.shutdown({ cancel: true }).catch(() => backend.disconnect());
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const manifest = {
    passed,
    scope: creationOnly
      ? "creation-only: no model or tool execution"
      : "full mutation and restart integration",
    platform: process.platform,
    node: process.version,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    binary: options.binary,
    binarySha256: createHash("sha256")
      .update(await readFile(options.binary))
      .digest("hex"),
    scratch,
    checks,
    requests,
    errors,
    threads,
    directories,
    limitations: [
      "Source Core/Runtime validation only; absolute paths and trusted external effects are not confined",
      "No Electron, package, signing or real provider account validation",
    ],
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }, null, 2));
}
