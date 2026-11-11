// 真实 Core/Runtime 的权限准入与读取协作；模型 fixture 不评价任务能力。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";

const root = await trackedMkdtemp(join(tmpdir(), "areal-delegation-permissions-"));
const evidence = resolve(process.env.AREAL_PERMISSION_EVIDENCE_DIR ?? root);
await mkdir(evidence, { recursive: true });
const marker = "public source evidence\n";
const outside = join(root, "outside.txt");
await writeFile(outside, "outside-private-sentinel\n");

function commandProbes() {
  const denied = current.mode === "read-only";
  return [
    { name: "custom-managed-tool", argv: ["managed-probe"] },
    ...["node", "npm", "pnpm", "rg"]
      .filter(
        (tool) =>
          process.platform === "darwin" &&
          ["/opt/homebrew/bin", "/usr/local/bin"].some((bin) => existsSync(join(bin, tool))),
      )
      .map((tool) => ({ name: `${tool}-version`, argv: [tool, "--version"] })),
    ...(process.platform === "darwin" && existsSync("/opt/homebrew/bin/node")
      ? [
          {
            name: "node-home-and-scratch",
            argv: [
              "node",
              "-e",
              'const fs=require("node:fs"),os=require("node:os");if(!os.homedir()||!os.tmpdir())process.exit(31);fs.writeFileSync(os.tmpdir()+"/node-probe","ok");console.log("node-scratch-ok")',
            ],
          },
        ]
      : []),
    { name: "git-version", argv: ["/usr/bin/git", "--version"] },
    {
      name: "git-read",
      argv: [
        "/bin/sh",
        "-c",
        "git status --porcelain && git diff --exit-code && git log -1 --format=%s",
      ],
    },
    {
      name: "bash-heredoc",
      argv: ["/bin/bash", "-c", "cat <<'END_PROBE'\nhere-doc-ok\nEND_PROBE"],
    },
    {
      name: "bash-large-heredoc",
      argv: ["/bin/bash", "-c", `wc -c <<'END_PROBE'\n${"x".repeat(20000)}\nEND_PROBE`],
    },
    {
      name: "scratch-write",
      argv: ["/bin/sh", "-c", 'printf scratch-ok > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"'],
    },
    { name: "source-write", argv: ["/bin/sh", "-c", "printf allowed > created.txt"], denied },
    {
      name: "git-write",
      argv: ["/usr/bin/git", "config", "--local", "areal.probe", "value"],
      denied,
    },
    { name: "outside-read", argv: ["/bin/cat", outside], denied },
    {
      name: "network",
      argv: [
        "/usr/bin/python3",
        "-c",
        `import socket; socket.create_connection(('127.0.0.1',${http.address().port}),1).close()`,
      ],
      denied,
    },
  ];
}
const probe =
  process.platform === "linux"
    ? spawnSync(
        "/usr/bin/bwrap",
        [
          "--unshare-all",
          "--die-with-parent",
          "--cap-drop",
          "ALL",
          "--ro-bind",
          "/",
          "/",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--",
          "/bin/true",
        ],
        {
          timeout: 5000,
        },
      )
    : spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
        timeout: 5000,
      });
