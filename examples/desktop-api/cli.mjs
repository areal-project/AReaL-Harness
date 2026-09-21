import assert from "node:assert/strict";
import { spawnNative } from "../../scripts/native-child.mjs";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture } from "./fixture.mjs";
const consumer = JSON.parse(
  await readFile(new URL("./fixtures/multica-consumer.json", import.meta.url), "utf8"),
);
const daemonInput = await readFile(
  new URL("./fixtures/claude-daemon-input.jsonl", import.meta.url),
  "utf8",
);
const root = await mkdtemp(join(tmpdir(), "areal-cli-test-")),
  workspace = join(root, "workspace"),
  home = join(root, "home");
await mkdir(workspace);
await mkdir(home);
const model = await fixture();
const config = join(root, "config.toml");
await writeFile(
  config,
  `schema_version = 1\n[model]\nname = "fixture"\nprovider = "local"\n[model.providers.local]\nendpoint = "${model.endpoint}"\nprotocol = "chat-completions"\n`,
);
const binary = process.env.AREAL_TEST_BIN_DIR
  ? resolve(process.env.AREAL_TEST_BIN_DIR, "areal")
  : resolve("target/debug/areal");
const all = [];
async function run(
  extra,
  input,
  { open = false, control, signal, env = {}, cwd = workspace, brokenPipe = false } = {},
) {
  const child = spawnNative(
    binary,
    [...consumer.fixedArgs, "-p", "--config", config, "--workspace", cwd, ...extra],
    {
      cwd,
      env: { ...process.env, HOME: join(root, "user"), AREAL_HARNESS_HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    buffer = "";
  const frames = [];
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    for (;;) {
      const n = buffer.indexOf("\n");
      if (n < 0) break;
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      try {
        const frame = JSON.parse(line);
        frames.push(frame);
        if (brokenPipe && frame.type === "stream_event") {
          child.stdout.destroy();
          brokenPipe = false;
        }
        if (frame.type === "control_request") control?.(frame, child);
        if (signal && frame.type === "stream_event" && frame.event.type === "content_block_delta") {
          child.kill(signal);
          signal = null;
        }
      } catch {}
    }
  });
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  if (open) child.stdin.write(input);
  else child.stdin.end(input ?? "");
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  // 消费 Claude Code 原有消息；禁止重新加入 AReaL 协议标识或私有终态。
  for (const frame of frames) {
    assert(!Object.hasOwn(frame, "areal"));
    assert(!Object.hasOwn(frame, "compatibilityVersion"));
    assert(
      [
        "system",
        "assistant",
        "user",
        "stream_event",
        "result",
        "control_request",
        "control_response",
      ].includes(frame.type),
      "unexpected Claude Code message type",
    );
    if (!["control_request", "control_response"].includes(frame.type)) {
      assert.equal(typeof frame.session_id, "string");
      assert.match(frame.uuid, /^[a-f0-9-]{36}$/);
    }
    if (frame.type === "system") {
      assert.equal(frame.subtype, "init");
      assert.equal(typeof frame.cwd, "string");
      assert.equal(typeof frame.model, "string");
      assert(frame.tools.every((tool) => typeof tool === "string"));
    }
    if (frame.type === "assistant" || frame.type === "user") {
      assert.equal(frame.message.role, frame.type);
      assert.equal(frame.parent_tool_use_id, null);
      for (const block of frame.message.content) {
        if (block.type === "text") assert.equal(typeof block.text, "string");
        else if (block.type === "tool_use") {
          assert.equal(typeof block.id, "string");
          assert.equal(typeof block.name, "string");
          assert.equal(typeof block.input, "object");
        } else {
          assert.equal(block.type, "tool_result");
          assert.equal(typeof block.tool_use_id, "string");
          assert.equal(typeof block.is_error, "boolean");
        }
      }
    }
    if (frame.type === "control_request") {
      assert.equal(typeof frame.request_id, "string");
      assert.equal(frame.request.subtype, "can_use_tool");
      assert.equal(typeof frame.request.tool_use_id, "string");
      assert.equal(typeof frame.request.tool_name, "string");
      assert.equal(typeof frame.request.input, "object");
    }
    if (frame.type === "result") {
      assert.equal(typeof frame.session_id, "string");
      assert.equal(typeof frame.uuid, "string");
      assert.equal(typeof frame.num_turns, "number");
      if (frame.is_error) {
        assert(["error_during_execution", "error_max_turns"].includes(frame.subtype));
        assert(frame.errors.length > 0 && frame.errors.every((e) => typeof e === "string"));
        assert(!Object.hasOwn(frame, "result"));
      } else {
        assert.equal(frame.subtype, "success");
        assert.equal(typeof frame.result, "string");
      }
    }
  }
  all.push({ code, frames });
  return { code, frames, stdout, stderr };
}
try {
  const probe = spawnNative(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let version = "";
  probe.stdout.on("data", (bytes) => (version += bytes));
  const [probeCode] = await once(probe, "exit");
  assert.equal(probeCode, 0);
  assert.match(version, /^areal /);
  assert.deepEqual(consumer.fixedArgs, []);
  const help = spawnNative(binary, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
  let helpText = "";
  help.stdout.on("data", (bytes) => (helpText += bytes));
  const [helpCode] = await once(help, "exit");
  assert.equal(helpCode, 0);
  assert(!helpText.includes("--protocol"));
  assert.match(helpText, /--print/);
  let r = await run(
    [
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--disallowedTools",
      "AskUserQuestion",
    ],
    "hello",
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  const session = r.frames.find((f) => f.type === "result").session_id;
  assert(r.frames.some((f) => f.type === "stream_event"));
  assert.equal(r.frames.filter((f) => f.type === "result").length, 1);
  const stream = r.frames.filter((f) => f.type === "stream_event").map((f) => f.event);
  assert.equal(stream[0].type, "message_start");
  assert.equal(stream[1].type, "content_block_start");
  assert.equal(stream.at(-2).type, "content_block_stop");
  assert.equal(stream.at(-1).type, "message_stop");
  assert.equal(
    stream
      .filter((e) => e.type === "content_block_delta")
      .map((e) => e.delta.text)
      .join(""),
    r.frames.find((f) => f.type === "assistant").message.content[0].text,
  );
  if (process.env.AREAL_CLI_TRANSCRIPT) {
    const transcript = r.frames.map((frame) =>
      JSON.stringify(frame).replaceAll(workspace, "/scratch/workspace"),
    );
    await writeFile(process.env.AREAL_CLI_TRANSCRIPT, transcript.join("\n") + "\n");
  }
  r = await run(
    ["--output-format", "json", "-r", session, "--permission-mode", "bypassPermissions"],
    "resume",
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  assert.equal(JSON.parse(r.stdout).session_id, session);
  r = await run(
    consumer.daemonArgs.filter((arg) => arg !== "-p"),
    daemonInput,
    { open: true },
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  r = await run(
    [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--allow-write",
    ],
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "approval" }] },
    }) + "\n",
    {
      open: true,
      control: (f, p) =>
        p.stdin.write(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: f.request_id,
              response: { behavior: "allow", updatedInput: f.request.input },
            },
          }) + "\n",
        ),
    },
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  assert(r.frames.some((f) => f.type === "control_request"));
  assert(r.frames.some((f) => f.message?.content?.[0]?.type === "tool_result"));
  r = await run(
    [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
    ],
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hang" }] },
    }) + "\n",
    { open: true, signal: "SIGTERM" },
  );
  assert.notEqual(r.code, 0);
  assert(r.frames.some((f) => f.type === "result" && f.is_error));
  assert.equal(r.frames.at(-1).subtype, "error_during_execution");
  assert(!Object.hasOwn(r.frames.at(-1), "usage"));
  assert(!Object.hasOwn(r.frames.at(-1), "total_cost_usd"));
  const user = (text) =>
    JSON.stringify({
      type: "user",
      uuid: crypto.randomUUID(),
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n";
  r = await run(
    [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
    ],
    user("first") + user("second"),
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  assert.equal(r.frames.filter((f) => f.type === "result").length, 2);
  for (const text of ["{invalid}\n", ""]) {
    r = await run(["--output-format", "stream-json", "--input-format", "stream-json"], text);
    assert.notEqual(r.code, 0);
    assert(r.frames.at(-1).is_error);
  }
  r = await run(
    ["--output-format", "json", "--allow-write", "--permission-mode", "plan"],
    "readonly",
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  await assert.rejects(readFile(join(workspace, "readonly-denied.txt")));
  r = await run(
    [
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: "/usr/bin/python3",
            args: [resolve("tests/fixtures/mcp-server.py"), join(root, "mcp-cli.jsonl"), "normal"],
          },
        },
      }),
    ],
    "mcp",
  );
  assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
  r = await run(
    ["--output-format", "json", "--max-turns", "1", "--permission-mode", "plan"],
    "readonly",
  );
  assert.notEqual(r.code, 0);
  assert.equal(r.frames.at(-1).subtype, "error_max_turns");
  assert.equal(r.frames.at(-1).num_turns, 1);
  r = await run(["hello positional", "--disallowed-tools", "AskUserQuestion"], "");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "完成：fixture");
  r = await run(["--protocol", "claude-code"], "hello");
  assert.notEqual(r.code, 0);
  assert(!r.stderr.includes("Core PID"));
  r = await run(["--output-format", "json", "--unknown-option"], "hello");
  assert.notEqual(r.code, 0);
  assert(!r.stderr.includes("Core PID"));
  r = await run(["--output-format", "json", "--resume", crypto.randomUUID()], "hello");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no replacement/);
  r = await run(
    [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
    ],
    user("hang"),
    { open: true, signal: "SIGKILL" },
  );
  assert.notEqual(r.code, 0);
  assert(!r.frames.some((f) => f.type === "result" && !f.is_error));
  const owned = [...r.stderr.matchAll(/(?:Runtime|Core) PID: (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(owned.length, 2, r.stderr);
  const cleanupDeadline = Date.now() + 10000;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (owned.some(alive) && Date.now() < cleanupDeadline)
    await new Promise((r) => setTimeout(r, 25));
  assert(!owned.some(alive), "CLI SIGKILL left owned processes alive");
  r = await run(["--output-format", "stream-json", "--include-partial-messages"], "hello", {
    brokenPipe: true,
  });
  assert.notEqual(r.code, 0);
  // 测试凭据只进入部署指定的程序；同一会话恢复刷新凭据，普通 shell 和持久记录不可见。
  const program = join(root, "approved-task-tool");
  await writeFile(
    program,
    `#!/bin/sh\nactual=$(printf %s "$MULTICA_TOKEN" | OPENSSL_CONF=/dev/null /usr/bin/openssl dgst -sha256); test "\${actual##* }" = "$1" && printf "credential matched"\n`,
  );
  await chmod(program, 0o700);
  const tokens = [crypto.randomUUID(), crypto.randomUUID()];
  let credentialSession;
  for (const token of tokens) {
    r = await run(
      [
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--task-credential-command",
        program,
        ...(credentialSession ? ["--resume", credentialSession] : []),
      ],
      "credentials " +
        JSON.stringify({ program, digest: createHash("sha256").update(token).digest("hex") }),
      { env: { MULTICA_TOKEN: token, MULTICA_TASK_ID: crypto.randomUUID() } },
    );
    assert.equal(r.code, 0, r.stderr + r.stdout + JSON.stringify(model.failures));
    credentialSession = JSON.parse(r.stdout).session_id;
    assert(!r.stdout.includes(token) && !r.stderr.includes(token));
  }
  async function assertNoCredentials(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await assertNoCredentials(path);
      else if (entry.isFile()) {
        const value = await readFile(path, "utf8");
        for (const token of tokens)
          assert(!value.includes(token), "credential leaked to persistent state");
      }
    }
  }
  await assertNoCredentials(home);
  for (const token of tokens)
    assert(!JSON.stringify(model.requests).includes(token), "credential leaked to model");
  const otherWorkspace = join(root, "工作区 with spaces");
  await mkdir(otherWorkspace);
  const concurrent = await Promise.all([
    run(["--output-format", "json"], "parallel-one"),
    run(["--output-format", "json"], "parallel-two", { cwd: otherWorkspace }),
  ]);
  for (const value of concurrent) assert.equal(value.code, 0, value.stderr);
  assert.notEqual(
    JSON.parse(concurrent[0].stdout).session_id,
    JSON.parse(concurrent[1].stdout).session_id,
  );
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      exampleId: "EX-17",
      name: "claude-cli-compat",
      status: "passed",
      cases: all.length,
      platform: process.platform + "/" + process.arch,
      consumer: `multica ${consumer.version} / ${consumer.revision}`,
      liveDaemon: "pending",
      cleanupConfirmed: true,
    }),
  );
} finally {
  model.server.closeAllConnections();
  await new Promise((r) => model.server.close(r));
  await rm(root, { recursive: true, force: true });
}
