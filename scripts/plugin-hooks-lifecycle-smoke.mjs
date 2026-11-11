// 失败契约：真实子任务压缩必须保留身份；恢复只在新执行会话发一次；
// 自动/手动压缩、Fork、Interrupt 和全部事件输入须符合固定上游 schema。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
const require = createRequire(import.meta.url),
  WebSocket = require("ws"),
  Ajv = require("ajv"),
  exec = promisify(execFile);
assert(process.argv.slice(2).every((v) => v === "--focus-child"));
const focusChild = process.argv.includes("--focus-child");
const scratch = await realpath(await trackedMkdtemp("/private/tmp/areal-hooks-lifecycle-")),
  workspace = join(scratch, "workspace"),
  home = join(scratch, "home");
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal"),
  coreSha256 = createHash("sha256")
    .update(await readFile(bin))
    .digest("hex");
const sourceHead = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  sourceFiles = {};
for (const file of new Set(
  (await exec("git", ["ls-files", "-m", "-o", "--exclude-standard"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean),
))
  sourceFiles[file] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const pin = JSON.parse(await readFile("upstream/pins.json", "utf8")).codexPlugins;
const schemas = resolve(pin.hookInputSchemaDirectory),
  provenance = JSON.parse(await readFile(join(schemas, "provenance.json"), "utf8")),
  validators = new Map(),
  ajv = new Ajv({ allErrors: true, strict: false });
for (const [name, source] of Object.entries(provenance.files)) {
  const bytes = await readFile(join(schemas, name));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  if (name.endsWith(".json")) {
    const schema = JSON.parse(bytes);
    validators.set(
      schema.properties.hook_event_name.enum?.[0] ?? schema.properties.hook_event_name.const,
      ajv.compile(schema),
    );
  }
}
assert.equal(provenance.revision, pin.revision);
assert.equal(validators.size, 12);
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(AREAL_|OPENAI_|ANTHROPIC_|GITHUB_|GH_TOKEN$|OTEL_)/.test(k),
    ),
  ),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
};
const checks = [],
  holds = new Map(),
  rounds = new Map();
let service,
  client,
  failure,
  passed = false;