assert(!probe.signal, "sandbox probe did not settle");
const restrictedAvailable = probe.status === 0;
const results = [];
let service,
  http,
  current,
  modelError,
  sequence = 0,
  failed = false;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function response(output, name, args, text = "done") {
  output.writeHead(200, { "content-type": "text/event-stream" });
  const delta = name
    ? {
        tool_calls: [
          {
            index: 0,
            id: `permission-${++sequence}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { content: text };
  output.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  output.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\n`,
  );
  output.end("data: [DONE]\n\n");
}

http = createServer(async (request, output) => {
  try {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const input = JSON.parse(bytes);
    const users = input.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const tools = input.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    current.requests++;
    if (users.includes("PERMISSION_WORKER")) {
      current.childRequests++;
      if (!tools.length) return response(output, "read_file", { path: "preserved.txt" });
      assert(JSON.stringify(tools[0]).includes(marker.trim()), JSON.stringify(tools[0]));
      // 先证明可信读取不占写租约，再执行需要申请租约的命令，避免测试自身造成互等。
      if (current.mode === "inherit") await current.parentRead;
      const probes = commandProbes();
      const last = tools.at(-1);
      if (tools.length > 1) {
        assert(last.processId, JSON.stringify(last));
        if (!last.outputClosed) {
          current.processReads++;
          assert(current.processReads <= probes.length * 5, "process observation did not settle");
          return response(output, "read_process", { processId: last.processId, waitMs: 1000 });
        }
      }
      const completed = new Set(tools.slice(1).map((tool) => tool.processId)).size;
      if (completed < probes.length) {
        return response(output, "run_command", {
          argv: probes[completed].argv,
          timeoutMs: 3000,
          yieldMs: probes[completed].name === "custom-managed-tool" ? 10 : 1000,
        });
      }
      return response(output, null, null, "verified public source evidence; inspection report");
    }
    assert(users.includes("PERMISSION_PARENT"), users);
    if (!tools.length)
      return response(output, "agent_spawn", {
        prompt:
          "PERMISSION_WORKER: inspect preserved.txt and return evidence; do not modify source",
        intent: "inspect",
        delivery: "report",
      });
    const execution = tools[0];
    assert(execution.executionId, JSON.stringify(execution));
    if (!restrictedAvailable && current.mode === "read-only") {
      assert.equal(execution.status, "failed", JSON.stringify(execution));
      assert.equal(current.childRequests, 0);
      if (tools.length === 1) return response(output, "fs_read", { path: "preserved.txt" });
      assert(JSON.stringify(tools[1]).includes(marker.trim()));
      return response(
        output,
        null,
        null,
        "restricted child rejected before model; parent read succeeded",
      );
    }
    assert.equal(
      execution.strategy,
      current.mode === "inherit" ? "sharedInherited" : "sharedReadOnly",
    );
    if (tools.length === 1 && current.mode === "inherit") {
      return response(output, "fs_read", { path: "preserved.txt" });
    }
    if (tools.length === 2 && current.mode === "inherit") {
      assert(JSON.stringify(tools[1]).includes(marker.trim()));
      current.releaseParentRead();
    }
    const waitIndex = current.mode === "inherit" ? 2 : 1;
    if (tools.length === waitIndex)
      return response(output, "agent_wait", {
        executionId: execution.executionId,
        timeoutMs: 10000,
      });
    assert.equal(tools[waitIndex].status, "completed", JSON.stringify(tools[waitIndex]));
    return response(output, null, null, "inspection evidence integrated");
  } catch (error) {
    modelError ??= error;
    output.destroy(error);
  }
});
http.listen(0, "127.0.0.1");
await once(http, "listening");

async function stop() {
  if (!service) return;
  await service.rpc?.close().catch(() => {});
  service.child.kill("SIGTERM");
  const timer = setTimeout(() => service.child.kill("SIGKILL"), 10000);
  const [code] = await service.exited;
  clearTimeout(timer);
  await writeFile(join(evidence, `${current.mode}.stderr.log`), service.stderr);
  assert.equal(code, 0, service.stderr.slice(-4000));
  service = undefined;
}

async function run(mode) {
  const dir = join(root, mode);
  const workspace = join(dir, "workspace"),
    data = join(dir, "data"),
    scratch = join(dir, "scratch");
  await mkdir(workspace, { recursive: true });
  await mkdir(scratch);
  await writeFile(join(workspace, "preserved.txt"), marker);
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const args of [
    ["init", "--quiet"],
    ["add", "preserved.txt"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "public-fixture",
    ],
  ]) {
    const result = spawnSync("/usr/bin/git", args, { cwd: workspace, env: gitEnv });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const originalIndex = await readFile(join(workspace, ".git/index"));
  const originalConfig = await readFile(join(workspace, ".git/config"));
  const manager = join(dir, "custom-node-manager");
  const installed = join(manager, "versions/node/v22.1.0");
  await mkdir(join(installed, "bin"), { recursive: true });
  await mkdir(join(installed, "lib"), { recursive: true });
  await mkdir(join(manager, "alias"), { recursive: true });
  await mkdir(join(dir, "user"), { recursive: true });
  await writeFile(join(manager, "alias/default"), "22\n");
  await writeFile(join(installed, "lib/resource"), "managed-tool-ok\n");
  await writeFile(
    join(installed, "bin/managed-probe"),
    `#!/bin/sh\nsleep 0.05\ncat '${installed}/lib/resource'\n`,
  );
  await chmod(join(installed, "bin/managed-probe"), 0o755);
  const config = join(dir, "config.toml");
  await writeFile(
    config,
    `schema_version=2\n[delegation]\ninspection_permissions="${mode}"\n[model]\nmax_retries=0\n[network]\nretry_mode="bounded"\n`,
  );
  current = { mode, requests: 0, childRequests: 0, processReads: 0 };
  current.parentRead = new Promise((done) => (current.releaseParentRead = done));
  const child = spawn(
    "python3",
    [
      "scripts/launch.py",
      "--config",
      config,
      "--bin-dir",
      resolve(process.env.AREAL_PERMISSION_BIN_DIR ?? "target/debug"),
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--workspace",
      workspace,
      "--scratch",
      scratch,
      "--allow-write",
      "--allow-network",
      "--sandbox-profile",
      "full-access",
      "--permissions",
      "yolo",
      "--model-endpoint",
      `http://127.0.0.1:${http.address().port}/`,
      "--model",
      "fixture",
      "--model-concurrency",
      "3",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : process.env.PATH,
        HOME: join(dir, "user"),
        NVM_DIR: manager,
        AREAL_HARNESS_HOME: join(dir, "home"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  );
  const owned = { child, exited: once(child, "exit"), stderr: "" };
  service = owned;
  child.stdout.resume();
  child.stderr.on("data", (bytes) => (owned.stderr += bytes));
  let endpoint;
  for (let n = 0; n < 300; n++) {
    endpoint = service.stderr.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (endpoint) break;
    assert.equal(child.exitCode, null, service.stderr);
    await pause(50);
  }
  assert(endpoint, service.stderr);
  service.rpc = await connect(endpoint, join(data, "security/auth.json"));
  const { thread } = await service.rpc.call("thread/start");
  const { turn } = await service.rpc.call("turn/start", {
    threadId: thread.id,
    input: [
      {
        type: "text",
        text: "PERMISSION_PARENT: delegate a bounded source inspection and integrate its report",
      },
    ],
  });
  const event = await service.rpc.waitEvent(
    "turn/completed",
    (e) => e.threadId === thread.id && e.turn.id === turn.id,
  );
  assert.equal(modelError, undefined, modelError?.stack);
  assert.equal(event.turn.status, "completed", JSON.stringify(event));
  assert.equal(
    await readFile(join(workspace, "preserved.txt"), "utf8"),
    marker,
    "inspection changed source",
  );
  const { data: executions } = await service.rpc.call("areal/execution/list", {
    parentThreadId: thread.id,
  });
  assert.equal(executions.length, 1);
  const rejected = mode === "read-only" && !restrictedAvailable;
  assert.equal(executions[0].status, rejected ? "failed" : "completed");
  const probes = commandProbes();
  assert.equal(current.childRequests, rejected ? 0 : probes.length + 2 + current.processReads);
  if (!rejected)
    assert(current.processReads > 0, "fixture must exercise asynchronous process reads");
  const observations = [];
  if (!rejected) {
    const { thread: childHistory } = await service.rpc.call("thread/read", {
      threadId: executions[0].threadId,
      includeTurns: true,
    });
    await writeFile(
      join(evidence, `${mode}.child-history.json`),
      JSON.stringify(childHistory, null, 2),
    );
    const calls = childHistory.turns[0].items.filter((item) => item.type === "dynamicToolCall");
    assert.equal(calls[0].tool, "read_file");
    assert.equal(calls[0].success, true);
    let cursor = 1;
    for (const probe of probes) {
      let call = calls[cursor++];
      assert.equal(call.tool, "run_command");
      assert.equal(call.execution.backend, "runtime");
      const decode = (item) =>
        JSON.parse(item.contentItems.find((c) => c.type === "inputText").text);
      let result = decode(call);
      const processId = result.processId;
      let stdout = result.stdout ?? "",
        stderr = result.stderr ?? "";
      // yield 只结束等待；继续回取同一进程，不重跑命令或放宽超时。
      while (!result.outputClosed) {
        call = calls[cursor++];
        assert.equal(call.tool, "read_process");
        result = decode(call);
        assert.equal(result.processId, processId);
        stdout += result.stdout ?? "";
        stderr += result.stderr ?? "";
      }
      result = { ...result, stdout, stderr };
      assert.equal(
        result.exitCode === 0,
        !probe.denied,
        `${mode} ${probe.name}: ${JSON.stringify(result)}`,
      );
      assert.equal(call.success, !probe.denied);
      if (probe.name === "bash-heredoc") assert.match(result.stdout, /here-doc-ok/);
      if (probe.name === "bash-large-heredoc") assert.match(result.stdout, /20001/);
      if (probe.name === "git-read") assert.match(result.stdout, /public-fixture/);
      observations.push({
        name: probe.name,
        expected: probe.denied ? "denied" : "allowed",
        ...result,
      });
    }
    if (mode === "read-only") {
      assert.deepEqual(await readFile(join(workspace, ".git/index")), originalIndex);
      assert.deepEqual(await readFile(join(workspace, ".git/config")), originalConfig);
    }
    assert.equal(cursor, calls.length, "probe command was repeated or left unsettled");
  }
  // 父任务 ToolOutcome 必须如实区分创建拒绝与读取失败子任务的成功操作。
  const { thread: history } = await service.rpc.call("thread/read", {
    threadId: thread.id,
    includeTurns: true,
  });
  const spawnItem = history.turns[0].items.find(
    (item) => item.type === "dynamicToolCall" && item.tool === "agent_spawn",
  );
  assert.equal(spawnItem.success, !rejected);
  results.push({
    probes: observations,
    mode,
    restrictedAvailable,
    requests: current.requests,
    childRequests: current.childRequests,
    executionStatus: executions[0].status,
    sourcePreserved: true,
    parentCompleted: true,
  });
  await writeFile(join(evidence, `${mode}.history.json`), JSON.stringify(history, null, 2));
  await stop();
  console.log(
    `PASS ${mode}: restrictedAvailable=${restrictedAvailable}, childRequests=${current.childRequests}, parent completed, source preserved`,
  );
}

try {
  await run("read-only");
  await run("inherit");
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(
      {
        platform: process.platform,
        results,
        liveModelRequests: 0,
        sandboxProbe: { status: probe.status, stderr: probe.stderr?.toString() },
      },
      null,
      2,
    ),
  );
} catch (error) {
  failed = true;
  console.error(modelError?.stack ?? error.stack);
  console.error(service?.stderr.slice(-4000) ?? "");
  throw error;
} finally {
  current?.releaseParentRead?.();
  await stop().catch(() => {});
  http.closeAllConnections();
  await new Promise((done) => http.close(done));
  if (!failed && evidence !== root) await rm(root, { recursive: true, force: true });
}