const pause = () => new Promise((r) => setTimeout(r, 40));
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const p of req) body += p;
    const q = JSON.parse(body);
    const summary = q.messages.some(
      (m) => m.role === "system" && String(m.content).startsWith("Summarize this session prefix"),
    );
    const input =
      q.messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .reverse()
        .find((s) => s.includes("LIFE_")) ?? "";
    const key = /RUN=([a-f0-9-]+)/.exec(input)?.[1] ?? "none",
      n = rounds.get(key) ?? 0;
    if (!summary) rounds.set(key, n + 1);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const pulse = setInterval(() => res.write(": fixture active\n\n"), 1000);
    res.on("close", () => clearInterval(pulse));
    if (!summary && input.includes("LIFE_HOLD") && n === 0)
      await new Promise((r) => holds.set(key, r));
    clearInterval(pulse);
    let delta = {
      content: summary
        ? "Checkpoint: " +
          input.slice(-300) +
          "; retain completed native output and continue remaining rounds."
        : "LIFECYCLE_OK " + "payload ".repeat(800),
    };
    if (!summary && input.includes("LIFE_CHILD") && n < 4)
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "life-" + key + "-" + n,
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({
                command: "python3 -c \"print('CHILD_NATIVE_OUTPUT ' * 400)\"",
                yieldMs: 1000,
              }),
            },
          },
        ],
      };
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        "\n\ndata: " +
        JSON.stringify({
          choices: [
            { index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
async function cli(args) {
  return JSON.parse(
    (await exec(bin, args, { env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  );
}
async function rpc(method, params) {
  try {
    return await client.request(method, params);
  } catch (error) {
    error.message = method + ": " + error.message;
    throw error;
  }
}
async function mutate(method, params) {
  return rpc(method, { requestId: randomUUID(), ...params });
}
async function connect() {
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    join(home, "config.toml"),
    "--desktop-config",
    join(home, "desktop.json"),
    "--allow-write",
  ]);
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  client = new CoreClient({
    createSocket: () =>
      new WebSocket(service.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      }),
    timeoutMs: 30000,
  });
  await client.connect();
}
async function stop() {
  client?.close();
  const result = await cli(["service", "stop", "--json", "--workspace", workspace, "--cancel"]);
  assert.equal(result.state, "stopped");
  service = null;
}
async function events() {
  try {
    return (await readFile(join(home, "plugins/data/lifecycle@local/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function settle(threadId, turnId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const { thread } = await rpc("thread/read", { threadId, includeTurns: true });
    const turn = thread.turns.find((t) => t.id === turnId) ?? thread.turns.at(-1);
    if (turn && turn.status !== "inProgress") return { thread, turn };
    await pause();
  }
  throw Error("Turn did not settle");
}
async function start(threadId, name) {
  return mutate("areal/turn/start", {
    threadId,
    input: [{ type: "text", text: name + " RUN=" + randomUUID() }],
  });
}
async function turn(threadId, name) {
  const begun = await start(threadId, name),
    result = await settle(threadId, begun.turn.id);
  assert.equal(result.turn.status, "completed", JSON.stringify(result.turn.error));
  return result;
}
async function held(profile) {
  const { thread } = profile
    ? await mutate("areal/thread/start", {
        cwd: workspace,
        agentProfile: { id: profile, revision: "v1" },
      })
    : await rpc("thread/start", { cwd: workspace });
  const begun = await start(thread.id, "LIFE_HOLD");
  const deadline = Date.now() + 20000;
  while (!holds.size && Date.now() < deadline) await pause();
  assert(holds.size, "model did not enter held fixture");
  return { thread, turnId: begun.turn.id };
}
function release() {
  for (const done of holds.values()) done();
  holds.clear();
}
try {
  await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
  await mkdir(join(workspace, "pkg/hooks"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.toml"),
    `schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}"\n[permissions]\nmode="ASK_PERMISSIONS"\n[context]\nmode="auto"\nrecent_tokens=512\n[limits]\ncontext_window_bytes=14000\ncontext_recent_bytes=2500\n`,
  );
  await writeFile(
    join(home, "desktop.json"),
    JSON.stringify({
      profiles: [
        {
          id: "reviewer",
          revision: "v1",
          displayName: "Reviewer",
          instructions: "",
          allowPluginSkills: true,
        },
        { id: "excluded", revision: "v1", displayName: "Excluded", instructions: "" },
      ],
    }),
  );
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({ name: "local", plugins: [{ name: "lifecycle", source: "./pkg" }] }),
  );
  await writeFile(
    join(workspace, "pkg/plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "lifecycle",
      version: "1.0.0",
    }),
  );
  const script = `import json,os,sys\nv=json.load(sys.stdin)\np=os.environ['PLUGIN_DATA']\nos.makedirs(p,exist_ok=True)\nwith open(p+('/matched.jsonl' if len(sys.argv)>1 else '/events.jsonl'),'a') as f:f.write(json.dumps(v)+'\\n')\nout={}\nif v['hook_event_name']=='PermissionRequest':out={'hookSpecificOutput':{'hookEventName':'PermissionRequest','decision':{'behavior':'allow'}}}\nprint(json.dumps(out))\n`;
  await writeFile(join(workspace, "pkg/hooks/hook.py"), script);
  const hooks = Object.fromEntries(
    [...validators.keys()].map((event) => [
      event,
      [
        {
          hooks: [
            { type: "command", command: 'python3 "${PLUGIN_ROOT}/hooks/hook.py"', timeout: 10 },
          ],
        },
      ],
    ]),
  );
  for (const event of ["SubagentStart", "SubagentStop"])
    hooks[event].push({
      matcher: "^reviewer$",
      hooks: [
        { type: "command", command: 'python3 "${PLUGIN_ROOT}/hooks/hook.py" matched', timeout: 10 },
      ],
    });
  await writeFile(join(workspace, "pkg/hooks/hooks.json"), JSON.stringify({ hooks }));
  await connect();
  const preview = await rpc("areal/plugin/read", { id: "lifecycle@local" });
  await mutate("areal/plugin/install", {
    id: preview.id,
    scope: "user",
    expectedRevision: preview.revision,
    source: preview.source,
    expectedDigest: preview.sourceDigest,
  });
  const row = (await rpc("areal/plugin/hooks/list", {})).data.find(
    (r) => r.pluginId === preview.id,
  );
  await mutate("areal/plugin/hooks/configure", {
    id: preview.id,
    expectedDigest: row.installedDigest,
    definitionDigest: row.definitionDigest,
    enabled: true,
    trusted: true,
  });
  let root, result;
  if (!focusChild) {
    ({ thread: root } = await rpc("thread/start", { cwd: workspace }));
    for (let n = 0; n < 5; n++) result = await turn(root.id, "LIFE_ROOT");
    assert(
      (await events()).some((e) => e.hook_event_name === "PreCompact" && e.trigger === "auto"),
    );
    checks.push("automatic compaction executes real Pre/Post hooks and compact SessionStart");
    await rpc("areal/context/compact", { threadId: root.id });
    assert(
      (await events()).some((e) => e.hook_event_name === "PreCompact" && e.trigger === "manual"),
    );
    checks.push("manual compaction retains its manual trigger");
    const before = (await events()).length;
    client.close();
    await connect();
    await rpc("thread/resume", { threadId: root.id });
    await rpc("thread/resume", { threadId: root.id });
    assert.equal((await events()).length, before);
    await turn(root.id, "LIFE_ATTACHED");
    assert.equal(
      (await events()).filter((e) => e.session_id === root.sessionId && e.source === "startup")
        .length,
      1,
    );
    assert.equal(
      (await events()).filter((e) => e.session_id === root.sessionId && e.source === "resume")
        .length,
      0,
    );
    checks.push("same-Core attachment is inert and does not replay SessionStart");
    const fork = await mutate("areal/thread/fork", {
      sourceThreadId: root.id,
      anchor: { turnId: result.turn.id, boundary: "after" },
      workspaceMode: "sharedCurrent",
    });
    const forkId = fork.thread?.id ?? fork.threadId;
    assert(forkId);
    await turn(forkId, "LIFE_FORK");
    assert((await events()).some((e) => e.session_id === forkId && e.source === "fork"));
    checks.push("fork emits fork source once under its own root identity");
  }
  const parent = await held();
  const spawned = await rpc("areal/agent/spawn", {
    parentThreadId: parent.thread.id,
    input: [{ type: "text", text: "LIFE_CHILD RUN=" + randomUUID() }],
    workspaceMode: "sharedWrite",
  });
  const child = await settle(spawned.thread.id, spawned.turn?.id);
  assert.equal(child.turn.status, "completed", JSON.stringify(child.turn.error));
  release();
  await settle(parent.thread.id, parent.turnId);
  const childEvents = (await events()).filter((e) => e.turn_id === child.turn.id);
  const compact = childEvents.filter(
    (e) => e.hook_event_name === "PreCompact" || e.hook_event_name === "PostCompact",
  );
  assert(compact.length >= 2, "child did not cross actual compaction boundary");
  for (const e of compact) {
    assert.equal(e.agent_id, child.thread.id, "child compact lost agent_id");
    assert.equal(e.agent_type, "default");
    assert.equal(e.session_id, parent.thread.sessionId);
  }
  checks.push("child automatic compaction preserves root session, child agent identity and type");
  const roleParent = await held();
  const roleChild = await rpc("areal/agent/spawn", {
    parentThreadId: roleParent.thread.id,
    agentProfile: { id: "reviewer", revision: "v1" },
    workspaceMode: "sharedWrite",
    input: [{ type: "text", text: "LIFE_ROLE RUN=" + randomUUID() }],
  });
  await settle(roleChild.thread.id, roleChild.turn?.id);
  const roleEvents = (await events()).filter((e) => e.agent_id === roleChild.thread.id);
  assert.deepEqual(
    roleEvents.map((e) => e.hook_event_name),
    ["SubagentStart", "SubagentStop"],
  );
  assert(roleEvents.every((e) => e.agent_type === "reviewer"));
  let matches = (await readFile(join(home, "plugins/data/lifecycle@local/matched.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(matches.filter((e) => e.agent_id === roleChild.thread.id).length, 2);
  checks.push(
    "explicitly enabled custom Profile carries the same immutable role to Start/Stop input and matcher",
  );
  const restricted = await rpc("areal/agent/spawn", {
    parentThreadId: roleParent.thread.id,
    agentProfile: { id: "reviewer", revision: "v1" },
    input: [{ type: "text", text: "LIFE_READONLY_NO_CONSENT RUN=" + randomUUID() }],
  });
  const restrictedResult = await settle(restricted.thread.id, restricted.turn?.id);
  assert.equal(restrictedResult.thread.desktop.hookRuns.length, 0);
  await mutate("areal/plugin/hooks/configure", {
    id: preview.id,
    expectedDigest: row.installedDigest,
    definitionDigest: row.definitionDigest,
    enabled: true,
    trusted: true,
    allowReadOnlyCommands: true,
  });
  const readonly = await rpc("areal/agent/spawn", {
    parentThreadId: roleParent.thread.id,
    agentProfile: { id: "reviewer", revision: "v1" },
    input: [{ type: "text", text: "LIFE_READONLY_ROLE RUN=" + randomUUID() }],
  });
  const readonlyResult = await settle(readonly.thread.id, readonly.turn?.id);
  assert.equal(readonlyResult.turn.status, "completed");
  assert(
    (await events()).some((e) => e.agent_id === readonly.thread.id && e.agent_type === "reviewer"),
  );
  checks.push("custom read-only role still needs separate command consent");
  const excluded = await rpc("areal/agent/spawn", {
    parentThreadId: roleParent.thread.id,
    agentProfile: { id: "excluded", revision: "v1" },
    workspaceMode: "sharedWrite",
    input: [{ type: "text", text: "LIFE_EXCLUDED RUN=" + randomUUID() }],
  });
  const excludedResult = await settle(excluded.thread.id, excluded.turn?.id);
  assert.equal(excludedResult.turn.configuration.allowPluginSkills, false);
  assert.equal(excludedResult.thread.desktop.hookRuns.length, 0);
  release();
  await settle(roleParent.thread.id, roleParent.turnId);
  const excludedParent = await held("excluded");
  const narrowed = await rpc("areal/agent/spawn", {
    parentThreadId: excludedParent.thread.id,
    agentProfile: { id: "reviewer", revision: "v1" },
    workspaceMode: "sharedWrite",
    input: [{ type: "text", text: "LIFE_NARROWED RUN=" + randomUUID() }],
  });
  const narrowedResult = await settle(narrowed.thread.id, narrowed.turn?.id);
  assert.equal(narrowedResult.turn.configuration.allowPluginSkills, false);
  assert.equal(narrowedResult.thread.desktop.hookRuns.length, 0);
  release();
  await settle(excludedParent.thread.id, excludedParent.turnId);
  checks.push(
    "omitted Profile opt-in remains disabled and a child opt-in cannot widen the parent boundary",
  );
  if (!focusChild) {
    const interrupted = await held();
    await rpc("turn/interrupt", { threadId: interrupted.thread.id, turnId: interrupted.turnId });
    release();
    const ended = await settle(interrupted.thread.id, interrupted.turnId);
    assert.equal(ended.turn.status, "interrupted");
    assert(
      (await events()).some(
        (e) => e.hook_event_name === "Interrupt" && e.turn_id === interrupted.turnId,
      ),
    );
    checks.push("actual interrupted model Turn emits Interrupt");
    await stop();
    const oldEvents = await events();
    await connect();
    await rpc("thread/resume", { threadId: root.id });
    assert.equal((await events()).length, oldEvents.length);
    await turn(root.id, "LIFE_RESTARTED");
    await turn(root.id, "LIFE_RESTARTED_AGAIN");
    assert.equal(
      (await events()).filter((e) => e.session_id === root.sessionId && e.source === "resume")
        .length,
      1,
    );
    checks.push(
      "confirmed Core restart emits resume on first execution only and preserves reviewed trust",
    );
  }
  await stop();
  const all = await events();
  for (const e of all) {
    const validate = validators.get(e.hook_event_name);
    assert(validate(e), e.hook_event_name + ": " + JSON.stringify(validate.errors));
  }
  if (!focusChild)
    assert.deepEqual(
      [...new Set(all.map((e) => e.hook_event_name))].sort(),
      [...validators.keys()].sort(),
    );
  const invalid = { ...all[0] };
  delete invalid.hook_event_name;
  assert.equal(validators.get(all[0].hook_event_name)(invalid), false);
  checks.push(
    (focusChild ? "observed child command inputs" : "all 12 actual command event inputs") +
      " conform to pinned upstream schemas; missing required-field mutation is rejected",
  );
  passed = true;
} catch (error) {
  failure = error.stack;
} finally {
  release();
  if (service)
    try {
      await stop();
    } catch (error) {
      failure ??= error.stack;
      passed = false;
    }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
}
const manifest = {
  passed,
  checks,
  failure,
  scratch,
  completeMatrix: !focusChild,
  core: bin,
  coreSha256,
  coreUnchanged:
    createHash("sha256")
      .update(await readFile(bin))
      .digest("hex") === coreSha256,
  sourceHead,
  sourceFiles,
  schemaRevision: provenance.revision,
  scope:
    "actual Core/Runtime command hooks; deterministic local model; upstream schema comparison, not full Codex binary differential",
};
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
if (!passed) process.exitCode = 1;
